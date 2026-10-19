/**
 * 小红书解析核心（P0 抽取自 app/api/xhs/route.js，逻辑逐字搬移，行为零变化）。
 */
import { TIMEOUT, UA_EDGE_WIN129 } from "./http";
import { logger } from "./api-utils";
import { getConfigOrEnv } from "../config";
import { buildQualityList } from "./quality";

/** 小红书 H5：桌面 Chrome UA，短链统一走 https */
const XHS_USER_AGENT = UA_EDGE_WIN129;

// 可选：浏览器登录小红书后复制的 Cookie，可显著降低数据中心/海外出口被风控概率
const XHS_COOKIE = String(getConfigOrEnv("xhsCookie", "XHS_COOKIE", ""));

// —— 简易 Cookie 池 ——
// 小红书对无 Cookie 的请求（尤其数据中心/海外 IP）会间歇返回安全验证页
// （无 __INITIAL_STATE__），带齐 a1/webId 等匿名 Cookie 后通常可放行。
// Node fetch 不自动保存 Cookie，这里累积各响应 set-cookie 供后续请求使用。
const xhsCookiePool = {};

// 博主主页统计进程内缓存（TTL 10 分钟）：同一博主连续解析多篇笔记时避免重复抓主页
const xhsProfileCache = new Map();
const XHS_PROFILE_CACHE_TTL = 10 * 60 * 1000;

function absorbXhsCookies(response) {
  try {
    const list =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const raw of list) {
      const pair = String(raw).split(";")[0].trim();
      const name = pair.split("=")[0]?.trim();
      if (!name) continue;
      xhsCookiePool[name] = pair;
    }
  } catch {
    // 忽略吸收失败，不影响主流程
  }
}

/** 合并多段 Cookie：环境变量 XHS_COOKIE 优先，其次 Cookie 池 */
function buildXhsCookieString(extra) {
  const sources = [extra, XHS_COOKIE];
  for (const name of Object.keys(xhsCookiePool)) {
    sources.push(xhsCookiePool[name]);
  }
  const seen = new Set();
  const parts = [];
  for (const src of sources) {
    if (!src) continue;
    for (const seg of String(src).split(";")) {
      const kv = seg.trim();
      if (!kv) continue;
      const name = kv.split("=")[0];
      if (name && !seen.has(name)) {
        seen.add(name);
        parts.push(kv);
      }
    }
  }
  return parts.join("; ");
}

