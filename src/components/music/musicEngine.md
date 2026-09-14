# 音乐聚合播放器「搜歌-播放」架构说明（现状基线 + 换源增强路线）

> 适用：/music 音乐中心（MusicExplorer）与后端音乐接口（`/api/music`、`/api/music/self`、`/api/music/resolve`）。
> 定位：本文是**模块内设计文档**，面向实现与改造。术语、字段、路由必须与 `src/lib/music-client.ts`、`src/lib/gdmusic.js`、`src/components/music/use-player-engine.ts`、`src/app/api/music/**` 实际代码一致；落地任何增强后，同步刷新 `CLAUDE.md` / `API.md` 的相关描述。
> 核心设计：**搜索与播放解耦，ID 优先播放、懒降级半自动换源，相似度校验防错歌，分层缓存减少第三方请求**。
> 用途约束：个人学习研究使用，禁止商用；第三方请求遵循“最小打扰”。

---

## 目录

1. 现状架构基线（已落地代码事实）
2. 现状约束清单（增强设计的地基）
3. 增强目标与不变式
4. 播放失败闭环（核心）
5. 候选池的落地边界
6. 相似度匹配规则 v2（防错歌）
7. 缓存体系 v2（分层 + 部署载体约束）
8. 前端交互（现状 + 增强后分支）
9. 性能与调优方向
10. 分阶段实施计划
11. 风险与边界

---

## 1. 现状架构基线

### 1.1 分层与文件

```
┌ UI 面板（MusicExplorer / PlayerBar / LyricPage / NowPlayingPanel / PlaylistPanel / TrackInfoDialog …）
│   只消费「快照 + 命令」，不持有 <audio>、不拼直链
├ use-player-engine.ts  播放引擎：会话编排 + HTML5 transport（audioProps）
│   快照：picked/currentIndex/br/direct/fetching/playing/playError/currentTime/duration/volume/muted/loop
│   命令：playTrack/playPrev/playNext/togglePlay/seek/switchQuality/setVolume/setMuted/setLoop/resetSession
├ use-media-session.ts  媒体会话音乐适配层：把曲目（歌名/歌手/专辑 + 平台品牌回退封面）映射进
│                       通用内核 components/media-session/use-now-playing.ts（元数据 / 播放态 /
│                       进度 / 系统媒体键 / 站点标题「歌曲 - 歌手」；品牌 SVG 由 brand-artwork.ts
│                       栅格化为 PNG —— platform-brand.ts 提供 label/色/public-logos SVG）
│                       视频解析页 videos/use-video-media-session.ts 复用同一内核，只换字段映射
├ music-client.ts       源通道引擎：sourceEngineKindFor/Caps（gd|self）、代理优先直连兜底、
│                       自研直连搜索分派 / netease·kuwo 自研为主、GD 搜索引擎兜底（会话标记）、
│                       下载与封面决策收敛（trackDownloadSpec/coverBinUrl）；UI 不得读 isDirectUsed 或手拼 URL
└ 服务端 routes
   /api/music        （provider=gd）    gdmusic.js  组装 GD 契约 types=url/search/pic/lyric，多基址 8s 预算回退
   /api/music/self   （自研直连，search/url）lib/self-search/（index/errors + netease/tencent/kugou/kuwo/migu 各一模块；kugou 官方试听直链在 kugou.js）
   /api/music/resolve                  music-link.ts 纯函数识别 → 官方详情通道（netease-meta / qqmusic / kuwo-meta / kugou getSongInfo）
   /api/music/caps   平台能力矩阵下发  lib/music-platform-flags.js（后端真源，读 env）→ 前端 lib/music-caps.ts 拉取过滤
```

> 自研直连搜索（`/api/music/self`）的定位与价值：`tencent`/`kugou`/`migu` 是 GD 未开放搜索的**独立搜索源 chips**；`netease`/`kuwo` 双通道：搜索以本通道为主，自研失败才回退 GD 搜索引擎（会话置位后同源翻页直接走 GD）。搜索结果归一为 GD 搜索同契约 SearchItem（`line.kind=self`）；封面不强求——搜索响应能内嵌的图床 URL 写入 `picUrlDirect` 直接展示，**不做二次换取**。`tencent`/`netease`/`kuwo` 的 id 与 GD 直链通道所需 id 一致可复用；`kugou` 已内置官方免费试听直链（`action=url` → `getSongInfo`，免费档 128k mp3，VIP/付费曲取链失败返回 `failType=vip-only`，见 `src/lib/self-search/kugou.js`）；`migu` 仍无内置直链引擎（`sourceEngineKindFor → self`，`SELF_ONLY_ENGINE_KEYS`），默认只能搜索展示（点播 / 封面 / 歌词抛明确 biz 提示，见 §8）。

关键不变量（代码事实）：

- **UI 无状态请求、无直链拼装**：直链/封面/下载 URL 一律由 `music-client` 出口；服务端失败按 `kind` 分类，`proxy` 通道不可用才允许浏览器直连 GD 公共源，且一次成功会话内即记忆（`directUsed`）。
- **播放调度在前端**：`use-player-engine` 的 `playTrack(item, index)` 拿到 `SearchItem` 后走 `requestPlayDirect(source, item, br)`（music-client 播放统一取链入口：GD 主通道、kugou 官方直链、migu 无内置直链（`SELF_ONLY_ENGINE_KEYS`，直接抛 `NO_ENGINE_MSG`），见 §1.3 步骤 2），就绪后经 `canplay` 起播；切音质 `switchQuality` 同样走 `requestPlayDirect`，热切换“旧档不打断、新源 seek 续播”；自然 `ended` 后 `playNext`（队尾且有 `hasMore` 时先 `fetchMorePage` 再播新页第一首）。
- **后端是薄动作 API，不维护播放会话**：`/api/music` 只做「按 source+id+br 取直链 / 按词搜索 / pic / lyric」。增强不得改成后端持会话的长连接式设计。
- **列表内 `musicKey` 唯一**：单源结果列表是「翻页累积」的，而 netease/kuwo 双通道共用同一套 id 空间、分页窗口却错位（实测同关键词自研第 2 页与 GD 第 2 页 20 条可重合 16 条），会话内转 GD 兜底后同源翻页会把前几页给过的歌再给一遍。故列表的每次写入（新搜索 / 翻页累积 / 聚合结果 / 快照恢复）都过 `music-match.dedupeSearchItems` 收敛，行 key（`source-id`）唯一性由它保证。

### 1.2 数据模型与契约（对齐 music-client / API.md）

