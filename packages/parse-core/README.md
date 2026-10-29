# @mediaget/parse-core

MediaGet 的统一解析内核：把各平台分享链接解析成**可直接下载的媒体直链 + 统一字段**。
web、桌面端、CLI 共用这一份代码，平台字段差异、反爬策略、超时与节流都在这里收口。

- 当前版本：`1.1.1`（以 `package.json` 为准，运行时读 `PARSE_CORE_VERSION`）
- 运行环境：Node.js **>= 22**
- 产物：ESM + CJS + `.d.ts`，只有一个入口 `"."`
- 无副作用导入：模块加载期不发网络请求；环境变量的读取时机见 §6.2

---

## 0. 30 秒上手

```bash
npm i @mediaget/parse-core
```

```js
import { unifiedParseLocal, normalizeResult } from "@mediaget/parse-core";

const res = normalizeResult(await unifiedParseLocal(url));

if (res.code !== 200) {
  console.error(res.code, res.msg); // msg 可直接展示给用户
} else {
  console.log(res.data.type); // video | image | music | text
  console.log(res.data.url);  // 视频 / 音频 / 单图直链
  console.log(res.data.images); // 图集（如有）
}
```

> **必须显式调用 `normalizeResult`**：统一入口只做「黑名单 → 识别 → 分发 → 兜底 → 直链验证 → 补 platform」，
> **不会**把各平台的原始字段名（`photoUrl` / `caption` / `coverUrl` …）改写成统一字段。

---

## 1. 边界：内核做什么，宿主做什么

| 归属 | 职责 |
| --- | --- |
| **内核**（本包） | 平台识别、分享链接解析、上游抓取（超时/UA/风控分类/退避）、直链有效性校验、字段归一化、平台注册表 |
| **宿主**（web / 桌面 / CLI） | 提供网络与配置、HTTP 路由与响应信封、per-IP 限流、CORS、图片代理、响应缓存、UI 展示 |

两条硬边界：

1. **内核只出媒体直链**（`http(s)://…`），绝不生成 `/api/image`、`/api/video-proxy` 这类站内相对路由。
   需要图片代理时由宿主在出口层改写（web 侧是 `src/lib/image-proxy.js`）。
2. **内核不认识 HTTP**：不返回 `Response`、不写 CORS、不做 per-IP 限流。这些属于「某个服务怎么守自己的入口」。

`tests/parse-core-shells.test.ts` 会扫描包内源码，出现站内路由串直接失败。

---

## 2. 安装与引入

```bash
# npm（主渠道）
npm i @mediaget/parse-core

# 离线 / 审计：GitHub Release 附带同源 tarball 与 .sha256
npm i ./mediaget-parse-core-1.1.1.tgz
```

```js
// ESM
import { unifiedParseLocal, normalizeResult } from "@mediaget/parse-core";

// CJS
const { unifiedParseLocal, normalizeResult } = require("@mediaget/parse-core");
```

```ts
// 类型
import type {
  ApiResponse,
  ParseData,
  ParsedVideoItem,
  ParsedVideoQuality,
  PlatformKey,
} from "@mediaget/parse-core";
```

本包**没有子路径导出**，不要 `import "@mediaget/parse-core/dist/lib/..."`；内部模块不属于公开契约。

---

## 3. 如何使用

### 3.1 统一入口（推荐）

```js
import { unifiedParseLocal, normalizeResult } from "@mediaget/parse-core";

const result = normalizeResult(await unifiedParseLocal(input));
```

`unifiedParseLocal` 的完整流程：

```
黑名单拦截 → 平台识别（汽水音乐特判）→ 内核缓存（如已注入）
→ 调用本地解析器 → 快手公共 API 兜底 → 直链 HEAD 校验
→ 补 platform → 成功结果写缓存（跳过 embedOnly）
```

- 直链校验是**保守策略**：只有 404 / 410 判坏链并置空 `data.url`；403 / 超时 / 网络错误一律不阻断。
- 失败结果不缓存；`data.embedOnly === true` 且没有 `url` 的降级结果也不缓存。
- 入口内部的 `try/catch` 会把未捕获异常转成 `{ code: 500, msg: "服务器内部错误" }`。

### 3.2 宿主注入解析器（web 形态）

