# CLAUDE.md

本文件给在仓库内写代码/改代码的 AI 助手（Claude Code / CodeBuddy 等）提供工作指引。目标：改完代码后 `README.md`、`API.md`、`CLAUDE.md` 中描述的平台、接口、环境变量、目录职责依然与实际实现一致。

## 项目概况

`mediaGet`（品牌「即刻解析」，线上 <https://get.hotier.cc.cd>）是一个 Next.js 15（App Router + React 19）解析下载站，含两大产品模块：

1. **视频/图文/音乐内容解析（首页 `/`）**：支持 **21 个平台**（抖音、快手、微博、哔哩哔哩、小红书、汽水音乐、皮皮虾、皮皮搞笑、西瓜视频、最右、虎牙、AcFun、全民K歌、QQ音乐、六间房、新片场、好看视频、TikTok、X/Twitter、Instagram、YouTube），输入分享链接 / 整段分享文案 /（部分平台）`source+id`，自动识别平台与内容类型并输出无水印直链。
2. **音乐解析中心（`/music`）**：多源聚合搜歌 / 试听 / 播放 / 歌词 / 封面 / 下载——默认 GD 聚合上游（`/api/music`，网易云/酷我/JOOX 等搜索）+ 自研直连搜索（`/api/music/self`，服务器直连腾讯/酷狗/咪咕等五家搜索，独立搜索源 chips）+ 歌曲链接解析（`/api/music/resolve`，网易云 / QQ音乐 / 酷我识别，酷狗与「被停用播放引擎的 QQ」返回 `engine-missing`）。平台「搜索引擎 / 播放引擎」为部署可配开关（env `MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY` 正向覆盖，另有 `MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` 黑名单与整体下线便捷变量 `MUSIC_PLATFORM_OFF` 作最终闸门，两维默认 6 平台全开，见 API.md §12）。除 env 外还可在音乐页齿轮进入的独立设置页 `/music/settings`（登录鉴权：未登录重定向到 `/music/settings/login`，校验 `SETTINGS_API_KEY` 后由服务端下发 HMAC 签名会话 Cookie）里改（写入 Turso 配置文档 `music.flags`，改完全站生效、无需重新部署；env 黑名单仍是压在最后的终闸）。

另有静态页：FAQ（`/faq`）、法律页（`/legal/{terms,privacy,dmca}`）、`robots.ts` / `sitemap.ts`；全站 PWA、深浅主题（默认跟随系统）。

技术形态：API 层与核心逻辑多为 **`.js`（ESM import/export）**，页面/组件/工具为 **TS/TSX**；前端是客户端会话式 SPA 页面（会话存 `sessionStorage`），后端是 API Route Handler，**除 `_diag/route.ts` 外全部为 `route.js`，且全部显式 `export const runtime = "nodejs"`**。

## 常用命令

```bash
npm run dev          # 开发（next dev --turbopack）
npm run build        # 生产构建
npm start            # 生产运行
npm run lint
npm test             # 单元测试（vitest run，纯本地无外网）
npm run test:watch
npm run test:live    # 真机解析测试（前缀 RUN_LIVE_PARSE=1，.env 需配 LIVE_URL_*）
npm run build:cf     # OpenNext Cloudflare 构建（产物 .open-next/）
```

单文件测试：`npx vitest run tests/share.test.ts`。真机测试目录 `tests/live/` 里另有音乐链接解析真机测试 `resolve-live.test.ts`（需显式 `RUN_LIVE_RESOLVE=1` 才跑，`npm run test:live` 不会带它）。live 测试都通过 `skipIf` 控制，不配 env 时默认跳过。

## 架构

### 后端（`src/app/api/**`）

**统一路由骨架**：平台/功能路由一律 `export const GET = createApiHandler(parseFn[, options])`；`createApiHandler`（`src/lib/api-middleware.ts`）把一个「纯解析函数」包装成完整 HTTP 接口，职责链依次为：CORS → IP 黑名单蜜罐（`lib/honeypot.ts`）→ IP 级限流 60 次/分（`lib/api-utils.js`）→ 平台级真实抓取节流（`lib/anti-bot.js`，默认 30 次/分/平台）→ URL 校验 + SSRF 白名单 → 解析执行 → `normalizeResult` 归一化统一契约 → 成功结果 5 分钟进程内缓存（`shouldCache`）→ `analytics.recordParse` 行为统计（Turso，可选）→ 统一错误响应；`fmt=text` 也由中间件统一处理。**不要绕过中间件自造轮子**，新增平台解析器只需返回 `{ code, msg, data }`。

