import type { VideoPlatformKey } from "../config/video-platforms";

/** 单个清晰度直链（B站及已接入档位表的平台） */
export interface ParsedVideoQuality {
  /**
   * 平台档位值：B站为 qn（64=480P、80=720P、112=1080P、127=1080P+ 等）；
   * 其余平台为高度 px（如 1080），无高度时退回码率（如 2176000）。
   */
  quality: number;
  /** 清晰度展示标签，如 "高清 1080P"、"1080p"、"2176kbps" */
  label: string;
  /** 该清晰度视频直链 */
  url: string;
}

/** 多分P / 多清晰度视频项（B站分P、微博多P、X 多视频等） */
export interface ParsedVideoItem {
  title?: string;
  url: string;
  /** 时长（毫秒，与 `ParseData.duration` 同口径；bilibili 分P 原始为秒，归一化时换算） */
  duration?: number;
  /** 格式化时长，如 "00:02:59" */
  durationFormat?: string;
  /**
   * 本档直链的清晰度展示（微博每P一行，前端下载选项徽标读它；
   * 微博 `quality_desc` 对 1080p 与 720p 都显示「高清」，故取自 quality_index 拼 "1080P"）。
   */
  qualityLabel?: string;
  /** B站可用清晰度名称列表（accept_description），与 qualities 的档位一一对应 */
  accept?: string[];
  /** 本条视频的可选清晰度直链列表（多P 内容逐 P 下发；≥2 档才出现） */
  qualities?: ParsedVideoQuality[];
  /** 分P封面（B站 pages[].pic，可能为空，前端可回退到整体封面） */
  cover?: string;
  /**
   * 原始键并存（归一化保留，非契约字段）：B站解析器的 `video_url`，
   * 供归一化前后取值不变的旧调用方使用；新消费方一律读 `url`。
   */
  video_url?: string;
  /** 原始键并存：B站解析器的 `pic`，新消费方一律读 `cover` */
  pic?: string;
}

/**
 * 统一媒体解析数据结构 —— 所有平台解析成功后 data 的契约。
 *
 * 由服务端 `normalize-result` 归一化产出；前端只消费本结构，
 * 平台特有字段（音乐/统计）作为可选扩展保留在同一对象内。
 */
export interface ParseData {
  // —— 内容信息 ——
  title?: string;
  desc?: string;
  /** 内容类型：video / image / music / text（text 表示仅文字、无媒体可下载） */
  type?: "video" | "image" | "music" | "text";
  /** 视频时长（毫秒，全平台统一口径：抖音/YouTube/tiktok/instagram/B站顶层与分P、X 均已换算） */
  duration?: number;

  // —— 作者信息 ——
  author?: string;
  authorId?: string;
  /** 博主主页链接（抖音等平台，前端可点击跳转） */
  authorUrl?: string;
  avatar?: string;
  /** UP主签名 / 个人简介 */
  sign?: string;
  /** 视频分区（bilibili tname） */
  tname?: string;
  /** 版权标识（bilibili：1=自制 2=转载；汽水音乐等平台为字符串文案） */
  copyright?: number | string;
  /** 互动统计（bilibili 播放/弹幕/评论/收藏/投币/分享/点赞） */
  stat?: {
    view?: number;
    danmaku?: number;
    reply?: number;
    favorite?: number;
    coin?: number;
    share?: number;
    like?: number;
  };

  // —— 媒体 ——
  /** 封面图 */
  cover?: string;
  /** 主媒体直链（视频 / 音乐 / 单图） */
  url?: string;
  /** 音频直链（背景音乐 / 原声），前端据此提供「下载音频」 */
  audioUrl?: string;
  /** 图集 */
  images?: string[];
  /** 多分P / 多清晰度列表（bilibili） */
  videos?: ParsedVideoItem[];

  // —— 官方嵌入（YouTube 等） ——
  /** 平台视频 ID（YouTube 等；供前端构造官方嵌入 / 原始页面链接） */
  videoId?: string;
  /** 官方可嵌入播放地址（仅平台支持 iframe 嵌入时下发，如 YouTube 的 youtube-nocookie.com/embed/{id}，无需 API Key） */
  embedUrl?: string;
  /** 降级标记：直链解析源不可用、仅官方嵌入可用的成功结果（无 url/audioUrl，后端不写缓存，解析源恢复后重试即可拿直链） */
  embedOnly?: boolean;
  /**
   * 最佳直链清晰度展示（如 "1080p"；平台解析不出清晰度时省略）。
   * 单视频挂顶层；多P/多分P 各档可能不同，落 `videos[].qualityLabel`。
   */
  qualityLabel?: string;
  /**
   * 可下载清晰度档位列表：单视频挂顶层；多P/多分P 挂在 `videos[]`，顶层不写整体档位。
   * ≥2 档时前端渲染行内清晰度下拉，**不足 2 档不下发**（单档仍由 qualityLabel 徽标展示）。
   * 现有平台：B站、微博、快手、小红书、抖音、X、Instagram、TikTok。
   * YouTube 只下发「合流（含音轨）」的可直接下载档位，分离流（无声视频）不入列。
   */
  qualities?: ParsedVideoQuality[];