```js
import { createUnifiedParser, normalizeResult } from "@mediaget/parse-core";

const parse = createUnifiedParser(async (platform) => {
  // 由宿主决定 platform → 解析函数；未支持返回 null
  return routes[platform] ?? null;
});

const res = normalizeResult(await parse(url));
```

`createUnifiedParser` 与 `unifiedParseLocal` 的编排完全一致，唯一差别是解析器来源可注入。

### 3.3 直接调用单个平台解析器

```js
import { douyinParse, normalizeResult } from "@mediaget/parse-core";

const res = normalizeResult(await douyinParse(url));
```

直接调用时**没有**统一入口的兜底、缓存与直链校验，需要的话自行补上。

### 3.4 ID 模式

```js
const res = await unifiedParseLocal("", {
  source: "twitter", // 注意：小红书 key 是 redbook，不是 xhs
  id: "1234567890",
});
```

实际可用性以注册表是否挂载 `parseVideoId` 为准。1.1.1 只有：

| 平台 | ID 模式 |
| --- | --- |
| `twitter` | 可用 |
| `xigua` | 可用 |
| `douyin` / `weibo` / `acfun` | `PLATFORM_INFO.supportsIdParse` 标了 `true`，但本地注册表未挂 `parseVideoId`，会返回「解析器暂不支持 ID 解析模式」 |

其余平台在 `supportsIdParse` 阶段就会被拒绝，提示使用分享链接。

### 3.5 分享文案

统一入口的 URL 模式只认「字符串里带 `://` 或 `.`」的输入。从分享文案里抽链接请先调用：

```js
import { extractUrlFromShareText } from "@mediaget/parse-core";

const url = extractUrlFromShareText("复制打开抖音，看看…… https://v.douyin.com/abc/ ！");
```

### 3.6 类型与导出

公开导出以 `src/index.ts` 为唯一契约（运行时导出名由快照测试锁定）。常用入口：

| 分类 | 导出 |
| --- | --- |
| 统一入口 | `unifiedParseLocal`、`createUnifiedParser`、`localParserKeys`、`resolveLocalParser`、`parserRegistry` |
| 平台解析器 | `douyinParse`、`parseKuaishou`、`xhsParse`、`bilibiliParse`、`weiboParse`、`twitterParse`、`xiguaParse`、`zuiyouParse`、`acfunParse`、`parseTiktok`、`parseInstagram`、`parseYoutube`、`qsmusicParse` |
| ID 模式 | `xiguaParseVideoId` |
| 识别面 | `PLATFORM_INFO`、`identifyPlatform`、`getPlatformName`、`extractUrlFromShareText`、`isBlockedText`、`BLOCKED_HOSTS` |
| 契约 | `normalizeResult`、`sanitizeFilename` |
| 配置/运行时 | `setKernelConfig`、`getKernelConfig`、`setRuntime`、`getRuntime`、`guardedFetch`、`UpstreamThrottledError` |
| 反爬工具 | `TIMEOUT`、`UA`、`UA_*`、`fetchWithTimeout`、`RequestTimeoutError`、`createSlidingWindowLimiter`、`platformFetchLimiter`、`classifyRisk`、`RISK_TYPES`、`sleep`、`createTtlCache`、`logger`、`beijingNow`、`isValidUrl`、`sanitizeUrl` |
| 版本 | `PARSE_CORE_VERSION` |

---

## 4. 支持的平台与支持情况

平台 key 以 `PLATFORM_INFO` 为准；注册表额外包含 `qsmusic`（汽水音乐）。

