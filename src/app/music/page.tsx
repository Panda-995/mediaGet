import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./music.css";
import MusicExplorer from "@/components/music/MusicExplorer";
import { MUSIC_VIEW_KEY, normalizeMusicView } from "@/lib/music-view";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  title: "音乐解析下载 - 多源聚合",
  description:
    "多源聚合音乐解析播放器：统一接入网易云音乐、酷我音乐、JOOX 等音源，输入歌名或歌手关键词即可搜索点播，一键获取试听 / 下载直链，即搜即听、即点即下。",
  keywords: [
    "音乐解析",
    "音乐下载",
    "在线搜歌",
    "在线听歌",
    "网易云音乐解析",
    "网易云音乐下载",
    "酷我音乐下载",
    "JOOX",
    "多源聚合",
    "音乐直链",
    "音频下载",
    siteConfig.name,
  ],
  alternates: {
    canonical: `${siteConfig.url}/music`,
  },
  openGraph: {
    title: `音乐解析下载 - 多源聚合 - ${siteConfig.name}`,
    description:
      "统一接入网易云、酷我、JOOX 等聚合音源，按关键词搜索即可获取歌曲试听与下载直链；全民K歌等视频内容请前往视频解析页。",
    url: `${siteConfig.url}/music`,
    siteName: siteConfig.name,
    type: "website",
    locale: "zh_CN",
  },
};

/**
 * 视图偏好（`mp-music-view`，见 music-view-store）**决定首屏渲染哪块面板**，因此必须服务端可知：
 * 只在客户端读（localStorage）会晚于首帧，刷新时先渲「发现歌曲」再跳「播放列表」，肉眼可见地闪。
 * 这里读出 Cookie 当 `initialView` 下发，首帧即正确面板。
 *
 * 代价：读 Cookie 使本路由按需渲染（不再静态预渲染）。取舍见 musicEngine.md §7。
 */
export const dynamic = "force-dynamic";

export default async function MusicPage() {
  const store = await cookies();
  const initialView = normalizeMusicView(store.get(MUSIC_VIEW_KEY)?.value);
  return <MusicExplorer initialView={initialView ?? undefined} />;
}
