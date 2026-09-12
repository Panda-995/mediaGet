# 音乐平台设置面板设计

状态：已确认（待实现）
日期：2026-09-12
范围：音乐平台「搜索引擎 / 播放引擎」开关与「自动换源」行为配置的**部署级**在线配置面板（保存后全站所有访客生效）

---

## 1. 背景与目标

**现状**：平台引擎开关在部署期由环境变量决定——`src/lib/music-platform-flags.js` 读 `MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY`（正向覆盖）、`MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED`（维度黑名单）、`MUSIC_PLATFORM_OFF`（整体下线），算出的矩阵经 `/api/music/caps` 下发给前端过滤搜索源 chips。**改一次开关要改 env 并重新部署。**

**目标**：
- 音乐页内提供设置面板，查看 / 调整 6 个平台的 `search` + `play` 两维开关；
- 可配置「自动换源」行为（总开关、单轮尝试上限、跨音源现搜、人工选版面板）；
- 配置持久化并**全站生效**，无需重新部署；
- 保留部署侧紧急下线能力（env 终闸永远优先）；
- 存储不可用时优雅降级，**绝不阻塞听歌主流程**。

**非目标**：
- 不做用户级个性化偏好（本面板改的是全站配置）；
- 不做多管理员账号体系（单密钥）；
- 不改歌词 / 封面 / 图片等数据通道；不改 lx 脚本扩展源（非平台全集内，恒视为启用）。

## 2. 关键决策

| # | 决策 | 取舍说明 |
|---|---|---|
| D1 | 作用域 = 部署级真配置（全站生效） | 需持久化存储 + 管理鉴权；用户明确选择 |
| D2 | env 仍是**最终闸门** | 保留「改 env 一键下线某平台」的运维兜底；面板对锁定平台只读 |
| D3 | 持久化复用 `src/lib/turso-client.js` | 零依赖自实现客户端，Node / Docker / CF Workers / Vercel 四端行为一致 |
| D4 | 存储形态 = **单行全量 JSON 文档** | 一次读、一次写、无并发歧义，且「所见即所存」 |
| D5 | 求值 = **两段式**（有无文档） | 见 §4：env 正向覆盖只在「从未保存」时作为初始基线 |
| D6 | 被锁定槽位写 `null` | 避免「面板曾把锁定平台存成 `false`，运维解闸后仍关着且无人知晓」的陷阱 |
| D7 | 写入口 = `PUT /api/music/caps` | 复用前端既有 caps 拉取链路，零新增读通道，读写同源同契约 |
| D8 | 鉴权 = `SETTINGS_API_KEY` + Bearer | 与 `/api/stats` 同范式；未配置则写接口整体禁用 |
| D9 | 面板公开可看、写入需密钥 | 能力矩阵本就是公开数据；真正的闸门在写入侧 |
| D10 | 暂存 + 显式保存 | 写入全站生效且需密钥，逐项即时写会产生多次鉴权往返与多次全局抖动 |
| D11 | 「恢复部署基线」= 删除文档 | 而非回填基线的值（回填会把 env 基线冻结成新配置，失去「交还控制权」语义） |

## 3. 数据模型

### 3.1 表结构

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

幂等建表，范式照抄 `src/lib/analytics.js` 的 `ensureTable()`（`tableReady` Promise 单飞 + 失败允许重试）。

### 3.2 配置文档

`key = "music.flags"`，`value` 为如下 JSON 字符串：

```json
{
  "v": 1,
  "search": {
    "netease": true, "tencent": false, "kugou": true,
    "kuwo": true, "migu": true, "joox": true
  },
  "play": {
    "netease": true, "tencent": null, "kugou": true,
    "kuwo": true, "migu": false, "joox": true
  },
  "behavior": {
    "autoFallback": {
      "enabled": true,
      "maxAttempts": 4,
      "crossSearch": true,
      "showManualDialog": true
    }
  },
  "updatedAt": "2026-09-12T10:20:30.000Z"
}
```

字段语义：

