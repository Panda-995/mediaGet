// @ts-nocheck
/**
 * 小平台解析路由的单测安全网（P2-3）。
 *
 * 背景：huya / quanminkge / haokan / acfun / xinpianchang 这 5 个「简单平台」此前
 * **只有 live 测试**（tests/live/parse-live.test.ts），需要真实链接 + 真实网络，默认
 * 跳过 —— 等于没有任何安全网。P2-5 的教训是「零测试覆盖时不要动结构」，因此本批
 * （P2-3）先补这一层：用 mock fetch 覆盖成功 / 上游无数据 / 链接无 id / 上游异常四条路径，
 * 后续的样板收敛才能有等价性验证。
 *
 * 约定：
 * - 限流（api-utils.rateLimit）与平台级节流（anti-bot.platformFetchLimiter）在
 *   VITEST=true 下自动跳过，可以高频调用；
 * - 进程内成功缓存 5 分钟（api-utils.getCachedResponse），**每个用例必须用不同 URL**，
 *   否则第二个用例会命中缓存拿到上一个结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as huyaGET } from "@/app/api/huya/route.js";
import { GET as quanminkgeGET } from "@/app/api/quanminkge/route.js";
import { GET as haokanGET } from "@/app/api/haokan/route.js";
import { GET as acfunGET } from "@/app/api/acfun/route.js";
import { GET as xinpianchangGET } from "@/app/api/xinpianchang/route.js";
import { GET as xiguaGET } from "@/app/api/xigua/route.js";
import { GET as pipigxGET } from "@/app/api/pipigx/route.js";
import { GET as qsmusicGET } from "@/app/api/qsmusic/route.js";

const IP = "203.0.113.42";

/** 构造带 IP 的请求（中间件按 x-forwarded-for 取客户端 IP） */
const req = (url: string) =>
  new Request(url, { headers: { "x-forwarded-for": IP } });

/** mock 一个 JSON 上游响应 */
const jsonOnce = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const htmlOnce = (body: string) => new Response(body, { status: 200 });

describe("虎牙 /api/huya", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功：从 moment 接口取到首个清晰度直链", async () => {
    global.fetch.mockResolvedValue(
      jsonOnce({
        data: {
          moment: {
            videoInfo: {
              videoTitle: "虎牙测试标题",
              actorNick: "主播A",
              actorAvatarUrl: "https://a.png",
              uid: 123456,
              videoCover: "https://c.png",
              definitions: [{ url: "https://v.huya.com/1.mp4" }],
            },
          },
        },
      })
    );

    const body = await (
      await huyaGET(req("http://127.0.0.1/api/huya?url=https://www.huya.com/1001.html"))
    ).json();

    expect(body.code).toBe(200);
    expect(body.msg).toBe("解析成功");
    expect(body.data).toMatchObject({
      title: "虎牙测试标题",
      author: "主播A",
      uid: "123456",
      url: "https://v.huya.com/1.mp4",
    });
  });

  it("链接里没有数字 id → 400", async () => {
    const body = await (
      await huyaGET(req("http://127.0.0.1/api/huya?url=https://www.huya.com/noid"))
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("视频 id");
  });

  it("上游无 definitions → 404", async () => {
    global.fetch.mockResolvedValue(jsonOnce({ data: { moment: {} } }));
    const body = await (
      await huyaGET(req("http://127.0.0.1/api/huya?url=https://www.huya.com/1002.html"))
    ).json();
    expect(body.code).toBe(404);
  });

  it("上游网络异常 → 500", async () => {
    global.fetch.mockRejectedValue(new Error("ECONNRESET"));
    const res = await huyaGET(
      req("http://127.0.0.1/api/huya?url=https://www.huya.com/1003.html")
    );
    expect(res.status).toBe(500);
  });
});

