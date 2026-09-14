# CLAUDE.md

本文件给在仓库内写代码/改代码的 AI 助手（Claude Code / CodeBuddy 等）提供工作指引。目标：改完代码后 `README.md`、`API.md`、`CLAUDE.md` 中描述的平台、接口、环境变量、目录职责依然与实际实现一致。

文档地图：`README.md`（产品与接口速览）、`API.md`（接口契约 + 环境变量全量）、`docs/architecture.md`（架构细节 / 目录约定 / 平台接入 SOP / 依赖须知）、`docs/ROADMAP.md`（演进计划）、`docs/REFACTOR-PLAN.md`（代码质量整改批次）。

## 项目概况

`mediaGet`（品牌「即刻解析」，线上 <https://get.hotier.cc.cd>）是一个 Next.js 15（App Router + React 19）解析下载站，含两大产品模块：

1. **视频/图文/音乐内容解析（首页 `/`）**：支持 **21 个平台**（抖音、快手、微博、哔哩哔哩、小红书、汽水音乐、皮皮虾、皮皮搞笑、西瓜视频、最右、虎牙、AcFun、全民K歌、QQ音乐、六间房、新片场、好看视频、TikTok、X/Twitter、Instagram、YouTube），输入分享链接 / 整段分享文案 /（部分平台）`source+id`，自动识别平台与内容类型并输出无水印直链（清单以 `src/config/video-platforms.ts` 与 README 为准）。
2. **音乐解析中心（`/music`）**：多源聚合搜歌 / 试听 / 播放 / 歌词 / 封面 / 下载——默认 GD 聚合上游（`/api/music`，网易云/酷我/JOOX 等搜索）+ 自研直连搜索（`/api/music/self`，服务器直连腾讯/酷狗/咪咕等五家搜索，独立搜索源 chips）+ 歌曲链接解析（`/api/music/resolve`，酷狗与「被停用播放引擎的 QQ」返回 `engine-missing`）。平台「搜索引擎 / 播放引擎」为部署可配开关（env 覆盖 + 设置页 `/music/settings` 写 Turso 配置文档 `music.flags`，两维默认 6 平台全开）。**完整链路、开关变量与求值顺序见 `docs/architecture.md` §3 与 API.md §12。**

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

> 后端骨架 / 音乐链路 / 前端结构 / 关键 lib / 目录约定 / 平台接入 SOP / 依赖须知，统一维护在 **`docs/architecture.md`**——本文不再复制一份，避免两处描述逐渐分叉。

改代码前先记住三条红线：

1. **平台/功能路由一律 `createApiHandler(parseFn)` 包装**，不要绕过中间件自造轮子（CORS / 蜜罐 / 限流 / SSRF / 归一化 / 缓存 / 统计全在职责链里）。
2. **域名唯一真源是 `lib/platforms.ts` 的 `PLATFORM_INFO`**：`ROUTE_DOMAIN_MAP`（中间件白名单）与 `ALL_DOMAINS` 都由它推导；另写一份会被 `tests/platform-metadata.test.ts` 挡下。
3. **依赖方向单向**：`src/lib/**` 不得 import `src/components/**`；跨模块共享类型放 `src/types/`。

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

- 语言风格：核心逻辑/API 为 `.js`，页面组件为 `.tsx`。
- **类型归属**（此前写「类型集中在 `src/types/`」，与实际不符，已修正）：只有**跨模块共享契约**放 `src/types/`（`api.ts` 解析契约、`music.ts` 音乐类型）；平台/前端展示配置类型留在 `src/config/*.ts`；仅单文件使用的类型就近声明。
- 路径别名 `@/* → ./src/*`（`tsconfig.json` + `vitest.config.mts`）。
- API 统一响应 `{ code, msg, data?, platform? }`；成功 `code:200`；字段契约以 `src/types/api.ts`、`API.md`、`normalize-result.ts` 为准。业务态错误尽量带 `failType`（`bot-gated` / `sources-down` / `source-unavailable` / `script-error` 等），前端据此区分提示与降级。
- 路由一律 `nodejs` runtime（勿引入对 Worker runtime 不兼容的依赖到 route 里）。
- 平台清单保持单一数据源：识别/`source+id` 能力改 `lib/platforms.ts`；解析路由注册改 `lib/platformRoutes.js`；前端平台元数据/排序/图标改 `src/config/video-platforms.ts`。README/API/CLAUDE 中的平台与接口清单由这些配置推导而来，改代码时同步更新文档。
- 请求外部平台遵循"最小打扰"：限流、UA、Referer、Cookie 治理都在中间件/解析器头部完成，新平台照抄既有路由的骨架（短链跟随超时、`fetchWithTimeout` + `TIMEOUT` 常量、`src/lib/http.ts` UA 常量池）。
- **新增平台的完整步骤**见 `docs/architecture.md` §6（平台接入 SOP）；**不可删/不可升的依赖**见同文 §7。
- **文件命名**（`src/components/**` 适用）：
  - 组件文件用 **PascalCase**（`PlayerBar.tsx`、`EqBars.tsx`）；hook / store / 工具模块用 **kebab-case**（`use-player-engine.ts`、`favorites-store.ts`、`lyric-utils.ts`）。
  - 例外：`next/dynamic` 的**懒加载实现模块**（`amll-player.tsx`、`amll-background.tsx`）保持 kebab-case——它们不被直接 import，只作为 `dynamic(() => import(...))` 的目标，kebab 正好标出"内部实现、勿直接引用"。
  - **禁止**两个文件仅首字母大小写之差（`AmllBackground.tsx` / `amll-background.tsx` 曾如此）：Windows 不敏感、Linux / CI 敏感，极易解析错。懒加载要么内联在使用方文件里，要么让实现文件换个不同的名字。

## 部署

- **Vercel**：导入即用；注意公共 GD 上游对数据中心出口会触发 CF 人机校验，`/api/music` 需 `MUSIC_API_BASE(S)` 指向可直连实例；TikTok（yt-dlp child_process）在 Serverless 不可用。
- **Cloudflare Workers**（OpenNext）：`npm run build:cf` → `.open-next/`；`wrangler.toml` 已配 `[vars]`/`[assets]`；敏感 Cookie 经 GitHub Actions `wrangler secret put` 注入（`.github/workflows/deploy-cloudflare.yaml`）。
- **Docker（当前线上正式运行方式）**：多阶段 `Dockerfile`（standalone 产物）内置 yt-dlp + ffmpeg（TikTok 依赖）并以非 root 运行；`.github/workflows/deploy-to-docker.yaml` 手动触发发布。
- 开发依赖含 `@opennextjs/cloudflare`（`build:cf`）、`vitest`；未配置 prettier/format 脚本，代码风格靠 ESLint（`npm run lint`）约束。改动组件后跑 `npm run lint` 自查。
