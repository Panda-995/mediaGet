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
