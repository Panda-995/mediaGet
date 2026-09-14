# 架构说明

> 本文是 `CLAUDE.md` 的架构分册（P3-5 从 `CLAUDE.md` 拆出），面向**要改代码的人**。
> 产品/接口契约见 `README.md` 与 `API.md`，演进计划见 `docs/ROADMAP.md`，整改批次见 `docs/REFACTOR-PLAN.md`。
> 本文件是目录约定、平台接入 SOP、依赖须知的**唯一说明处**，`CLAUDE.md` 只保留索引与速查，避免两处各写一份导致腐化。

## 1. 目录约定

| 路径 | 放什么 | 不放什么 |
| --- | --- | --- |
| `src/app/api/<platform>/route.js` | 单个平台的解析路由（纯解析函数 + `createApiHandler` 包装） | 跨平台共用逻辑（放 `src/lib/`） |
| `src/lib/` | **服务端**层：解析基础设施、平台解析、音乐链路、HTTP 公共能力 | 反向 import `src/components/**`（已清零，勿再引入） |
| `src/lib/client/` | 仅浏览器可用的模块（如 `music-client`） | 服务端逻辑 |
| `src/components/` | 页面组件与展示组件 | 服务端解析逻辑 |
| `src/types/` | 跨模块共享契约类型：`api.ts`（解析契约）、`music.ts`（音乐） | 平台专属类型（就近声明） |
| `src/config/` | 前端平台元数据与展示配置（`video-platforms.ts`、`site.ts`） | 服务端识别逻辑（在 `lib/platforms.ts`） |
| `src/hooks/`、`src/utils/` | 前端 hook 与纯工具 | — |
| `tests/` | `vitest` 单测；`tests/live/` 为真机测试（env 控制，默认跳过） | — |

- 文件命名：组件 **PascalCase**（`PlayerBar.tsx`），hook / store / 工具模块 **kebab-case**（`use-player-engine.ts`）。
- 例外：`next/dynamic` 的懒加载实现模块保持 kebab-case（`amll-player.tsx`、`amll-background.tsx`），标注"内部实现、勿直接引用"。
- **禁止**两个文件仅首字母大小写之差（Windows 不敏感、Linux / CI 敏感）。大小写重命名在 Windows 上必须走两步（`git mv a.tsx tmp.tsx` → `git mv tmp.tsx A.tsx`），否则 git 索引里仍是旧名。
- API 层与核心逻辑多为 `.js`（ESM），页面/组件/工具为 TS/TSX。

## 2. 后端：`src/app/api/**`

**统一路由骨架**：平台/功能路由一律 `export const GET = createApiHandler(parseFn[, options])`。`createApiHandler`（`src/lib/api-middleware.ts`）把一个「纯解析函数」包装成完整 HTTP 接口，职责链依次为：

CORS → IP 黑名单蜜罐（`lib/honeypot.ts`）→ IP 级限流 60 次/分（`lib/api-utils.js`）→ 平台级真实抓取节流（`lib/anti-bot.js`，默认 30 次/分/平台）→ URL 校验 + SSRF 白名单 → 解析执行 → `normalizeResult` 归一化统一契约 → 成功结果 5 分钟进程内缓存（`shouldCache`）→ `analytics.recordParse` 行为统计（Turso，可选）→ 统一错误响应；`fmt=text` 也由中间件统一处理。

**不要绕过中间件自造轮子**，新增平台解析器只需返回 `{ code, msg, data }`。

**统一入口**：`/api/parse`（GET/POST）与 `/api/parse-text`（纯 `text=` 文案的兼容别名）都是薄壳，真实逻辑在 `src/lib/parse-handler.js`：

`unified-parser.js` 识别平台（`lib/platforms.ts` 的 `PLATFORM_INFO` 决定识别与 `source+id` 能力）→ `lib/blockedPlatforms.ts` 黑名单（微信视频号与付费/DRM 平台）→ 按 `lib/platformRoutes.js`（平台 key → route 的唯一映射）动态 import 解析器 → 解析后写入 **24h 共享结果缓存**（`lib/result-cache.js`，Cloudflare Cache API，命中时先探测主直链，404/410 死链自动重解析）。

**平台解析器风格**：多数是 route 内独立 async 函数（短链跟随 → 伪装 UA 抓页面/接口 → 提内嵌 JSON）；快手是类（`lib/kuaishouCore.js`）；TikTok 走 `lib/tiktokDlp.js`（yt-dlp child_process，**仅 Docker/带二进制环境可用**）；YouTube 为纯 HTTP 多源竞速（`lib/youtube.js`）；Instagram（`lib/instagram.js`）已全面登录墙，需 `IG_COOKIE`。