| 结构 | 关键字段 | 备注 |
|---|---|---|
| `SearchItem`（搜索与 resolve 归一产物） | `id / urlId / name / artist[] / album / source / picId / lyricId / picUrlDirect? / line?` | `urlId` 才是取直链用 ID；`line.kind` = `proxy\|direct\|self`（自研直连通道产物，仅带 `picUrlDirect` 时才有可直接展示封面，无 `picId` 二次换取语义） |
| `DirectData` | `url / br / size / source / id` | 直链带时效 token，**只可缓存 {source,id}，不可缓存 URL** |
| `ResolveData` | `status: "playable"\|"engine-missing"`、`platform / songId / metadata: "full"\|"fallback" / item?` | `playable` 后播放仍走 `requestDirect` |
| br 档位 | `128 / 192 / 320 / 740 / 999` | 前端默认 `BR_DEFAULT="320"`；后端 `action=url` 缺省 `999`——两处默认不一致，取直链必须显式传 br |
| 错误契约 | HTTP 400/404/502 + `failType` | `source-unavailable` / `not-found` / `sources-down`；400 带参数说明 |

### 1.3 播放链路（现状时序）

1. 列表点击/链接解析成功 → `playTrack(item)`：置位 `picked/fetching`，`unlockAutoplay()`（用户手势内静音试播解锁）。
2. `requestPlayDirect(source, item, br)`（music-client 播放统一取链入口）：GD 源 → `/api/music`（代理 `kind=down` 才直连）；kugou（self 源，已内置直链）→ `/api/music/self?action=url`（官方 `getSongInfo`，免费档 128k mp3，VIP/付费曲取链失败）；migu（self 源，`SELF_ONLY_ENGINE_KEYS` 无内置直链）→ 直接抛 `NO_ENGINE_MSG`（见 §8「仅 migu」分支）。
3. 成功 `setDirect(data)` → `<audio src>` 资源 `canplay` 后 `play()`（被自动播放策略拦截时静音起播再还原用户音量设置）。
4. 失败仅 `setPlayError(msg)` 展示，**当前无自动换源**；队列续播只由 `ended` 驱动。
5. 封面走 `requestPic`（picId→URL，代理可用时 `coverBinUrl` 同源取色）；下载由 `trackDownloadSpec` 决策 `bin`（同源字节代理、文件名带音质标签）或 `external`。

   **`bin` 分支不能用 `<a download href>` 直连**（踩过的坑）：那样浏览器会把服务端
   **错误响应也照存成文件**——上游偶发失败（防盗链 403 / 直链过期 / 风控 JSON）时用户
   点下载得到的是内容全为 JSON 的 `.json` 文件，且没有任何提示。现状是 UI 调
   `downloadBinTrack()`：先取回字节、确认状态与 `Content-Type` 是音频后才落盘，失败抛
   `MusicDownloadError` 由父层弹轻提示。服务端侧同样设了两道闸：`bin=1` 命中直链缓存
   也**必须**去源站取字节（缓存里是解析结果 JSON，直接回它等于把 JSON 当文件下发），
   且非音频响应一律回 `502 sources-down` 并失效该直链缓存（见 `API.md` §12）。

---

## 2. 现状约束清单（增强设计的地基）

> ⚠️ **2026-09 变更：平台「搜索引擎」与「播放引擎」改为部署可配开关（双层能力矩阵）**——tencent（QQ音乐）代码与注册**完整保留**，开关**默认两维全开**（可由 env / 设置页 `/music/settings` 收敛）；开关关闭 = UI 不展示 + 后端拒绝动作，恢复/关闭无需再改代码：
>
> - **真源与下发**：后端唯一真源 `src/lib/music-platform-flags.js`（读 env、动态生效）；前端默认矩阵与后端同值源（`src/lib/music-caps.ts`），挂载时拉 `/api/music/caps` 覆盖为“生效矩阵”（未拉到前按默认过滤，防首帧闪烁）。
> - **开关模型**：面向用户的 6 平台（netease/tencent/kugou/kuwo/migu/joox）各含二维开关 `search`（搜索引擎）/ `play`（播放引擎 = 取直链通道）。默认值：两维均 6 平台全开（`MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY` 留空即全开，2026-09 起；需要收敛时用 `*_DISABLED` 黑名单 / `MUSIC_PLATFORM_OFF` 或设置页 `/music/settings` 单独停用）——kugou 为内置官方免费试听直链（免费档 128k mp3，VIP/付费曲取链失败 `vip-only`），migu 无内置直链（`SELF_ONLY_ENGINE_KEYS`）；tencent 的 GD 取链上游不开放（实测 400），**开关放开 ≠ 取链必然可用**。
> - **关闭表现**：`search` 关 → 前端不展示该源 chip / 聚合候选（`MusicExplorer` 过滤 `SELF_SEARCH_SOURCES` + `buildSearchChips`），后端 `action=search` 与 `/api/music/self` 拒绝并 400 `source-unavailable`（文案含“可配置 MUSIC_PLATFORM_SEARCH 开启”）；`play` 关 → `/api/music?action=url` 拒绝取链、`/api/music/resolve` 识别成功但返回 `engine-missing`（文案含 `MUSIC_PLATFORM_PLAY`）。
> - **语义边界**：仅“面向用户的 6 平台”受开关约束；GD-only 源不在全集内，恒视为启用（避免误伤）。歌词/封面/pic 等数据通道不受开关影响，resolve 的歌曲识别与官方详情元数据同理不受影响。
> - **内置播放引擎总开关（第四维，2026-09，独立于平台矩阵）**：站点自带取直链通道（GD 公共上游 `/api/music` + 自研直连 `/api/music/self`）的总闸。真源同为 `music-platform-flags.js`（`resolveBuiltinPlayBaseline` / `isBuiltinPlayLocked`），env `MUSIC_BUILTIN_PLAY`（`off` = **运维终闸**：强制关闭且配置文档无法复活，设置页 C 区块显示「部署锁定」；`on` / 留空 / `default` = 基线开启，面板可自由开关）→ 配置文档字段 `builtinPlay`（服务端求值 `resolveEffectiveMusicBuiltinPlay`）→ caps 下发 `builtinPlay:{enabled,locked}`（前端 `music-caps.ts` 的 `isBuiltinPlayOn()` / `getBuiltinPlay()`）。**关闭表现**：`/api/music?action=url` 与 `/api/music/self?action=url` 一律 400；resolve 识别成功但回 `engine-missing`（**优先于**平台级 `play` 判定）；前端 `crossSearchPlayableSourceKeys` 剔除全部内置源（跨源候选为空）、`requestDirect` 拦截内置通道、`requestPlayDirect` 抛 `BUILTIN_PLAY_OFF_MSG`；设置页 C 区块顶部为总开关行，关闭时 A 区块 6 个播放开关整体呈从属停用态（**槽位存储值不变**，重新开启即恢复原配置）。**搜索 / 歌词 / 封面 / 链接识别等数据通道不受影响**（与平台 `play` 开关的收敛面不同：后者只关单平台取链）。
> - 下文凡提及 tencent 为“独立搜索源 chips / 可搜可播集合”之处，均指**开关放开后的启用态**；默认部署即放开态（后端 `enabledPlatformList` / 前端 `getPlatformCaps` 为唯一口径）。