**统一入口**：`/api/parse`（GET/POST）与 `/api/parse-text`（纯 `text=` 文案的兼容别名）都是薄壳，真实逻辑在 `src/lib/parse-handler.js`：`unified-parser.js` 识别平台（`lib/platforms.ts` 的 `PLATFORM_INFO` 决定识别与 `source+id` 能力）→ `lib/blockedPlatforms.ts` 黑名单（微信视频号与付费/DRM 平台）→ 按 `lib/platformRoutes.js`（平台 key → route 的唯一映射）动态 import 解析器 → 解析后写入 **24h 共享结果缓存**（`lib/result-cache.js`，Cloudflare Cache API，命中时先探测主直链，404/410 死链自动重解析）。key 与目录名映射：小红书 `redbook` → `/api/xhs`，皮皮虾 `pipixia` → `/api/ppxia`，汽水音乐 `qsmusic` 走特判。

**平台解析器风格**：多数是 route 内独立 async 函数（短链跟随 → 伪装 UA 抓页面/接口 → 提内嵌 JSON），快手是类（`lib/kuaishouCore.js`）。TikTok 走 `lib/tiktokDlp.js`（yt-dlp child_process，**仅 Docker/带二进制环境可用**）；YouTube 为纯 HTTP 多源竞速（`lib/youtube.js`，见下）；Instagram（`lib/instagram.js`）已全面登录墙，需 `IG_COOKIE`。

**音乐接口**：
- `/api/music`（provider=gd）：`lib/gdmusic.js` 按 GD(gdstudio) 契约组装 `types=url/search/pic/lyric` 请求，`getUpstreamBases` 多基址按序回退（8s 总预算）。action 支持 `search/pic/lyric/url(默认)`；另有 `bin=1`（url→音频字节代理下载带音质标签文件名；pic→封面字节同源取色）与 `fmt=text`。搜索 action 仅开放 netease/kuwo/joox。
- `/api/music/self`（自研直连搜索，仅 `action=search`）：`lib/self-search/`（index/errors + netease/tencent/kugou/kuwo/migu 每平台一模块，移植 lx-music musicSdk 并自研签名）服务器直连五家搜索 API，source 沿用 GD 命名，归一为 GD 搜索同契约 SearchItem（line 标注 `kind=self`）。三条价值：(1) tencent/kugou/migu 是 GD 未开放搜索的**独立搜索源 chips**；(2) netease/kuwo 双通道：搜索以本通道为主（自研失败才回退 GD 搜索引擎，并会话置位让后续翻页直接走 GD）；(3) 封面不强求——搜索响应能内嵌的写入 `picUrlDirect` 直接展示，不做二次换取。tencent/netease/kuwo 产物 id 与其 GD 直链通道所需 id 一致，可无缝复用直链/歌词/封面；kugou 已内置官方免费试听直链（`action=url` → 官方 `getSongInfo`，免费档 128k mp3，VIP/付费曲返回 `failType=vip-only`），migu 无内置直链引擎（`sourceEngineKindFor → self`，`SELF_ONLY_ENGINE_KEYS`）：前端点播/切音质统一走 music-client `requestPlayDirect`，migu 直接抛「该音源暂未接入试听直链引擎」提示。
- `/api/music/resolve`：`lib/music-link.ts` 纯函数识别链接（SSRF 面收敛：不直接请求用户链接，官方短链 `163cn.tv` / `c.y.qq.com` 等服务端跟随一次重定向）→ 按平台直链引擎补元数据并产出 SearchItem，播放直链由 `/api/music` `action=url` 实时取（不预取）。网易 ready（`lib/netease-meta.js`，官方 song/detail）、QQ音乐 ready（`lib/qqmusic.js` songinfo，songmid 走 GD tencent 源）、酷我 ready（`lib/kuwo-meta.js`，m.kuwo.cn H5 songinfo，rid 走 GD kuwo 源）；各平台详情失败均降级占位标题仍可播（`metadata=fallback`），详情成功各自缓存 5 分钟。酷狗识别成功仍 `engine-missing`（GD 无 kugou source，直链通道未建），无法识别 400。

