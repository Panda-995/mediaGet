/**
 * 视频清晰度档位（qualities）收口守卫。
 *
 * 微博/快手/抖音/Twitter/Instagram 的档位断言在各自平台的守卫文件里；
 * 这里补两件事：
 * 1. 共享 buildQualityList 的边界（<2 档不出、按 URL 去重、缺失档位兜底）；
 * 2. 小红书（h264/h265 流表）与 TikTok（yt-dlp 渐进式 mp4）两条只能整体
 *    跑的解析链路——它们的档位映射没有可单独导出的纯函数，用打桩跑通出口形状。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/parse-core/src/lib/ytDlpClient", () => ({
  runYtDlp: vi.fn(),
  sleep: vi.fn(async () => {}),
}));

import { runYtDlp } from "../packages/parse-core/src/lib/ytDlpClient";
import { buildQualityList } from "@/lib/quality";
import { xhsParse } from "@/lib/xhsCore";
import { parseTiktok } from "@/lib/tiktokDlp";

describe("buildQualityList：共享档位收口", () => {
  it("少于两档返回 undefined（前端只在 >1 时渲染下拉）", () => {
    expect(buildQualityList([])).toBeUndefined();
    expect(buildQualityList(undefined as never)).toBeUndefined();
    expect(buildQualityList([{ quality: 720, label: "720p", url: "u720" }])).toBeUndefined();
  });

  it("按 URL 去重、保留顺序，非数字档位落 0 并给默认文案", () => {
    expect(
      buildQualityList([
        { quality: 1080, label: "1080p", url: "u1080" },
        { quality: 1080, label: "重复", url: "u1080" },
        { quality: Number.NaN, label: "", url: "uDefault" },
      ])
    ).toEqual([
      { quality: 1080, label: "1080p", url: "u1080" },
      { quality: 0, label: "默认", url: "uDefault" },
    ]);
  });
});

describe("小红书 video.media.stream：h264/h265 档位", () => {
  const NOTE_URL = "https://www.xiaohongshu.com/explore/65f0c0e5000000001203d2a3";

  /** note 页 + HEAD 探测两种请求：HEAD 一律可用，其余回笔记 HTML */
  function stubXhs(stream: Record<string, unknown>) {
    const state = {
      note: {
        currentNoteId: "65f0c0e5000000001203d2a3",
        noteDetailMap: {
          "65f0c0e5000000001203d2a3": {
            note: { title: "笔记", video: { media: { stream } } },
          },
        },
      },
    };
    const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)}</script>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") return { ok: true };
        return {
          status: 200,
          url: NOTE_URL,
          headers: { get: () => null, getSetCookie: () => [] },
          text: async () => html,
        };
      })
    );
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("h264 多档：按高度降序，主直链跟最高档，http 直链统一转 https", async () => {
    stubXhs({
      h264: [
        {
          height: 720,
          width: 1280,
          masterUrl: "https://cdn/720-master.mp4",
          backupUrls: ["http://cdn/720.mp4"],
        },
        {
          height: 1080,
          width: 1920,
          masterUrl: "https://cdn/1080-master.mp4",
          backupUrls: ["https://cdn/1080.mp4"],
        },
      ],
    });

    const res: any = await xhsParse(NOTE_URL);

    expect(res.code).toBe(200);
    expect(res.data.qualities).toEqual([
      { quality: 1080, label: "1080p", url: "https://cdn/1080.mp4" },
      { quality: 720, label: "720p", url: "https://cdn/720.mp4" },
    ]);
    expect(res.data.url).toBe("https://cdn/1080.mp4");
  });

  it("h264 为空才用 h265；只有一档时不造下拉", async () => {
    stubXhs({
      h264: [],
      h265: [
        { height: 720, width: 1280, backupUrls: ["https://cdn/hevc720.mp4"] },
      ],
    });

    const res: any = await xhsParse(NOTE_URL);

    expect(res.data.url).toBe("https://cdn/hevc720.mp4");
    expect("qualities" in res.data).toBe(false);
  });
});

describe("TikTok：yt-dlp 渐进式 mp4 档位", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("只取含音视频的 mp4，按高度降序；主直链跟最高档", async () => {
    (runYtDlp as any).mockResolvedValue(
      JSON.stringify({
        title: "TikTok 档位",
        uploader: "作者",
        thumbnail: "https://cover.jpg",
        duration: 12,
        formats: [
          { ext: "mp4", height: 720, acodec: "aac", vcodec: "h264", url: "https://tt/720.mp4" },
          { ext: "mp4", height: 1080, acodec: "aac", vcodec: "h264", url: "https://tt/1080.mp4" },
          { ext: "mp4", height: 2160, acodec: "none", vcodec: "h264", url: "https://tt/video-only.mp4" },
          { ext: "m4a", acodec: "aac", vcodec: "none", url: "https://tt/audio.m4a" },
        ],
      })
    );

    const res: any = await parseTiktok("https://www.tiktok.com/@u/video/1");

    expect(res.code).toBe(200);
    expect(res.data.url).toBe("https://tt/1080.mp4");
    expect(res.data.qualities).toEqual([
      { quality: 1080, label: "1080p", url: "https://tt/1080.mp4" },
      { quality: 720, label: "720p", url: "https://tt/720.mp4" },
    ]);
  });

  it("只有一档渐进式 mp4 时不造下拉", async () => {
    (runYtDlp as any).mockResolvedValue(
      JSON.stringify({
        title: "单档",
        formats: [
          { ext: "mp4", height: 720, acodec: "aac", vcodec: "h264", url: "https://tt/only.mp4" },
        ],
      })
    );

    const res: any = await parseTiktok("https://www.tiktok.com/@u/video/2");

    expect(res.data.url).toBe("https://tt/only.mp4");
    expect("qualities" in res.data).toBe(false);
  });
});
