# CLAUDE.md

本文件给在仓库内写代码/改代码的 AI 助手（Claude Code / CodeBuddy 等）提供工作指引。目标：改完代码后 `README.md`、`API.md`、`CLAUDE.md` 中描述的平台、接口、环境变量、目录职责依然与实际实现一致。

文档地图：`README.md`（产品与接口速览）、`API.md`（接口契约 + 环境变量全量）、`docs/architecture.md`（架构细节 / 目录约定 / 平台接入 SOP / 依赖须知）、`docs/ROADMAP.md`（演进计划）、`docs/REFACTOR-PLAN.md`（代码质量整改批次）。

## 项目概况

`MadiaGet`（品牌「即刻解析」，线上 <https://get.hotier.cc.cd>）是一个 Next.js 16（App Router + React 19）解析下载站，含两大产品模块：

1. **视频/图文/音乐内容解析（首页 `/`）**：支持 **13 个平台**（抖音、快手、微博、哔哩哔哩、小红书、汽水音乐、西瓜视频、最右、AcFun、TikTok、X/Twitter、Instagram、YouTube），输入分享链接 / 整段分享文案 /（部分平台）`source+id`，自动识别平台与内容类型并输出无水印直链（清单以 `src/config/video-platforms.ts` 与 README 为准；QQ音乐 的歌曲链接归音乐区，不走视频解析核心）。
2. **音乐解析中心（`/music`）**：多源聚合搜歌 / 试听 / 播放 / 歌词 / 封面 / 下载——默认 GD 聚合上游（`/api/music`，网易云/酷我/JOOX 等搜索）+ 自研直连搜索（`/api/music/self`，服务器直连腾讯/酷狗/咪咕等五家搜索，独立搜索源 chips）+ 歌曲链接解析（`/api/music/resolve`，酷狗与「被停用播放引擎的 QQ」返回 `engine-missing`）。平台「搜索引擎 / 播放引擎」为部署可配开关（env 覆盖 + 设置页 `/music/settings` 写 Turso 配置文档 `music.flags`，两维默认 6 平台全开）。**完整链路、开关变量与求值顺序见 `docs/architecture.md` §3 与 API.md §12。**

另有静态页：FAQ（`/faq`）、法律页（`/legal/{terms,privacy,dmca}`）、`robots.ts` / `sitemap.ts`；全站 PWA、深浅主题（默认跟随系统）。

技术形态：API 层与核心逻辑多为 **`.js`（ESM import/export）**，页面/组件/工具为 **TS/TSX**；前端是客户端会话式 SPA 页面（会话存 `sessionStorage`），后端是 API Route Handler，**除 `_diag/route.ts` 外全部为 `route.js`，且全部显式 `export const runtime = "nodejs"`**。

## 常用命令

