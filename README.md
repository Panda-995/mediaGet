<p align="center">
  <img src="public/icon.png" width="72" height="72" alt="MediaGet" />
</p>

<h1 align="center">MediaGet</h1>

<p align="center">短视频解析 + 音乐解析下载服务：粘贴分享链接或整段分享文案，即得无水印直链。</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-black.svg" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/Node.js-22-339933.svg" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/PWA-ready-5a0fc8.svg" alt="PWA" />
</p>

<p align="center">
  <a href="API.md">接口文档</a> ·
  <a href="#支持平台">支持平台</a> ·
  <a href="#部署">部署</a>
</p>

> **免责声明**：本项目仅用于技术学习与搜索聚合演示，不存储、不传播任何受版权保护的内容，请勿用于商业或侵权用途。

## 为什么是 MediaGet

- **一条链接出结果**：视频、图文、音乐统一解析，自动识别平台与内容类型
- **不用手动挑链接**：整段分享文案直接粘贴，自动提取有效地址
- **不重复等待**：结果缓存 24 小时，直链失效自动重新解析
- **不止视频**：内置多源音乐搜索、播放、滚动歌词与下载
- **随时能自部署**：Docker 一条命令跑起来，无厂商锁定
- **MIT 开源**：可自由使用、修改与分发

## 功能特性

**视频解析**

- 支持 13 个平台的视频 / 图文 / 音频解析与下载
- 支持分享链接、整段分享文案与部分平台的 `source+id` 直接解析
- 图文图集多选下载；哔哩哔哩多分 P / 清晰度；汽水音乐直接下载音频
- 支持 `fmt=text` 纯文本输出，便于快捷指令调用

**音乐解析**

- 多源聚合搜歌、试听、播放、滚动歌词、封面与下载
- 覆盖网易云 / 酷我 / JOOX，内置 QQ音乐 / 酷狗 / 咪咕直连搜索
- 聚合搜索自动去重并按相关度排序；播放失败自动换源，也可手动选版
- 网易云 / QQ音乐 / 酷我 歌曲链接可一键解析

**站点**

- 深浅色主题、移动端适配、刷新不丢解析结果、PWA 可安装
- 提供常见问题与隐私 / 条款 / DMCA 页面

## 支持平台

| 平台 | 说明 |
| --- | --- |
| 抖音 | 匿名可解析；可选 `DOUYIN_COOKIE` 增强 |
| 快手 | 匿名可解析；`KUAISHOU_COOKIE` 补全作者简介与获赞数，未配置自动降级 |
| 微博 | 游客模式，无需配置 |
| 哔哩哔哩 | 多分 P / 清晰度；服务器出口建议配置 `BILIBILI_COOKIE` |
| 小红书 | 登录墙平台；可选 `XHS_COOKIE` |
| 汽水音乐 | 音乐内容，直接下载音频 |
| 西瓜视频 | 视频解析 |
| 最右 | 视频解析 |
| AcFun | 视频解析 |
| TikTok | 依赖 yt-dlp，仅 Docker 部署可用 |
| X (Twitter) | 视频解析 |
| Instagram | 登录墙平台，建议配置 `IG_COOKIE` |
| YouTube | 多源解析，源不可用时降级为官方嵌入播放；可选 `YOUTUBE_API_KEY` 与自建解析源 |

> `source+id` 适用于抖音、微博、西瓜视频、AcFun、X (Twitter)。微信视频号及腾讯视频 / 爱奇艺 / 优酷 / 芒果TV / Netflix / Spotify 等付费或 DRM 平台不支持；平台可用性受各站风控与地区影响。

## 部署


### Vercel

 <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhotier%2FmediaGet"><img src="https://vercel.com/button" alt="Deploy with Vercel" height="32" /></a>

1. 在 Vercel 导入仓库，框架自动识别为 Next.js，构建命令填 `npm run build`
2. **Settings → Environment Variables** 填入 Cookie、音乐上游与可选存储配置（生产 / 预览环境都勾选）
3. 点击 **Deploy**，完成后在 **Settings → Domains** 绑定域名
4. 打开 `/api/health` 验证部署

> TikTok 不可用；公共音乐上游对数据中心出口会被人机校验，需用 `MUSIC_API_BASE(S)` 指向可直连实例。

### Cloudflare Workers

**方式A：GitHub Actions 部署（推荐）**

<a href="../../actions/workflows/deploy-cloudflare.yaml"><img src="https://img.shields.io/badge/Cloudflare_Workers-Deploy-F38020?logo=cloudflare&logoColor=white" alt="Deploy to Cloudflare Workers" height="26" align="absmiddle" /></a>

1. 在 **Settings → Secrets and variables → Actions** 配置 `CF_API_TOKEN`（权限 Workers Scripts:Edit）、`CF_ACCOUNT_ID`
2. 到 Actions 页手动运行 **Deploy to Cloudflare Workers**，首次运行会自动创建 Worker
3. **Settings → Variables and Secrets** 填入 Cookie、Turso、`SETTINGS_API_KEY` 等，敏感项选 **Secret**
4. **Settings → Domains & Routes** 绑定域名，访问 `/api/health` 验证