**资源代理**：`/api/video-proxy`（视频流：按平台补 Referer 防盗链、Range/206、`download=1`、twitter CDN 特殊处理；超时/重试）与 `/api/image`（图片字节代理，内存 LRU 6h，小红书/微博/快手图床需带 Referer）。二者入口统一走 `lib/proxy-guard.js`（IP 黑名单 + 限流 + SSRF 白名单，后者带 `PROXY_SSRF_STRICT` 灰度开关）。前端是否走代理由 `utils/videoProxy.ts` 判定。

**辅助端点**：`/api/health`、`/api/config`（读 `VIDEO_PARSE_ENABLED`）、`/api/stats`（Turso 统计，需 `STATS_API_KEY`）、`/api/rate-limit`、`/api/engines`（平台路由体检）、`/api/_diag`（临时诊断，用完即删）。

## 3. 音乐链路

- `/api/music`（provider=gd）：`lib/gdmusic.js` 按 GD(gdstudio) 契约组装 `types=url/search/pic/lyric` 请求，`getUpstreamBases` 多基址按序回退（8s 总预算）。action 支持 `search/pic/lyric/url(默认)`；另有 `bin=1` 与 `fmt=text`。搜索 action 仅开放 netease/kuwo/joox。路由本体只做 CORS / 限流 / 参数归一化 + 分派，四个 action 实现在 `src/lib/music-actions/`（`search.js` / `pic.js` / `lyric.js` / `url.js`，共用部分在 `shared.js`，映射表在 `index.js`）。
- `/api/music/self`（自研直连搜索，仅 `action=search`）：`lib/self-search/`（index/errors + netease/tencent/kugou/kuwo/migu 每平台一模块，移植 lx-music musicSdk 并自研签名）服务器直连五家搜索 API，source 沿用 GD 命名，归一为 GD 搜索同契约 SearchItem（line 标注 `kind=self`）。三条价值：(1) tencent/kugou/migu 是 GD 未开放搜索的**独立搜索源 chips**；(2) netease/kuwo 双通道（自研失败才回退 GD 搜索引擎）；(3) 封面不强求——能内嵌的写入 `picUrlDirect` 直接展示。migu 无内置直链引擎（`SELF_ONLY_ENGINE_KEYS`），点播提示"该音源暂未接入试听直链引擎"。
- `/api/music/resolve`：`lib/music-link.ts` 纯函数识别链接（SSRF 面收敛：不直接请求用户链接，官方短链服务端跟随一次重定向）→ 按平台直链引擎补元数据并产出 SearchItem，播放直链由 `/api/music` `action=url` 实时取（不预取）。网易（`lib/netease-meta.js`）、QQ音乐（`lib/qqmusic.js`）、酷我（`lib/kuwo-meta.js`）ready；各平台详情失败均降级占位标题仍可播（`metadata=fallback`）。酷狗识别成功仍 `engine-missing`，无法识别 400。
- `/api/music/caps`：平台能力矩阵 + 设置写入端点。`GET`（公开）下发生效矩阵与 `baseline` / `overrides` / `locked` / `behavior` / `editable` / `blockedReason`；`PUT`（全量矩阵 + 自动换源行为）与 `DELETE`（恢复部署基线）需 `Authorization: Bearer <SETTINGS_API_KEY>` 或设置页登录会话 Cookie（`lib/music-settings-auth.js`）。另有 `/api/music/settings/session`（`POST` 登录 / `GET` 查询 / `DELETE` 登出）。求值为两段式（无文档 = 默认→env 正向→env 终闸；有文档 = 文档全量→env 终闸），配置文档存 Turso `app_settings`（key `music.flags`），进程内 TTL 15s 缓存 + 写后失效。存储不可用 / 文档损坏时读路径回落基线不阻塞听歌，只有写入报 503。**「没配置存储」与「配了但连不上」必须严格区分**（`lib/settings-store.js` 的 `getStoreStatus()` 记录最近一次故障原因）。详见 API.md §12。

## 4. 前端