- `/api/music/caps`：平台能力矩阵 + 设置写入端点。`GET`（公开，无鉴权）下发生效矩阵与面板所需的 `baseline` / `overrides` / `locked` / `behavior` / `editable` / `blockedReason`，前端 `lib/music-caps.ts` 启动时拉取并据此过滤 chips / 跨源候选；`PUT`（全量矩阵 + 自动换源行为）与 `DELETE`（恢复部署基线）需 `Authorization: Bearer <SETTINGS_API_KEY>` 或设置页登录会话 Cookie（`lib/music-settings-auth.js`，HMAC 签名令牌 + httpOnly Cookie）。另有 `/api/music/settings/session`（`POST` 登录换会话 / `GET` 查询 / `DELETE` 登出，`runtime=nodejs`），设置页 `/music/settings` 服务端读 Cookie 校验、无会话即重定向登录页 `/music/settings/login`（`next` 仅允许 `/music/settings` 前缀）。求值为两段式（无文档 = 默认→env 正向→env 终闸；有文档 = 文档全量→env 终闸），配置文档存 Turso `app_settings`（key `music.flags`），进程内 TTL 15s 缓存 + 写后失效。存储不可用 / 文档损坏时读路径回落基线不阻塞听歌，只有写入报 503。**「没配置存储」与「配了但连不上」必须严格区分**（`lib/settings-store.js` 的 `getStoreStatus()` 记录最近一次故障原因）：写入失败 503 的 `msg` 会带真实原因（如 `持久化存储写入失败：Turso 请求超时（>8000ms）`），只有真的没配 `TURSO_DB_URL` / `TURSO_AUTH_TOKEN` 才回「未配置持久化存储」——否则「代理 / 防火墙把 `turso.io` 黑洞了」会被误读成「忘了配环境变量」。写入鉴权统一走 `lib/music-settings-auth.js` 的 `authenticateSettingsWrite`（`PUT`/`DELETE /api/music/caps` 共用）；GET 另下发 `storeAvailable`（**仅代表 env 是否配置**）/ `storeError`（最近一次故障原因，null = 正常）/ `writeKeyConfigured` 供设置页「运行状态」区块诊断，把「未配置」与「连接异常」分开显示。详见 API.md §12.7。

**资源代理**：`/api/video-proxy`（视频流：按平台补 Referer 防盗链、Range/206、download=1、twitter CDN 特殊处理；超时/重试）与 `/api/image`（图片字节代理，内存 LRU 6h，小红书/微博/快手图床需带 Referer）。前端是否走代理由 `utils/videoProxy.ts` 判定。

**辅助端点**：`/api/health`、`/api/config`（读 `VIDEO_PARSE_ENABLED`）、`/api/stats`（Turso 统计，需 `STATS_API_KEY`）、`/api/rate-limit`（查当前 IP 配额）、`/api/engines`（平台路由体检）、`/api/_diag`（临时诊断）。

### 前端