| key | 平台 | 内容类型 | 认证 / 依赖 | ID 模式 | 已知限制 |
| --- | --- | --- | --- | --- | --- |
| `douyin` | 抖音 | 视频、图文（`aweme_type` 1/2） | `DOUYIN_COOKIE` 可选；风控环境强烈建议 | 声明支持，实际未挂载 | 数据中心 IP 易触发 argus 风控；已做 DoH/IP 直连兜底 |
| `kuaishou` | 快手 | 视频 | `KUAISHOU_COOKIE` 可选，**只影响作者资料**（简介/获赞/粉丝），视频解析不需要 | 不支持 | H5 页面结构变化时靠公共 API 兜底 |
| `redbook` | 小红书 | 视频、图文（`imageList`） | `XHS_COOKIE` 可选，可降低风控 | 不支持 | 未登录会话下主页统计可能脱敏（`statsUnreliable`） |
| `xigua` | 西瓜视频 | 视频 | 无 | **可用** | — |
| `zuiyou` | 最右 | 视频 | 无 | 不支持 | — |
| `bilibili` | 哔哩哔哩 | 视频（分P/多清晰度）、图文动态（opus）、纯文字动态 | `BILIBILI_COOKIE` 建议配置；`BILIBILI_USER_AGENT` 可选 | 不支持 | 无 Cookie 的数据中心 IP 常被 `-352` 风控；opus 仅支持 `/opus/`、`/dynamic/` |
| `weibo` | 微博 | 视频、图文、纯文字 | 无（访客模式） | 声明支持，实际未挂载 | 部分计数/作者字段只在桌面接口存在 |
| `acfun` | AcFun | 视频 | 无 | 声明支持，实际未挂载 | — |
| `twitter` | X / Twitter | 视频、图片、纯文字 | `TWITTER_FIXER_SERVICES` 可选（自定义 fixer 域名） | **可用** | 依赖第三方 fixer / syndication，可能随风控波动 |
| `tiktok` | TikTok | 视频 | **必须**有 `yt-dlp`（`YTDLP_BIN`、`YTDLP_TIMEOUT_MS`） | 不支持 | 只能在 Docker / Node 运行，Cloudflare 等无子进程环境不可用 |
| `instagram` | Instagram | 视频、图片/图集 | `IG_COOKIE` 强烈建议；`IG_TIMEOUT_MS` 可选 | 不支持 | 匿名访问普遍撞登录墙 |
| `youtube` | YouTube | 视频 | `YOUTUBE_API_KEY` 可选（只补元数据）；Piped/Invidious 主机可配 | 不支持 | 直链源全部失败时返回 `embedOnly` 降级（只有官方嵌入，无直链） |
| `qsmusic` | 汽水音乐 | 音乐（音频直链） | 无 | 不支持 | 不在 `PLATFORM_INFO` 内，由统一入口对 `music.douyin.com` / `qishui.douyin.com` 特判，避免被误识别成抖音 |

补充说明：

- **内容类型**来自解析器实际分支，不保证 `data.type` 一定存在；`normalizeResult` 不会凭空补值。
- 普通视频平台的 `data.url` 是视频直链；图集在 `data.images`；B站多分P/多清晰度在 `data.videos`。
- 付费/DRM 平台在识别前直接拒绝：腾讯视频、爱奇艺、优酷、芒果TV、Netflix、Disney+、HBO、Prime Video、Spotify、Hulu，以及微信视频号。命中返回 `code: 400` 与明确文案。

---

## 5. 返回契约

### 5.1 响应信封

```ts
interface ApiResponse {
  code: number;        // 200 = 成功；其它为失败
  msg: string;         // 可直接展示给用户
  platform?: PlatformKey;
  data?: ParseData;
  failType?: string;   // 目前 YouTube 使用：bot-gated / sources-down / not-found / no-sources / unreachable
}
```

- 成功统一为 `code: 200`（B站历史返回 `1`，由 `normalizeResult` 收口）。
- 失败码不保证全局统一（平台解析器会返回 201/400/404 等），调用方**只判断 `code === 200`**，不要枚举失败码。
- 非成功响应 `normalizeResult` 原样返回。

### 5.2 `ParseData` 关键字段

| 字段 | 说明 |
| --- | --- |
| `type` | `video` / `image` / `music` / `text`；`text` 表示只有文字、没有媒体 |
| `title` / `desc` | 标题 / 正文或描述 |
| `author` / `authorId` / `authorUrl` / `avatar` / `sign` | 作者信息 |
| `cover` | 封面图 |
| `url` | 主媒体直链（视频 / 音频 / 单图） |
| `audioUrl` | 音频直链（抖音等，供「下载音频」） |
| `images` | 图集直链 |
| `videos` | 多分P / 多清晰度列表（B站、微博等） |
| `duration` | **毫秒**，全平台统一 |
| `time` | 发布时间，**单位不统一**（见 5.4） |
| `stat` | 互动统计（B站：view/danmaku/reply/favorite/coin/share/like） |
| `favorite` / `reply` / `share` / `like` 等 | 平台顶层计数，与 `stat.*` 分属两套来源 |
| `qualities` | 可直接下载的清晰度档位列表（形状与放置见下） |
| `embedOnly` | 直链源不可用、仅官方嵌入可用的降级标记 |
| `failType` | 失败细分类型（YouTube） |

