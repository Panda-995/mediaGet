# 即刻解析 · mediaGet

短视频解析 + 音乐解析下载服务：粘贴分享链接 / 整段分享文案，即得无水印直链。

- 在线体验：<https://get.hotier.cc.cd>
- 视频解析：`/`（首页）
- 音乐解析：`/music`

> 免责声明：本项目仅用于技术学习与搜索聚合演示，不存储、不传播任何受版权保护的内容，请勿用于商业或侵权用途。

## 功能特性

### 视频解析（首页 `/`）

- 支持 **21 个平台**的视频 / 图文 / 音频解析与下载：抖音、快手、微博、哔哩哔哩、小红书、汽水音乐、皮皮虾、皮皮搞笑、西瓜视频、最右、虎牙、AcFun、全民K歌、QQ音乐、六间房、新片场、好看视频、TikTok、X（Twitter）、Instagram、YouTube
- 输入方式：分享链接、整段分享文案（自动提取链接）或 `source+id` 直接解析（部分平台）
- 自动识别平台与内容类型（视频 / 图文 / 音乐），统一数据契约输出；支持 `fmt=text` 纯文本输出（iOS 快捷指令等）
- 图文内容图集展示、多选批量下载；哔哩哔哩支持多分 P / 清晰度选择；音乐类内容（汽水音乐 / QQ音乐）直接下载音频
- 解析结果 24h 共享缓存，再次打开秒回；直链失效自动重解析；同链接并发只抓一次
- 部分平台说明：
  - 抖音：匿名解析为主链路，可配 `DOUYIN_COOKIE` 增强
  - 哔哩哔哩：强烈建议配 `BILIBILI_COOKIE`（穿透服务器 / 数据中心出口的 -412/-352 风控）
  - 微博：自动游客模式，无需配置 Cookie
  - 小红书 / Instagram：可选配 `XHS_COOKIE` / `IG_COOKIE`（登录墙平台）
  - YouTube：纯 HTTP 多源（Piped / Invidious，可自托管）竞速解析，源不可用时自动降级为官方嵌入播放（无直链）
  - 微信视频号，以及腾讯视频 / 爱奇艺 / 优酷 / 芒果TV / Netflix / Spotify 等付费或 DRM 平台会直接提示不支持
- 平台可用性依赖各站实时接口，部分平台可能受风控 / 地区影响暂时不可用

### 音乐解析（`/music`）

- 多源聚合在线搜歌 / 试听 / 播放 / 滚动歌词 / 封面 / 下载
- 默认上游覆盖网易云 / 酷我 / JOOX 等曲库（GD 契约，支持多基址回退）；内置腾讯(QQ音乐) / 酷狗 / 咪咕 **自研直连搜索** chips（服务器直连各家搜歌，网易云 / 酷我在 GD 通道不可用时自动回退该通道）；支持**聚合搜索**：一次并发搜索全部可用音源，跨源同曲自动去重、按关键词相关度打分排序展示（单源搜索照旧保留）。平台「搜索引擎 / 播放引擎」为部署可配开关（`MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY`，两维默认 6 平台全开，可用 env 黑名单或音乐页齿轮进入的 `/music/settings` 设置页（需登录）收敛）；另有独立于平台矩阵的**内置播放引擎总开关**（站点自带取直链通道 GD / 自研直连的总闸，`MUSIC_BUILTIN_PLAY` 或设置页顶部开关，默认开启——关闭后取试听直链一律被拦，**搜索 / 歌词 / 封面 / 链接识别不受影响**；`MUSIC_BUILTIN_PLAY=off` 为运维终闸，设置页显示「部署锁定」不可再开启）
- 网易云 / QQ音乐 / 酷我 歌曲链接可一键解析为单曲（元数据 + 播放 / 下载，QQ 受播放引擎开关约束——默认放开，若部署侧停用则该链接回 `engine-missing`）；酷狗链接解析引擎待接入；咪咕自研搜索结果默认仅搜索识别（无内置直链引擎）

### 站点

- SEO：sitemap / robots / JSON-LD；FAQ（`/faq`）与法律页（`/legal/terms`、`/legal/privacy`、`/legal/dmca`）
- 深浅色主题（默认跟随系统，可手动切换）、PWA 可安装（API 响应不做 Service Worker 缓存）
- 移动端友好，解析结果与会话级恢复（刷新不丢）

