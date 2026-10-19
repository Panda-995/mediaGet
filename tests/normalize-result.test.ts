// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  normalizeResult,
  UNIFIED_TEXT_FIELDS,
  UNIFIED_NUMBER_FIELDS,
} from "@/lib/normalize-result";

/**
 * 全平台 raw→契约对拍（`@mediaget/parse-core` 下游消费面的验收门）。
 *
 * 每条 fixture 逐字镜像对应解析器**成功分支的真实返回**（源码位置写在 name 里），
 * 覆盖 `packages/parse-core/src/index.ts` 白名单里的全部 13 个公开解析器。
 * 三条判据各有不变式守卫：
 * - **完整性**：`unified` 统一字段落位 + `retain` 原始键仍在 + 非空标量值不丢；
 * - **单位一致**：`duration` 期望值按该平台原始单位写成毫秒（写错就红）；
 * - **消费一致**：契约字段类型合规、无 `""` / null 空占位下发、二次归一幂等。
 *
 * fixture 是手写的，不是从解析器抓的：解析器改字段时本表不会自动变红，
 * 实时守卫是 `tests/simple-platforms.test.ts`、`tests/kuaishou-route.test.ts`
 * 等 mock fetch 用例。本表守的是「出口契约」这一层——它比单个平台更少变动，
 * 却决定下游怎么写取值代码，所以每条都要显式声明 duration 与保留键。
 */
