// @ts-nocheck
/**
 * 小平台解析路由的单测安全网（P2-3）。
 *
 * 背景：本文件覆盖 acfun / xigua / qsmusic 三个「简单平台」。这类平台此前
 * **只有 live 测试**（tests/live/parse-live.test.ts），需要真实链接 + 真实网络，默认
 * 跳过 —— 等于没有任何安全网。P2-5 的教训是「零测试覆盖时不要动结构」，因此本批
 * （P2-3）先补这一层：用 mock fetch 覆盖成功 / 上游无数据 / 链接无 id / 上游异常四条路径，
 * 后续的样板收敛才能有等价性验证。
 *
 * 约定：
 * - 限流（server-guard.rateLimit）与平台级节流（anti-bot.platformFetchLimiter）在
 *   VITEST=true 下自动跳过，可以高频调用；
 * - 进程内成功缓存 5 分钟（server-guard.getCachedResponse），**每个用例必须用不同 URL**，
 *   否则第二个用例会命中缓存拿到上一个结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as acfunGET } from "@/app/api/acfun/route.js";
import { GET as xiguaGET } from "@/app/api/xigua/route.js";
import { GET as qsmusicGET } from "@/app/api/qsmusic/route.js";

const IP = "203.0.113.42";

/** 构造带 IP 的请求（中间件按 x-forwarded-for 取客户端 IP） */
const req = (url: string) =>
  new Request(url, { headers: { "x-forwarded-for": IP } });

/** mock 一个 HTML 上游响应 */
const htmlOnce = (body: string) => new Response(body, { status: 200 });

describe("AcFun /api/acfun", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功：从页面 playInfo 取首个播放地址", async () => {
    global.fetch.mockResolvedValue(
      htmlOnce(
        `<html><script>var videoInfo = ${JSON.stringify({
          title: "A站标题",
          cover: "https://cov.png",
        })};</script>
         <script>var playInfo = ${JSON.stringify({
           streams: [{ playUrls: ["https://acfun/1.m3u8"] }],
         })};</script></html>`
      )
    );

    const body = await (
      await acfunGET(req("http://127.0.0.1/api/acfun?url=https://www.acfun.cn/v/ac1001"))
    ).json();

    expect(body.code).toBe(200);
    expect(body.data).toMatchObject({
      title: "A站标题",
      url: "https://acfun/1.m3u8",
    });
  });

  it("无 playInfo → 404", async () => {
    global.fetch.mockResolvedValue(htmlOnce("<html>只有页面骨架</html>"));
    const body = await (
      await acfunGET(req("http://127.0.0.1/api/acfun?url=https://www.acfun.cn/v/ac1002"))
    ).json();
    expect(body.code).toBe(404);
    expect(body.msg).toContain("AcFun");
  });
});

