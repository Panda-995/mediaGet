/**
 * 统一平台配置
 * 参考: https://github.com/wujunwei928/parse-video
 */

// 平台常量
export const PLATFORMS = {
  DOUYIN: "douyin",
  KUAISHOU: "kuaishou",
  XHS: "redbook",
  PIPIXIA: "pipixia",
  XIGUA: "xigua",
  ZUIYOU: "zuiyou",
  PIPI_GX: "pipigx",
  HUYA: "huya",
  BILIBILI: "bilibili",
  WEIBO: "weibo",
  QUANMIN_KGE: "quanminkge",
  SIXROOM: "sixroom",
  XINPIANCHANG: "xinpianchang",
  HAOKAN: "haokan",
  ACFUN: "acfun",
  TWITTER: "twitter",
  TIKTOK: "tiktok",
  INSTAGRAM: "instagram",
  YOUTUBE: "youtube",
  QQ_MUSIC: "qqmusic",
} as const;

type PlatformKey = (typeof PLATFORMS)[keyof typeof PLATFORMS];

export interface PlatformInfoEntry {
  name: string;
  nameEn: string;
  domains: string[];
  shortDomains: string[];
  supportsIdParse: boolean;
}

// 平台信息映射
export const PLATFORM_INFO: Record<PlatformKey, PlatformInfoEntry> = {
  [PLATFORMS.DOUYIN]: {
    name: "抖音",
    nameEn: "Douyin",
    // snssdk.com（aweme.snssdk.com 等 App 分享直链）、wtturl.cn（老版短链）
    // 原只存在于中间件的路由白名单，统一入口 identifyPlatform 认不出，
    // 粘贴这类链接会返回「未知平台」。补齐后两处行为一致。
    domains: ["douyin.com", "iesdouyin.com", "snssdk.com", "wtturl.cn"],
    shortDomains: ["v.douyin.com"],
    supportsIdParse: true,
  },
  [PLATFORMS.KUAISHOU]: {
    name: "快手",
    nameEn: "Kuaishou",
    domains: ["kuaishou.com", "kuaishoup.com"],
    shortDomains: ["v.kuaishou.com"],
    supportsIdParse: false,
  },
  [PLATFORMS.XHS]: {
    name: "小红书",
    nameEn: "Xiaohongshu",
    domains: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
    shortDomains: ["xhslink.com", "xhslink.cn"],
    supportsIdParse: false,
  },
  [PLATFORMS.PIPIXIA]: {
    name: "皮皮虾",
    nameEn: "Pipixia",
    domains: ["pipix.com"],
    shortDomains: [],
    supportsIdParse: true,
  },
  [PLATFORMS.XIGUA]: {
    name: "西瓜视频",
    nameEn: "Xigua",
    domains: ["ixigua.com"],
    shortDomains: ["v.ixigua.com"],
    supportsIdParse: true,
  },
  [PLATFORMS.ZUIYOU]: {
    name: "最右",
    nameEn: "Zuiyou",
    // xiaochuankeji.cn：与路由白名单对齐（share.xiaochuankeji.cn 是其子域）
    domains: ["izuiyou.com", "xiaochuankeji.com", "xiaochuankeji.cn"],
    shortDomains: ["share.xiaochuankeji.cn"],
    supportsIdParse: false,
  },
  [PLATFORMS.PIPI_GX]: {
    name: "皮皮搞笑",
    nameEn: "Pipigaoxiao",
    domains: ["pipigx.com"],
    shortDomains: ["h5.pipigx.com"],
    supportsIdParse: true,
  },
  [PLATFORMS.HUYA]: {
    name: "虎牙直播",
    nameEn: "Huya",
    domains: ["huya.com"],
    shortDomains: ["v.huya.com"],
    supportsIdParse: true,
  },
  [PLATFORMS.BILIBILI]: {
    name: "哔哩哔哩",
    nameEn: "Bilibili",
    domains: ["bilibili.com", "b23.tv"],
    shortDomains: ["b23.tv"],
    supportsIdParse: false,
  },
  [PLATFORMS.WEIBO]: {
    name: "微博",
    nameEn: "Weibo",
    // weibo.cn（含 m.weibo.cn）原被已移除的「绿洲」平台霸占，现回归微博阵营
    domains: ["weibo.com", "weibo.cn", "m.weibo.com"],
    shortDomains: [],
    supportsIdParse: true,
  },
  [PLATFORMS.QUANMIN_KGE]: {
    name: "全民K歌",
    nameEn: "Quanminkge",
    domains: ["kg.qq.com", "quanmin.kg.qq.com"],
    shortDomains: [],
    supportsIdParse: true,
  },
  [PLATFORMS.SIXROOM]: {
    name: "六间房",
    nameEn: "Sixroom",
    domains: ["6.cn"],
    shortDomains: [],
    supportsIdParse: true,
  },
  [PLATFORMS.XINPIANCHANG]: {
    name: "新片场",
    nameEn: "Xinpianchang",
    domains: ["xinpianchang.com"],
    shortDomains: [],
    supportsIdParse: false,
  },
  [PLATFORMS.HAOKAN]: {
    name: "好看视频",
    nameEn: "Haokan",
    domains: ["haokan.baidu.com", "haokan.hao123.com"],
    shortDomains: [],
    supportsIdParse: true,
  },
  [PLATFORMS.ACFUN]: {
    name: "AcFun",
    nameEn: "Acfun",
    domains: ["acfun.cn"],
    shortDomains: [],
    supportsIdParse: true,
  },
  [PLATFORMS.TWITTER]: {
    name: "Twitter/X",
    nameEn: "Twitter",
    domains: ["twitter.com", "x.com", "t.co"],
    shortDomains: ["t.co"],
    supportsIdParse: true,
  },
  [PLATFORMS.TIKTOK]: {
    name: "TikTok",
    nameEn: "Tiktok",
    domains: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    shortDomains: ["vm.tiktok.com", "vt.tiktok.com"],
    supportsIdParse: false,
  },
  [PLATFORMS.INSTAGRAM]: {
    name: "Instagram",
    nameEn: "Instagram",
    domains: ["instagram.com"],
    shortDomains: ["instagr.am"],
    supportsIdParse: false,
  },
  [PLATFORMS.YOUTUBE]: {
    name: "YouTube",
    nameEn: "Youtube",
    // youtube-nocookie.com：隐私增强域名，与路由白名单对齐
    domains: ["youtube.com", "youtube-nocookie.com"],
    shortDomains: ["youtu.be"],
    supportsIdParse: false,
  },
  [PLATFORMS.QQ_MUSIC]: {
    name: "QQ音乐",
    nameEn: "QQ Music",
    // c6.y.qq.com（App 分享短链）/ i.y.qq.com（分享 webview）由后缀规则覆盖
    domains: ["y.qq.com"],
    shortDomains: [],
    supportsIdParse: true,
  },
};