| 字段 | 语义 |
|---|---|
| `v` | 文档版本，当前固定 `1`；供将来结构迁移 |
| `search` / `play` | 全量矩阵，**必须覆盖 `MUSIC_FLAG_PLATFORM_KEYS` 全部 6 个平台** |
| 槽位值 `true` / `false` | 面板显式设定的开关值 |
| 槽位值 `null` | 「交给部署决定」——该平台该维度被 env 终闸锁定，面板不可编辑 |
| `behavior.autoFallback.enabled` | 自动换源总开关 |
| `behavior.autoFallback.maxAttempts` | 单轮直链请求上限（整数 1–8） |
| `behavior.autoFallback.crossSearch` | 队列内无自动候选时是否跨音源现搜同名歌曲 |
| `behavior.autoFallback.showManualDialog` | 自动换源收尾仍失败时是否弹出人工选版面板 |
| `updatedAt` | 服务端生成的 ISO 8601，客户端传入值一律忽略 |

### 3.3 校验与规范化（`normalizeMusicSettingsDoc`）

写入侧**严格**校验（管理端写的是全量矩阵，静默丢弃会让「所见即所存」失真，必须显式报错）：

| 输入 | 规则 | 违规处理 |
|---|---|---|
| `search` / `play` | 必须为对象且覆盖全部 6 个平台键 | 400，msg 指明缺失键 |
| 槽位值 | `true` / `false` / `null` | 400，msg 指明非法键 |
| **被锁定槽位** | 服务端**强制规范化为 `null`** | 不报错，静默规范化（不信任客户端，也不给 UI bug 留陷阱） |
| `behavior.*` 三个开关 | boolean | 400 |
| `behavior.maxAttempts` | 整数且在 `[1, 8]` | 400 |
| `v` | 固定 `1`；仅读路径消费 | 读路径遇 `v ≠ 1` → 视同无法识别，回落基线 + `logger.warn`；写入忽略该字段（由服务端生成） |
| 未知顶层字段 | — | 忽略 |

`normalizeMusicSettingsDoc` 同时供**读路径**使用（宽松模式）：逐字段丢弃非法项、其余生效；整体 JSON 损坏 → 返回 `null`（视同无文档）。

## 4. 求值语义

```
【无配置文档】 内置默认 → env 正向覆盖（MUSIC_PLATFORM_SEARCH / _PLAY）→ env 终闸
【有配置文档】 文档全量矩阵                                                    → env 终闸
```

即 env 正向覆盖**只在从未保存过时起作用**，此时它充当「初始基线」；一旦保存过，它退化为历史种子。而 **env 终闸（`MUSIC_PLATFORM_OFF` ∪ `MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED`）永远压在最后**，这是不可让渡的运维能力。

现有 `resolveMusicPlatformFlags(kind)`（同构、同步）**恰好就是「无文档基线」**，原样保留不改语义。

```js
// src/lib/music-effective-flags.js —— 纯函数，仅服务端
export function resolveEffectiveMusicPlatformFlags({ kind, doc }) {
  const baseline = resolveMusicPlatformFlags(kind); // 默认 → env 正向 → env 终闸
  const stored = doc?.[kind];
  const table = {};
  for (const key of MUSIC_FLAG_PLATFORM_KEYS) {
    const v = stored?.[key];
    // null / 缺省 → 回落到基线（含 env 终闸结果）
    table[key] = v === true || v === false ? v : baseline[key];
  }
  // env 终闸最后再压一遍：文档里的 true 无法复活被运维下线的平台
  for (const key of lockedPlatformKeys(kind)) table[key] = false;
  return table;
}
```

行为配置取「文档值 ?? 内置默认」，逐字段独立回落（文档缺 `crossSearch` 时不影响 `enabled`）。

## 5. 后端设计

### 5.1 新增 / 改动模块