以下限制来自已落地上游契约，**任何增强方案都不得假设这些约束不存在**：

| # | 约束 | 影响 |
|---|---|---|
| C1 | GD `action=search` 只开放 `netease / kuwo / joox`，其余 source（含 `tencent`）返回 400 | 「自动跨源搜同名」只能在**可搜索源集合**（GD 三源 + 自研直连源）内发生 |
| C2 | GD search 响应字段无时长，`SearchItem` 未透传 duration | 原方案“时长 20 分、差 >15s 淘汰”在**解析失败降级段无法计算**，见 §6 两段式 |
| C3 | `resolve` 识别与官方详情 ready：netease/tencent/kuwo/kugou（kugou 走官方 `getSongInfo` 详情并直接返回可播曲目）。（2026-09 起 tencent 播放引擎默认放开，识别成功即回 `playable`；若部署侧用 `MUSIC_PLATFORM_PLAY_DISABLED` / 面板停用 tencent，则识别成功亦回 `engine-missing`） | 官方高置信候选覆盖面有限，QQ 候选是否可播随开关收敛 |
| C4 | 直链均带时效，`requestDirect` 每次现取 | 任何“缓存可用歌曲”都只是缓存 **候选 ID** |
| C5 | 部署形态三选一：Docker standalone（当前线上，进程内存单实例）/ Vercel / CF Workers(OpenNext) | 缓存载体需按部署选型，见 §7 |
| C6 | 播放态失败（403/404/410/CORS/超时）发生在 `audio` 元素层，`use-player-engine` transport 当前未上送 `onError` | 需要补 transport 事件，失败才能进入换源闭环 |
| C7 | 自研直连搜索通道（`/api/music/self`）可搜 netease/tencent/kugou/kuwo/migu：tencent/kugou/migu 为独立搜索源 chips（GD 无其搜索），netease/kuwo 双通道：本通道为主，自研失败才回退 GD 搜索引擎。kugou 已内置官方免费试听直链（`/api/music/self?action=url` → `getSongInfo`，免费档 128k mp3，VIP/付费曲取链失败 `failType=vip-only`）；migu 仍**无内置直链引擎**（`SELF_ONLY_ENGINE_KEYS`，`sourceEngineKindFor → self`），默认只能搜索展示（封面/歌词等数据通道抛明确 biz 提示） | 换源候选只收录**可播放**的源（netease/kuwo/tencent/joox/kugou，随 search+play 开关收敛），migu 即便搜到同名也不进自动候选（kugou 默认即候选）；引擎对 migu（`SELF_ONLY_ENGINE_KEYS`）跳过自动换源闭环（确定性失败避免空转）；kugou 直链失败属业务性（VIP/下架/网络），正常进入候选遍历 |

---

## 3. 增强目标与不变式

价值主张延续 v1，并显式声明以下不变式：

1. **ID 优先播放**：所有入口（搜索、resolve、候选）最终都归结为 `{source, id/urlId}`；直链永远最后一步现取。
2. **懒降级 + 半自动换源**：仅在**当前候选失败**时才寻找同歌候选；**禁止静默换低匹配歌曲**（防错歌安全阀）。
3. **自动候选只信高置信**：≥阈值才自动重试；低置信一律交人工；无候选给可操作的原因与建议。
4. **决策层保持前端**：候选遍历、打分选择由前端引擎/纯函数驱动（可单测），后端只新增无状态动作接口。
5. **不破坏现有单一数据流**：搜索结果列表仍按“源”分组展示，候选池只作为“失败后找替代品”的次级数据，不混入主列表。

---

## 4. 播放失败闭环（核心修订）

### 4.1 两个失败来源（必须同时接入）

| 失败来源 | 判定位置 | 现有处理 | 增强动作 |
|---|---|---|---|
| `resolve-fail` 解析失败 | `requestDirect` 抛错（`MusicError` kind + `failType`） | `playError` 提示 | 按 §6.1 分类记黑名单 → 取下一候选 |
| `play-fail` 播放态失败 | `<audio>` `error` 事件 / `fetch` 直链 HTTP 403/404/410/超时 / `MediaError` code | **未接入** | transport 增加 `onError` 上送（`use-player-engine` 的 `audioProps` 补 `onError`，合入 `playError`），并作为候选遍历触发源 |

**修订理由**：多源聚合最常碰到的其实是“URL 拿到了但 `<audio>` 一播就挂”（防盗链、token 即时失效、地区限制），只处理解析失败等于漏掉主战场。引擎对外快照/命令接口不变，仅在 transport 区块扩展 `onError` 一个回调，符合「快照+命令」界面稳定原则。

### 4.2 换源循环（前端驱动，单轮有界）

```
CURRENT(source,id,br)
  ├─ resolve-fail / play-fail（且失败类别允许换源）
  │     → 记源黑名单 → 取同歌下一候选（来源见 §5）
  │         ├─ auto(≥阈值) → 直接 requestDirect 重试
  │         ├─ manual(阈值内) → 停下来，弹 select 面板交人工（§8）
  │         └─ 无候选 → 返回 fail + 原因；写降级负缓存（§7）
  └─ 成功 → 记录候选缓存（写入条件见 §7）
```

轮次上界：**一次失败最多 1 轮 suggest**；每轮内解析尝试 ≤ `behavior.maxAttempts` 个候选（默认 4，专用设置页 `/music/settings` 可调 1–8，见 §4.4）；单个 URL 请求最多重试 1 次（间隔 300–500ms）；同 `source+id` 在失败黑名单 TTL 内不再重试。目标：单轮自动换源对第三方的请求上界 = 1 次 suggest（≈ 搜索源数 × 1 个 search，串行或并发上限 2）+ ≤ `maxAttempts` 次 `url`。

### 4.4 自动换源行为配置（部署级，设置页可调）