清晰度档位 `qualities`：

- 形状为 `{ quality, label, url }`。`quality` 是平台档位值——B站为 qn（如 112）；其余平台为高度 px（如 1080），无高度时退回码率（如 2176000）。`label` 只用于展示，`url` 是该档直链。
- 放置：单视频挂 `data.qualities`；多P/多分P 挂 `videos[].qualities`，顶层不写整体档位（避免 P1 的档位被误读为整条内容）。
- **不足 2 档不下发**（`buildQualityList` 统一收口）；单档继续由 `qualityLabel` 徽标展示，前端只在 >1 档时渲染下拉。
- 现有产出平台：B站、微博、快手、小红书、抖音、X、Instagram、TikTok。YouTube 只收「合流（含音轨）」档位。同一档位下发多条编码时先归并：快手优先 avc，X 取高码率；URL 重复项丢弃。
- `url` 与档位表首项保持一致：上游同时给「默认直链 + 档位表」时，主直链跟随最高档（快手 `mainMvUrls`、抖音默认 `play_addr` 均如此处理）。

完整声明见 `src/types/api.ts`。

### 5.3 `normalizeResult` 到底做什么

| 行为 | 说明 |
| --- | --- |
| 别名映射 | `photoUrl → url`、`caption → title`、`coverUrl → cover`、`authorName → author`、`headUrl → avatar` 等 |
| 类型收拢 | 字符串档数字转字符串；数字档纯数字串转 number |
| 删空占位 | `""` / 纯空白 / `null` 的键直接删除，不下发空壳 |
| 收不拢就保留 | 如小红书 `"1.2万"` 原样保留，不静默丢数据 |
| 保留原始键 | 只做加法，不删除平台原始字段；B站分P同时保留 `video_url` / `pic` |
| B站特例 | `data` 为数组时把顶层字段与分P归入 `data`；分P `duration` 秒 → 毫秒；顶层 `url` 回退第一分P |
| 幂等 | 对已归一结果再调用不改变任何东西 |

### 5.4 单位口径

- `duration`：**一律毫秒**。换算由各解析器负责，唯 B站分P在归一化层 ×1000。
- `time`：**平台原样透传，不统一**。抖音/小红书/B站是 unix 秒，X/Instagram/YouTube 是毫秒时间戳，微博是可 `new Date()` 解析的日期串。消费方需三选一兼容。
- 新增平台时：`duration` 必须在解析器出口换成毫秒；`time` 若无法确认单位，宁可不填，也不要猜。

### 5.5 直链规则

- 内核只输出 `http(s)://` 绝对直链。
- 图片直链在 web 页面直接使用可能被防盗链/混合内容拦截，由宿主改写为站内代理（web 的 `/api/image`）。
- 桌面宿主直接按直链取流，不需要代理。

---

## 6. 配置

### 6.1 `setKernelConfig`

```js
import { setKernelConfig } from "@mediaget/parse-core";

setKernelConfig({
  douyinCookie: "...",
  kuaishouCookie: "...",
  bilibiliCookie: "...",
  xhsCookie: "...",
  igCookie: "...",
  youtubeApiKey: "...",
});
```

字段与环境变量（注入值优先于 env）：