// 从 URL 识别平台
export function identifyPlatform(url: string): string | null {
  const hostname = new URL(url).hostname.toLowerCase();

  for (const [platform, info] of Object.entries(PLATFORM_INFO)) {
    // 检查主域名
    if (info.domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      return platform;
    }
    // 检查短域名
    if (info.shortDomains?.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      return platform;
    }
  }

  return null;
}

// 获取平台信息
export function getPlatformInfo(platform: string): PlatformInfoEntry | null {
  return PLATFORM_INFO[platform as PlatformKey] || null;
}

// 获取平台名称
export function getPlatformName(platform: string): string {
  return PLATFORM_INFO[platform as PlatformKey]?.name || platform;
}

// 获取所有支持 ID 解析的平台
export function getPlatformsSupportingIdParse(): string[] {
  return Object.entries(PLATFORM_INFO)
    .filter(([, info]) => info.supportsIdParse)
    .map(([platform]) => platform);
}

/**
 * 平台 key → 路由目录名。
 * 只列两者不一致的：路由目录沿用历史命名，平台 key 用统一入口 identifyPlatform 的返回值。
 * 新增平台若目录名与 key 相同，无需改这里。
 */
const ROUTE_DIR_ALIAS: Record<string, string> = {
  [PLATFORMS.XHS]: "xhs", // /api/xhs
  [PLATFORMS.PIPIXIA]: "ppxia", // /api/ppxia
};

/** 收集某平台全部域名（主域 + 短链域），去重且保持顺序 */
function allHostsOf(info: PlatformInfoEntry): string[] {
  return [...new Set([...(info.domains || []), ...(info.shortDomains || [])])];
}

/**
 * 平台专用路由（/api/douyin 等）的域名白名单：路由目录名 → { name, hosts }。
 *
 * 由 PLATFORM_INFO 推导，不再单独维护——此前中间件里另有一份硬编码表，
 * 两边逐渐分叉（中间件认 snssdk.com/wtturl.cn，PLATFORM_INFO 不认），
 * 表现为「/api/douyin 能解析、/api/parse 说未知平台」。
 *
 * 匹配规则（与 identifyPlatform 一致）：hostname === d || hostname.endsWith("." + d)。
 * 短链域名（v.douyin.com 等）虽被主域后缀覆盖，仍显式保留，便于检索与排查。
 */
export const ROUTE_DOMAIN_MAP: Record<string, { name: string; hosts: string[] }> =
  Object.fromEntries(
    Object.entries(PLATFORM_INFO).map(([key, info]) => [
      ROUTE_DIR_ALIAS[key] ?? key,
      { name: info.name, hosts: allHostsOf(info) },
    ])
  );

/**
 * 全部平台域名（用于 URL 验证）。
 * 同样从 PLATFORM_INFO 推导，避免与上面的白名单、identifyPlatform 三处各写一份。
 */
export const ALL_DOMAINS: string[] = Object.values(PLATFORM_INFO).flatMap(allHostsOf);
