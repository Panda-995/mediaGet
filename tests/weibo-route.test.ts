// @ts-nocheck
/**
 * 微博出口链路守卫（weiboCore.js 的 weiboParse）。
 *
 * 链路（2026-10-18 实测）：访客 Cookie 两段式 → fid 先经 component 换 mid →
 * 桌面作品接口 ajax/statuses/show（主通道）→ 桌面作者接口 ajax/profile/info →
 * 手机 m.weibo.cn 降级 → component 降级。
 *
 * 守的是实测出来的坑：
 *  - 1080p 只在 media_info.playback_list，平铺字段（mp4_hd_url 等）全是 720p；
 *  - playback_list 混有 type=3 的 scrubber_hd 预览图，不能当视频；
 *  - media_info.author_name 是素材作者（实测一条央视新闻投稿 ≠ 博文作者）；
 *  - 图集档位名与体积无关，largest 最大、original 反而小；
 *  - 作者接口失败态是 HTTP 200 + 业务错误体，且粉丝数是精确整数
 *    （手机通道同字段是四舍五入串 "123.4万"）；
 *  - 新浪图床的 ?ssig= 签名进出口就是死链。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/weibo/route.js";
import { normalizeResult } from "@/lib/normalize-result";

const MID = "5355396699260433"; // url2mid("Rnf7vCR3P")
const FID = "1034:5355396530110472";
const UID = "2656274875";

/** 每个用例用不同 tag：出口有 5 分钟进程内成功缓存，同 URL 会命中上一条结果 */
function makeRequest(tag, path = `https://weibo.com/${UID}/Rnf7vCR3P`) {
  return new Request(
    `http://127.0.0.1/api/weibo?url=${encodeURIComponent(`${path}?tag=${tag}`)}`,
    { headers: { "x-forwarded-for": "203.0.113.42" } }
  );
}

const jsonResp = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const textResp = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
  text: async () => body,
});

const U1080 = "https://f.video.weibocdn.com/o0/AAA1080.mp4?label=mp4_1080p";
const U720 = "https://f.video.weibocdn.com/o0/BBB720.mp4?label=mp4_720p";

/**
 * 桌面作品接口（ajax/statuses/show）的视频帖：响应顶层即状态对象，无 data 包装。
 * playback_list 按实测顺序放 1080/720/480 + 末位 scrubber_hd（type=3 指向 jpg）。
 * scrubber 故意挂最高 quality_index：只按档位排序、漏掉 type 过滤时它就会抢下视频直链。
 */
function desktopVideo(over = {}) {
  return {
    created_at: "Wed Oct 15 20:30:00 +0800 2026",
    id: Number(MID),
    idstr: MID,
    mid: MID,
    mblogid: "Rnf7vCR3P",
    text: '<a href="#x">正文</a>带标签的文案',
    region_name: "发布于 北京",
    attitudes_count: "14,370",
    comments_count: "1,420",
    reposts_count: 2649,
    pic_ids: [],
    pic_num: 0,
    user: {
      id: Number(UID),
      idstr: UID,
      screen_name: "半岛hooker",
      avatar_hd:
        "https://tva4.sinaimg.cn/crop.0.0.751.751.1020/abc.jpg?KID=imgbed,tva&Expires=1&ssig=SIGN",
      status_total_counter: { like_cnt: "35,091,109", total_cnt: "40,479,439" },
    },
    page_info: {
      type: 11,
      content1: "视频标题",
      page_pic: "https://wx1.sinaimg.cn/orj480/cover.jpg?KID=imgbed&ssig=SIGN",
      media_info: {
        duration: 13,
        author_name: "央视新闻", // 素材作者，禁止覆盖博文作者
        mp4_hd_url: U720,
        stream_url_hd: U720,
        mp4_720p_mp4: U720,
        playback_list: [
          {
            meta: { label: "mp4_1080p", quality_index: 1080, quality_desc: "高清", quality_label: "1080p", type: 1, is_hidden: false },
            play_info: { url: U1080 },
          },
          {
            meta: { label: "mp4_720p", quality_index: 720, quality_desc: "高清", quality_label: "720p", type: 1, is_hidden: false },
            play_info: { url: U720 },
          },
          {
            meta: { label: "mp4_hd", quality_index: 480, quality_desc: "标清", quality_label: "480p", type: 1, is_hidden: false },
            play_info: { url: "https://f.video.weibocdn.com/o0/CCC480.mp4" },
          },
          { meta: { label: "scrubber_hd", type: 3, quality_index: 2160 }, play_info: { url: "https://wx4.sinaimg.cn/large/scrub.jpg" } },
        ],
      },
    },
    ...over,
  };
}