| 字段 | 环境变量 | 默认 / 说明 |
| --- | --- | --- |
| `bilibiliUserAgent` | `BILIBILI_USER_AGENT` | 默认旧版 Chrome UA，部分接口另有现代 UA |
| `bilibiliCookie` | `BILIBILI_COOKIE` | 建议配置，绕过 `-352` 风控 |
| `douyinCookie` | `DOUYIN_COOKIE` | 可选，风控环境建议 |
| `kuaishouCookie` | `KUAISHOU_COOKIE` | 可选，只补作者资料 |
| `xhsCookie` | `XHS_COOKIE` | 可选 |
| `igCookie` | `IG_COOKIE` | 强烈建议 |
| `igTimeoutMs` | `IG_TIMEOUT_MS` | 默认 `TIMEOUT.PAGE`（20s） |
| `twitterFixerServices` | `TWITTER_FIXER_SERVICES` | 逗号分隔的自定义 fixer 域名 |
| `youtubeApiKey` | `YOUTUBE_API_KEY` | 可选，只补元数据，不给直链 |
| `youtubeSourceTimeoutMs` | `YOUTUBE_SOURCE_TIMEOUT_MS` | 默认 6000 |
| `youtubeApiTimeoutMs` | `YOUTUBE_API_TIMEOUT_MS` | 默认 5000 |
| `youtubeInvidiousHosts` | `YOUTUBE_INVIDIOUS_HOSTS` | 逗号分隔；默认空 |
| `youtubePipedHosts` | `YOUTUBE_PIPED_HOSTS` | 逗号分隔；有默认候选 |
| `ytdlpBin` | `YTDLP_BIN` | 默认 `yt-dlp`，支持带参数 |
| `ytdlpTimeoutMs` | `YTDLP_TIMEOUT_MS` | 默认 25000 |

### 6.2 配置读取时机（重要）

1.1.1 中只有 `douyinCookie`、`kuaishouCookie` 是**每次解析时**读取，`setKernelConfig` 运行期立即生效。

其余配置（B站、Instagram、小红书、Twitter fixer、YouTube、yt-dlp）在**模块加载时**读取一次。因此：

```js
// 正确：Node 宿主在首次 import 前写好 env，再动态 import
process.env.BILIBILI_COOKIE = cookieFromKeychain;
const { unifiedParseLocal } = await import("@mediaget/parse-core");
```

```js
// 错误：import 已完成，模块级常量已经定型
import { setKernelConfig } from "@mediaget/parse-core";
setKernelConfig({ bilibiliCookie: "..." }); // 对 B站不生效
```

后续版本会把它们统一改为请求时读取；在此之前，**模块加载期配置请走环境变量**。

### 6.3 安全约束

- Cookie / API Key 只放**服务端环境变量或宿主私有配置**，不要写入 `wrangler.toml`、前端 bundle、日志或提交到仓库。
- 不提交 `.env`、`credentials.*`、导出的 Cookie 文本。
- Cookie 只发给对应平台的第一方域名；不要跨平台复用或转发到第三方（快手尤其明确：只发快手第一方）。
- 日志中不要打印完整 Cookie / Key。

---

## 7. 运行时注入

内核默认自带反爬运行时；宿主可以整体替换四个端口：

```js
import {
  setRuntime,
  createTtlCache,
  createSlidingWindowLimiter,
} from "@mediaget/parse-core";

setRuntime({
  fetch: (url, options) => myProxyFetch(url, options),
  limiter: createSlidingWindowLimiter({ max: 30, windowMs: 60_000 }),
  cache: createTtlCache({ max: 500, ttlMs: 5 * 60_000 }),
  logger: console,
});
```

| 端口 | 默认 | 说明 |
| --- | --- | --- |
| `fetch` | `fetchWithTimeout` | 签名 `(url, { timeoutMs, ...init }) => Promise<Response>`；可换成代理 / 自建网络栈 |
| `limiter` | `platformFetchLimiter` | 滑动窗口 `take(key)` / `reset()` |
| `cache` | `null` | `null` = 内核不缓存；注入后统一入口按**原始输入串**缓存成功结果 |
| `logger` | dev-gated `console` | `log/info` 仅 development 输出，`warn/error` 生产也输出 |

`guardedFetch(url, options)` 的防线顺序：

```
取节流配额（仅当显式传 platform）→ 超时层 → 风控判定 → 指数退避重试
```

- 配额超限抛 `UpstreamThrottledError`（带 `.platform`），调用方应映射为 429，而不是当作普通失败。
- `retries` 默认 0；只有 `rate_limited` / `ip_risked` / `cookie_stale` 会重试。
- 重试耗尽或未命中风控时**原样返回响应（包括 403）**，由解析器自己的风控检测给出文案。
- 内置解析器当前一般不传 `platform`，所以不会消耗配额；需要内核内节流时，在自定义解析器里显式传入。

---

## 8. 平台识别与黑名单

- `PLATFORM_INFO` 是域名唯一真源（主域名 + 短链域名 + `supportsIdParse`）。
- `identifyPlatform(url)` 按域名后缀匹配，返回平台 key；认不出返回 `null`。
- `getPlatformName(key)` 返回中文名，找不到时回退原 key。
- `extractUrlFromShareText(text)` 从分享文案抽第一个 URL，并剔除尾部中英文标点。
- `isBlockedText(text)` 判断付费/DRM/微信视频号黑名单。