四项行为配置与平台引擎开关一起由 `/api/music/caps` 下发（Turso 配置文档 `music.flags`；在专用设置页 `/music/settings`（登录鉴权，登录页 `/music/settings/login`）调整，写入走登录会话 Cookie 或 `SETTINGS_API_KEY` Bearer；求值与降级语义见 `API.md` 12.6）：

| 配置 | 默认 | 生效点（`use-player-engine.ts`） |
|---|---|---|
| `autoFallback.enabled` | `true` | `runAutoFallback` 入口 + 两个调用点（`playTrack` 的 resolve 失败分支、`audioProps.onError` 的 play 失败分支）前置判空：关闭时**不进入换源闭环**，保留既有 `playError` 文案 |
| `autoFallback.maxAttempts` | `4` | 换源循环的条件上界（`st.count >= behavior.maxAttempts`） |
| `autoFallback.crossSearch` | `true` | 队列内无自动候选时是否跑那一轮跨源现搜；关闭时跳过现搜，直接收尾 |
| `autoFallback.showManualDialog` | `true` | 收尾时是否把未尝试候选写入 `alternatives`（驱动 `AltSelectDialog`）；关闭时只保留最终 `playError` |

读取时机：`runAutoFallback` 入口与每个调用点各读一次 `getMusicBehavior()`（模块级快照，不参与 React 渲染），同轮内不重复读，避免一轮尝试中因配置刷新产生漂移。前端默认值与后端同源（`MUSIC_BEHAVIOR_DEFAULTS` / `MUSIC_BEHAVIOR_LIMITS`，见 `src/lib/music-platform-flags.js`）。

### 4.3 失败类别 × 重试策略（分级）

| failType / 现象 | 归类 | 重试策略 |
|---|---|---|
| `sources-down` / 代理 5xx | 瞬时通道故障 | 本候选取消，全轮重试前退避（指数，上限 30min） |
| 上游超时 | 解析器瞬时异常 | 退避 2min 后可再试 |
| `not-found` / `source-unavailable` / “无版权/无音源” | 源级确定失败 | **不再自动重试该 `source+id`**，长记（歌曲级黑名单） |
| `play-fail` 403/404/410 | 直链失效（token/防盗链） | 该候选降权；同一 {source,id} 记短期黑名单（因为重取 URL 可能拿到新 token） |
| 参数类 400（source/br 非法） | 配置错误 | 直接 human，不消耗候选 |

---

## 5. 候选池的落地边界

候选池 = 与当前曲目“同歌”的 `{source, id, 元数据指纹}` 列表，按来源与置信排列。**候选只从以下四类来源产生**，不对任意平台凭空改名搜索：

| 来源 | 说明 | 置信基准 | 成本 |
|---|---|---|---|
| A 队列内近似 | 当前 keyword 搜索结果列表里经清洗标题+歌手比对出的同歌不同版本条目 | 文本可证，多数可直接 auto | 0（已持有） |
| B 可搜索源现搜 | 在「可搜可播源（netease/kuwo/tencent/kugou/joox：netease·kuwo 自研为主 GD 兜底、tencent/kugou 自研、joox 仅 GD；kugou 已内置官方直链默认即候选、migu 无直链引擎仅展示并剔除）」内，以清洗后歌名+主歌手逐源 search 第 1 页（count=20，分派与列表搜索一致：self-first / GD-fallback），打分过滤后并入 | §6 打分，≥75 才 auto | 每源 1 次 search，必须串行或 ≤2 并发 |
| C 会话内已 resolve 曲目 | 本会话粘贴链接解析出的官方曲目（netease/tencent/kuwo，`metadata=full`） | 官方详情高置信 | 0（会话内） |
| D 历史播放成功缓存 | 本曲“真实播放成功”过的候选（见 §7 层①） | 曾真实可播 | 0 |

约束映射（对照 §2/C7）：netease/kuwo/tencent/kugou/joox 均可搜可播（netease·kuwo 走 self-first / GD-fallback，kugou 走内置官方直链），migu 借自研通道可搜但 **无直链引擎**（`SELF_ONLY_ENGINE_KEYS`），B 只收录可播放源（netease/kuwo/tencent/kugou/joox）；resolve 过的官方曲目仍进 B/C。

规则：

- 候选条目统一带 `provenance`（`list|multi-search|resolve|cache`）与打分，供 UI 展示来源标签。
- **专辑不同即视为不同版本**：B 里与当前曲目专辑不同（且当前/候选专辑均非空）的同名曲，不得 auto，降级为 manual（防“同名串歌”，也让缓存不串版本）。
- 主列表不动：候选数据与主搜索列表分开存（如引擎新增 `alternatives` 快照），避免污染既有选择/队列语义。

---

## 6. 相似度匹配规则 v2（防错歌）

### 6.1 文本清洗（沿用 v1 并增补）

剔除歌名括号/方括号内版本标记（保留“标题(ft.xx)”等主标题），移除版本词黑名单（`伴奏/纯音乐/翻唱/翻奏/现场版/Live/Remix/Demo/KTV/cover` 等，词表可配置扩展）；歌手名规范化（去 `feat./ft.` 段、统一 `&`/`and`/全半角与大小写，预留别名表挂载点）。

### 6.2 打分（两段式——修正 v1 的时长盲点）

| 维度 | 权重 | 说明（修订） |
|---|---|---|
| 歌手匹配 | 40 | 拆分歌手数组两两比对取 best-match 再平均；只比较规范化后的名字，容编辑距离（如 1） |
| 歌名匹配 | 30 | 用清洗后标题；相等满分，包含/编辑距离递减 |
| 专辑匹配 | 10 | 一致加分；不一致**不淘汰**（平台专辑命名差异），但触发 §5 的 manual 规则 |
| 时长匹配 | 20 | **仅在“具备高可信时长”时启用**：官方详情（resolve C 类）或本曲真实播放已获得 duration。差值 ≤25s 内按接近给分，>25s 直接淘汰；时长缺失给中性分 0 并**不**把该维度分母计入（即按可得维度归一） |

**两段语义**：
- 第一段（解析失败降级，B/A 类，通常无时长）：只算歌手+歌名+专辑 = 满分 80，按比例归一到 100 与阈值比较。
- 第二段（播放态失败再降级，C/D 类或已真实播过旧版本）：此时本曲真实 duration 已知，才启用时长硬校验——这也是 GD search 无 duration 约束（C2）下的正确解法：**真实播放时长是本歌 ground truth，绝不拿“另一版本录音的猜测时长”去误杀**。

### 6.3 阈值与输出

