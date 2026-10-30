// 深色主题下平台强调色的可读性守卫：
// 近黑品牌色（X #14171a / TikTok #010101）在 .dark 背景 #0a0f16 上必须被提亮到
// WCAG AA 对比度；本身够亮的品牌色不能被无谓降饱和。
import { describe, it, expect } from "vitest";
import { contrastRatio, readableOnDark } from "@/utils/readable-color";
import { VIDEO_PLATFORMS } from "@/config/video-platforms";

const DARK_BG = "#0a0f16";

describe("readableOnDark：深色主题可读强调色", () => {
  it("近黑品牌色提亮到 AA 对比度，且不再是原色", () => {
    for (const brand of ["#14171a", "#010101"]) {
      const out = readableOnDark(brand);
      expect(out).not.toBe(brand);
      expect(contrastRatio(out, DARK_BG)).toBeGreaterThanOrEqual(4.5);
      // 提亮而非变暗
      expect(contrastRatio(out, DARK_BG)).toBeGreaterThan(
        contrastRatio(brand, DARK_BG)
      );
    }
  });

  it("本身已达 AA 的品牌色原样返回（不做无谓降饱和）", () => {
    for (const brand of ["#fe2c55", "#00aeec", "#ff6600"]) {
      expect(contrastRatio(brand, DARK_BG)).toBeGreaterThanOrEqual(4.5);
      expect(readableOnDark(brand)).toBe(brand);
    }
  });

  it("3 位缩写与带/不带 # 都能解析，非法输入原样返回", () => {
    expect(contrastRatio("#fff", DARK_BG)).toBe(
      contrastRatio("ffffff", DARK_BG)
    );
    expect(readableOnDark("not-a-color")).toBe("not-a-color");
    expect(contrastRatio("not-a-color", DARK_BG)).toBe(1);
  });

  it("近黑平台自带 darkColor，且原样就达 AA（不被提亮成灰）", () => {
    // X / TikTok 的品牌色近黑，深色主题改用平台自己的亮色；删掉 darkColor 会退回
    // 逐级混白得到的灰 #7e7f81，链接在深底上像禁用态，这里兜住。
    const x = VIDEO_PLATFORMS.twitter;
    const tiktok = VIDEO_PLATFORMS.tiktok;
    const xDark = "darkColor" in x ? x.darkColor : undefined;
    const tiktokDark = "darkColor" in tiktok ? tiktok.darkColor : undefined;
    expect(xDark).toBe("#1d9bf0");
    expect(tiktokDark).toBe("#25f4ee");
    for (const c of [xDark, tiktokDark] as string[]) {
      expect(contrastRatio(c, DARK_BG)).toBeGreaterThanOrEqual(4.5);
      expect(readableOnDark(c)).toBe(c);
    }
  });

  it("全平台深色强调色在深色底上都达标", () => {
    // 单一口径：有 darkColor 用 darkColor，否则用品牌色，再过 readableOnDark。
    for (const [key, cfg] of Object.entries(VIDEO_PLATFORMS)) {
      const darkAccent = "darkColor" in cfg ? cfg.darkColor : cfg.color;
      expect(
        contrastRatio(readableOnDark(darkAccent), DARK_BG),
        `${key} 深色强调色对比度不足`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