  // —— 富信息扩展（YouTube 与 B站对齐） ——
  /** 频道订阅者数（数字；0 / 缺失表示直链源未提供，前端据此隐藏徽标） */
  subscriberCount?: number;
  /** 频道投稿数（YouTube；仅官方 v3 配置时下发，0 / 缺失按无值隐藏。与 B站「分P数量」的 info-panel 特殊键 videoCount 无关，那是读 videos.length） */
  videoCount?: number;
  /** 频道累计播放（YouTube；仅官方 v3 配置时下发，0 / 缺失按无值隐藏） */
  channelViews?: number;

  // —— 音乐扩展（汽水音乐）——
  name?: string;
  lyrics?: string;
  core?: string;
  /** 解析来源标记（快手 init-state / json-fragment、YouTube yt-dlp…、Instagram instagram），诊断用 */
  source?: string;

  // —— 平台特有统计（保留，抖音等） ——
  like?: number;
  /** 收藏数（小红书 / 微博 / B站 note 卡等，与 `stat.favorite` 分属两套来源） */
  favorite?: number | string;
  /** 评论数（小红书 / 微博等顶层计数，与 `stat.reply` 分属两套来源） */
  reply?: number | string;
  /** 分享数（小红书 / 微博等顶层计数） */
  share?: number | string;
  /** 播放数（快手等顶层计数） */
  playCount?: number | string;
  /** 点赞数（快手等顶层计数，与 `like` 并存） */
  likeCount?: number | string;
  /** 评论数（快手等顶层计数，与 `reply` 并存） */
  commentCount?: number | string;
  /** 分享数（快手等顶层计数，与 `share` 并存） */
  shareCount?: number | string;
  /**
   * 收藏数（快手）：来自 H5 页顶层 `counts.collectionCount`。该 `counts` 是混合对象——
   * `fanCount` / `photoCount` 跟作者走，这一项跟**作品**走，不要并进博主公开信息一档。
   */
  collectionCount?: number | string;
  /** 格式化时长，如 "00:02:59"（X / B站分P 下发，`duration` 的展示伴生字段） */
  durationFormat?: string;
  /** 笔记 / 帖子 ID（小红书 `noteId`，与 `awemeId` 同类的作品标识扩展） */
  noteId?: string;
  /** 转发数（X / 微博等） */
  retweets?: number;
  /** 评论数（X / 微博等） */
  replies?: number;
  /** 查看量（X 等） */
  views?: number;
  /**
   * 发布时间 —— **平台原样透传，口径不统一**（与 `duration` 的毫秒硬口径不同）：
   * 抖音 / 小红书 / B站为 unix 秒，X / Instagram / YouTube 为毫秒时间戳，
   * 微博为可 `new Date()` 解析的日期串。消费方按「秒 / 毫秒 / 可解析串」三选一兼容处理
   * （web 侧的 `ParseInfoPanel.formatTime` 就是这个写法），不要假设单一单位。
   */
  time?: number | string;
  /**
   * IP 属地（作品级，发布这条内容时所在地）。微博取桌面作品接口 `region_name`
   * （文案「发布于 山东」已剥前缀）；手机通道无此字段。
   */
  ipRegion?: string;
  /** 原始键并存（非契约）：作者内部 ID，部分平台用它拼主页链接；新消费方读 `authorId` */
  uid?: string;
  /** 视频 ID（抖音 aweme_id 等） */
  awemeId?: string;
  /** 粉丝数（抖音博主主页公开信息） */
  followerCount?: number;
  /** 关注数（抖音博主主页公开信息） */
  followingCount?: number;
  /**
   * 获赞数 —— **作者**累计获赞（不是本条作品的点赞，后者是 `like`）。
   * 抖音 / 快手 / B站来自博主主页公开信息，小红书为主页统计，
   * 微博只存在于桌面 ajax 的 `user.status_total_counter.like_cnt`（手机通道无此字段）。
   * 注意同表里的 `total_cnt` = 赞 + 评论 + 转发，是互动总数，不是获赞，不要取它。
   */
  totalFavorited?: number;
  /** 认证说明（微博桌面作者接口 `verified_reason`，如「微博译制视频博主」） */
  verifiedReason?: string;
  /** 作者微博总条数（微博桌面作者接口 `statuses_count`，其他平台无此口径） */
  statusesCount?: number;
  /** 小红书：主页统计是否被脱敏（未登录会话时小红书降级为固定估算低值，非精确数据） */
  statsUnreliable?: boolean;
  music?: { author: string; title?: string; avatar: string };
}

export interface ApiResponse {
  code: number;
  msg: string;
  platform?: VideoPlatformKey;
  data?: ParseData;
  /**
   * 失败细分类型（YouTube 等解析器返回，code 非 200 时可能有值）：
   * bot-gated（视频需登录验证）/ sources-down（解析源暂不可用）/
   * not-found（视频不存在或受限）/ no-sources / unreachable。
   * 前端据此给出针对性提示，普通失败无此字段。
   */
  failType?: string;
}
