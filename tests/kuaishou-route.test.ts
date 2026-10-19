// @ts-nocheck
/**
 * 快手出口的五层守卫：
 * - 路由兜底：主解析失败（404 信封）→ 自动走 public17Parse 兜底，兜底也失败 → 404，
 *   主解析成功 → 不触发兜底；头像/封面走站内代理且不外泄内部字段；
 * - H5 取数通道：链接解出的 photoId 一律转投 fw/photo 取数页（桌面 short-video 是未登录空壳），
 *   主端点被风控时按序换镜像；
 * - 登录态作者资料：配了 KUAISHOU_COOKIE 才抓桌面 profile 页补简介/获赞，失效或认不出
 *   该作者时整体降级，不带 cookie 出镜像域名；
 * - 内核提取分支：json-fragment 只带白名单字段（不散播 url 别名、不串标题）；
 * - 统一入口出参：首页走的 /api/parse 也必须把图片改写成站内代理（与 /api/kuaishou 同源）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/kuaishou/route.js";
import { GET as PARSE_GET } from "@/app/api/parse/route.js";
import * as kuaishouCore from "@/lib/kuaishouCore";
import * as douyinFallback from "@/lib/douyinFallback";
import { logger } from "@/lib/api-utils";
import { normalizeResult } from "@/lib/normalize-result";

function makeRequest(url) {
  return new Request(`http://127.0.0.1/api/kuaishou?url=${encodeURIComponent(url)}`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

describe("kuaishou route fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VITEST = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("主解析成功时直接返回，不走兜底", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 200,
      msg: "解析成功",
      data: { photoUrl: "https://v.kwaicdn.com/x.mp4", source: "main" },
      platform: "kuaishou",
    });
    const fallbackSpy = vi
      .spyOn(douyinFallback, "public17Parse")
      .mockResolvedValue({ ok: true, key: "17change", url: "https://fb.mp4" });

    const res = await GET(makeRequest("https://www.kuaishou.com/short-video/abc123"));
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.data.photoUrl).toBe("https://v.kwaicdn.com/x.mp4");
    expect(json.data.source).toBe("main");
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it("主解析无结果时走 17change 兜底并成功", async () => {
    // 内核已保证 parseKuaishou 恒返回信封（不再吐 null），失败码 404 触发兜底
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 404,
      msg: "解析失败，可能是链接格式不支持或内容无法访问",
      platform: "kuaishou",
    });
    vi.spyOn(douyinFallback, "public17Parse").mockResolvedValue({
      ok: true,
      key: "17change",
      url: "https://v23-3.kwaicdn.com/upic/x.mp4",
      title: "测试视频",
      cover: "https://p66.a.kwimgs.com/cover.jpg",
      author: "测试作者",
    });

    const res = await GET(makeRequest("https://www.kuaishou.com/f/abc123"));
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.data.photoUrl).toMatch(/^https?:\/\//);
    expect(json.data.source).toBe("17change");
    expect(json.data.caption).toBe("测试视频");
    expect(json.data.authorName).toBe("测试作者");
  });

  it("主解析失败且兜底也失败时返回 404", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 404,
      msg: "解析失败，可能是链接格式不支持或内容无法访问",
      platform: "kuaishou",
    });
    vi.spyOn(douyinFallback, "public17Parse").mockResolvedValue({
      ok: false,
      error: "17change: 响应无视频地址",
    });

    const res = await GET(makeRequest("https://www.kuaishou.com/f/fallback404"));
    const json = await res.json();

    expect(json.code).toBe(404);
    expect(json.msg).toContain("解析失败");
  });

  it("主解析返回非 200 结果时走兜底", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 404,
      msg: "解析失败",
      data: null,
    });
    vi.spyOn(douyinFallback, "public17Parse").mockResolvedValue({
      ok: true,
      key: "17change",
      url: "https://v23-3.kwaicdn.com/upic/y.mp4",
    });

    const res = await GET(makeRequest("https://www.kuaishou.com/photo/xyz"));
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.data.photoUrl).toBe("https://v23-3.kwaicdn.com/upic/y.mp4");
  });

  it("头像与封面走站内代理：保留 _s 变体、各自携带 CDN fallback、不外泄内部字段", async () => {
    vi.spyOn(kuaishouCore, "parseKuaishou").mockResolvedValue({
      code: 200,
      msg: "解析成功",
      data: {
        photoUrl: "https://v.kwaicdn.com/x.mp4",
        authorAvatar:
          "https://p2-pro.a.yximgs.com/uhead/AB/2022/09/14/14/x==_s.jpg",
        authorAvatarFallbacks: [
          "https://p1-pro.a.yximgs.com/uhead/AB/2022/09/14/14/x==_s.jpg",
        ],
        coverUrl: "https://p5.a.yximgs.com/upic/x.jpg",
        coverUrlFallbacks: ["https://p2.a.yximgs.com/upic/x.jpg"],
        source: "main",
      },
      platform: "kuaishou",
    });

    // 注意：createApiHandler 对同 URL 有进程内缓存，须用与其它用例不同的链接
    const res = await GET(
      makeRequest("https://www.kuaishou.com/short-video/avatar-fallback")
    );
    const json = await res.json();

    expect(json.code).toBe(200);
    // 头像必须走站内代理
    expect(json.data.authorAvatar).toContain("/api/image?url=");
    // 必须保留 _s 变体（uhead 上 _c/_b/原图变体实测 404，替换会导致破图）
    expect(json.data.authorAvatar).toContain("_s.jpg");
    expect(json.data.authorAvatar).not.toContain("_c.jpg");
    // CDN 备选必须传给代理（主节点如 p2-pro 可能 DNS 失效）
    expect(json.data.authorAvatar).toContain("&fallback=");
    expect(json.data.authorAvatar).toContain("p1-pro.a.yximgs.com");
    // 内部字段不对外暴露
    expect(json.data.authorAvatarFallbacks).toBeUndefined();
    expect(json.data.coverUrlFallbacks).toBeUndefined();
    // 封面同样走代理，并带上自己的 CDN 备选
    expect(json.data.coverUrl).toContain("/api/image?url=");
    expect(json.data.coverUrl).toContain("p5.a.yximgs.com");
    expect(json.data.coverUrl).toContain("&fallback=");
    expect(json.data.coverUrl.split("&fallback=")[1]).toContain("p2.a.yximgs.com");
  });
});

/**
 * H5 取数通道（fw/photo）。
 *
 * 桌面页 `www.kuaishou.com/short-video/<id>` 实测只回未登录空壳（无 photoId/mainMvUrls），
 * 同一 photoId 的 `chenzhongtech.com/fw/photo/<id>` 才带 window.INIT_STATE——所以短链/桌面
 * 链接解出的 id 必须转投 H5，且主站被风控时要能换镜像。这里锁住三件事：转投、不再回退桌面
 * 页取数、镜像按序生效。
 */