- 页面：`src/app/page.tsx`（首页解析会话状态机 + 平台网格 + 结果卡 + `failType` 差异化错误展示）、`src/app/music/page.tsx`（MusicExplorer 全屏音乐播放器 + 歌词）、`src/app/music/settings/page.tsx`（服务端会话守卫的平台引擎设置页）+ `src/app/music/settings/login/page.tsx`、`faq`、`legal/*`。`layout.tsx` 含主题三段脚本与 JSON-LD/PWA manifest。
- 表单与展示：`src/components/VideoParserForm.tsx`（剪贴板、防抖、平台指定）；`src/components/videos/` 每平台一个展示组件，`platform-renderers.tsx` 按平台/content 类型分发（图文图集多选下载、多分P清晰度、在线播放、复制直链）。
- 音乐 UI：`src/components/music/MusicExplorer.tsx`、`LyricPage`、`PlayerBar` 等，以及平台引擎设置共享表单 `MusicSettingsForm.tsx`（齿轮入口在内容区 `.mp-tools`，改用 `<Link>` 跳转 `/music/settings`；被设置页与登录页复用；草稿/diff/提交/密钥逻辑抽在 `use-music-settings.ts`）。
- 请求层 `src/lib/client/music-client.ts`（barrel，实现按通道拆在 `music-client-{core,search,direct,media,meta}.ts`）：同源代理优先 + GD 公共源直连兜底（仅 provider=gd 可直连）。浏览器端用**源通道引擎抽象**（`sourceEngineKindFor` / `sourceEngineCapsFor` 把 source 归入 `gd|self`，`trackDownloadSpec` / `coverBinUrl` 决策 bin 字节下载 / 封面取色 URL）——**UI 不得自己拼 `/api/music` URL 或读 `isDirectUsed`**；搜索引擎注册视图由 `source-meta.ts` 的 `buildSearchChips` 统一构建。
- **聚合搜索**：SearchPanel chips 行首「聚合搜索」伪 chip（`aggActive`）开启，一次 `searchAcrossSources`（平台级限流闸 ≤3 路并发、逐源失败隔离）拉全部可用源第 1 页，`music-match.ts`（纯函数：文本清洗/关键词相关度打分/跨源同曲判定与去重）合并排序；去重与打分规则与播放失败自动换源共用同一套实现。聚合列表无翻页、不落播放快照；部分源失败以 `pageErr` 尾部提示、全部失败给空态说明。
- **播放失败自动换源**由 `use-player-engine.ts` 收敛：resolve（取直链失败）与 play（`<audio>` 媒体层报错）双阶段都进入 token 化有界自动换源——先遍历队列内同曲高置信候选，再跑一轮**跨源现搜**（`suggestCrossCandidates`，复用聚合闸），两段共用同一尝试预算；失败收尾时把未尝试过的候选以 `alternatives` 暴露给 UI，`MusicExplorer` 据此弹 `AltSelectDialog` 人工选版。四项行为（总开关 / 单轮上限 `maxAttempts` 默认 4 / 跨源现搜 / 失败弹人工选版）由部署级设置面板下发。**候选挑选与合并已抽到 `alt-candidates.ts`（纯函数）**，transport 层仍在主文件（拆前需先补 `renderHook` 测试，见 `docs/REFACTOR-PLAN.md` P2-5）。
- **系统媒体会话**由 `use-media-session.ts` 收敛：元数据用专辑封面、无封面时回退平台品牌 logo（`platform-brand.ts` 提供 label/强调色/`public/logos` SVG；系统控件不渲染 SVG，故栅格化为 PNG），播放态 / 进度 / 媒体键回灌播放引擎。通用内核在 `src/components/media-session/`（`use-now-playing.ts`、`brand-artwork.ts`），音乐与视频两侧只做字段映射（视频侧 `videos/use-video-media-session.ts` + `VideoPosterCard.tsx`，多分P跟随当前播放项）。
- **本地缓存层**（浏览器侧，`src/components/music/`）：播放偏好 `player-prefs.ts`、音乐页视图 `music-view-store.ts`、上次播放会话 `playback-session.ts`、播放列表快照 `playlist-cache.ts`、最近搜索 `search-history.ts`、个人收藏 `favorites.ts` + `favorites-store.ts`、歌词与封面配色 `media-cache.ts`；只存本机、绝不落带时效的直链，载体 / TTL / 读写口径见 `src/components/music/musicEngine.md` §7.4。收藏的四处入口共用 `FavoriteButton.tsx`；收藏只存曲目身份与元数据（含取直链要用的 `urlId`），点播时现取直链。
- `src/components/ui/` 是基于 shadcn/ui 规范生成的基础组件（CVA + tailwind-merge + 少量 radix primitives），改 UI 优先复用其中封装。

## 5. 关键 lib 一览（`src/lib/`）

