/**
 * 平台原始档位表 → 契约 `qualities`。
 *
 * 调用方负责按「高 → 低」排好序并给出可展示的 label；本函数只做两件事：
 * URL 去重、不足 2 档返回 undefined —— 前端仅在 >1 档时渲染下拉，
 * 单档继续由 `qualityLabel` 徽标展示，避免出现一个点了也没得选的菜单。
 *
 * @param {{ quality?: number, label?: string, url?: string }[]} entries
 * @returns {{ quality: number, label: string, url: string }[] | undefined}
 */
export function buildQualityList(entries) {
  const list = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const url = entry?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const rawQuality = Number(entry.quality);
    const quality = Number.isFinite(rawQuality) ? rawQuality : 0;
    list.push({
      quality,
      label: String(entry.label || (quality ? `${quality}P` : "默认")),
      url,
    });
  }
  return list.length >= 2 ? list : undefined;
}
