# 代码质量整改计划

> 基于 2026-09-14 全量粗审（src/ 200 文件 + 工程配置）生成。
> 优先级：**P0 安全/稳定性 > P1 状态与配置治理 > P2 结构整改 > P3 卫生清理**。
> 原则：**小步、可回滚、每批带验收标准**；禁止一次性重写骨架（涉及 30+ 平台 route）。

## 进度总览

| 批次 | 主题 | 任务数 | 预估 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 安全与稳定性补漏 | 4 | 1~2 天 | ✅ 已完成（2026-09-14） |
| P1 | 全局状态与配置治理 | 4 | 2~3 天 | ✅ 已完成（2026-09-14） |
| P2 | 结构整改与复用抽取 | 7 | 1~2 周 | ✅ 已完成（2026-09-14） |
| P3 | 依赖与文档卫生 | 5（+1 补做：P3-6 测试目录 lint 卫生） | 0.5 天 | ✅ 已完成（2026-09-14）；P3-6 已于同日补做完成 |

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
> - **遗留（2026-09-14 已由 P3-6 结清）**：`tests/` 下曾有 **114 个 eslint 错误**（实测值，比当时记的 87 更多）——6 个未使用导入已真删；`any` / `@ts-nocheck` 共 108 处在 `tests/**` 下降级为 warn；`lint` 脚本已纳入 tests 目录，现 `npm run lint` **0 error**。详见 P3-6。
> - **仍未修**：`tests/parse-route.test.ts` 在 CPU 有并发负载时会 flaky（单独跑 5/5 通过），疑似对时序敏感。

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

> **复核结论 2（2026-09-14）：第二批——超时裸写清零，P2-2 收尾。**
> - **范围**：`AbortSignal.timeout(<裸数字>)` 与「模块级常量 = 裸数字」两类，共 **30 处 / 16 个文件**。
> - **替换规则（零行为变化是硬约束）**：
>   1. 值命中现有档位 → 直接 `TIMEOUT.XS/SHORT/DEFAULT/LONG/PAGE/DOWNLOAD`（3s/5s/8s/15s/20s/30s）。
>   2. 值**不在**档位上（4s / 6s / 7s / 10s）→ **就地提为具名常量并注明"不在公共档位、勿归并"**，不往 `TIMEOUT` 里加档。理由：这些值是各链路实测踩出来的（如抖音备用源 6s、分享页 10s、IP 查询 4s、短链 7s），归到相邻档就等于**悄悄改行为**；把它们升格成"公共推荐档位"更糟——会把噪音固化成默认。
> - **落地**：`weibo` / `music/amll` / `music/resolve` / `netease-meta` / `kuwo-meta` / `music-actions/shared` / `turso-client` / `instagram` / `video-proxy` / `image` / `xhs` / `ip` / `douyin` / `twitter` / `kuaishouCore` / `qqmusic-id` / `verifyUrl` / `YouTubeVideo` / `_diag`，以及 P2-3 第二批顺手改的 `xigua` / `pipigx` / `qsmusic` / `qqmusic`。`ppxia` 里原本就叫 `TIMEOUT` 的局部常量改名 `UPSTREAM_TIMEOUT_MS`（与公共常量组同名易混）。
> - **刻意保留的 3 处**（已具名，不算裸写）：`youtube.js`（值由 env 覆盖）、`self-search/request.js` 的 `REQUEST_TIMEOUT`（导出常量，10s）、`music/resolve` 的 `REDIRECT_TIMEOUT`（7s，已具名 + 注释）。
> - 验收：`tsc --noEmit` 0 错误、`npm run lint` 干净、全量 **1067 通过**。

## P2-3 平台 route 样板工厂化

- **问题**：30+ 平台 route 存在大量样板（`{code:200,msg:"解析成功"}` 文案、短链跟随、Referer 设置、错误返回、图集/多清晰度解析、JSON 提取）。
- **动作**：在 `createApiHandler` 之上提供 `createSimpleParser({ platform, extract, normalize })` 工厂，让「简单平台」route 收敛到 30~50 行。**仅对结构规整平台先做**（`qsmusic` / `qqmusic` / `pipigx` / `quanminkge` / `huya` / `xigua` / `xinpianchang`），抖音/小红书/B站/快手等重逻辑平台**保持现状不动**。
- **验收**：改造后 `/api/engines` 状态不变；`tests/parsers-new.test.ts` + live 测试全绿。
- **风险**：**高。动骨架 = 30+ 文件同改**。必须逐平台灰度，禁止一次性重写。

> **复核结论（2026-09-14）：不做 `createSimpleParser` 工厂，改判为「先补测试安全网 + 只抽真同构的外壳」，已落地 5 个平台。**
> - **先看事实**：逐个读了 8 个「简单平台」route（huya 39 行 / quanminkge 53 / haokan 44 / acfun 52 / xinpianchang 53 / pipigx 78 / xigua 66 / qsmusic 93）。它们**同构的只有约 6 行外壳**——`createApiHandler` 包装、成功壳 `{ code:200, msg:"解析成功", data }`、失败壳 `{ code, msg }`、以及「从 URL 取 id」的 try/catch；**主体各不相同**：有的 `res.json()` 有的 `res.text()`、有的走自家接口有的直接抓分享页、错误码与文案各异、UA 是有意按平台调过的（P2-2 已判定平台 UA 就地维护）。
> - **因此否掉工厂**：`createSimpleParser({ platform, extract, normalize })` 要把「json 还是 text / 超时档位 / 各平台错误文案 / UA / 失败码」全变成选项字典——这正是 P2-2 复核里已经判过的反模式：**把分支换成选项字典，只挪位置、不减分支**，还多一层要读源码才懂的骨架。计划里"收敛到 30~50 行"的目标也无从达成（本来就 39~93 行）。
> - **改判后实际做了两件事**：
>   1. **先补单元测试安全网**（这才是真债）：这 5 个平台此前**只有 live 测试**——要真实链接 + 真实网络、默认跳过，等于没有安全网；P2-5 的教训就是"零覆盖时别动结构"。新增 `tests/simple-platforms.test.ts`（**17 个用例**，mock `global.fetch`），覆盖成功 / 上游无数据 404 / 链接无 id 400 / 上游异常 500 四条路径，并记下两条测试约定：限流与平台节流在 `VITEST=true` 下自动跳过；进程内成功缓存 5 分钟，**每个用例必须用不同 URL**。
>   2. **只抽真同构的外壳** → 新增 `src/lib/parser-kit.js`：`parseOk(data)`（"解析成功" 字面量从 12+ 处收敛到 1 处）、`parseFail(code, msg)`、`extractQueryParam(url, key)`（区分「链接非法」与「参数缺失」两种 400，此前 quanminkge / haokan 各写一遍）。应用到**有测试覆盖的 5 个平台**：huya / quanminkge / haokan / acfun / xinpianchang。
> - **其余 7 个平台留到下一批**：逐平台灰度（改一个 → 单测 + live → 提交），本批不扩大改动面。
> - 验收：`npx tsc --noEmit` 0 错误；`npm run lint` 干净；全量单测 **953 通过**（936 + 17 新增）。