| 文件 | 性质 | 职责 |
|---|---|---|
| `src/lib/settings-store.js` | 新增，仅服务端 | 通用键值存储。**不知道音乐是什么**，只有 `isStoreAvailable()` / `readSetting(key)` / `writeSetting(key, value)` / `deleteSetting(key)`。内部：Turso 惰性连接 + 幂等建表 + 15s TTL 缓存 + 写后主动失效。未配置 / 超时 / 查询抛错一律返回 `null`，不抛错 |
| `src/lib/music-effective-flags.js` | 新增，仅服务端 | 分层求值纯函数 `resolveEffectiveMusicPlatformFlags`；async 入口 `loadEffectiveMusicFlags()`（读文档 → 求值 → 顺带算出 `locked` / `editable` / `blockedReason` / `behavior`）；`normalizeMusicSettingsDoc(raw, mode)` |
| `src/lib/music-platform-flags.js` | 改动，**保持同构 + 同步 + 零副作用** | ① 新增 `MUSIC_BEHAVIOR_DEFAULTS` / `MUSIC_BEHAVIOR_LIMITS`（前后端共用同一份默认）；② 新增 `lockedPlatformKeys(kind)`（纯读 env 算终闸锁定集合）；③ 现有判定函数增加**可选表参数**：`isMusicPlatformEnabled(kind, source, table?)` / `isPlatformSearchEnabled(source, table?)` / `isPlatformPlayEnabled(source, table?)` / `enabledPlatformList(kind, table?)`。**不传表时行为与现在完全一致** |

> 该文件被前端 `src/lib/music-caps.ts` import 取默认值，**不能被 async 污染**；所有 async 只出现在新增的服务端模块里。

### 5.2 端点契约

#### `GET /api/music/caps`（公开，契约向后兼容——只增字段）

```jsonc
{
  "code": 200, "msg": "ok",
  "data": {
    "defaults": { "search": {}, "play": {} },     // 不变：内置默认矩阵
    "flags":    { "search": {}, "play": {} },     // 生效矩阵（含文档覆写）
    "baseline": { "search": {}, "play": {} },     // 部署基线（无文档时的值）
    "platforms": [
      { "key": "netease", "search": true, "play": true,
        "selfSearch": true,
        "locked": { "search": false, "play": false } }
    ],
    "locked":   { "search": ["tencent"], "play": ["tencent"] },
    "overrides": { "search": {}, "play": {}, "behavior": {}, "updatedAt": "..." }, // 无文档时为 null
    "behavior": { "autoFallback": { "enabled": true, "maxAttempts": 4,
                                    "crossSearch": true, "showManualDialog": true } },
    "editable": true,
    "blockedReason": null   // "no-store" | "no-key" | null
  }
}
```

`editable = storeAvailable && writeKeyConfigured`；`blockedReason` 供面板精确横幅文案，两者同时不满足时**优先取 `"no-store"`**（存储缺失更根本——它决定读路径能否持久，而密钥缺失只挡写入）。

限流 / 黑名单 / 日志格式与现状一致，不变。

#### `PUT /api/music/caps`（管理写入）

- Header：`Authorization: Bearer <SETTINGS_API_KEY>`
- Body：`{ search, play, behavior }`（`v` / `updatedAt` 由服务端生成）

错误顺序与语义：

| 顺序 | 情形 | 状态码 | msg |
|---|---|---|---|
| 1 | 黑名单 IP 命中 | 403 | 与主接口一致 |
| 2 | `SETTINGS_API_KEY` 未配置 | 403 | 设置写入未启用 |
| 3 | Bearer 不匹配 | 401 | 未授权 |
| 4 | 超出 `rateLimit(clientIP)` | 429 | 请求过于频繁，请稍后再试 |
| 5 | 存储不可用（未配 Turso / 查询失败） | 503 | 未配置持久化存储，无法保存 |
| 6 | 校验失败（§3.3） | 400 | 指明具体字段 / 键 |

成功 200，`data` 与 `GET` **完全同构**（省一次往返，前端直接用来刷新）。写入后：本进程缓存立即失效 → `console.log` 一行审计（时间 / ip / 变更摘要）。

#### `DELETE /api/music/caps`（管理，恢复部署基线）

同一套鉴权；删除 `music.flags` 文档 → 失效缓存 → 返回与 `GET` 同构的 `data`。

**为什么写入口放 caps 而不是新端点**：前端已经有一条 caps 拉取链路（`music-caps.ts` 的 inflight 去重 + 默认回退 + 失败降级），复用它等于零新增读通道，读写同源同契约，面板改完能立刻对账生效结果。

### 5.3 消费点改造（关键：不让 async 传染）

统一模式：**路由入口取一次生效表 → 纯函数按表判定**。

