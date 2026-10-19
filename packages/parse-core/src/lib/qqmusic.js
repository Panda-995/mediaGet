/**
 * QQ音乐歌曲元数据纯逻辑层 —— c.y.qq.com 单曲信息接口组装、响应归一与封面地址。
 * 无网络依赖，全部可单测；调用方是音乐区 /api/music/resolve（视频解析核心不再承载 QQ音乐）。
 * zzc 签名在 qqmusic-sign.js，由音乐区自研搜索 src/lib/self-search/tencent.js 使用。
 */

/** 歌曲信息接口（免签名可用，songmid/songid 均支持，2026-09 实测） */
export function buildSongInfoUrl({ songmid = "", songid = "" } = {}) {
  const key = songmid ? `songmid=${encodeURIComponent(songmid)}` : `songid=${encodeURIComponent(songid)}`;
  return `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?${key}&format=json`;
}

/** 归一歌曲信息；结构不符返回 null */
export function parseSongInfo(json) {
  const song = json?.data?.[0];
  if (!song?.mid) return null;
  return {
    songmid: String(song.mid),
    songid: String(song.id ?? ""),
    name: song.name || song.title || "",
    singers: (Array.isArray(song.singer) ? song.singer : [])
      .map((s) => s?.name)
      .filter(Boolean),
    albumName: song.album?.name || "",
    albumMid: song.album?.mid || "",
    interval: Number(song.interval) || 0,
  };
}

/** 专辑封面（按 albummid 拼 y.gtimg.cn 标准图床地址） */
export function buildAlbumCoverUrl(albumMid) {
  if (!albumMid) return "";
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`;
}
