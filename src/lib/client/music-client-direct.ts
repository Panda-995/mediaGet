/**
 * 音乐客户端请求层 —— 直链通道（取试听直链 + 下载入口决策）
 *
 * requestDirect / requestPlayDirect 是播放取链的两个入口：
 * - GD 引擎源：走内置取链通道（同源代理优先 + 浏览器直连降级）；
 * - self 源（kugou / migu）：kugou 走自研官方试听直链，migu 无内置直链（NO_ENGINE_MSG）；
 * - 内置播放引擎总开关关闭（music-caps 的 builtinPlay）：直接抛 BUILTIN_PLAY_OFF_MSG。
 *
 * trackDownloadSpec 把「当前曲目 + 已解析直链 + 档位」到下载方式的分支收敛在这里，
 * 供 UI 统一决策（同源 bin 字节下载 vs 外部直链另存）。
 */
import { isBuiltinPlayOn } from "@/lib/music-caps";
import {
  BUILTIN_PLAY_OFF_MSG,
  DOWN_MSG,
  MusicError,
  NO_ENGINE_MSG,
  NOT_FOUND_MSG,
  SELF_ONLY_ENGINE_KEYS,
  directAfterDown,
  directJson,
  isDirectUsed,
  proxyGet,
  sourceEngineKindFor,
  type DirectData,
  type SearchItem,
} from "./music-client-core";

/** 上游直连取直链（代理不可用时的兜底路径） */
async function directTrack(
  source: string,
  id: string,
  br: string,
  signal?: AbortSignal
): Promise<DirectData> {
  const params = new URLSearchParams({
    types: "url",
    source,
    id,
    br,
  });
  const json = await directJson(params, signal);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MusicError("down", DOWN_MSG);
  }
  const rec = json as Record<string, unknown>;
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!url.startsWith("http")) throw new MusicError("biz", NOT_FOUND_MSG);
  return {
    url,
    br: Number(rec.br) || 0,
    size: Number(rec.size) || 0,
    source,
    id,
  };
}

/** 自研直连源取直链：/api/music/self?action=url（kugou 官方试听直链；无浏览器直连兜底） */
async function requestSelfPlayDirect(
  source: string,
  id: string,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  const qs = new URLSearchParams({ action: "url", source, id, br });
  const payload = await proxyGet(qs, signal, "/api/music/self");
  const data = payload.data as DirectData | undefined;
  if (!data?.url) throw new MusicError("biz", NOT_FOUND_MSG);
  return data;
}

/** 取指定 source+id 在 br 档位下的试听直链 */
export async function requestDirect(
  source: string,
  id: string,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  // 内置播放引擎总开关关闭：内置取链通道（GD 公共上游 / 自研直连 / 浏览器直连降级）
  // 一律不再取链（与 /api/music、/api/music/self 的服务端拦截对齐），此处为防御性拦截。
  if (!isBuiltinPlayOn()) {
    throw new MusicError("biz", BUILTIN_PLAY_OFF_MSG);
  }
  // self 源：migu（SELF_ONLY）无内置直链明确提示；kugou 有官方直链走自研端点
  //（避免 migu 打到 GD 后误报“未找到链接”）
  if (sourceEngineKindFor(source) === "self") {
    if (SELF_ONLY_ENGINE_KEYS.has(source)) {
      throw new MusicError("biz", NO_ENGINE_MSG);
    }
    return requestSelfPlayDirect(source, id, br, signal);
  }
  const qs = new URLSearchParams({ source, id, br });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const data = payload.data as DirectData | undefined;
      if (!data?.url) throw new MusicError("biz", NOT_FOUND_MSG);
      return data;
    },
    () => directTrack(source, id, br, signal),
    signal
  );
}

/**
 * 播放取直链入口（点歌 / 切音质）。
 *
 * - GD 引擎源：走内置取链通道（代理优先 + 直连降级）；
 * - self 源（kugou / migu）：kugou 走内置官方直链；migu（无内置直链）保持 NO_ENGINE 提示；
 * - 内置播放引擎总开关关闭（music-caps 的 builtinPlay）：抛 BUILTIN_PLAY_OFF_MSG
 *   （搜索维度不受影响）。
 */
export async function requestPlayDirect(
  source: string,
  item: Pick<SearchItem, "id" | "urlId" | "lyricId" | "name" | "artist">,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  if (!isBuiltinPlayOn()) {
    throw new MusicError("biz", BUILTIN_PLAY_OFF_MSG);
  }
  if (sourceEngineKindFor(source) === "self" && SELF_ONLY_ENGINE_KEYS.has(source)) {
    // migu 无内置直链
    throw new MusicError("biz", NO_ENGINE_MSG);
  }
  return requestDirect(source, item.urlId || item.id, br, signal);
}

