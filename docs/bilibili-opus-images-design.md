# B 站动态（/opus/）解析设计

状态：草案，待审查
日期：2026-09-02（2026-10-18 增补纯文字动态）
范围：支持**图文动态**（`type:"image"` + `images[]`）与**纯文字动态**（`type:"text"` + `desc`）；链接为 `www.bilibili.com/opus/<id>` / `m.bilibili.com/opus/<id>` / `www.bilibili.com/dynamic/<id>` / b23.tv 短链跳转后为上述路径

---

## 1. 背景与目标

用户反馈 B 站 UP 主简介获取失败，排查期间实测发现若干接口（`x/space/wbi/acc/info` 等）2026 年起对访客普遍风控（-352 / HTML WAF 页）。进一步调研 B 站图文内容时确认：图文动态本身的服务端接口**畅通无 cookie 即可访问**，可作为独立能力接入。

目标：
- 粘贴 B 站动态链接（`/opus/<id>`）可解析出全部图片 + 动态文案 + 作者信息；纯文字动态可解析出正文 + 作者信息
- 前端以图集卡片展示图文（单图大图 / 多图网格，支持「一键下载全部图片」）；纯文字以「动态文案」展示正文
- 复用现有 bilibili 平台链路，**不新增平台**，视频解析零回归

## 2. 现状关键结论（实测）