| 文件 | 现状位置 | 改动 |
|---|---|---|
| `src/app/api/music/route.js` | `action=search` 校验（含 `supportedSources` 的 `.filter()` 回调）、取链校验 `MUSIC_FLAG_PLATFORM_KEYS.includes(source) && !isPlatformPlayEnabled(source)` | 入口 `await loadEffectiveMusicFlags()`，后续全部传表 |
| `src/app/api/music/self/route.js` | 取链校验、`enabledPlatformList("search")` 收窄、搜索校验 | 同上 |
| `src/app/api/music/resolve/route.js` | `handleEngineMissing` 分支里的 `isPlatformPlayEnabled(platform)` | 同上（该分支在请求内，取表后传入） |
| `src/app/api/music/caps/route.js` | `resolveMusicPlatformFlags("search"/"play")` | 改用 `loadEffectiveMusicFlags()`，并下发新增字段 |
| `src/lib/self-search/index.js` | `selfSearch()` 内 `isPlatformSearchEnabled(source)` 二次守卫 | **不改 async**：签名增加可选 `searchFlags`，缺省走 env 判定；调用方（当前为 `/api/music/self`）传入生效表 |

> 实施时需用 LSP 找全 `isPlatformSearchEnabled` / `isPlatformPlayEnabled` / `enabledPlatformList` / `selfSearch` 的**所有**调用点，逐个确认是否在服务端请求路径内。

### 5.4 缓存与传播

- 进程内 TTL **15s**；写入 / 删除后本进程立即失效。
- 读失败也写入**短 TTL（5s）空值缓存**，防止 Turso 抖动时每个请求都打网络。
- 多副本部署（Docker 多实例）下最坏 **15s** 才全量生效——配置类变更不需要强一致，此延迟可接受，需写入 README 说明，避免「改了怎么没立刻生效」的困惑。
- 每次 caps 请求至多引入 1 次额外 Turso HTTP（3s 超时，见 `turso-client.js`）。

## 6. 前端设计

### 6.1 入口

在音乐页 `.mp-tools` 内、`MusicViewSeg` 右侧加一个齿轮图标按钮（lucide `SlidersHorizontal`）：

```1250:1255:src/components/music/MusicExplorer.tsx
      <div className="mp-body">
        <main className="mp-main">
          <div className="mp-tools">
            <MusicViewSeg />
          </div>
```

只挂在 `/music`，**不进全站导航**，避免把管理入口散到首页与页脚。

### 6.2 弹层形态

自研弹层，复用 `TrackInfoDialog` 的视觉语言：`.mp-info-mask` 遮罩 + `.mp-info-card`（18px 圆角、`color-mix` 半透明底、22px 背景模糊、`0 24px 64px` 投影），宽 `min(560px, 100%)`；Esc / 点遮罩关闭；≤700px 全宽 + 内容区滚动。

**不引入 Radix Dialog**——仓库未安装，既有三个弹窗（`TrackInfoDialog` / `AltSelectDialog` / 信息卡）全部是自研 CSS，保持一致性。新增样式集中在 `src/app/music/music.css` 的 `.mp-settings-*`，沿用既有色系变量。

### 6.3 面板结构（三区块）

**A. 平台引擎**：6 行（平台）× 2 列（搜索引擎 / 播放引擎）开关矩阵。
- 行首复用 `src/components/music/platform-brand.ts` 的 logo + 展示名；
- 开关为自研 pill toggle（对齐 `.mp-*` 风格，不用 Radix Switch）；
- 锁定槽：开关灰态禁用 + 右侧「部署锁定」小标签，title 提示具体 env 名。

**B. 自动换源**：4 个控件——总开关 / 单轮尝试上限（数字步进 1–8，默认 4）/ 队列候选不足时跨音源现搜 / 全部失败后弹人工选版面板。

**C. 底部操作条**：`恢复部署基线`（次要）· `放弃` · `保存`（主，有改动才可用）。有改动时显示「N 项待保存」。

### 6.4 三态

| 状态 | 触发条件 | 表现 |
|---|---|---|
| 只读 | `editable === false` | 全部控件 disabled；顶部横幅按 `blockedReason`：「未配置持久化存储，开关不可修改」/「服务端未启用设置写入」；隐藏保存按钮 |
| 锁定项 | `locked[kind].includes(key)` | 该项 disabled + 「部署锁定」标签（`editable=true` 时也可能出现，两者独立） |
| 可编辑未解锁 | 无 sessionStorage 密钥 | 控件可交互；状态行「未解锁编辑」，主按钮文案「解锁并保存」 |