> **复核结论 2（2026-09-14）：第二批完成，候选池 7 个平台全部处理完，P2-3 收尾。**
> - **补齐的 4 个**：`xigua`（4 处壳）/ `pipigx`（5 处）/ `qsmusic`（5 处）/ `qqmusic`（route 2 处失败壳）。`qqmusic` 的成功壳在 `lib/qqmusic-id.js` 里且 `msg` 是动态的（失败原因透传），**不是同构外壳，不换**。
> - 顺带把这三个平台的裸写超时一并收敛（见 P2-2 复核结论 2）。
> - **测试 17 → 34 例**（+17）：西瓜 6（短链跟随 / 无 Location / 无 `_ROUTER_DATA` / JSON 非法 / 无播放地址 / 上游异常）、皮皮搞笑 6、汽水音乐 5（含 LRC 转换：`startMs=0` 的句子被过滤，只剩 `[01:05.000]你好`）。
> - **踩到一个真 bug（未修，按现状锁死）**：`pipigx` 取视频地址是 `videos.filter(Array.isArray)` 之后取 `videos[0].url` —— filter 之后元素仍是数组，`videos[0].url` **恒为 undefined**，而 JSON 又无法表达「数组自带 url 属性」，等于**成功分支不可达、任何上游响应都 404**。已在代码处标注 ⚠️ 并写明：需要真实响应样本才能确定该 flatten 还是改下标，**本轮不猜**。修复时 `tests/simple-platforms.test.ts` 里"成功分支当前不可达"那条会变红，正好是提醒。
> - 验收：`tsc --noEmit` 0 错误、`npm run lint` 干净、全量 **1067 通过**（1050 + 17 新增）。

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
| `src/components/music/MusicExplorer.tsx` | 1604 → **862** | 拆出「搜索 / 播放 / 收藏」三个容器 hook + 展示组件。**已抽**：搜索域 `use-music-search.ts`(614)、媒体域 `use-music-media.ts`(294)、交互域 `use-mobile-viewport` / `use-mobile-gestures` / `use-overlay-dismiss`；播放域早先在 `use-player-engine.ts`(681) |
| `src/components/music/use-player-engine.ts` | 858 → **681** | 原计划「拆三个 hook」，评估后改判（见下）：**已完成**候选挑选层 `alt-candidates.ts` 与传输层 `use-audio-transport.ts`(237)；剩下的「会话状态 + 换源闭环」不拆（11 个 ref 交织、递归互调） |
| `src/app/api/music/route.js` | 801（`GET` 约 660 行） | 按 `action` 拆为 handler 映射表 ✅ **已完成（2026-09-14）** |
| `src/lib/music-client.ts` | 908 | 拆「搜索 / 直链 / 歌词 / 封面」通道模块 ✅ **已完成（2026-09-14）** |

- **验收**：`tsc --noEmit` 无新增错误；音乐页交互冒烟通过。

> **复核结论（2026-09-14）：route.js 已拆完（P2-5 第一块）。**
> - **结构**：`route.js` 由 846 行瘦到 **116 行**（LF 实测），只留 CORS / 限流 / 蜜罐拦截 / 开关矩阵加载 / 参数归一化 + 分派；四个 action 各占一文件于 `src/lib/music-actions/`（`search.js` / `pic.js` / `lyric.js` / `url.js`），跨分支共用的上游请求头、超时预算、多基址链编排、JSON 解析抽到 `shared.js`，映射表与用法提示在 `index.js`。
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

> **候选挑选层的测试补齐（2026-09-14）：`alt-candidates.ts` 从 0 覆盖 → 22 个用例。** 这是上一条复核里写明的「先用 `renderHook` 给播放引擎补测试，再动 transport 那一刀」的前半段——不需要 jsdom 就能先做的部分：
> | 函数 | 用例 | 锁住的规则 |
> | --- | --- | --- |
> | `mergeAltCandidates` | 6 | 按 `musicKey` 去重且**保留更优的一份**（auto > 非 auto，其次高分）；排序 = auto 优先 → 分高优先 → key 字典序（无分视为 -1，排末尾）。三路（A/C/B）合并同曲只出现一次 |
> | `pickQueueAlternatives` | 6 | 排除自身；歌名按 `cleanMusicText` 清洗后比对（`(Live)` 之类括注不影响匹配）；歌手需有交集；专辑一致或缺失 → `auto=true`，**专辑都给但不同 → 降级人工候选**（现场 / 翻唱）；auto 优先排前 |
> | `pickCachedAlternatives` | 5 | 候选源必须「当前既可搜又可播」（migu 这类无内置直链的缓存行不入选，否则必然失败还会白写一条黑名单）；排除失败源自身；命中即 `auto=true` + `provenance="cache"`；`urlId` 兜底取缓存 id；缓存行无 album 时沿用失败曲目的专辑 |
> | `isSameMediaSrc` | 5 | 空值 false；忽略 hash 与结尾斜杠；一方是另一方后缀（代理前缀差异）视为同一资源；不同资源必须 false（误判会导致跳过重新赋 src、续播失败） |
> - 对 `@/lib/client/music-client`（`crossSearchPlayableSourceKeys`）与 `@/lib/music-remote-cache`（`readCachedCandidates`）用替身，故断言不受引擎开关矩阵与网络影响；`cleanMusicText` / `musicKey` 走真实实现（去重与匹配口径与线上同源）。
> - 验证：`tests/alt-candidates.test.ts` 22 例全绿，全量 **993 通过**（971 + 22）。
> - **仍未做**：`renderHook` 层面的引擎测试（直链就绪续播 / 音质热切换）——需要 jsdom + `@testing-library/react`，属「引入测试基础设施」的独立项，见上方 MusicExplorer 复核结论里的顺序建议①②③。
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