const CONTRACT_CASES = [
  {
    parser: "parseKuaishou",
    name: "快手 INIT_STATE（kuaishouCore.js:311-392）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "kuaishou",
      data: {
        source: "init-state",
        photoId: "3x2abcdefgh",
        photoUrl: "https://v1.kwaicdn.com/ks/1.mp4",
        coverUrl: "https://p1.kwaicdn.com/ks/1.jpg",
        caption: "快手的小猫",
        authorName: "作者甲",
        authorAvatar: "https://p1.kwaicdn.com/ks/face.jpg",
        authorId: "123456789",
        authorSign: "个人简介",
        likeCount: 1024,
        viewCount: 20480,
        commentCount: 33,
        shareCount: 5,
        // 作品收藏数：H5 顶层 counts.collectionCount（跟作品走，不是作者总数）
        collectionCount: 15883,
        // 收不拢的计数写法：原样保留，删掉才是丢数据
        followerCount: "3.1万",
        duration: 15300,
        timestamp: 1700000000000,
      },
    },
    unified: {
      url: "https://v1.kwaicdn.com/ks/1.mp4",
      title: "快手的小猫",
      cover: "https://p1.kwaicdn.com/ks/1.jpg",
      author: "作者甲",
      authorId: "123456789",
      sign: "个人简介",
    },
    duration: 15300,
    retain: [
      "photoUrl",
      "caption",
      "coverUrl",
      "authorName",
      "source",
      "likeCount",
      "collectionCount",
    ],
  },
  {
    parser: "parseKuaishou",
    name: "快手 json-fragment 白名单分支（kuaishouCore.js:852-893）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "kuaishou",
      data: {
        photoUrl: "https://v1.kwaicdn.com/ks/2.mp4",
        source: "json-fragment",
        caption: "片段标题",
        coverUrl: "https://p1.kwaicdn.com/ks/2.jpg",
        authorName: "作者乙",
        duration: 8000,
      },
    },
    unified: {
      url: "https://v1.kwaicdn.com/ks/2.mp4",
      title: "片段标题",
      cover: "https://p1.kwaicdn.com/ks/2.jpg",
      author: "作者乙",
    },
    duration: 8000,
    // 死链复活根因：出口验链置空 `url` 后，碎片里的同值别名会被 FIELD_SOURCES.url 兜底复活
    absent: ["src", "playUrl", "videoUrl", "mp4Url", "name"],
  },
  {
    parser: "douyinParse",
    name: "抖音主路径（douyin-extract.js:160-198 + douyinCore.js:351-367）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "douyin",
      data: {
        author: "抖音用户",
        uid: "MS4wLjABAAAAxxxx",
        sign: "个人主页简介",
        avatar: "https://p3.douyinpic.com/aweme/face.jpg",
        like: 100000,
        time: 1700000000,
        title: "抖音标题",
        cover: "https://p3.douyinpic.com/aweme/cover.jpg",
        type: "video",
        url: "https://v.douyinvod.com/1.mp4",
        duration: 9600,
        audioUrl: "https://sf6-cdn-tos.douyinstatic.com/1.mp3",
        stat: { view: 1, like: 2, reply: 3, favorite: 4, share: 5 },
        music: { author: "抖音用户", title: "抖音标题", avatar: "" },
        awemeId: "7300000000000000000",
        followerCount: 1000,
        followingCount: 50,
        totalFavorited: 20000,
        authorUrl: "https://www.douyin.com/user/MS4wLjABAAAAxxxx",
      },
    },
    unified: {
      url: "https://v.douyinvod.com/1.mp4",
      title: "抖音标题",
      author: "抖音用户",
      authorId: "MS4wLjABAAAAxxxx",
    },
    duration: 9600,
    retain: ["uid", "awemeId", "stat", "music", "audioUrl"],
  },
  {
    parser: "douyinParse",
    name: "抖音公共解析兜底分支（douyinCore.js:265-280，空占位不下发）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "douyin",
      data: {
        author: "",
        uid: "",
        avatar: "",
        like: 0,
        time: 0,
        title: "视频",
        cover: "",
        type: "video",
        url: "https://fb.example.com/1.mp4",
        duration: 0,
      },
    },
    unified: { url: "https://fb.example.com/1.mp4", title: "视频", type: "video" },
    duration: 0,
    absent: ["author", "avatar", "cover"],
  },
  {
    parser: "weiboParse",
    name: "微博视频帖（weiboCore.js:368-409）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "weibo",
      data: {
        title: "微博正文首行",
        desc: "微博完整正文",
        author: "微博用户",
        authorId: "1234567890",
        authorUrl: "https://weibo.com/u/1234567890",
        sign: "微博简介",
        followingCount: 100,
        followerCount: 200000,
        avatar: "https://tv1.sinaimg.cn/avatar.jpg",
        time: "2026-01-02T10:00:00.000Z",
        like: 520,
        reply: 33,
        share: 12,
        cover: "https://wx1.sinaimg.cn/cover.jpg",
        url: "https://f.video.weibocdn.com/1.mp4",
        images: ["https://wx1.sinaimg.cn/1.jpg"],
        type: "video",
      },
    },
    unified: {
      url: "https://f.video.weibocdn.com/1.mp4",
      title: "微博正文首行",
      author: "微博用户",
      authorId: "1234567890",
    },
    retain: ["like", "reply", "share", "images"],
  },
  {
    parser: "xhsParse",
    name: "小红书视频笔记（xhsCore.js:621-659、730-737）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "redbook",
      data: {
        author: "博主",
        authorID: "xhs_red_123",
        authorUrl: "https://www.xiaohongshu.com/user/profile/abc",
        sign: "",
        title: "笔记标题",
        desc: "笔记正文",
        avatar: "https://sns-avatar-qc.xhscdn.com/face.jpg",
        time: 1700000000,
        like: "1.2万",
        favorite: "123",
        reply: 45,
        share: "",
        noteId: "",
        cover: "https://sns-webpic.xhscdn.com/cover.jpg",
        url: "https://sns-video-bd.xhscdn.com/1.mp4",
        type: "video",
      },
    },
    unified: {
      url: "https://sns-video-bd.xhscdn.com/1.mp4",
      title: "笔记标题",
      author: "博主",
      authorId: "xhs_red_123",
    },
    // "1.2万" 收不拢原样保留；"123" 收成 number（见 assertScalarContract）
    retain: ["like", "favorite", "authorID"],
    absent: ["sign", "share", "noteId"],
  },
  {
    parser: "xhsParse",
    name: "小红书图文笔记（xhsCore.js:762-767，无 url 属正常）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "redbook",
      data: {
        author: "博主",
        title: "图文标题",
        desc: "图文正文",
        avatar: "https://sns-avatar-qc.xhscdn.com/face.jpg",
        time: 1700000000,
        like: 12,
        cover: "https://sns-webpic.xhscdn.com/i1.jpg",
        images: ["https://sns-webpic.xhscdn.com/i1.jpg"],
        type: "image",
      },
    },
    unified: {
      title: "图文标题",
      type: "image",
      images: ["https://sns-webpic.xhscdn.com/i1.jpg"],
    },
    retain: ["images"],
  },
  {
    parser: "twitterParse",
    name: "Twitter/X fxTwitter 分支（twitterCore.js:486-512）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "twitter",
      data: {
        title: "推文正文",
        author: "显示名",
        avatar: "https://pbs.twimg.com/face.jpg",
        uid: "handle",
        authorUrl: "https://x.com/handle",
        sign: "作者简介",
        followerCount: 1234,
        followingCount: 56,
        like: 100,
        retweets: 20,
        replies: 5,
        views: 9000,
        cover: "https://pbs.twimg.com/thumb.jpg",
        url: "https://video.twimg.com/1.mp4",
        duration: 65000,
        durationFormat: "01:05",
        type: "video",
        time: 1700000000000,
      },
    },
    unified: {
      url: "https://video.twimg.com/1.mp4",
      title: "推文正文",
      authorId: "handle",
      durationFormat: "01:05",
    },
    duration: 65000,
    retain: ["uid", "retweets", "views"],
  },
  {
    parser: "bilibiliParse",
    name: "B站视频多分P（bilibiliCore.js:390-441，顶层散字段 + data 数组）",
    raw: {
      code: 1,
      msg: "解析成功！",
      platform: "bilibili",
      title: "B站视频",
      imgurl: "https://cover.jpg",
      desc: "简介",
      pubdate: 1700000000,
      duration: 270000,
      tname: "影视剪辑",
      copyright: 1,
      stat: { view: 100, like: 10 },
      user: {
        name: "UP主",
        user_img: "https://avatar.jpg",
        uid: 290526283,
        sign: "UP主简介",
        authorUrl: "https://space.bilibili.com/290526283",
      },
      data: [
        {
          title: "P1",
          duration: 180,
          durationFormat: "00:02:59",
          accept: ["高清 1080P+", "高清 720P"],
          pic: "https://p1.jpg",
          video_url: "https://p1.mp4",
          qualities: [
            { quality: 112, label: "高清 1080P+", url: "https://p1-1080.mp4" },
            { quality: 64, label: "高清 720P", url: "https://p1-720.mp4" },
          ],
        },
        { title: "P2", duration: 90, durationFormat: "00:01:30", accept: [] },
      ],
    },
    unified: {
      title: "B站视频",
      desc: "简介",
      cover: "https://cover.jpg",
      author: "UP主",
      avatar: "https://avatar.jpg",
      tname: "影视剪辑",
      // 顶层 url：统一契约可直接消费，取第一分P直链
      url: "https://p1.mp4",
      stat: { view: 100, like: 10 },
      videos: [
        {
          title: "P1",
          url: "https://p1.mp4",
          // 契约 duration 全平台毫秒：分P 原始是秒（180），归一化时换算
          duration: 180000,
          durationFormat: "00:02:59",
          cover: "https://p1.jpg",
          // 原始键并存：归一化前后按 video_url / pic 取值都拿得到
          video_url: "https://p1.mp4",
          pic: "https://p1.jpg",
          accept: ["高清 1080P+", "高清 720P"],
          qualities: [
            { quality: 112, label: "高清 1080P+", url: "https://p1-1080.mp4" },
            { quality: 64, label: "高清 720P", url: "https://p1-720.mp4" },
          ],
        },
      ],
    },
    // 顶层 270000（解析器已 ×1000）；P2 无 video_url → 被 filter 剔除
    duration: 270000,
    after(out) {
      // 标量收拢：B站 owner.mid 是数字，契约的 authorId 是字符串
      expect(out.data.authorId).toBe("290526283");
      expect(out.data.videos).toHaveLength(1);
      expect(out.data.time).toBe(1700000000);
    },
  },
  {
    parser: "bilibiliParse",
    name: "B站图文动态（bilibili-opus.js:80-99 + bilibiliCore.js:565）",
    raw: {
      code: 200,
      msg: "解析成功！",
      platform: "bilibili",
      data: {
        type: "image",
        title: "动态标题",
        desc: "动态正文",
        cover: "https://i0.hdslb.com/bfs/opus/1.jpg",
        images: ["https://i0.hdslb.com/bfs/opus/1.jpg"],
        author: "UP主",
        authorId: "290526283",
        authorUrl: "https://space.bilibili.com/290526283",
        avatar: "",
        time: 1700000000,
        stat: { like: 10, reply: 2, share: 1 },
        sign: "UP主简介",
        followingCount: 1,
        followerCount: 2,
        totalFavorited: 3,
      },
    },
    unified: { title: "动态标题", author: "UP主", authorId: "290526283", type: "image" },
    absent: ["avatar"],
    retain: ["images", "stat"],
  },
  {
    parser: "acfunParse",
    name: "AcFun（acfunCore.js:48-54，parseOk 的空占位）",
    raw: {
      code: 200,
      msg: "解析成功",
      data: {
        title: "A站标题",
        author: "",
        avatar: "",
        cover: "https://thumb.a.cdn.acfun.cn/1.jpg",
        url: "https://video.a.cdn.acfun.cn/1.m3u8",
      },
    },
    unified: { title: "A站标题", url: "https://video.a.cdn.acfun.cn/1.m3u8" },
    absent: ["author", "avatar"],
  },
  {
    parser: "qsmusicParse",
    name: "汽水音乐（qsmusicCore.js:88-94，原始字段是 name）",
    raw: {
      code: 200,
      msg: "解析成功",
      data: {
        name: "汽水歌曲",
        url: "https://qishui.douyin.com/1.mp3",
        cover: "https://p3-douyin.yximgs.com/cover.jpg",
        lyrics: "[01:05.000]你好",
        core: "汽水音乐",
      },
    },
    unified: { title: "汽水歌曲", name: "汽水歌曲", url: "https://qishui.douyin.com/1.mp3" },
    retain: ["name", "lyrics", "core"],
  },
  {
    parser: "xiguaParse",
    name: "西瓜视频（xiguaCore.js:40-47）",
    raw: {
      code: 200,
      msg: "解析成功",
      data: {
        title: "西瓜标题",
        author: "作者E",
        avatar: "https://av.png",
        uid: "77",
        cover: "https://cov.png",
        url: "https://v3-xg.douyinvod.com/1.mp4",
      },
    },
    unified: { title: "西瓜标题", authorId: "77" },
    retain: ["uid"],
  },
  {
    parser: "zuiyouParse",
    name: "最右（zuiyouCore.js:50-59）",
    raw: {
      code: 200,
      msg: "解析成功",
      data: {
        title: "最右帖子",
        author: "最右用户",
        avatar: "https://avatar.png",
        cover: "https://cover.png",
        url: "https://video.zuiyou.com/1.mp4",
      },
    },
    unified: { title: "最右帖子", author: "最右用户" },
  },
  {
    parser: "parseTiktok",
    name: "TikTok（tiktokDlp.js:56-67，yt-dlp 秒已在解析器换算成毫秒）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "tiktok",
      data: {
        title: "TikTok caption",
        author: "tiktok user",
        cover: "https://p16-sign.tiktokcdn.com/cover.jpg",
        url: "https://v16-webapp.tiktok.com/1.mp4",
        type: "video",
        duration: 12800,
      },
    },
    unified: { title: "TikTok caption", url: "https://v16-webapp.tiktok.com/1.mp4" },
    duration: 12800,
  },
  {
    parser: "parseInstagram",
    name: "Instagram 视频（instagram.js:157-177）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "instagram",
      data: {
        title: "IG 配文",
        desc: "IG 配文",
        author: "ig_user",
        avatar: "",
        authorUrl: "https://www.instagram.com/ig_user/",
        cover: "https://scontent.cdninstagram.com/cover.jpg",
        time: 1700000000000,
        source: "instagram",
        type: "video",
        url: "https://scontent.cdninstagram.com/1.mp4",
        duration: 31000,
      },
    },
    unified: {
      title: "IG 配文",
      author: "ig_user",
      url: "https://scontent.cdninstagram.com/1.mp4",
    },
    duration: 31000,
    absent: ["avatar"],
    retain: ["source"],
  },
  {
    parser: "parseYoutube",
    name: "YouTube 官方接口分支（youtube.js:827-871）",
    raw: {
      code: 200,
      msg: "解析成功",
      platform: "youtube",
      data: {
        videoId: "dQw4w9WgXcQ",
        embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
        title: "YT 标题",
        author: "频道名",
        cover: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        authorUrl: "https://www.youtube.com/@channel",
        avatar: "https://yt3.ggpht.com/face.jpg",
        desc: "YT 描述",
        time: 1700000000000,
        views: 1000,
        like: 20,
        subscriberCount: 3000,
        authorId: "UCxxxx",
        sign: "频道简介",
        videoCount: 42,
        channelViews: 999999,
        url: "https://rr1.example.com/1.mp4",
        type: "video",
        duration: 213000,
        qualityLabel: "1080p",
        qualities: [{ quality: 1080, label: "1080p", url: "https://rr1.example.com/1.mp4" }],
        source: "yt-dlp",
      },
    },
    unified: {
      title: "YT 标题",
      author: "频道名",
      authorId: "UCxxxx",
      videoId: "dQw4w9WgXcQ",
      url: "https://rr1.example.com/1.mp4",
    },
    duration: 213000,
    retain: ["embedUrl", "qualities", "subscriberCount"],
  },
  {
    parser: "parseYoutube",
    name: "YouTube 仅内嵌分支（youtube.js:883-919，无直链属正常）",
    raw: {
      code: 200,
      msg: "解析成功（在线播放可用）",
      platform: "youtube",
      data: {
        videoId: "dQw4w9WgXcQ",
        embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
        title: "YT 标题",
        author: "频道名",
        cover: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        type: "video",
        embedOnly: true,
      },
    },
    unified: { embedOnly: true, embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ" },
    retain: ["embedOnly"],
  },
];

