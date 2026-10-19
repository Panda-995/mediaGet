/** P0 抽取自 app/api/weibo/route.js，逻辑逐字搬移，行为零变化 */
import { TIMEOUT } from "./http";
import { buildQualityList } from "./quality";

/**
 * 微博视频解析（游客模式，无需登录 Cookie）
 *
 * 背景：2026-08 起微博对无 Cookie 的服务端请求全部 302 到登录墙（passport.weibo.com），
 * 旧实现依赖环境变量 WEIBO_COOKIE，未配置时 component 接口拿不到数据 → 全量解析失败。
 *
 * 2026-08-27 修复：旧版「a=enter 一次性下发 Cookie」已失效（现在返回需要执行 JS 指纹的 HTML 页面）。
 * 新版访客流程（与新浪访客系统 JS 一致，weiboSpider 等开源爬虫同款）：
 *  1. POST /visitor/genvisitor 上报伪指纹 → 拿 tid；
 *  2. GET  /visitor/visitor?a=incarnate&t={tid}&w=2&c=100 → 拿 SUB/SUBP 访客 Cookie；
 *  3. 链接是 fid（1034:xxx）时先用 tv/api/component 换成真实 mid（桌面接口不认 fid，直接 400）；
 *  4. 主通道 桌面 GET weibo.com/ajax/statuses/show?id={bid|mid} —— 作品主体：正文 / pic_ids+pic_infos
 *     图集最大档 / mix_media_info.items 混排（视频+图片）/ playback_list 最高清晰度 /
 *     region_name / 作者级获赞；
 *  5. 作者卡 桌面 GET weibo.com/ajax/profile/info?uid={authorId} —— 简介 / 关注 / 精确粉丝 /
 *     认证说明 / 微博总数（第 4 步内嵌的 user 没有这些）；
 *  6. 第 4 步失败 → 降级 GET m.weibo.cn/statuses/show；再失败 → 降级 tv/api/component。
 *
 * 为什么桌面当主通道：手机通道视频清晰度封顶 720p（page_info.urls 只有 720p/480p），
 * 1080p 只出现在桌面 media_info.playback_list 里；图片手机只给 /mw2000/（实测 859KB），
 * 桌面 pic_infos 给全档位表，largest 是 /large/（实测 3.7MB）。字段口径实测记录见 API.md 微博节。
 *
 * 游客 Cookie 运行时获取并模块级缓存（约 25 分钟），不读环境变量、无持久化。
 */

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const TIMEOUT_MS = TIMEOUT.DEFAULT;

/** 访客 Cookie 模块级缓存（SUB 有效期较长，避免每次解析都跑两趟访客流程） */
let visitorCookieCache = "";
let visitorCookieExpireAt = 0;
const VISITOR_COOKIE_TTL_MS = 25 * 60 * 1000;

/** 微博字符型 mid 的 base62 字符表（数字+小写+大写） */
const MID_BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * 字符型 mid（如 "RfXp5BMsF"）→ 数字 mid（16 位十进制，如 "5336206955708503"）。
 * 微博编码规则：数字 mid 从右往左每 7 位一组 → base62 4 字符；
 * 解码则反向：字符 mid 从右往左每 4 字符一组 → 十进制，除最左组外每组补零到 7 位。
 */
function url2mid(urlMid) {
  if (!urlMid) return "";
  const groups = [];
  for (let i = urlMid.length - 4; i > -4; i -= 4) {
    const start = i > 0 ? i : 0;
    const len = i > 0 ? 4 : i + 4;
    const seg = urlMid.substring(start, start + len);
    let n = 0;
    for (let k = 0; k < seg.length; k++) {
      const idx = MID_BASE62.indexOf(seg[k]);
      if (idx < 0) return ""; // 含非法字符
      n = n * 62 + idx;
    }
    groups.unshift(String(n).padStart(7, "0"));
  }
  // 去掉最左组的前导 0，得到数字 mid
  return groups.join("").replace(/^0+/, "");
}

/**
 * 从各种微博分享链接形态中提取视频 oid（形如 "1034:5336206955708503"）。
 * 支持：tv/show/{id}、show?fid={id}、video.weibo.com/show、纯数字等。
 */