> **复核结论（2026-09-14）：MusicExplorer 的拆分前置已完成，但本轮未动刀——卡点是测试，不是结构。**
> - **现状盘点**（LSP 符号扫描）：单组件内 **398 个符号**——约 40 个 `useState`、28 个 `useEffect`、17 个 `useRef`，域边界在文件里是**按注释分区**而非按模块分区；`tests/` 对该组件的命中数为 **0**。
> - **「搜索 / 播放 / 收藏」三分为什么不好落**：播放域（`use-player-engine`，858 行）抽走后，剩下的是**视图编排层**，三域之间仍有硬耦合——搜索域的 `runSearch` 要回调 `playSearchQueue`（播放域）与 `showToast`；收藏域的 `favQueue` 与播放域的 `activeList` 通过 `queueOrigin` 互斥（`queueOrigin` 同时是"收藏队列不落搜索快照"的守卫）；`goToPage` / `handleListScroll` / `reachedLoadPoint` 三个翻页入口共享 `pagingRef` 防重入，且三者都被 `eslint-disable exhaustive-deps` 保护（**风险 1 的复核已判定：缺依赖不等于 stale closure，入依赖反而会自触发连锁翻页**）。硬拆要么把 10+ 个 state 与 4 个 ref 抬到父层逐一下传，要么用回调注入互相调用——参数爆炸，且会把"每次渲染新建闭包、故意不入依赖"的既有约定打散。
>   - **2026-09-14 已解决**：这里的三处耦合正是搜索域的边界——`runSearch` 的播放域回调、`pagingRef` 三入口共享、以及"不入依赖"的约定，都随**搜索域整体搬进 `useMusicSearch`**（见下「搜索域抽离」）一并收走，耦合改为 `options` 注入 + ref 取最新值，没有抬 state 也没有参数爆炸。
> - **先补安全网再动刀（建议顺序）**：① 引入 `@testing-library/react` + `jsdom`（当前 devDependencies 无组件测试库，vitest 为 node 环境）；② 用 `render` / `renderHook` 补三条最关键路径——挂载期本地恢复 → 列表渲染、关键词搜索 → 结果写入、点播 → 直链就绪起播；③ 再按「搜索容器 hook → 展示组件（底栏 / 整页歌词 / 详情弹窗）」两步拆。
> - **①②③ 均已完成**（① 见「组件测试基础设施」；② 见「MusicExplorer 渲染级测试」；③ 前半 = 搜索域 `use-music-search.ts`，见下）。
>   - **③ 后半（底栏 / 整页歌词 / 详情弹窗）实际早已落地**：`PlayerBar` / `LyricPage` / `TrackInfoDialog` 各自独立，组件里只剩三个转调薄壳（`renderBottomBar` / `renderLyricPage` / `renderTrackInfo`）。本文件此前记为"未做"是**记账错误**——后半真正的内容其实是**媒体域 + 交互域的 effect**，已于 2026-09-14 抽走（见下）。
> - 本轮为它做的**可静态验证**的准备工作已完成：依赖数组缺陷已复核修正（风险 1）、P2-6 遗留的大小写重命名已修正（`marquee.tsx → Marquee.tsx`，消除 TS1261）。

> **第一刀（2026-09-14）：先抽「不需要动状态就能测」的部分，而不是硬拆三域。** 1708 → **1650 行**（实测），新增 **18 个用例**（全量 971）。
> | 抽出 | 行数 | 为何值得抽 |
> | --- | --- | --- |
> | `search-channel-pref.ts` | 47 | 搜索渠道偏好的读写：带结构版本号 + 恢复时过引擎开关，是**本机偏好**，与同目录 `player-prefs.ts` 同族。此前内联在组件里无法断言 |
> | `playable-rank.ts` | 24 | 聚合「同曲合并」挑主副本的可播性排序，**锁的是 `musicEngine.md` 里写明却从无断言的规则**：GD(0) > kugou(1) > migu(2)。顺便不再每次渲染新建闭包 |
> - **与 `player-prefs.ts` 刻意不合并**：那份带内存缓存（`cached` 模块变量），而渠道偏好**不能缓存**——引擎开关矩阵 `/api/music/caps` 异步到达，缓存会把「开关已关」的旧判断固化。新模块每次读都重新求值，并专门写了一条用例锁这个语义（开关打开后同一份缓存立即可用）。
> - **搜索渠道偏好测试覆盖**（13 例）：无记录 / 版本不符 / 无版本号 / `agg` 非布尔 / 非法 JSON / localStorage 不可用 → 一律 `null` 且不抛；合法记录原样返回；source 不在内置源或所属平台引擎已关 → 回落默认源（保留 `agg`）；写入落盘结构 `{v, agg, source}`；写入失败静默。
> - 依赖方向检查：`playable-rank.ts` 需 `sourceEngineKindFor` / `SELF_ONLY_ENGINE_KEYS`，**没有**放进 `src/lib/music-match.ts` —— 那会形成 `music-match → music-client → music-client-search → music-match` 的环，故留在组件目录作叶子模块。
> - 验证：`tsc --noEmit` 0 错误、`npm run lint` 干净、全量 **971 通过**（953 + 18）。

> **组件测试基础设施落地（2026-09-14）：仓库第一个渲染级测试。** 这是上面顺序建议的 ①，也是 P2-5 剩下两块的唯一解锁条件。
> - **新增 devDependencies**：`jsdom@^29.1.1`、`@testing-library/react@^16.3.3`、`@testing-library/dom@^10.4.2`（RTL 16 起 `@testing-library/dom` 是 peer，必须显式装）。既有 3 个 `npm audit` 告警（next critical / fast-uri / qs）与本次无关，安装前后一致。
> - **刻意没有装 `@vitejs/plugin-react`**：本仓 vite 是 **8.2.2**，插件 v5 的 peer 只到 `^7`，v6 才支持 8 —— 而 v6 依赖 `@rolldown/plugin-babel`，其 peer 同时接受 `@babel/core@7 || 8`，在本仓解析成 8.0.5 与既有 7.29.7 冲突 → `ERESOLVE`。为不加 `--legacy-peer-deps`、不污染 lock，放弃插件走原生转换。
> - **配置坑（值得记）**：Vite 8 起转换器是 **oxc**，`esbuild.jsx` / `esbuild.tsconfigRaw` 均已失效（日志只提示"oxc options will be used"），而 tsconfig 的 `jsx: "preserve"` 是 Next 的硬性要求不能改 → JSX 被原样保留、下游 `ssrTransformScript` 直接报 "Unexpected JSX expression"。解法是 `vitest.config.mts` 里 `oxc: { jsx: "automatic" }`。
> - **环境按文件 opt-in**：组件测试顶部写 `// @vitest-environment jsdom`，`vitest.config.mts` 的 `environment` 仍为 `node` —— 既有用例的运行环境零改动（全量 993 → 1005，无既有用例变红）。
> - **首个组件测试 `tests/alt-select-dialog.test.tsx`（12 例）** 选 `AltSelectDialog` 打头是刻意的：纯 props 进出（无 hook / store / `<audio>`），先把链路跑通而不被 Audio / matchMedia / ResizeObserver 的 mock 干扰。覆盖：未打开不占 DOM；`aria-modal` 与可访问名；标题带失败曲目名（`picked=null` 时退化文案）；每候选一行的来源标签 / 歌名 / 歌手·专辑（走 `sourceMetaFor`）；`artistText` 由父层注入；**徽标注释按 provenance 分支断言**（auto 无注、list 专辑不同、现搜"专辑不同" vs "置信度不足"、cache"曾成功播放过"）；交互（点行 `onPick`、关闭按钮、点遮罩关闭 vs 点卡片不关闭）。
> - 注意：vitest 未开 `globals`，RTL 的自动 cleanup 不注册，测试里显式 `afterEach(cleanup)`。
> - 验证：`tsc --noEmit` 0 错误、`npm run lint` 干净、全量 **1005 通过**（993 + 12）。`npx next build` 未因本次改动重跑（仅 devDeps 与测试文件）。