### 2.1 接口可用性
`GET https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=<opusid>&features=itemOpusStyle`
- **无需 cookie / wbi 签名**即可返回（海外出口亦验证通过），只需浏览器 UA + Referer
- 图片 URL 来自 `modules.module_dynamic.major.opus.pics[].url`，hdslb 图床直链。
  ⚠️ **hdslb 有 Referer 防盗链**（2026-09-02 实测：浏览器带第三方 Referer 直链加载返回 403 text/html；
  服务端无 Referer fetch 返回 200 image/*；B 站 Referer 放行）。因此**web 接口出参中的图集/头像必须包成
  `/api/image` 同源代理**（服务端无 Referer 回源），与头像/封面/小红书/微博图片的处理一致。
  2026-10-18 起这层改写由 web 出口统一完成（`src/lib/image-proxy.js`，挂在 `createApiHandler` 的
  `normalizeResult` 之后；ID 直查分支同）：**内核只输出 https 直链，桌面端按直链自行取流**，
  web 的 JSON 出参才是代理串。
- 纯文字正文来自 `major.opus.summary.text`（features 形态，`desc` 为 null）；无 features 形态回退
  `module_dynamic.desc.text`。2026-10-18 实测 `DYNAMIC_TYPE_WORD` 样例两者均验证。

### 2.2 内容类型（边界关键）
detail 返回的 `item.type` 实测存在多种取值，**不能只按「pics 非空」判定**：

| type | 样例 | 内容位置 | 是否支持 |
|---|---|---|---|
| `DYNAMIC_TYPE_DRAW` | 图文动态（发图文） | `major.opus.pics[]` 全量图片；无图时正文在 `summary.text` | ✅ 有图→image / 无图→text |
| `DYNAMIC_TYPE_OPUS` | 新版图文动态 | 同上 | ✅ 有图→image / 无图→text |
| `DYNAMIC_TYPE_WORD` | 纯文字动态 | `major.opus.summary.text`（`pics: []`） | ✅ text |
| `DYNAMIC_TYPE_ARTICLE` | 专栏文章投递到动态 | pics 只有 1 张封面，正文图需走已风控的 `x/article/view` | ❌ 明确拒绝 |
| 其它（AV/转发/音乐等） | — | 媒体在别处 | ❌ 明确拒绝 |

判定规则：`type ∈ {DRAW, OPUS, WORD}`：`pics.length > 0` → `image`；否则正文非空 → `text`；正文也为空 → 拒绝。`ARTICLE` → 专属提示；其余类型 → 通用提示。

### 2.3 现有链路（无需改动点）
- 统一入口 `/api/parse` → `unifiedParser` → `platformRoutes.bilibili` 动态 import `/api/bilibili/route.js` 的 `GET`（内部构造 Request 调 `createApiHandler` 包装的解析函数，出口已 `normalizeResult`）
- `/api/bilibili/route.js` 视频解析返回 `{ code:1, data: 分P数组, title… }`，`normalizeResult` 走 **bilibili 特例**（`data` 为数组）
- **图文返回若为 `{ code:200, data: { type:"image", …统一字段 } }`，将走 normalizeResult 通用分支**（`data` 为对象 → `out={...src}` 透传），无需新增归一化特例
- `fmt=text`（iOS 快捷指令）已支持 `data.images[0]` 兜底直链
- 前端渲染链：URL → 前端平台 key `bilibili` → `platformRenderers.bilibili = BilibiliVideo`，opus 与视频同平台

## 3. 后端设计（`src/app/api/bilibili/route.js`）

### 3.1 入口分流
- 现有视频解析函数体保持不动（改名不必要，保留函数名即可），在其**开头**做 URL 判定：
  1. 统一 URL 归一（保留现有 `cleanUrlParameters`），b23.tv 短链先 `redirect: "follow"` 解析出最终 URL
  2. 最终 URL pathname 匹配 `/\/(?:opus|dynamic)\/(\d+)/` → 转入新函数 `parseBilibiliOpus`
  3. 否则维持原视频逻辑（bvid 提取改为基于最终 URL，与现状等价）
- 仅新增一个导出解析函数或保持函数内部分流，`createApiHandler` 包装方式不变，域名白名单（`bilibili.com` / `b23.tv`）天然覆盖

### 3.2 `parseBilibiliOpus(url)` 流程
```
1. 提取 opus id（数字）
2. GET x/polymer/web-dynamic/v1/detail?id=<id>&features=itemOpusStyle
   （复用 bilibiliRequest：自动 UA/Accept-Language/Referer + Cookie 池 buvid 兜底）
3. 判定 item.type / pics（见 2.2）
4. 字段映射（见 3.3）
5. 并行补调：空间统计（作者卡）+ x/polymer/web-dynamic/v1/opus/detail（收藏数）
6. 返回 { code: 200, msg: "解析成功！", data: {…} }
```
异常统一 try/catch，返回 `{ code: 0, msg }` 与视频失败的 code 语义一致（中间件对非 200/1 原样透传）。

### 3.3 字段映射（统一 `ParseData` 契约）
| 统一字段 | 来源 | 备注 |
|---|---|---|
| `type` | 有图固定 `"image"`；无图 `"text"` | 前端据此走图集 / 纯文字分支 |
| `title` | `major.opus.title` | 缺失时前端标题行自动隐藏 |
| `desc` | `major.opus.summary.text`（回退 `module_dynamic.desc.text`） | 图文为动态文案；纯文字即正文 |
| `cover` | `pics[0].url` | 仅图文；归一 https |
| `images` | `pics[].url` | 仅图文；全部归一 https，顺序保持 |
| `author` / `authorId` | `module_author.name` / `mid` | mid → String |
| `avatar` | `module_author.face` | 内核转 https 直链；web 出口统一包成 `/api/image` |
| `authorUrl` | `https://space.bilibili.com/${mid}` | 与视频一致 |
| `time` | `module_author.pub_ts` | unix 秒 |
| `stat` | `module_stat` + opus/detail 补充 | `{ like, reply: comment.count, favorite, share: forward.count }` |

> 收藏数来源：常规 detail 接口实测（含 `itemOpusStyle` 等各 features 组合）只返回 `comment`/`forward`/`like`，**没有 `favorite` 键**；而 opus 页面同源接口 `x/polymer/web-dynamic/v1/opus/detail?id=<id>` 的 `data.item.modules` 是模块数组，其中 `MODULE_TYPE_STAT` 项的 `module_stat.favorite.count` 即收藏数（实测样例 19 / 1 / 2）。解析器在 detail 成功后并行补调该接口（与 UP 主空间统计并行），提取成功才写入 `stat.favorite`；请求失败、字段缺失或计数为 0 时保持缺失（不造数），前端收藏行自动隐藏。该补充只影响展示，不影响主解析结果。
>
> 说明：不给 `data.url` 媒体直链（图片非签名直链，textMode/verifyDirectUrl 均按现有 images 兜底逻辑处理，不触发 `verifyDirectUrl` 验证）。纯文字无 `cover`/`images`/`url`/`videos`，`fmt=text` 由 `desc` 兜底输出正文。

### 3.4 边界 / 错误文案（`code: 0`）
| 情形 | msg |
|---|---|
| `DYNAMIC_TYPE_ARTICLE` | 「该动态是 B 站专栏文章，非图文动态，暂不支持解析正文图片」 |
| DRAW/OPUS/WORD 但无图且正文为空 | 「该动态不包含可解析的文字或图片内容」 |
| 其它类型（视频/转发/音乐动态） | 「该动态不是图文或文字内容，暂不支持解析」 |
| 网络失败 / WAF | 与视频一致：「解析失败！」（含日志） |

## 4. 前端设计

### 4.1 `BilibiliVideo.tsx`（`src/components/videos/`）
- 组件内判定：`const isImage = parsed?.type === "image" && (parsed?.images?.length ?? 0) > 0`；
  `const isText = parsed?.type === "text"`（纯文字动态）
- **作者卡**：图文、纯文字与视频共用现有卡片（UP主/UID/简介/关注·粉丝·获赞/头像渐变蓝徽），零改动
- **图集卡片**（`isImage` 时新增，替代视频播放器区）：
  - 单图：大图（`aspect-square`）展示，点击新窗开原图
  - 多图：`CollapsibleGallery` + 网格（2/3/4 张自适应列数，与 XhsVideo 图集一致）
  - 「一键下载全部图片（N 张）」按钮：`downloadAllImages(images, 'bilibili-'+author)`，B 站蓝渐变（`#00aeec → #4dc9ff`）
  - 图集展示与下载均经 `/api/image` 代理：hdslb 有 Referer 防盗链，浏览器带本站 Referer 直链加载会 403 破图
    （实测，详见 §2.1）。web 接口出参已由后端出口统一包好；组件内的幂等 proxify（`proxifyImageUrl`，
    已代理路径不重复包裹）保留为历史缓存/直链入参的兜底
- **文案区**：图文与纯文字时 `CaptionBox` 标题用「动态文案」（视频保持「视频简介」）
- **信息面板**：图文时 `<ParseInfoPanel platform="bilibiliOpus" title="图文信息" />`；纯文字同用 `bilibiliOpus`
  字段集，标题「动态信息」（内容类型由 `formatType` 映射为「纯文字」）

### 4.2 `ParseInfoPanel.tsx`（`src/components/videos/`）
新增平台字段集 `bilibiliOpus`（标题/发布时间/点赞/评论/收藏/分享 + 内容类型），图文与纯文字共用，避免复用 bilibili 视频表时出现「视频标题 / 内容类型:视频」错误标签。仅配置表新增一行，不改组件逻辑。

### 4.3 无需改动
`platformRenderers` / `video-platforms` / 平台识别（域名级，opus 与视频同域名）/ 页面主流程。

## 5. 测试策略
| 类型 | 内容 |
|---|---|
| 单测 | `tests/bilibili-opus.test.ts`：DRAW/OPUS 图文、WORD 纯文字、无图 DRAW、无 features 回退、ARTICLE/AV 拒绝、空动态拒绝、收藏数提取（有值/0/缺失/结构不符） |
| 单测 | `tests/normalize-result.test.ts`：opus 形状（data 为对象、code 200）经通用分支透传 images/type/stat 等 |
| 单测 | `tests/live/parse-live.test.ts` 增补 `bilibili-opus` / `bilibili-opus-text` case（env `LIVE_URL_BILIBILI_OPUS` / `LIVE_URL_BILIBILI_OPUS_TEXT`；图文断言 `data.images[0]`，纯文字断言 `type=text` + `desc`） |
| live 样例 | `urls.example.env` 增加 `LIVE_URL_BILIBILI_OPUS`（纯图文 DRAW 样例）与 `LIVE_URL_BILIBILI_OPUS_TEXT`（WORD 样例） |
| 手工回归 | DRAW 图文解析 / WORD 纯文字解析 / ARTICLE 专栏提示 / 空动态提示 / b23 短链 / 视频多分 P 零回归 / fmt=text |

## 6. 风险与备注
- pics 结构信任 detail API（DRAW/OPUS 全量；ARTICLE 仅封面故拒绝），不兼容老 `t.bilibili.com/<id>` 动态页（不在本次范围，遇之按「不是 /opus/ 链接」提示沿用现视频逻辑报错文案即可）
- 图片直链长期有效（非签名 URL），`GET /api/bilibili` 维持 `shouldCache: false` 不引入新缓存语义
- 部署后需手动触发部署 workflow 上线（同历史行为）

## 7. 验收清单
- [ ] 纯图文 opus 链接 → 返回 code 200 + data.type=image + images 全部原图
- [ ] 纯文字动态（WORD / 无图）→ 返回 code 200 + data.type=text + data.desc 正文
- [ ] 专栏文章 opus → code 0 + 专属文案
- [ ] 前端图集卡片：单图大图 / 多图网格 / 一键下载全部
- [ ] 前端纯文字：动态文案 + 动态信息（不再出现「视频简介/视频信息」）
- [ ] 视频链接解析与展示无回归
- [ ] 新增/更新测试通过（`npm test`，live 按 env 可跑）