- 页面：`src/app/page.tsx`（首页解析会话状态机 + 平台网格 + 结果卡 + `failType` 差异化错误展示）、`src/app/music/page.tsx`（MusicExplorer 全屏音乐播放器 + 歌词）、`src/app/music/settings/page.tsx`（服务端会话守卫的平台引擎设置页）+ `src/app/music/settings/login/page.tsx`（设置登录页）、`faq`、`legal/*`。`layout.tsx` 含主题三段脚本与 JSON-LD/PWA manifest。
- 表单与展示：`src/components/VideoParserForm.tsx`（剪贴板、防抖、平台指定）；`src/components/videos/` 每平台一个展示组件，`platform-renderers.tsx` 按平台/content 类型分发（图文图集多选下载、多分P清晰度、在线播放、复制直链）。
- 音乐 UI：`src/components/music/MusicExplorer.tsx`、`MusicViewSeg`、`BrPicker` 等，以及平台引擎设置共享表单 `MusicSettingsForm.tsx`（齿轮入口在内容区 `.mp-tools`，改用 `<Link>` 跳转 `/music/settings`；表单为「平台引擎 6×2 矩阵 + 自动换源 + 内置播放引擎总开关 + 运行状态」四区块与操作条，支持 `key`（内联密钥）/`session`（登录会话）两种授权，被设置页 `MusicSettingsPage.tsx` 与登录页 `MusicSettingsLogin.tsx` 复用；草稿/diff/提交/密钥逻辑抽在 `use-music-settings.ts`，纯函数可单测）；请求层 `src/lib/music-client.ts`：同源代理优先 + GD 公共源直连兜底（仅 provider=gd 可直连），自研直连搜索源 chips（tencent/kugou/migu）与 netease/kuwo 双通道（自研为主、GD 搜索引擎兜底）搜索都经 `/api/music/self` 分派。浏览器端用 **源通道引擎抽象**（`sourceEngineKindFor`/`sourceEngineCapsFor` 把 source 归入 `gd|self`，`trackDownloadSpec`/`coverBinUrl` 决策 bin 字节下载 / 封面取色 URL）——UI 不得自己拼 `/api/music` URL 或读 `isDirectUsed`；搜索引擎注册视图由 `source-meta.ts` 的 `buildSearchChips`（内置 GD 源 + 内置自研直连源）统一构建，`MusicExplorer`/各面板只消费 chips 与上述入口。**聚合搜索**：SearchPanel chips 行首「聚合搜索」伪 chip（`aggActive`）开启，一次 `searchAcrossSources`（music-client，平台级限流闸 ≤3 路并发、多次触发叠加也不超 3、逐源失败隔离）拉全部可用源第 1 页，`music-match.ts`（纯函数：文本清洗/关键词相关度打分/跨源同曲判定与去重）合并排序成混合列表；去重与打分规则与播放失败自动换源共用同一套实现。聚合列表无翻页、不落播放快照（来源混合无从恢复），部分源失败以 `pageErr` 尾部提示、全部失败给空态说明。**播放失败自动换源**由 `use-player-engine.ts` 收敛：resolve（取直链失败）与 play（`<audio>` 媒体层报错）双阶段都进入 token 化有界自动换源——先遍历当前队列内同曲高置信候选，队列内无自动候选时再跑一轮**跨源现搜**（`suggestCrossCandidates`，复用聚合闸），两段共用同一尝试预算（`autoTrying` 期间播放条上方显示进行态 pill，阶段文案经 `altNote` 提示「正在跨音源现搜…」），失败收尾时把「尚未自动尝试过」的候选以 `alternatives` 快照暴露给 UI——`MusicExplorer` 据此弹出 `AltSelectDialog` 人工选版（逐行 来源/歌名/歌手/专辑，点行 `playTrack` 重走闭环）。四项行为（总开关 / 单轮尝试上限 `maxAttempts` 1–8 默认 4 / 跨源现搜 / 失败弹人工选版）由部署级设置面板下发，引擎在 `runAutoFallback` 入口与两个调用点各读一次 `getMusicBehavior()`（模块级快照，不参与渲染）：总开关关闭时不进闭环、直接保留既有 `playError`。**系统媒体会话**由 `use-media-session.ts` 收敛：把当前曲目同步到浏览器 Media Session（Windows 通知栏 / 锁屏 / 系统媒体键），元数据用专辑封面、未获取封面时回退该曲目所属平台的品牌 logo（`platform-brand.ts` 提供 label/强调色/`public/logos` SVG；系统控件不渲染 SVG，故栅格化为 PNG，无品牌 SVG 的平台退化为品牌色块），播放态 / 进度 / 媒体键回灌播放引擎命令；播放会话期间站点标题同步为「歌曲 - 歌手」，会话清空 / 卸载时还原。通用内核抽在 `src/components/media-session/`（`use-now-playing.ts` 元数据 / 播放态 / 进度 / 媒体键 / 站点标题，`brand-artwork.ts` 品牌 SVG → PNG），音乐与视频两侧只做字段映射：视频解析页 `videos/use-video-media-session.ts` + `videos/VideoPosterCard.tsx` 在内嵌播放时上报视频标题 / UP主 / 平台，多分P（B站分P、微博与 X 多视频）跟随当前播放项、系统「上一首 / 下一首」切相邻分P；直链在新标签页播放的场景不由本页上报。**本地缓存层**（浏览器侧，均在 `src/components/music/`）：播放偏好 `player-prefs.ts`、音乐页视图 `music-view-store.ts`、上次播放会话 `playback-session.ts`、播放列表快照 `playlist-cache.ts`、搜索渠道偏好（`MusicExplorer.tsx` 内 `mp-search-channel`）与最近搜索 `search-history.ts`、歌词与封面配色 `media-cache.ts`；只存本机、绝不落带时效的直链，载体 / TTL / 读写口径见 `musicEngine.md` §7.4。
- `src/components/ui/` 是基于 shadcn/ui 规范生成的基础组件（CVA + tailwind-merge + 少量 radix primitives），改 UI 优先复用其中封装。