> **播放引擎补测 + transport 抽离（2026-09-14）：顺序建议的 ② 与 transport 那一刀一起落地。**
> - **`tests/use-player-engine.test.ts`（19 例）**：`renderHook` + **替身 `<audio>` 元素**（经 `audioProps.ref(el)` 注入，不渲染真实 audio，故不需要媒体栈）。网络 / 远程缓存 / caps 走替身，`music-match` 与 `alt-candidates` 走真实实现。覆盖：
>   | 组 | 锁住的行为 |
>   | --- | --- |
>   | 挂载恢复（2） | 从 `player-prefs` 恢复音量/音质/循环/静音；**恢复值不会被默认档写回覆盖**（首渲染跳过落盘，否则 0.5 会把 0.35 冲掉） |
>   | 点歌主路径（3） | 直链就绪即起播；取链失败 → `failStage=resolve` + 文案 + 上报；**层①写入条件是「真实出声」**（取到直链不上报，`onPlay` 才上报） |
>   | 会话恢复（2） | 定位到上次进度但**不自动起播**；续播位置超过时长按 `duration` 截断 |
>   | 音质热切换（4） | 播放中切档旧链不打断 → 新源就绪后从旧位置续播；**切档窗口内的媒体报错 = 新档不可播，不触发整曲换源**；切档失败回滚档位且保留旧链；暂停中切档不自动起播 |
>   | transport 原语（6） | 音量/静音/循环同步到元素；`togglePlay`；起播被拦截回落 `playing=false`；`seek` 按 `[0,duration]` 截断；单曲循环 vs 播下一首；页尾 `ended` + `hasMore` → 先翻页再播新页第一首 |
>   | 自动换源（2） | 主曲失败 → 自动尝试队列内高置信候选且成功即停（不跑现搜）；总开关关闭时只留文案、`autoTrying` 不常亮 |
> - **两个值得记的测试约定**：① 恢复会话用例不能断言 `audio.play` 从未调用——`attemptPlay` 里的 `unlockAutoplay` 会先静音试播一次，要比对「直链就绪前后」的调用次数；② `player-prefs` 有**进程内内存副本**，同一用例里第二次挂载会继承上一次 `setLoop(true)`，需 `localStorage.clear() + resetPlayerPrefsCacheForTest()`。
> - **transport 抽离**：新增 `src/components/music/use-audio-transport.ts`（217 行）——元素持有（`audioRef`）、音量/静音/循环同步、`play`/`pause`/`togglePlay`/`seek`/`unlockAutoplay`/`pauseAndRestoreMuted`、**直链就绪续播 `playWhenReady`**（resumeAt 定位 + autoplay + canplay 等待 + 清理函数）、`audioProps`。引擎只留会话语义，把传输事件翻译成快照；事件回调走 `latest` ref 取「最新一次渲染」的值（等价于原先每渲染重建 `audioProps`）。
> - **踩到的分层细节**：`transport` 必须**先于**依赖它的 effect 创建，并把 `onEnded`/`onError` 用箭头包一层（它们在下方定义，箭头把取值推迟到事件触发时）；effect 依赖要写成解构出来的稳定原语（`setResourceUrl`/`playWhenReady`），直接写 `transport` 会因每次渲染都是新对象而重复触发。
> - 结果：`use-player-engine.ts` **749 → 681 行**（实测），传输层 **237 行**单独成文，可直接替换成别的播放引擎。二者相加多于原 749 行 —— 抽离**不是纯搬移**：transport 补了方法级 JSDoc，引擎补了「会话语义 / 传输层」的分层说明与 `latest` ref 注释。
> - 验证：`tsc --noEmit` 0 错误、`npm run lint` 干净（无 warning）、全量 **1024 通过**（1005 + 19；实测 1024 passed / 18 skipped，60 files passed / 4 skipped）。
> - **数字口径留档**：本文件此前几处行数（1555 / 650 / 217）是凭记忆记的，与实测（1650 / 681 / 237）不符，已按 `node -e` 实测值订正。**后续复核结论一律写实测值**，不要沿用估算。
> - **数行数的工具也要留档（2026-09-14 二次订正）**：本轮用 PowerShell 的 `Get-Content -Encoding utf8 | Measure-Object -Line` 复核，得到 650 / 217 / 583 / **808** —— 与 `node -e` 数 `\n` 字节得到的 681 / 237 / 614 / **862** 系统性偏低（少 4%~7%，疑为对特殊字符 / 长行的解码差异）。**已用第三种方法（直接数 LF 字节）裁决，以 `node` 为准**：681 / 237 / 614 / **862**。教训：复核行数**不要用 `Get-Content`**，用 `node -e` 数 `\n`，且至少两种工具交叉验证过再下结论——否则"订正"本身就成了新的水分（`MusicExplorer` 的 808 就是这么写进去的，实为 862）。

> **MusicExplorer 渲染级测试落地（2026-09-14）：顺序建议的 ② 完成，三域拆分的安全网铺好。**
> - `tests/music-explorer.test.tsx`（**12 例**）走**整组件 `render`**：**不替身任何子组件**（SearchPanel / PlaylistPanel / PlayerBar / NowPlayingPanel 全走真实实现），只替身网络（`music-client`）、开关矩阵（`music-caps`）、远程缓存（`music-remote-cache`）与封面取色（canvas 在 jsdom 不可用）。断言因此贴近真实交互：填表提交、点结果行、读 `<audio>` 的 src。
> - 三条关键路径：
>   | 组 | 例 | 锁住的行为 |
>   | --- | --- | --- |
>   | ① 挂载恢复 | 4 | 快照来源 = 渠道偏好 → 回填列表并退出「恢复中」占位；渠道为聚合 → 不回填且清掉残留快照；无快照 → 空态且不卡占位；**回填只填数据、不改视图**（切到「播放列表」才见内容——历史上快照恢复曾无条件 `setMusicView("playlist")`，把偏好就地改写后用户再也回不去「发现歌曲」） |
>   | ② 搜索 | 6 | 聚合多源结果写入 + 自动切视图 + 落渠道偏好与搜索历史；部分音源失败给降级提示；单源走 `requestSearchPage` 且**首屏不满一屏自动补页累积**（去重后两页各出现一次，补页不顺手点播）；无结果空态带关键词；**失败态优先于空态**（聚合 / 单源都上屏失败原因，且不与「无结果」混淆） |
>   | ③ 点播 | 3 | 点行 → 取直链 → 写入受控 `<audio src>` → `canplay` 后起播 + 该行标 `is-active`；取链失败不上 src 且错误上屏；上次会话挂载后重新取链但**停在暂停态**（不自动出声） |
> - **jsdom 补齐**（都在测试文件末尾，集中一处便于复用）：`matchMedia`（对 `prefers-reduced-motion` 返回 true，让伪频谱跳过 rAF 动画循环）、`ResizeObserver`、`HTMLMediaElement.play/pause`、`HTMLCanvasElement.getContext → null`（jsdom 默认实现会打 "Not implemented" 噪声）。另有三个模块必须替身：`LyricPage`（内部 `dynamic()` 懒加载 AMLL / Pixi，jsdom 下必炸）、`use-media-session`（依赖 `navigator.mediaSession`）、`next/link`（App Router 需要路由上下文）。
> - **新发现一处 UX 缺口（当时只锁现状；2026-09-14 已修）**：搜索失败时只写 `searchError`，而视图在搜索开始时就切到了播放列表 → 空态「播放列表还是空的」优先渲染，失败原因（挂在 SearchPanel / `emptyHint` 上）用户看不到。
>   - **修法**（比当时设想的更贴切，不靠 `setList([])` 混进空结果态）：`PlaylistPanel` 把 `emptyHint` 改造成 **`errorHint`**——非空则渲染**失败态，优先于「未搜索」与「无结果」两个空态**，图标 `AlertCircle` + 原因 + 重试引导；组件侧 `emptyHint={aggActive && searchError ? …}`（**只有聚合模式带得出来**）改成 `errorHint={searchError}`，单源失败也上屏。
>   - 语义上顺带纠正了另一半：聚合全源失败此前显示的是「没有找到…」，现在显示「这次搜索没有完成」——**失败 ≠ 无结果**，不该混成一个空态。
>   - 用例同步改写（原「失败 → 落到空态」改为「失败原因上屏、空态不出现」），并补一例**单源**失败：`tests/music-explorer.test.tsx` 12 → **13 例**。
> - 验证：`tsc --noEmit` 0 错误、`npm run lint` 干净、全量 **1037 通过**（1024 + 13）。

