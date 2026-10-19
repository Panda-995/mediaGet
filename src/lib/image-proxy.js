/**
 * 图片字段的站内代理改写（web 出口层，服务端）。
 *
 * 分工：parse-core 内核只出**媒体直链**（与站点无关，桌面端按直链消费），
 * 「要不要包成站内代理」属宿主的出参形态，全部落在本层。平台专用路由与统一入口
 * 都经 `createApiHandler`（ID 直查分支同），因此不再各平台各抄一份改写。
 * 包代理买到的是同源化（浏览器不直连图床，不带外部 Referer、不暴露访问者 IP）
 * 加多 CDN 备选重试：备选地址经 `&fallback=` 传下去，`/api/image` 服务端再按图床
 * 域名补 Referer 后按序回源。
 *
 * 这不是万能钥匙：小红书/微博图床确实按 Referer 拦 403，快手则实测与 Referer 无关
 * （2026-10-18 四种 Referer + 浏览器全套请求头直连 `a.yximgs.com`/`a.kwimgs.com` 一律
 * 400，其媒体边缘整体回源故障时，代理与裸直链一起失败，代理只把故障透成 502）。
 *
 * 边界：只改写图片，视频直链不代理（避免拖慢播放）；`*Fallbacks` 是内核给代理用的内部键，
 * 改写后删除，不外泄给下游。
 */

/** 代理串主体 + 多 CDN 备选：站内相对地址，浏览器发的是同源请求 */
function buildProxy(url, fallbacks) {
  let proxy = `/api/image?url=${encodeURIComponent(url)}`;
  if (fallbacks.length) {
    proxy += `&fallback=${fallbacks.map(encodeURIComponent).join(",")}`;
  }
  return proxy;
}

/**
 * 只包远端 http(s) 直链。站内相对路径（含已包过的代理串）原样返回
 * —— 这是本模块唯一的幂等判据，重复调用不套两层。
 */
function isRemoteUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * 按扩展名判图片再包：用于「既可能是视频、又可能是图片」的字段。
 * 图文帖的 `data.url` 是图集第一张（微博），视频帖的 `data.url` 是 mp4，只能看值本身。
 */
export function proxifyImage(url, fallbacks = []) {
  if (!isRemoteUrl(url)) return url;
  if (!/\.(?:jpg|jpeg|png|webp|gif|bmp|heic|heif)(?:[?#]|$)/i.test(url)) {
    return url;
  }
  return buildProxy(url, fallbacks);
}

/**
 * 已声明为图片的字段一律当图片包，不看扩展名。
 * 小红书 / B站的图片地址常没有扩展名（`…!nd_dft_wlteh_webp`、`/bfs/new_dyn/pic1`），
 * 靠扩展名判据会漏包，浏览器直连就是 403 破图 —— 这些键上字段名才是判据。
 */
function asImage(url, fallbacks = []) {
  if (!isRemoteUrl(url)) return url;
  return buildProxy(url, fallbacks);
}

/** 声明为图片的标量字段：统一契约键 + normalizeResult 复制它们用的原始别名键 */
const IMAGE_FIELDS = [
  "cover",
  "coverUrl",
  "imgurl",
  "poster",
  "videoCover",
  "thumbnail",
  "avatar",
  "authorAvatar",
  "headUrl",
  "user_img",
];

/** 声明为图片数组的字段（图集） */
const IMAGE_ARRAY_FIELDS = ["images"];

/** 分P / 多视频条目里的图片字段（同条目的 url 是视频直链，不在改写面内） */
const VIDEO_ITEM_IMAGE_FIELDS = ["cover", "pic"];

/** 内核透出的多 CDN 备选内部键：折叠进 `&fallback=` 后删除，不外泄给下游 */
const FALLBACK_KEYS = ["coverUrlFallbacks", "authorAvatarFallbacks"];
const FALLBACK_SOURCE = {
  cover: "coverUrlFallbacks",
  coverUrl: "coverUrlFallbacks",
  avatar: "authorAvatarFallbacks",
  authorAvatar: "authorAvatarFallbacks",
};

/**
 * 结果体的图片字段就地改写。统一契约键（`cover` / `avatar`）与 normalizeResult
 * 复制它们的原始别名键（`coverUrl` / `authorAvatar`…）一起改写，两个形态同源；
 * 备选数组在收尾统一删除，所以派生键与来源键拿到的是同一份 `&fallback=`。
 */
export function proxifyResultData(data) {
  if (!data || typeof data !== "object") return data;
  const fallbacksOf = (key) => {
    const src = FALLBACK_SOURCE[key];
    return src && Array.isArray(data[src]) ? data[src] : [];
  };

  for (const key of IMAGE_FIELDS) {
    if (typeof data[key] === "string") {
      data[key] = asImage(data[key], fallbacksOf(key));
    }
  }
  for (const key of IMAGE_ARRAY_FIELDS) {
    if (Array.isArray(data[key])) {
      data[key] = data[key].map((u) => asImage(u, fallbacksOf(key)));
    }
  }
  if (Array.isArray(data.videos)) {
    for (const item of data.videos) {
      if (!item || typeof item !== "object") continue;
      for (const key of VIDEO_ITEM_IMAGE_FIELDS) {
        if (typeof item[key] === "string") item[key] = asImage(item[key]);
      }
    }
  }
  // 主直链按值判：图文帖包，视频帖不包
  if (typeof data.url === "string") data.url = proxifyImage(data.url);

  for (const key of FALLBACK_KEYS) delete data[key];
  return data;
}

/** 整条响应的图片改写（`createApiHandler` 与 ID 直查分支共用）；非成功结果原样返回 */
export function proxifyResult(result) {
  if (
    result &&
    result.code === 200 &&
    result.data &&
    typeof result.data === "object"
  ) {
    proxifyResultData(result.data);
  }
  return result;
}