/**
 * H5 取数页假数据。`extra` 追加 photo 对象的片段（作者号 / 原声作者等），
 * `top` 追加与 photo 平级的片段（内核从 photo 的父层读 `counts`：作者粉丝/关注/作品）。
 */
function H5_PAGE(photoId, extra = "", top = "") {
  return (
    `<html><body><script>window.INIT_STATE = {"detail":{"photoId":"${photoId}",` +
    `"caption":"H5 标题","userName":"H5 作者","duration":62366,` +
    `"mainMvUrls":[{"url":"https://txmov2.a.kwimgs.com/upic/${photoId}.mp4"}],` +
    `"coverUrls":[{"cdn":"p4.a.yximgs.com","url":"https://p4.a.yximgs.com/upic/${photoId}.jpg"},` +
    `{"cdn":"p23.a.yximgs.com","url":"https://p23.a.yximgs.com/upic/${photoId}.jpg"}],` +
    `"headUrl":"https://p2-pro.a.yximgs.com/uhead/${photoId}_s.jpg","userId":"3442571839"${extra}}${top}};</script></body></html>`
  );
}

/** 假网络：首个请求只做重定向探测（读 .url），其余按 URL 命中 pages 里的页面 */
function stubNet(redirectUrl, pages) {
  const calls = [];
  let probeDone = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      calls.push(url);
      if (!probeDone) {
        probeDone = true;
        return { url: redirectUrl ?? url, ok: true, status: 200, text: async () => "" };
      }
      const hit = Object.entries(pages).find(([sub]) => url.includes(sub));
      const body = hit ? hit[1] : '{"result":2,"error_msg":null}';
      return {
        url,
        ok: !!hit,
        status: hit ? 200 : 500,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    })
  );
  return calls;
}