> **搜索域抽离（2026-09-14）：`useMusicSearch` 落地 —— 顺序建议的 ③ 第一步完成。**
> - 新增 `src/components/music/use-music-search.ts`（**614 行**）；`MusicExplorer.tsx` **1650 → 1215 行**（实测）。搜进去的：渠道偏好（聚合 / 单源 + 平台 chip）、关键词搜索（聚合并发 / 单源分页）、链接解析、结果列表与翻页（触底补页 + 窗口滚动）、列表快照与挂载期恢复、平台开关矩阵与 chips、最近搜索。
> - **跨域耦合怎么解**（本刀的关键，上文列为卡点）：
>   - 播放域 / UI 域的副作用一律由 `options` 注入：`onBeforeSearch`（清播放会话）、`notify`（轻提示）、`onSnapshotRestored`（快照回填后定位上次会话）。hook **不 import 播放引擎**，反向依赖随之消失。
>   - `options` 存在 ref 里读最新值：hook 内的 effect 刻意不把回调纳入依赖（挂载恢复只跑一次、快照落盘只在列表变化时跑），读 ref 既能拿到最新闭包、又不会因为回调每次渲染都新建而重跑。
>   - 与 `use-player-engine` 的循环依赖（引擎要 `source` / `list` / `hasMore`，hook 要 `restorePlayback`）由调用方用两个 ref（`resetPlayerRef` / `restorePlaybackRef`）打破：hook 先建、引擎后建，**渲染期**回填 —— 渲染期赋值早于任何 effect 执行，所以挂载恢复读得到。
>   - 边界留在外面：`queueOrigin`（搜索队列 vs 收藏队列）仍归组件，只以「守卫」身份传入；播放会话的定位（哪首 / 播到几秒）由 `onSnapshotRestored` 回调交回组件交给引擎。
> - **行为等价的证据**：上一轮那 12 例 `render` 测试**一个字没改、全绿**。其中「快照回填不改视图」「首屏自动补页累积」「上次会话恢复停在暂停态」恰好是搬移中最容易走样的三条语义。
> - 顺带清掉的两处历史包袱：组件里不再有 `searchAbortRef` / `resolveAbortRef` / `listTopRef` / `pagingRef`，以及与搜索域绑定的那一批 import。
> - 验证：`tsc --noEmit` 0 错误、`npm run lint` 干净（无 warning）、全量 **1036 通过**（与抽离前完全一致）。

> **媒体域 + 交互域抽离（2026-09-14）：`MusicExplorer.tsx` 1215 → 862 行（LF 实测；原写 808 系 `Get-Content` 少算，已于 2026-09-14 订正）。**
> - **先核对「后半」到底是什么**：计划里写「展示组件（底栏 / 整页歌词 / 详情弹窗）待做」，实际这三个文件**早已独立**（`PlayerBar` / `LyricPage` / `TrackInfoDialog`），组件里只剩 `renderBottomBar()` / `renderLyricPage()` / `renderTrackInfo()` 三个**转调薄壳**。
>   - **薄壳刻意不动**：它们各承载 20~30 个 props，内联回主 JSX 只会把 `return` 撑成 250 行、更难读。删与不删都是 45 行的事，**可读性优先**（文档此前把它记成"未做"，属记账错误，已在上表订正）。
> - **媒体域 → `use-music-media.ts`（294 行）**：专辑封面、封面配色（整页歌词动态背景）、歌词（LRC + AMLL 双通道 + 本地缓存）、LRC 转可下载 Blob，连同 12 个 `useState` 与 3 个 `AbortController` ref。
>   - 只依赖「当前曲目 + 音源」，与搜索 / 播放编排 / 视图切换零耦合，是组件里最"外挂"的一块。
>   - **留在外面的**：歌词高亮行下标（「歌词 × 进度」的交叉结果，进度在引擎里）、`isDark`（只服务取色，不外传）。
>   - **新增一个出口 `markCoverFailed`**：`<img onError>` 要能标记失败，但 `setCoverFailed` 已随 hook 收走 —— 与其把 state 抬回父层，不如把"标记失败"这个动作收进接口（与请求阶段失败共用同一个 `coverFailed`）。
> - **交互域 → 3 个小 hook**：`use-mobile-viewport`(27) / `use-mobile-gestures`(152) / `use-overlay-dismiss`(45)。
>   - `use-overlay-dismiss` **顺带消掉一处逐字重复**：整页歌词与详情弹窗各写了一份「Esc 关闭 + 锁 body 滚动」。复制粘贴的隐患正在**让位规则**上——人工选版面板（`.mp-alt-mask`）浮在歌词页之上时 Esc 必须归它，两处各写一份，改一处忘一处就会出现「按一次 Esc 关两层」。
>   - 两条约定写进了测试：`onDismiss` **不入依赖**（每次渲染都换闭包，入依赖会反复改写 `overflow`）但**不许变陈旧**（存 ref 读最新）；关闭时**还原打开前的值**而不是写死空串（浮层可叠开，写死会提前解掉底层的锁）。
>   - `use-mobile-gestures` 的两个动作同样**经 ref 取最新实现**：手势监听常驻，而展开 / 收起的闭包每次渲染都是新的，进依赖会随渲染反复重挂、手势中途被打断。
> - **新测试 `tests/music-interactions.test.tsx`（13 例）**：锁的是搬移前靠人眼保证的边界 —— Esc 让位 / overflow 还原 / 最新闭包；手势的死区（<8px 不判定方向）、方向（向上交还原生滚动）、控制区起手不拦截、歌词区已滚动不抢滚动、过阈值才收起否则回弹、非移动端形态不挂监听；视口的断点跟随与旧版 Safari `addListener` 回退。jsdom 无 `TouchEvent` 构造器，用普通 `Event` 挂 `touches` 即可（手势只读 `clientY` / `target`）。
> - 验证：`tsc --noEmit` 0 错误、`npm run lint` 干净、全量 **1050 通过**（1037 + 13）。