/** 桌面作者接口（ajax/profile/info）：data.user 形态，失败态见 stubWeiboNet 的 profile 参数 */
function desktopProfile(over = {}) {
  return {
    data: {
      user: {
        idstr: UID,
        screen_name: "半岛hooker",
        description: "博主简介",
        friends_count: 12,
        followers_count: 1298045, // 精确整数：手机通道同字段是 "129.8万"
        statuses_count: "5,678",
        verified_reason: "音乐博主",
        avatar_hd: "https://tva4.sinaimg.cn/crop.0.0.751.751.1020/abc.jpg?ssig=SIGN",
        status_total_counter: { like_cnt: "35,091,109" },
      },
    },
    ...over,
  };
}

/** 手机通道（m.weibo.cn/statuses/show）：封顶 720p，粉丝是四舍五入串 */
const MOBILE_VIDEO = {
  ok: 1,
  data: {
    id: Number(MID),
    mid: MID,
    bid: "Rnf7vCR3P",
    created_at: "Wed Oct 15 20:30:00 +0800 2026",
    text: "<p>正文</p>",
    attitudes_count: 731,
    comments_count: 51,
    reposts_count: 16,
    user: {
      id: Number(UID),
      idstr: UID,
      screen_name: "半岛hooker",
      profile_image_url: "//tva1.sinaimg.cn/crop.0.0.180.180.180/avatar.jpg",
      description: "博主简介",
      follow_count: 12,
      followers_count: "123.4万",
    },
    page_info: {
      type: 11,
      page_pic: { url: "https://wx1.sinaimg.cn/orj480/cover.jpg", width: 480, height: 852 },
      media_info: { duration: 13, mp4_hd_url: U720, stream_url_hd: U720 },
    },
  },
};

/** 官方 tv/api/component：唯一能把 fid（1034:xxx）映射到真实 mid 的公开接口 */
const COMPONENT_VIDEO = {
  data: {
    Component_Play_Playinfo: {
      title: "视频标题",
      cover_image: "https://wx1.sinaimg.cn/mw690/cover999.jpg",
      author: "半岛hooker",
      avatar: "//tva1.sinaimg.cn/crop.0.0.180.180.180/avatar.jpg",
      real_date: "1760774400",
      mid: MID,
      urls: { "高清 720P": U720, "标清 480P": "https://f.video.weibocdn.com/480.mp4" },
    },
  },
};

/**
 * 打桩微博六条链路（访客两段式 + component + 手机 + 桌面作品 + 桌面作者）。
 * show / profile 传 null 即该腿按无 Cookie 的实测形态失败：
 *  作品接口 403 {"error":"Forbidden"}，作者接口 403。
 * profile 传函数可自定义业务错误体（HTTP 200）。
 */
function stubWeiboNet({ show, profile, mobile = MOBILE_VIDEO, component = COMPONENT_VIDEO } = {}) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("genvisitor"))
        return textResp('gen_callback({"retcode":20000000,"data":{"tid":"tid-abc"}})');
      if (u.includes("a=incarnate"))
        return textResp('cross_domain({"retcode":20000000,"data":{"sub":"SUB-V","subp":"SUBP-V"}})');
      if (u.includes("tv/api/component")) return jsonResp(component || {});
      if (u.includes("ajax/profile/info"))
        return profile === null ? jsonResp({ error: "Forbidden" }, 403) : jsonResp(profile);
      if (u.includes("ajax/statuses/show"))
        return show ? jsonResp(show) : jsonResp({ error: "Forbidden" }, 403);
      if (u.includes("m.weibo.cn/statuses/show"))
        return mobile ? jsonResp(mobile) : jsonResp({ ok: 0 }, 500);
      return jsonResp({}, 500);
    })
  );
  return calls;
}

const get = async (tag, path) => await (await GET(makeRequest(tag, path))).json();

/** 还原站内图片代理里的原图 URL（代理前缀 + encodeURIComponent 两层包装） */
function unproxify(u) {
  const raw = String(u || "");
  return decodeURIComponent(
    raw.startsWith("/api/image?url=") ? raw.slice("/api/image?url=".length) : raw
  );
}

