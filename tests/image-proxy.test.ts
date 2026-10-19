// @ts-nocheck
/**
 * 图片代理两层守卫：
 * 1. 出口改写（proxifyResult / proxifyResultData）—— 内核出直链，站内代理是 web 的出参形态；
 *    判据、幂等、多 CDN 备选折叠、视频不动都归在这里；
 * 2. `/api/image` 回源：主地址 fetch 失败/非 2xx 时按序尝试 fallback 备选（快手头像多 CDN 容错），
 *    备选请求携带对应图床的防盗链 Referer，全部失败返回 502。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/image/route.js";
import { proxifyResult, proxifyResultData } from "@/lib/image-proxy";

const goodJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]).buffer;

function imageRequest(url, fallback) {
  let qs = `url=${encodeURIComponent(url)}`;
  if (fallback) qs += `&fallback=${encodeURIComponent(fallback)}`;
  return new Request(`http://127.0.0.1/api/image?${qs}`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

describe("image proxy CDN fallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("主地址失败（5xx）时回退到 fallback 备选，并带快手 Referer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(goodJpeg, { headers: { "content-type": "image/jpeg" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    // 注意：代理按主 URL 进程内缓存，各用例需用不同主 URL 避免互相命中
    const res = await GET(
      imageRequest(
        "https://p2-pro.a.yximgs.com/uhead/x1==_s.jpg",
        "https://p1-pro.a.yximgs.com/uhead/x1==_s.jpg"
      )
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");

    const fallbackCall = fetchMock.mock.calls[1];
    expect(fallbackCall[0]).toContain("p1-pro.a.yximgs.com");
    expect(fallbackCall[1].headers.Referer).toBe("https://www.kuaishou.com/");
  });

  it("主地址网络异常（fetch 抛错）时回退到 fallback 备选", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(goodJpeg, { headers: { "content-type": "image/jpeg" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(
      imageRequest(
        "https://p2-pro.a.yximgs.com/uhead/x2==_s.jpg",
        "https://p1-pro.a.yximgs.com/uhead/x2==_s.jpg"
      )
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("主地址与备选全部失败时返回 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 }))
    );

    const res = await GET(
      imageRequest(
        "https://p2-pro.a.yximgs.com/uhead/x3==_s.jpg",
        "https://p1-pro.a.yximgs.com/uhead/x3==_s.jpg"
      )
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("404");
  });
});

/** 代理串还原（只看结构，便于断言改写结果而不复制 encode 细节） */
function unwrap(proxy) {
  const prefix = "/api/image?url=";
  expect(proxy.startsWith(prefix)).toBe(true);
  const rest = proxy.slice(prefix.length);
  const [u, fb] = rest.split("&fallback=");
  return {
    url: decodeURIComponent(u),
    fallbacks: fb === undefined ? null : fb.split(",").map(decodeURIComponent),
  };
}

describe("出口改写：内核直链 → 站内图片代理", () => {
  it("声明为图片的键一律包（无扩展名的图床地址也包），统一键与来源别名键同源", () => {
    const data = {
      cover: "https://sns-webpic.xhscdn.com/202609/i1!nd_dft_wlteh_webp",
      coverUrl: "https://p2-pro.a.yximgs.com/uhead/a.jpg",
      avatar: "https://i1.hdslb.com/bfs/face/f",
      authorAvatar: "https://p2-pro.a.yximgs.com/uhead/b.jpg",
      imgurl: "https://i0.hdslb.com/bfs/archive/pic.jpg",
      images: [
        "https://sns-webpic.xhscdn.com/202609/i1!nd_dft_wlteh_webp",
        "https://wx1.sinaimg.cn/large/abc.jpg",
      ],
      videos: [
        { url: "https://f.video.weibocdn.com/720.mp4", cover: "https://wx1.sinaimg.cn/large/v.jpg" },
      ],
    };
    proxifyResultData(data);

    expect(unwrap(data.cover).url).toBe("https://sns-webpic.xhscdn.com/202609/i1!nd_dft_wlteh_webp");
    expect(unwrap(data.avatar).url).toBe("https://i1.hdslb.com/bfs/face/f");
    expect(unwrap(data.imgurl).url).toBe("https://i0.hdslb.com/bfs/archive/pic.jpg");
    expect(data.images.map((u) => unwrap(u).url)).toEqual([
      "https://sns-webpic.xhscdn.com/202609/i1!nd_dft_wlteh_webp",
      "https://wx1.sinaimg.cn/large/abc.jpg",
    ]);
    // 分P：封面包，视频直链不动（代理视频会拖慢播放）
    expect(unwrap(data.videos[0].cover).url).toBe("https://wx1.sinaimg.cn/large/v.jpg");
    expect(data.videos[0].url).toBe("https://f.video.weibocdn.com/720.mp4");
  });

  it("主直链按值判：图文帖的 .jpg 包，视频帖的 .mp4 不包", () => {
    const image = proxifyResult({
      code: 200,
      data: { url: "https://wx2.sinaimg.cn/large/Rn4lmzVM9.jpg", type: "image" },
    });
    expect(unwrap(image.data.url).url).toBe("https://wx2.sinaimg.cn/large/Rn4lmzVM9.jpg");

    const video = proxifyResult({
      code: 200,
      data: { url: "https://us.video.weibocdn.com/1080.mp4", type: "video" },
    });
    expect(video.data.url).toBe("https://us.video.weibocdn.com/1080.mp4");
  });

  it("多 CDN 备选折叠进 &fallback= 后删除内部键，派生键与来源键拿到同一份备选", () => {
    const cover = "https://p2-pro.a.yximgs.com/uhead/x.jpg";
    const data = {
      cover,
      coverUrl: cover,
      coverUrlFallbacks: [
        "https://p1-pro.a.yximgs.com/uhead/x.jpg",
        "https://p0-pro.a.yximgs.com/uhead/x.jpg",
      ],
      authorAvatar: "https://p2-pro.a.yximgs.com/uhead/y.jpg",
      authorAvatarFallbacks: ["https://p1-pro.a.yximgs.com/uhead/y.jpg"],
    };
    proxifyResultData(data);

    expect(unwrap(data.cover).fallbacks).toEqual([
      "https://p1-pro.a.yximgs.com/uhead/x.jpg",
      "https://p0-pro.a.yximgs.com/uhead/x.jpg",
    ]);
    expect(unwrap(data.coverUrl).fallbacks).toHaveLength(2);
    expect(unwrap(data.authorAvatar).fallbacks).toEqual([
      "https://p1-pro.a.yximgs.com/uhead/y.jpg",
    ]);
    expect("coverUrlFallbacks" in data).toBe(false);
    expect("authorAvatarFallbacks" in data).toBe(false);
  });

  it("幂等：改写结果再过一遍不变（URL 模式与 ID 直查共用出口，重复调用不套两层）", () => {
    const data = {
      cover: "https://wx1.sinaimg.cn/large/a.jpg",
      images: ["https://wx1.sinaimg.cn/large/b.jpg"],
    };
    proxifyResultData(data);
    const once = JSON.parse(JSON.stringify(data));
    proxifyResultData(data);
    expect(data).toEqual(once);
    expect(data.cover.startsWith("/api/image?url=%2Fapi%2Fimage")).toBe(false);
  });

  it("非成功信封原样返回，不碰 data", () => {
    const failed = { code: 400, msg: "解析失败" };
    expect(proxifyResult(failed)).toBe(failed);
    expect(proxifyResult({ code: 200, msg: "ok" }).code).toBe(200);
  });
});