### 6.5 鉴权交互

- 点「解锁并保存」→ 底部操作条**内联展开**密钥输入框（不弹二层级，避免弹窗套弹窗）；
- 提交带 `Authorization: Bearer <输入值>`；
- 成功 → 密钥存 `sessionStorage`（key `mp-settings-key`，仅当前标签页，关掉即失效，**不落 localStorage**），状态行变「已解锁编辑」，后续保存免输入；
- 失败内联报错：401「密钥不正确」/ 403「服务端未启用设置写入」/ 503「未配置持久化存储，无法保存」；
- 另设「锁定编辑」按钮清除 sessionStorage 密钥。

### 6.6 保存模型

- 打开面板时以 `overrides ?? baseline` 填入草稿 state；
- 草稿与生效值 diff → 驱动「N 项待保存」与按钮可用态；
- `放弃` = 回填当前生效值；
- `保存` = PUT 全量 `{ search, play, behavior }`；锁定槽提交 `null`；
- `恢复部署基线` = DELETE（需密钥，走同一套解锁交互）；成功后 `overrides` 变 `null`，面板回填 `baseline`；
- 成功后用响应 `data` 就地刷新面板 + `setPlatformCaps()`（触发 chips / 跨源候选重算）+ 失效 `music-caps` 模块缓存。

### 6.7 自动换源接线（`src/components/music/use-player-engine.ts`）

| 现状 | 改为 |
|---|---|
| `const MAX_AUTO_ALT_ATTEMPTS = 4`（:99） | 调用时读 `getMusicBehavior().autoFallback.maxAttempts` |
| `runAutoFallback()` 无总开关（:467） | 入口即 `if (!enabled) return;`；resolve 阶段与媒体错误阶段的**调用点**同样前置判断，关闭时直接走既有错误文案 |
| `suggestCrossCandidates` 无条件触发（:485-491） | 前置 `crossSearch` 判断；关闭时跳过现搜，直接处理队列候选 |
| `setAlternatives(pool)` 无条件暴露候选（:497） | 前置 `showManualDialog` 判断；关闭时不暴露候选，仅保留最终 `setPlayError` 文案 |

读取时机：在 `runAutoFallback` / 调用点入口各读一次（同轮内不重复读，避免配置漂移）。该值**不参与 React 渲染**，零重渲染代价。

### 6.8 前端文件清单

| 文件 | 性质 |
|---|---|
| `src/components/music/use-music-settings.ts` | 新增：草稿 diff / 提交 / 密钥管理 / 错误态逻辑 |
| `src/components/music/MusicSettingsPanel.tsx` | 新增：弹层 UI（纯渲染 + 事件透传） |
| `src/components/music/MusicExplorer.tsx` | 改动：齿轮入口 + 弹层挂载 + 保存后刷新 `platformCaps` |
| `src/lib/music-caps.ts` | 改动：`behavior` 生效值 + `getMusicBehavior()` + `refreshPlatformCaps({ force })`（force 绕过 inflight 去重） |
| `src/components/music/use-player-engine.ts` | 改动：见 §6.7 |
| `src/app/music/music.css` | 改动：`.mp-settings-*` 样式 |

## 7. 错误处理与降级

**总原则：读路径永不拖垮听歌。**

| 情形 | 读路径 | 写路径 |
|---|---|---|
| Turso 未配置 | 回落部署基线；`editable=false`；`blockedReason="no-store"` | 503 |
| 查询超时 / 网络失败 | 回落基线 + `logger.warn`；短 TTL 空值缓存 | 503 |
| 文档 JSON 损坏 | 视同无文档、回落基线 + `logger.warn`（**不抛错**） | — |
| 文档字段非法 | 逐字段丢弃非法项、其余生效 | 400（写入侧严格） |
| `SETTINGS_API_KEY` 未配置 | 读不受影响 | 403 |
| 密钥错误 | — | 401 |

## 8. 安全

- 密钥只经 `Authorization` 头传输（HTTPS），前端存 `sessionStorage`，不落 `localStorage`、不写日志 / URL / 错误文案。
- 等值比较沿用 `/api/stats` 范式；接口受 `rateLimit(clientIP)` 约束，密钥为高熵随机串，不额外做常数时间比较。
- 失败不泄露额外信息：403 只表示「接口未启用」，与密钥取值无关。
- PUT / DELETE 成功后各记一行审计日志（服务端时间 / ip / 变更摘要）。