> **P2-5 收尾（2026-09-14；同日复核后更新为「无剩余项」）。**
> - **五块文件现状**（实测）：`music.css` 拆 8 片 ✅；`api/music/route.js` 846→**116 行** ✅；`music-client.ts` 982 行拆 **5 个通道模块 + 1 个 barrel**（已迁至 `src/lib/client/music-client-*.ts`，barrel 96 行，对外零改动）✅；`MusicExplorer.tsx` **1650 → 862 行**（搜索 / 媒体 / 交互三域已抽，展示组件本就独立）✅；`use-player-engine.ts` **858 → 681 行**（候选挑选层 + transport 已抽，剩余部分判定为**不拆**）。
> - **本轮净产出**：新增 4 个 hook 文件 —— `use-music-media.ts`(294) / `use-mobile-gestures.ts`(152) / `use-overlay-dismiss.ts`(45) / `use-mobile-viewport.ts`(27)；新增 `tests/music-interactions.test.tsx` **13 例**；顺带消掉一处逐字重复（Esc + 锁滚动）。全量 **1036 → 1050**。
> - **~~明确不在本轮做的：transport 那一刀~~ → 2026-09-14 复核：已落地，此项作废。** 实测 `use-audio-transport.ts` 已接管 `resumeAtRef` / `autoplayRef`（`playWhenReady({ resumeAt, autoplay })`），且 `tests/use-player-engine.test.ts` 已覆盖「直链就绪 → 自动起播」（:156）与「音质热切换」4 例（:236-301）。当初把「最后一刀」和它的前置测试都记成未做，是**双重过期记账**——`use-player-engine` 剩余部分（会话状态 + 换源闭环，11 个 ref 交织 + 递归互调）判定为**不拆**才是不做的那一项，不是没做完。**P2-5 现无任何剩余项。**
> - **一条留给后续的经验**：本轮最大的收获不是删了多少行，而是**先核对计划里的"待做"是否真的待做**——`P2-5` 里写的「展示组件待做」「`use-player-engine` 858 行」「后半未做」三处，实测全是过期记账。动手前先量一遍，能省掉一把假刀。

## P2-6 命名规范统一

- **问题**：`components/music/` 下 PascalCase 组件（`MusicExplorer.tsx`、`PlayerBar.tsx`）与 kebab-case 模块（`music-view-store.ts`、`use-player-engine.ts`）混用；`AmllBackground.tsx` 与 `amll-background.tsx` 同目录并存（仅首字母大小写差异），疑为重构残留。
- **动作**：确立规范（**组件 PascalCase，hooks/stores/utils kebab-case**）并写入 `CLAUDE.md`；核查两个 Amll 文件的实际引用方，删除无引用者。
- **验收**：无重复职责的孪生文件；规范写入文档。
- **风险**：低。Windows 下大小写不敏感，删除前**必须确认引用方**，否则易误删。

> **复核结论（2026-09-14）：已完成，且原判断有一处需要更正。**\n> - **`AmllBackground.tsx` 不是重构残留**：它是 890 B 的懒加载壳（`dynamic ssr:false` + `memo`），真身在 4.8 KB 的 `amll-background.tsx`，与 `AmllLyricView.tsx` → `amll-player.tsx` 是同一套「壳 + 实现」分层。**但它是全仓唯一一对仅首字母大小写之差的文件**，Windows 无感、Linux / CI 上极易解析错。处理：把壳内联进 `LyricPage.tsx`（`memo(dynamic(() => import("./amll-background"), { ssr: false }))`，与 `AmllLyricView` 内的 `AmllPlayer` 写法统一），删除壳文件，只留实现文件。\n> - 4 个 kebab-case 小组件改 PascalCase：`eq-bars→EqBars`、`favorite-btn→FavoriteButton`、`icon-btn→IconButton`、`marquee→Marquee`（引用 6 个文件 / 10 处）。`amll-player.tsx`、`amll-background.tsx` **保留** kebab——它们是 `dynamic()` 的懒加载目标，kebab 正好标出「内部实现、勿直接引用」。\n> - 规范已写入 `CLAUDE.md` 的「约定」，含上述例外与「禁止仅首字母大小写之差」这条硬规矩。\n> - 全量 936 通过；src 侧 eslint 干净。
> - **补记（2026-09-14 晚）：`marquee → Marquee` 当时只落了一半。** Windows 大小写不敏感，目录里文件仍是 `marquee.tsx`、git 索引里也是小写，只有 import 改成了 `./Marquee` —— 本地一切正常，`npx tsc --noEmit` 却多出一条 TS1261（大小写冲突），Linux / CI 上会直接解析失败。已用两步 `git mv`（经临时名）修正，`tsc` 归零。教训已写进 `docs/architecture.md` §1：**Windows 上大小写重命名必须走两步 `git mv`**。

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

> **P2 整批复核结论（2026-09-14）：七条全部完成，全量 1067 通过 / 18 skipped。**
> - **P2-1** 反向依赖切断：`src/lib` 对 `@/components` 的引用 **0 命中**。
> - **P2-2** 第二批：30 处超时裸写收敛到 `TIMEOUT` 常量组与具名常量，余 3 处刻意保留（具名常量 / env 可调）。
> - **P2-3** 第二批：剩余 4 个平台（`xigua` / `pipigx` / `qsmusic` / `qqmusic`）接入 `parser-kit`，小平台单测 **17 → 34 例**。
> - **P2-4** 前端重复逻辑抽取：`playable-rank.ts`（可播性排序）+ `search-channel-pref.ts`（搜索渠道偏好）各自独立并带单测；`MusicExplorer` 由此瘦 58 行（1708 → 1650）、**+18 用例**。
> - **P2-5** 五块文件全完成（含此前误记为「待做」的 transport 那一刀）：
>   - `music.css` 拆 8 片；`api/music/route.js` 846 → **116 行**（LF 实测）；
>   - `music-client.ts` 982 行拆 **5 个通道模块 + 1 个 barrel**（迁至 `src/lib/client/music-client-*.ts`，barrel 96 行，对外零改动）；
>   - `use-player-engine.ts` 858 → **681 行**：候选挑选层 `alt-candidates.ts` 与传输层 `use-audio-transport.ts`（**237 行**）已抽，剩余「会话状态 + 换源闭环」因 11 个 ref 交织、递归互调，判定为**不拆**；
>   - `MusicExplorer.tsx` 1650 → 1215 → **862 行**（LF 实测）：搜索域 `use-music-search.ts`（614 行）、媒体域 `use-music-media.ts`（294 行）、交互域 `use-mobile-viewport` / `use-mobile-gestures` / `use-overlay-dismiss` 三个小 hook 已抽；展示组件（`PlayerBar` / `LyricPage` / `TrackInfoDialog`）本就独立，主 JSX 刻意保留薄壳以维持可读性。
> - **P2-6** 命名规范统一：全仓唯一一对「仅首字母大小写之差」的 `AmllBackground.tsx`（懒加载壳）内联进 `LyricPage.tsx` 后删除；4 个 kebab 小组件改 PascalCase（含两步 `git mv` 修正的 `Marquee`）；规范与其例外（`dynamic()` 懒加载目标保留 kebab）写入 `CLAUDE.md`。
> - **P2-7** 无超时 fetch 清零：11 个文件 13 处补齐，服务端 `fetch` 全部自带 signal（浏览器端 fetch 不在本条范围）。
> - **测试**：`alt-candidates` 0 → 22 例；组件测试基础设施落地（jsdom + RTL + oxc JSX）——播放引擎 19 例 `renderHook`、`MusicExplorer` 12 例 `render`、`tests/music-interactions.test.tsx` 13 例。
> - **已知未做（非本批验收项）**：`pipigx` 的取数逻辑已确认失效（`videos[0].url` 恒为 `undefined`，成功分支不可达）。现状已锁进测试并留 TODO；修它需要一条真实响应样本，不靠猜上游结构。
> - **数字口径**：以上行数均为 `node` 数 `\n`（LF）实测。复核时曾用 PowerShell `Get-Content | Measure -Line`，结果系统性偏低 4%~7%（`MusicExplorer` 一度被记成 808）——**该工具不可用于核行数**，详见 P2-5 复核段的留档。

