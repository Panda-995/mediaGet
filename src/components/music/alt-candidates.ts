/**
 * 换源候选的挑选与合并 —— 「同歌其它版本」从哪里来、按什么顺序排。
 *
 * 与 use-player-engine 的分工：本模块只回答"有哪些候选、哪个更可信"，
 * 不涉及 React 状态、不碰 <audio>，因此是纯函数（唯一 IO 是共享缓存的一次读），
 * 可独立阅读与测试；播放引擎只负责拿着结果去逐个尝试。
 *
 * 候选来源按成本从低到高：
 * - list         队列内的近似条目（零请求成本，来源 A）
 * - cache        共享缓存里「历史真实播放成功过」的同曲版本（一次读即得，来源 C）
 * - multi-search 跨源现搜兜底（最贵，来源 B；现搜本身在播放引擎内，此处只接收其结果）
 */
import {
  crossSearchPlayableSourceKeys,
  type SearchItem,
} from "@/lib/client/music-client";
import { cleanMusicText, musicKey } from "@/lib/music-match";
import { readCachedCandidates } from "@/lib/music-remote-cache";

/**
 * 换源候选来源：
 * - list         = 当前播放队列内的近似条目（零额外请求成本）；
 * - cache        = 共享缓存里「历史真实播放成功过」的同曲版本（来源 C，一次读即得）；
 * - multi-search = 跨源现搜兜底（来源 B，成本最高，排在最后）。
 */
export type AltProvenance = "list" | "cache" | "multi-search";

/** 播放失败后的“同歌其他版本”候选 */
export interface AltCandidate {
  item: SearchItem;
  /**
   * true = 高置信可自动尝试；false = 仅歌手/歌名近似（专辑不一致或置信分不足），
   * 只能交人工确认。
   */
  auto: boolean;
  /** 候选来源（A=队列内；B=跨源现搜） */
  provenance: AltProvenance;
  /** multi-search 候选的同曲置信分（0-100）；list 候选无此字段 */
  score?: number;
  /** 专辑都给但不同（现场 / 翻唱 / 其它录制），用于人工面板提示 */
  albumDiff?: boolean;
}

/** 三路候选（队列内 A / 共享缓存 C / 跨源现搜 B）合并：按 (source,id) 去重、自动优先、高分优先 */
export function mergeAltCandidates(
  ...groups: AltCandidate[][]
): AltCandidate[] {
  const map = new Map<string, AltCandidate>();
  const put = (c: AltCandidate) => {
    const k = musicKey(c.item);
    const prev = map.get(k);
    if (
      !prev ||
      (Number(c.auto) > Number(prev.auto)) ||
      (prev.auto === c.auto && (c.score ?? -1) > (prev.score ?? -1))
    ) {
      map.set(k, c);
    }
  };
  groups.forEach((group) => group.forEach(put));
  const out = Array.from(map.values());
  out.sort((a, b) => {
    if (a.auto !== b.auto) return Number(b.auto) - Number(a.auto);
    if ((a.score ?? -1) !== (b.score ?? -1)) return (b.score ?? -1) - (a.score ?? -1);
    return musicKey(a.item).localeCompare(musicKey(b.item));
  });
  return out;
}

/**
 * 从当前播放队列里挑选“与目标同歌”的候选（来源 A）。
 * 判定：清洗后歌名一致 + 歌手交集非空；专辑一致或缺失才算高置信 auto，
 * 专辑不一致的降级为人工候选（可能是现场版 / 不同录音版本）。
 */
export function pickQueueAlternatives(
  list: SearchItem[] | null,
  item: SearchItem
): AltCandidate[] {
  if (!list || list.length === 0) return [];
  const name = cleanMusicText(item.name);
  if (!name) return [];
  const arts = new Set((item.artist || []).map(cleanMusicText).filter(Boolean));
  const album = cleanMusicText(item.album);
  const selfKey = musicKey(item);
  const out: AltCandidate[] = [];
  for (const it of list) {
    if (musicKey(it) === selfKey) continue;
    if (cleanMusicText(it.name) !== name) continue;
    const itArts = (it.artist || []).map(cleanMusicText).filter(Boolean);
    if (![...arts].some((a) => itArts.includes(a))) continue;
    const itAlbum = cleanMusicText(it.album);
    const sameAlbum = !album || !itAlbum || album === itAlbum;
    out.push({ item: it, auto: sameAlbum, provenance: "list" });
  }
  // auto 优先（可能直接续播），人工候选排后
  out.sort((a, b) => Number(b.auto) - Number(a.auto));
  return out;
}

/**
 * 从共享缓存里挑「历史真实播放成功过」的同曲版本（来源 C，层①）。
 *
 * 与来源 A（队列内）的关系：A 依赖「用户这次搜到的列表里恰好有其它源的同曲条目」，
 * C 则是累积事实——某个版本只要被任何人真实播放成功过一次，7 天内就能被复用。
 * 因为只有真实出声才写，命中即高置信，按 auto 处理（可直接自动续播）。
 *
 * 元数据（歌名/歌手/封面）沿用失败曲目：缓存只存 source/id/album，同名同歌手是既定前提；
 * id 同时兜底给 urlId，理由见 music-client.requestPlayDirect 的取值顺序。
 */
export async function pickCachedAlternatives(
  item: SearchItem
): Promise<AltCandidate[]> {
  const rows = await readCachedCandidates(item);
  if (!rows.length) return [];
  // 与来源 B 同一口径：候选源必须「当前既可搜又可播」（平台/内置引擎开关可能已被收敛），
  // 否则会把已停用的源塞进候选——必然失败，还会白写一条黑名单
  const allowed = new Set(crossSearchPlayableSourceKeys(item.source || ""));
  const selfKey = musicKey(item);
  const out: AltCandidate[] = [];
  for (const row of rows) {
    if (!allowed.has(row.source)) continue;
    if (musicKey({ source: row.source, id: row.id }) === selfKey) continue;
    out.push({
      item: {
        ...item,
        source: row.source,
        id: row.id,
        urlId: row.id,
        album: row.album || item.album,
      },
      auto: true,
      provenance: "cache",
    });
  }
  return out;
}

/** 判断 <audio> 当前播放源与已生效直链是否为同一资源（宽容比较：忽略 hash 与结尾斜杠差异） */
export function isSameMediaSrc(current: string, directUrl: string): boolean {
  if (!current || !directUrl) return false;
  const trim = (s: string) => s.split("#")[0].replace(/\/+$/, "");
  const a = trim(current);
  const b = trim(directUrl);
  return a === b || a.endsWith(b) || b.endsWith(a);
}