```bash
npm run dev          # 开发（next dev --turbopack）
npm run build        # 生产构建（next build --webpack，Serwist 需要 webpack）
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
4. **改 `packages/parse-core/**` 前必须先向用户报告**：这是独立发布的解析内核，web 薄壳（`src/lib/*`）、桌面端、CLI 与外部 npm 使用者共用同一份代码，改它等于改下游契约。动手前列出改动文件、行为变化、公开导出是否变动与 semver 级别（major / minor / patch），确认后再改；未被点名不要顺手改。

## 环境变量

敏感 Cookie 只进服务端环境变量（平台路由在 Node runtime 读），**不要写入 `wrangler.toml` / 前端可及文件**。完整说明与示例在 `API.md`「限制说明 → 环境变量配置」，此处给速查：

- 抖音：`DOUYIN_COOKIE`（可选，仅增强；UA 轮询已硬编码，**没有 `DOUYIN_USER_AGENT`**）。
- 哔哩哔哩：`BILIBILI_COOKIE`（强烈建议，穿透数据中心/海外出口 -412/-352 WAF；含失效自检告警）、`BILIBILI_USER_AGENT`（已写入 wrangler `[vars]`）。
- 小红书：`XHS_COOKIE`（可选）。微博：自动游客模式，无需 Cookie（`WEIBO_COOKIE` 已废弃）。
- 快手：`KUAISHOU_COOKIE`（可选，**只补作者主页的简介 / 获赞**；视频解析匿名即可，Cookie 只发 `www.kuaishou.com` 第一方，失效自动降级为匿名结果）。
- Instagram：`IG_COOKIE`（强烈建议）、`IG_TIMEOUT_MS`（默认 20000）。
- X/Twitter：`TWITTER_FIXER_SERVICES`（可选，覆盖 fixer 集）。
- YouTube：`YOUTUBE_PIPED_HOSTS`（默认内置 3 个公共 Piped 候选）、`YOUTUBE_INVIDIOUS_HOSTS`（默认**不启用**，需显式配置或自托管）、`YOUTUBE_API_KEY`（Data API v3，仅优先元数据，无直链）、`YOUTUBE_API_TIMEOUT_MS`（默认 5000）、`YOUTUBE_SOURCE_TIMEOUT_MS`（默认 6000）。yt-dlp 已不参与 YouTube。
- 音乐：`MUSIC_API_BASE` / `MUSIC_API_BASES`（GD 契约上游链；公共实例对数据中心出口会被 CF 人机校验拦，线上需自建可直连实例）。自研直连搜索（`/api/music/self`）为代码内直连实现，无需额外环境变量。
- 统计：`TURSO_DB_URL` + `TURSO_AUTH_TOKEN`（未配置静默禁用）、`STATS_API_KEY`（`/api/stats` Bearer，未配置 403）、`TURSO_HTTP_TIMEOUT_MS`（可选，Turso 单次请求超时，默认 8000ms，夹在 500~60000；跨境链路或经代理访问 `turso.io` 慢时用它放宽，3s 级超时在跨境链路上必然误报「存储不可用」）。
- 平台引擎与设置页：`MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY`（正向覆盖，JSON 对象或 `"all"`）、`MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` / `MUSIC_PLATFORM_OFF`（黑名单，最终闸门）；`MUSIC_BUILTIN_PLAY`（**内置播放引擎总开关**：站点自带取直链通道 GD / 自研直连的总闸，`off` = 运维终闸 / 设置页「部署锁定」，`on` / 留空 = 基线开启可由面板开关；关闭后 `action=url` 一律 400、resolve 回 `engine-missing`，**搜索等数据通道不受影响**）；`SETTINGS_API_KEY`（设置页登录密钥，亦为 `PUT`/`DELETE /api/music/caps` 的 Bearer 密钥；未配置时 caps 端点 `editable=false`、设置页只读且无法登录）；`SETTINGS_SESSION_SECRET`（可选，设置页会话令牌签名密钥，缺省回落 `SETTINGS_API_KEY`，轮换即让全部会话失效）。
- 开关：`VIDEO_PARSE_ENABLED`（`"true"` 才放开视频解析入口，wrangler `[vars]` 已配）。
- 媒体代理：`/api/image`、`/api/video-proxy` 默认只中转平台已知媒体 CDN（清单在 `src/lib/proxy-guard.js`，非白名单域 403）；`PROXY_ALLOWED_HOSTS` 追加自建媒体域，`YOUTUBE_PIPED_HOSTS` / `YOUTUBE_INVIDIOUS_HOSTS` 自动放行；`PROXY_SSRF_STRICT` 默认 `true` 强拦截，`false` 回退仅记录。出站流量按「天 + 端点」写 Turso `proxy_traffic_daily`（`src/lib/proxy-traffic.js`，60s / 4MB / 500 次窗口聚合），经 `/api/stats` 的 `proxyTraffic` 查看；图片有 Cache API 边缘缓存（Workers 下生效，响应带 `X-Proxy-Cache`）。
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
- **Docker（当前线上正式运行方式）**：多阶段 `Dockerfile`（standalone 产物，基镜像 `node:22-alpine`——Next 16 最低 20.9，20.x 已 EOL）内置 yt-dlp + ffmpeg（TikTok 依赖）并以非 root 运行。发布已**不再走 GitHub Actions**（原 `.github/workflows/deploy-to-docker.yaml` 移除）：改本地/服务器 `docker build -t <image> .` 后手动跑容器，等价运行参数：
  `docker run -d --name <repo> --restart unless-stopped --init --env-file /opt/1panel/apps/openresty/openresty/www/sites/parse.shenzjd.com/index/.env -p 5269:3000 <image>`
  （`--init` 必需：node 作 PID1 不回收孤儿进程；PO Token 用的 bgutil 容器是独立自建工程，本仓不启停，地址经 `.env` 的 `POT_BASE_URL` 配置）。历史自动发布配方留在 git 历史里可查。
- **Cloudflare Workers（OpenNext）**：`wrangler.toml` + `open-next.config.ts`（无 ISR，静态页走 `ASSETS` 绑定直出，解析结果缓存由 `src/lib/result-cache.js` 的 Cache API 层负责）。命令：`npm run build:cf` → `npm run preview:cf`（workerd 本地预演）→ `npm run deploy:cf`；也可手动触发 `.github/workflows/deploy-cloudflare.yaml`（需仓库 Secrets `CF_API_TOKEN` / `CF_ACCOUNT_ID`），运行时敏感变量用 `npx wrangler secret put <NAME>`。兼容面：`compatibility_date = 2026-03-17` + `nodejs_compat`——`node:http(s)` 客户端自 2025-08-15、`child_process` 桩自 2026-03-17 起才随 compat 生效，调低会分别破坏抖音 DoH 兜底与 TikTok 路由加载（两者现已改为惰性 import，不支持时只降级不炸包）。TikTok 无 yt-dlp，仅 Docker 可用；免费档 10ms CPU / 50 子请求/次 撑不住重试链路，线上用 Paid。
- **Netlify（备用 / 演示）**：根目录 `netlify.toml`（Next.js Runtime v5，`build` 仍走 `npm run build` 以保留 `--webpack`）。可用：页面、静态资源、解析接口、音乐链路；不可用/受限：同步函数默认 10s 超时（IG 20s、YouTube 双源、B站重试易超时）、响应体 6MB 上限（`/api/video-proxy` 大视频被截断，Range 透传无保证）、无子进程（TikTok 不可），`result-cache` 无 Cache API 时退化为进程内 Map。敏感变量走 Site settings → Environment variables。
- **CI**：`.github/workflows/ci.yaml`——push main / PR / 手动触发，跑 `npm test`（含 `tests/parse-core-shells.test.ts` 的 parse-core 薄壳 ↔ 真源一致性守卫）→ `tsc --noEmit` → `npm run build:cf`（内含 `next build`，同时校验常规 Next 产物与 OpenNext Workers 产物，不再单独跑 `next build`）。只检查，不部署、不出镜像；Cloudflare 部署是独立的 `deploy-cloudflare.yaml`（手动触发，只发布，构建校验由 CI 负责）。
- **Next 版本**：Next 16.4.3（16 默认 Turbopack，但 `npm run build` 显式带 `--webpack`——PWA 仍靠 webpack 插件在构建期产出 SW）。PWA 已从停更的 `@ducanh2912/next-pwa` 迁到 `@serwist/next`：SW 源码 `src/sw.ts`，运行时缓存规则（`/api` 永不缓存 / 文档 NetworkFirst / 静态资源 SWR）在该文件里维护；dev 下 `disable` 关闭 SW，所以 `next dev --turbopack` 不受影响。OpenNext 与 Next 16 搭配有硬门槛：`@opennextjs/cloudflare` >= 1.20.13（peer `next >=16.4.1`）且 `wrangler` >= 4.148，低于此会出现 `Unexpected loadManifest(...preview-props.json)` 之类的 server manifest 报错。
- **`package-lock.json` 只能用 npm 10 重生成**（CI 的 node 22 自带 npm 10）。本机 npm 11 写锁会裁掉跨平台 optional 叶子（`@esbuild/*`、`@cloudflare/workerd-*`）和 wasm peer（`@emnapi/core`、`@emnapi/wasi-threads`），ubuntu runner 上 `npm ci` 随即报 `Missing: ... from lock file`。改依赖后若在本机生成过锁，先 `npx npm@10 ci --dry-run`（干净临时目录里）验证再提交。
- 开发依赖含 `@opennextjs/cloudflare`（`build:cf`）、`vitest`；未配置 prettier/format 脚本，代码风格靠 ESLint（`npm run lint`）约束。改动组件后跑 `npm run lint` 自查。