- `≥75`：高匹配，可 auto 尝试（需过 §5 专辑不同 → manual 例外）。
- `60–74`：低匹配，禁止自动，弹 select 面板人工选择。
- `<60`：丢弃。
- 个人使用不建议把 auto 阈值降到 <70。

---

## 7. 缓存体系 v2

### 7.1 缓存分层

| 层 | Key | Value | TTL | 写回条件 |
|---|---|---|---|---|
| ① 可用候选缓存 | `normalize(清洗标题) + sortedArtists`（utf-8 原文保留于 value） | 按可用优先级排序的 `[{source,id, album?, provenance}]` | 7 天 | **仅“真实播放成功”或“人工确认过”**才写；仅解析成功无播放证据只记临时半可信（低优先，不排前） |
| ② 搜索结果缓存 | keyword+source+page | 搜索页 | 30–60s | 每页成功后写 |
| ③ 降级负缓存 | 同层① key | “最近已降级/无合格候选”标记 + 时间 | 5–10min | 降级轮以 fail/manual 结束且无缓存命中时写 |
| ④ 失败黑名单 | `source+id`（或歌曲级） | 失败类别 + 时间戳 | **分级**：瞬时 2min / `sources-down` 指数退避 cap 30min / `not-found`·无版权歌曲级长期 | 对应失败发生时 |
| ⑤ 详情缓存（已有） | resolve 官方详情 | 元数据 | 详情 5min | 维持现状 |

作用链：层③ 防止“烂歌”反复触发整轮 suggest（负缓存挡住的是搜索成本，层④ 只挡解析成本）；层① 让熟歌秒起且不发 suggest。

### 7.2 载体选型（对照部署形态 C5）

- 进程内 Map（现 `api-utils` 缓存同思路）：开发环境与 **Docker 单实例**默认可用，层②③④天然满足。
- 层①在单实例下进程内即可；多实例（Vercel/CF）需跨实例共享时才引入外部载体：
  - Cloudflare Workers → `Cache API` / KV（项目已有 `result-cache.js` 先例）；
  - Vercel → Upstash/自管 Redis（可选）。
- **不要在代码里写死某个 Redis 客户端依赖**：抽象成与现有缓存一致的 `get/set/ttl` 接口，按部署注入实现。
- 不变：层④与层①的歌曲级标记在单实例里只存内存，重启可接受。

### 7.3 关键一致性规则

- 直链 URL 永不进任何缓存层（token 时效）。
- 缓存候选在遍历时如果排在首位的“历史成功”再次解析失败 → 当场降权/剔除并触发黑名单，不能让坏候选反复占满 4 个尝试额度。
- 层①写入前过一遍 §6 归一化，防同一歌手数组乱序造成多份 key。

### 7.4 前端本地缓存（本机又快又稳的一层，已落地）

浏览器侧承载「个人偏好 + 准静态大块数据」，与服务端缓存层互补：服务端层解决跨实例共享与第三方请求成本，
本地层解决**首帧可用性**（零网络同步读）与**隐私**（个人行为不出本机）。

| 数据 | 载体 / key | TTL | 实现 |
|---|---|---|---|
| 播放偏好（音量 / 音质档 / 单曲循环 / 静音） | localStorage `mp-player-prefs`（单份 JSON，迁移旧裸数字 `mp-player-volume`） | 永久 | `player-prefs.ts` + `use-player-engine.ts` |
| 音乐页视图（发现歌曲 / 播放列表 / 我的收藏） | Cookie `mp-music-view`（SSR 首帧读）+ localStorage `mp-music-view`（回落） | 永久 | `music-view-store.ts` + `lib/music-view.ts`；视图决定**首屏渲染哪块面板**，故偏好同时写 Cookie 让服务端可知（首帧即正确视图，刷新不闪）；`useMusicView(initialView)` 用 Cookie 值播种内存态，`restoreMusicView()` 只在服务端没读到 Cookie 时兜底 |
| 上次播放会话（曲目 + 进度） | localStorage `mp-playback-session` | 24h | `playback-session.ts`；恢复走引擎 `restorePlayback`（暂停态定位，不自动出声、不进自动换源闭环） |
| 播放列表快照（搜索结果 + 已翻页累积） | localStorage `mp-playlist-cache-v2`（单份 JSON，上限 400 条） | 永久（空结果即清） | `playlist-cache.ts`；仅单平台渠道下写——聚合列表来源混合、刷新后无从恢复，刻意不落盘；是否可回填由 `canRestorePlaylistSnapshot`（渠道偏好为单平台且来源一致）决定，恢复**只回填列表 / 关键词 / 翻页进度，不改写视图** |
| 搜索渠道偏好（聚合 / 单平台） | localStorage `mp-search-channel`（`{v, agg, source}`） | 永久 | `search-channel-pref.ts` 的 `readSearchChannelPref` / `writeSearchChannelPref`；只在用户显式交互时写（点 chip / 提交搜索），链接解析与快照恢复等被动变化不写，避免渠道被拖成并非用户所选。带结构版本号，且恢复时过引擎开关（引擎已关的源回落默认）；**不做内存缓存**（开关异步到达，缓存会固化旧判断） |
| 最近搜索关键词 | localStorage `mp-search-history`（`{v, items}`，上限 8 条） | 永久 | `search-history.ts`；只存关键词不存渠道，点历史词按当前渠道重搜；纯个人行为明细，只留本机（§7.5） |
| 个人收藏（曲目身份 + 元数据） | localStorage `mp-favorites`（`{v, items}`，上限 500 条） | 永久 | `favorites.ts`（纯变换 + IO 原语）+ `favorites-store.ts`（`useSyncExternalStore` 共享态，四处消费：结果行 / 正在播放卡片 / 底部播放条 / 「我的收藏」面板）。唯一键 `musicKey`（`source:id`），**刻意不做跨源合并**（`songIdentityKey` 会误合不同版本）；存 `urlId`（取直链要用，咪咕等源与 `id` 不同）、**不存 `line` 与直链**；上限按 `addedAt` 淘汰最旧；「我的收藏」面板**复用播放列表的 `.mp-row` / `.mp-cell-*` 与同一份逐列宽度变量**，不自持一套行样式（列宽只有一份定义，改列不会漏改一边），差异只有两处内容层面的：**不渲染「线路」列**（收藏不存 `line`，靠 `mp-favs` 换用少拼一条轨道的模板）、**行内动作钮直接复用 `FavoriteButton`**（面板里每行都是已收藏态，显示的就是点亮后的那颗心，点一下即取消收藏） |
| 歌词（LRC 原文 + AMLL TTML 原文） | IndexedDB `mp-media-cache` | 30 天 | `media-cache.ts`；命中即免一次第三方请求 |
| 封面配色（按封面 + 主题模式） | IndexedDB `mp-media-cache` | 30 天 | 同上；key 用 `picId`/曲目 id，不用带签名的图床直链（否则次次击穿） |