describe("全民K歌 /api/quanminkge", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const html = (detail: unknown) =>
    `<html><script>window.__DATA__ = ${JSON.stringify({ detail })};</script></html>`;

  it("成功：从页面 __DATA__ 提取播放地址", async () => {
    global.fetch.mockResolvedValue(
      htmlOnce(
        html({
          content: "K歌作品",
          nick: "歌手B",
          avatar: "https://av.png",
          uid: 88,
          cover: "https://cov.png",
          playurl_video: "https://kg.qq.com/1.mp4",
        })
      )
    );

    const body = await (
      await quanminkgeGET(
        req("http://127.0.0.1/api/quanminkge?url=https://kg.qq.com/node/play?s=SUCCESS1")
      )
    ).json();

    expect(body.code).toBe(200);
    expect(body.data).toMatchObject({
      title: "K歌作品",
      author: "歌手B",
      uid: "88",
      url: "https://kg.qq.com/1.mp4",
    });
  });

  it("页面无 __DATA__ → 400", async () => {
    global.fetch.mockResolvedValue(htmlOnce("<html>no data</html>"));
    const body = await (
      await quanminkgeGET(
        req("http://127.0.0.1/api/quanminkge?url=https://kg.qq.com/node/play?s=NODATA1")
      )
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("页面解析失败");
  });

  it("__DATA__ 不是合法 JSON → 400", async () => {
    global.fetch.mockResolvedValue(htmlOnce("<html>window.__DATA__ = {oops;</html>"));
    const body = await (
      await quanminkgeGET(
        req("http://127.0.0.1/api/quanminkge?url=https://kg.qq.com/node/play?s=BADJSON1")
      )
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("数据解析失败");
  });

  it("缺少 s 参数 → 400", async () => {
    const body = await (
      await quanminkgeGET(
        req("http://127.0.0.1/api/quanminkge?url=https://kg.qq.com/node/play")
      )
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("参数 s");
  });
});

describe("好看视频 /api/haokan", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功：errno=0 时取 curVideoMeta.playurl", async () => {
    global.fetch.mockResolvedValue(
      jsonOnce({
        errno: 0,
        data: {
          apiData: {
            curVideoMeta: {
              title: "好看标题",
              poster: "https://p.png",
              playurl: "https://haokan/1.mp4",
              mth: { author_name: "作者C", author_photo: "https://ph.png", mthid: 42 },
            },
          },
        },
      })
    );

    const body = await (
      await haokanGET(req("http://127.0.0.1/api/haokan?url=https://haokan.baidu.com/v?vid=OK1"))
    ).json();

    expect(body.code).toBe(200);
    expect(body.data).toMatchObject({
      title: "好看标题",
      author: "作者C",
      uid: "42",
      url: "https://haokan/1.mp4",
    });
  });

  it("errno≠0 → 400（接口错误）", async () => {
    global.fetch.mockResolvedValue(jsonOnce({ errno: 1001, error: "vid 不存在" }));
    const body = await (
      await haokanGET(req("http://127.0.0.1/api/haokan?url=https://haokan.baidu.com/v?vid=ERR1"))
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("vid 不存在");
  });

  it("无 playurl → 404", async () => {
    global.fetch.mockResolvedValue(
      jsonOnce({ errno: 0, data: { apiData: { curVideoMeta: { title: "x" } } } })
    );
    const body = await (
      await haokanGET(req("http://127.0.0.1/api/haokan?url=https://haokan.baidu.com/v?vid=NOURL1"))
    ).json();
    expect(body.code).toBe(404);
  });

  it("缺少 vid → 400", async () => {
    const body = await (
      await haokanGET(req("http://127.0.0.1/api/haokan?url=https://haokan.baidu.com/v"))
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("vid");
  });
});

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

describe("新片场 /api/xinpianchang", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (detail: unknown) =>
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { detail } },
    })}</script></html>`;

  it("成功：从 __NEXT_DATA__ 取首个 progressive 地址", async () => {
    global.fetch.mockResolvedValue(
      htmlOnce(
        page({
          title: "新片场作品",
          cover: "https://cov.png",
          author: { userinfo: { username: "导演D", avatar: "https://av.png" } },
          video: { content: { progressive: [{ url: "https://xpc/1.mp4" }] } },
        })
      )
    );

    const body = await (
      await xinpianchangGET(
        req("http://127.0.0.1/api/xinpianchang?url=https://www.xinpianchang.com/a1001")
      )
    ).json();

    expect(body.code).toBe(200);
    expect(body.data).toMatchObject({
      title: "新片场作品",
      author: "导演D",
      url: "https://xpc/1.mp4",
    });
  });

  it("无 __NEXT_DATA__ → 400", async () => {
    global.fetch.mockResolvedValue(htmlOnce("<html>静态页</html>"));
    const body = await (
      await xinpianchangGET(
        req("http://127.0.0.1/api/xinpianchang?url=https://www.xinpianchang.com/a1002")
      )
    ).json();
    expect(body.code).toBe(400);
    expect(body.msg).toContain("__NEXT_DATA__");
  });

  it("有 __NEXT_DATA__ 但无视频地址 → 404", async () => {
    global.fetch.mockResolvedValue(htmlOnce(page({ title: "图文作品" })));
    const body = await (
      await xinpianchangGET(
        req("http://127.0.0.1/api/xinpianchang?url=https://www.xinpianchang.com/a1003")
      )
    ).json();
    expect(body.code).toBe(404);
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

describe("皮皮搞笑 /api/pipigx", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** videos 是「数组的数组」，取第一组的第一条 */
  const postBody = (content: string, videos: unknown[]) =>
    jsonOnce({ data: { post: { content, videos } } });

  /** 直接给 videos 的原始 JSON —— 数组上的额外属性会被 JSON.stringify 丢掉，只能手写 */
  const postRaw = (content: string, videosJson: string) =>
    new Response(
      `{"data":{"post":{"content":${JSON.stringify(content)},"videos":${videosJson}}}}`,
      { status: 200, headers: { "content-type": "application/json" } }
    );

  // 平台 URL 自带 query，`&` 必须转义，否则会被当成外层请求参数、mid 直接丢失
  const url = (pid: number, mid: number) =>
    req(
      `http://127.0.0.1/api/pipigx?url=${encodeURIComponent(
        `https://h5.pipigx.com/p/1?pid=${pid}&mid=${mid}`
      )}`
    );

  it("成功分支当前不可达：嵌套数组取 videos[0].url 恒为 undefined", async () => {
    // 现有实现先 `videos.filter(Array.isArray)` 再取 `videos[0].url`：filter 之后元素
    // 仍是数组，而 JSON 无法表达「数组自带 url 属性」→ **上游返回任何 JSON 都到不了
    // 成功分支**。本用例锁死这个现状（404 + 该文案），等拿到真实响应再修取值方式；
    // 修好之后这条会变红，正是需要的提醒。详见 docs/REFACTOR-PLAN.md P2-3 第二批。
    global.fetch.mockResolvedValue(
      postRaw("搞笑视频", `[[{"url":"https://ppgx/1.mp4","thumb":"t1"}]]`)
    );
    const body = await (await pipigxGET(url(100, 200))).json();

    expect(body.code).toBe(404);
    expect(body.msg).toContain("视频地址不存在");
  });

  it("扁平对象数组 → 被 filter 过滤 → 同样 404", async () => {
    global.fetch.mockResolvedValue(
      postBody("搞笑视频", [{ url: "https://ppgx/1.mp4" }])
    );
    const body = await (await pipigxGET(url(106, 206))).json();

    expect(body.code).toBe(404);
  });

  it("链接缺 pid/mid → 400", async () => {
    const body = await (
      await pipigxGET(req("http://127.0.0.1/api/pipigx?url=https://h5.pipigx.com/p/1"))
    ).json();

    expect(body.code).toBe(400);
    expect(body.msg).toContain("链接格式");
  });

  it("上游 HTTP 错误 → 状态码透传", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 502 }));
    const body = await (await pipigxGET(url(101, 201))).json();

    expect(body.code).toBe(502);
    expect(body.msg).toContain("502");
  });

  it("上游无 post 数据 → 404", async () => {
    global.fetch.mockResolvedValue(jsonOnce({ data: {} }));
    const body = await (await pipigxGET(url(102, 202))).json();

    expect(body.code).toBe(404);
    expect(body.msg).toContain("未找到视频数据");
  });

  it("post 无视频地址 → 404", async () => {
    global.fetch.mockResolvedValue(postBody("图文", []));
    const body = await (await pipigxGET(url(103, 203))).json();

    expect(body.code).toBe(404);
    expect(body.msg).toContain("视频地址不存在");
  });

  it("上游异常 → 500（请求失败）", async () => {
    global.fetch.mockRejectedValue(new Error("ECONNRESET"));
    const body = await (await pipigxGET(url(104, 204))).json();

    expect(body.code).toBe(500);
    expect(body.msg).toContain("请求上游接口失败");
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
      cover: "https://cov.png",
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
