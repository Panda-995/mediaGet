// 共享的快手解析核心逻辑（供 Next 路由与 Cloudflare Workers 复用）

// Edge/Workers 环境不启用 DOM 解析，直接使用字符串/正则方案
import { TIMEOUT, UA_CHROME_WIN126, UA_IOS_SAFARI_16_6 } from "./http";
import { logger } from "./api-utils";
import { getConfigOrEnv } from "../config";
import { buildQualityList } from "./quality";

/**
 * 分享页抓取超时：10s。**不在公共档位上**（DEFAULT 8s / LONG 15s），是快手链路的实测取值，
 * 归到相邻档会改变行为，故就地具名（见 docs/REFACTOR-PLAN.md P2-2）。
 */
const PAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * 快手取数页端点（H5 分享页，未登录即带 window.INIT_STATE）。
 *
 * 桌面页 `www.kuaishou.com/short-video/<id>` 实测只回 75KB 未登录空壳（`__APOLLO_STATE__`
 * 里没有 photoId/mainMvUrls，页面文案「登录后看更多视频」），同一 photoId 打下面任一
 * `fw/photo` 端点才拿得到数据；三者同源不同出口，主站被风控时按序换镜像。
 */
const H5_PHOTO_HOSTS = ["chenzhongtech.com", "m.gifshow.com"];

/** 由 photoId 组装候选取数页（顺序即优先级） */
function h5PhotoPages(videoId) {
  return H5_PHOTO_HOSTS.map((host) => `https://${host}/fw/photo/${videoId}`);
}

/**
 * 作者主页资料（简介 / 获赞 / 粉丝 / 关注 / 作品数 / 快手号）。
 *
 * 快手把这份数据 SSR 预取进桌面 profile 页的 `window.INIT_STATE`（`/rest/v/profile/user`
 * 缓存项），游客态该缓存项整体缺席：REST `/rest/v/profile/user`、`graphql visionProfile`、
 * H5 镜像的 profile 路径、桌面页本身四条通道实测（含真浏览器渲染）游客全部拿不到，
 * 所以仅在配置了 KUAISHOU_COOKIE 时才发这次请求，未配置零网络开销。
 *
 * 走页面而不是 graphql：`visionProfile` 即使带 cookie 也只回 `result:2`（且 profile 页
 * 的 `ownerCount.like` 是获赞总数，graphql 的 ownerCount 根本没有这一项）。
 *
 * cookie 只发第一方 `www.kuaishou.com`——H5 取数镜像（chenzhongtech / m.gifshow）没有
 * profile 页（实测 404），第三方兜底后端更不该带，把会话发出去只会泄漏。
 */
const KS_PROFILE_PAGE_URL = (eid) => `https://www.kuaishou.com/profile/${eid}`;
/** profile 链接里的 eid 段：只允许账号 id 字符集，避免把页面数据原样拼进 URL */
const KS_EID_RE = /\/profile\/([A-Za-z0-9_-]+)/;

/** cookie 配了但拿不到资料：只提示一次，避免每次解析都刷日志 */
let profileBlockedWarned = false;

async function initDOMParser() {
  return null;
}

/**
 * 快手响应壳。失败时不带 `data`：契约声明 `data?: ParseData`，
 * 用 `[]` 占位会让调用方把「没有结果」读成「空结果」。
 */
export function formatResponse(code = 200, msg = "解析成功", data) {
  const result = { code, msg, platform: "kuaishou" };
  if (data !== undefined) result.data = data;
  return result;
}

/** 主解析无结果时的统一失败文案（与 web `/api/kuaishou` 历史出口一致） */
const KUAISHOU_PARSE_FAIL_MSG = "解析失败，可能是链接格式不支持或内容无法访问";

class KuaishouParser {
  constructor() {
    this.headers = {
      "User-Agent":
        UA_IOS_SAFARI_16_6,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    };

    this.urlPatterns = [
      {
        // 快手短链/分享页重定向到 chenzhongtech H5 页，直接抓该页面（含作者简介与粉丝数据）
        name: "chenzhongtech-photo",
        regex: /chenzhongtech\.com\/fw\/photo\/[^?]+/,
        template: (_videoId, redirectUrl) => redirectUrl,
      },
      {
        name: "short-video",
        regex: /short-video\/([^?]+)/,
        template: (videoId) => h5PhotoPages(videoId),
      },
      {
        name: "photo",
        regex: /photo\/([^?]+)/,
        template: (videoId) => h5PhotoPages(videoId),
      },
      {
        name: "f-format",
        regex: /\/f\/([^?]+)/,
        template: (videoId, redirectUrl) => redirectUrl,
      },
      {
        name: "profile",
        regex: /profile\/([^?]+)/,
        template: (videoId, redirectUrl) => redirectUrl,
      },
      {
        name: "video",
        regex: /video\/([^?]+)/,
        template: (videoId, redirectUrl) => redirectUrl,
      },
    ];
  }