约束：

- **不落任何带时效的东西**（直链 / token），与 §7.3 一致：会话快照只存曲目与进度，恢复时重新取链；
- 读路径必须**同步或可失败**：localStorage 同步读；IndexedDB 相关 API 永不抛错，失败一律降级为「无缓存」，绝不阻断播放；
- **水合安全**：所有 localStorage 读取放在挂载 effect（`useState` 初值恒为默认），避免 SSR/CSR 首帧不一致；**但决定首屏结构的状态不能只留 localStorage**——只留它就必然「先渲默认、挂载后再改」，肉眼可见地闪（音乐页视图即此例，故改走 Cookie + SSR 下发，见 `src/app/music/page.tsx`）；
- **视图落点与数据回填分离**：刷新后停在「发现歌曲」还是「播放列表」只认 `mp-music-view`（恢复入口唯一：MusicExplorer 挂载恢复 effect）。列表快照只负责「上次的列表不销毁」，不得调 `setMusicView`——历史实现里快照恢复无条件切播放列表，既覆盖用户显式选择、又把偏好就地改写成 playlist（此后刷新再也回不去）；视图恢复也不得散在 `MusicViewSeg` 这类子组件 effect 里（子先父后执行，落点变成依赖组件树顺序的隐式行为）；
- **视图落点的三层来源**（优先级从高到低）：Cookie（SSR 首帧）＞ localStorage（挂载回落，仅当服务端没读到 Cookie）＞ 默认「发现歌曲」。Cookie 被禁用（隐私模式）时退化为「先渲默认、挂载后再跳」的一帧闪烁，功能不受影响；`/music` 因读 Cookie 改为按需渲染（不再静态预渲染），这是「刷新零闪烁」的代价；
- **不写负缓存**：歌词双通道皆空说明源不支持或暂时失败，不落盘，下次仍可重试；
- **个人行为明细只留本机**：列表快照 / 渠道偏好 / 最近搜索 / 个人收藏这几项都落在 localStorage，不进 Turso（§7.5）——音乐页是匿名公开页，没有账号体系可供归属，要做跨设备同步须先有账号；
- **收藏的内存态是权威、磁盘只是快照**：与本节的搜索历史刻意相反——搜索历史写不进就当没有（只是输入便利），收藏写不进（配额 / 隐私模式）**不回滚内存**，只置 `persistFailed` 提示「刷新后会丢失」。用户显式攒下的资产不能静默蒸发；
- **收藏队列与搜索队列各自独立**：`list`（搜索结果 / 链接解析产物）与 `favQueue`（「我的收藏」页点播时灌入，取自面板当前可见的那一份）是两份互不覆盖的队列，`queueOrigin` 只负责告诉引擎此刻跟哪一份（引擎的上一首/下一首、翻页、队内换源候选、当前下标全按它算）。各自页面点歌默认就播自己那一份：收藏页点播不写 `list`、不动翻页进度、也不切视图，播放列表页点播也不动 `favQueue`——两边来回切，各自还停在上次的队列上；
- **收藏队列不落播放列表快照**：`queueOrigin="favorites"` 时跳过 `writePlaylistSnapshot`——收藏队列既不是一次搜索会话（落盘会挤掉用户真正的搜索快照），本身又会随收藏增删而过期；`runSearch` / `runResolve` 会把出身归还 `search`；
- **收藏的水合入口唯一**：`hydrateFavorites()` 只能挂在 MusicExplorer 的挂载恢复 effect 里。下放到 `FavoritesPanel` 会在首屏停在「发现歌曲」时永不执行（该面板不挂载 → 结果行与底栏的星永远不亮）；下放到 `MusicViewSeg` 这类子组件会因「子先父后」变成依赖组件树顺序的隐式行为（与本节视图恢复踩过的坑同源）。`favorites-store` 的服务端快照恒为「空 + 未水合」，`toggleFavoriteItem` 还带一次兜底补读盘，避免以空列表为基准覆盖磁盘已有收藏；
- 本地缓存**不替代**服务端层①②③④，只补首帧与个人偏好。

### 7.5 服务端持久化（Turso）适用边界

项目已有 `app_settings`（控制台配置 + 15s 进程缓存 + 失败防抖）与 `parse_events`（解析埋点）两张 Turso 表。
音乐域可复用的候选（均为「全站共享 + 写入稀疏」的数据）：

- 层① 可用候选缓存（key = 归一化歌名+歌手，7 天，仅真实播放成功时写）；
- 层④ 失败黑名单 / 层③ 降级负缓存（全站共享价值最大：某源挂了不必每个实例重复踩）；
- 源健康度埋点（与 `parse_events` 同款 fire-and-forget，用于按源降权）；
- resolve 官方详情长缓存（30 天，替掉现在的 5min 进程缓存）。

**不适合进 Turso**：直链（时效）、播放队列 / 进度 / 音量 / 音质（高频写 + 跨境延迟，见 `turso-client.js` 的超时与代理注释）、
以及无账号体系下的个人行为明细——音乐页是匿名公开页，个人数据只能留本地或做去标识聚合。

### 7.6 落地形态（已实现）

**表**：`music_cache` 单表 KV（`kind` 命名空间 + `cache_key` 复合主键 + `payload` JSON + `expires_at`）。
存储层 `src/lib/music-cache-store.js` 与 settings-store 同款语义：未配置 env 静默跳过、任何异常不向上抛、
进程内命中 30s / 未命中与失败 5s 防抖、写后失效、单值 64KB 上限、每 50 次写顺手清过期行（无定时任务）。

| 层 | kind | 写入时机 | TTL |
|---|---|---|---|
| ① 可用候选 | `candidate` | `<audio>` **真实出声**（onPlay）才写；合并写（新成功在前、按 `source:id` 去重、上限 20 条） | 7 天 |
| ③ 降级负缓存 | `negative` | 降级轮以 fail/manual 收尾 + 层① 一条可用候选都没给出 + 本轮**真跑过**跨源现搜（被层③ 自己挡下现搜的轮次不写，避免 TTL 被无限续期） | 10min（§7.1 给 5–10min，取上界） |
| ④ 失败黑名单 | `fail` | resolve 失败 / 媒体层失败 / 音质档失败（文案推断类别） | 瞬时 2min、源级 30min、版权下架 30 天 |
| ⑤ 官方详情 | `detail` | resolve 路由上游抓取成功（四平台同一入口） | 30 天 |
| ⑥ 源健康度 | `health` | 每次 resolve / play / quality 的结果（`failStreak` 连续失败数累加，成功归零） | 24h |