/** 完整浏览器请求头（小红书会校验请求特征，缺头易被识别为爬虫） */
function xhsHeaders({ referer, cookie, acceptJson } = {}) {
  const headers = {
    "User-Agent": XHS_USER_AGENT,
    Accept: acceptJson
      ? "application/json, text/plain, */*"
      : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "sec-ch-ua":
      '"Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  if (referer) headers.Referer = referer;
  const cookieStr = buildXhsCookieString(cookie);
  if (cookieStr) headers.Cookie = cookieStr;
  return headers;
}

/**
 * 小红书响应壳。失败时不带 `data`：契约声明 `data?: ParseData`，
 * 用 `[]` 占位会让调用方把「没有结果」读成「空结果」。
 */
function output(code, msg, data) {
  const result = { code, msg };
  if (data !== undefined) result.data = data;
  return result;
}

function normalizeXhsUrl(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    // xhslink.com / xhslink.cn 短链统一走 https
    if (["xhslink.com", "xhslink.cn"].includes(host) && u.protocol === "http:") {
      u.protocol = "https:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return url.trim();
}

/**
 * 短链与笔记页：手动跟随重定向，兼容 xhslink.com 的 o/ 短链。
 * 每次响应吸收 set-cookie，后续请求自动携带（无 Cookie 时小红书易弹安全验证）。
 * 首次链路失败/被风控时，用已吸收的 Cookie 自动重试一次。
 */
async function fetchXhsNoteHtml(url, attempt = 1) {
  const target = normalizeXhsUrl(url);

  const doFetch = (u, referer) =>
    fetch(u, {
      headers: xhsHeaders(referer ? { referer } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT.PAGE),
    });

  try {
    // 第一步：请求短链/笔记页，手动处理重定向
    let response = await doFetch(target, "");
    absorbXhsCookies(response);

    // 手动跟随重定向（最多跟 5 次），每步带上已吸收的 Cookie 与来源 Referer
    let redirectCount = 0;
    const maxRedirects = 5;
    while (
      redirectCount < maxRedirects &&
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, response.url).toString();
      redirectCount++;
      response = await doFetch(nextUrl, response.url);
      absorbXhsCookies(response);
    }

    const html = await response.text();
    const finalUrl = response.url;

    // 已落到小红书域但缺页面数据：多半是首次无 Cookie 被风控，
    // 用已吸收的 Cookie 整条重试一次（二次请求通常能拿到正常笔记页）
    if (
      attempt === 1 &&
      !html.includes("__INITIAL_STATE__") &&
      /xiaohongshu\.com|xhslink\.(com|cn)/.test(finalUrl)
    ) {
      console.log("[xhs] retry with absorbed cookies, finalUrl:", finalUrl);
      return fetchXhsNoteHtml(url, 2);
    }

    return { html, finalUrl };
  } catch (error) {
    if (attempt === 1) {
      console.log("[xhs] fetch error, retry once:", error.message);
      return fetchXhsNoteHtml(url, 2);
    }
    throw error;
  }
}

/**
 * 识别小红书的「拦截页」：链接失效/需要登录时，小红书会 302 到 /404 或 /login，
 * 这两类页面同样带 __INITIAL_STATE__（但 note 是空壳或不存在），继续解析只会得到
 * 误导性的「该内容不包含视频或图片」。这里先行判定并给出可操作提示。
 */
function detectXhsBlockedPage(finalUrl) {
  if (!finalUrl) return null;
  let path = "";
  try {
    path = new URL(finalUrl).pathname;
  } catch {
    return null;
  }
  if (/^\/login(\/|$)/.test(path)) {
    return output(
      400,
      "该笔记需要登录才能浏览，请在小红书 App 内重新复制分享链接，或联系站长配置 XHS_COOKIE"
    );
  }
  // 移动端/H5 入口的安全验证页（iPhone/微信 UA 直连时常见）
  if (/^\/website-login\/captcha/.test(path)) {
    return output(
      400,
      "小红书触发了安全验证，请稍后重试（或联系站长配置 XHS_COOKIE）"
    );
  }
  // 笔记不可见：/website-login/error?error_code=300017（已删除/私密/被限制）
  if (/^\/website-login\/error(\/|$)/.test(path) || /error_code=300017/.test(finalUrl)) {
    return output(
      400,
      "笔记暂时无法查看：可能已删除、设为私密或被限制访问"
    );
  }
  if (/^\/404(\/|$)/.test(path) || /error_code=300031/.test(finalUrl)) {
    return output(
      400,
      "笔记暂时无法浏览：链接可能已失效或需要新的分享链接，请在小红书 App 内重新分享"
    );
  }
  return null;
}

// 安全地获取嵌套属性
function safeGet(obj, path) {
  try {
    return path.split(".").reduce((current, key) => {
      if (current && typeof current === "object" && key in current) {
        return current[key];
      }
      return null;
    }, obj);
  } catch {
    return null;
  }
}

/**
 * 兜底查找互动统计：从 note.noteDetailMap 全量遍历，取第一个带 interactInfo 的笔记
 * （不同分享入口结构略有差异，interactInfo 可能在 entry 或 entry.note 上）
 */
function findFirstInteractInfo(root) {
  const detailMap = safeGet(root, "note.noteDetailMap");
  if (!detailMap || typeof detailMap !== "object") return null;
  for (const key of Object.keys(detailMap)) {
    const entry = detailMap[key];
    const info =
      safeGet(entry, "note.interactInfo") ||
      safeGet(entry, "interactInfo") ||
      null;
    if (info && typeof info === "object") return info;
  }
  return null;
}

/**
 * 新版笔记页：note.currentNoteId + note.noteDetailMap[id].note
 * 旧版：noteData.data.noteData 等
 */
function resolveNotePayload(decoded) {
  // 新版结构：note.noteDetailMap
  const noteId = safeGet(decoded, "note.currentNoteId");
  const detailMap = safeGet(decoded, "note.noteDetailMap");
  if (noteId && detailMap && typeof detailMap === "object") {
    const entry = detailMap[noteId];
    if (entry?.note && typeof entry.note === "object") {
      return entry.note;
    }
    // 有些版本 note 直接挂在 entry 下
    if (entry && typeof entry === "object" && entry.title) {
      return entry;
    }
  }

  // 旧版结构
  const legacy =
    safeGet(decoded, "noteData.data.noteData") ||
    safeGet(decoded, "note.data") ||
    safeGet(decoded, "noteDetail.data") ||
    safeGet(decoded, "data.noteData") ||
    // 更多兜底路径
    safeGet(decoded, "note.noteDetailMap")?.[noteId]?.note ||
    safeGet(decoded, "note.noteDetailMap")?.[noteId];
  if (legacy) return legacy;

  // 兜底 decoded.note：登录页/404 页也带 note 空壳（无任何笔记字段），
  // 直接返回会让错误被吞成「该内容不包含视频或图片」，这里按字段特征校验
  const shell = safeGet(decoded, "note");
  if (
    shell &&
    typeof shell === "object" &&
    (shell.title || shell.desc || shell.noteId || shell.imageList || shell.video)
  ) {
    return shell;
  }
  return null;
}

/**
 * 小红书页面的 __INITIAL_STATE__ 不是严格 JSON：
 * 匿名页偶见 `undefined`，登录态页面还会带 `new Map([])` / `new Set([])`
 * 这类 JS 字面量（AiNoteDetailStore 等 store），直接 JSON.parse 会报
 * 「JSON数据解析失败」。这里按字符串边界安全改写为 JSON 等价形态。
 */
function sanitizeInitialStateJson(raw) {
  let out = "";
  let i = 0;
  const n = raw.length;
  let inString = false;

  while (i < n) {
    const ch = raw[i];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += raw[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    // new Map(...) / new Set(...) / new WeakMap(...) → {} / []
    const ctor = /^new (Map|Set|WeakMap|WeakSet)\s*\(/.exec(raw.slice(i, i + 24));
    if (ctor) {
      const isMap = ctor[1] === "Map" || ctor[1] === "WeakMap";
      i += ctor[0].length;
      let depth = 1;
      let str = false;
      while (i < n && depth > 0) {
        const c = raw[i];
        if (str) {
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === '"') str = false;
        } else if (c === '"') {
          str = true;
        } else if (c === "(") {
          depth += 1;
        } else if (c === ")") {
          depth -= 1;
        }
        i += 1;
      }
      out += isMap ? "{}" : "[]";
      continue;
    }

    if (raw.startsWith("undefined", i)) {
      out += "null";
      i += "undefined".length;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function extractInitialStateJson(html) {
  // 取到下一个 </script>，避免对大段 JSON 做错误的非贪婪 `}` 截断
  const re = /window\.__INITIAL_STATE__\s*=\s*(.*?)<\/script>/is;
  const m = html.match(re);
  if (m?.[1]) {
    return m[1].trim();
  }
  // 兼容旧版 script 标签格式
  const legacy =
    /<script>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(
      html
    );
  if (legacy?.[1]) {
    return legacy[1].trim();
  }
  // 兼容单行 script 格式
  const inline =
    /<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(
      html
    );
  return inline?.[1]?.trim() ?? null;
}

/** 小红书计数归一化：兼容数字 / 数字字符串 / 尾随"+" / K(千) / 万 / 亿单位（"10+"、"1K+"、"10K+"、"1万+"、"1.2亿+"） */
function parseXhsCount(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : 0;
  const s = String(v).trim().replace(/[+\s]/g, "");
  const w = /^([\d.]+)万$/.exec(s);
  if (w) return Math.round(parseFloat(w[1]) * 10000);
  const y = /^([\d.]+)亿$/.exec(s);
  if (y) return Math.round(parseFloat(y[1]) * 100000000);
  const k = /^([\d.]+)[kK]$/.exec(s);
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * 从博主主页初始状态提取关注/粉丝/获赞与收藏计数。
 * 主页结构随版本多变，提供多条兜底路径（新版 user.userPageData → 旧版 userPageData）。
 * 计数对象可能直接带 counts，也可能计数平铺在页面数据上，因此统一按字段名探测。
 */
function extractXhsUserStats(decoded) {
  const pageData =
    safeGet(decoded, "user.userPageData") ||
    safeGet(decoded, "userPageData") ||
    safeGet(decoded, "userData") ||
    null;
  if (!pageData || typeof pageData !== "object") return null;

  let followingCount = 0;
  let followerCount = 0;
  let totalFavorited = 0;
  // 脱敏检测：小红书对「无登录会话」的请求会把主页三项统计统一降级为
  // 固定低值、且每项都带「+」尾缀的估算文案（10+ / 1万+ / 10K+）。
  // 登录态真实数据不带「+」（如 831 / 2.5万 / 15.7万）。带 + 项占多数即判定脱敏。
  let unreliable = false;

  // 新版主页：interactions 数组按 type 区分
  // [{type:"follows",name:"关注",count:"10+"},{type:"fans",name:"粉丝",count:"1万+"},{type:"interaction",name:"获赞与收藏",count:"1万+"}]
  if (Array.isArray(pageData.interactions)) {
    // 诊断：打印主页 interactions 原始项（type/count/i18nCount），便于核对映射
    try {
      console.log(
        "[xhs] interactions raw:",
        JSON.stringify(
          pageData.interactions.map((i) => ({
            type: i && i.type,
            name: i && i.name,
            count: i && i.count,
            i18nCount: i && i.i18nCount,
          }))
        )
      );
    } catch {
      /* debug only */
    }
    // 脱敏模板判定：仅以「+」尾缀为信号。真实数据 831/2.5万/15.7万 不带 +，
    // 但同样带「万」单位，因此不能把单位本身当作脱敏特征。
    const isSanitized = (v) => typeof v === "string" && /[+＋]/.test(v);
    let sanitizedHits = 0;
    let sanitizedTotal = 0;
    for (const item of pageData.interactions) {
      if (!item || typeof item !== "object") continue;
      const raw = item.count ?? item.i18nCount;
      if (raw !== undefined && raw !== null && raw !== "") {
        sanitizedTotal += 1;
        if (isSanitized(raw)) sanitizedHits += 1;
      }
      const v = parseXhsCount(raw);
      if (item.type === "follows") followingCount = v;
      else if (item.type === "fans") followerCount = v;
      else if (item.type === "interaction" || item.type === "liked")
        totalFavorited = v;
    }
    // 带「+」项占多数 → 判定为脱敏数据（非精确值）
    unreliable = sanitizedTotal > 0 && sanitizedHits * 2 >= sanitizedTotal;
  } else {
    // 旧版主页：counts 对象
    const counts = pageData.counts || pageData;
    if (counts && typeof counts === "object") {
      // 字段名新旧兼容：follows/following/followingCount；fans/follower/followerCount；
      // interactions（小红书口径：获赞与收藏）/likedCount/likes
      followingCount = parseXhsCount(
        counts.follows ?? counts.followingCount ?? counts.following
      );
      followerCount = parseXhsCount(
        counts.fans ?? counts.followerCount ?? counts.follower
      );
      totalFavorited = parseXhsCount(
        counts.interactions ??
          counts.totalFavorited ??
          counts.likedCount ??
          counts.likes
      );
    }
  }

  // 主页简介（basicInfo.desc）兜底笔记页缺失的简介
  const basic = pageData.basicInfo || pageData || null;
  const sign =
    (basic && (basic.desc ?? basic.description ?? basic.sign)) || "";
  // 主页博主身份（用于与笔记作者比对，防止主页抓错用户）
  // redId = 自定义小红书号（如 635198943，主页「小红书号」展示用）；
  // nickname = 昵称；userKey 兜底组合，供旧版校验复用
  const redId = (basic && (basic.redId || basic.userId)) || "";
  const nickname =
    (basic && (basic.nickname ?? basic.nickName ?? basic.name)) || "";
  const userKey = redId || nickname;

  if (followerCount || followingCount || totalFavorited || sign) {
    return {
      followingCount,
      followerCount,
      totalFavorited,
      sign,
      redId,
      nickname,
      userKey,
      unreliable,
    };
  }
  return null;
}

/** 调试用：递归找到第一个同时含粉丝/关注等键的对象，帮助定位主页结构变化 */
function findCountsHolder(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return null;
  if (keys.some((k) => k in obj)) return obj;
  for (const k of Object.keys(obj)) {
    // 跳过超大列表字段，避免无谓深挖与输出爆炸
    if (
      ["notes", "noteList", "noteDetailMap", "noteMap", "comments"].includes(
        k
      )
    ) {
      continue;
    }
    const r = findCountsHolder(obj[k], keys, depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * 从笔记 HTML 提取作者主页链接里的 xsec_token。
 * 小红书要求主页访问带专属 token，否则会被风控或返回错配用户数据，
 * 因此不能直接裸请求 /user/profile/{id}，需复用笔记页里现成的作者主页 token。
 */
function extractProfileToken(html, userId) {
  if (!html) return "";
  try {
    const re = new RegExp(
      `/user/profile/${userId}[^"'<>\\s]*?xsec_token=([^"'<>\\s&]+)`
    );
    const m = html.match(re);
    if (m?.[1]) return decodeURIComponent(m[1]);
    // 兜底：任意作者主页链接里的 token
    const m2 = html.match(
      /\/user\/profile\/[^"'<>\\s]*?xsec_token=([^"'<>\\s&]+)/
    );
    if (m2?.[1]) return decodeURIComponent(m2[1]);
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 博主主页公开统计（关注/粉丝/获赞与收藏）：
 * 笔记页不含这些数据，需额外抓一次博主主页再解 __INITIAL_STATE__。
 * 主页 URL 必须携带笔记 HTML 中提取的 xsec_token，否则易被风控/错配。
 * 任何一步失败都静默返回 null —— 缺失字段前端自动隐藏，不影响主解析结果。
 */
async function fetchXhsProfileStats(userId, xsecToken = "") {
  if (!userId) return null;
  // 命中缓存直接返回，避免同博主多次解析重复抓主页
  const cached = xhsProfileCache.get(userId);
  if (cached) return cached;
  const profileUrl = xsecToken
    ? `https://www.xiaohongshu.com/user/profile/${userId}?xsec_token=${encodeURIComponent(
        xsecToken
      )}&xsec_source=pc_user`
    : `https://www.xiaohongshu.com/user/profile/${userId}`;
  try {
    const { html } = await fetchXhsNoteHtml(profileUrl);
    const jsonRaw = html ? extractInitialStateJson(html) : null;
    if (!jsonRaw) return null;
    let decoded;
    try {
      decoded = JSON.parse(sanitizeInitialStateJson(jsonRaw));
    } catch {
      return null;
    }
    const stats = extractXhsUserStats(decoded);
    // 结构探测：统计全为 0 / 缺失时打印主页实际字段，便于定位字段名变化
    if (
      !stats ||
      (!stats.followingCount && !stats.followerCount && !stats.totalFavorited)
    ) {
      try {
        const holder = findCountsHolder(decoded, [
          "fans",
          "followerCount",
          "follows",
          "followingCount",
          "interactions",
        ]);
        console.log(
          "[xhs] profile empty, topKeys:",
          Object.keys(decoded).join(",")
        );
        if (holder) {
          console.log(
            "[xhs] profile holder sample:",
            JSON.stringify(holder).slice(0, 800)
          );
        }
      } catch {
        /* debug only */
      }
    }
    // 只缓存成功结果；失败的（风控/结构变化）留待下次重新尝试
    if (stats) {
      xhsProfileCache.set(userId, stats);
      setTimeout(
        () => xhsProfileCache.delete(userId),
        XHS_PROFILE_CACHE_TTL
      );
    }
    return stats;
  } catch (error) {
    console.log("[xhs] profile stats failed:", error.message);
    return null;
  }
}

/**
 * 从 video.media.stream 取可用视频档位。
 * 旧结构键为编码名（h264/h265/av1），新结构改为档位标识（EF4~EF7）。
 * 只认旧键会让视频笔记因取不到档位而落到图文分支，丢掉整条视频直链；
 * 因此旧键优先（h264 浏览器兼容性最好），全缺时遍历所有数组键兜底。
 */
function collectVideoEntries(stream) {
  if (!stream || typeof stream !== "object") return [];

  const isEntry = (e) =>
    e &&
    typeof e === "object" &&
    (e.masterUrl || (Array.isArray(e.backupUrls) && e.backupUrls.length > 0));

  for (const key of ["h264", "h265", "av1", "h266"]) {
    const arr = stream[key];
    if (!Array.isArray(arr)) continue;
    const list = arr.filter(isEntry);
    if (list.length) return list;
  }

  const fallback = [];
  for (const value of Object.values(stream)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isEntry(entry)) fallback.push(entry);
    }
  }
  return fallback;
}

/**
 * 选取稳定可用的视频直链。
 * backupUrls 为裸直链（无短时效签名，长期有效），优先使用；
 * masterUrl 带约 30 分钟签名，仅作兜底。
 * 统一转 https，避免 https 站点下 http 直链的 mixed content 问题。
 */
async function pickStableVideoUrl(entry) {
  if (!entry || typeof entry !== "object") return null;

  const toHttps = (u) => (u ? u.replace(/^http:/i, "https:") : u);

  const candidates = [];
  if (Array.isArray(entry.backupUrls)) {
    for (const u of entry.backupUrls) {
      if (u) candidates.push(toHttps(u));
    }
  }
  if (entry.masterUrl) candidates.push(toHttps(entry.masterUrl));

  // HEAD 轻量验证可用性（部分 CDN 节点 404，如 bak-v6），取第一个可用的
  for (const u of candidates) {
    try {
      const head = await fetch(u, {
        method: "HEAD",
        signal: AbortSignal.timeout(TIMEOUT.SHORT),
      });
      if (head.ok) return u;
    } catch {
      /* try next */
    }
  }
  // HEAD 全部失败不一定是链接不可用（CDN 可能拒绝 HEAD / 节点抽风），
  // 退回第一个候选让下游 video-proxy 用 GET 尝试，避免把可用的视频
  // 误判成“该内容不包含视频或图片”。
  console.log("[xhs] all video HEAD failed, fallback:", candidates[0]);
  return candidates[0];
}

export async function xhsParse(url) {
  try {
    const { html, finalUrl } = await fetchXhsNoteHtml(url);

    console.log("[xhs] finalUrl:", finalUrl);
    console.log("[xhs] html length:", html?.length || 0);

    if (!html) {
      return output(400, "请求失败，未获取到页面内容");
    }

    // 检查是否被小红书拦截或跳转到了非笔记页
    if (
      (finalUrl.includes("xhslink.com") || finalUrl.includes("xhslink.cn")) &&
      !html.includes("__INITIAL_STATE__")
    ) {
      return output(
        400,
        "短链重定向失败，请尝试复制小红书 App 内的分享链接"
      );
    }

    if (
      !finalUrl.includes("xiaohongshu.com") &&
      !html.includes("__INITIAL_STATE__")
    ) {
      return output(
        400,
        "无法打开小红书笔记页，请确认短链有效或使用 App 分享链接"
      );
    }

    // 被 302 到登录墙或 404（error_code=300031）时先判定：
    // 这两类页面也带 __INITIAL_STATE__，继续解析只会得到误导性文案
    const blocked = detectXhsBlockedPage(finalUrl);
    if (blocked) {
      console.log("[xhs] blocked page, finalUrl:", finalUrl);
      return blocked;
    }

    let jsonRaw = extractInitialStateJson(html);
    if (!jsonRaw) {
      // 安全验证页/风控拦截的典型特征（页面不含 __INITIAL_STATE__）
      if (
        /安全验证|请完成验证|__AC_NONCE__|geetest|verify|captcha/i.test(html)
      ) {
        console.log("[xhs] blocked by safety check, finalUrl:", finalUrl);
        return output(
          400,
          "小红书触发了安全验证，请稍后重试（或联系站长配置 XHS_COOKIE）"
        );
      }
      // 尝试打印 HTML 片段帮助调试
      console.log("[xhs] HTML preview:", html.substring(0, 500));
      return output(400, "未找到页面数据，小红书可能更新了页面结构");
    }

    jsonRaw = sanitizeInitialStateJson(jsonRaw);

    let decoded;
    try {
      decoded = JSON.parse(jsonRaw);
    } catch (e) {
      console.log("[xhs] JSON parse error:", e.message);
      return output(400, "JSON数据解析失败");
    }

    if (!decoded || typeof decoded !== "object") {
      return output(400, "数据格式错误");
    }

    const noteData = resolveNotePayload(decoded);

    if (!noteData || typeof noteData !== "object") {
      console.log("[xhs] decoded keys:", Object.keys(decoded));
      return output(400, "数据结构不匹配，请检查链接是否为有效的小红书内容");
    }

    // 安全地构建基础数据
    // 内部 userId（16 进制）仅用于拼博主主页链接与抓主页，不对外展示
    const userId =
      safeGet(noteData, "user.userId") || safeGet(noteData, "user.id") || "";
    // 互动统计：主路径取 noteData.interactInfo，缺失时从 noteDetailMap 全量兜底
    const interactInfo = noteData.interactInfo || findFirstInteractInfo(decoded);
    const data = {
      author:
        safeGet(noteData, "user.nickName") ||
        safeGet(noteData, "user.nickname") ||
        safeGet(noteData, "user.name") ||
        "",
      // 小红书号（自定义号）：只填真实 redId；笔记页缺失时稍后由主页数据补齐，
      // 绝不回退内部 userId（16 进制内部标识，与主页展示的自定义号不一致）
      authorID: safeGet(noteData, "user.redId") || "",
      // 博主主页链接：由 userId 拼 profile 首页（前端可点击跳转）
      authorUrl: userId
        ? `https://www.xiaohongshu.com/user/profile/${userId}`
        : "",
      // 博主简介（笔记页 user 可能带，缺失时前端自动隐藏）
      sign:
        safeGet(noteData, "user.description") ||
        safeGet(noteData, "user.desc") ||
        "",
      title: noteData.title || "",
      desc: noteData.desc || noteData.description || "",
      avatar:
        safeGet(noteData, "user.avatar") ||
        safeGet(noteData, "user.avatarUrl") ||
        "",
      // —— 帖子（笔记）信息 ——
      // 发布时间：小红书 time/lastUpdateTime 为毫秒时间戳，统一转成 unix 秒给前端 formatTime
      time: (() => {
        const rawTime = noteData.time ?? noteData.lastUpdateTime;
        return typeof rawTime === "number" && rawTime >= 1e12
          ? Math.floor(rawTime / 1000)
          : (rawTime ?? "");
      })(),
      // 笔记互动统计（interactInfo 各计数可能是字符串，保留原始值交给前端格式化）
      like: safeGet(interactInfo, "likedCount") ?? "",
      favorite: safeGet(interactInfo, "collectedCount") ?? "",
      reply: safeGet(interactInfo, "commentCount") ?? "",
      share: safeGet(interactInfo, "sharedCount") ?? "",
      noteId: noteData.noteId ?? "",
    };

    // 博主主页公开统计（关注/粉丝/获赞与收藏）与简介兜底：笔记页不含统计，
    // 额外抓一次主页补齐；失败/被风控时静默降级，缺失字段前端徽标自动隐藏。
    if (userId) {
      const stats = await fetchXhsProfileStats(
        userId,
        extractProfileToken(html, userId)
      );
      if (stats) {
        // 身份校验：主页数据必须与笔记指向同一博主，避免张冠李戴
        // - 笔记页带自定义号(redId)：主页 redId 须一致（主页 redId 缺失时按昵称比对）
        // - 笔记页无 redId（仅有内部 userId）：主页昵称须与笔记作者一致
        const noteRedId = data.authorID || "";
        const pageMatches = noteRedId
          ? stats.userKey === noteRedId ||
            (stats.nickname && stats.nickname === data.author)
          : !stats.nickname || stats.nickname === data.author;
        if (pageMatches) {
          // 小红书号以主页为准：笔记页缺失 redId 时补齐，保证与博主主页显示一致
          if (stats.redId) data.authorID = stats.redId;
          data.followingCount = stats.followingCount;
          data.followerCount = stats.followerCount;
          data.totalFavorited = stats.totalFavorited;
          if (!data.sign && stats.sign) data.sign = stats.sign;
          console.log(
            `[xhs] profile stats: 关注=${stats.followingCount} 粉丝=${stats.followerCount} 获赞与收藏=${stats.totalFavorited}`
          );
          if (stats.unreliable) {
            data.statsUnreliable = true;
            console.log(
              "[xhs] profile stats SANITIZED: XHS_COOKIE 缺失或已过期，主页统计为脱敏估算值，配置登录 Cookie 后显示精确数据"
            );
          }
        } else {
          console.log(
            `[xhs] profile mismatch: page user=[${stats.userKey}] vs note user=[${noteRedId}] ${data.author}, skipped`
          );
        }
      }
    }

    // 检查视频URL
    let videoUrl = null;
    let videoQualities;
    const videoStream = safeGet(noteData, "video.media.stream");

    if (videoStream && typeof videoStream === "object") {
      // 流表键名随版本变化：旧版 h264/h265/av1，新版编码档位标识 EF4~EF7。
      // 优先取浏览器兼容性最好的 h264；旧键全缺时遍历所有数组键，避免
      // 视频笔记因键名不匹配被误判成图文（丢掉整条视频直链）。
      const list = collectVideoEntries(videoStream);
      if (list.length) {
        const stableUrls = await Promise.all(list.map(pickStableVideoUrl));
        const resolved = list
          .map((entry, i) => ({ entry, url: stableUrls[i] }))
          .filter(({ url }) => url)
          .sort(
            (a, b) =>
              (Number(b.entry.height) || 0) - (Number(a.entry.height) || 0) ||
              (Number(b.entry.width) || 0) - (Number(a.entry.width) || 0)
          );
        videoUrl = resolved[0]?.url || null;
        videoQualities = buildQualityList(
          resolved.map(({ entry, url }) => {
            const height = Number(entry.height) || 0;
            const width = Number(entry.width) || 0;
            return {
              quality: height || width,
              label: height ? `${height}p` : width ? `${width}w` : "",
              url,
            };
          })
        );
      }
    }

    if (videoUrl) {
      console.log("[xhs] videoUrl:", videoUrl);
      // 视频内容
      data.cover = "";
      const imageList = noteData.imageList;
      if (Array.isArray(imageList) && imageList.length > 0 && imageList[0]) {
        const first = imageList[0];
        data.cover = (
          first.urlDefault ||
          first.url ||
          safeGet(first, "infoList.0.url") ||
          ""
        ).replace(/^http:/i, "https:");
      }
      data.url = videoUrl;
      if (videoQualities) data.qualities = videoQualities;
      data.type = "video";
      return output(200, "解析成功", data);
    }

    // 检查图片内容
    const imageList = noteData.imageList;
    if (Array.isArray(imageList) && imageList.length > 0) {
      const images = [];
      let cover = "";

      for (let i = 0; i < imageList.length; i++) {
        const img = imageList[i];
        if (img && typeof img === "object") {
          let imageUrl = (
            img.urlDefault ||
            img.url ||
            safeGet(img, "infoList.0.url") ||
            ""
          ).replace(/^http:/i, "https:");
          if (imageUrl) {
            images.push(imageUrl);
            if (i === 0) cover = imageUrl;
          }
        }
      }

      if (images.length > 0) {
        data.cover = cover;
        data.images = images;
        data.type = "image";
        return output(200, "解析成功", data);
      }
    }

    return output(404, "该内容不包含视频或图片");
  } catch (error) {
    logger.error("xhs parse error:", error);
    return output(500, "服务器内部错误");
  }
}