describe("kuaishou 内核 H5 取数通道：id 转投 fw/photo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VITEST = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("/f/ 分享码：重定向解出的 id 转投 chenzhongtech fw/photo 并成功", async () => {
    const calls = stubNet(
      "https://www.kuaishou.com/short-video/3x8f?cc=share_wxms&shareToken=X95cvQeFt6BxX20",
      { "chenzhongtech.com/fw/photo/3x8f": H5_PAGE("3x8f") }
    );

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/f/X95cvQeFt6BxX20");

    expect(res.code).toBe(200);
    expect(res.data).toMatchObject({
      photoUrl: "https://txmov2.a.kwimgs.com/upic/3x8f.mp4",
      caption: "H5 标题",
      authorName: "H5 作者",
      duration: 62366,
      source: "init-state",
    });
    // 封面：首节点为主地址，其余作为 CDN 备选（与头像同口径）
    expect(res.data.coverUrl).toBe("https://p4.a.yximgs.com/upic/3x8f.jpg");
    expect(res.data.coverUrlFallbacks).toEqual([
      "https://p23.a.yximgs.com/upic/3x8f.jpg",
    ]);
    expect(calls[1]).toBe("https://chenzhongtech.com/fw/photo/3x8f");
  });

  it("桌面 short-video 链接不再用它自己取数（只用于重定向探测）", async () => {
    const calls = stubNet(null, { "chenzhongtech.com/fw/photo/3x8d": H5_PAGE("3x8d") });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/short-video/3x8d");

    expect(res.code).toBe(200);
    expect(res.data.photoUrl).toContain("3x8d.mp4");
    expect(calls.filter((u) => u.includes("www.kuaishou.com/short-video"))).toEqual([
      "https://www.kuaishou.com/short-video/3x8d",
    ]);
  });

  it("主端点被风控时按序换 m.gifshow 镜像", async () => {
    const calls = stubNet(null, { "m.gifshow.com/fw/photo/3x8m": H5_PAGE("3x8m") });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3x8m");

    expect(res.code).toBe(200);
    expect(res.data.caption).toBe("H5 标题");
    expect(calls.slice(1)).toEqual([
      "https://chenzhongtech.com/fw/photo/3x8m",
      "https://m.gifshow.com/fw/photo/3x8m",
    ]);
  });

  it("H5 端点全被拦且原始页也提不出数据时，仍是 404 信封（不吐 null）", async () => {
    stubNet(null, {});

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/f/deadbeef");

    expect(res.code).toBe(404);
    expect(res.data).toBeUndefined();
  });
});

/**
 * manifest 清晰度档位。
 *
 * H5 INIT_STATE 的 `manifest.adaptationSet[].representation[]` 才是全档位表：
 * `quality` 是相对分（实测 1.5）不能当高度，展示档位取 `qualityType`/`height`；
 * 同一档位会同时下发 avc / hevc 两条，必须归并并优先浏览器兼容的 avc。
 * 只有一档时不输出下拉（buildQualityList 统一收口）。
 */