**注意词表差异**：内核平台 key 小红书是 `redbook`；web 前端展示用的 `VideoPlatformKey` 是 `xhs`。二者不要混用。

---

## 9. 接入新平台（内核侧 SOP）

按顺序做，每一步都能独立验证：

### 9.1 写纯函数解析器

新建 `src/lib/<platform>Core.js`，导出一个 `async function <platform>Parse(url)`：

```js
import { TIMEOUT, UA_CHROME_WIN126 } from "./http";
import { guardedFetch } from "../runtime";
import { parseOk, parseFail } from "./parser-kit";

export async function fooParse(url) {
  const res = await guardedFetch(apiUrl, {
    headers: { "User-Agent": UA_CHROME_WIN126 },
    timeoutMs: TIMEOUT.DEFAULT,
  });
  if (!res.ok) return parseFail(400, "解析失败：上游不可用");
  return parseOk({
    type: "video",
    title: "",
    url: "",
    duration: 0, // 毫秒
  });
}
```

约定：

- 只做「URL → `{ code, msg, data }`」，不碰 HTTP 信封、CORS、限流。
- 所有上游请求走 `guardedFetch`（`setRuntime({ fetch })` 才能生效），并显式给 `timeoutMs`。
- UA 用 `TIMEOUT` / `UA_*` 常量池；平台专用 UA 留在本文件并注释原因。
- 成功用 `parseOk(data)`，失败用 `parseFail(code, msg)`；`msg` 面向用户。
- 配置用 `getConfigOrEnv(key, ENV_NAME, default)`，并在**函数内**读取，不要新增模块级常量。
- 不伪造字段；拿不到就省略。`duration` 必须毫秒。

### 9.2 注册识别面（新平台才需要）

在 `src/lib/platforms.ts` 的 `PLATFORMS` 与 `PLATFORM_INFO` 增加 key、名称、主域名、短链域名、`supportsIdParse`。
测试会校验「声明的每个域名都能被 `identifyPlatform` 认回本平台」。

如果新平台要进入 `ApiResponse.platform` 的展示词表，同步本包 `src/config/video-platforms.ts`；
宿主前端也有同名的展示配置（web 仓库根目录），需要一并加名称/颜色/图标。

### 9.3 注册本地解析器

在 `src/lib/parser-registry.js` 增加：

```js
foo: fooParse,
// 支持 ID 模式时：
foo: withId(fooParse, fooParseVideoId),
```

### 9.4 加入公开导出

在 `src/index.ts` 增加导出，并同步 `tests/parse-core-shells.test.ts` 的 `PUBLIC_EXPORTS` 快照。
新增导出按 semver 是 **minor**；改名/删除是 **major**。

### 9.5 加 web 薄壳（web 共用时）

web 侧 `src/lib/<same-name>.{js,ts}` 必须是一行纯转发：

```js
export * from "../../packages/parse-core/src/lib/fooCore";
```

`tests/parse-core-shells.test.ts` 要求「包内每个源文件恰好被一个薄壳转发」，漏了会红。

### 9.6 测试与归一化

1. 新增平台单测（mock `guardedFetch` / `fetch`，覆盖成功与失败分支）。
2. 在 `tests/normalize-result.test.ts` 增加 raw → 契约 fixture，声明 `duration` 毫秒值与需保留的原始键。
3. 做一次变异验证：改坏关键分支，确认对应断言变红，再还原。

### 9.7 升版本与文档

- 新增平台 = minor：同步 `package.json` 与 `src/index.ts` 的 `PARSE_CORE_VERSION`。
- 更新本 README 的平台矩阵；web 侧平台清单同步根 `README.md` / `API.md`。
- 若平台还需要 web 路由、前端渲染器，按根仓库 `docs/architecture.md` §6 的宿主 SOP 继续。

### 9.8 验收门

```bash
npm --prefix packages/parse-core run build
npx vitest run tests/parse-core-shells.test.ts tests/normalize-result.test.ts
npm test
```

需要真机样本时再跑 `npm run test:live`（默认关闭，见 §10）。

---