**换源候选来源顺序**（`use-player-engine.runAutoFallback`）：A 队列内近似 → C 共享缓存
（一次读即得，曾真实播放成功过 → 按高置信 auto 处理）→ B 跨源现搜（最贵，只有前两者都没有
可自动尝试的版本时才跑）。C 与 B 用同一套源合法性口径（`crossSearchPlayableSourceKeys`）过滤，
避免把已收敛掉的源塞进候选。

**读写联动**：`fail` 上报会把候选缓存里的同版本打上 `failUntil`，读侧本地过滤——于是「换源前读候选」
只需一次 GET，也不会把已失效版本反复排到前面重试。读取失败 / 无缓存一律等同「无缓存」，
不改变既有换源闭环的判定条件。

**层③ 的读写口径**：读侧在换源入口与层① **并行**（一次网络等待出两个结果），命中即把本轮的
`crossSearch` 置为不可用——挡的是搜索成本，队列内近似候选与共享候选照常尝试，用户的手动搜索
完全不受影响。写侧只在 `!next`（fail/manual 收尾）且「跑了现搜却仍无自动候选 + 层① 无候选」时写；
层① 有候选却没播成**不记负**——那是层④ 逐版本黑名单的职责，下一轮仍值得去搜新版本。
被层③ 挡下现搜的轮次 `crossTried` 保持 false，因此不会重复写、TTL 不会被续期：负缓存到期后自然恢复搜索。

**接口**：`GET /api/music/cache?kind=&key=`（读候选）、`POST /api/music/cache { events }`（旁路上报）。
安全与其它音乐端点同款前置（蜜罐 / IP 限流 / CORS），写入侧另有事件条数（≤20）、字段长度、
候选条数（≤20）、`type` / `reason` 白名单校验；存储未配置时如实回报 `store:"unavailable"` 且仍返回 200
（旁路上报绝不 5xx）。浏览器侧客户端见 `src/lib/music-remote-cache.ts`：合并窗口 1.2s 或满 20 条上报一次，
`keepalive` 保证切歌 / 关页面途中也能送出，并且**只在真实播放成功时**写候选。

---

## 8. 前端交互（现状 + 增强）

现状（已实现）：

- 搜歌点列表 → `playTrack`；失败给 `playError`；封面临时占位取色；自然播完自动续播下一页。
- 自研直连搜索源 chips（tencent/kugou/migu）与双通道源 netease/kuwo 的自研主通道：搜索列表带 `line.kind=self` 徽标（「站点直连」）；封面不强求——搜索结果内嵌 `picUrlDirect` 直接展示、无则占位，**不上传二次封面换取**。
- migu「仅搜索展示」（`SELF_ONLY_ENGINE_KEYS`）：点播 / 封面 / 歌词直接抛明确 biz 提示（`NO_ENGINE_MSG` 等，渲染进 `playError`），引擎对 migu **跳过自动换源闭环**（确定性失败，同队列候选也必同为该源，空转无意义）；kugou 已内置官方免费试听直链，点播直接可播（免费档 128k；VIP/付费曲失败 `vip-only`），封面/歌词等数据通道仍抛 biz 提示。
- **系统媒体会话**（`use-media-session.ts`，已落地）：`MusicExplorer` 把引擎快照（`picked`/`playing`/`currentTime`/`duration`）与封面 URL 交给该 hook，同步到浏览器 Media Session —— 元数据（歌名/歌手/专辑 + 封面；封面未就绪或加载失败时回退该曲目 `source` 对应的平台品牌 logo，`platform-brand.ts` 为 label/强调色/`public/logos` SVG 的单一数据源，Windows SMTC 不渲染 SVG 故栅格化为 PNG、无品牌 SVG 的平台退化品牌色块）、`playbackState`、`setPositionState` 进度、系统媒体键（play/pause/上一首/下一首/快进快退/拖动/停止）回灌 `togglePlay`/`playPrev`/`playNext`/`seek`；站点标题在播放会话期间为「歌曲 - 歌手」，会话清空 / 卸载还原。该 hook 只读快照、只上行命令，不改变引擎界面。**通用内核已抽出**（`src/components/media-session/`）：`use-now-playing.ts` 承担元数据 / `playbackState` / `setPositionState` / 系统媒体键 / 站点标题，`brand-artwork.ts` 承担品牌 SVG → PNG 栅格化与缓存，两侧只做业务字段映射与回退封面来源适配；视频解析页由 `videos/use-video-media-session.ts` + `videos/VideoPosterCard.tsx` 复用（当前页内嵌播放时上报视频标题 / UP主 / 平台，多分P 跟随当前播放项，系统「上一首 / 下一首」切相邻分P）。
- **聚合搜索**：SearchPanel chips 行首「聚合搜索」伪 chip（`aggActive`，不占 `source`）。`music-client.searchAcrossSources`（平台级限流闸 ≤3 路并发，即使多次触发叠加同一时刻也不超 3 路；逐源失败隔离）拉全部可用源第 1 页 → `src/lib/music-match.ts`（纯函数，文本清洗/关键词相关度打分/`isSameSong` 同曲判定）跨源去重（同分取「可播副本」优先：GD > kugou > migu 仅展示）→ 相关度降序（打分只取决于关键词与歌曲内容，排序不掺平台/引擎顺序）截断 80 条混合展示。规则与播放失败自动换源共用（引擎内 `cleanMusicText`/`musicKey` 已收敛到该模块）；聚合列表无翻页、不落播放快照，部分源失败在列表尾 `pageErr` 提示、全部失败给空态原因。

增强后（仅增加分支，不改变既有状态）：

1. 点歌/解析成功 → 引擎照常 requestDirect + transport 起播（不变）。
2. `resolve-fail`/`play-fail` 且候选可自动 → 播放条/面板出现**轻量进行态**：“正在尝试 网易云 → 酷我”，期间可取消（AbortController 已具备）。
3. 触达 manual（60–74 或专辑不同版本）→ 弹 `select` 候选面板：每项展示 来源徽标 + 歌名 + 歌手 + 专辑 + 来源类型（搜索/历史可播/链接解析）+ 置信，按钮“就播这版”与“仅此一次 / 以后记住”。选中后立即 `playTrack(candidate)`（成功则按 §7.1 层①决定是否写入）。
4. 无候选 → 展示**最终原因**（哪一源、何种失败类别、是否被源黑名单）与建议动作（换源搜索 / 粘贴 QQ/酷我分享链接 resolve——C 类是 GD 不可搜索源的正规补充入口）。

