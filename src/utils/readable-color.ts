/**
 * 深色主题下的可读强调色。
 *
 * 平台品牌色被页面注入 `--accent` 后同时当文字色用（链接、徽标），而近黑的
 * 品牌色（X `#14171a`、TikTok `#010101`）在深色背景上对比度不足 1.5:1，等于
 * 隐形。这里按 WCAG 相对亮度算对比度，不达标就逐步混白（保色相、降饱和），
 * 直到达到 AA 正文标准 4.5:1；本身够亮的品牌色原样返回，不做无谓降饱和。
 */

/** 与 globals.css `.dark --background` 保持一致的默认深色底 */
const DARK_BG = "#0a0f16";
/** WCAG AA 正文对比度 */
const MIN_CONTRAST = 4.5;
/** 混白步数（0.05 一档），够细且结果稳定可测 */
const MIX_STEPS = 20;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  const hex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** WCAG 相对亮度（0 黑 → 1 白） */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 两色对比度（1:1 ~ 21:1）；无法解析时返回 1 */
export function contrastRatio(fg: string, bg: string): number {
  const a = parseHex(fg);
  const b = parseHex(bg);
  if (!a || !b) return 1;
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 取深色背景下的可读版本：对比度已达 4.5 原样返回，否则逐档混白直到达标 */
export function readableOnDark(color: string, bg = DARK_BG): string {
  const c = parseHex(color);
  if (!c || !parseHex(bg)) return color;
  for (let i = 0; i <= MIX_STEPS; i++) {
    const t = i / MIX_STEPS;
    const mixed: Rgb = [
      c[0] + (255 - c[0]) * t,
      c[1] + (255 - c[1]) * t,
      c[2] + (255 - c[2]) * t,
    ];
    const hex = toHex(mixed);
    if (contrastRatio(hex, bg) >= MIN_CONTRAST) return hex;
  }
  return "#ffffff";
}