构建校验已在 CI 中完成，该工作流只负责发布。

**方式B：控制台 Git 集成**

 <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/hotier/mediaGet"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="32" /></a>

需要账户具备 Workers Builds 权限，否则面板会提示 `Your account is blocked from using Workers Builds`。

1. Cloudflare Dashboard → **Workers & Pages → Create → Connect to Git**，选择本仓库
2. 修改面板自动填充的命令：Build command 填 `npm run build:cf`，Preview command 填 `npx wrangler versions upload`（不需要预览可留空），Deploy command `npx wrangler deploy` 保持不变
3. 添加构建变量 `NODE_VERSION=22`；Worker 名称、兼容日期、静态资源与绑定均由仓库的 `wrangler.toml` 提供，无需在面板填写
4. **Settings → Variables and Secrets** 填入运行时配置

> 不要使用面板的 Next.js 预设：它会默认走 vinext，并填入 `npm run build`、`npx wrangler preview`，前者只产出 `.next`、后者在 wrangler 4 中不存在，均与本仓库的 OpenNext 产物不兼容。

> 构建命令 `npm run build:cf` 会先生成 OpenNext 产物。建议 Paid 套餐；TikTok 不可用。

> X 的第三方 fixer 会按出口 IP 做人机校验/限流，Workers 出口拿不到；直连全失败时解析会经 `r.jina.ai` 阅读器中继补取同一份 fx 数据（只转发「推文 ID 拼出的 fx 公开接口 URL」，该 URL 会经过第三方），正文、媒体、博主简介/粉丝因此都正常。介意内容外流可设 `TWITTER_FIXER_RELAY_URL=off`，此时退回官方 syndication：缺简介/粉丝，敏感内容可能报「已删除或不可见」。排障看 `/api/health?probe=twitter`。

### Netlify

  <a href="https://app.netlify.com/start/deploy?repository=https://github.com/hotier/mediaGet"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify" height="32" /></a>

1. 导入仓库，Netlify 自动读取 `netlify.toml`（Node.js 22 + `npm run build`）
2. **Site configuration → Environment variables** 填入运行配置
3. 点击 **Deploy site**，完成后绑定域名

> 函数默认 10 秒超时、响应体上限 6 MB、TikTok 不可用，适合演示与备用。经 `/api/video-proxy` 转发的视频超过约 6 MB 会被截断，X 等平台的视频播放/下载因此不可靠；需要完整播放请用 Cloudflare Workers 或 Docker。

### Docker（推荐）

```bash
git clone <仓库地址> /opt/mediaget && cd /opt/mediaget
# 按下方「可选配置」写入 /opt/mediaget/.env
chmod 600 .env

docker build --build-arg BUILD_ID=$(git rev-parse HEAD) -t mediaget:latest .
docker run -d --name mediaget --restart unless-stopped --init \
  --env-file /opt/mediaget/.env -p 3000:3000 mediaget:latest
```

镜像内置 yt-dlp 与 ffmpeg，以非 root 用户运行；`--init` 不可省略。用 Nginx / OpenResty / 1Panel 反向代理到 `127.0.0.1:3000` 并配置 HTTPS，`curl -f http://127.0.0.1:3000/api/health` 验证。

更新版本：`git pull` → 重新构建 → `docker rm -f mediaget` → 用同样命令启动。修改 `.env` 后需重启容器生效。

## 可选配置

所有 Cookie、Token 与密钥均属敏感信息，请勿提交到仓库。

| 变量 | 说明 |
| --- | --- |
| `MUSIC_API_BASE` / `MUSIC_API_BASES` | 音乐上游地址，多基址按序回退 |
| `MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY` / `MUSIC_PLATFORM_OFF` | 各平台搜索 / 播放引擎开关与整体下线 |
| `MUSIC_BUILTIN_PLAY` | 内置播放引擎总闸，`off` 为强制关闭 |
| `TURSO_DB_URL` / `TURSO_AUTH_TOKEN` | Turso 数据库，用于缓存、统计与设置持久化 |
| `SETTINGS_API_KEY` | `/music/settings` 设置页登录密钥 |
| `VIDEO_PARSE_ENABLED` | 视频解析入口开关，`true` 时开放 |
| `PROXY_ALLOWED_HOSTS` | 追加媒体代理白名单（自建 CDN / 图床域名，逗号分隔） |

配好 Turso 与设置密钥后，可经音乐页齿轮进入 `/music/settings` 在线调整平台开关与换源行为，无需重新部署。平台 Cookie 见「支持平台」。

## 文档与反馈

- [接口文档](API.md)：请求参数、响应结构、错误码
- [问题反馈](https://github.com/hotier/mediaGet/issues)

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
