# 代码质量整改计划

> 基于 2026-09-14 全量粗审（src/ 200 文件 + 工程配置）生成。
> 优先级：**P0 安全/稳定性 > P1 状态与配置治理 > P2 结构整改 > P3 卫生清理**。
> 原则：**小步、可回滚、每批带验收标准**；禁止一次性重写骨架（涉及 30+ 平台 route）。

## 进度总览

| 批次 | 主题 | 任务数 | 预估 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 安全与稳定性补漏 | 4 | 1~2 天 | ✅ 已完成（2026-09-14） |
| P1 | 全局状态与配置治理 | 4 | 2~3 天 | ✅ 已完成（2026-09-14） |
| P2 | 结构整改与复用抽取 | 7 | 1~2 周 | P2-1、P2-4、P2-6、P2-7 已完成；P2-2 第一批（UA 收敛 17 处）已完成；P2-5 四块已完成（依赖数组前置 / `api/music/route.js` / `music-client.ts` / `music.css`），`use-player-engine` 仅完成候选挑选层（待补测试再动）；P2-3 未开始 |
| P3 | 依赖与文档卫生 | 5 | 0.5 天 | 待开始 |

---

# P0 · 安全与稳定性补漏（必须做）

## P0-1 代理端点缺失 SSRF 白名单 + 限流 【最高危】

- **问题**：`/api/image`、`/api/video-proxy` 仅校验 `http/https` scheme，**未调用 `sanitizeUrl()` / `rateLimit()`**（全文件 grep 0 命中）。任意 `169.254.169.254`（云元数据）、`10.x`、`127.0.0.1` 可经此代理探测内网，且**响应体/图片像素原样回传**，构成完整回带通道。与 `api-middleware` 已有的 SSRF 防护形成反差。
- **位置**
  - `src/app/api/image/route.js:52-147`（尤其 `:70-76` 只校验 protocol）
  - `src/app/api/video-proxy/route.js:67+`
- **动作**
  1. 两个 route 解析 `url` 后立即接入 `sanitizeUrl()`，返回 `null` 时给 403（不回传原因，沿用 `serverErrorResponse` 不泄密原则）。
  2. 接入 `rateLimit(getClientIP(request))`，超限 429；代理类天然高并发，建议给 `rateLimit(ip, { max })` 增加可选配额参数，代理取独立档位（如 300/min）。
  3. **灰度开关**：加 `PROXY_SSRF_STRICT` env，默认先「仅记录不拦截」跑 1~2 天，确认无业务误伤后再切强拦截。
- **验收**：`tests/image-proxy.test.ts`、`tests/video-proxy-utils.test.ts` 增补用例——内网 IP / 云元数据地址必须 403 且不发起上游请求；现有正常图床用例全绿。
- **风险**：改变现有行为。若前端图床/视频 CDN 恰好命中内网网段会直接 502，**必须先灰度观察再强开**。

## P0-2 图片代理缓存无界（OOM 放大器）

- **问题**：`cache` 只有 TTL 判断，**无 size 上限、无主动淘汰**；配合 P0-1 的「url 完全可控 + 无限流」，可构造大量不同 url 撑爆内存（单条上限 10MB）。
- **位置**：`src/app/api/image/route.js:17`（定义）、`:91-99`（读）、`:134`（写）
- **动作**：抽出 `createTtlCache({ max, ttlMs })`（见 P1-1），image route 改为有界 FIFO/LRU（复用 `result-cache.js:23 MEMORY_MAX` 模式），`max` 取 500。
- **验收**：单测断言连续写入 600 个不同 key 后 `size <= 500`。
- **风险**：低，只影响命中率。

## P0-3 限流状态无界增长（慢速内存泄漏）

- **问题**：`rateLimitRequests` 挂在 `globalThis`，但只在**该 IP 再次请求时**才 prune；IP 基数只增不减，长期运行持续膨胀。
- **位置**：`src/lib/api-utils.js:99-115`
- **动作**：写入时检查 `rateLimitRequests.size`，超阈值（如 10000）触发一次全量 prune（清除窗口内无时间戳的 key）；prune 抽成 `pruneAllRateLimit()` 供统一调度。
- **验收**：单测模拟 20000 个不同 IP 请求后 `size` 回落；`tests/api-utils.test.ts` 全绿。
- **风险**：低。

## P0-4 解析缓存未挂 globalThis（与同文件注释自相矛盾）

- **问题**：`api-utils.js:94-100` 注释自述「dev 下每 route 独立 chunk 导致多实例，故挂 globalThis」，但**紧邻的解析缓存 `cache` 未挂 globalThis**，dev 下缓存按 chunk 分裂、内存重复占用，与注释预期不符。
- **位置**：`src/lib/api-utils.js:47` vs `:99`
- **动作**：`cache` 一并挂 `globalThis`（key 如 `__mediaGetParseCache__`），补注释说明 TTL/上限语义。
- **验收**：dev 下同一 URL 跨两个 route 文件能命中同一份缓存；现有单测不回归。
- **风险**：**Workers 下 `globalThis` 依赖 isolate 复用，不要假设强一致**；注释必须写清「仅为 dev/单实例优化，非正确性依赖」。

---

# P1 · 全局状态与配置治理

## P1-1 统一进程内缓存容器

- **问题**：全项目 4 份各自实现的内存缓存，语义各不相同（有无上限、淘汰策略、是否共享均不一致）：

  | 位置 | 现状 |
  | --- | --- |
  | `src/lib/api-utils.js:47` | 解析缓存，无 globalThis、惰性全量清理 |
  | `src/app/api/image/route.js:17` | 图片缓存，**无上限** |
  | `src/lib/result-cache.js:28` | `memoryCache`，FIFO 有界（实现最规范） |
  | `src/lib/anti-bot.js:37` | `buckets`，按 key 自动 filter 但 key 数无上限 |