describe("kuaishou manifest 档位表", () => {
  const rep = (height, codec, url, extra = "") =>
    `{"qualityType":"${height}p","height":${height},"width":${Math.round((height * 16) / 9)},` +
    `"videoCodec":"${codec}","maxBitrate":${codec === "hevc" ? 1500 : 1200},` +
    `"url":"${url}",${extra ? `${extra},` : ""}"quality":1.5}`;
  const FIXED = "https://txmov2.a.kwimgs.com/upic";

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VITEST = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("多档：按高度降序、同档去重取 avc、跳过 hidden，主直链跟最高档", async () => {
    const reps = [
      rep(720, "hevc", `${FIXED}/hevc720.mp4`),
      rep(720, "avc", `${FIXED}/avc720.mp4`),
      rep(1080, "avc", `${FIXED}/avc1080.mp4`),
      rep(2160, "hevc", `${FIXED}/hidden2160.mp4`, '"hidden":true'),
    ].join(",");
    const page =
      `<html><body><script>window.INIT_STATE = {"detail":{"photoId":"3xq1","caption":"档位",` +
      `"userName":"作者","mainMvUrls":[{"url":"${FIXED}/default.mp4"}],` +
      `"manifest":{"adaptationSet":[{"representation":[${reps}]}]}}};</script></body></html>`;
    stubNet(null, { "chenzhongtech.com/fw/photo/3xq1": page });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3xq1");

    expect(res.code).toBe(200);
    expect(res.data.qualities).toEqual([
      { quality: 1080, label: "1080p", url: `${FIXED}/avc1080.mp4` },
      { quality: 720, label: "720p", url: `${FIXED}/avc720.mp4` },
    ]);
    // mainMvUrls 只是默认档；manifest 有多档时主直链跟最高档
    expect(res.data.photoUrl).toBe(`${FIXED}/avc1080.mp4`);
  });

  it("只有一档：不出 qualities，主直链维持 mainMvUrls", async () => {
    const reps = rep(720, "avc", `${FIXED}/only720.mp4`);
    const page =
      `<html><body><script>window.INIT_STATE = {"detail":{"photoId":"3xq2","caption":"单档",` +
      `"userName":"作者","mainMvUrls":[{"url":"${FIXED}/default.mp4"}],` +
      `"manifest":{"adaptationSet":[{"representation":[${reps}]}]}}};</script></body></html>`;
    stubNet(null, { "chenzhongtech.com/fw/photo/3xq2": page });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3xq2");

    expect(res.code).toBe(200);
    expect("qualities" in res.data).toBe(false);
    expect(res.data.photoUrl).toBe(`${FIXED}/default.mp4`);
  });
});

/**
 * 快手作者字段口径。
 *
 * 匿名分享页只有一层：`photo` 给昵称/头像/作者ID/userEid；`counts` 是混合对象——
 * `fanCount/followCount/photoCount` 跟作者走（粉丝/关注/作品），`collectionCount`
 * 跟**作品**走（收藏数，实测与带签名接口 `/rest/v/feed/hot` 的作品级 `collectCount`
 * 同值），快手号只出现在 `soundTrack.user`（那是「原声」所有者，二创用他人原声时是别人）；
 * 简介与获赞一律要登录态（REST、graphql、H5 镜像、桌面 profile 页四条通道实测游客全部拿不到）。
 * 这里锁住四件事：同人才取快手号、主页链接由 userEid 拼、配了 KUAISHOU_COOKIE 才走桌面
 * profile 页补全（cookie 只发第一方，不发镜像）、补全失败或资料不认这个作者时整体降级不串号。
 */
