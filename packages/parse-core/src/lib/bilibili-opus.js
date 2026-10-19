/**
 * B 站动态（/opus/<id>）detail 响应分类与归一 —— 纯函数，不发起网络请求，
 * 供 route.js 调用与单元测试直接 import。
 *
 * 输入：x/polymer/web-dynamic/v1/detail 的 JSON（code 应为 0）
 * 输出：
 *   - 图文动态（DRAW / OPUS / WORD 且 pics 非空）
 *     → { ok: true, data: { type:"image", title, desc, cover, images, author,
 *        authorId, authorUrl, avatar, time, stat } }
 *   - 纯文字动态（DRAW / OPUS / WORD 且无图，含 DYNAMIC_TYPE_WORD）
 *     → { ok: true, data: { type:"text", title, desc, author, authorId,
 *        authorUrl, avatar, time, stat } }（desc 即正文）
 *   - 其余 → { ok: false, msg }
 *
 * 实测结构：detail.data.item = {
 *   type: "DYNAMIC_TYPE_DRAW" | "DYNAMIC_TYPE_OPUS" | "DYNAMIC_TYPE_WORD" | ...,
 *   modules: {
 *     module_author: { mid, name, face, pub_ts },
 *     module_dynamic: {
 *       desc: { text },                          // 无 features 形态的正文
 *       major: { opus: { title, pics: [{ url }], summary: { text } } },
 *     },
 *     module_stat: { like: {count}, comment: {count}, forward: {count} },
 *   },
 * }
 * 收藏数不在 detail 响应里（实测各 features 组合均无 favorite 键），
 * 需另取 opus 页面同源接口 x/polymer/web-dynamic/v1/opus/detail：
 *   data.item.modules = [{ module_type:"MODULE_TYPE_STAT",
 *                          module_stat:{ favorite:{count} } }, ...]（数组形态）
 * 由 extractOpusFavorite 单独提取，失败时保持缺失、不造数。
 * 纯文字实测（vivo 号 WORD 动态，features=itemOpusStyle）：desc 为 null，
 * 正文在 major.opus.summary.text，pics 为空数组。
 * 边界：ARTICLE（专栏文章）pics 只是封面入口图，正文图需走已风控的专栏接口，明确拒绝。
 */

/** http → https：hdslb 图床图片 http 直链在 https 页面会被混合内容拦截破图 */
function toHttps(url) {
  if (typeof url !== "string") return "";
  return url.replace(/^http:\/\//i, "https://");
}

/** 空串 / "-" / 纯空白视为无文案（与视频 desc 归一行为一致） */
function cleanText(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  if (!t || t === "-") return "";
  return text;
}

/** 统计计数：仅保留正数，缺失/异常返回 undefined（前端该行自动隐藏） */
function positiveCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 从 opus/detail 响应提取收藏数。该接口的 modules 是数组（每项带 module_type），
 * 收藏数位于 MODULE_TYPE_STAT 项的 module_stat.favorite.count。
 * 缺失 / 结构不符 / 非正数时返回 undefined，由调用方保持字段缺失。
 */
export function extractOpusFavorite(payload) {
  const modules = payload?.data?.item?.modules;
  if (!Array.isArray(modules)) return undefined;
  const statModule = modules.find((m) => m?.module_stat);
  const favorite = statModule?.module_stat?.favorite;
  const count =
    favorite && typeof favorite === "object" ? favorite.count : favorite;
  return positiveCount(count);
}

export function classifyOpusDetail(detail) {
  const item = detail?.data?.item;
  if (!item) return { ok: false, msg: "解析失败！" };

  const type = item.type || "";
  const modules = item.modules || {};
  const dynamic = modules.module_dynamic || {};
  const opus = dynamic.major?.opus || {};
  const pics = (Array.isArray(opus.pics) ? opus.pics : [])
    .map((pic) => toHttps(pic?.url))
    .filter(Boolean);

  // 专栏文章封面图只是入口图，正文需另走已风控接口，保持拒绝
  if (type === "DYNAMIC_TYPE_ARTICLE") {
    return {
      ok: false,
      msg: "该动态是B站专栏文章，非图文动态，暂不支持解析正文图片",
    };
  }
  // 白名单之外的类型一律拒绝（视频/转发/直播/音乐等）
  if (!/^(DYNAMIC_TYPE_DRAW|DYNAMIC_TYPE_OPUS|DYNAMIC_TYPE_WORD)$/.test(type)) {
    return { ok: false, msg: "该动态不是图文或文字内容，暂不支持解析" };
  }

  const author = modules.module_author || {};
  const stat = modules.module_stat || {};
  const mid = author.mid;
  const pubTs = Number(author.pub_ts);
  const time = Number.isFinite(pubTs) && pubTs > 0 ? pubTs : undefined;
  const base = {
    title: opus.title || undefined,
    author: author.name || undefined,
    authorId: mid != null ? String(mid) : undefined,
    authorUrl: mid != null ? `https://space.bilibili.com/${mid}` : undefined,
    avatar: toHttps(author.face),
    time,
    stat: {
      like: positiveCount(stat.like?.count),
      reply: positiveCount(stat.comment?.count),
      favorite: positiveCount(stat.favorite?.count),
      share: positiveCount(stat.forward?.count),
    },
  };

  if (pics.length > 0) {
    return {
      ok: true,
      data: {
        type: "image",
        ...base,
        desc: cleanText(opus.summary?.text) || undefined,
        cover: pics[0],
        images: pics,
      },
    };
  }

  // 无图：纯文字动态（WORD，或 DRAW/OPUS 发成纯文字）。正文优先取
  // itemOpusStyle 的 opus.summary.text，旧/无 features 形态回退 desc.text。
  const text = cleanText(opus.summary?.text) || cleanText(dynamic.desc?.text);
  if (!text) {
    return { ok: false, msg: "该动态不包含可解析的文字或图片内容" };
  }
  return {
    ok: true,
    data: {
      type: "text",
      ...base,
      desc: text,
    },
  };
}