- **动作**：新增 `src/lib/lru-cache.ts`，导出 `createTtlCache({ max, ttlMs })`（`get/set/prune/clear`），以 `result-cache.js` 现有 FIFO 为基线，逐步替换其余三处。
- **验收**：每个替换点配套单测（过期、淘汰、并发写）。
- **风险**：横跨 4 个文件，**逐个替换、逐个验证**，不要一次全换。

> **复核结论（2026-09-14）**：4 处不必全换，实际只有 2 处是真问题。
> - `api-utils.js:47` 解析缓存 —— **实际无界**（`size >= 500` 时只清理「已过期」条目，条目都未过期则只增不删），已换成 `createTtlCache`。
> - `image/route.js:17` —— **完全无上限**，已换成 `createTtlCache`（P0-2）。
> - `result-cache.js:28` —— 已是 FIFO 有界（500）+ 过期删除，语义等价，**不换**（换它还得给容器补 `clear()`，收益为零）。
> - `anti-bot.js:37` —— 是**滑动窗口限流器**不是缓存，key 为平台名（有限集合）、每次 `take` 都会 filter 清理，**不构成泄漏，不换**。
>
> 因此本项收敛为「新增统一容器 + 替换真正无界的 2 处」，条目上限语义统一为硬上限。

## P1-2 平台元数据收敛为单一真源

- **问题**：平台信息存在**四份真源**，需人工对齐（`api-middleware.ts:85` 注释已明确承认）：

  | 真源 | 位置 | 用途 |
  | --- | --- | --- |
  | `PLATFORM_INFO` | `src/lib/platforms.ts:41` | 服务端识别（domains/shortDomains） |
  | `ROUTE_DOMAIN_MAP` | `src/lib/api-middleware.ts:89-110` | 路由域名白名单 |
  | `VIDEO_PLATFORMS` | `src/config/video-platforms.ts:2` | 前端展示（名称/颜色/图标） |
  | key→route 映射 | `src/lib/platformRoutes.js:12` | 动态 import 路由 |

- **动作**：最小第一步——把 `ROUTE_DOMAIN_MAP` 改为从 `PLATFORM_INFO` 的 `domains`/`shortDomains` 推导生成。第二步再评估 `VIDEO_PLATFORMS` 与 `PLATFORM_INFO` 合并的可行性（需权衡前端包体积）。
- **验收**：`/api/engines` 返回与改造前完全一致；`tests/api-middleware.test.ts` 全绿。
- **风险**：涉及 `redbook`→`/api/xhs`、`pipixia`→`/api/ppxia` 这类 **key 与目录名不一致的特例**，且 `platformRoutes.js` 依赖动态 import 路径，改动后必须回归全平台解析。

> **复核结论（2026-09-14）：P1-2 已完成，且顺带修了一个真实功能缺陷。**
> - `ROUTE_DOMAIN_MAP` 已移入 `platforms.ts`，由 `PLATFORM_INFO` 推导（路由目录名差异收敛进 3 行的 `ROUTE_DIR_ALIAS`：`redbook→xhs`、`pipixia→ppxia`）；`api-middleware.ts` 改为 import，不再自持。
> - `ALL_DOMAINS`（第四份真源、且全项目无引用）同样改为推导，真源由四份降为两份（`PLATFORM_INFO` + 前端 `VIDEO_PLATFORMS`）。
> - **两表不一致不只是重复，而是行为分叉**：中间件白名单认、而 `PLATFORM_INFO` 不认的域名有 4 个 —— `snssdk.com`、`wtturl.cn`（抖音老短链/App 直链）、`youtube-nocookie.com`、`xiaochuankeji.cn`。也就是说 `/api/douyin` 能解析 `wtturl.cn` 链接，`/api/parse` 却返回「未知平台」。已把这 4 个域名补进 `PLATFORM_INFO.domains`，两边行为拉齐。
> - 新增 `tests/platform-metadata.test.ts` 锁定不变式：**平台声明的每个域名（含子域）都必须能被 `identifyPlatform` 识别回本平台** —— 此后任何一处再写死域名都会被这条测试挡下。

## P1-3 安全/环境硬编码外移