  /**
   * 主入口：永远返回 `{ code, msg, ... }` 信封，不再吐 `null`——
   * 导出面 `Promise<ApiResponse>` 靠这一条成立（上层备用通道仍按 code 判定）。
   */
  async parse(url) {
    try {
      const redirectedUrl = await this.getRedirectedUrl(url);
      for (const pageUrl of this.parseUrl(url, redirectedUrl)) {
        const htmlContent = await this.makeRequest(pageUrl);
        if (!htmlContent) continue;
        const videoInfo = await this.parseVideoInfo(htmlContent);
        if (videoInfo) {
          await this.enrichAuthorInfo(videoInfo.data);
          return videoInfo;
        }
      }
      return formatResponse(404, KUAISHOU_PARSE_FAIL_MSG);
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回失败信封交由上层换下一条策略
      return formatResponse(404, KUAISHOU_PARSE_FAIL_MSG);
    }
  }

  /**
   * 作者资料补全（简介 / 获赞 / 粉丝 / 关注 / 作品数 / 快手号）。
   *
   * 只在「配了 KUAISHOU_COOKIE 且视频解出了作者 eid」时发这次请求；读不到 cookie、
   * cookie 失效、页面结构变化一律原样返回，匿名通道已填的字段一个都不动——
   * 有 cookie 走有 cookie 的方式，没有就退回匿名结果，视频解析出口不依赖它。
   */
  async enrichAuthorInfo(videoData) {
    if (!videoData) return;
    const cookie = String(getConfigOrEnv("kuaishouCookie", "KUAISHOU_COOKIE", ""));
    if (!cookie) return;
    const eid = KS_EID_RE.exec(String(videoData.authorUrl || ""))?.[1];
    if (!eid) return;

    const profile = await this.fetchAuthorProfile(eid, cookie);
    if (!profile) {
      if (!profileBlockedWarned) {
        profileBlockedWarned = true;
        logger.warn(
          "[kuaishou] 已配置 KUAISHOU_COOKIE，但作者主页资料为空（cookie 失效或命中风控）：降级为匿名结果，简介 / 获赞缺失"
        );
      }
      return;
    }
    const user = profile.profile || {};
    const counts = profile.ownerCount || {};
    if (typeof user.user_text === "string" && user.user_text.trim()) {
      videoData.authorSign = user.user_text.trim();
    }
    if (typeof counts.like === "number") videoData.totalFavorited = counts.like;
    if (typeof counts.fan === "number") videoData.followerCount = counts.fan;
    if (typeof counts.follow === "number") videoData.followingCount = counts.follow;
    if (typeof counts.photo_public === "number") videoData.worksCount = counts.photo_public;
    // userDefineId 是官方快手号，比匿名侧从「原声作者」猜出来的可靠，直接覆盖
    if (typeof profile.userDefineId === "string" && profile.userDefineId) {
      videoData.uid = profile.userDefineId;
    }
  }

  /** 抓桌面 profile 页并取出 SSR 预取的作者资料对象；任何失败返回 null（增强项，不影响主链路） */
  async fetchAuthorProfile(eid, cookie) {
    try {
      const response = await fetch(KS_PROFILE_PAGE_URL(eid), {
        headers: {
          "User-Agent": UA_CHROME_WIN126,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Referer: "https://www.kuaishou.com/",
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const html = await response.text();
      return this.parseAuthorProfile(html, eid);
    } catch {
      // 有意静默：作者资料是增强项，失败不能影响视频解析出口
      return null;
    }
  }

  /**
   * 从 profile 页 HTML 里取 `/rest/v/profile/user` 缓存对象。
   * INIT_STATE 的键名被混淆（`string./rest/...` 逐字母 +1）且顺序不稳定，按形状深搜。
   */
  parseAuthorProfile(htmlContent, eid) {
    const marker = "window.INIT_STATE";
    const startIdx = String(htmlContent || "").indexOf(marker);
    if (startIdx === -1) return null;
    const braceIdx = htmlContent.indexOf("{", startIdx);
    if (braceIdx === -1) return null;
    const jsonStr = this.extractBalancedJson(htmlContent, braceIdx);
    if (!jsonStr) return null;
    let state;
    try {
      state = JSON.parse(jsonStr);
    } catch {
      try {
        state = JSON.parse(this.cleanJsonString(jsonStr));
      } catch {
        return null;
      }
    }
    return this.findUserProfileDeep(state, eid);
  }

  /**
   * 找「这位作者的」资料对象：`{ result: 1, userProfile: { profile: { user_id, ... } } }`。
   * 必须按 eid 认领——带 cookie 的页面里可能预取别人的资料（如登录者自己），
   * 认不到就整体降级，不能把别人的简介/粉丝并进这位作者的视频结果里。
   * 实测该 `user_id` 存的是 eid 而非数字 userId；快手哪天改成数字，这里会整体落空
   * （简介/获赞缺失、退回匿名结果），但不会串号。
   */
  findUserProfileDeep(obj, eid, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== "object") return null;
    if (
      obj.result === 1 &&
      obj.userProfile &&
      typeof obj.userProfile === "object" &&
      obj.userProfile.profile &&
      String(obj.userProfile.profile.user_id) === String(eid)
    ) {
      return obj.userProfile;
    }
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const result = this.findUserProfileDeep(obj[key], eid, depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * 候选取数页（按序尝试，第一个「能抓到且提得出数据」的页面胜出）。
   * 模板可返回单个 URL 或一组 URL；原始链接始终排在最后兜底（与拆分前一致）。
   */
  parseUrl(originalUrl, redirectedUrl) {
    let pages = [redirectedUrl];
    for (const pattern of this.urlPatterns) {
      const match =
        originalUrl.match(pattern.regex) || redirectedUrl.match(pattern.regex);
      if (match) {
        const built = pattern.template(match[1], redirectedUrl);
        pages = Array.isArray(built) ? built : [built];
        break;
      }
    }
    return [...new Set([...pages, originalUrl])];
  }

  async getRedirectedUrl(url) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": this.headers["User-Agent"] },
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
      });
      return response.url || url;
    } catch {
      return url;
    }
  }

