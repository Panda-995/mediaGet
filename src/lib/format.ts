/**
 * 展示格式化工具（前端通用）。
 *
 * formatCount 此前在 7 个视频组件里逐字重复（TwitterVideo 的 fmtCount 同公式），
 * ParseInfoPanel 另有一份宽容变体，本模块统一收敛。
 */

/** 数字缩写：≥1万 → x.x万（≥100万 → 整数万）/ 其余千分位。
 *  入参约定为已校验有效的数字（无效值会显示 "NaN"——与各组件原先的行为一致）。 */
export function formatCount(n: number): string {
  if (n >= 10000) {
    return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`;
  }
  return n.toLocaleString("zh-CN");
}

/** 解析宽松计数输入：数字 / 数字字符串 / 中文单位字符串（"32.1万"、"1.2亿"）。无效返回 NaN */
function parseCount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (typeof value === "string") {
    const m = value.trim();
    const w = /^([\d.]+)\s*万$/.exec(m);
    if (w) return parseFloat(w[1]) * 10000;
    const y = /^([\d.]+)\s*亿$/.exec(m);
    if (y) return parseFloat(y[1]) * 100000000;
    return parseFloat(m);
  }
  return Number.NaN;
}

/** 宽容版计数格式化：无效或 ≤0 返回 undefined（用于"无效则隐藏该行"的场景） */
export function formatCountLoose(value: unknown): string | undefined {
  const n = parseCount(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return formatCount(n);
}
