/**
 * 音乐平台品牌元信息「单一数据源」：展示名 / 强调色 / `public/logos` 下的品牌 SVG。
 *
 * 汇总来源（避免多处重复维护）：
 * - 内置 GD 聚合源与自研直连搜索源：`@/types/music` 的 SEARCH_SOURCES / SELF_SEARCH_SOURCES；
 * - 链接解析专属平台（如 tencent）：`source-meta` 的 RESOLVE_EXTRA_META。
 *
 * 消费方：
 * - `platform-icons/index.tsx`（页面内联图标，`<img>` 直接引用 SVG）；
 * - `use-media-session.ts`（系统媒体控件封面 —— 系统控件不渲染 SVG，需据此栅格化/回退色块）。
 */
import { SEARCH_SOURCES, SELF_SEARCH_SOURCES } from "@/types/music";
import { RESOLVE_EXTRA_META } from "./source-meta";

/**
 * `public/logos` 下的品牌 logo：文件名 = 平台 key，如 netease.svg。
 * 把完整品牌 SVG 直接存入 `public/logos/` 即可被引用（viewBox 任意，现有文件统一 1024×1024）；
 * 未列出的平台（无品牌 SVG）由展示层回退「品牌色 + 名称首字」色块。
 * 内置 6 源（netease / tencent / kugou / kuwo / migu / joox）均已登记品牌 SVG。
 */
export const PLATFORM_LOGOS: Partial<Record<string, string>> = {
  netease: "/logos/netease.svg",
  kuwo: "/logos/kuwo.svg",
  joox: "/logos/joox.svg",
  kugou: "/logos/kugou.svg",
  migu: "/logos/migu.svg",
  // GD 直链通道对 QQ音乐的 source key 为 tencent；品牌 logo 复用平台解析用的 qqmusic.svg
  tencent: "/logos/qqmusic.svg",
};

/**
 * 「聚合搜索」模式图标（多路音源汇聚成一份合并结果）。
 *
 * 它是搜索**模式**的图示而非音源平台，所以刻意不登记进上面的 PLATFORM_LOGOS：
 * - `platformBrandFor()` 只解析真实 source key，塞进去会得到一个并不存在的「聚合平台」；
 * - 系统媒体控件回退封面（use-media-session）按平台品牌色栅格化，也不该被它污染。
 * 需要它的地方（SearchPanel 的平台 chip 行首伪 chip）直接引用本常量。
 */
export const AGGREGATE_LOGO = "/logos/aggregate.svg";

/** 平台品牌元信息 */
export interface PlatformBrand {
  /** 平台展示名（如「网易云音乐」） */
  label: string;
  /** 品牌强调色（hex）；未收录平台给中性色 */
  color: string;
  /** `public/logos` 下的品牌 SVG 路径；缺失表示该平台无品牌 logo */
  logo?: string;
}

/** 未收录平台的中性兜底色 */
const NEUTRAL_COLOR = "#64748b";

const BRAND_BY_SOURCE: Record<string, PlatformBrand> = (() => {
  const map: Record<string, PlatformBrand> = {};
  for (const s of [...SEARCH_SOURCES, ...SELF_SEARCH_SOURCES]) {
    map[s.key] = { label: s.label, color: s.color };
  }
  for (const [key, meta] of Object.entries(RESOLVE_EXTRA_META)) {
    map[key] = { label: meta.label, color: meta.color };
  }
  for (const [key, logo] of Object.entries(PLATFORM_LOGOS)) {
    if (!logo) continue;
    const prev = map[key];
    map[key] = prev
      ? { ...prev, logo }
      : { label: key, color: NEUTRAL_COLOR, logo };
  }
  return map;
})();

/** 解析 source key → 平台品牌元信息；未收录平台退回 source 键 + 中性色（无 logo） */
export function platformBrandFor(source: string): PlatformBrand {
  return (
    BRAND_BY_SOURCE[source] ?? {
      label: source || "未知平台",
      color: NEUTRAL_COLOR,
    }
  );
}