/** 契约字段类型合规：字符串档不得是空占位，数字档不得残留纯数字串 */
function assertScalarContract(data, label) {
  for (const key of UNIFIED_TEXT_FIELDS) {
    if (!(key in data) || data[key] === undefined) continue;
    const value = data[key];
    expect(typeof value, `${label}.${key} 应为字符串，实际 ${typeof value}`).toBe("string");
    expect(value, `${label}.${key} 不应下发空占位`).not.toBe("");
  }
  for (const key of UNIFIED_NUMBER_FIELDS) {
    if (!(key in data) || data[key] === undefined) continue;
    const value = data[key];
    if (typeof value === "string") {
      // 收不拢的写法（"1.2万"）原样保留是有意为之，纯数字串则必须已收成 number
      expect(
        value,
        `${label}.${key} 纯数字串应已收拢成 number`
      ).not.toMatch(/^[+-]?\d+(\.\d+)?$/);
    } else {
      expect(Number.isFinite(value), `${label}.${key} 应为有限数字`).toBe(true);
    }
  }
}

/** "mm:ss" / "h:mm:ss" → 秒；解析不出来返回 null */
function secondsFromFormat(fmt) {
  const parts = String(fmt)
    .split(":")
    .map((p) => Number(p));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * 时长口径交叉校验：`duration`（毫秒）与 `durationFormat` 必须自洽。
 * 允许 ±1 秒（B站分P 的 durationFormat 由 `duration - 1` 生成）。
 * 这条是秒/毫秒混用的直接探测器——把 duration 写成秒，差值就是几千秒。
 */
function assertDurationMs(value, fmt, label) {
  if (typeof value !== "number" || value <= 0) return;
  const secs = secondsFromFormat(fmt);
  if (secs === null) return;
  expect(Math.abs(value / 1000 - secs), `${label} duration=${value} 与 ${fmt} 不自洽`).toBeLessThanOrEqual(1);
}

/** 清晰度档位项（ParsedVideoQuality）：B站/YouTube 两个来源同构，都要能直接渲染下载行 */
function assertQualityList(qualities, label) {
  for (const [i, q] of (qualities ?? []).entries()) {
    expect(typeof q.url, `${label}[${i}].url`).toBe("string");
    expect(q.url, `${label}[${i}].url 不应为空`).not.toBe("");
    expect(typeof q.label, `${label}[${i}].label`).toBe("string");
    expect(Number.isFinite(q.quality), `${label}[${i}].quality 应为档位数字`).toBe(true);
  }
}

describe("全平台 raw→契约 对拍（parse-core 验收门）", () => {
  for (const c of CONTRACT_CASES) {
    it(c.name, () => {
      const out = normalizeResult(structuredClone(c.raw));

      // 消费一致性：成功码统一（B站历史的 1 也收成 200）
      expect(out.code).toBe(200);
      expect(out.data).toBeTypeOf("object");
      expect(Array.isArray(out.data)).toBe(false);

      // 完整性：统一字段落位
      if (c.unified) expect(out.data).toMatchObject(c.unified);

      // 单位一致：duration 毫秒（未声明 = 该平台不吐 duration）
      expect(out.data.duration).toBe(c.duration);

      // 完整性：原始键并存 / 不该出现的别名已消失
      for (const key of c.retain ?? []) {
        expect(key in out.data, `${c.name}: 原始键 ${key} 丢失`).toBe(true);
      }
      for (const key of c.absent ?? []) {
        expect(key in out.data, `${c.name}: ${key} 不应出现`).toBe(false);
      }

      assertScalarContract(out.data, c.name);

      // 单位一致：duration 与 durationFormat 自洽（写成秒就红）
      assertDurationMs(out.data.duration, out.data.durationFormat, `${c.name} 顶层`);

      // 列表型契约：下游按项遍历取值，url / duration / qualities 同样要合规
      for (const [i, item] of (out.data.videos ?? []).entries()) {
        const label = `${c.name} videos[${i}]`;
        expect(typeof item.url, `${label}.url 应为字符串`).toBe("string");
        expect(item.url, `${label}.url 不应为空`).not.toBe("");
        assertDurationMs(item.duration, item.durationFormat, label);
        assertQualityList(item.qualities, `${label}.qualities`);
      }
      assertQualityList(out.data.qualities, `${c.name}.qualities`);

      // 完整性：非空标量/数组的值不因归一化而丢失（收拢只换类型不改值）
      if (!Array.isArray(c.raw.data)) {
        for (const [key, value] of Object.entries(c.raw.data)) {
          if (value === null || value === undefined) continue;
          if (typeof value === "string" && value.trim() === "") continue;
          if (typeof value === "object") {
            expect(out.data[key], `${c.name}: ${key} 结构变化`).toEqual(value);
          } else {
            expect(String(out.data[key]), `${c.name}: ${key} 值变化`).toBe(String(value));
          }
        }
      }

      c.after?.(out);

      // 消费一致性：双归一幂等（下游重复套一层 normalizeResult 不改变结果）
      expect(normalizeResult(structuredClone(out))).toEqual(out);
    });
  }

  it("index.ts 白名单里的每个公开解析器都在本表中有用例", async () => {
    const core = await import("../packages/parse-core/src/index");
    const isParserExport = (name) =>
      typeof core[name] === "function" &&
      (/^parse[A-Z]/.test(name) || /[a-z]Parse$/.test(name));
    const exported = Object.keys(core).filter(isParserExport).sort();
    const covered = [...new Set(CONTRACT_CASES.map((c) => c.parser))].sort();

    // 新增解析器不落表 = 出口契约没人守；落表却查无此函数 = 解析器已被删/改名（major）
    expect({ exported, covered }).toEqual({ exported: covered, covered: exported });
  });
});

describe("normalizeResult：单点行为", () => {
  it("bilibili 无分P数据时不产生空 videos，顶层 url 为空", () => {
    const input = { code: 1, msg: "ok", title: "t", data: [] };
    const out = normalizeResult(input);
    expect(out.code).toBe(200);
    expect(out.data.videos).toEqual([]);
    expect(out.data.url).toBeUndefined();
  });

  it("错误响应不被归一化（原对象返回）", () => {
    const err = { code: 400, msg: "解析失败" };
    expect(normalizeResult(err)).toBe(err);
  });

  it("已存在统一字段时不被空值/旧字段覆盖", () => {
    const input = {
      code: 200,
      msg: "解析成功",
      data: { url: "https://u.mp4", photoUrl: "", caption: "标题" },
    };
    const out = normalizeResult(input);
    expect(out.data.url).toBe("https://u.mp4");
    expect(out.data.title).toBe("标题");
  });

  it("非对象输入原样返回", () => {
    expect(normalizeResult(null)).toBeNull();
    expect(normalizeResult(undefined)).toBeUndefined();
    expect(normalizeResult("str")).toBe("str");
  });
});