describe("kuaishou 作者字段：快手号 / 主页链接 / 登录态补全", () => {
  const EID = "3xr5umz6xc7ggtu";
  const AUTHOR_EXTRA =
    `,"userEid":"${EID}","soundTrack":{"user":{"user_id":"3442571839","kwaiId":"Q-3827799414"}}`;
  /** 匿名分享页给的粉丝/关注/作品（作者级）与收藏数（作品级），挂在 photo 的父层 */
  const ANON_COUNTS =
    ',"counts":{"fanCount":32771,"followCount":488,"photoCount":28,"collectionCount":45121}';

  /**
   * 桌面 profile 页的 SSR 预取：INIT_STATE 里 `/rest/v/profile/user` 缓存项，键名逐字母 +1
   * 混淆且顺序不稳定（生产按形状深搜），首项放个无关的 startup 对象干扰。
   */
  function profilePage(userProfileObj) {
    return (
      `<html><body><script>window.INIT_STATE = ` +
      `{"tusjoh.0sftu0w0tztufn0tubsuvq-pckfdu.":{"result":1,"loginTitleConfig":{"DEFAULT":"登录后看更多喜欢的视频"}},` +
      `"tusjoh.0sftu0w0qspgjmf0vtfs-pckfdu.":${JSON.stringify(userProfileObj)}};</script></body></html>`
    );
  }

  const PROFILE_OK = {
    result: 1,
    userProfile: {
      profile: {
        user_id: EID,
        user_name: "“首发凯里”",
        user_text: "  二创素材来源网络\n感谢快手官方支持  ",
        headurl: "http://p4.a.yximgs.com/uhead/AB/x_s.jpg",
      },
      // like 是获赞总数（graphql 的 ownerCount 没有这一项）；photo_public 才是作品数
      ownerCount: { fan: 32775, like: 1244796, follow: 490, photo_public: 29 },
      userDefineId: "Q-3827799414",
      gender: "M",
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VITEST = "true";
    delete process.env.KUAISHOU_COOKIE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.KUAISHOU_COOKIE;
  });

  it("原声作者即视频作者：取到快手号，并按 userEid 拼主页链接", async () => {
    stubNet(null, { "chenzhongtech.com/fw/photo/3x8a": H5_PAGE("3x8a", AUTHOR_EXTRA) });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3x8a");

    expect(res.code).toBe(200);
    expect(res.data.uid).toBe("Q-3827799414");
    expect(res.data.authorUrl).toBe(`https://www.kuaishou.com/profile/${EID}`);
  });

  it("二创用他人原声：快手号不串到视频作者身上", async () => {
    const otherSound =
      `,"userEid":"${EID}","soundTrack":{"user":{"user_id":"9999999999","kwaiId":"OTHER_1"}}`;
    stubNet(null, { "chenzhongtech.com/fw/photo/3x8b": H5_PAGE("3x8b", otherSound) });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3x8b");

    expect(res.code).toBe(200);
    expect(res.data.authorName).toBe("H5 作者");
    expect("uid" in res.data).toBe(false);
    expect(res.data.authorUrl).toContain(EID);
  });

  it("页面没有 userEid：不拼主页链接，配了 cookie 也无从补全", async () => {
    process.env.KUAISHOU_COOKIE = "passToken=abc";
    const calls = stubNet(null, { "chenzhongtech.com/fw/photo/3x8c": H5_PAGE("3x8c") });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3x8c");

    expect(res.code).toBe(200);
    expect("authorUrl" in res.data).toBe(false);
    expect(calls.some((u) => u.includes("/profile/"))).toBe(false);
    expect("authorSign" in res.data).toBe(false);
  });

  it("未配置 KUAISHOU_COOKIE：不向作者主页发任何请求", async () => {
    const calls = stubNet(null, {
      "chenzhongtech.com/fw/photo/3x8d": H5_PAGE("3x8d", AUTHOR_EXTRA, ANON_COUNTS),
    });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3x8d");

    expect(res.code).toBe(200);
    expect(calls.some((u) => u.includes("/profile/"))).toBe(false);
    expect("authorSign" in res.data).toBe(false);
    expect("totalFavorited" in res.data).toBe(false);
    // 匿名粉丝数照旧透出，登录态缺失不影响它
    expect(res.data.followerCount).toBe(32771);
    // 作品收藏数同样匿名可得（与粉丝同一个 counts 对象，但跟作品走）
    expect(res.data.collectionCount).toBe(45121);
  });

  it("手机端短链 + KUAISHOU_COOKIE：跟随重定向取到视频后，用 cookie 补全简介与获赞", async () => {
    process.env.KUAISHOU_COOKIE = "kpf=PC_WEB; userId=129523614; kwssectoken=xyz";
    const calls = stubNet("https://chenzhongtech.com/fw/photo/3x8e", {
      "chenzhongtech.com/fw/photo/3x8e": H5_PAGE("3x8e", AUTHOR_EXTRA, ANON_COUNTS),
      "www.kuaishou.com/profile/3xr5umz6xc7ggtu": profilePage(PROFILE_OK),
    });

    const res = await kuaishouCore.parseKuaishou("https://v.kuaishou.com/KkJ8pQ");

    expect(res.code).toBe(200);
    expect(res.data.photoUrl).toContain("3x8e.mp4");
    const [profileUrl, profileInit] = global.fetch.mock.calls.find(([u]) =>
      u.includes("/profile/")
    );
    expect(profileUrl).toBe(`https://www.kuaishou.com/profile/${EID}`);
    expect(profileInit.headers.Cookie).toBe(process.env.KUAISHOU_COOKIE);
    // cookie 只发第一方：取数镜像与第三方兜底一律不带
    expect(
      calls
        .filter((u) => !u.includes("www.kuaishou.com"))
        .every((u) => !/profile/.test(u))
    ).toBe(true);
    expect(res.data).toMatchObject({
      authorSign: "二创素材来源网络\n感谢快手官方支持",
      totalFavorited: 1244796,
      // 主页数字比分享页缓存新，以主页为准
      followerCount: 32775,
      followingCount: 490,
      worksCount: 29,
      // 收藏数是作品级的，主页补全不覆盖它
      collectionCount: 45121,
      uid: "Q-3827799414",
    });
    // 归一化出口：简介落到契约字段 sign，获赞落到 totalFavorited
    const unified = normalizeResult(res).data;
    expect(unified.sign).toBe("二创素材来源网络\n感谢快手官方支持");
    expect(unified.totalFavorited).toBe(1244796);
  });

  it("cookie 失效（profile 页回未登录空壳）：降级为匿名结果，视频字段不动", async () => {
    process.env.KUAISHOU_COOKIE = "kwssectoken=expired";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    stubNet("https://www.kuaishou.com/short-video/3x8f?cc=share_wxms&shareToken=X95cvQeFt6BxX20", {
      "chenzhongtech.com/fw/photo/3x8f": H5_PAGE("3x8f", AUTHOR_EXTRA, ANON_COUNTS),
      // 游客态实测形状：页面照旧 200，但 INIT_STATE 里没有 profile/user 缓存项
      "www.kuaishou.com/profile/3xr5umz6xc7ggtu":
        '<html><script>window.INIT_STATE = {"tusjoh.0sftu0w0tztufn0tubsuvq-pckfdu.":{"result":1}};</script></html>',
    });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/f/X95cvQeFt6BxX20");

    expect(res.code).toBe(200);
    expect(res.data.photoUrl).toContain("3x8f.mp4");
    expect(res.data.uid).toBe("Q-3827799414");
    expect(res.data.followerCount).toBe(32771);
    expect("authorSign" in res.data).toBe(false);
    expect("totalFavorited" in res.data).toBe(false);
    expect(warn.mock.calls.join(" | ")).toContain("KUAISHOU_COOKIE");
  });

  it("profile 页里预取的不是这位作者的资料：整体不合并（防串号）", async () => {
    process.env.KUAISHOU_COOKIE = "kwssectoken=xyz";
    const someoneElse = JSON.parse(JSON.stringify(PROFILE_OK));
    someoneElse.userProfile.profile.user_id = "3xotheridotherid";
    someoneElse.userProfile.userDefineId = "OTHER_9";
    someoneElse.userProfile.ownerCount = { fan: 1, like: 2, follow: 3, photo_public: 4 };
    stubNet(null, {
      "chenzhongtech.com/fw/photo/3x8g": H5_PAGE("3x8g", AUTHOR_EXTRA, ANON_COUNTS),
      "www.kuaishou.com/profile/3xr5umz6xc7ggtu": profilePage(someoneElse),
    });

    const res = await kuaishouCore.parseKuaishou("https://www.kuaishou.com/photo/3x8g");

    expect(res.code).toBe(200);
    expect("authorSign" in res.data).toBe(false);
    expect("totalFavorited" in res.data).toBe(false);
    expect(res.data.uid).toBe("Q-3827799414");
    expect(res.data.followerCount).toBe(32771);
  });
});