---

# P3 · 依赖与文档卫生

## P3-1 清理调试产物

- **问题**：根目录 `tmp-bar-1/2/1100/1280/1440.png` + `tmp-bar-probe.mjs` 为一次性调试产物，**未加入 .gitignore**（git status 中为 untracked）。
- **动作**：删除 6 个文件；`.gitignore` 补 `tmp-*.png`、`tmp-*.mjs`。
- **验收**：`git status` 无 tmp 残留。

> **复核结论（2026-09-14）：文件已不在，本条只补了 .gitignore。**
> - 根目录 `tmp-bar-*.png` / `tmp-bar-probe.mjs` 现状命中数为 0（`git status` 干净、文件系统无匹配），说明已在此前批次删除，故未再执行删除动作。
> - 补了 ignore 规则 `/tmp-*.png`、`/tmp-*.mjs`——**带前导 `/` 限定仓库根目录**，避免误伤 `src/**` 下可能存在的同名文件。

## P3-2 依赖清理

- **问题**
  1. `audiomotion-analyzer` 全仓库 **0 引用**（功能已被 `pseudo-spectrum.tsx` 原生 Canvas 实现取代）。
  2. `playwright-core` 位于 **dependencies**（应为 devDependencies，且仅服务于 P3-1 的临时脚本）。
  3. `@pixi/filter-bulge-pinch ^5.1.1` 与其余 `@pixi/* ^7.4.3` 版本数字断裂。
- **动作**：删 `audiomotion-analyzer`；`playwright-core` 移 devDependencies 或随临时脚本一并删；为 `@pixi/filter-bulge-pinch` 加注释锁定版本原因。
- **验收**：`npm run build` 通过；`tests/music-*.test.ts` 全绿。
- **风险**：**`@pixi/*` 其余 7 个子包虽无直接引用，但属 `@applemusic-like-lyrics/core` 的 peerDependencies，必须保留，勿误删**。

> **复核结论（2026-09-14）：删了 2 个包；@pixi 版本断裂的原因写进文档而不是 package.json。**
> - `audiomotion-analyzer`：全仓 0 引用（功能已被 `pseudo-spectrum.tsx` 原生 Canvas 实现取代）→ 删。
> - `playwright-core`：全仓 0 引用（原仅服务 `tmp-bar-probe.mjs`，该脚本已随 P3-1 消失）→ **删而非移 devDependencies**：留在 dev 会让人误以为项目有 E2E 基线，实际一次都没跑过。`npm install` 后 lock 同步（`removed 2 packages`）。
> - `@pixi/filter-bulge-pinch@^5.1.1` 与其余 `^7.4.3` 的版本数字断裂**不是笔误**：上游该 filter 只发到 v5 线，而 AMLL 的 peerDependencies 声明为 `*`，升到 7.x 会装不上。
> - **package.json 是 JSON、不能写注释**，所以"@pixi/* 全部 7 个包是 `@applemusic-like-lyrics/core` 的 peerDependencies，删了运行时才报错"这条原因连同上面的版本说明一起写进 **`docs/architecture.md` §7（依赖须知）**，比夹在 JSON 里更容易被看到。
> - 验收：`npm run build` 通过、`npm test` 936 全绿、`npm run lint` 干净。

## P3-3 死配置与冗余 import

- **问题**
  1. `next.config.mjs:48-113` 手写 12 组 `remotePatterns`（http/https 各一遍），但 `images.unoptimized: true` 使其**完全不生效**——死配置。
  2. `src/components/videos/` 下 **14 个文件**存在冗余 `import React`（React 19 自动 JSX runtime）。
  3. `tests/twitter-fixer.test.ts:403-405` 断言 `sign` / `followerCount` / `views`，`npx tsc --noEmit` 报 TS2339「类型上不存在」——**既有类型错误**（测试运行通过，说明运行时有值、类型声明滞后）。
- **动作**：删除 `remotePatterns` 配置块（保留 `unoptimized: true` 及原因注释）；批量移除冗余 `import React`；补齐 Twitter 解析结果类型声明中缺失的 3 个字段。
- **验收**：`next build` 通过；lint 无 unused-vars 新增报警；`npx tsc --noEmit` 归零。
- **风险**：低。删 `remotePatterns` 前确认没有 `<Image>` 走优化路径（当前全站 `unoptimized`，安全）。

> **复核结论（2026-09-14）：三条都做了，并额外修掉一处计划外的类型错误；`tsc --noEmit` 首次归零。**
> - `remotePatterns`：确认 `images.unoptimized: true`（没有请求会走优化器）后删掉 12 组死配置，保留 `unoptimized` 与「日后若开启优化需一并补回」的注释。
> - 冗余 `import React`：复核命中 **14 个文件**（与计划一致）。其中 `DownloadRow.tsx` **不是冗余**——它用 `React.ReactNode`，改成 `type ReactNode` 类型导入；其余 13 处直接删默认导入（React 19 自动 JSX runtime）。
> - `tests/twitter-fixer.test.ts` 的 3 个 TS2339：**根因不是"类型声明缺字段"**，而是 vxtwitter 适配器**根本不写** `sign` / `followerCount` / `views` 三个键（只有 fxTwitter 分支写），TS 按对象字面量推断出"没有这三个属性"，而测试按统一契约读它们。`ParseData` 里三者本就是可选字段，故给 `buildVxtwitterResult` 补 JSDoc `@returns`，把返回值锚到 `ParseData & { durationFormat?: string }`（`durationFormat` 是该分支额外下发、契约未收录的字段）。
>   **没有**为了让类型通过而往运行时对象里塞 `sign: undefined` ——那会让 `Object.keys` 多出三个键，属于"用运行时形状迁就类型"。
> - **计划外**：`tsc` 基线其实不是 3 个而是 **4 个**。多出的 TS1261 来自 P2-6：`marquee.tsx → Marquee.tsx` 在 Windows 上只改了 import、没改文件名（git 索引里仍是小写），大小写冲突。两步 `git mv`（经临时名）修正后，`npx tsc --noEmit` **归零** —— P2-1 立下的「新增错误数必须为 0」红线首次在绝对值上也达成。
> - 教训已写进 `docs/architecture.md` §1：**Windows 上大小写重命名必须走两步 `git mv`**，否则 git 索引不更新，本地一切正常、CI（Linux）才炸。