### 关键 lib 一览（`src/lib/`）

- 解析基础设施：`api-utils.js`（缓存/限流/URL校验/日志/北京时区/取客户端 IP）、`api-middleware.ts`、`normalize-result.ts`、`result-cache.js`、`parse-handler.js`、`unified-parser.js`、`platformRoutes.js`、`platforms.ts`、`share-text.ts`（服务端抽链接，与前端 `utils/share.ts` 行为对齐）、`blockedPlatforms.ts`、`anti-bot.js`、`honeypot.ts`、`analytics.js` + `turso-client.js`。
- 平台解析：抖音（route 内 + `douyin-extract.js`/`douyinFallback.js`）、`kuaishouCore.js`、bilibili（route 内 + `bilibili-opus.js` 图文、`bilibili-cookie-guard.js` 失效告警）、`instagram.js`、`tiktokDlp.js`、`ytDlpClient.js`（备用封装）、`youtube.js`、`qqmusic.js`/`qqmusic-id.js`/`qqmusic-sign.js`，其余小平台解析内联在各 route。
- 音乐：`gdmusic.js`、`music-link.ts`、`netease-meta.js`；`music-platform-flags.js`（平台双维开关真源 + `MUSIC_BEHAVIOR_DEFAULTS` 自动换源默认值 + `MUSIC_BEHAVIOR_LIMITS` 边界 + `lockedPlatformKeys` 终闸锁定集）、`music-effective-flags.js`（配置文档校验/规范化 + 两段式求值）、`settings-store.js`（Turso `app_settings` 单表键值存储 + TTL 缓存，写入需 `TURSO_DB_URL` / `TURSO_AUTH_TOKEN`）；`self-search/`（自研直连搜索：`netease.js`/`tencent.js`/`kugou.js`/`kuwo.js`/`migu.js` + `index.js` 统一编排 + `errors.js`，配套单测 `tests/self-search.test.ts`、路由单测 `tests/self-route.test.ts`）。
- 前端工具：`utils/share.ts`、`utils/videoProxy.ts`、`utils/downloadImages.ts`、`utils/filename.ts`。

## 环境变量

敏感 Cookie 只进服务端环境变量（平台路由在 Node runtime 读），**不要写入 `wrangler.toml` / 前端可及文件**。完整说明与示例在 `API.md`「限制说明 → 环境变量配置」，此处给速查：

