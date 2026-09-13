/**
 * 系统媒体控件「品牌回退封面」通用内核：把品牌 SVG logo 栅格化为 PNG data URL。
 *
 * 为什么需要：系统级「正在播放」控件（Windows 通知栏 / SMTC、macOS 播放中心与锁屏、
 * Android 通知、iOS 控制中心）普遍不渲染 SVG，只认位图；当内容本身没有封面或封面
 * 加载失败时，用平台品牌 logo（栅格化）兜底，避免系统控件出现无图卡片；无品牌 SVG
 * 的平台退化为「品牌色 + 名称首字」色块。
 *
 * 品牌视觉的「单一数据源」仍留在各业务侧，本模块只负责绘制与缓存：
 * - 音乐：`music/platform-brand.ts`（label / 强调色 / `public/logos` SVG）；
 * - 视频：`config/video-platforms.ts`（name / color / logo）。
 */

/** 回退封面边长：系统控件通常只取一张图，512 足够清晰 */
export const ARTWORK_SIZE = 512;

/** 品牌视觉信息（各业务模块各自映射） */
export interface BrandVisual {
  /** 展示名；无品牌 SVG 时取首字画色块 */
  label: string;
  /** 品牌强调色（hex）；缺失用中性色 */
  color?: string;
  /** `public/logos` 下的品牌 SVG 路径；缺失表示该平台无品牌 logo */
  logo?: string;
}

/** 无品牌色时的中性兜底 */
const NEUTRAL_COLOR = "#64748b";

/** 加载图片（封面探测 / 品牌栅格化共用）；失败 reject */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/** 绘制品牌色圆角方块 + 名称首字 */
function drawBrandTile(ctx: CanvasRenderingContext2D, brand: BrandVisual): void {
  const s = ARTWORK_SIZE;
  ctx.fillStyle = brand.color || NEUTRAL_COLOR;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(0, 0, s, s, s * 0.22);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, s, s);
  }
  const glyph = (brand.label || "?").trim().slice(0, 1) || "?";
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(s * 0.46)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, s / 2, s / 2 + s * 0.02);
}

/** 栅格化品牌 SVG → PNG data URL；无 logo / 加载失败退回品牌色块，无 canvas 环境返回 null */
async function buildBrandArtwork(brand: BrandVisual): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = ARTWORK_SIZE;
  canvas.height = ARTWORK_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (brand.logo) {
    try {
      // 同源 SVG → canvas 不会污染画布，可安全导出 data URL
      const img = await loadImage(new URL(brand.logo, window.location.href).href);
      ctx.drawImage(img, 0, 0, ARTWORK_SIZE, ARTWORK_SIZE);
      return canvas.toDataURL("image/png");
    } catch {
      // logo 资源缺失 / 离线 → 落到品牌色块
    }
  }
  drawBrandTile(ctx, brand);
  return canvas.toDataURL("image/png");
}

/** 回退封面缓存：同一 key 只生成一次（值为 PNG data URL 的 Promise） */
const brandArtworkCache = new Map<string, Promise<string | null>>();

/**
 * 取品牌回退封面（`image/png` data URL）；生成失败（无 canvas 等极端环境）返回 null。
 * 结果按 cacheKey 缓存 —— 同一平台反复播放只栅格化一次。
 */
export function brandArtworkFor(cacheKey: string, brand: BrandVisual): Promise<string | null> {
  const cached = brandArtworkCache.get(cacheKey);
  if (cached) return cached;
  const task = buildBrandArtwork(brand).catch(() => null);
  brandArtworkCache.set(cacheKey, task);
  return task;
}