## 10. 测试与验收

本包没有独立的 test 脚本，测试统一在仓库根目录：

| 命令 | 用途 |
| --- | --- |
| `npm --prefix packages/parse-core run build` | tsup 产出 ESM/CJS/d.ts；构建不过不谈验收 |
| `npm test` | 全量单测（含内核守卫） |
| `npx vitest run tests/parse-core-shells.test.ts` | 薄壳 ↔ 真源、公开导出快照、内核零站内路由 |
| `npx vitest run tests/normalize-result.test.ts` | 13 个公开解析器的 raw → 契约对拍（完整性/单位/幂等） |
| `npx vitest run tests/kernel-runtime.test.ts tests/anti-bot.test.ts` | 运行时端口与风控分类 |
| `npm run test:live` | 真机解析，需 `RUN_LIVE_PARSE=1` 与真实链接；改解析器前先留基线 |

测试约定：

- fixture 尽量逐字镜像真实接口返回，并在注释里标源码位置。
- 新增/修改解析分支必须补对应断言；断言优先进现有守卫文件，不新建平行测试。
- 关键行为做变异验证：故意改坏 → 断言必须红 → 还原。
- 真机测试是可选门，不要把它变成 CI 必跑项（上游风控会导致假红）。

---

## 11. 开发规范

### 11.1 公开面与版本

- **改动前必须报告**：本包由多个宿主共用（web 薄壳 / 桌面端 / CLI / npm 使用者），任何源码改动都可能影响下游项目。动手前先向维护者报告改动范围、行为变化、公开导出是否变动与 semver 级别，得到确认后再改。
- `src/index.ts` 是唯一公开契约；内部模块可自由重构。
- `export type` 在运行时擦除，不进导出快照。
- semver 与发布双通道（npm 主渠道 + Release 同源 tarball）以 `docs/architecture.md` §8 为准；核心口径：改导出白名单/返回结构/删解析器 = **major**，新增解析器/配置 API = **minor**，修 bug = **patch**。
- `PARSE_CORE_VERSION` 必须与 `package.json.version` 一致（CI 会比对）。

### 11.2 导入与副作用

- 保持 `sideEffects: false`：模块加载期不得发网络请求。
- **不要新增 import-time 环境变量读取**；配置在函数内用 `getConfigOrEnv` 读取（历史模块见 §6.2）。
- 不在模块加载期创建定时器、监听器或无条件写全局状态。
- 进程内缓存/计数可以用，但要接受 Serverless 多 isolate 下打折；不要依赖它做正确性。

### 11.3 字段与单位

- `duration` 毫秒；`time` 平台原样并注释单位。
- 统一字段优先；无法映射的原始字段保留，不删。
- 空值不下发：`""` / 纯空白 / `null` 在归一化层删除。
- 不造数：拿不到就是 `undefined`，不要用 0 或假文案填充（计数类 0 若确有语义再保留）。
- 版权/敏感内容：不在内核做登录态绕过、DRM 破解或付费内容抓取。

### 11.4 网络与反爬

- 所有上游请求走 `guardedFetch`，显式 `timeoutMs`。
- 新增风控特征优先用平台专属检测；通用兜底用 `classifyRisk`。
- 重试只针对 `rate_limited` / `ip_risked` / `cookie_stale`，指数退避。
- 不要在内核里做 per-IP 限流、CORS、响应信封。

### 11.5 安全

- 不提交 Cookie / Key / `.env`；日志脱敏。
- Cookie 只发对应平台第一方域名。
- 新增第三方服务（fixer、代理、解析 API）时，明确数据去向，不把用户 Cookie 带过去。

### 11.6 注释与可维护性

- 注释只写「为什么」，尤其是反爬、兼容、风控相关的非显然约束。
- 平台差异写在该平台文件顶部，不要散落到调用方。
- 不引入与现有工具重复的新依赖；能用 `node:` / 现有工具解决就不加包。

---

## 12. 常见问题

**统一入口返回 `photoUrl` / `caption`，没有 `url` / `title`。**
没有调用 `normalizeResult`。统一入口不做字段归一，见 §0。

**`source + id` 返回「解析器暂不支持 ID 解析模式」。**
该平台在 `PLATFORM_INFO` 标了 `supportsIdParse`，但本地注册表没有 `parseVideoId`。改用分享链接。