## P3-4 吞异常补日志

- **问题**：多处空 catch 无任何记录，线上静默失败：`src/lib/result-cache.js:46,78,113`、`src/app/api/image/route.js:85`、`src/app/layout.tsx`。
- **动作**：统一改为 `catch (e) { logger.warn("...", e?.message); }`，沿用 `logger.warn` 生产可见的约定。
- **验收**：无空 catch 残留（有意为之者需带注释说明）。
- **风险**：低。注意日志脱敏，不要打印完整 URL（可能含签名 token）。

> **复核结论（2026-09-14）：计划列 3 个文件，实际 12 处；按"是否掩盖需人介入的故障"分两类处理，不是一律打日志。**
> - **补 `logger.warn`（4 处，关键路径）**：`result-cache.js` 读缓存失败（持续失败 = 缓存层不可用，会静默退化成每次全量重解析）/ 写缓存失败；直链探测异常（留痕才能区分"探测失败"与"真死链"）；`image/route.js` 非法 fallback 候选 —— **不打印 URL 本身**（可能带签名 token）。
> - **只补注释不打日志（8 处）**：`kuaishouCore.js` 的 5 个内层 catch + 3 处策略兜底……实际是 **9 个策略兜底**——快手页面结构多版本并存，代码就是"多条候选路径逐条试"，某条不适用属正常控制流；其中 `findVideoDataDeep` 在**递归**中执行，打日志会被放大成噪声风暴。`_diag/route.ts` 是"用完即删"的临时诊断端点，同理。
> - **内联脚本（`layout.tsx` 主题脚本 2 处）**：隐私模式下 `localStorage` / `matchMedia` 会直接抛异常，只能静默回退 `system`。这是浏览器端首屏前脚本，既无 logger 也不该在每次加载时打 warn，已在 JSX 注释写明"有意静默"，未改脚本字符串。
> - 判断口径：**静默是否掩盖了需要人介入的故障**——缓存层整体不可用、代理被喂非法参数要留痕；"这条路径不适用"是正常控制流，留注释即可。

## P3-5 文档去重与结构修正

- **问题**
  1. `CLAUDE.md` 第 10 行单段近 2000 字、第 56 行近 2500 字，与 `docs/ROADMAP.md`、`src/components/music/musicEngine.md` 三处描述高度重叠 → 易腐化。
  2. `CLAUDE.md:86` 约定「类型集中在 `src/types/`」，但 `src/types/` 实际只有 `api.ts`，音乐类型在 `components/music/types.ts`、平台类型在 `config/*.ts` → **文档已失真**。
- **动作**：`CLAUDE.md` 拆出 `docs/architecture.md`（目录约定、平台接入 SOP），`CLAUDE.md` 保留索引引用；随 P2-1 把类型归位后同步修正该约定表述。
- **验收**：文档与实际目录一致；`CLAUDE.md` 单段不超过 500 字。
- **风险**：低。

> **复核结论（2026-09-14）：已拆分，并补了原文没有的"平台接入 SOP"。**
> - `CLAUDE.md` 的架构大段（后端 / 音乐 / 前端 / 关键 lib，其中前端段近 2500 字）整体迁到新建的 **`docs/architecture.md`**，按「目录约定 / 后端 / 音乐链路 / 前端 / 关键 lib / 平台接入 SOP / 依赖须知」重组；`CLAUDE.md` 只留**三条红线**（走 `createApiHandler`、域名唯一真源、依赖方向单向）+ 索引，另加「文档地图」一行指向 README / API / 三份 docs。
> - **平台接入 SOP 是新写的**（原文没有这个内容）：6 步 —— 写解析器 → 注册 `PLATFORM_INFO` → 注册 `platformRoutes`（目录名不同则**还要**改 `ROUTE_DIR_ALIAS`）→ 前端 `video-platforms.ts` / 渲染组件 → 回归（单测 + live + `/api/engines`）→ 更新文档。把 P1-2 收敛后"域名唯一真源 + alias 两处都要改"这条坑固化成了硬步骤。
> - 修正失真约定：原 `CLAUDE.md:86`「类型集中在 `src/types/`」→ 实际只有**跨模块共享契约**在 `src/types/`（`api.ts` / `music.ts`），平台与前端展示配置类型在 `src/config/*.ts`，单文件类型就近声明。
> - 与 `docs/ROADMAP.md` 的职责边界写进各自开头：architecture 是"现在长什么样"，ROADMAP 是"接下来做什么"，REFACTOR-PLAN 是"代码质量怎么还债"。

## P3-6 测试目录 lint 卫生（P2-1 遗留，本条为补做时新增）

- **问题**：`tests/` 下 **114 个 eslint 错误**（`@ts-nocheck` 49 / `any` 59 / 未使用变量 6），但 `npm run lint`（`next lint` 默认目录）**不覆盖 tests**，于是「CI 全绿」与「手动 eslint tests 一片红」长期并存 —— 这是**口径不一致**，比错误本身更危险：会让人误以为仓库是干净的。
- **动作**：
  1. 真修那 6 个未使用导入（`parse-live.test.ts` 的 `beforeAll`、`music-caps.test.ts` 的 `setPlatformCapsForTest`、`music-effective-flags.test.ts` 的 4 个未使用常量）。
  2. 给 `tests/**` 加 override：`no-explicit-any` / `ban-ts-comment` 降级为 **warn**。理由：测试里的 mock / 桩 / 第三方响应形状天然依赖 `any` 与 `@ts-nocheck`，强行类型化会把样板放大数倍；**但保留为 warn** 以免彻底失明。
  3. `lint` 脚本改为 `next lint --dir src --dir tests`，把 tests 纳入默认口径。
- **验收**：`npm run lint` **0 error**（108 warnings 全在 tests，且均为上述两条被降级的规则）；全量 **1067 通过**。
- **风险**：低。未改动任何运行时代码；warn 不计入退出码，不会卡 CI。
- **为什么没有把 108 个 warn 也清零**：那需要给几十个文件补真实类型，改动面与回归风险都远超收益，且 `tsc --noEmit` 并不检查这些文件。留作 warn 是**可见的债**，不是藏起来的债。

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