- 抖音：`DOUYIN_COOKIE`（可选，仅增强；UA 轮询已硬编码，**没有 `DOUYIN_USER_AGENT`**）。
- 哔哩哔哩：`BILIBILI_COOKIE`（强烈建议，穿透数据中心/海外出口 -412/-352 WAF；含失效自检告警）、`BILIBILI_USER_AGENT`（已写入 wrangler `[vars]`）。
- 小红书：`XHS_COOKIE`（可选）。微博：自动游客模式，无需 Cookie（`WEIBO_COOKIE` 已废弃）。
- Instagram：`IG_COOKIE`（强烈建议）、`IG_TIMEOUT_MS`（默认 20000）。
- QQ音乐 source+id：`QQMUSIC_COOKIE`（可选，vkey 试听接口）。X/Twitter：`TWITTER_FIXER_SERVICES`（可选，覆盖 fixer 集）。
- YouTube：`YOUTUBE_PIPED_HOSTS`（默认内置 3 个公共 Piped 候选）、`YOUTUBE_INVIDIOUS_HOSTS`（默认**不启用**，需显式配置或自托管）、`YOUTUBE_API_KEY`（Data API v3，仅优先元数据，无直链）、`YOUTUBE_API_TIMEOUT_MS`（默认 5000）、`YOUTUBE_SOURCE_TIMEOUT_MS`（默认 6000）。yt-dlp 已不参与 YouTube。
- 音乐：`MUSIC_API_BASE` / `MUSIC_API_BASES`（GD 契约上游链；公共实例对数据中心出口会被 CF 人机校验拦，线上需自建可直连实例）。自研直连搜索（`/api/music/self`）为代码内直连实现，无需额外环境变量。
- 统计：`TURSO_DB_URL` + `TURSO_AUTH_TOKEN`（未配置静默禁用）、`STATS_API_KEY`（`/api/stats` Bearer，未配置 403）、`TURSO_HTTP_TIMEOUT_MS`（可选，Turso 单次请求超时，默认 8000ms，夹在 500~60000；跨境链路或经代理访问 `turso.io` 慢时用它放宽，3s 级超时在跨境链路上必然误报「存储不可用」）。
- 平台引擎与设置页：`MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY`（正向覆盖，JSON 对象或 `"all"`）、`MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` / `MUSIC_PLATFORM_OFF`（黑名单，最终闸门）；`MUSIC_BUILTIN_PLAY`（**内置播放引擎总开关**：站点自带取直链通道 GD / 自研直连的总闸，`off` = 运维终闸 / 设置页「部署锁定」，`on` / 留空 = 基线开启可由面板开关；关闭后 `action=url` 一律 400、resolve 回 `engine-missing`，**搜索等数据通道不受影响**）；`SETTINGS_API_KEY`（设置页登录密钥，亦为 `PUT`/`DELETE /api/music/caps` 的 Bearer 密钥；未配置时 caps 端点 `editable=false`、设置页只读且无法登录）；`SETTINGS_SESSION_SECRET`（可选，设置页会话令牌签名密钥，缺省回落 `SETTINGS_API_KEY`，轮换即让全部会话失效）。
- 开关：`VIDEO_PARSE_ENABLED`（`"true"` 才放开视频解析入口，wrangler `[vars]` 已配）。
- 蜜罐：`NEXT_PUBLIC_SITE_URL`（蜜罐页引导 URL 前缀，默认站点）。
- 测试：`RUN_LIVE_PARSE=1`、`RUN_LIVE_RESOLVE=1`、`LIVE_URL_*`（真机分享链接，模板 `tests/live/urls.example.env`，含可选 `LIVE_URL_BILIBILI_OPUS`）、`LIVE_PARSE_TIMEOUT_MS`（默认 120000）。单测内部还会读写 `VITEST=true`。
- yt-dlp 备用封装：`YTDLP_BIN`、`YTDLP_TIMEOUT_MS`（默认 25000）。

## 约定

- 语言风格：核心逻辑/API 为 `.js`，页面组件为 `.tsx`，类型集中在 `src/types/`。
- 路径别名 `@/* → ./src/*`（`tsconfig.json` + `vitest.config.mts`）。
- API 统一响应 `{ code, msg, data?, platform? }`；成功 `code:200`；字段契约以 `src/types/api.ts`、`API.md`、`normalize-result.ts` 为准。业务态错误尽量带 `failType`（`bot-gated` / `sources-down` / `source-unavailable` / `script-error` 等），前端据此区分提示与降级。
- 路由一律 `nodejs` runtime（勿引入对 Worker runtime 不兼容的依赖到 route 里）。
- 平台清单保持单一数据源：识别/`source+id` 能力改 `lib/platforms.ts`；解析路由注册改 `lib/platformRoutes.js`；前端平台元数据/排序/图标改 `src/config/video-platforms.ts`。README/API/CLAUDE 中的平台与接口清单由这些配置推导而来，改代码时同步更新文档。
- 请求外部平台遵循“最小打扰”：限流、UA、Referer、Cookie 治理都在中间件/解析器头部完成，新平台照抄既有路由的骨架（短链跟随超时、`AbortSignal.timeout`、UA 常量）。

## 部署

- **Vercel**：导入即用；注意公共 GD 上游对数据中心出口会触发 CF 人机校验，`/api/music` 需 `MUSIC_API_BASE(S)` 指向可直连实例；TikTok（yt-dlp child_process）在 Serverless 不可用。
- **Cloudflare Workers**（OpenNext）：`npm run build:cf` → `.open-next/`；`wrangler.toml` 已配 `[vars]`/`[assets]`；敏感 Cookie 经 GitHub Actions `wrangler secret put` 注入（`.github/workflows/deploy-cloudflare.yaml`）。
- **Docker（当前线上正式运行方式）**：多阶段 `Dockerfile`（standalone 产物）内置 yt-dlp + ffmpeg（TikTok 依赖）并以非 root 运行；`.github/workflows/deploy-to-docker.yaml` 手动触发发布。
- 开发依赖含 `@opennextjs/cloudflare`（`build:cf`）、`vitest`；未配置 prettier/format 脚本，代码风格靠 ESLint（`npm run lint`）约束。改动组件后跑 `npm run lint` 自查。
