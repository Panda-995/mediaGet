/**
 * 最近搜索关键词本地缓存（localStorage 单份 JSON，key `mp-search-history`）：
 * 记住用户最近搜过什么，点一下回填重搜，省去重复输入。
 *
 * 边界：
 * - **只留本机**：搜索历史是纯个人行为明细，音乐页又是匿名公开页，这类数据不进 Turso
 *   （见 musicEngine.md §7.5），与服务端 `music_cache`（全站共享的「哪些版本能播」）分工明确；
 * - **只存关键词，不存渠道**：点历史词时按当前渠道重搜，行为可预期——「上次用哪个源」另有
 *   `mp-search-channel` 专门记（见 MusicExplorer.tsx）；
 * - 读路径同步且可失败：结构损坏 / 版本不符 / 存储不可用一律当「没有历史」，绝不阻断搜索。
 */
export const SEARCH_HISTORY_KEY = "mp-search-history";
/** 结构版本：无版本号或版本不符的旧记录一律忽略，避免结构演进时读出脏数据 */
const SEARCH_HISTORY_VERSION = 1;
/** 历史上限：只留最近 N 条，超出丢最旧。再多用户也不会翻，留着只增噪音 */
export const SEARCH_HISTORY_LIMIT = 8;

/** 去重比较：首尾空白与大小写不同的同一关键词视为同一条 */
function sameKw(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 清洗历史列表：剔除非字符串 / 空白项，按出现顺序去重，并截断到上限 */
function sanitize(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== "string") continue;
    const kw = it.trim();
    if (!kw || out.some((k) => sameKw(k, kw))) continue;
    out.push(kw);
    if (out.length >= SEARCH_HISTORY_LIMIT) break;
  }
  return out;
}

/** 写盘（失败静默：隐私模式 / 配额问题都不影响本次搜索，只是下次记不住） */
function write(items: string[]): void {
  try {
    localStorage.setItem(
      SEARCH_HISTORY_KEY,
      JSON.stringify({ v: SEARCH_HISTORY_VERSION, items })
    );
  } catch {
    /* 忽略 */
  }
}

/** 读取历史（最新在前）；无记录 / 结构不合法 / 存储不可用一律返回空数组 */
export function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const d = JSON.parse(raw) as { v?: number; items?: unknown };
    if (!d || typeof d !== "object" || d.v !== SEARCH_HISTORY_VERSION) return [];
    return sanitize(d.items);
  } catch {
    return [];
  }
}

/**
 * 记录一次搜索：已在历史里的关键词提到最前（不产生重复项），返回更新后的完整历史。
 * 空白关键词不入历史。存储不可用（隐私模式 / 配额）时不保留内存副本——与
 * `playlist-cache.ts` 同口径：历史只是输入便利，读不到就当没有，不影响搜索本身。
 */
export function pushSearchHistory(kw: string): string[] {
  const k = (kw || "").trim();
  const prev = readSearchHistory();
  if (!k) return prev;
  const next = sanitize([k, ...prev]);
  write(next);
  return next;
}

/** 删除单条历史，返回更新后的完整历史 */
export function removeSearchHistory(kw: string): string[] {
  const next = readSearchHistory().filter((k) => !sameKw(k, kw));
  write(next);
  return next;
}

/** 清空全部历史（用户显式点「清空」时调用） */
export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}