function extractId(rawUrl) {
  let id = null;
  if (rawUrl.includes("show?fid=")) {
    const m = rawUrl.match(/fid=([^&]+)/);
    id = m ? m[1] : null;
  } else if (rawUrl.includes("tv/show/")) {
    const m = rawUrl.match(/tv\/show\/([^?&/]+)/);
    id = m ? m[1] : null;
  } else {
    const m = rawUrl.match(/\d+\:\d+/);
    id = m ? m[0] : null;
  }
  // 兜底：weibo.com/{uid}/{mid} 详情页，取 16 位纯数字 mid
  if (!id) {
    const m = rawUrl.match(/(\d{16})/);
    id = m ? m[1] : null;
  }
  // 字符型 mid：weibo.com/{uid}/{mid}（如 RfXp5BMsF），先转成数字 mid
  if (!id) {
    const m = rawUrl.match(/weibo\.com\/\d+\/([A-Za-z0-9]{5,16})/);
    if (m) {
      id = url2mid(m[1]) || m[1];
    }
  }
  return id ? decodeURIComponent(id) : null;
}

/**
 * 获取微博游客通行凭据（SUB/SUBP）。两段式：
 *  1) POST /visitor/genvisitor 上报伪指纹拿 tid；
 *  2) GET  /visitor/visitor?a=incarnate&t={tid}&w=2&c=100 拿 SUB。
 * 结果模块级缓存约 25 分钟。
 */
