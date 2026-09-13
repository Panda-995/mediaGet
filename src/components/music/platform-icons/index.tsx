import type { SearchSourceKey } from "@/components/music/types";
import { AGGREGATE_LOGO, PLATFORM_LOGOS } from "@/components/music/platform-brand";

/**
 * 音乐平台品牌图标统一引用 public/logos/ 下的静态 SVG 文件：
 *   文件命名 = 平台 key + ".svg"，如 netease.svg / kugou.svg / migu.svg。
 * 把完整品牌 SVG 直接存入 public/logos/ 即可（viewBox 任意，现有文件统一 0 0 1024 1024），
 * 下方 PlatformIcon 会自动以 <img> 形式展示；品牌映射集中在 platform-brand.ts
 * （PLATFORM_LOGOS，系统媒体控件回退封面也复用同一份）。
 * 另导出 AggregateIcon：聚合搜索模式图标（不是平台品牌，走 platform-brand 的 AGGREGATE_LOGO）。
 */
/** 与平台 logo 同规格的图标入参（尺寸/类名），供聚合搜索模式图标等非平台图标复用 */
export interface BrandIconProps {
  /** 图标边长（默认 14，与 chip 行内平台 logo 保持一致） */
  size?: number;
  className?: string;
}

export interface PlatformIconProps extends BrandIconProps {
  /** 平台 key（netease / tencent / kuwo / joox） */
  source: SearchSourceKey;
}

/** 按平台 key 渲染 public/logos 下对应的品牌 logo */
export function PlatformIcon({
  source,
  size = 14,
  className = "",
}: PlatformIconProps) {
  const src = PLATFORM_LOGOS[source];
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`shrink-0 object-contain ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * 「聚合搜索」模式图标：不是平台品牌，而是搜索模式的图示（多路音源汇聚成一份合并结果）。
 * 与 PlatformIcon 同为 14px `<img>`，尺寸/间距一致，保证 chip 行内视觉对齐。
 */
export function AggregateIcon({ size = 14, className = "" }: BrandIconProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={AGGREGATE_LOGO}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`shrink-0 object-contain ${className}`}
      aria-hidden="true"
    />
  );
}
