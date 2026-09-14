/**
 * 音乐客户端请求层 —— 展示辅助
 *
 * 只做「数据 → 界面文案」的纯换算，不发请求、不碰会话状态：
 * - brInfo / brIsSupported：音质档位值 ↔ 下拉选项标签；
 * - lineBaseLabel / musicLineMeta：把结果线路（proxy / direct / self）翻成列表列文案与悬浮说明。
 */
import { BR_OPTIONS } from "@/types/music";
import { GD_PUBLIC_HOST, type MusicLine } from "./music-client-core";

/** 音质档位详情 */
export function brInfo(value: string): { label: string; br: number } {
  const opt = BR_OPTIONS.find((o) => o.value === value);
  return { label: opt?.label ?? `${value}kbps`, br: Number(value) || 320 };
}

export function brIsSupported(value: string): boolean {
  return BR_OPTIONS.some((o) => o.value === value);
}

/** 上游基址可读短名：GD 公共实例显示「GD 音乐」，其余按 host 展示 */
export function lineBaseLabel(base: string): string {
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    /* 非法 URL 保持原样展示 */
  }
  return host === GD_PUBLIC_HOST ? "GD 音乐" : host;
}

/** 结果列表「线路」列内容：返回展示文案 / 悬浮全文 / 是否直连；无线路（如链接解析产物）返回 null */
export function musicLineMeta(
  line?: MusicLine | null
): { text: string; title: string; direct: boolean } | null {
  if (!line || !line.base) return null;
  // 站点直连搜索线路：站点服务端直连各音源搜索接口（不经 GD 上游）
  if (line.kind === "self") {
    return {
      text: "站点直连",
      title: "站点直连音源搜索接口取回（不经 GD 音乐）",
      direct: false,
    };
  }
  const direct = line.kind === "direct";
  return {
    text: `${direct ? "直连" : "代理"} · ${lineBaseLabel(line.base)}`,
    title: direct
      ? `浏览器直连上游取回（同源代理不可用后降级）· ${line.base}`
      : `经同源代理 /api/music 命中上游基址 · ${line.base}`,
    direct,
  };
}
