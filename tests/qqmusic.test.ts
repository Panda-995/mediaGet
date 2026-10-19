// @ts-nocheck
import { describe, it, expect } from "vitest";
import { zzcSign } from "@/lib/qqmusic-sign";
import {
  buildSongInfoUrl,
  parseSongInfo,
  buildAlbumCoverUrl,
} from "@/lib/qqmusic";

/**
 * QQ音乐 保留在仓库里的两块纯逻辑：zzc 签名（音乐区自研搜索用）与
 * c.y.qq.com 歌曲元数据通道（/api/music/resolve 用）。
 * QQ 歌曲链接的识别与曲目 ID 提取已归 lib/music-link.ts，守卫在 tests/music-link.test.ts。
 */

// —— zzc 签名（向量取自参考实现 jixunmoe/qmweb-sign 官方测试） ——

describe("zzcSign：QQ音乐 musicu.fcg 请求签名", () => {
  it.each([
    ["123", "zzcec1b555gzqzg7laztguyjl2bu20r6x1w50c55f60"],
    ["hello world", "zzcfb3415bc4nfoxmd9uik71mkomtubjfjp141a1cbbcc"],
    ["jixun.uk", "zzcf47b78apso27mjjbbzgbof0szikfkvyqc7fc3a2b5"],
  ])("%s → %s", (input, expected) => {
    expect(zzcSign(input)).toBe(expected);
  });

  it("签名以 zzc 开头且整体小写", () => {
    const sign = zzcSign('{"req_0":{}}');
    expect(sign.startsWith("zzc")).toBe(true);
    expect(sign).toBe(sign.toLowerCase());
    // 总长 = zzc(3) + 首段7 + b64段(20字节去 \ / + =，随 payload 21~27) + 尾段8
    expect(sign.length).toBeGreaterThanOrEqual(39);
    expect(sign.length).toBeLessThanOrEqual(45);
  });
});

// —— 元数据接口组装与解析 ——

describe("buildSongInfoUrl", () => {
  it("songmid 优先", () => {
    expect(buildSongInfoUrl({ songmid: "abc", songid: "1" })).toBe(
      "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=abc&format=json"
    );
  });

  it("无 songmid 时用 songid", () => {
    expect(buildSongInfoUrl({ songid: "97773" })).toBe(
      "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songid=97773&format=json"
    );
  });
});

const SONG_FIXTURE = {
  code: 0,
  data: [
    {
      mid: "0039MnYb0qxYhV",
      id: 97773,
      name: "晴天",
      singer: [
        { mid: "0025NhlN2yWrP4", name: "周杰伦", type: 0 },
        { mid: "", name: "假声名", type: 1 },
      ],
      album: {
        id: 8220,
        mid: "000MkMni19ClKG",
        name: "叶惠美",
      },
      interval: 269,
      file: { media_mid: "0039MnYb0qxYhV" },
    },
  ],
};

describe("parseSongInfo：响应归一", () => {
  it("提取歌名/歌手/专辑/时长", () => {
    const meta = parseSongInfo(SONG_FIXTURE);
    expect(meta).toEqual({
      songmid: "0039MnYb0qxYhV",
      songid: "97773",
      name: "晴天",
      singers: ["周杰伦", "假声名"],
      albumName: "叶惠美",
      albumMid: "000MkMni19ClKG",
      interval: 269,
    });
  });

  it("空响应/缺 mid 返回 null", () => {
    expect(parseSongInfo(null)).toBeNull();
    expect(parseSongInfo({ code: 0, data: [] })).toBeNull();
    expect(parseSongInfo({ code: 0, data: [{}] })).toBeNull();
  });

  it("album 缺失时字段归零而非抛错", () => {
    const meta = parseSongInfo({
      code: 0,
      data: [{ mid: "00abc", id: 1, name: "x", singer: [] }],
    });
    expect(meta.albumMid).toBe("");
    expect(meta.singers).toEqual([]);
  });
});

describe("buildAlbumCoverUrl", () => {
  it("按 albummid 拼图床地址", () => {
    expect(buildAlbumCoverUrl("000MkMni19ClKG")).toBe(
      "https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg"
    );
  });
  it("无 albummid 返回空串", () => {
    expect(buildAlbumCoverUrl("")).toBe("");
  });
});