describe("西瓜 /api/xigua", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const routerHtml = (item: unknown) =>
    `<html><script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [item] } } },
    })}</script></html>`;

  const fullItem = {
    desc: "西瓜标题",
    author: {
      nickname: "作者E",
      avatar_thumb: { url_list: ["https://av.png"] },
      user_id: 77,
    },
    video: {
      cover: { url_list: ["https://cov.png"] },
      play_addr: { url_list: ["https://xigua/1.mp4"] },
    },
  };

  /** 第一次请求 = 短链 302，第二次 = 分享页 HTML */
  const mockShortThenPage = (pageHtml: string) => {
    global.fetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://www.ixigua.com/video/7001" },
        })
      )
      .mockResolvedValueOnce(htmlOnce(pageHtml));
  };

  it("成功：短链跟随 → _ROUTER_DATA 取首个播放地址", async () => {
    mockShortThenPage(routerHtml(fullItem));
    const body = await (
      await xiguaGET(req("http://127.0.0.1/api/xigua?url=https://ixigua.com/s/OK1"))
    ).json();

    expect(body.code).toBe(200);
    expect(body.data).toMatchObject({
      title: "西瓜标题",
      author: "作者E",
      uid: "77",
      url: "https://xigua/1.mp4",
    });
  });

  it("短链无 Location → 400", async () => {
    global.fetch.mockResolvedValue(new Response("no redirect", { status: 200 }));
    const body = await (
      await xiguaGET(req("http://127.0.0.1/api/xigua?url=https://ixigua.com/s/NORED1"))
    ).json();

    expect(body.code).toBe(400);
    expect(body.msg).toContain("重定向");
  });

  it("页面无 _ROUTER_DATA → 400", async () => {
    mockShortThenPage("<html>只有页面骨架</html>");
    const body = await (
      await xiguaGET(req("http://127.0.0.1/api/xigua?url=https://ixigua.com/s/NODATA1"))
    ).json();

    expect(body.code).toBe(400);
    expect(body.msg).toContain("西瓜页面解析失败");
  });

  it("_ROUTER_DATA 非合法 JSON → 400", async () => {
    mockShortThenPage("<html><script>window._ROUTER_DATA = {oops;</script></html>");
    const body = await (
      await xiguaGET(req("http://127.0.0.1/api/xigua?url=https://ixigua.com/s/BADJSON1"))
    ).json();

    expect(body.code).toBe(400);
    expect(body.msg).toContain("JSON");
  });

  it("无播放地址 → 404", async () => {
    mockShortThenPage(routerHtml({ desc: "没有地址的作品" }));
    const body = await (
      await xiguaGET(req("http://127.0.0.1/api/xigua?url=https://ixigua.com/s/NOURL1"))
    ).json();

    expect(body.code).toBe(404);
  });

  it("上游异常 → 500", async () => {
    global.fetch.mockRejectedValue(new Error("ECONNRESET"));
    const res = await xiguaGET(
      req("http://127.0.0.1/api/xigua?url=https://ixigua.com/s/ERR1")
    );
    expect(res.status).toBe(500);
  });
});

describe("汽水音乐 /api/qsmusic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (title: string, audio: unknown) =>
    `<html><head><script type="application/ld+json">${encodeURIComponent(
      JSON.stringify({ title, images: ["https://cov.png"] })
    )}</script></head><body><script>window._ROUTER_DATA = ${JSON.stringify({
      loaderData: { track_page: { audioWithLyricsOption: audio } },
    })};</script></body></html>`;

  /** 用 music.douyin.com（不含 qishui.douyin.com）以跳过短链跟随那一跳 */
  const url = (trackId: string) =>
    req(
      `http://127.0.0.1/api/qsmusic?url=https://music.douyin.com/qishui/share/track?track_id=${trackId}`
    );

  it("成功：LD+JSON 取标题、ROUTER_DATA 取音频并转 LRC", async () => {
    global.fetch.mockResolvedValue(
      htmlOnce(
        page("汽水歌曲", {
          url: "https://qishui/1.mp3",
          lyrics: {
            sentences: [
              { startMs: 65_000, words: [{ text: "你" }, { text: "好" }] },
              { startMs: 0, words: [{ text: "前奏" }] },
            ],
          },
        })
      )
    );
    const body = await (await qsmusicGET(url("7001"))).json();

    expect(body.code).toBe(200);
    expect(body.data).toMatchObject({
      name: "汽水歌曲",
      url: "https://qishui/1.mp3",
      // 封面是图片，出口层统一包站内代理（内核只出直链）
      cover: `/api/image?url=${encodeURIComponent("https://cov.png")}`,
    });
    // startMs=0 的句子被过滤（falsy），只留 01:05.000 那句
    expect(body.data.lyrics).toBe("[01:05.000]你好");
  });

  it("链接无 track_id → 400", async () => {
    const body = await (
      await qsmusicGET(
        req("http://127.0.0.1/api/qsmusic?url=https://music.douyin.com/qishui/share/track")
      )
    ).json();

    expect(body.code).toBe(400);
    expect(body.msg).toContain("音乐ID");
  });

  it("页面无音乐信息 → 404", async () => {
    global.fetch.mockResolvedValue(htmlOnce("<html>空页面</html>"));
    const body = await (await qsmusicGET(url("7002"))).json();

    expect(body.code).toBe(404);
  });

  it("上游异常 → 500", async () => {
    global.fetch.mockRejectedValue(new Error("ECONNRESET"));
    const body = await (await qsmusicGET(url("7003"))).json();

    expect(body.code).toBe(500);
  });
});