  async makeRequest(url) {
    try {
      const response = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(TIMEOUT.LONG),
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  async parseVideoInfo(htmlContent) {
    try {
      const domParser = await initDOMParser();
      if (domParser) {
        const result = await this.parseWithDOM(htmlContent, domParser);
        if (result) return result;
      }
      // 快手 H5 分享页当前把数据放在 window.INIT_STATE（键名混淆，值为明文 Apollo 缓存），
      // 直接解析该 JSON 可拿到作者/头像/统计/时长/发布时间等完整信息，优先使用。
      let result = this.parseInitState(htmlContent);
      if (result) return result;
      result = this.parseApolloStateRegex(htmlContent);
      if (result) return result;
      result = this.parseInlineJsonData(htmlContent);
      if (result) return result;
      result = this.parseWithRegexFallback(htmlContent);
      if (result) return result;
      result = this.parseWithBroadSearch(htmlContent);
      if (result) return result;
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  parseWithDOM(htmlContent, DOMParserClass) {
    try {
      const parser = new DOMParserClass();
      const document = parser.parseFromString(htmlContent, "text/html");
      let result = this.parseApolloState(document);
      if (result) return result;
      result = this.parseScriptData(document);
      if (result) return result;
      result = this.parseMetaTags(document);
      if (result) return result;
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  /**
   * 解析 window.INIT_STATE（快手 H5 分享页主数据源，键名被混淆、值为明文 Apollo 缓存）。
   * 可提取：视频直链 / 封面 / 文案 / 作者名 / 头像 / 点赞 / 播放 / 评论 / 分享 / 时长 / 发布时间。
   */
  parseInitState(htmlContent) {
    try {
      const marker = "window.INIT_STATE = ";
      const startIdx = htmlContent.indexOf(marker);
      if (startIdx === -1) return null;
      const braceIdx = htmlContent.indexOf("{", startIdx);
      if (braceIdx === -1) return null;
      const jsonStr = this.extractBalancedJson(htmlContent, braceIdx);
      if (!jsonStr) return null;
      let state;
      try {
        state = JSON.parse(jsonStr);
      } catch {
        try {
          state = JSON.parse(this.cleanJsonString(jsonStr));
        } catch {
          return null;
        }
      }
      const found = this.findPhotoDeep(state);
      if (!found) return null;
      const photo = found.photo;
      const videoData = this.extractVideoFromPhoto(photo);
      if (!videoData.photoUrl) return null;
      // 顶层 counts 是混合对象：fanCount/followCount/photoCount 跟作者走，
      // collectionCount 跟作品走（实测与带签名接口 /rest/v/feed/hot 的作品级
      // collectCount 同值），别按名字把它归到作者档上。
      if (found.counts && typeof found.counts === "object") {
        if (found.counts.fanCount !== undefined) {
          videoData.followerCount = found.counts.fanCount;
        }
        if (found.counts.followCount !== undefined) {
          videoData.followingCount = found.counts.followCount;
        }
        if (found.counts.photoCount !== undefined) {
          videoData.worksCount = found.counts.photoCount;
        }
        if (found.counts.collectionCount !== undefined) {
          videoData.collectionCount = found.counts.collectionCount;
        }
      }
      // 补充作者简介：INIT_STATE 里的 userProfile 缓存含 user_text，按作者名匹配取出
      if (photo.userName) {
        const sign = this.findAuthorSign(state, photo.userName);
        if (sign) videoData.authorSign = sign;
      }
      return formatResponse(200, "解析成功", videoData);
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  /** 从起始左花括号开始，括号平衡提取完整 JSON 字符串（跳过字符串内的括号） */
  extractBalancedJson(str, startBraceIdx) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = startBraceIdx; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return str.slice(startBraceIdx, i + 1);
      }
    }
    return null;
  }

  /** 深度遍历，找「主视频 photo 对象」并携带其顶层 counts（作者关注/粉丝/作品数） */
  findPhotoDeep(obj, parent = null, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== "object") return null;
    if (
      (typeof obj.caption === "string" || typeof obj.userName === "string") &&
      obj.photoId !== undefined &&
      (obj.coverUrls || obj.mainMvUrls || obj.manifest)
    ) {
      return { photo: obj, counts: parent && parent.counts };
    }
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const result = this.findPhotoDeep(obj[key], obj, depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  /** 按作者名在 INIT_STATE 中查找 userProfile 缓存的简介（user_text），返回首个非空值 */
  findAuthorSign(state, authorName) {
    let sign = null;
    const walk = (obj, depth) => {
      if (depth > 8 || sign || !obj || typeof obj !== "object") return;
      if (
        typeof obj.user_name === "string" &&
        obj.user_name === authorName &&
        typeof obj.user_text === "string" &&
        obj.user_text.trim()
      ) {
        sign = obj.user_text.trim();
        return;
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          walk(obj[key], depth + 1);
        }
      }
    };
    walk(state, 0);
    return sign;
  }

  /** 从 photo 对象提取统一字段（返回数据里保留 photoId 供展示/调试） */
  extractVideoFromPhoto(photo) {
    const videoData = {
      source: "init-state",
      photoId: photo.photoId,
    };
    // 视频直链：mainMvUrls 优先（[{cdn,url}] 或 [url]），其次 manifest 清晰度列表（按 quality 降序）
    if (Array.isArray(photo.mainMvUrls)) {
      for (const item of photo.mainMvUrls) {
        const u = typeof item === "string" ? item : item && item.url;
        if (u && u.startsWith("http")) {
          videoData.photoUrl = u;
          break;
        }
      }
    }
    if (!videoData.photoUrl && photo.manifest) {
      const reps = [];
      if (Array.isArray(photo.manifest.adaptationSet)) {
        for (const set of photo.manifest.adaptationSet) {
          if (Array.isArray(set.representation)) reps.push(...set.representation);
        }
      }
      reps.sort((a, b) => Number(b.quality || 0) - Number(a.quality || 0));
      for (const rep of reps) {
        if (rep.url && rep.url.startsWith("http")) {
          videoData.photoUrl = rep.url;
          break;
        }
        if (
          Array.isArray(rep.backupUrl) &&
          rep.backupUrl[0] &&
          rep.backupUrl[0].startsWith("http")
        ) {
          videoData.photoUrl = rep.backupUrl[0];
          break;
        }
      }
    }
    // 清晰度档位表：manifest 的 `quality` 是相对分（实测 1.5），不能当高度用；
    // 真正可展示的是 `qualityType`（如 "720p"）与 `height`。同一档位会同时下发
    // avc / hevc 两条（qualityType 相同），浏览器兼容优先 avc；其余按高度降序列出。
    if (photo.manifest && Array.isArray(photo.manifest.adaptationSet)) {
      const byTier = new Map();
      for (const set of photo.manifest.adaptationSet) {
        for (const rep of Array.isArray(set.representation) ? set.representation : []) {
          if (!rep || rep.hidden === true) continue;
          const url =
            (rep.url && rep.url.startsWith("http") && rep.url) ||
            (Array.isArray(rep.backupUrl) &&
              rep.backupUrl.find((u) => typeof u === "string" && u.startsWith("http"))) ||
            "";
          if (!url) continue;
          const height = Number(rep.height) || 0;
          const label = String(rep.qualityType || (height ? `${height}p` : ""));
          const key = label || `${Number(rep.width) || 0}x${height}`;
          // avc 权重高于 hevc；同编码再按峰值码率取高
          const rank =
            (rep.videoCodec === "hevc" ? 0 : 1) * 1e9 +
            (Number(rep.maxBitrate) || 0);
          const prev = byTier.get(key);
          if (!prev || rank > prev.rank) {
            byTier.set(key, { url, label, height, rank });
          }
        }
      }
      const sorted = [...byTier.values()].sort(
        (a, b) => b.height - a.height || b.rank - a.rank
      );
      const qualities = buildQualityList(
        sorted.map((tier) => ({
          quality: tier.height,
          label: tier.label,
          url: tier.url,
        }))
      );
      if (qualities) {
        videoData.qualities = qualities;
        // 主直链与下拉首档保持一致：主通道的 mainMvUrls 是默认档，
        // 当 manifest 确实给出多档时，最高档才是用户预期的主直链。
        videoData.photoUrl = qualities[0].url;
      }
    }
    // 封面：coverUrls 优先。同一张图官方下发多个 CDN 节点，除首节点外作为备选透出，
    // 供图片代理在主节点解析失败时按序重试（与 headUrls → authorAvatarFallbacks 同口径）。
    if (Array.isArray(photo.coverUrls)) {
      const coverUrls = [];
      for (const item of photo.coverUrls) {
        const u = typeof item === "string" ? item : item && item.url;
        if (u && u.startsWith("http") && !coverUrls.includes(u)) coverUrls.push(u);
      }
      if (coverUrls.length) {
        videoData.coverUrl = coverUrls[0];
        if (coverUrls.length > 1) videoData.coverUrlFallbacks = coverUrls.slice(1);
      }
    } else if (typeof photo.coverUrl === "string" && photo.coverUrl.startsWith("http")) {
      videoData.coverUrl = photo.coverUrl;
    }
    // 文案 / 作者 / 头像 / 作者ID
    if (typeof photo.caption === "string") videoData.caption = photo.caption;
    if (typeof photo.userName === "string") videoData.authorName = photo.userName;
    if (typeof photo.headUrl === "string" && photo.headUrl.startsWith("http")) {
      // 快手官方页面（分享页/m.gifshow/桌面 short-video）统一使用 _s.jpg 变体；
      // 实测 _c/_b/原图变体在 uhead 资源上大量 404（之前曾尝试 _s→_c 高清化导致破图），
      // 因此保持原始 URL 不变，仅靠 CDN 备选容错。
      const primary = photo.headUrl;
      videoData.authorAvatar = primary;
      // headUrls 提供同一资源的 CDN 备选（实测部分节点如 p2-pro DNS 解析失效，需容错）。
      // 收集与主 URL 不同的备选，供图片代理按序重试。
      const fallbacks = [];
      if (Array.isArray(photo.headUrls)) {
        for (const item of photo.headUrls) {
          const u = typeof item === "string" ? item : item && item.url;
          if (u && u.startsWith("http") && u !== primary && !fallbacks.includes(u)) {
            fallbacks.push(u);
          }
        }
      }
      if (fallbacks.length) videoData.authorAvatarFallbacks = fallbacks;
    }
    if (photo.userId !== undefined) videoData.authorId = String(photo.userId);
    // 快手号（对外展示的账号名）只出现在 soundTrack.user 里，而那是「原声」的所有者——
    // 二创用他人原声时它是别人，故只在作者 ID 与视频作者一致时采用。
    const soundUser = photo.soundTrack && photo.soundTrack.user;
    if (
      soundUser &&
      String(soundUser.user_id) === String(photo.userId) &&
      typeof soundUser.kwaiId === "string" &&
      soundUser.kwaiId
    ) {
      videoData.uid = soundUser.kwaiId;
    }
    // 主页链接用 userEid 拼（游客态打不开该页的数据，但链接本身对人有效）
    if (typeof photo.userEid === "string" && photo.userEid) {
      videoData.authorUrl = `https://www.kuaishou.com/profile/${photo.userEid}`;
    }
    // 互动统计
    for (const k of ["likeCount", "viewCount", "commentCount", "shareCount", "forwardCount"]) {
      if (photo[k] !== undefined) videoData[k] = photo[k];
    }
    // 时长（毫秒）与发布时间（毫秒时间戳）
    if (photo.duration !== undefined) videoData.duration = photo.duration;
    if (photo.timestamp !== undefined) videoData.timestamp = photo.timestamp;
    return videoData;
  }

  parseApolloStateRegex(htmlContent) {
    try {
      const apolloStatePattern =
        /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})(?:\s*;|\s*<\/script>)/;
      const matches = htmlContent.match(apolloStatePattern);
      if (matches) {
        try {
          let apolloStateStr = matches[1];
          apolloStateStr = this.cleanJsonString(apolloStateStr);
          const apolloState = JSON.parse(apolloStateStr);
          const defaultClient = apolloState.defaultClient || apolloState;
          if (defaultClient) {
            const result = this.extractVideoDataFromApolloState(defaultClient);
            if (result) return result;
          }
        } catch {
          // 有意静默：候选提取路径逐条试，某条不适用（结构不匹配 / JSON 非法）
          // 就换下一条；不打日志——部分路径在递归中执行，日志会放大成噪声。
          }
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  parseWithRegexFallback(htmlContent) {
    try {
      const regexPatterns = [
        /"photoUrl":\s*"([^"]+)"/,
        /"playUrl":\s*"([^"]+)"/,
        /"videoUrl":\s*"([^"]+)"/,
        /"mp4Url":\s*"([^"]+)"/,
        /photoUrl['"]\s*:\s*['"]([^'"]+)['"]/,
        /playUrl['"]\s*:\s*['"]([^'"]+)['"]/,
      ];
      for (const pattern of regexPatterns) {
        const match = htmlContent.match(pattern);
        if (match) {
          let videoUrl = match[1];
          videoUrl = this.cleanUrl(videoUrl);
          if (videoUrl.startsWith("http")) {
            const contextData = {
              photoUrl: videoUrl,
              source: "regex-fallback",
            };
            this.extractAdditionalInfo(htmlContent, contextData);
            return formatResponse(200, "解析成功", contextData);
          }
        }
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  parseApolloState(document) {
    try {
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const content = script.textContent || script.innerHTML;
        if (content.includes("__APOLLO_STATE__")) {
          const apolloStateMatch = content.match(
            /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})(?:\s*;|\s*<\/script>)/
          );
          if (apolloStateMatch) {
            try {
              const apolloStateStr = this.cleanJsonString(apolloStateMatch[1]);
              const apolloState = JSON.parse(apolloStateStr);
              const defaultClient = apolloState.defaultClient || apolloState;
              if (defaultClient) {
                const result =
                  this.extractVideoDataFromApolloState(defaultClient);
                if (result) return result;
              }
            } catch {
          // 有意静默：候选提取路径逐条试，某条不适用（结构不匹配 / JSON 非法）
          // 就换下一条；不打日志——部分路径在递归中执行，日志会放大成噪声。
          }
          }
        }
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  parseScriptData(document) {
    try {
      const scripts = document.querySelectorAll("script");
      const dataPatterns = [
        {
          name: "INITIAL_STATE",
          pattern: /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
        },
        { name: "NUXT", pattern: /window\.__NUXT__\s*=\s*({[\s\S]*?});/ },
        { name: "videoDetail", pattern: /"videoDetail":\s*({[\s\S]*?})/ },
        { name: "photoInfo", pattern: /"photoInfo":\s*({[\s\S]*?})/ },
      ];
      for (const script of scripts) {
        const content = script.textContent || script.innerHTML;
        for (const { pattern } of dataPatterns) {
          const match = content.match(pattern);
          if (match) {
            try {
              const data = JSON.parse(match[1]);
              const result = this.findVideoDataDeep(data);
              if (result) return result;
            } catch {
          // 有意静默：候选提取路径逐条试，某条不适用（结构不匹配 / JSON 非法）
          // 就换下一条；不打日志——部分路径在递归中执行，日志会放大成噪声。
          }
          }
        }
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  parseInlineJsonData(htmlContent) {
    try {
      const jsonPatterns = [
        { name: "photoUrl", pattern: /"photoUrl":\s*"([^"]+)"/ },
        { name: "playUrl", pattern: /"playUrl":\s*"([^"]+)"/ },
        { name: "videoUrl", pattern: /"videoUrl":\s*"([^"]+)"/ },
        { name: "mp4Url", pattern: /"mp4Url":\s*"([^"]+)"/ },
      ];
      for (const { name, pattern } of jsonPatterns) {
        const match = htmlContent.match(pattern);
        if (match) {
          let videoUrl = this.cleanUrl(match[1]);
          if (videoUrl.startsWith("http")) {
            const videoData = {
              photoUrl: videoUrl,
              source: `inline-json-${name}`,
            };
            this.extractAdditionalInfo(htmlContent, videoData);
            return formatResponse(200, "解析成功", videoData);
          }
        }
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  parseMetaTags(document) {
    try {
      const videoData = {};
      const metaTags = document.querySelectorAll("meta");
      for (const meta of metaTags) {
        const property =
          meta.getAttribute("property") || meta.getAttribute("name");
        const content = meta.getAttribute("content");
        if (!property || !content) continue;
        if (property === "og:video" || property === "og:video:url") {
          videoData.photoUrl = content;
        } else if (property === "og:image") {
          videoData.coverUrl = content;
        } else if (property === "og:title" || property === "og:description") {
          videoData.title = content;
        }
        if (property.includes("video") && content.startsWith("http")) {
          videoData.photoUrl = content;
        }
      }
      if (videoData.photoUrl) {
        videoData.source = "meta-tags";
        return formatResponse(200, "解析成功", videoData);
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }

  extractVideoDataFromApolloState(apolloState) {
    const videoKeys = Object.keys(apolloState).filter(
      (key) =>
        key.includes("Photo") || key.includes("Video") || key.includes("Detail")
    );
    for (const key of videoKeys) {
      const data = apolloState[key];
      if (data && typeof data === "object") {
        const result = this.extractVideoDataFromObject(data);
        if (result) return result;
      }
    }
    const deepResult = this.findVideoDataDeep(apolloState);
    if (deepResult) return deepResult;
    return null;
  }

  extractVideoDataFromObject(obj) {
    if (!obj || typeof obj !== "object") return null;
    const videoUrl =
      obj.photoUrl || obj.playUrl || obj.videoUrl || obj.mp4Url || obj.src;
    if (
      videoUrl &&
      typeof videoUrl === "string" &&
      videoUrl.startsWith("http")
    ) {
      const result = { photoUrl: videoUrl, source: "apollo-state-object" };
      this.mapObjectFields(obj, result);
      return formatResponse(200, "解析成功", result);
    }
    return null;
  }

  mapObjectFields(source, target) {
    const fieldMappings = {
      caption: "caption",
      title: "title",
      coverUrl: "coverUrl",
      cover: "coverUrl",
      poster: "coverUrl",
      thumbnail: "coverUrl",
      previewUrl: "coverUrl",
      name: "authorName",
      author: "author",
      headUrl: "authorAvatar",
      avatar: "avatar",
      likeCount: "likeCount",
      like: "like",
      commentCount: "commentCount",
      shareCount: "shareCount",
      playCount: "playCount",
      duration: "duration",
      createTime: "createTime",
      timestamp: "timestamp",
    };
    for (const [sourceKey, targetKey] of Object.entries(fieldMappings)) {
      if (source[sourceKey] !== undefined) {
        target[targetKey] = source[sourceKey];
      }
    }
  }

  findVideoDataDeep(obj, depth = 0) {
    if (depth > 6) return null;
    if (!obj || typeof obj !== "object") return null;
    const directResult = this.extractVideoDataFromObject(obj);
    if (directResult) return directResult;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        try {
          const result = this.findVideoDataDeep(obj[key], depth + 1);
          if (result) return result;
        } catch {
          // 有意静默：候选提取路径逐条试，某条不适用（结构不匹配 / JSON 非法）
          // 就换下一条；不打日志——部分路径在递归中执行，日志会放大成噪声。
          }
      }
    }
    return null;
  }

  extractAdditionalInfo(htmlContent, videoData) {
    const allImages = htmlContent.match(
      /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)(?:[^"'\s]*)?/gi
    );
    const coverPatterns = [
      /"coverUrl":\s*"([^"]+)"/,
      /"cover":\s*"([^"]+)"/,
      /"poster":\s*"([^"]+)"/,
      /"thumbnail":\s*"([^"]+)"/,
      /"previewUrl":\s*"([^"]+)"/,
      /"imageUrl":\s*"([^"]+)"/,
    ];
    for (const pattern of coverPatterns) {
      const match = htmlContent.match(pattern);
      if (match) {
        let coverUrl = this.cleanUrl(match[1]);
        if (coverUrl.startsWith("http") && this.isSimpleImageUrl(coverUrl)) {
          videoData.coverUrl = coverUrl;
          break;
        }
      }
    }
    if (!videoData.coverUrl && allImages) {
      for (const imageUrl of allImages) {
        const cleanUrl = this.cleanUrl(imageUrl);
        if (this.isKuaishouImageUrl(cleanUrl)) {
          videoData.coverUrl = cleanUrl;
          break;
        }
      }
      if (!videoData.coverUrl) {
        for (const imageUrl of allImages.slice(0, 15)) {
          const cleanUrl = this.cleanUrl(imageUrl);
          if (this.looksLikeCover(cleanUrl)) {
            videoData.coverUrl = cleanUrl;
            break;
          }
        }
      }
      if (!videoData.coverUrl && allImages.length > 0) {
        const firstImage = this.cleanUrl(allImages[0]);
        if (this.isReasonableImage(firstImage)) {
          videoData.coverUrl = firstImage;
        }
      }
    }
    const captionMatch = htmlContent.match(/"caption":\s*"([^"]+)"/);
    if (captionMatch) videoData.caption = captionMatch[1];
    const authorMatch = htmlContent.match(/"name":\s*"([^"]+)"/);
    if (authorMatch && !authorMatch[1].includes("原声"))
      videoData.authorName = authorMatch[1];
  }

  isSimpleImageUrl(url) {
    if (!url || !url.startsWith("http")) return false;
    return url.toLowerCase().match(/\.(jpg|jpeg|png|webp)/);
  }
  isKuaishouImageUrl(url) {
    if (!url || !url.startsWith("http")) return false;
    const urlLower = url.toLowerCase();
    const kuaishouDomains = ["kwimgs.com", "kwaicdn.com", "kuaishou.com"];
    const isKuaishouDomain = kuaishouDomains.some((domain) =>
      urlLower.includes(domain)
    );
    if (!isKuaishouDomain) return false;
    const excludeKeywords = [
      "icon",
      "logo",
      "button",
      "menu",
      "ui",
      "asset",
      "sprite",
    ];
    const hasExcludeKeyword = excludeKeywords.some((keyword) =>
      urlLower.includes(keyword)
    );
    return !hasExcludeKeyword;
  }
  looksLikeCover(url) {
    if (!url || !url.startsWith("http")) return false;
    const urlLower = url.toLowerCase();
    const excludeKeywords = [
      "icon",
      "logo",
      "button",
      "menu",
      "ui",
      "asset",
      "avatar",
      "user",
      "profile",
      "head",
      "background",
      "bg",
      "sprite",
      "line-up",
      "arrow",
      "close",
      "play-btn",
    ];
    const hasExcludeKeyword = excludeKeywords.some((keyword) =>
      urlLower.includes(keyword)
    );
    if (hasExcludeKeyword) return false;
    return urlLower.match(/\.(jpg|jpeg|png|webp)/);
  }
  isReasonableImage(url) {
    if (!url || !url.startsWith("http")) return false;
    const urlLower = url.toLowerCase();
    if (!urlLower.match(/\.(jpg|jpeg|png|webp)/)) return false;
    const unreasonableKeywords = [
      "data:image",
      "base64",
      "1x1",
      "pixel",
      "tracking",
    ];
    return !unreasonableKeywords.some((keyword) => urlLower.includes(keyword));
  }
  cleanJsonString(jsonStr) {
    try {
      return jsonStr
        .replace(/function\s*\([^)]*\)\s*{[^{}]*(?:{[^{}]*}[^{}]*)*}/g, "null")
        .replace(/:\s*undefined/g, ":null")
        .replace(/,\s*undefined/g, ",null")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*(?=})/g, "")
        .replace(/,\s*(?=])/g, "")
        .replace(/new\s+Date\([^)]*\)/g, "null")
        .replace(/Symbol\([^)]*\)/g, "null")
        .replace(/[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)/g, "null")
        .replace(/(['"])??([a-zA-Z0-9_]+)(['"])??:/g, '"$2":');
    } catch {
      return jsonStr;
    }
  }
  cleanUrl(url) {
    return url
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");
  }
  isValidImageUrl(url) {
    return (
      url.startsWith("http") &&
      (url.includes(".jpg") ||
        url.includes(".jpeg") ||
        url.includes(".png") ||
        url.includes(".webp") ||
        url.includes("image") ||
        url.includes("cover") ||
        url.includes("thumb"))
    );
  }
  parseWithBroadSearch(htmlContent) {
    try {
      const broadPatterns = [
        /https?:\/\/[^"'\s]+\.(?:mp4|m3u8|flv|avi|mov|wmv|mkv)(?:[^"'\s]*)?/gi,
        /https?:\/\/[^"'\s]*(?:video|media|stream|play|cdn)[^"'\s]*\.(?:mp4|m3u8|flv)/gi,
        /https?:\/\/[^"'\s]*(?:kuaishou|kwai|ks)[^"'\s]*\.(mp4|m3u8|flv)/gi,
        /https?:\/\/[^"'\s]+(?:play|stream|video)[^"'\s]*/gi,
      ];
      for (const pattern of broadPatterns) {
        const matches = htmlContent.match(pattern);
        if (matches) {
          for (const url of matches.slice(0, 10)) {
            if (this.isValidVideoUrl(url)) {
              const videoData = { photoUrl: url, source: "broad-search" };
              this.extractAdditionalInfo(htmlContent, videoData);
              return formatResponse(200, "解析成功", videoData);
            }
          }
        }
      }
      return this.extractFromJsonFragments(htmlContent);
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }
  extractEnhancedInfo(htmlContent, videoData) {
    // 保留占位，核心逻辑已在 extractAdditionalInfo 覆盖
    return videoData;
  }
  isValidCoverUrl(url) {
    const lower = (url || "").toLowerCase();
    return lower.startsWith("http") && /\.(jpg|jpeg|png|webp)/.test(lower);
  }
  extractFromJsonFragments(htmlContent) {
    try {
      const jsonPatterns = [
        /\{[^{}]*"(?:photoUrl|playUrl|videoUrl|mp4Url)"[^{}]*\}/g,
        /\{[^{}]*"url":\s*"https?:\/\/[^\"]*\.(?:mp4|m3u8|flv)[^\"]*"[^{}]*\}/g,
        /\{[^{}]*"src":\s*"https?:\/\/[^\"]*\.(?:mp4|m3u8|flv)[^\"]*"[^{}]*\}/g,
      ];
      for (const pattern of jsonPatterns) {
        const matches = htmlContent.match(pattern);
        if (matches) {
          for (const jsonStr of matches.slice(0, 5)) {
            try {
              const data = JSON.parse(jsonStr);
              const videoUrl =
                data.photoUrl ||
                data.playUrl ||
                data.videoUrl ||
                data.mp4Url ||
                data.url ||
                data.src;
              if (videoUrl && this.isValidVideoUrl(videoUrl)) {
                // 只带白名单字段，不 `...data`：正则碎片里的同一条直链会散成
                // url / src / playUrl 等多个别名，出口验链置空 `url` 后会被归一化的
                // 别名兜底原样复活（坏链又变回「可用」）；上游当作者名用的 `name`
                // 也会串进统一标题。与本文件其余提取分支保持同一套字段口径。
                const videoData = { photoUrl: videoUrl, source: "json-fragment" };
                this.mapObjectFields(data, videoData);
                return formatResponse(200, "解析成功", videoData);
              }
            } catch {
          // 有意静默：候选提取路径逐条试，某条不适用（结构不匹配 / JSON 非法）
          // 就换下一条；不打日志——部分路径在递归中执行，日志会放大成噪声。
          }
          }
        }
      }
      return null;
    } catch {
      // 有意静默：本条提取路径不适用于当前页面，返回 null 交由上层换下一条策略
      return null;
    }
  }
  isValidVideoUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("http")) return false;
    const videoIndicators = [
      ".mp4",
      ".m3u8",
      ".flv",
      ".avi",
      ".mov",
      ".wmv",
      ".mkv",
      "video",
      "play",
      "stream",
      "media",
    ];
    return videoIndicators.some((indicator) =>
      url.toLowerCase().includes(indicator)
    );
  }
}

export async function parseKuaishou(url) {
  const parser = new KuaishouParser();
  return await parser.parse(url);
}
