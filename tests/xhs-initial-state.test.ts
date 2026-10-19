/**
 * 小红书 `__INITIAL_STATE__` 兼容性。
 *
 * 该赋值不是严格 JSON：
 * - 匿名页：偶见 `undefined`
 * - 登录态页（配置 XHS_COOKIE 后）：带 `new Map([])` / `new Set([])` 等 store 字面量
 *
 * 以前只做了 `/undefined/g -> null`，登录态页面会直接「JSON数据解析失败」；
 * 且全局正则会误伤字符串内部的 "undefined"。这里锁住两条：
 * 1. `new Map(...)` / `new Set(...)` 被清洗后仍能解析出笔记
 * 2. 字符串内的 "undefined" 原样保留
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { xhsParse } from "@/lib/xhsCore";

const NOTE_ID = "69129dcf000000000402931c";
const NOTE_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}`;

function stubPage(initialStateLiteral: string) {
  const html = `<html><script>window.__INITIAL_STATE__ = ${initialStateLiteral}</script></html>`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => ({
      status: 200,
      url: String(input),
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => html,
    }))
  );
}

describe("小红书 __INITIAL_STATE__：JS 字面量清洗", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("登录态页面含 new Map([])/new Set([])：仍能解析出笔记与图片", async () => {
    stubPage(
      `{"note":{"currentNoteId":"${NOTE_ID}","noteDetailMap":{"${NOTE_ID}":{"note":` +
        `{"title":"登录态笔记","desc":"正文","user":{"nickname":"作者"},` +
        `"imageList":[{"urlDefault":"https://sns-webpic.xhscdn.com/i1.jpg"}]}}}},` +
        `"AiNoteDetailStore":{"noteDetailMap":new Map([])},` +
        `"tail":{"tailMap":new Map([["a","b"]]),"seen":new Set(["x"])}}`
    );

    const res: any = await xhsParse(NOTE_URL);

    expect(res.code).toBe(200);
    expect(res.msg).toBe("解析成功");
    expect(res.data.type).toBe("image");
    expect(res.data.title).toBe("登录态笔记");
    expect(res.data.author).toBe("作者");
    expect(res.data.images).toEqual(["https://sns-webpic.xhscdn.com/i1.jpg"]);
  });

  it("字符串内部的 undefined 不被改写", async () => {
    stubPage(
      `{"note":{"currentNoteId":"${NOTE_ID}","noteDetailMap":{"${NOTE_ID}":{"note":` +
        `{"title":"t","desc":"undefined 是 JS 关键字，不是 null",` +
        `"imageList":[{"urlDefault":"https://sns-webpic.xhscdn.com/i2.jpg"}]}}}}}`
    );

    const res: any = await xhsParse(NOTE_URL);

    expect(res.code).toBe(200);
    expect(res.data.desc).toBe("undefined 是 JS 关键字，不是 null");
  });
});
