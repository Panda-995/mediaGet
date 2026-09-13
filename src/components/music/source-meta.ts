import { SEARCH_SOURCES, SELF_SEARCH_SOURCES, type SearchSourceKey } from "./types";

/** 搜索源 chip 的统一展示形态：内置 GD 源 + 内置自研直连搜索源 */
export interface SearchChip {
  key: SearchSourceKey;
  label: string;
  color: string;
  /** 是否为内置自研直连搜索源（站点服务端直连音源搜索接口，不经 GD）；chip 图标按品牌 SVG 渲染 */
  self?: boolean;
}

/**
 * 引擎注册表视图：由「内置 GD 源 + 内置自研直连搜索源」合并出可选搜索源 chips。
 * 新增搜索引擎的接入点：向 SEARCH_SOURCES（GD 聚合源）/ SELF_SEARCH_SOURCES（自研直连
 * 搜索，不经 GD）注册；调用方（MusicExplorer / SearchPanel / 各列表面板）无需感知源
 * 属于哪个通道引擎。
 */
export function buildSearchChips(): SearchChip[] {
  return [
    ...SEARCH_SOURCES.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    ...SELF_SEARCH_SOURCES.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      self: true,
    })),
  ];
}

/**
 * 「链接解析」产物平台的展示元信息（source 键按 GD 直链通道命名）。kugou / migu 亦以内置
 * 自研直连搜索源 chip 出现（sourceMetaFor 优先命中 chip）；tencent 搜索引擎默认放开（部署侧
 * MUSIC_PLATFORM_SEARCH_DISABLED 可停用），链接解析 / 历史缓存也可能携带 tencent 产物，
 * 故保留兜底文案/配色；未收录平台退回原始 source 键。
 */
export const RESOLVE_EXTRA_META: Record<string, { label: string; color: string }> = {
  tencent: { label: "QQ音乐", color: "#31c27c" },
  kugou: { label: "酷狗音乐", color: "#0fa5e9" },
  migu: { label: "咪咕音乐", color: "#ee3a8a" },
};

/**
 * 行内「来源」展示元信息：先按 chip（内置源）命中，链接解析专属平台
 * （如 tencent）走 RESOLVE_EXTRA_META，均未命中则退回原始 source 键。
 */
export const sourceMetaFor = (
  key: string,
  chips: SearchChip[]
): { label: string; color: string } => {
  const chip = chips.find((s) => s.key === key);
  if (chip) return chip;
  const extra = RESOLVE_EXTRA_META[key];
  return {
    label: extra?.label ?? (key || "未知平台"),
    color: extra?.color ?? "",
  };
};
