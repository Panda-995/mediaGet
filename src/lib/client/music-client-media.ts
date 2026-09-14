/**
 * 音乐客户端请求层 —— 封面与歌词通道
 *
 * 三个互相独立的内容通道，都遵循同一套降级策略（代理优先 → 浏览器直连兜底）：
 * - 封面：requestPic（directAfterDown 编排）；coverBinUrl 供封面取色走同源 bin 字节；
 * - 歌词：requestLyric（上游可能直接返回 LRC 纯文本，也可能是 JSON 包裹）；
 * - AMLL 逐字歌词：requestAmllLyric，属「锦上添花」通道——未收录 / 上游异常一律返回
 *   null，不抛错打扰主歌词流。
 *
 * self 引擎源（kugou / migu）没有 GD 的 pic / lyric 通道，直接给出明确文案，
 * 避免打到 GD 后误报“未找到”。
 */
import {
  DOWN_MSG,
  MusicError,
  NO_COVER_MSG,
  directAfterDown,
  directGet,
  directJson,
  isChallengeBody,
  isDirectUsed,
  proxyGet,
  sourceEngineKindFor,
  type LyricData,
  type PicData,
} from "./music-client-core";

/** 上游直连取封面（代理不可用时的兜底路径） */
async function directPic(
  source: string,
  picId: string,
  signal?: AbortSignal
): Promise<string> {
  const params = new URLSearchParams({
    types: "pic",
    source,
    id: picId,
    size: "300",
  });
  const json = await directJson(params, signal);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new MusicError("down", DOWN_MSG);
  }
  const rec = json as Record<string, unknown>;
  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) throw new MusicError("biz", NO_COVER_MSG);
  // 与 gdmusic.js parsePicResponse 一致：统一升级为 https，避免页面 mixed-content
  return url.replace(/^http:\/\//i, "https://");
}

/** 取专辑封面真实图片 URL */
export async function requestPic(
  source: string,
  picId: string,
  signal: AbortSignal
): Promise<string> {
  // self 源（kugou/migu）：无 GD 封面通道，且自研搜索结果一般不带可二次换取封面
  if (sourceEngineKindFor(source) === "self") {
    throw new MusicError("biz", NO_COVER_MSG);
  }
  const qs = new URLSearchParams({ action: "pic", source, id: picId, size: "300" });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const data = payload.data as PicData | undefined;
      if (!data?.url) throw new MusicError("biz", NO_COVER_MSG);
      return data.url;
    },
    () => directPic(source, picId, signal),
    signal
  );
}

/**
 * 封面取色用的同源 bin 字节 URL；仅 GD 源且同源代理可用时返回非空。
 * self 源与直连模式下返回空串，调用方据此回退“仅外部直链取色”。
 */
export function coverBinUrl(source: string, picId: string): string {
  if (!picId || sourceEngineKindFor(source) !== "gd" || isDirectUsed()) return "";
  return (
    `/api/music?action=pic&source=${encodeURIComponent(source)}` +
    `&id=${encodeURIComponent(picId)}&size=300&bin=1`
  );
}

/** 上游直连取歌词（响应可能是 JSON 包裹，也可能是 LRC 纯文本，还可能是 CF 校验页） */
async function directLyric(
  source: string,
  id: string,
  signal?: AbortSignal
): Promise<string> {
  const params = new URLSearchParams({ types: "lyric", source, id });
  const res = await directGet(params, signal);
  const text = await res.text();
  if (isChallengeBody(text)) throw new MusicError("down", DOWN_MSG);
  let lyric = "";
  if (text) {
    try {
      const json = JSON.parse(text);
      if (typeof json.lyric === "string") lyric = json.lyric;
      else if (typeof json.lrc === "string") lyric = json.lrc;
      else if (typeof json === "string") lyric = json;
    } catch {
      // 上游可能直接返回 LRC 纯文本
      lyric = text;
    }
  }
  return lyric.trim();
}

/** 取歌词文本（LRC 格式） */
export async function requestLyric(
  source: string,
  lyricId: string,
  signal: AbortSignal
): Promise<string> {
  // self 源（kugou/migu）：无歌词通道，明确提示
  if (sourceEngineKindFor(source) === "self") {
    throw new MusicError("biz", "歌词获取失败（该音源暂未接入歌词通道）");
  }
  const qs = new URLSearchParams({ action: "lyric", source, id: lyricId });
  return directAfterDown(
    async () => {
      const payload = await proxyGet(qs, signal);
      const data = payload.data as LyricData | undefined;
      if (!data || typeof data.lyric !== "string") {
        throw new MusicError("biz", "歌词获取失败");
      }
      return data.lyric.trim();
    },
    () => directLyric(source, lyricId, signal),
    signal
  );
}

/** AMLL 词库可按平台 ID 精确匹配逐字歌词的源（源名沿用 GD 通道命名） */
const AMLL_ID_SOURCES = new Set(["netease", "tencent"]);

/** 该源是否能用平台 ID 精确查词库（其余源只能模糊搜，暂不接入） */
export function sourceSupportsAmllLyric(source: string): boolean {
  return AMLL_ID_SOURCES.has(source);
}

/**
 * 从 AMLL 词库（/api/music/amll）拉 TTML 逐字歌词原文。
 * 属于「锦上添花」通道：未收录 / 上游异常一律返回 null，不抛错打扰主歌词流。
 */
export async function requestAmllLyric(
  source: string,
  id: string,
  signal: AbortSignal
): Promise<string | null> {
  if (!sourceSupportsAmllLyric(source) || !id) return null;
  try {
    const qs = new URLSearchParams({ source, id });
    const res = await fetch(`/api/music/amll?${qs.toString()}`, { signal });
    if (!res.ok) return null;
    const payload = (await res.json()) as
      | { code?: number; data?: { lyric?: unknown } }
      | null;
    const lyric = payload?.data?.lyric;
    return typeof lyric === "string" && lyric.trim() ? lyric : null;
  } catch {
    return null;
  }
}