- 解析基础设施：`api-utils.js`（缓存/限流/URL校验/日志/北京时区/取客户端 IP）、`api-middleware.ts`、`normalize-result.ts`、`result-cache.js`、`parse-handler.js`、`unified-parser.js`、`platformRoutes.js`、`platforms.ts`、`share-text.ts`（服务端抽链接，与前端 `utils/share.ts` 行为对齐）、`blockedPlatforms.ts`、`anti-bot.js`、`honeypot.ts`、`analytics.js` + `turso-client.js`、`http.ts`（`TIMEOUT` 常量组 + UA 常量池 + `fetchWithTimeout`）、`lru-cache.ts`（`createTtlCache` 有界 TTL 容器）、`proxy-guard.js`（代理端点统一安防）。
- 平台解析：抖音（route 内 + `douyin-extract.js` / `douyinFallback.js`）、`kuaishouCore.js`、bilibili（route 内 + `bilibili-opus.js` 图文、`bilibili-cookie-guard.js` 失效告警）、`instagram.js`、`tiktokDlp.js`、`ytDlpClient.js`（备用封装）、`youtube.js`、`qqmusic.js` / `qqmusic-id.js` / `qqmusic-sign.js`，其余小平台解析内联在各 route。
- 音乐：`gdmusic.js`、`music-link.ts`、`netease-meta.js`；`music-platform-flags.js`（平台双维开关真源 + `MUSIC_BEHAVIOR_DEFAULTS` / `LIMITS` + `lockedPlatformKeys` 终闸）、`music-effective-flags.js`（配置文档校验/规范化 + 两段式求值）、`settings-store.js`（Turso `app_settings` 单表键值存储 + TTL 缓存）、`music-actions/`（`/api/music` 四 action 实现）；`self-search/`（自研直连搜索 + `errors.js` + `retry.js`）。
- 前端工具：`utils/share.ts`、`utils/videoProxy.ts`、`utils/downloadImages.ts`、`utils/filename.ts`、`format.ts`（`formatCount` / `formatCountLoose`）、`dom.ts`（`scrollToElement`）。
- **类型与依赖方向**：`src/lib/**` 不得 import `src/components/**`；音乐类型在 `src/types/music.ts`，解析契约在 `src/types/api.ts`。

## 6. 平台接入 SOP（新增一个解析平台）

按顺序改，每步都能独立验证：

1. **写解析器**：新建 `src/app/api/<dir>/route.js`，`export const runtime = "nodejs"`，导出 `export const GET = createApiHandler(parseFn)`；`parseFn(url)` 返回 `{ code, msg, data }`。模板照抄结构最接近的既有平台（短链跟随用 `getRedirectLocation`、抓取用 `fetchWithTimeout` + `TIMEOUT` 常量、UA 用 `src/lib/http.ts` 常量池；平台专用 UA 留在本地文件并在注释写明原因）。
2. **注册识别**：`src/lib/platforms.ts` 的 `PLATFORMS` 加 key、`PLATFORM_INFO` 加 `{ name, nameEn, domains, shortDomains, supportsIdParse }`。**这是域名唯一真源**——`ROUTE_DOMAIN_MAP`（中间件白名单）与 `ALL_DOMAINS` 都由它推导，`tests/platform-metadata.test.ts` 会校验「声明的每个域名都能被 `identifyPlatform` 认回本平台」，写错域名会直接变红。
3. **注册路由**：`src/lib/platformRoutes.js` 的 `platformRoutes` 加 `key: () => import("@/app/api/<dir>/route.js")`。若目录名与 key 不同（如 `redbook`→`xhs`），另在 `platforms.ts` 的 `ROUTE_DIR_ALIAS` 加一行——**两处都要改**，`ROUTE_DOMAIN_MAP` 用 alias 推导目录名。
4. **前端展示**：`src/config/video-platforms.ts` 加展示元数据（名称/颜色/图标）；需要定制展示时加 `src/components/videos/<Platform>Video.tsx` 并在 `platform-renderers.tsx` 分发。
5. **回归**：`npm test`（全量单测）+ `npm run test:live`（真机解析，改前先跑一次留基线）+ 打开 `/api/engines` 看新平台是否在列。
6. **文档**：`README.md` / `API.md` 的平台清单、CLAUDE.md 概览里的平台数与名单（由配置推导，改代码时同步）。

## 7. 依赖须知（勿误删 / 勿误升）

| 包 | 状态 | 说明 |
| --- | --- | --- |
| `@pixi/*`（app / core / display / sprite / filter-blur / filter-color-matrix / filter-bulge-pinch） | **必留** | 是 `@applemusic-like-lyrics/core` 的 **peerDependencies**（AMLL 歌词特效依赖），本项目源码 0 直接引用，删了运行时会报缺包。 |
| `@pixi/filter-bulge-pinch@^5.1.1` | 版本数字与其余 `^7.4.3` 断裂，**不是笔误** | 上游该 filter 只发到 v5 线，AMLL peerDeps 声明为 `*`。升到 7.x 会装不上。 |
| `clsx` + `tailwind-merge` | 都留 | shadcn/ui 标准组合，非重叠依赖，勿合并。 |
| `@ducanh2912/next-pwa` | 必留 | PWA/SW 由 `next.config.mjs` 的 `withPWA` 生成。 |
| `bowser`、`lucide-react`、`@radix-ui/*` | 使用中 | — |

已清理：`audiomotion-analyzer`（功能被 `pseudo-spectrum.tsx` 原生 Canvas 实现取代，0 引用）、`playwright-core`（仅服务一次性调试脚本，脚本已删）。