/**
 * 下载入口的通道内决策结果：
 * - kind=bin：经同源 /api/music 字节代理下载（带音质标签文件名），下载按钮配 download 属性；
 * - kind=external：浏览器直接访问真实源地址，新标签打开后另存；
 *   若因「同源代理对上游不可用」退回直连模式（fallbackDirect=true），提示文案需说明这是直连。
 */
export interface TrackDownloadSpec {
  kind: "bin" | "external";
  url: string;
  fallbackDirect?: boolean;
}

/** 由「当前曲目 + 已解析直链 + 档位」决策下载入口，收敛原散落在展示层的三分支 */
export function trackDownloadSpec(opts: {
  item?: SearchItem | null;
  source: string;
  direct: DirectData;
  br: string;
}): TrackDownloadSpec {
  const { item, source, direct, br } = opts;
  const channel = sourceEngineKindFor(item?.source || source);
  // GD 源 + 同源代理可用 → 同源 bin 字节下载（服务端带 attachment 与原文件名）
  if (channel === "gd" && !isDirectUsed()) {
    const qs = new URLSearchParams({
      source: item?.source || source,
      id: item?.urlId || item?.id || direct.id,
      br,
      bin: "1",
      title: item?.name || "",
      // 艺术家随下载请求下发，服务端拼进文件名「曲名 - 艺术家 - 音质标签.ext」
      artist: (item?.artist || []).filter(Boolean).join(", "),
    });
    return { kind: "bin", url: `/api/music?${qs.toString()}` };
  }
  // 其余（GD 直连模式 / self 源）：真实源地址即为可下载文件，新标签打开后另存
  return {
    kind: "external",
    url: direct.url,
    fallbackDirect: channel === "gd" && isDirectUsed(),
  };
}

/** 下载失败：message 是可直接展示给用户的文案（来自服务端 msg 或本地兜底） */
export class MusicDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicDownloadError";
  }
}

/** 响应 Content-Type 可否作为音频落盘（与服务端 url.js isBinMediaType 同口径） */
function isMediaContentType(contentType: string): boolean {
  const t = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!t) return true; // 上游未声明时按音频放行
  return (
    t.startsWith("audio/") || t.startsWith("video/") || t.includes("octet-stream")
  );
}

/** 从 Content-Disposition 取文件名：RFC 5987 filename* 优先，其次 filename="..." */
export function fileNameFromDisposition(
  header: string | null,
  fallback: string
): string {
  const raw = header || "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(raw);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // 编码异常（非标准转义）时继续试普通 filename
    }
  }
  const plain =
    /filename\s*=\s*"([^"]+)"/i.exec(raw) || /filename\s*=\s*([^;]+)/i.exec(raw);
  return plain?.[1]?.trim() || fallback;
}

/** 触发浏览器保存：临时 <a> + objectURL（与 utils/downloadImages 同款） */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 经同源 bin 字节代理下载音频，返回落盘文件名。
 *
 * **为什么不直接用 `<a download href={binUrl}>`**：那样浏览器会把服务端的
 * **错误响应也照存成文件**。上游偶发失败（防盗链 403 / 直链过期 / 风控 JSON）时
 * 用户点「下载」会得到一个内容是 JSON 的 `.json` 文件，全程没有任何失败提示——
 * 这正是「点了下载结果下来一个 JSON」的来源。这里先取回响应、确认状态与内容
 * 类型是音频后再落盘；失败抛 MusicDownloadError，由 UI 弹提示而不是静默存坏文件。
 *
 * 代价是整首先进内存（10~50MB，音频量级可接受），换来失败可感知。
 */
export async function downloadBinTrack(opts: {
  url: string;
  fallbackName?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { url, fallbackName = "track.mp3", signal } = opts;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new MusicDownloadError("下载请求失败，请检查网络后重试");
  }

  if (!res.ok) {
    let msg = "";
    try {
      const body = (await res.json()) as { msg?: unknown };
      if (typeof body?.msg === "string") msg = body.msg;
    } catch {
      // 非 JSON 错误体：用状态码兜底
    }
    throw new MusicDownloadError(
      msg || `下载失败（HTTP ${res.status}），请稍后重试`
    );
  }

  const contentType = res.headers.get("content-type") || "";
  if (!isMediaContentType(contentType)) {
    throw new MusicDownloadError(
      "源站返回了非音频内容（链接可能已过期），请稍后重试"
    );
  }

  const blob = await res.blob();
  if (!blob.size) {
    throw new MusicDownloadError("源站返回了空文件，请稍后重试");
  }
  const name = fileNameFromDisposition(
    res.headers.get("content-disposition"),
    fallbackName
  );
  saveBlob(blob, name);
  return name;
}