describe("微博：桌面双接口主通道 + 手机降级", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 用例之间必须各自重新打桩：stubGlobal 不受 restoreAllMocks 影响，
    // 否则上一条用例的桌面链路会漏到下一条，让「桌面不可用」的用例假通过
    vi.unstubAllGlobals();
    process.env.VITEST = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("主通道作品字段：取 playback_list 最高档而非平铺 720p", async () => {
    const calls = stubWeiboNet({ show: desktopVideo(), profile: desktopProfile() });

    const json = await get("show-primary");

    expect(json.code).toBe(200);
    expect(json.data.type).toBe("video");
    // 1080p 只存在于 playback_list；只读 media_info 平铺字段会拿到 720p
    expect(json.data.url).toBe(U1080);
    expect(json.data.qualityLabel).toBe("1080p");
    // 契约口径 duration 毫秒（桌面 media_info.duration 是秒）
    expect(json.data.duration).toBe(13000);
    // 单P 不下发 videos，多P 才逐条列出
    expect(json.data.videos).toBeUndefined();
    // playback_list 全档位透出：按档位降序，type=3 的 scrubber 不能混进下拉
    expect(json.data.qualities).toEqual([
      { quality: 1080, label: "1080p", url: U1080 },
      { quality: 720, label: "720p", url: U720 },
      { quality: 480, label: "480p", url: "https://f.video.weibocdn.com/o0/CCC480.mp4" },
    ]);
    // scrubber_hd 是 type=3 的进度条预览图，不能被当成第二P
    expect(json.data.cover).toContain("cover.jpg");
    expect(json.data.cover).not.toContain("scrub");
    // HTML 标签剥掉；千分位串收成数字
    expect(json.data.desc).toBe("正文带标签的文案");
    expect(json.data.like).toBe(14370);
    expect(json.data.reply).toBe(1420);
    expect(json.data.share).toBe(2649);
    // 「发布于 北京」只留属地
    expect(json.data.ipRegion).toBe("北京");
    // media_info.author_name 是素材作者，不能覆盖博文作者
    expect(json.data.author).toBe("半岛hooker");
    // 签名参数进出口就是死链
    expect(json.data.avatar).toMatch(/^\/api\/image\?url=/);
    expect(unproxify(json.data.avatar)).not.toContain("ssig=");
    // 主通道成功不该再碰手机通道
    expect(calls.some((u) => u.includes("m.weibo.cn/statuses/show"))).toBe(false);
  });

  it("作者接口补全作者卡：精确粉丝覆盖 + 认证说明，出口归一化不丢键", async () => {
    stubWeiboNet({ show: desktopVideo(), profile: desktopProfile() });

    const json = await get("author-profile");
    const out = normalizeResult(json).data;

    expect(json.data.sign).toBe("博主简介");
    expect(json.data.followingCount).toBe(12);
    // 手机通道的 "123.4万" 会收成假精确 1234000，作者接口的 1298045 才是真值
    expect(json.data.followerCount).toBe(1298045);
    expect(json.data.statusesCount).toBe(5678);
    expect(json.data.verifiedReason).toBe("音乐博主");
    // 获赞取 like_cnt，不是 total_cnt（那是赞+评论+转发的互动总数）
    expect(json.data.totalFavorited).toBe(35091109);
    // 归一化出口：新增字段是白名单外会被丢的最大风险
    expect(out.ipRegion).toBe("北京");
    expect(out.verifiedReason).toBe("音乐博主");
    expect(out.statusesCount).toBe(5678);
    expect(out.qualityLabel).toBe("1080p");
    expect(out.duration).toBe(13000);
  });

  it("作者接口不可用：用手机内嵌 user 回补三项，其余作者字段按无源删键", async () => {
    const calls = stubWeiboNet({
      show: desktopVideo(),
      profile: { data: { user: {}, message: "用户不存在", abnormal: true, ok: 1 } },
    });

    const json = await get("author-fill");

    expect(json.code).toBe(200);
    expect(json.data.url).toBe(U1080); // 作品数据仍以桌面主通道为准
    expect(json.data.sign).toBe("博主简介");
    expect(json.data.followerCount).toBe(1234000); // "123.4万" 降级值
    expect(calls.some((u) => u.includes("m.weibo.cn/statuses/show"))).toBe(true);
    // 获赞来自作品接口内嵌的 user，作者接口挂了也照收
    expect(json.data.totalFavorited).toBe(35091109);
    // 只有作者接口才有的两项，不能凭空造
    for (const key of ["verifiedReason", "statusesCount"])
      expect(key in json.data).toBe(false);
  });

  it("作者卡片与博文作者不同人：整体不合并，避免串他人统计", async () => {
    const other = desktopProfile();
    other.data.user.idstr = "9999999999";
    stubWeiboNet({ show: desktopVideo(), profile: other });

    const json = await get("author-other-person");

    expect(json.data.authorId).toBe(UID);
    expect(json.data.verifiedReason).toBeUndefined();
    // 手机回补只认同 uid 的卡片
    expect(json.data.followerCount).toBe(1234000);
  });

  it("桌面作品接口不可用：降级手机通道，无清晰度文案故不写 qualityLabel", async () => {
    const calls = stubWeiboNet({ show: null, profile: desktopProfile() });

    const json = await get("desktop-down");

    expect(json.code).toBe(200);
    expect(json.data.url).toBe(U720);
    expect(json.data.duration).toBe(13000);
    expect("qualityLabel" in json.data).toBe(false);
    expect("ipRegion" in json.data).toBe(false); // 手机通道没有 IP 属地
    expect(json.data.cover).toContain("/api/image?url=");
    // page_pic 手机是 {url} 对象、桌面是裸字符串，两种形态都要吃
    expect(unproxify(json.data.cover)).toContain("/orj480/cover.jpg");
    // 作者接口仍独立补全
    expect(json.data.followerCount).toBe(1298045);
    expect(calls.some((u) => u.includes("ajax/statuses/show"))).toBe(true);
  });

  it("图集帖：按 pic_ids 保序取 largest 档，livephoto 静态图不重复入图集", async () => {
    const pic = (id, tier) => ({
      largest: { url: `https://wx1.sinaimg.cn/large/${id}.jpg?KID=x&ssig=S` },
      mw2000: { url: `https://wx1.sinaimg.cn/mw2000/${id}.jpg` },
      original: { url: `https://wx1.sinaimg.cn/orj1080/${id}.jpg` },
      type: "pic16",
      ...tier,
    });
    const show = desktopVideo({
      page_info: undefined,
      pic_num: 3,
      pic_ids: ["pA", "pLive", "pC"],
      pic_infos: {
        pA: pic("pA"),
        pLive: pic("pLive", { video: "https://video.weibo.com/show?livephoto=xxx.mp4" }),
        pC: pic("pC"),
      },
    });
    stubWeiboNet({ show, profile: desktopProfile() });

    const json = await get("gallery");

    expect(json.data.type).toBe("video"); // livephoto 有动态直链
    expect(json.data.url).toBe("https://video.weibo.com/show?livephoto=xxx.mp4");
    expect(json.data.images).toHaveLength(2);
    // 顺序跟 pic_ids，且拿的是 largest(/large/) 而不是 mw2000
    expect(unproxify(json.data.images[0])).toBe("https://wx1.sinaimg.cn/large/pA.jpg");
    expect(unproxify(json.data.images[1])).toBe("https://wx1.sinaimg.cn/large/pC.jpg");
    // livephoto 的静态帧已作封面，不能再进图集
    expect(json.data.images.join()).not.toContain("pLive");
    expect(unproxify(json.data.cover)).toBe("https://wx1.sinaimg.cn/large/pLive.jpg");
  });

  it("混排帖：视频在 mix_media_info.items，不能被当成纯图集丢掉", async () => {
    // 实测形态（mid 5355394283342657）：顶层无 page_info / pics / pic_infos，
    // pic_ids 只列图片项，视频与图片都在 mix_media_info.items 里
    const pic = (id) => ({
      largest: { url: `https://wx1.sinaimg.cn/large/${id}.jpg` },
      mw2000: { url: `https://wx1.sinaimg.cn/mw2000/${id}.jpg` },
    });
    const show = desktopVideo({
      page_info: undefined,
      pic_num: 3,
      pic_ids: ["pA", "pB"],
      pic_infos: {},
      mix_media_info: {
        items: [
          {
            type: "video",
            id: "1034:123",
            data: {
              content1: "混排视频",
              page_pic: "https://wx1.sinaimg.cn/orj480/mix-cover.jpg",
              media_info: {
                duration: 9,
                playback_list: [
                  { meta: { label: "mp4_1080p", quality_index: 1080, quality_label: "1080p", type: 1 }, play_info: { url: U1080 } },
                  { meta: { label: "mp4_720p", quality_index: 720, quality_label: "720p", type: 1 }, play_info: { url: U720 } },
                ],
              },
            },
          },
          { type: "pic", id: "pA", data: pic("pA") },
          { type: "pic", id: "pB", data: pic("pB") },
        ],
      },
    });
    stubWeiboNet({ show, profile: desktopProfile() });

    const json = await get("mixed");

    expect(json.code).toBe(200);
    expect(json.data.type).toBe("video");
    expect(json.data.url).toBe(U1080);
    expect(json.data.qualityLabel).toBe("1080p");
    expect(json.data.duration).toBe(9000);
    // 混排分支的视频项同样带全档位表
    expect(json.data.qualities?.map((q) => q.label)).toEqual(["1080p", "720p"]);
    expect(unproxify(json.data.cover)).toContain("/orj480/mix-cover.jpg");
    // 视频照常是主媒体，图片作为图集并存，且按 items 顺序取 largest 档
    expect(json.data.images).toHaveLength(2);
    expect(unproxify(json.data.images[0])).toBe("https://wx1.sinaimg.cn/large/pA.jpg");
    expect(unproxify(json.data.images[1])).toBe("https://wx1.sinaimg.cn/large/pB.jpg");
  });

  it("多P：逐P下发档位与时长，顶层不写「整体清晰度」", async () => {
    const part = (n, tiers) => ({
      type: 11,
      content1: `P${n} 标题`,
      page_pic: `https://wx1.sinaimg.cn/orj480/c${n}.jpg`,
      media_info: {
        duration: 10 + n,
        playback_list: tiers.map(([label, url]) => ({
          meta: { label, quality_label: label, quality_index: parseInt(label), type: 1 },
          play_info: { url },
        })),
      },
    });
    const show = desktopVideo({
      page_info: [
        part(1, [["1080p", U1080], ["720p", U720]]),
        part(2, [["720p", "https://f.video.weibocdn.com/o0/DDD720.mp4"]]),
      ],
    });
    stubWeiboNet({ show, profile: desktopProfile() });

    const json = await get("multi-part");

    expect(json.data.videos).toHaveLength(2);
    expect(json.data.videos.map((v) => v.qualityLabel)).toEqual(["1080p", "720p"]);
    expect(json.data.videos[1].url).toBe("https://f.video.weibocdn.com/o0/DDD720.mp4");
    expect(json.data.videos.map((v) => v.duration)).toEqual([11000, 12000]);
    // 档位表跟着每一 P 走：P1 两档，P2 只有一档时不造下拉
    expect(json.data.videos[0].qualities.map((q) => q.label)).toEqual(["1080p", "720p"]);
    expect("qualities" in json.data.videos[1]).toBe(false);
    // P2 只有 720p：顶层写「1080p」会误导成整条微博的档位
    expect("qualityLabel" in json.data).toBe(false);
    expect("qualities" in json.data).toBe(false);
    expect("duration" in json.data).toBe(false);
  });

  it("fid 形态：先经 component 换成真实 mid 再打桌面接口", async () => {
    const calls = stubWeiboNet({ show: desktopVideo(), profile: desktopProfile() });

    const json = await get("fid", `https://weibo.com/tv/show/${FID}`);

    expect(json.code).toBe(200);
    expect(json.data.url).toBe(U1080);
    expect(calls.some((u) => u.includes(`ajax/statuses/show?id=${MID}`))).toBe(true);
    // 桌面接口不认 fid（实测回 400 参数错误），不能拿 1034:xxx 去请求
    expect(calls.some((u) => u.includes("ajax/statuses/show?id=1034"))).toBe(false);
    expect(calls.some((u) => u.includes("m.weibo.cn/statuses/show?id=1034"))).toBe(false);
  });

  it("聚合数与属地缺失：等同无源，删键不造 0 占位", async () => {
    const bare = desktopVideo();
    delete bare.region_name;
    delete bare.user.status_total_counter;
    stubWeiboNet({ show: bare, profile: { data: { user: { idstr: UID, screen_name: "半岛hooker" } } } });

    const json = await get("no-source");

    for (const key of ["ipRegion", "totalFavorited", "verifiedReason", "statusesCount", "sign"])
      expect(key in json.data).toBe(false);
    expect(normalizeResult(json).data.ipRegion).toBeUndefined();
    // 作品主体不受影响
    expect(json.data.url).toBe(U1080);
  });
});
