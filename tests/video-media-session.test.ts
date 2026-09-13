import { describe, expect, it } from "vitest";
import {
  videoArtworkFor,
  videoNowPlayingTitle,
  videoPageTitle,
} from "@/components/videos/use-video-media-session";

describe("videoNowPlayingTitle", () => {
  it("单视频（无分P标题）用整体标题", () => {
    expect(videoNowPlayingTitle("如何写一个解析器", "")).toBe("如何写一个解析器");
  });

  it("多分P 拼成「整体标题 - 分P标题」", () => {
    expect(videoNowPlayingTitle("【合集】前端手记", "P2 状态管理")).toBe(
      "【合集】前端手记 - P2 状态管理"
    );
  });

  it("分P标题与整体相同 / 全为空白时不重复拼接", () => {
    expect(videoNowPlayingTitle("同一个标题", "同一个标题")).toBe("同一个标题");
    expect(videoNowPlayingTitle("同一个标题", "   ")).toBe("同一个标题");
  });

  it("整体标题缺失时退回分P标题", () => {
    expect(videoNowPlayingTitle("", "P3 收尾")).toBe("P3 收尾");
  });
});

describe("videoPageTitle", () => {
  it("站点标题为「视频标题 - 上传者」", () => {
    expect(videoPageTitle("三分钟讲清媒体会话", "某UP主", "哔哩哔哩")).toBe(
      "三分钟讲清媒体会话 - 某UP主"
    );
  });

  it("上传者缺失时退回平台名", () => {
    expect(videoPageTitle("三分钟讲清媒体会话", "", "抖音")).toBe(
      "三分钟讲清媒体会话 - 抖音"
    );
  });
});

describe("videoArtworkFor", () => {
  it("未指定平台时不下发封面（系统控件只展示文字）", async () => {
    await expect(videoArtworkFor()).resolves.toEqual([]);
  });

  it("无 canvas 环境（node）下静默降级为空数组，不影响页面播放", async () => {
    await expect(videoArtworkFor("bilibili")).resolves.toEqual([]);
    // 同一平台重复取走缓存，同样不抛错
    await expect(videoArtworkFor("bilibili")).resolves.toEqual([]);
  });
});
