/**
 * 站内图片代理串与裸直链的互转（web 出口层）。
 *
 * 出口改写在内核出口统一做（`lib/image-proxy.js`），浏览器拿到的 `cover` / `avatar` /
 * `images[]` 已经是 `/api/image?url=…` 相对串，裸直链不外泄给前端。因此代理加载失败时
 * 想回退直链，判据只能是代理串自己带的 `url` 参数——不改契约、不额外下发原始字段。
 *
 * 回退有真实收益：代理慢在「服务端跨境回源」，而用户浏览器往往就在图床的境内边缘节点
 * 旁边，直连比代理快得多（抖音 / 字节系图床实测不校验 Referer，浏览器直连可成）。
 */

/** 站内图片代理路径，与 `src/app/api/image/route.js` 对应 */
const PROXY_PATH = "/api/image";

/** 是否为裸远端地址（与出口改写同一判据） */
function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** 裸直链包成代理串；已是代理串 / 非 http(s) 原样返回（幂等） */
export function proxiedImageUrl(src: string): string {
  if (!isRemoteUrl(src)) return src;
  return `${PROXY_PATH}?url=${encodeURIComponent(src)}`;
}

/**
 * 从代理串还原裸直链。
 * 非代理串原样返回；`url` 参数缺失或不是 http(s)（如被手改成站内路径）也原样返回，
 * 避免把回退目标变成第二次代理或站内跳转。
 */
export function directImageUrl(src: string): string {
  if (!src?.startsWith(`${PROXY_PATH}?`)) return src;
  let raw: string | null = null;
  try {
    raw = new URL(src, "http://image-proxy.invalid").searchParams.get("url");
  } catch {
    return src;
  }
  return raw && isRemoteUrl(raw) ? raw : src;
}

/**
 * 按优先级返回可尝试的图片地址：代理在前、直链兜底在后。
 * 两种入参形态都收——出口改写过的代理串，以及尚未改写的裸直链（YouTube 卡片自带
 * 的图床地址就是后者）；无可回退项时只有一项。
 */
export function imageUrlCandidates(src: string): string[] {
  if (!src) return [];
  if (isRemoteUrl(src)) return [proxiedImageUrl(src), src];
  const direct = directImageUrl(src);
  return direct === src ? [src] : [src, direct];
}