/**
 * 内核提取分支的字段口径（不走 route，直接喂页面给 parseKuaishou）。
 *
 * json-fragment 这条分支此前用 `...data` 整包散播正则碎片：同一条直链会同时落成
 * `url` / `src` / `playUrl` 多个别名（出口验链置空 `url` 后被归一化别名兜底复活成
 * 「可用」坏链），上游当作者名用的 `name` 还会串进统一标题。这里锁死收口后的形状。
 */
describe("kuaishou 内核 json-fragment 分支：只带白名单字段", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    process.env.VITEST = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 落到 extractFromJsonFragments 的条件很窄：`"playUrl":null` 让 inline-json /
  // regex-fallback 的字面量正则（要求冒号后紧跟字符串）全部落空，URL 无扩展名且只含
  // media（broad-search 四条模式都不认）却过得了 isValidVideoUrl 的指示词表。
  it("碎片字段收口：url 别名不散播、name 不串进标题", async () => {
    const page = `<html><body><script>var frag = {"playUrl":null,"src":"https://v1.kwaicdn.com/media/abc","name":"作者名","caption":"真标题","cover":"https://p1.kwaicdn.com/c.jpg","duration":8000};</script></body></html>`;
    global.fetch.mockImplementation(async () => new Response(page, { status: 200 }));

    const res = await kuaishouCore.parseKuaishou(
      "https://www.kuaishou.com/short-video/FRAGMENT1"
    );

    expect(res.code).toBe(200);
    expect(res.data).toMatchObject({
      photoUrl: "https://v1.kwaicdn.com/media/abc",
      source: "json-fragment",
      caption: "真标题",
      authorName: "作者名",
      coverUrl: "https://p1.kwaicdn.com/c.jpg",
      duration: 8000,
    });
    for (const key of ["url", "src", "playUrl", "videoUrl", "mp4Url", "name"]) {
      expect(key in res.data, `碎片别名 ${key} 不应出现在出口字段里`).toBe(false);
    }

    // 归一化后：标题是 caption，不是上游作者名；url 取自 photoUrl 且只有一个来源
    const unified = normalizeResult(res).data;
    expect(unified.title).toBe("真标题");
    expect(unified.author).toBe("作者名");
    expect(unified.url).toBe("https://v1.kwaicdn.com/media/abc");
  });
});

