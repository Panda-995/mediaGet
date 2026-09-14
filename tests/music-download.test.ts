// @vitest-environment jsdom
/**
 * 音乐下载（同源 bin 字节代理）的落盘行为。
 *
 * 锁的是「点了下载不能下来一个 JSON」这条底线：
 * 旧实现是 `<a download href="/api/music?...bin=1">`，浏览器会把**服务端的错误响应
 * 也照存成文件**——上游偶发失败（防盗链 403 / 直链过期 / 风控 JSON）时，用户点下载
 * 得到的就是一个内容是 JSON 的 `.json` 文件，且全程没有任何提示。现在改由前端
 * 取回字节、确认是音频后才落盘，失败抛 MusicDownloadError 交给 UI 提示。
 *
 * 这里逐条锁住：什么情况允许落盘、什么情况必须抛错且**一个字节都不能落**。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MusicDownloadError,
  downloadBinTrack,
  fileNameFromDisposition,
} from "@/lib/client/music-client";

/** 替身响应：只实现 downloadBinTrack 真正用到的成员，避免依赖 jsdom 的 fetch/Blob 实现 */
function res(opts: {
  status: number;
  contentType?: string;
  disposition?: string;
  body?: unknown;
  size?: number;
}) {
  const headers = new Map<string, string>();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  if (opts.disposition) headers.set("content-disposition", opts.disposition);
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => opts.body,
    blob: async () => ({ size: opts.size ?? 1024 }),
  } as unknown as Response;
}

/** 接管落盘动作：jsdom 不真的下载，只能验证「有没有点过 <a download> 及文件名」 */
function instrumentDownload() {
  const saved: string[] = [];
  const createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as { createObjectURL: unknown }).createObjectURL =
    createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
  return { saved, createObjectURL, click };
}

describe("音乐下载落盘（music-client downloadBinTrack）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("音频响应 → 落盘，文件名取服务端 RFC 5987 的 filename*", async () => {
    const dl = instrumentDownload();
    global.fetch = vi.fn().mockResolvedValue(
      res({
        status: 200,
        contentType: "audio/mpeg",
        disposition:
          "attachment; filename*=UTF-8''%E5%BC%80%E5%A7%8B%E6%87%82%E4%BA%86%20-%20%E6%A0%87%E5%87%86%E9%9F%B3%E8%B4%A8%C2%B7320kbps.mp3",
        size: 10862803,
      })
    );

    const name = await downloadBinTrack({ url: "/api/music?bin=1" });

    expect(name).toBe("开始懂了 - 标准音质·320kbps.mp3");
    expect(dl.saved).toEqual([name]);
    expect(dl.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("服务端无 Content-Disposition 时用调用方给的兜底文件名", async () => {
    const dl = instrumentDownload();
    global.fetch = vi
      .fn()
      .mockResolvedValue(res({ status: 200, contentType: "audio/flac" }));

    const name = await downloadBinTrack({
      url: "/api/music?bin=1",
      fallbackName: "开始懂了 - 孙燕姿.mp3",
    });

    expect(name).toBe("开始懂了 - 孙燕姿.mp3");
    expect(dl.saved).toEqual([name]);
  });

  it("服务端错误（502 + JSON msg）→ 抛错且不落盘，不存下错误体", async () => {
    const dl = instrumentDownload();
    global.fetch = vi.fn().mockResolvedValue(
      res({
        status: 502,
        contentType: "application/json",
        body: { code: 502, msg: "音频源站下载失败（状态 403），请稍后重试" },
      })
    );

    await expect(downloadBinTrack({ url: "/api/music?bin=1" })).rejects.toThrow(
      MusicDownloadError
    );
    await expect(downloadBinTrack({ url: "/api/music?bin=1" })).rejects.toThrow(
      "音频源站下载失败（状态 403），请稍后重试"
    );
    // 关键：一次都没落盘——这正是「下载下来一个 JSON」的回归点
    expect(dl.saved).toHaveLength(0);
    expect(dl.createObjectURL).not.toHaveBeenCalled();
  });

  it("200 但 Content-Type 是 JSON（过期 / 风控页）→ 抛错且不落盘", async () => {
    const dl = instrumentDownload();
    global.fetch = vi.fn().mockResolvedValue(
      res({
        status: 200,
        contentType: "application/json",
        body: { code: -460, msg: "Cheating" },
      })
    );

    await expect(downloadBinTrack({ url: "/api/music?bin=1" })).rejects.toThrow(
      /非音频内容/
    );
    expect(dl.saved).toHaveLength(0);
  });

  it("源站返回空文件 → 抛错不落盘", async () => {
    const dl = instrumentDownload();
    global.fetch = vi
      .fn()
      .mockResolvedValue(res({ status: 200, contentType: "audio/mpeg", size: 0 }));

    await expect(downloadBinTrack({ url: "/api/music?bin=1" })).rejects.toThrow(
      /空文件/
    );
    expect(dl.saved).toHaveLength(0);
  });

  it("网络异常 → 抛可展示的文案，不落盘", async () => {
    const dl = instrumentDownload();
    global.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    await expect(downloadBinTrack({ url: "/api/music?bin=1" })).rejects.toThrow(
      /下载请求失败/
    );
    expect(dl.saved).toHaveLength(0);
  });

  it("fileNameFromDisposition：filename* 优先，其次 filename，都没有则回退", () => {
    expect(
      fileNameFromDisposition(
        "attachment; filename=\"fallback.mp3\"; filename*=UTF-8''%E6%AD%8C.mp3",
        "x.mp3"
      )
    ).toBe("歌.mp3");
    expect(
      fileNameFromDisposition("attachment; filename=\"plain.mp3\"", "x.mp3")
    ).toBe("plain.mp3");
    expect(fileNameFromDisposition(null, "x.mp3")).toBe("x.mp3");
  });
});
