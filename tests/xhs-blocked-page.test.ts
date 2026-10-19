/**
 * 小红书拦截页守卫：登录墙（/login）与链接失效（/404?error_code=300031）。
 *
 * 这两类页面同样带 `window.__INITIAL_STATE__`，此前会被继续解析成
 * 「数据结构不匹配」或「该内容不包含视频或图片」，把「链接需要重新分享」
 * 误报成「内容没有媒体」。这里锁死三种出口：
 * 1. 302 /login      → 提示需要登录/重新分享链接
 * 2. 302 /404 300031 → 提示笔记暂时无法浏览
 * 3. 空壳 note 200   → 仍走「数据结构不匹配」，不落到「不包含视频或图片」
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { xhsParse } from "@/lib/xhsCore";

const NOTE_ID = "6acf7afd000000000200d157";
const XHS_NOTE_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;
const SHORT_URL = "https://xhslink.cn/o/7slyb6OnhfB";

type StubResponse = {
  status: number;
  url: string;
  headers: { get(name: string): string | null; getSetCookie(): string[] };
  text(): Promise<string>;
};

function makeResponse(
  url: string,
  status: number,
  opts: { location?: string; html?: string } = {}
): StubResponse {
  return {
    status,
    url,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "location" ? opts.location ?? null : null,
      getSetCookie: () => [],
    },
    text: async () => opts.html ?? "",
  };
}

function stateHtml(state: unknown) {
  return `<html><script>window.__INITIAL_STATE__ = ${JSON.stringify(
    state
  )}</script></html>`;
}

/** 登录页/404 页共用的空壳 note 结构（无 currentNoteId、noteDetailMap 为空） */
const EMPTY_SHELL_STATE = {
  global: {},
  note: {
    prevRouteData: null,
    commentTarget: null,
    isImgFullscreen: false,
    noteDetailMap: {},
    currentNoteId: null,
  },
};

describe("小红书拦截页：登录墙与链接失效", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("短链落到 /login：提示需要登录，不再报「数据结构不匹配」", async () => {
    const loginUrl = `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(
      `http://www.xiaohongshu.com/discovery/item/${NOTE_ID}?xsec_token=abc%3D`
    )}`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === SHORT_URL) {
          return makeResponse(url, 302, { location: loginUrl });
        }
        return makeResponse(url, 200, { html: stateHtml(EMPTY_SHELL_STATE) });
      })
    );

    const res = await xhsParse(SHORT_URL);

    expect(res.code).toBe(400);
    expect(res.msg).toContain("登录");
    expect(res.msg).not.toContain("数据结构不匹配");
  });

  it("302 到 /404?error_code=300031：提示笔记无法浏览，不再报「不包含视频或图片」", async () => {
    const notFoundUrl = `https://www.xiaohongshu.com/404?source=/404/sec_abc?redirectPath=${encodeURIComponent(
      XHS_NOTE_URL
    )}&error_code=300031&error_msg=Sorry`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === XHS_NOTE_URL) {
          return makeResponse(url, 302, { location: notFoundUrl });
        }
        return makeResponse(url, 200, { html: stateHtml(EMPTY_SHELL_STATE) });
      })
    );

    const res = await xhsParse(XHS_NOTE_URL);

    expect(res.code).toBe(400);
    expect(res.msg).toContain("无法浏览");
    expect(res.msg).not.toContain("不包含视频或图片");
  });

  it("302 到 /website-login/error?error_code=300017：提示笔记不可见，不再报「页面结构更新」", async () => {
    const errorUrl = `https://www.xiaohongshu.com/website-login/error?redirectPath=${encodeURIComponent(
      `https://www.xiaohongshu.com/explore?target_note_id=${NOTE_ID}`
    )}&error_code=300017&error_msg=url%20is%20invalid`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === XHS_NOTE_URL) {
          return makeResponse(url, 302, { location: errorUrl });
        }
        return makeResponse(url, 200, {
          html: "<html><head><title>小红书</title></head><body></body></html>",
        });
      })
    );

    const res = await xhsParse(XHS_NOTE_URL);

    expect(res.code).toBe(400);
    expect(res.msg).toContain("无法查看");
    expect(res.msg).not.toContain("页面结构");
  });

  it("页面 200 但 note 为空壳：兜底路径拒收，报结构不匹配而非内容无媒体", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        makeResponse(String(input), 200, { html: stateHtml(EMPTY_SHELL_STATE) })
      )
    );

    const res = await xhsParse(XHS_NOTE_URL);

    expect(res.code).toBe(400);
    expect(res.msg).toContain("数据结构不匹配");
    expect(res.msg).not.toContain("不包含视频或图片");
  });
});