## 9. 测试策略

| 类型 | 文件 | 覆盖内容 |
|---|---|---|
| 单测 | `tests/settings-store.test.ts` | 注入假 client：TTL 命中 / 失效、写后失效、未配置降级 `null`、查询抛错降级、删除 |
| 单测 | `tests/music-effective-flags.test.ts` | 两段式求值（无文档=env 基线；有文档=全量覆盖；**env 终闸压过文档**；锁定槽恒 `false`）；`locked` / `editable` / `blockedReason` 计算；文档损坏 / 字段非法容错；behavior 逐字段回落 |
| 单测 | `tests/music-settings-panel.test.ts` | 草稿 diff 计数；锁定槽提交 `null`；`maxAttempts` 范围校验；`normalizeMusicSettingsDoc` 严格/宽松两模式 |
| 回归 | 现有 `tests/*`（如 `self-route.test.ts`） | 全靠「不传表时行为不变」的默认参数，目标零改动；若有改动需显式说明 |
| 手工 | — | 面板三态；锁定平台灰显；保存后全站生效；「恢复部署基线」；未配 Turso 环境降级；未配 KEY 时 403 |

## 10. 实施顺序

| 阶段 | 内容 | 可验证信号 |
|---|---|---|
| **S1 底座** | `settings-store.js` + `music-effective-flags.js` + `music-platform-flags.js` 加可选表参数 + 单测 | 单测全绿；不传表时现有行为零变化 |
| **S2 生效链路** | caps 端点改造（GET 增补字段 / PUT / DELETE）+ 四个消费点改 `await` 取表 + README 补 `SETTINGS_API_KEY` | `curl` 可读可写；改开关后 `/api/music?action=url` 立即按新配置拒绝 / 放行 |
| **S3 面板 UI** | `use-music-settings.ts` + `MusicSettingsPanel.tsx` + 齿轮入口 + `music-caps` 扩展 + 播放引擎接线 | 面板三态可用；保存后 chips 与自动换源行为同步变化 |

S1 → S2 是硬依赖；S3 依赖 S2 的契约。

## 11. 风险与备注

- **误操作影响面**：面板改的是全站配置，任何改动影响所有访客 → 靠「显式保存 + 放弃 + 恢复部署基线 + 审计日志」四件套兜底。
- **多副本传播延迟**：最坏 15s（§5.4），需在 README 注明。
- **无乐观锁**：两人同时编辑会后者覆盖前者。当前单管理员场景可接受，将来若需要再加 `updatedAt` 版本校验。
- **`music-platform-flags.js` 改动面**：该文件被前端与服务端共同消费，加可选表参数时必须保证不传表时行为逐位不变——这是本轮最大的回归风险点，由单测兜住。
- **README 需补**：`SETTINGS_API_KEY`（新）、以及「面板 vs env 的优先级关系」说明段落。
- 部署后需手动触发部署 workflow 上线（同历史行为）。

## 12. 验收清单

- [ ] 未保存过时，生效矩阵与现有 env 行为**逐位一致**（零回归）
- [ ] 面板保存后全站生效（换浏览器 / 隐身窗口验证），无需重新部署
- [ ] 平台开关矩阵 6×2 可调；被 env 终闸锁定的槽位灰显「部署锁定」且无法开启
- [ ] `MUSIC_PLATFORM_OFF` 列出的平台，即便文档里为 `true` 也仍被强制关闭
- [ ] 自动换源 4 项配置均生效（尤其 `maxAttempts` 与 `showManualDialog`）
- [ ] 「恢复部署基线」删除文档后，面板回到 env 基线
- [ ] 未配置 Turso → 面板只读 + 明确提示，听歌功能不受影响；PUT 返回 503
- [ ] 未配置 `SETTINGS_API_KEY` → PUT/DELETE 返回 403，GET 不受影响
- [ ] 密钥错误返回 401 且面板内联报错，不泄露额外信息
- [ ] 文档 JSON 损坏时服务端回落基线并告警，不抛错、不阻塞听歌
- [ ] 新增单测通过；现有测试零回归（`npm test`）