**B站返回 `-352` / 风控页。**
配置 `BILIBILI_COOKIE`，并尽量使用能通过风控的出口 IP。内核已带 buvid Cookie 池兜底，但不保证匿名可用。

**抖音解析被 argus 风控。**
配置 `DOUYIN_COOKIE`；或更换出口网络。内核已做多 UA / 多域名 / DoH 直连兜底。

**快手作者简介/获赞缺失。**
视频解析不依赖 Cookie；作者资料补全需要 `KUAISHOU_COOKIE`。Cookie 失效会静默降级为匿名结果。

**Instagram 返回登录墙提示。**
配置 `IG_COOKIE`。匿名抓取只在少数出口/内容上可用。

**YouTube 返回 `embedOnly`。**
直链源（Piped/Invidious）全部失败，只剩官方嵌入。该结果不缓存，稍后重试或配置可用实例。

**TikTok 报 `YTDLP_NOT_FOUND`。**
运行环境没有 `yt-dlp`。配置 `YTDLP_BIN`（可带参数），或改用带 yt-dlp 的 Docker 镜像；Cloudflare 等无子进程环境不支持。

**调用 `guardedFetch` 抛 `UpstreamThrottledError`。**
平台级节流配额耗尽。宿主应返回 429 / 「请稍后重试」，不要当作内容解析失败。

**`setKernelConfig` 配了 B站/IG/YouTube 没生效。**
这些配置在模块加载时读取。改为在首次 `import` 前写环境变量，见 §6.2。

**分享文案直接传给统一入口没反应。**
先 `extractUrlFromShareText` 抽链接，见 §3.5。

---

## 13. 文件地图

```
src/index.ts                  公开导出白名单（唯一契约）
src/config.ts                 setKernelConfig / getKernelConfig / env 兜底
src/runtime.ts                setRuntime + guardedFetch（fetch/limiter/cache/logger）
src/types/api.ts              ApiResponse / ParseData / ParsedVideoItem 契约
src/config/video-platforms.ts 前端展示用的 VideoPlatformKey
src/utils/filename.ts         sanitizeFilename

src/lib/platforms.ts          PLATFORM_INFO + identifyPlatform（域名唯一真源）
src/lib/share-text.ts         分享文案抽 URL
src/lib/blockedPlatforms.ts   付费/DRM/视频号黑名单
src/lib/normalize-result.ts   出口归一化（别名/类型/删空/B站特例/幂等）
src/lib/parser-kit.js         parseOk / parseFail
src/lib/parser-registry.js    平台 → 本地解析器（13 项）
src/lib/unified-core.js       统一编排 + ID 模式 + 缓存/兜底/验链
src/lib/http.ts               TIMEOUT / UA 常量 / fetchWithTimeout
src/lib/anti-bot.js           滑动窗口 / 风控分类 / sleep
src/lib/api-utils.js          日志 / TTL 缓存 / URL 工具
src/lib/verifyUrl.js          直链 HEAD 校验（保守策略）

src/lib/douyinCore.js         抖音
src/lib/kuaishouCore.js       快手
src/lib/xhsCore.js            小红书
src/lib/bilibiliCore.js       B站视频
src/lib/bilibili-opus.js      B站图文/纯文字动态（纯函数）
src/lib/weiboCore.js          微博
src/lib/twitterCore.js        X / Twitter
src/lib/xiguaCore.js          西瓜视频
src/lib/zuiyouCore.js         最右
src/lib/acfunCore.js          AcFun
src/lib/instagram.js          Instagram
src/lib/tiktokDlp.js          TikTok
src/lib/youtube.js            YouTube
src/lib/qsmusicCore.js        汽水音乐
src/lib/douyin-extract.js     抖音纯提取逻辑
src/lib/douyinFallback.js     抖音/快手公共 API 兜底
src/lib/ytDlpClient.js        yt-dlp 子进程封装
```

扩展阅读（仓库根目录）：

- `docs/architecture.md` §6：web 侧新增平台 SOP（路由 / 前端 / 回归）
- `docs/architecture.md` §8：parse-core 版本化与 semver
- `docs/architecture.md` §9：反爬运行时与关注点边界
- `API.md`：面向 HTTP API 的字段说明
- `docs/bilibili-opus-images-design.md`：B站 opus 设计细节