所有面板仍然只消费引擎“快照+命令”，新候选状态以 `alternatives` 快照 + `reportPlaybackFailure` 命令形式挂在引擎界面上。

---

## 9. 性能与调优方向

- **请求预算表**：单次自动换源轮次对第三方请求上界见 §4.2；负缓存层③保证重复失败不重复花钱。
- **源顺序**：缓存候选（层①）→ 会话内 resolve（C）→ 当前搜索列表近似（A，0 成本）→ B 现搜；每源 1 页、串行或 ≤2 并发。
- **匹配精度**：版本词黑名单做成配置表；阈值个人使用不低于 70；专辑冲突走 manual 而非降阈。
- **可观测**：候选换源全程埋点——`prov`（A/B/C/D）、尝试 source、阶段（resolve/play）、耗时、结果（success/manual/fail），用于日志定位失效源（哪些 source 最近一直 play-fail，应降权/剔除）。
- 新打分纯函数与清洗规则必须**可脱离 DOM 单测**（放 `src/lib/music-match.ts` 之类共享位置，前后端皆可用）。

---

## 10. 分阶段实施计划

> v1 原文把“搜索引擎适配器/播放调度在服务端一个 get-play-url”当作起点——与本项目已落地的“前端驱动 + 薄后端动作 API”不符，废弃该假设。以下计划从**现状代码**出发。

- **P0（已落地）**：四入口 + gd/self 两通道（含自研直连搜索 chips tencent/kugou/migu 与 netease/kuwo 双通道：自研为主、GD 搜索兜底）+ resolve 归一曲目 + `use-player-engine` 快照/命令解耦 + 代理/直连降级 + bin 下载/封面收敛。对照 §1。
- **P1｜最小闭环（纯前端）**：transport 补 `onError` 上送（§4.1）；候选来源 A（队列近似，0 成本）接入换源循环；`alternatives` 快照 + manual select 基础 UI。
  - ✅ 已落地（引擎层，`use-player-engine.ts`，不触碰 UI）：`audioProps.onError` 上送（`play` 阶段失败）；`resolve`/`play` 双失败闭环，token 化有界（上界 = `behavior.maxAttempts`，见 §4.4）自动换源队列内近似高置信候选；`failStage` / `alternatives` / `autoTrying` 快照暴露。
  - ✅ 已落地（UI 层）：`MusicExplorer.tsx` 消费 `failStage` / `alternatives` / `autoTrying`——`autoTrying` 期间播放条上方轻量进行态 pill（“播放失败，正在自动尝试同曲其他版本…”）；失败收尾且队列内仍有未尝试同曲候选时自动弹出 `AltSelectDialog` 人工选版面板（逐行展示 来源徽标 + 歌名 + 歌手 + 专辑，整行点击即 `playTrack` 重走闭环；Esc / 遮罩 / X 关闭，关闭记忆 `altDismissed` 随换歌复位）。引擎侧配套：候选快照仅保留本轮尚未自动尝试的版本、任一候选播放就绪即清空快照（防陈旧候选在后续音质档失败时误弹）；自动尝试的“取消”= 手动切歌（token 失效），pill 内未做独立取消按钮。
- **P2｜跨源现搜**（已落地：来源 B 自动兜底、层③ 降级负缓存、层④ 失败黑名单联动；未落地：§6 两段式时长校验）：
  - 来源 B 自动兜底：队列内已无自动候选可试时，一次失败至多跑 **1 轮现搜**——拿原曲在「可搜可播源（netease/kuwo/joox + tencent + kugou，剔除失败源自身与无直链的 migu）」现搜第 1 页，由 `music-match.ts` 的 `rankSongMatchCandidates` 打分收敛：≥75 且专辑一致 → 自动接续尝试（A 耗尽后才动用）；60-74 或专辑冲突 → 人工候选。
  - 预算/并发：单轮直链尝试预算由 2 上调到 ≤ `behavior.maxAttempts`（默认 4，来源 A 队列候选 + 来源 B 现搜候选共用同一预算，见 §4.4）；跨源现搜复用聚合闸（≤3 并发）、切歌/重置即中止（轮次 token + AbortController），现搜网络异常静默降级不阻塞闭环。
  - UI：pill 动态文案（`altNote`，跨源现搜阶段提示“正在跨音源现搜…”）；`AltSelectDialog` 跨源条目带“现搜”徽标与置信注角；面板可点“现搜”回条目（不在队列时走 index=-1 直接播放）。
  - 已落地：层④ 失败黑名单（与「换源前读候选」联动，读侧 `failUntil` 本地过滤）；层③ 降级负缓存（`negative` 短 TTL，「重复失败不再跨源重搜」，见 §7.6）。
  - 未落地：专辑名 / 歌手级停用；层① 歌手热歌缓存；§6 时长维度校验；候选来源 C（解析产物/会话内 resolve）。
- **P3｜记忆与编排**：`/api/music/suggest` 服务端动作（输入归一曲目元数据 → 返回可搜索源候选 B 结果，无状态，复用现有 search 与限流）；层①可用候选缓存 + 写入规则；多实例缓存载体按部署选型接入。
- **P4｜可选增强**：播放成功/失败统计与源健康度排序；失效源自动降权。

P1–P3 各阶段结束时跑 `npm run lint`、`npm test`，并同步 CLAUDE.md/API.md。

---

## 11. 风险与边界

- **上游契约漂移**：GD search 源名单与字段可能变化（搜索源缩到少于两家时 B 来源退化）；现有多基址 8s 预算机制对超时兜底，但“可搜索源变少”要能自动降级为 manual。
- **误判成本**：宁 manual 勿 auto——放错歌对音乐工具是致命体验；auto 前置条件：清洗一致 + 歌手一致 + 专辑不冲突（或专辑缺失）。
- **请求打扰**：跨源现搜天然放大对第三方的请求；严格遵守 §4.2 轮次上界与层③负缓存，不无限搜索。
- **SSRF/开放代理**：任何新增中转/代理端点（suggest 本身只出 ID 不拉字节，无需代理；若未来需字节代理复用 `/api/music` `bin=1` 白名单语义）都不得接受任意 URL。
- **合规**：个人学习研究用途，禁止商用；不向第三方源做批量抓取，人工触发为主。
- 本文档是模块设计说明，不替代 `API.md`（对外契约）与 `CLAUDE.md`（目录/环境变量），实施落地后三处需保持同步。