## 技术栈

- Next.js 15（App Router）+ React 19，TypeScript / JavaScript 混合
- Tailwind CSS；基于 shadcn/ui 规范的基础组件；Lucide 图标
- 测试：Vitest（纯本地单测 + live 真机测试）
- 部署：Vercel / Cloudflare Workers（OpenNext）/ Docker 均支持

## 本地开发

```bash
npm install
npm run dev        # 开发（next dev --turbopack）
npm run build      # 构建
npm start          # 生产运行
npm run lint
npm test           # 单元测试（无需外网）
```

## 真机测试（live，需真实分享链接）

单测不访问外部网络；需要联网验证真实链接的 live 测试另行运行：

1. 复制 `tests/live/urls.example.env` 为项目根目录 `.env`，按模板填入各平台真实分享链接（`LIVE_URL_*`，部分平台可留空跳过）
2. 执行：

```bash
npm run test:live
```

3. 平台 Cookie 按需补充（均为可选）：`BILIBILI_COOKIE`（服务器 / 数据中心出口强烈建议）、`DOUYIN_COOKIE`、`XHS_COOKIE` 等；微博为自动游客模式，**不再需要 `WEIBO_COOKIE`**。详见 `API.md`「限制说明 → 环境变量配置」。

## 部署

- **Vercel**：仓库导入即用。注意：TikTok 解析依赖 yt-dlp（child_process），Serverless 不可用；`/api/music` 的公共上游对数据中心出口会触发 CF 人机校验，需配置 `MUSIC_API_BASE(S)` 指向可直连的兼容实例（详见 `API.md`）。
- **Cloudflare Workers**（OpenNext）：`npm run build:cf` 生成 `.open-next/`，`wrangler.toml` 已就绪；敏感 Cookie 在 Worker Settings → Variables and Secrets 配置（CI 已接入自动 `wrangler secret put`）。
- **Docker**（当前线上正式运行方式）：多阶段 `Dockerfile` 已内置 yt-dlp + ffmpeg（TikTok 解析需要），镜像以非 root 运行：

```bash
docker build -t mediaget:latest .
docker run -d -p 3000:3000 --env-file .env mediaget:latest
```

## 平台引擎设置（可选，独立路由 + 登录鉴权）

不改代码、不重新部署也能调整「平台搜索引擎 / 播放引擎」开关、「内置播放引擎总开关」与「自动换源」行为：配好 `TURSO_DB_URL` + `TURSO_AUTH_TOKEN`（存配置文档）与 `SETTINGS_API_KEY`（写入密钥）后，音乐页内容区右上角齿轮跳转到 **`/music/settings`**（专用设置页）→ 改完点保存即全站生效（多副本部署最坏 15s 传播延迟，无乐观锁，单管理员场景适用）。

- **登录鉴权**：直接访问 `/music/settings` 会被服务端重定向到 `/music/settings/login`；输入 `SETTINGS_API_KEY` 通过后，服务端下发 **HMAC 签名会话 Cookie**（`mp_settings_session`，httpOnly、SameSite=Lax、默认 12h），期间刷新 / 切页保持登录；页面右上角「退出登录」清除会话。前端不落盘密钥。写入请求（`PUT` / `DELETE /api/music/caps`）同时接受该会话 Cookie 与 `Authorization: Bearer <SETTINGS_API_KEY>`（脚本 / curl 路径）。
- **优先级**：设置页写入的配置文档覆盖 env；env 的 `MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` / `MUSIC_PLATFORM_OFF`（平台级）与 `MUSIC_BUILTIN_PLAY=off`（内置播放引擎总开关）始终压在最后（终闸），被锁定的平台槽位 / 总开关在页面上灰显「部署锁定」且无法开启。
- **降级**：未配置 Turso 或 `SETTINGS_API_KEY` 时页面只读并给出原因（未配密钥则无法登录，`503` / `403`），听歌功能完全不受影响；存储抖动 / 文档损坏时服务端回落 env 基线继续供曲，只有写入返回 `503`。
- **恢复**：页面「恢复部署基线」删除配置文档，回到环境变量基线。

详见 `API.md` §12.7。

## 许可证

本项目仓库未附开源许可证文件（`package.json` 声明 `private: true`、`license: ISC`），不授权对外分发。