- **问题**
  1. IP 黑名单写死在源码（注释自述「依据 data/*.log ... 2026-08-26 自动生成」）→ 加一个 IP 要发一次版。
  2. CORS 白名单硬编码 `.hotier.cc.cd` → Vercel preview / localhost 全部拿不到 CORS 头。
- **位置**：`src/lib/api-utils.js:264-274`（黑名单）、`:295`（CORS）
- **动作**
  1. 黑名单 → env `BLOCKED_IPS` / `BLOCKED_IP_PREFIXES`（逗号分隔），源码内列表作默认值兜底；中期改存 `settings-store`（已有持久化能力）。
  2. CORS → 从 env 读允许源列表，默认含站点主域 + `localhost`；保留现有 suffix 匹配逻辑。
- **验收**：`tests/api-utils.test.ts` 增补 env 覆盖用例；本地 dev 跨域能拿到 `Access-Control-Allow-Origin`。
- **风险**：低，但**默认值必须保留**，否则环境未配置时防护直接失效。

> **复核结论（2026-09-14）：已完成，但把「覆盖」改成了「追加」。**
> - `BLOCKED_IPS` / `BLOCKED_IP_PREFIXES` / `CORS_ALLOWED_ORIGINS` 三个 env 均已支持，源码内列表保留为内置基线，env 在其之上**取并集**。
> - 原计划写的是「env 覆盖、源码列表兜底」。实施时改了语义：运维只想临时拉黑一个 IP，若 env 整体替换基线，反而把已有的 5 个全放跑了。**要下线内置 IP 请改代码发版**，env 只负责加。
> - `envList()` 会归一化大小写与空白；env 为缺失/空串/纯空白时返回空数组，内置基线不受影响（不会因配错一个空字符串导致防护静默失效）。
> - CORS 额外补了 `Vary: Origin` —— 响应随 Origin 变化，不加会让 CDN/浏览器缓存把 A 站的 CORS 头发给 B 站。
> - 新增 `tests/api-config-env.test.ts`（9 例）锁定并集语义与兜底行为。

## P1-4 性能：消除热路径不必要开销

- **问题**
  1. `beijingNow()` 每次调用都 `new Intl.DateTimeFormat(...)`（构造成本远高于格式化），而 `api-middleware` 每请求至少调用 2 次（usage 日志 + parse 日志）。
  2. `classifyRisk()` 对整份 HTML 做 `toLowerCase()` **全量复制**后再做 5 次 `includes` 扫描。
  3. `evictExpiredCache()` 在 `cache.size >= 500` 时**同步遍历整个 Map**，阻塞当次请求。
- **位置**：`src/lib/api-utils.js:8-20`、`:50-62,80`；`src/lib/anti-bot.js:93-107`
- **动作**
  1. `Intl.DateTimeFormat` 实例提到模块级常量复用。
  2. `classifyRisk` 增 `maxScanBytes`（默认 64KB），只截取前 N KB 做特征扫描。
  3. 全量清理改为 O(1) 摊还清理，或交给 P1-1 容器的 TTL 惰性策略。
- **验收**：`tests/anti-bot.test.ts`、`tests/api-utils.test.ts` 全绿；压测单次解析 P95 无劣化。
- **风险**：低。截断扫描需确认风控特征（验证码脚本、`__ac_signature` 等）确实落在前 64KB——**先加日志记录截断前后判定差异再定阈值**。

> **复核结论（2026-09-14）：已完成。**
> - `beijingNow()` 的 `Intl.DateTimeFormat` 已提到模块级复用（时区固定、实例无状态，可安全复用）。
> - `classifyRisk()` 增 `maxScanLength`（默认 50KB，按字符数而非 64KB 字节——风控文案都是 ASCII/中文混排，按字符截断更直观且省一次 Buffer 计算）。风控特征（验证码、JS 挑战、`__ac_signature`）都出现在页面 head 附近，截断不影响判定；`maxScanLength` 可传入调大。
> - **第 3 点无需单独做**：`evictExpiredCache()` 已随 P1-1 一并消失（解析缓存换成 `createTtlCache`，改惰性过期 + LRU 淘汰，不再有「超阈值同步遍历整个 Map」的路径）。
> - 风险提示里要求的「先加日志对比截断前后判定差异」**未做**——灰度期无真实风控样本，改为用测试锁定边界行为（`tests/hot-path-perf.test.ts`）：特征在窗口内必须识别、窗口外判为无风险。若线上出现「明明是风控页却判 OK」，优先调大 `maxScanLength`。

---

# P2 · 结构整改与复用抽取

## P2-1 切断 lib → components 反向依赖

- **问题**：`src/lib/`（服务端层）反向依赖 `src/components/music/types`；且 `music-client.ts` 是**纯浏览器模块**（模块级可变状态 `directUsed:62`、`gdFallbackSearchSources:69`）却与服务端 lib 混放，职责边界模糊。
- **位置**：`src/lib/music-client.ts:29-34`（import）、`:62,69`；`src/lib/music-remote-cache.ts:20`
- **动作**：音乐类型上提至 `src/types/music.ts`，`music-client.ts` 迁至 `src/lib/client/music-client.ts`，更新全部引用方。
- **验收**：`grep -r "@/components" src/lib` 返回 0 命中；`tests/music-client.test.ts` 全绿。
- **风险**：低（纯移动），但引用方可能较多，需全量搜索后批量替换。

> **复核结论（2026-09-14）：已完成，实际影响面比预估大一点。**
> - 音乐类型（含 `SEARCH_SOURCES`/`BR_OPTIONS` 常量与 `formatTime`/`formatSize`）上提至 `src/types/music.ts`，原 `components/music/types.ts` 删除。**引用方 14 处**（11 处 `@/components/music/types` + 3 处同目录 `./types`，后者容易被漏掉）；旧路径残留仅剩注释文字。
> - `music-client.ts` 迁至 `src/lib/client/music-client.ts`，**引用方 21 处**（src 16 + tests 5）。它内部只有 2 处绝对导入，移动安全。
> - 验收：`grep "@/components" src/lib` = 0 命中 ✓。
> - **顺带修**：`classifyRisk` 的 JSDoc `@param` 漏了新增的 `maxScanLength`，导致 `tsc` 多报 1 个 TS2353（上轮改动引入）。已补。
> - **注意**：`tsc --noEmit` 现在只剩 `tests/twitter-fixer.test.ts` 的 3 个既有错误（已记入 P3-3）。建议把它当作新的基线红线——**新增错误数必须为 0**。
> - **遗留**：`tests/` 下既有 **87 个 eslint 错误**（多为 `@ts-nocheck` 与 `any`），本次未处理，建议单开一条 P3 清理。另发现 `tests/parse-route.test.ts` 在 CPU 有并发负载时会 flaky（单独跑 5/5 通过），疑似对时序敏感，暂未修。

## P2-2 抽取 HTTP 公共能力（收益最大）

- **问题**：UA 字符串在 **19 个文件**重复定义（Chrome126 多份、iPhone16_6 多份，以及 Chrome79/84/85/104/120/129 等互不相同的历史遗留版本）；已有 `src/lib/default-mobile-ua.ts` 却只被 4 个文件使用。超时毫秒数裸写分散在 ≥10 个文件（3000/4000/5000/6000/8000/10000/15000/20000）。
- **位置（UA 节选）**：`xigua/route.js:9`(Chrome79)、`xinpianchang:29`(Chrome84)、`huya:10`(Chrome85)、`quanminkge:10`(Chrome104)、`twitter:621`(Chrome120)、`douyinFallback.js:17`(Chrome128)、`xhs:8` / `image:105` / `video-proxy:107`(Chrome129 Edg)
- **位置（超时节选）**：`douyin/route.js:202,420,463,510,559`、`xhs/route.js:124,528`、`qsmusic/route.js:14,30`、`qqmusic-id.js:52`
- **动作**：新增 `src/lib/http.ts`
  - UA 常量池（`UA_DESKTOP_CHROME` / `UA_MOBILE_IOS` / `UA_MOBILE_ANDROID` 等），平台专用 UA 集中管理并注明原因。
  - `TIMEOUT` 常量组（`SHORT=5s` / `DEFAULT=8s` / `LONG=15s` / `PAGE=20s`）。
  - `fetchWithTimeout(url, { timeoutMs, headers, ... })` 统一 `AbortSignal.timeout` 封装。
- **验收**：按模块分批替换（先音乐类 route，再视频类），每批跑对应单测 + live 测试。
- **风险**：**改 UA 可能触发上游风控策略变化**（各平台 UA 版本是踩坑调出来的）。第一阶段**只集中管理、不改值**，确认行为一致后再考虑统一版本。

> **复核结论（2026-09-14）：第一批已完成，并据此调整了后续范围。**
> - **调查全貌**（比计划预估更散）：UA 字面量 **36 处 / 22 种不同值**；超时 **18 种数值**（3000~30000，主流 8000）；全仓**没有**任何公共 fetch 封装，`createApiHandler` 也不管超时。
> - 新增 `src/lib/http.ts`：`TIMEOUT` 常量组（XS/SHORT/DEFAULT/LONG/PAGE/DOWNLOAD）、UA 常量池、`fetchWithTimeout`（超时抛 `RequestTimeoutError` 以区别于"调用方主动取消"，支持合并外部 signal，`finally` 清理定时器）。
> - **收敛 17 处同值 UA**（3 组：Chrome126×10、iOS16.6×4、Edg129×3，跨 16 个文件）。值与原先**逐字符相同**，属纯重构，零行为变化。
> - `fetchWithTimeout` 已在 `self-search/request.js` 落地（原 `AbortSignal.timeout` 写法）。先确认调用方**不依赖超时错误类型**（自研搜索各源只判断 `SelfSearchError`）才改的。
> - **剩余 19 种平台专用 UA 决定不搬**（抖音 App UA、咪咕 Android WebView、B 站 Chrome94、微博 iOS16.0…）：它们都只在**一处**使用，搬进公共模块只会离使用点更远，还让公共模块堆满"仅某平台关心"的细节。留在各平台文件里，并在 `http.ts` 顶部注明该约定。
> - **新发现并单开 P2-7**：12+ 处 fetch **完全没有超时**（含公共的 `getRedirectLocation`），这是可用性缺陷而非代码美学问题，优先级应高于剩余的 UA/超时收敛。
> - 新增 `tests/http.test.ts`（9 例）：**UA 字符串逐字符锁定**——改动 UA 有风控风险，误改必须变红。

## P2-3 平台 route 样板工厂化

- **问题**：30+ 平台 route 存在大量样板（`{code:200,msg:"解析成功"}` 文案、短链跟随、Referer 设置、错误返回、图集/多清晰度解析、JSON 提取）。
- **动作**：在 `createApiHandler` 之上提供 `createSimpleParser({ platform, extract, normalize })` 工厂，让「简单平台」route 收敛到 30~50 行。**仅对结构规整平台先做**（`qsmusic` / `qqmusic` / `pipigx` / `quanminkge` / `huya` / `xigua` / `xinpianchang`），抖音/小红书/B站/快手等重逻辑平台**保持现状不动**。
- **验收**：改造后 `/api/engines` 状态不变；`tests/parsers-new.test.ts` + live 测试全绿。
- **风险**：**高。动骨架 = 30+ 文件同改**。必须逐平台灰度，禁止一次性重写。

## P2-4 前端重复逻辑抽取

- **问题**
  1. `formatCount`（万/亿格式化）同实现重复 **8 处**：`ParseInfoPanel.tsx:42`、`WeiboVideo.tsx:72`、`TwitterVideo.tsx:56`、`BilibiliVideo.tsx:75`、`XhsVideo.tsx:39`、`KuaishouVideo.tsx:44`、`DouyinVideo.tsx:44` 等。
  2. `scrollToDownload` 重复 **4 处**：`YouTubeVideo.tsx:442`、`WeiboVideo.tsx:99`、`TwitterVideo.tsx:74`、`BilibiliVideo.tsx:89`。
  3. `self-search/` 五个模块（netease/tencent/kugou/kuwo/migu）重试循环逐字相同。
  4. `music-view-store.ts` 与 `favorites-store.ts` 的 `useSyncExternalStore` 样板重复约 80 行。
- **动作**：新增 `src/lib/format.ts`、`src/hooks/use-scroll-to-download.ts`、`src/lib/self-search/retry.ts`、`createExternalStore<T>()` 工厂。
- **验收**：删除重复实现后类型检查通过、相关单测全绿。
- **风险**：低~中。`formatCount` 各副本可能有细微差异（如 `unknown` 入参 vs `number`），**先比对实现再统一**。

> **复核结论（2026-09-14）：已完成，实际重复度比预估低，按真实差异拆分而非强行归一。**
> - **formatCount**：8 处实为 **3 种语义**——① 5 个视频组件逐字相同的 `(n: number) => string`；② YouTube 的 `fmtCount`（同公式、不同名）；③ ParseInfoPanel 的宽容版（`unknown` 入参、兼容 "24.9万"/"1.2亿" 字符串、无效返回 `undefined` 用于隐藏行）。收敛为 `src/lib/format.ts` 的 **`formatCount` + `formatCountLoose` 两个函数**（③ 的"无效即隐藏"语义不该并进 ①②）。①② 的 NaN/0 透传行为原样保留。
> - **scrollToDownload**：4 处中 B 站的回退是 `block:"start"`（其余 center），是有意差异。收敛为 `src/lib/dom.ts` 的 `scrollToElement(id, { fallbackId, fallbackBlock })`，各组件保留 1~3 行薄封装维持 `onDownloadClick` 签名。**落点与计划不同**：它不是 hook（不依赖 React 状态），放 `hooks/` 名不副实。
> - **self-search 重试**：实际 **6 处**编排（kugou 有搜索+取链两处），骨架逐字相同，仅"请求调用 / parse / 失败文案"三个变化点。收敛为 `src/lib/self-search/retry.js` 的 `searchWithRetry(run, failMessage)`。`SelfSearchError` 首抛即重不重试的语义原样保留。
> - **store 样板**：两 store 真正重复的只有**订阅者集合管理**（listeners/subscribe/notify，约 25 行）；hook 层因服务端快照语义不同（favorites 恒定空快照 vs music-view 按 initialView）不该合并。收敛为 `src/lib/client/external-store.ts` 的 `createExternalStore()`（无泛型——集合管理与快照类型无关）。
> - 全量 936 通过；净删约 120 行重复。

## P2-5 拆分超长文件

| 文件 | 行数 | 拆分建议 |
| --- | --- | --- |
| `src/app/music/music.css` | 3585 | 拆 8 个片段 + `music.css` 汇聚 `@import` ✅ **已完成（2026-09-14）** |
| `src/components/music/MusicExplorer.tsx` | 1604 | 拆出「搜索 / 播放 / 收藏」三个容器 hook + 展示组件 |
| `src/components/music/use-player-engine.ts` | 858 | 原计划「拆三个 hook」，评估后改判（见下）：仅抽出候选挑选层 |
| `src/app/api/music/route.js` | 801（`GET` 约 660 行） | 按 `action` 拆为 handler 映射表 ✅ **已完成（2026-09-14）** |
| `src/lib/music-client.ts` | 908 | 拆「搜索 / 直链 / 歌词 / 封面」通道模块 ✅ **已完成（2026-09-14）** |

- **验收**：`tsc --noEmit` 无新增错误；音乐页交互冒烟通过。

> **复核结论（2026-09-14）：route.js 已拆完（P2-5 第一块）。**
> - **结构**：`route.js` 由 846 行瘦到约 120 行，只留 CORS / 限流 / 蜜罐拦截 / 开关矩阵加载 / 参数归一化 + 分派；四个 action 各占一文件于 `src/lib/music-actions/`（`search.js` / `pic.js` / `lyric.js` / `url.js`），跨分支共用的上游请求头、超时预算、多基址链编排、JSON 解析抽到 `shared.js`，映射表与用法提示在 `index.js`。
> - **验证**：`tests/gdmusic-route.test.ts` **37 个用例全绿**——该测试逐 action 覆盖成功 / 404 / 被拒 / 风控页 / 非 JSON / 多基址链切换 / 总开关，是天然的等价性安全网；全量 936 通过。逻辑逐字搬运，未做任何顺手改动。
> - **拆分中堵掉的一处新增风险**：原代码用白名单比较（`action !== "url" && ...`）天然安全，改成查表后 `action=constructor` / `__proto__` 会命中原型链上的非 handler 值（进而当函数调用）→ 分派改用 `Object.hasOwn(MUSIC_ACTIONS, action)` 判定。
> - **发现但未修的历史瑕疵**（保持日志文本字节级不变）：`logMusic(status, code, detail)` 的形参名与实参语义相反——调用点第一个实参传的是标签（如 `"cached-search"`），模板里却写成 `code=${code} status=${status}`，实际输出 `code=200 status=cached-search`，即 **status 字段打印的是标签**。纯内部命名问题，不影响任何行为与断言；日后若要修正，需同步更新任何按该日志文本 grep 的排查脚本。

> **复核结论（2026-09-14）：use-player-engine.ts 只做了第一层，原计划的「三分法」经评估不成立。**
> - **零测试覆盖**：`tests/` 对该 hook 的命中数为 **0**，拆分没有等价性安全网（对比 `route.js` 有 37 个用例兜底）。因此只做可静态验证、且边界天然清晰的部分。
> - **已完成**：候选挑选与合并（来源 A 队列内 / 来源 C 共享缓存 / 三路合并 / 同资源判定，约 150 行）连同 `AltCandidate`、`AltProvenance` 类型抽到同层 `alt-candidates.ts` —— 纯函数、不碰 `<audio>` 与 React 状态，可独立阅读与测试；同步把 `AltSelectDialog.tsx` 的类型来源改为新模块。主文件 901 → 约 750 行。验证：tsc 无新增错误、eslint 干净、全量 936 通过。
> - **为什么没有按「队列管理 / 播放控制 / 直链获取」拆**：该分类与实际代码结构不符。真实分组是「会话状态 + transport + 换源闭环」，三者通过 **11 个 ref**（altToken / altState / altInFlight / directAbort / crossAbort / resumeAt / autoplay / qualitySwitchAt / resourceUrl / muted / audio）与 15 个 setState 交织，且 `playTrack → attemptPlay → runAutoFallback → attemptPlay` 互相递归；「队列管理」在本文件里其实只有 `playPrev/playNext` 的索引推进，队列本身是外部传入的 `list` prop。硬拆要把这批 ref 提升到父层再逐一下传（参数爆炸），而每次渲染新建的闭包（`runAutoFallback` 读 `list`、`behavior`）一旦 `useCallback` 依赖写漏，就会固化 stale-closure —— 正是 P2-5 前置里警告的雷。风险收益比不成立。
> - **值得做、但应先补测试的下一刀**：文件头注释已预留 transport 接缝（「替换/扩展 transport 区块即可，UI 层无需改动」），可抽 `use-audio-transport.ts`（audioRef / 音量同步 / 直链就绪起播 / `audioProps` / `togglePlay` / `seek` / `unlockAutoplay`，约 130 行）。但它要求把 `resumeAtRef` / `autoplayRef` 的所有权从主层转移到 transport（现由 `attemptPlay` 在取到直链后写、由 effect 消费），是接口重设计而非搬移。**建议先用 `renderHook` 给播放引擎补测试（至少覆盖「直链就绪续播」与「音质热切换」两条路径），再动这一刀。**

> **复核结论（2026-09-14）：music-client.ts 已按通道拆完（P2-5 第二块）。** 实际 982 行（计划写 908 是旧数据），拆成 6 个文件：
> | 模块 | 行数 | 职责 |
> | --- | --- | --- |
> | `music-client.ts` | 96 | **barrel**：汇聚导出 + 通道总览注释 |
> | `music-client-core.ts` | 380 | 共享基座：契约类型 / 常量 / 会话状态 / 错误分类 / IO（proxyGet·directGet·directJson）/ 降级编排 `directAfterDown` / 引擎能力矩阵 / 链接解析 |
> | `music-client-search.ts` | 296 | 搜索通道：直连搜索解析、自研 / GD 分派、跨源聚合 + 平台级并发闸（≤3） |
> | `music-client-direct.ts` | 167 | 直链通道：取链 + 下载入口决策 `trackDownloadSpec` |
> | `music-client-media.ts` | 166 | 封面 / 歌词 / AMLL 逐字歌词通道 |
> | `music-client-meta.ts` | 53 | 展示辅助（音质档位、线路文案），纯换算不发请求 |
>
> - **对外零改动**：原文件保留为 barrel，导出符号全集（28 值 + 12 类型）与导入路径 `@/lib/client/music-client` 完全不变，因此 **src 引用方 16 处与测试 5 处一行未改**；`tests/music-client.test.ts` 原样通过。
> - **依赖方向单向**：四个通道模块只依赖 core，彼此不互相依赖，也不反向依赖 barrel —— 无环，`MusicError` 的 `instanceof` 判定跨模块仍成立（同一类实例）。
> - **关键难点：会话状态的所有权**。`directUsed` 与 `gdFallbackSearchSources` 是模块级可变状态，跨通道读写（降级编排写、下载/取色决策读、搜索分派读写）。处理：二者都留在 core，读写统一收敛为 `isDirectUsed` / `markGdFallbackSource` / `isGdFallbackSource` / `resetDirectUsed`；`directAfterDown` 也留在 core（它是唯一写 `directUsed` 的地方），避免状态所有权分散到多个模块。
> - **验证**：tsc 无新增错误（仍 3 个既有 twitter-fixer）、eslint 干净、全量 936 通过。最大文件从 982 → 380 行。
- **风险 1**：**MusicExplorer 有 5 处 `eslint-disable react-hooks/exhaustive-deps`**（`:405,423,936,951,1373`），说明依赖数组本身有缺陷。**先补齐依赖数组并验证无回归，再拆分**，否则会把 stale-closure bug 固化到新文件。

> **复核结论（2026-09-14）：前置已完成，但结论与计划预设不同——5 处里只有 1 处该补齐。**
> 做法：临时移除 5 行 disable，让 eslint 报出确切缺失项，再逐处判断能否补（不能直接信"报了就是 bug"）。
> | 位置 | eslint 报缺 | 判断与处理 |
> | --- | --- | --- |
> | `:406` 挂载恢复 | `initialView`、`restorePlayback` | **保留 disable**。这是"只在挂载执行一次"的恢复；`initialView` 是服务端一次性落点，入依赖会重复恢复。 |
> | `:424` 写播放列表快照 | `aggActive`、`queueOrigin` | **保留 disable**。二者是早退守卫，入依赖会让"守卫翻转"也重写快照——`queueOrigin` 由 favorites 变回 search 的瞬间可能把收藏队列误写进搜索快照。 |
> | `:937` 自动补页 | `goToPage` | **保留 disable**。`goToPage` 是每次渲染新建的 async 函数，入依赖会让 effect **每次渲染都跑**（含翻页自身引起的重渲染）→ 自触发连锁翻页。 |
> | `:952` 窗口滚动监听 | `goToPage` | **保留 disable**，同上（且会导致每次渲染都解绑/重挂监听）。 |
> | `:1374` 歌词加载 | `applyLyricData` | **已补齐**：它是 `useCallback([])` 的稳定引用，列入依赖不改变执行时机 → 零行为变化，disable 删除。 |
>
> 关键判断依据：effect 闭包捕获的是**触发它的那次渲染**的值，所以"守卫值/函数"缺依赖**不等于** stale closure——上表 4 处保留项都无 stale 读。原先 3 处（937/952/1374）是**裸 disable 无任何说明**，现已全部补上"为何安全、为何不能入依赖"的注释，把机械压制变成有据可查的决策。
- **风险 2**：`music.css` 拆分时 Tailwind 与裸 CSS 混用，**注意 `@layer` 顺序变化引发样式优先级漂移**；建议先加作用域前缀、再物理拆分。

> **复核结论（2026-09-14）：music.css 已拆完，且「风险 2」的前提不成立。** 实际 3714 行（计划写 3585 是旧数据），按功能分区拆成同目录 8 个片段 + `music.css` 汇聚：
> | 片段 | 行数 | 职责 |
> | --- | --- | --- |
> | `music-base.css` | 222 | 作用域 `.mp-app`、共享令牌、音质下拉、toast |
> | `music-list.css` | 613 | 发现歌曲 / 播放列表主体（左半区） |
> | `music-now-playing.css` | 247 | 右侧「正在播放」 |
> | `music-player-bar.css` | 490 | 底部播放条（收起 / 唤起、进度、音量） |
> | `music-lyric-page.css` | 856 | 整页歌词页（含动态取色、移动端） |
> | `music-dialogs.css` | 483 | 详情弹窗 / 查找方式切换 / 选版面板 / 设置齿轮 |
> | `music-settings-card.css` | 510 | 平台引擎设置共享卡片 |
> | `music-settings-page.css` | 321 | 专用设置页与登录页页面态 |
>
> - **风险 2 前提不成立**：全文 grep 确认 `music.css` 里 **0 处 `@apply` / `@tailwind` / `@layer` / `theme()`** —— 是纯原生 CSS。因此既不需要「先加作用域前缀再拆分」，也不依赖 `postcss-import`（`postcss.config.mjs` 仍只有 tailwind + autoprefixer，**未新增依赖**）。
> - **唯一真实约束是顺序**：CSS 同特异性下后者覆盖前者，所以按**连续行区间**切片、`@import` 顺序严格等于原顺序；歌词页的「动态取色」「移动端」两段本身就是覆写上方基础规则，拆开后仍靠顺序保证。barrel 与各片段头注释均已写明「顺序即层叠顺序，不得调换」。
> - **等价性验证**：切片为连续区间（5–3713，无重叠无遗漏）；7 个边界行逐行确认是「空行 + 注释块开头」；8 个片段花括号计数全部自平衡（证明没有截断任何规则块）；3 个引用方（`music/page.tsx`、`settings/page.tsx`、`settings/login/page.tsx`）导入路径未变。
> - **构建验证已跑（同日补记）**：`npx next build` 通过（编译 8.7s、46/46 静态页），产物层面确认与拆分前等价：
>   | 检查项 | 结果 |
>   | --- | --- |
>   | 零丢失 | 8 个片段 334 个 `mp*` 类在产物 CSS 中全部命中（缺 0） |
>   | 覆盖完整 | `/music`、`/music/settings`、`/music/settings/login` 三个路由**均同时加载**两个 CSS chunk（`47f101…` 含片段 1–6、`1b1453…` 含片段 7–8） |
>   | 层叠顺序未漂移 | 片段 1–6 在主 chunk 内偏移严格递增（4093→11367→19908→21666→41073→53030）；片段 7（0–10923）整体早于片段 8（11683–19060） |
>
>   即：内容、归属、顺序三者都与单文件时期一致，可视为纯搬运。
> - **构建踩坑（非代码问题，记此避坑）**：集成终端首次构建在 `✓ Compiled successfully` 之后报 `ENOENT .next/server/pages-manifest.json`，而该文件实际存在。根因是 shell 注入了 `NODE_OPTIONS=--require …/node-language-shim.cjs`，它会代理 Node 的文件操作（此前同类报错还有 `node-safe-delete-shim`）。**重跑一次即通过**，或在系统自带终端里构建。遇到「文件明明在却 ENOENT」先换终端复现，不要去改代码。

## P2-6 命名规范统一

- **问题**：`components/music/` 下 PascalCase 组件（`MusicExplorer.tsx`、`PlayerBar.tsx`）与 kebab-case 模块（`music-view-store.ts`、`use-player-engine.ts`）混用；`AmllBackground.tsx` 与 `amll-background.tsx` 同目录并存（仅首字母大小写差异），疑为重构残留。
- **动作**：确立规范（**组件 PascalCase，hooks/stores/utils kebab-case**）并写入 `CLAUDE.md`；核查两个 Amll 文件的实际引用方，删除无引用者。
- **验收**：无重复职责的孪生文件；规范写入文档。
- **风险**：低。Windows 下大小写不敏感，删除前**必须确认引用方**，否则易误删。

> **复核结论（2026-09-14）：已完成，且原判断有一处需要更正。**\n> - **`AmllBackground.tsx` 不是重构残留**：它是 890 B 的懒加载壳（`dynamic ssr:false` + `memo`），真身在 4.8 KB 的 `amll-background.tsx`，与 `AmllLyricView.tsx` → `amll-player.tsx` 是同一套「壳 + 实现」分层。**但它是全仓唯一一对仅首字母大小写之差的文件**，Windows 无感、Linux / CI 上极易解析错。处理：把壳内联进 `LyricPage.tsx`（`memo(dynamic(() => import("./amll-background"), { ssr: false }))`，与 `AmllLyricView` 内的 `AmllPlayer` 写法统一），删除壳文件，只留实现文件。\n> - 4 个 kebab-case 小组件改 PascalCase：`eq-bars→EqBars`、`favorite-btn→FavoriteButton`、`icon-btn→IconButton`、`marquee→Marquee`（引用 6 个文件 / 10 处）。`amll-player.tsx`、`amll-background.tsx` **保留** kebab——它们是 `dynamic()` 的懒加载目标，kebab 正好标出「内部实现、勿直接引用」。\n> - 规范已写入 `CLAUDE.md` 的「约定」，含上述例外与「禁止仅首字母大小写之差」这条硬规矩。\n> - 全量 936 通过；src 侧 eslint 干净。

## P2-7 补齐无超时的 fetch（P2-2 调查中新发现的真实缺陷）

- **问题**：以下 fetch **完全没有超时**，上游一旦挂住就会一直拖到 Serverless 函数被平台强杀，白白占住并发额度（比"重复代码"严重得多，属于可用性缺陷）：
  - `src/lib/redirect-location.ts:5-9`（`getRedirectLocation`，**最该先补**——公共函数，被火山/西瓜短链、twitter t.co 等多处调用）
  - `src/lib/platformRoutes.js:47-49`（内部转发）
  - `src/app/api/`：huya、xinpianchang、xigua、acfun、quanminkge、haokan、zuiyou、sixroom、bilibili（整文件无 timeout）、twitter:618-625（syndication）
- **动作**：统一改用 `fetchWithTimeout`，短链跟随取 `TIMEOUT.SHORT`(5s)，页面抓取取 `TIMEOUT.DEFAULT`(8s)。
- **验收**：`grep -rn "fetch(" src/app/api src/lib | grep -v signal` 显著减少；各平台单测全绿。
- **风险**：**属于行为变更**（原来"无限等"，现在会超时失败），需逐平台灰度。本项目尚未建立 live 回归，建议先补 `redirect-location` 一处并观察，再铺开。

> **复核结论（2026-09-14）：已完成，11 个文件补了 13 处。**
> - 已补：`redirect-location.ts`（`getRedirectLocation` 增加 `timeoutMs` 参数，默认 8s；顺带修了"未取到 Location 时 body 未消费导致连接悬挂"）、acfun / huya / xinpianchang / xigua / quanminkge / haokan / zuiyou / sixroom（统一 `TIMEOUT.DEFAULT` 8s）、bilibili（`bilibiliRequest` 8s + b23.tv 短链跟随 5s）、twitter syndication（8s，超时自然落入既有 catch→502 分支）。
> - **调查误报 1 处**：`platformRoutes.js:47-49` 是同进程构造 `Request` 直接调 `mod.GET(request)`，没有网络请求，无需改（原文档把它误列为"内部转发"缺口）。
> - 浏览器端 fetch（`music-remote-cache` / `music-caps` / `use-music-settings` / `downloadImages` / `music-client`）不属于本条范围：同源请求用户可感知可取消。
> - 全量 936 通过，无超时缺口清零（`await fetch(` 剩余命中全部自带 signal）。

---

# P3 · 依赖与文档卫生

## P3-1 清理调试产物

- **问题**：根目录 `tmp-bar-1/2/1100/1280/1440.png` + `tmp-bar-probe.mjs` 为一次性调试产物，**未加入 .gitignore**（git status 中为 untracked）。
- **动作**：删除 6 个文件；`.gitignore` 补 `tmp-*.png`、`tmp-*.mjs`。
- **验收**：`git status` 无 tmp 残留。

## P3-2 依赖清理

- **问题**
  1. `audiomotion-analyzer` 全仓库 **0 引用**（功能已被 `pseudo-spectrum.tsx` 原生 Canvas 实现取代）。
  2. `playwright-core` 位于 **dependencies**（应为 devDependencies，且仅服务于 P3-1 的临时脚本）。
  3. `@pixi/filter-bulge-pinch ^5.1.1` 与其余 `@pixi/* ^7.4.3` 版本数字断裂。
- **动作**：删 `audiomotion-analyzer`；`playwright-core` 移 devDependencies 或随临时脚本一并删；为 `@pixi/filter-bulge-pinch` 加注释锁定版本原因。
- **验收**：`npm run build` 通过；`tests/music-*.test.ts` 全绿。
- **风险**：**`@pixi/*` 其余 7 个子包虽无直接引用，但属 `@applemusic-like-lyrics/core` 的 peerDependencies，必须保留，勿误删**。

## P3-3 死配置与冗余 import

- **问题**
  1. `next.config.mjs:48-113` 手写 12 组 `remotePatterns`（http/https 各一遍），但 `images.unoptimized: true` 使其**完全不生效**——死配置。
  2. `src/components/videos/` 下 **14 个文件**存在冗余 `import React`（React 19 自动 JSX runtime）。
  3. `tests/twitter-fixer.test.ts:403-405` 断言 `sign` / `followerCount` / `views`，`npx tsc --noEmit` 报 TS2339「类型上不存在」——**既有类型错误**（测试运行通过，说明运行时有值、类型声明滞后）。
- **动作**：删除 `remotePatterns` 配置块（保留 `unoptimized: true` 及原因注释）；批量移除冗余 `import React`；补齐 Twitter 解析结果类型声明中缺失的 3 个字段。
- **验收**：`next build` 通过；lint 无 unused-vars 新增报警；`npx tsc --noEmit` 归零。
- **风险**：低。删 `remotePatterns` 前确认没有 `<Image>` 走优化路径（当前全站 `unoptimized`，安全）。

## P3-4 吞异常补日志

- **问题**：多处空 catch 无任何记录，线上静默失败：`src/lib/result-cache.js:46,78,113`、`src/app/api/image/route.js:85`、`src/app/layout.tsx`。
- **动作**：统一改为 `catch (e) { logger.warn("...", e?.message); }`，沿用 `logger.warn` 生产可见的约定。
- **验收**：无空 catch 残留（有意为之者需带注释说明）。
- **风险**：低。注意日志脱敏，不要打印完整 URL（可能含签名 token）。

## P3-5 文档去重与结构修正

- **问题**
  1. `CLAUDE.md` 第 10 行单段近 2000 字、第 56 行近 2500 字，与 `docs/ROADMAP.md`、`src/components/music/musicEngine.md` 三处描述高度重叠 → 易腐化。
  2. `CLAUDE.md:86` 约定「类型集中在 `src/types/`」，但 `src/types/` 实际只有 `api.ts`，音乐类型在 `components/music/types.ts`、平台类型在 `config/*.ts` → **文档已失真**。
- **动作**：`CLAUDE.md` 拆出 `docs/architecture.md`（目录约定、平台接入 SOP），`CLAUDE.md` 保留索引引用；随 P2-1 把类型归位后同步修正该约定表述。
- **验收**：文档与实际目录一致；`CLAUDE.md` 单段不超过 500 字。
- **风险**：低。

---

# 全局风险与注意事项

1. **禁止一次性重写骨架**。`createApiHandler` / 平台 route 涉及 30+ 文件，必须**逐平台灰度**：改一个 → 跑单测 → 跑 `npm run test:live` → 提交。改造前先跑一次 live 基线并留存结果。
2. **代理端点加 SSRF 防护会改变行为**。先开「仅记录」观察 1~2 天，确认无业务误伤再切强拦截（P0-1）。
3. **Cloudflare Workers 语义陷阱**。`globalThis` 缓存依赖 isolate 复用，**不要假设强一致**；`result-cache.js` 已做 Cache API / 内存双路径，新增缓存需沿用该模式。
4. **改 UA 有触发风控的风险**。P2-2 第一阶段只集中管理不改值。
5. **MusicExplorer 的 5 处 `exhaustive-deps` 禁用是雷区**。直接照搬逻辑拆分会固化 stale-closure bug，必须先补依赖再拆（P2-5）。
6. **平台元数据收敛的回归面广**。改动后必须回归 `/api/engines` 体检接口 + 全平台 live 解析（P1-2）。
7. **`@pixi/*` 不可删**（AMLL peerDeps）；`clsx` + `tailwind-merge` 是 shadcn 标准组合，非重叠依赖，勿合并。
8. **性能改动需可度量**。P1-4 每步改动前后各测一次 P95，避免「优化」反而劣化。