async function getVisitorCookie() {
  if (visitorCookieCache && Date.now() < visitorCookieExpireAt) {
    return visitorCookieCache;
  }
  try {
    // 1) genvisitor：上报伪设备指纹，换取 tid
    const fpBody =
      'cb=gen_callback&fp={"os":"1","browser":"Safari16","fonts":"undefined","screen":"*","plugins":""}';
    const res1 = await fetch("https://visitor.passport.weibo.cn/visitor/genvisitor", {
      method: "POST",
      headers: {
        "User-Agent": UA_MOBILE,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://m.weibo.cn/",
      },
      body: fpBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text1 = await res1.text();
    const tid = text1.match(/"tid":"([^"]+)"/)?.[1];
    if (!tid) return "";

    // 2) incarnate：tid 换取 SUB/SUBP 访客 Cookie
    const res2 = await fetch(
      `https://visitor.passport.weibo.cn/visitor/visitor?a=incarnate&t=${encodeURIComponent(
        tid
      )}&w=2&c=100&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
      {
        headers: { "User-Agent": UA_MOBILE, Referer: "https://m.weibo.cn/" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    const text2 = await res2.text();
    const sub = text2.match(/"sub":"([^"]+)"/)?.[1];
    const subp = text2.match(/"subp":"([^"]+)"/)?.[1];
    if (!sub) {
      console.log(`[weibo] visitor cookie failed: stage2 status=${res2.status} no SUB`);
      return "";
    }

    const cookie = `SUB=${sub}${subp ? `; SUBP=${subp}` : ""}`;
    visitorCookieCache = cookie;
    visitorCookieExpireAt = Date.now() + VISITOR_COOKIE_TTL_MS;
    console.log(`[weibo] visitor cookie ok (SUB acquired, cached ${VISITOR_COOKIE_TTL_MS / 60000}min)`);
    return cookie;
  } catch (e) {
    console.log(`[weibo] visitor cookie error: ${e?.message || e}`);
    return "";
  }
}

/**
 * 通用 JSON 请求。label 非空时打印生产可见诊断日志（Vercel 等无本地控制台的环境
 * 也能从函数日志定位是哪一步失败：访客 Cookie / component / m.weibo.cn）。
 */
async function fetchJson(url, options = {}, label = "") {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": UA_DESKTOP,
        ...(options.headers || {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ct = res.headers.get("content-type") || "";
    if (label) console.log(`[weibo] ${label} status=${res.status} ct=${ct.split(";")[0]}`);
    if (!res.ok && !ct.includes("json")) return null;
    const json = await res.json();
    if (label) console.log(`[weibo] ${label} json keys=[${Object.keys(json).join(", ")}]`);
    return json;
  } catch (e) {
    if (label) console.log(`[weibo] ${label} error=${e?.message || e}`);
    return null;
  }
}

/** 规范化微博 CDN 链接（"//xxx" → "https://xxx"） */
function normalizeUrl(u) {
  if (!u) return "";
  return u.startsWith("//") ? `https:${u}` : u;
}

/**
 * 微博计数归一化：兼容数字 / 数字字符串 / 千分位字符串（"40,476,159"）/
 * 中文单位字符串（"32.1万"、"1.2亿"）。
 * m.weibo.cn 接口对较大的关注/粉丝/互动数会返回带单位的字符串，桌面 ajax 的作者级
 * 累计数用千分位分组，直接 Number() 得到 NaN，导致前端按 0 处理隐藏该行。
 */
function parseCount(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/,/g, "");
  const w = /^([\d.]+)\s*万$/.exec(s);
  if (w) return parseFloat(w[1]) * 10000;
  const y = /^([\d.]+)\s*亿$/.exec(s);
  if (y) return parseFloat(y[1]) * 100000000;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** 微博图 URL 统一放大尺寸（缩略图 → 原图） */
function normalizeImageUrl(u) {
  const url = normalizeUrl(u);
  if (!url) return "";
  // sinaimg 的尺寸标识：thumb150/bmiddle/orj360 替换为 large（原图）
  return url
    .replace(/\/thumb150\//, "/large/")
    .replace(/\/bmiddle\//, "/large/")
    .replace(/\/orj360\//, "/large/");
}

/**
 * 剥掉新浪图床的防盗链签名参数（?KID=imgbed,tva&Expires=…&ssig=…）。
 * 桌面接口的头像 / avatar_hd 都带签名，直接进出口是一条会过期的死链；
 * 实测同一路径去掉整串 query 后仍然 200 且字节相同（回源需带 Referer: weibo.com，
 * 这对头由宿主的取流层补，内核只负责给出不会过期的路径）。
 * 只处理图床域名：livephoto 的 video.weibo.com/media/play?livephoto=… 查询串是资源本体，不能剥。
 */
const SINA_IMG_HOST = /^https?:\/\/(?:[\w-]+\.)+(?:sinaimg\.cn|weibocdn\.com)\//i;
function stripImageSignature(u) {
  const url = normalizeUrl(u);
  if (!url || !SINA_IMG_HOST.test(url)) return url;
  return url.split("?")[0];
}

/**
 * 桌面 pic_infos 单图的档位表。按实测字节从大到小排：
 * largest(/large/ 3.7MB) > mw2000(860KB) > original(/orj1080/ 146KB) —— 字段名与大小无关，
 * 不能按名字猜，只能按表取第一个存在的档。
 */
const RENDITION_ORDER = ["largest", "large", "mw2000", "original", "bmiddle", "thumbnail"];
function pickRenditionUrl(info) {
  for (const key of RENDITION_ORDER) {
    const url = stripImageSignature(info?.[key]?.url || "");
    if (url) return url;
  }
  return "";
}

/**
 * 从桌面 media_info.playback_list 取最高清晰度视频直链。
 * 两个必须处理的坑：表里混有非视频条目（scrubber_hd 是进度条预览图，meta.type=3，指向一张 jpg）；
 * 而 media_info 的平铺字段（mp4_hd_url / stream_url_hd / mp4_720p_mp4 / h265_* / inch_*）
 * 实测全部指向同一个 720p 文件，1080p 只存在于本表 —— 只读平铺字段等于白换桌面通道。
 * 清晰度文案取 meta.quality_label（"1080p"）；quality_desc 不可用于区分，
 * 实测 1080p 与 720p 都写「高清」。
 */
function pickBestPlayback(mediaInfo) {
  const list = Array.isArray(mediaInfo?.playback_list) ? mediaInfo.playback_list : [];
  const candidates = list
    .map((p) => ({ meta: p?.meta || {}, play: p?.play_info || {} }))
    .filter(({ meta, play }) => meta.type === 1 && meta.is_hidden !== true && play?.url);
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) => Number(b.meta.quality_index || 0) - Number(a.meta.quality_index || 0)
  );
  // playback_list 本身就是全档位表（实测 1080/720/480），逐档映射给前端下拉；
  // 最高档同时作为单直链出口。type=3 的 scrubber 已在上面滤掉。
  const qualities = buildQualityList(
    candidates.map(({ meta, play }) => {
      const index = Number(meta.quality_index || 0);
      return {
        quality: index,
        label: String(meta.quality_label || (index ? `${index}P` : "")),
        url: normalizeUrl(play.url),
      };
    })
  );
  const { meta, play } = candidates[0];
  const index = Number(meta.quality_index || 0);
  return {
    url: normalizeUrl(play.url),
    qualityLabel: String(meta.quality_label || (index ? `${index}P` : "")),
    qualities,
  };
}

/** 视频封面：手机 page_pic 是 {url,width,height} 对象，桌面是裸字符串，两种形态都要吃 */
function readPagePic(pi) {
  const p = pi?.page_pic;
  const raw = typeof p === "string" ? p : p?.url || pi?.media_info?.poster || "";
  return stripImageSignature(raw);
}

/** 秒 → 毫秒（契约口径：duration 一律毫秒，换算归各解析器） */
function secondsToMs(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

/** 去掉正文里的 HTML 标签 */
function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, "").trim();
}

/** 从 page_info 提取视频直链（media_url / media_info 多级降级，兼容单视频与多视频数组元素） */
function pickMediaUrl(pi) {
  if (!pi) return "";
  const media = pi.media_info || {};
  return (
    pi.media_url ||
    media.stream_url_hd ||
    media.stream_url ||
    media.mp4_hd_url ||
    media.mp4_720p_mp4 ||
    media.mp4_hd_mp4 ||
    media.mp4_ld_mp4 ||
    media.mp4_url ||
    media.mp4_sd_url ||
    media.hd_url ||
    media.ld_url ||
    media.origin_url ||
    ""
  );
}

/** 视频时长（秒）→ "mm:ss" / "h:mm:ss"，无效返回空串 */
function formatSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = Math.round(n);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 从 mblog 对象提取图片列表（pics[].large.url，兼容字符串项；过滤视频项） */
function extractImagesFromMblog(mblog) {
  if (!Array.isArray(mblog?.pics)) return [];
  const images = [];
  for (const p of mblog.pics) {
    // 多视频帖的每个分P是 pics 里的视频项（type=video + videoSrc 直链），不是图集内容
    if (p?.type === "video" || p?.videoSrc) continue;
    const raw =
      (typeof p === "string" ? p : "") ||
      p?.large?.url ||
      p?.url ||
      "";
    const url = normalizeImageUrl(raw);
    if (url) images.push(url);
  }
  return images;
}

/**
 * 从 mblog 提取视频列表。
 * 多视频帖：每个分P都在 pics 里（type=video + videoSrc 直链），逐个提取；
 * pics 无视频时（图文混排单视频 / 纯单视频），用 page_info 兜底
 * （page_info 仅含主视频且 URL 与 pics[0] 同视频但清晰度不同，不能简单按 URL 去重合并）。
 */
function extractVideosFromMblog(mblog) {
  const videos = [];
  // 1) pics 视频项：多视频帖的所有分P（含主视频）都在这里
  for (const p of Array.isArray(mblog?.pics) ? mblog.pics : []) {
    const videoSrc = normalizeUrl(p?.videoSrc || "");
    if (!videoSrc) continue;
    const coverUrl = normalizeImageUrl(p?.large?.url || p?.url || "");
    videos.push({
      title: "",
      url: videoSrc,
      duration: secondsToMs(p?.duration),
      durationFormat: formatSeconds(p?.duration),
      cover: coverUrl,
    });
  }
  // 2) page_info 兜底：pics 无视频项时，提取 page_info 主视频（兼容对象/数组）
  if (videos.length === 0) {
    const pageInfos = Array.isArray(mblog?.page_info)
      ? mblog.page_info
      : mblog?.page_info
        ? [mblog.page_info]
        : [];
    for (const pi of pageInfos) {
      const mediaUrl = normalizeUrl(pickMediaUrl(pi));
      if (!mediaUrl) continue;
      const media = pi.media_info || {};
      videos.push({
        title: (pi.content1 || pi.title || "").trim(),
        url: mediaUrl,
        duration: secondsToMs(media.duration),
        durationFormat: formatSeconds(media.duration),
        cover: readPagePic(pi),
      });
    }
  }
  return videos;
}

/**
 * 新浪图片去重键：sinaimg 同一张图会以多种尺寸标识出现
 * （thumb150 / bmiddle / orj360 / orj480 / large），文件名相同。
 * 取 URL 最后一段文件名（小写）作为比较键，跨尺寸识别同一张图。
 */
function sinaImageKey(u) {
  const url = normalizeUrl(u);
  if (!url) return "";
  const m = /\/[^/]+\.(?:jpe?g|png|gif|webp)$/i.exec(url);
  return m ? m[0].toLowerCase() : url.toLowerCase();
}

/**
 * 从 m.weibo.cn 详情 JSON 提取微博信息（statuses/show 的 data 即 mblog 对象）。
 * 按媒体类型返回：
 *  - 有视频直链 → type: video（url/cover）
 *  - 无视频但有图片 → type: image（images 图集 + url/cover 指向第一张）
 *  - 仅有文字 → type: text（无媒体字段，前端展示提示）
 */
function extractFromMWeibo(json) {
  const mblog = json?.data?.mblog || json?.data || null;
  if (!mblog) return null;
  const text = stripHtml(mblog.text);
  const title = text.slice(0, 120);
  const user = mblog.user || {};
  const author = user.screen_name || "";
  // 头像出直链：sinaimg 防盗链由宿主的取流层补 Referer（web 出口包站内图片代理）
  const avatar = stripImageSignature(
    user.avatar_large || user.avatar_hd || user.profile_image_url || ""
  );
  const time = mblog.created_at || "";
  // 博主主页公开信息（对齐小红书博主卡：可点主页 + 简介 + 关注/粉丝）
  const uid = String(user.idstr || user.id || "");
  const authorUrl = uid ? `https://weibo.com/u/${uid}` : "";
  const sign = user.description || "";
  const followingCount = parseCount(user.follow_count);
  const followerCount = parseCount(user.followers_count);
  // 微博互动统计（对齐小红书信息面板：点赞/评论/转发）
  const like = parseCount(mblog.attitudes_count);
  const reply = parseCount(mblog.comments_count);
  const share = parseCount(mblog.reposts_count);
  const base = {
    title,
    desc: text,
    author,
    authorId: uid,
    authorUrl,
    sign,
    followingCount,
    followerCount,
    avatar,
    time,
    like,
    reply,
    share,
  };

  // 1) 视频：多视频帖每个分P在 pics 里（type=video + videoSrc 直链），
  //    page_info 仅为主视频，pics 有视频项即优先（其 URL 与 pics[0] 同视频但清晰度不同）。
  //    图集 = pics 中非视频项；各视频封面（同文件不同尺寸标识）再按文件名剔除，防止残留。
  const videoItems = extractVideosFromMblog(mblog);
  if (videoItems.length > 0) {
    const videoCoverKeys = new Set();
    for (const v of videoItems) {
      const k = sinaImageKey(v.cover || "");
      if (k) videoCoverKeys.add(k);
    }
    const images = extractImagesFromMblog(mblog).filter((u) => {
      const k = sinaImageKey(u);
      return !k || !videoCoverKeys.has(k);
    });
    const first = videoItems[0];
    return {
      ...base,
      cover: first.cover,
      url: first.url,
      images: images.length > 0 ? images : undefined,
      videos: videoItems.length > 1 ? videoItems : undefined,
      // 与桌面主通道同规则：单P 才把时长提到顶层（手机通道无清晰度文案，故不写 qualityLabel）
      duration: videoItems.length === 1 ? first.duration : undefined,
      type: "video",
    };
  }

  // 2) 图片：mblog.pics 图集（直链原样透出，防盗链由宿主取流层负责）
  const images = extractImagesFromMblog(mblog);
  if (images.length > 0) {
    return {
      ...base,
      cover: images[0],
      url: images[0],
      images,
      type: "image",
    };
  }

  // 3) 纯文字：无媒体，仅返回元数据
  return { ...base, type: "text" };
}

/**
 * 桌面端作品接口（weibo.com/ajax/statuses/show）主通道提取器。
 * 该接口直接以状态对象为响应顶层（没有 m.weibo.cn 的 data 包装）。
 *
 * 取数要点（全部为 2026-10-18 实测）：
 *  - 视频直链只认 media_info.playback_list 的最高档，手机通道封顶 720p；
 *  - 图集按 pic_ids 保序，逐张从 pic_infos 的档位表取最大档，不能正则硬改写；
 *  - livephoto 的动态直链在 pic_infos[pid].video，手机那边表现为 pics[].videoSrc；
 *  - user.status_total_counter.like_cnt 是**作者**累计获赞（total_cnt 是赞+评论+转发，
 *    属互动总数，不能当获赞用），帖子级点赞是 attitudes_count；
 *  - region_name 是 IP 属地，形如「发布于 山东」；
 *  - media_info.author_name 是视频素材作者（实测一条央视新闻的投稿里它≠博文作者），
 *    禁止拿来覆盖 author；
 *  - 内嵌 user 没有 description / follow_count / followers_count，那三项由作者接口补。
 */
function extractFromDesktopShow(json) {
  const status = json && json.user !== undefined ? json : json?.data;
  if (!status || (!status.text && !status.page_info && !status.pic_num)) return null;

  const text = stripHtml(status.text || status.text_raw);
  const user = status.user || {};
  const uid = String(user.idstr || user.id || "");
  const base = {
    title: text.slice(0, 120),
    desc: text,
    author: user.screen_name || "",
    authorId: uid,
    authorUrl: uid ? `https://weibo.com/u/${uid}` : "",
    avatar: stripImageSignature(
      user.avatar_hd || user.avatar_large || user.profile_image_url || ""
    ),
    time: status.created_at || "",
    like: parseCount(status.attitudes_count),
    reply: parseCount(status.comments_count),
    share: parseCount(status.reposts_count),
  };
  // 新字段遵循「无源不造数」：拿不到就不写键，不落 0 占位
  const totalFavorited = parseCount(user.status_total_counter?.like_cnt);
  if (totalFavorited) base.totalFavorited = totalFavorited;
  const ipRegion = String(status.region_name || "").replace(/^发布于\s*/, "").trim();
  if (ipRegion) base.ipRegion = ipRegion;

  const picIds = Array.isArray(status.pic_ids)
    ? status.pic_ids
    : Object.keys(status.pic_infos || {});
  const picInfos = status.pic_infos || {};

  // 1) 视频：page_info 主视频（playback_list 优先）→ mix_media_info 混排项 →
  //    图集里的 livephoto 直链。同一视频可能出现在多个来源，按直链去重。
  const videos = [];
  const seenVideoUrls = new Set();
  const pushVideo = (v) => {
    if (!v?.url || seenVideoUrls.has(v.url)) return;
    seenVideoUrls.add(v.url);
    videos.push(v);
  };
  const pageInfos = Array.isArray(status.page_info)
    ? status.page_info
    : status.page_info
      ? [status.page_info]
      : [];
  for (const pi of pageInfos) {
    const media = pi?.media_info || {};
    const best = pickBestPlayback(media);
    const url = best?.url || normalizeUrl(pickMediaUrl({ media_info: media, ...pi }));
    if (!url) continue;
    pushVideo({
      title: (pi.content1 || pi.title || "").trim(),
      url,
      duration: secondsToMs(media.duration),
      durationFormat: formatSeconds(media.duration),
      qualityLabel: best?.qualityLabel || "",
      ...(best?.qualities ? { qualities: best.qualities } : {}),
      cover: readPagePic(pi),
    });
  }
  // 混排帖（视频 + 图片）：媒体全部在 mix_media_info.items，顶层没有 page_info/pics。
  // 视频项 data 是 page_info 形态（media_info + page_pic），图片项 data 是档位表形态。
  const mixItems = Array.isArray(status.mix_media_info?.items)
    ? status.mix_media_info.items
    : [];
  for (const item of mixItems) {
    const data = item?.data;
    if (item?.type === "video" && data) {
      const media = data.media_info || {};
      const best = pickBestPlayback(media);
      const url = best?.url || normalizeUrl(pickMediaUrl(data));
      if (url) {
        pushVideo({
          title: (data.content1 || data.page_title || "").trim(),
          url,
          duration: secondsToMs(media.duration),
          durationFormat: formatSeconds(media.duration),
          qualityLabel: best?.qualityLabel || "",
          ...(best?.qualities ? { qualities: best.qualities } : {}),
          cover: readPagePic(data),
        });
      }
    } else if (item?.type === "pic" && data) {
      const mov = normalizeUrl(data.video || "");
      // livephoto 的 still 兼作封面，不进图集（与手机通道口径一致）
      if (mov) {
        pushVideo({
          title: "",
          url: mov,
          duration: undefined,
          durationFormat: "",
          cover: pickRenditionUrl(data),
        });
      }
    }
  }
  for (const pid of picIds) {
    const info = picInfos[pid] || {};
    const mov = normalizeUrl(info.video || "");
    if (mov) {
      pushVideo({
        title: "",
        url: mov,
        duration: undefined,
        durationFormat: "",
        cover: pickRenditionUrl(info),
      });
    }
  }

  // 2) 图集：混排图片项与 pic_ids 均按原顺序取最大档；同一张图（不同尺寸标识）
  //    只留一张，并剔除被各视频封面占用的那张
  const videoCoverKeys = new Set();
  for (const v of videos) {
    const k = sinaImageKey(v.cover || "");
    if (k) videoCoverKeys.add(k);
  }
  const imageCandidates = [];
  for (const item of mixItems) {
    if (item?.type === "pic" && item.data) {
      imageCandidates.push(pickRenditionUrl(item.data));
    }
  }
  for (const pid of picIds) {
    imageCandidates.push(pickRenditionUrl(picInfos[pid]));
  }
  const images = [];
  const seenImageKeys = new Set();
  for (const u of imageCandidates) {
    if (!u) continue;
    const k = sinaImageKey(u) || u;
    if (videoCoverKeys.has(k) || seenImageKeys.has(k)) continue;
    seenImageKeys.add(k);
    images.push(u);
  }

  if (videos.length > 0) {
    const first = videos[0];
    return {
      ...base,
      cover: first.cover,
      url: first.url,
      images: images.length > 0 ? images : undefined,
      videos: videos.length > 1 ? videos : undefined,
      // 单P 时 videos 不下发，时长与清晰度只剩顶层字段可承载（顶层不写 videos[0] 的值，
      // 免得多P 时「duration/qualityLabel = P1」被误读成整条微博的总时长/统一档位）
      duration: videos.length === 1 ? first.duration : undefined,
      qualityLabel:
        videos.length === 1 ? first.qualityLabel || undefined : undefined,
      qualities: videos.length === 1 ? first.qualities : undefined,
      type: "video",
    };
  }
  if (images.length > 0) {
    return { ...base, cover: images[0], url: images[0], images, type: "image" };
  }
  return { ...base, type: "text" };
}

/**
 * 桌面端作者接口（weibo.com/ajax/profile/info）的作者卡提取。
 * 失败态全是 **HTTP 200 + 业务错误体**，不能判状态码：
 *  受限/注销号 → {"error_type":"link","url":"https://weibo.com/sorry?usernotexists…"}；
 *  不存在号   → {"user":{},"message":"用户不存在","abnormal":true,"ok":1}。
 * 所以只认 data.user 里有 screen_name 或 idstr。
 */
function extractFromDesktopProfile(json) {
  const user = json?.data?.user;
  if (!user || (!user.screen_name && !user.idstr)) return null;
  const out = {
    authorId: String(user.idstr || user.id || ""),
    sign: user.description || "",
    followingCount: parseCount(user.friends_count),
    // 精确整数（手机通道同字段是四舍五入字符串 "129.8万" → 1298000，真值 1298045）
    followerCount: parseCount(user.followers_count),
    totalFavorited: parseCount(user.status_total_counter?.like_cnt),
    verifiedReason: user.verified_reason || "",
    statusesCount: parseCount(user.statuses_count),
    avatar: stripImageSignature(user.avatar_hd || user.avatar_large || ""),
  };
  return out;
}

const DESKTOP_ACCEPT = "application/json, text/plain, */*";

/** 桌面作品接口请求（bid 与 16 位数字 mid 两种 id 形态都收；fid 会 400） */
function fetchDesktopShow(id, cookie) {
  return fetchJson(
    `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(id)}&locale=zh-CN&isGetLongText=true`,
    {
      headers: {
        Cookie: cookie,
        Referer: "https://weibo.com/",
        "X-Requested-With": "XMLHttpRequest",
        Accept: DESKTOP_ACCEPT,
      },
    },
    "desktop-show"
  );
}

/** 桌面作者接口请求（无访客 Cookie 时 403） */
function fetchDesktopProfile(uid, cookie) {
  return fetchJson(
    `https://weibo.com/ajax/profile/info?uid=${encodeURIComponent(uid)}&scene=profile`,
    {
      headers: {
        Cookie: cookie,
        Referer: `https://weibo.com/u/${uid}`,
        "X-Requested-With": "XMLHttpRequest",
        Accept: DESKTOP_ACCEPT,
      },
    },
    "desktop-profile"
  );
}

/** 手机通道请求：必须带 X-Requested-With 等 H5 头，否则返回 HTML 错误页而非 JSON */
function fetchMWeibo(id, cookie, label) {
  return fetchJson(
    `https://m.weibo.cn/statuses/show?id=${encodeURIComponent(id)}`,
    {
      headers: {
        "User-Agent": UA_MOBILE,
        Cookie: cookie,
        Referer: "https://m.weibo.cn/",
        "X-Requested-With": "XMLHttpRequest",
        "MWeibo-Pwa": "1",
        Accept: DESKTOP_ACCEPT,
      },
    },
    label
  );
}

/** 官方 component 接口：唯一能把 fid（1034:xxx）映射到真实 mid 的公开入口 */
function fetchComponent(id, cookie) {
  return fetchJson(
    `https://weibo.com/tv/api/component?page=/tv/show/${encodeURIComponent(id)}`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Referer: `https://weibo.com/tv/show/${id}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: `data=${encodeURIComponent(`{"Component_Play_Playinfo":{"oid":"${id}"}}`)}`,
    },
    "component"
  );
}

/**
 * 作者卡补全：桌面作品接口内嵌的 user 没有简介 / 关注 / 粉丝，必须走独立作者接口。
 * 同人不匹配（uid 解不出他人卡片）或接口给出业务错误体时整体降级，不写空占位。
 * 返回是否补上，供主链路决定要不要再用手机通道兜作者字段。
 */
async function attachAuthorProfile(data, cookie) {
  if (!data || !data.authorId) return false;
  const extra = extractFromDesktopProfile(
    await fetchDesktopProfile(data.authorId, cookie)
  );
  if (!extra || extra.authorId !== data.authorId) return false;
  if (extra.sign) data.sign = extra.sign;
  if (extra.followingCount) data.followingCount = extra.followingCount;
  if (extra.followerCount) data.followerCount = extra.followerCount;
  if (extra.totalFavorited) data.totalFavorited = extra.totalFavorited;
  if (extra.verifiedReason) data.verifiedReason = extra.verifiedReason;
  if (extra.statusesCount) data.statusesCount = extra.statusesCount;
  if (extra.avatar) data.avatar = extra.avatar;
  return true;
}

/**
 * 作者接口不可用时的最后一档：手机通道的内嵌 user 有简介 / 关注 / 粉丝，
 * 只回补这三项（作品数据仍以桌面主通道结果为准），避免作者卡整块丢失。
 */
async function fillAuthorFromMobile(data, id, cookie) {
  if (!data || data.sign && data.followerCount) return;
  const fromM = extractFromMWeibo(await fetchMWeibo(id, cookie, "mweibo-author-fill"));
  if (!fromM) return;
  if (data.authorId && fromM.authorId && data.authorId !== fromM.authorId) return;
  if (fromM.sign) data.sign = fromM.sign;
  if (fromM.followingCount) data.followingCount = fromM.followingCount;
  if (fromM.followerCount) data.followerCount = fromM.followerCount;
}

/** 按清晰度优先级从 component urls 里选直链 */
const QUALITY_ORDER = [
  "超清 2K",
  "超清 1080P",
  "高清 1080P",
  "蓝光",
  "高清 720P",
  "标清 480P",
  "标清",
  "流畅",
];

/** 从官方 tv/api/component 响应提取视频信息（带游客凭据）；同时返回 mid 供二次补全元数据 */
function extractFromComponent(json) {
  const data = json?.data?.Component_Play_Playinfo;
  if (!data || !data.urls) return null;
  const entries = Object.entries(data.urls);
  if (!entries.length) return null;
  let picked = entries[0];
  for (const q of QUALITY_ORDER) {
    const hit = entries.find(([label]) => label.includes(q));
    if (hit) {
      picked = hit;
      break;
    }
  }
  const url = normalizeUrl(picked[1]);
  if (!url) return null;
  return {
    title: (data.title || "").trim(),
    cover: normalizeUrl(data.cover_image || ""),
    author: data.author || data.nickname || "",
    avatar: normalizeUrl(data.avatar || ""),
    time: data.real_date ? new Date(Number(data.real_date) * 1000).toISOString() : "",
    url,
    mid: data.mid ? String(data.mid) : "",
    type: "video",
  };
}

export async function weiboParse(url) {
  const id = extractId(url);
  if (!id) return null;

  // 游客凭据（自动获取，无需配置）
  const cookie = await getVisitorCookie();

  // 1) fid（1034:xxx）形态：桌面与手机接口都不认（桌面回 400 参数错误），
  //    只有 component 能做 fid → 真实 mid 的映射；顺带把响应留到第 4 步复用，不重复请求。
  const isFid = /^\d+:\d+$/.test(id);
  let componentJson = null;
  let workId = id;
  if (isFid) {
    componentJson = await fetchComponent(id, cookie);
    const mid = extractFromComponent(componentJson)?.mid;
    if (mid) workId = mid;
  }

  // 2) 主通道：桌面作品接口（视频 1080p / 图集全档位 / IP 属地 / 作者获赞）
  //    + 桌面作者接口（简介 / 关注 / 精确粉丝 / 认证说明 / 微博总数）
  const fromD = extractFromDesktopShow(await fetchDesktopShow(workId, cookie));
  if (fromD) {
    if (!(await attachAuthorProfile(fromD, cookie))) {
      // 作者接口挂了也不能整卡丢失：用手机通道的内嵌 user 回补简介与关注/粉丝
      await fillAuthorFromMobile(fromD, workId, cookie);
    }
    return { code: 200, msg: "解析成功", data: fromD };
  }

  // 3) 降级：m.weibo.cn 单条详情（图集只有 /mw2000/ 档、视频封顶 720p，但字段自洽）
  const fromM = extractFromMWeibo(await fetchMWeibo(workId, cookie, "mweibo-fallback"));
  if (fromM) {
    await attachAuthorProfile(fromM, cookie);
    return { code: 200, msg: "解析成功", data: fromM };
  }

  // 4) 最后降级：component 视频直链。到这一步手机与桌面详情接口都取不到元数据，
  //    原样透出 component 结果（它自带 title/cover/author/avatar/time，但不含 uid，
  //    所以作者卡字段在此路径下无源，按「无源不造数」不写键）。
  const fromC = extractFromComponent(
    componentJson === null ? await fetchComponent(id, cookie) : componentJson
  );
  if (fromC && fromC.url) {
    const data = { ...fromC };
    delete data.mid;
    return { code: 200, msg: "解析成功", data };
  }

  return null;
}