/**
 * 统一入口的图片出参（首页实际调的就是 /api/parse）。
 *
 * 背景：/api/parse 对快手走内核纯函数（platformParsers 优先于 platformRoutes），
 * 曾经因此绕过了 /api/kuaishou 那层的图片代理改写——首页拿到的是裸 CDN 直链，
 * 既没有 `&fallback=` 多节点重试，也把访问者 IP 直接暴露给第三方图床。
 * 现在改写挂在 unified-parser 出口，锁四件事：封面/头像都成代理串、统一字段
 * cover/avatar 与原始键同值、内部备选键不外泄、视频直链照旧不代理。
 */
describe("kuaishou 经 /api/parse：图片同样走站内代理", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.VITEST = "true";
    delete process.env.KUAISHOU_COOKIE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("H5 主解析成功：封面/头像成代理串并带 CDN 备选，视频直链不代理", async () => {
    // 唯一链接：createApiHandler 有进程内缓存，不能与其它用例复用
    stubNet(null, { "chenzhongtech.com/fw/photo/3xup1": H5_PAGE("3xup1") });

    const res = await PARSE_GET(
      new Request(
        "http://127.0.0.1/api/parse?url=" +
          encodeURIComponent("https://www.kuaishou.com/short-video/3xup1"),
        { headers: { "x-forwarded-for": "203.0.113.42" } }
      )
    );
    const json = await res.json();

    expect(json.code).toBe(200);
    expect(json.platform).toBe("kuaishou");

    expect(json.data.coverUrl).toContain("/api/image?url=");
    expect(json.data.coverUrl).toContain(
      encodeURIComponent("https://p4.a.yximgs.com/upic/3xup1.jpg")
    );
    expect(json.data.coverUrl).toContain("&fallback=");
    expect(json.data.coverUrl.split("&fallback=")[1]).toContain(
      encodeURIComponent("https://p23.a.yximgs.com/upic/3xup1.jpg")
    );
    expect(json.data.authorAvatar).toContain("/api/image?url=");
    // 头像必须保留 _s 变体（uhead 其它变体实测 404）
    expect(json.data.authorAvatar).toContain("_s.jpg");

    // 归一化后的统一字段继承改写值（中间件在 unified-parser 之后跑）
    expect(json.data.cover).toBe(json.data.coverUrl);
    expect(json.data.avatar).toBe(json.data.authorAvatar);

    // 内部备选键不下发
    expect("coverUrlFallbacks" in json.data).toBe(false);
    expect("authorAvatarFallbacks" in json.data).toBe(false);

    // 视频直链不代理（避免拖慢播放）
    expect(json.data.photoUrl).toBe("https://txmov2.a.kwimgs.com/upic/3xup1.mp4");
  });
});
