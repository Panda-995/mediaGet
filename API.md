# API 文档

短视频解析 + 音乐解析服务 API 文档

## 基础信息

- **Base URL**: `https://get.hotier.cc.cd` 或本地 `http://localhost:3000`
- **响应格式**: JSON
- **跨域支持**: 所有接口均支持 CORS

## 通用响应格式

### 成功响应
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": { ... },
  "platform": "douyin"
}
```

### 统一响应模型

所有平台的**成功响应**（`code` 恒为 `200`）在出口统一归一化，`data` 遵循同一套字段契约，前端与调用方只需消费以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 标题 |
| `desc` | string | 描述 |
| `author` | string | 作者昵称 |
| `authorId` | string | 作者 ID |
| `avatar` | string | 作者头像 |
| `cover` | string | 封面图 |
| `url` | string | 主媒体直链（视频/音乐/单图） |
| `audioUrl` | string | 音频直链（背景音乐/原声） |
| `images` | string[] | 图集（图文内容） |
| `type` | string | 内容类型：`video` / `image` |
| `duration` | number | 视频时长（毫秒） |
| `videos` | array | 多分P/多清晰度列表（bilibili） |
| `name` / `lyrics` / `core` / `copyright` | string | 音乐类扩展字段（汽水音乐） |

> 兼容说明：归一化**保留**各平台原始字段（如快手的 `photoUrl`、`caption` 等），同时新增上述统一字段，外部旧调用方不受影响。
>
> 历史变更：此前 bilibili 成功返回 `code: 1`、字段散落在顶层（`title`/`imgurl`/`user`）且 `data` 为分P数组——现已统一为 `code: 200` + 顶层字段移入 `data` + 分P 列表放入 `data.videos`。
>
> 补充：bilibili 归一化后 `data.url` 已补齐为第一分P直链，统一契约下消费方无需再取 `data.videos[0].url`。

### 纯文本模式（fmt=text）

适用于 iOS 快捷指令等轻量调用方，免去 JSON 解析。在任意解析接口 URL 后追加 `&fmt=text`：

- **成功**：返回两行纯文本 `标题\n直链`（直链优先级：`data.url` → `data.videos[0].url`（B 站）→ `data.images[0]`（小红书图文））
- **失败**：返回错误信息文本

**示例**：
```
GET /api/parse?url=https://v.douyin.com/xxx/&fmt=text
```
```
视频标题
https://v.douyin.com/xxxx/xxx.mp4
```

### 错误响应
```json
{
  "code": 400,
  "msg": "错误描述信息"
}
```

### 状态码说明

| 状态码 | 含义 |
|--------|------|
| 200 | 解析成功 |
| 400 | 请求参数错误或解析失败 |
| 429 | 请求过于频繁（含 IP 级限流与平台级上游节流，见「限制说明」） |
| 500 | 服务器内部错误 |

---

## API 接口

### 0. 统一解析入口（推荐）

**接口**: `GET /api/parse`（**同时支持 `POST`**：body 为 JSON `{"url"|"text": "…"}` 或表单 `url=/text=…`，用于超长分享文案，不受 GET URL 长度限制）

**说明**: 自动识别链接所属平台并调用对应解析器，所有平台共用这一个接口。**新调用方推荐统一使用 `url=` 一个参数**：纯分享链接与整段分享文案（分享码）均可直接传入，服务端自动提取文案中的链接（提取逻辑与前端共用）；`text=` 是同一能力的「严格面孔」（仅收文案、提取失败报错更明确），作为兼容别名保留（见 0.1），新调用方无需区分两者。分享链接被好友/他人再次打开时，24 小时内直接命中共享缓存（Cloudflare Cache API，跨实例共享），不会全量重新解析；缓存命中后还会探测主直链，明确死链自动重新解析，避免拿到过期直链。

**参数**（`url`、`text`、`source+id` 任选其一）:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 方式1（推荐） | **全场景通用**：任意平台分享链接，或直接粘贴整段分享文案（分享码，如「【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …」），服务端自动识别平台并提取文案中的链接（提取逻辑与前端共用） |
| text | string | 方式1b（兼容别名） | 仅接收整段分享文案（含标题/引导语），提取其中第一个 http(s) 链接。解析行为与 `url=` 传文案一致，差别仅在提取失败时返回精确的「未能从分享文案中提取到有效链接」；沿用旧 `/api/parse-text` 语义的调用方使用即可 |
| source + id | string | 方式2 | 平台名 + 视频 ID（仅部分平台支持，见下方响应） |

**示例请求**:
```
# 方式1（推荐）：url= 一个参数全场景通用——纯链接或整段分享码均可
GET /api/parse?url=https://v.douyin.com/kB9dI20w7vk/
GET /api/parse?url=https://www.bilibili.com/video/BV1xx411c7mD
GET /api/parse?url=【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …
GET /api/parse?source=douyin&id=7212345678901234567

# 兼容别名（可选）：text= 仅收整段分享文案，语义更严格
GET /api/parse?text=【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …

# 超长分享码走 POST（JSON 或表单均可；body 的 url=/text= 均支持）
POST /api/parse
Content-Type: application/json
{"url": "【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …"}
```

**响应**: 与各平台专用接口一致（`code: 200` + 统一 `data` 字段契约）。

**注意**:
- 付费/DRM 平台（腾讯视频、爱奇艺、优酷、Netflix 等）会直接返回 `400` 并提示不支持，不消耗解析流量
- 支持 `&fmt=text` 纯文本模式（见上文「纯文本模式」）
- 并发保护：同一链接同时被多人打开时只真实抓取一次，其余请求复用同一次解析（进程内，缓存之外的补充）
- `url` / `text` / `source+id` 均缺失时返回 `400`，并附 `usage`（各调用方式示例）与 `supportedPlatforms`（支持 ID 解析的平台列表）

---

### 0.1 分享文案解析（兼容别名）

**接口**: `GET /api/parse-text`（也支持 `POST`，JSON body: `{"text": "…"}` 或表单 `text=…`）

**说明**: 文案解析的**兼容别名**——与 `/api/parse` 共用同一份实现（`src/lib/parse-handler.js`），只接收 `text=` 整段分享文案（含标题、引导语）并提取其中第一个 http(s) 链接，平台识别、解析、缓存、直链验证、限流等行为与 `/api/parse` 完全一致。**新调用方请直接使用 `/api/parse`**，推荐统一传 `url=`（一个参数覆盖纯链接与整段分享文案）；本入口保留给既有调用方（如 iOS 快捷指令）与偏好严格 `text=` 语义的场景。提取逻辑与前端共用同一份实现（`src/lib/share-text.ts`），保证网页表单与 API 行为一致。

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | string | 是 | 整段分享文案，如「【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …」，服务端自动提取其中链接 |

**示例请求**:
```
GET /api/parse-text?text=【这个视频太有意思了】复制打开抖音，看看 https://v.douyin.com/xxx/ 的作品
GET /api/parse-text?text=https://v.kuaishou.com/Ku1rFvu1 你的新版奶爸来了唷…该作品在快手被播放过49.6万次，点击链接，打开【快手】直接观看！
POST /api/parse-text
Content-Type: application/json
{"text": "【标题】…复制打开抖音，看看 https://v.douyin.com/xxx/ …"}
```

**响应**: 与 `/api/parse` 一致（`code: 200` + 统一 `data` 字段契约；提取不到链接返回 `400`）。同样支持 `&fmt=text` 纯文本模式、共享缓存与并发保护。

---

### 0.2 各平台专用接口一览

除统一入口 `/api/parse` 外，各平台保留独立直连接口 `GET /api/{platform}?url=<分享链接>`，响应与统一入口一致（`code: 200` + 归一化 `data` 契约）。以下为当前实际注册的完整清单：

| 路径 | 平台 | 备注 |
|------|------|------|
| `/api/douyin` | 抖音 | 见 §1 |
| `/api/bilibili` | 哔哩哔哩 | 见 §2（另含 `/api/bilibili/opus` 图文动态） |
| `/api/kuaishou` | 快手 | 见 §3 |
| `/api/weibo` | 微博 | 见 §4（自动游客模式） |
| `/api/xhs` | 小红书 | 见 §5（视频 / 图文） |
| `/api/qsmusic` | 汽水音乐 | 见 §6（音乐类，返回音频直链） |
| `/api/pipigx` | 皮皮搞笑 | 见 §7 |
| `/api/ppxia` | 皮皮虾 | 见 §8 |
| `/api/xigua` | 西瓜视频 | — |
| `/api/zuiyou` | 最右 | — |
| `/api/huya` | 虎牙 | — |
| `/api/acfun` | AcFun | — |
| `/api/quanminkge` | 全民K歌 | 音乐类，返回音频直链 |
| `/api/sixroom` | 六间房 | — |
| `/api/xinpianchang` | 新片场 | — |
| `/api/haokan` | 好看视频 | — |
| `/api/qqmusic` | QQ音乐 | 音乐类，返回音频直链 |
| `/api/tiktok` | TikTok | 依赖 yt-dlp（child_process），仅 Docker / Node 环境可用 |
| `/api/twitter` | X（Twitter） | — |
| `/api/instagram` | Instagram | 2024+ 匿名请求被登录墙拦截，建议配 `IG_COOKIE` |
| `/api/youtube` | YouTube | 多源 HTTP 解析；源不可用时降级官方嵌入播放（`embedOnly`，无直链） |

> 平台 key 与目录名不完全一致：小红书 key=`redbook`（目录 `/api/xhs`）、皮皮虾 key=`pipixia`（目录 `/api/ppxia`）；统一入口为推荐入口，专用直连接口仅供既有调用方使用。

---

### 1. 抖音视频解析

**接口**: `GET /api/douyin`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 抖音视频链接 |

**支持的链接格式**:
- `https://v.douyin.com/xxx/`
- `https://www.iesdouyin.com/share/video/xxx/`
- `https://www.douyin.com/video/xxx`

**示例请求**:
```
GET /api/douyin?url=https://v.douyin.com/kB9dI20w7vk/
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "platform": "douyin",
  "data": {
    "author": "作者昵称",
    "uid": "用户ID",
    "avatar": "头像URL",
    "like": 12345,
    "time": 1703980800,
    "title": "视频标题",
    "cover": "封面URL",
    "url": "视频播放地址",
    "music": {
      "author": "音乐作者",
      "avatar": "音乐封面"
    }
  }
}
```

---

### 2. 哔哩哔哩视频解析

**接口**: `GET /api/bilibili`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 哔哩哔哩视频链接 |

**支持的链接格式**:
- `https://b23.tv/xxx`
- `https://www.bilibili.com/video/BVxxx`
- `https://m.bilibili.com/video/BVxxx`
- `https://www.bilibili.com/opus/<id>` / `https://m.bilibili.com/opus/<id>`（图文动态，返回 `type: "image"` + `images[]`；专栏文章等非纯图文会返回错误提示）

**示例请求**:
```
GET /api/bilibili?url=https://b23.tv/abcDEFg
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功！",
  "platform": "bilibili",
  "data": {
    "title": "视频标题",
    "desc": "视频描述",
    "cover": "封面URL",
    "author": "UP主名称",
    "avatar": "UP主头像",
    "videos": [
      {
        "title": "P1",
        "url": "视频播放地址",
        "duration": 180,
        "durationFormat": "00:02:59",
        "accept": ["高清 1080P+", "高清 720P"]
      }
    ]
  }
}
```

> 注：已统一为 `code: 200`；分P 列表在 `data.videos`，作者信息在 `data.author` / `data.avatar`。

**图文动态响应补充**：图文动态为纯图片内容，无 `videos`/`url`；图片直链在 `data.images`（原图，已统一 https），`data.cover` 为首图，`data.desc` 为动态文案，`data.type` 为 `"image"`。前端展示为图集卡片并支持一键下载全部图片。

> 注：图文动态解析内部使用现代浏览器 User-Agent 访问 detail 接口——旧 UA 会被 B 站风控拦截（`-352`），该实现细节与接口可用性相关，调用方无需自行处理。

---

### 3. 快手视频解析

**接口**: `GET /api/kuaishou`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 快手视频链接 |

**支持的链接格式**:
- `https://v.kuaishou.com/xxx`
- `https://www.kuaishou.com/short-video/xxx`
- `https://www.kuaishou.com/photo/xxx`

**示例请求**:
```
GET /api/kuaishou?url=https://v.kuaishou.com/abcdEF
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "platform": "kuaishou",
  "data": {
    "url": "视频播放地址",
    "title": "视频标题",
    "cover": "封面URL",
    "author": "作者名称"
  }
}
```

> 注：已统一为 `url` / `title` / `cover` / `author` 字段契约（原始 `photoUrl` / `caption` / `coverUrl` / `authorName` 字段仍保留）。

---

### 4. 微博视频解析

**接口**: `GET /api/weibo`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 微博视频链接 |

**支持的链接格式**:
- `https://weibo.com/tv/show/xxx`
- `https://video.weibo.com/show?fid=xxx`

**示例请求**:
```
GET /api/weibo?url=https://weibo.com/tv/show/1034:4912345678901234
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": {
    "author": "作者名称",
    "avatar": "头像URL",
    "time": "发布时间",
    "title": "视频标题",
    "cover": "封面URL",
    "url": "视频播放地址"
  }
}
```

---

### 5. 小红书内容解析

**接口**: `GET /api/xhs`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 小红书内容链接 |

**支持的链接格式**:
- `https://www.xiaohongshu.com/explore/xxx`
- `http://xhslink.com/xxx`

**示例请求**:
```
GET /api/xhs?url=https://www.xiaohongshu.com/explore/66f8f8f8f8f8f8f8f8f8f8f8
```

**响应示例 (视频)**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": {
    "author": "作者昵称",
    "authorID": "用户ID",
    "title": "内容标题",
    "desc": "内容描述",
    "avatar": "头像URL",
    "cover": "封面URL",
    "url": "视频播放地址",
    "type": "video"
  }
}
```

**响应示例 (图片)**:
```json
{
  "code": 200,
  "msg": "解析成功",
  "data": {
    "author": "作者昵称",
    "authorID": "用户ID",
    "title": "内容标题",
    "desc": "内容描述",
    "avatar": "头像URL",
    "cover": "封面URL",
    "images": ["图片1URL", "图片2URL"],
    "type": "image"
  }
}
```

---

### 6. 汽水音乐解析

**接口**: `GET /api/qsmusic`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 汽水音乐链接 |

**示例请求**:
```
GET /api/qsmusic?url=https://music.douyin.com/qishui/share/track?track_id=xxx
```

---

### 7. 皮皮搞笑视频解析

**接口**: `GET /api/pipigx`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 皮皮搞笑视频链接 |

---

### 8. 皮皮虾视频解析

**接口**: `GET /api/ppxia`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 皮皮虾视频链接 |

---

### 9. 健康检查

**接口**: `GET /api/health`

**说明**: 用于监控服务状态

**示例请求**:
```
GET /api/health
```

**响应示例**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "responseTime": 5
}
```

---

## 10. 解析行为统计

**接口**: `GET /api/stats`

**鉴权**: 需携带 `Authorization: Bearer <STATS_API_KEY>`；未配置 `STATS_API_KEY` 时返回 `403`。

**说明**: 返回所有解析记录（**成功与失败**）的分析结果——平台分布（含失败数）、近 14 天每日解析量、总量/成功/失败/独立访客（IP 匿名哈希）/独立链接数。数据由 `createApiHandler` 在每次解析结束（成功或失败）时异步写入 Turso（`parse_events` 表，`status` 区分 `success`/`failed`，`reason` 记录失败原因）。

**响应示例**:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "totals": { "total": 120, "success": 100, "failed": 20, "users": 34, "unique_links": 88 },
    "byPlatform": [
      { "platform": "douyin", "total": 50, "success": 45, "failed": 5 }
    ],
    "byDay": [
      { "day": "2024-01-01", "total": 10, "success": 8, "failed": 2 }
    ]
  }
}
```

> 提示：`failed` 数高的平台说明当前解析成功率偏低或存在未支持的内容类型，可针对性优化（查看失败 `reason` 需直接查询数据库 `parse_events` 表）。

---

## 11. 功能开关配置

**接口**: `GET /api/config`

**说明**: 返回客户端功能开关（供小程序等客户端远程读取）。当前主要用于小程序审核：`videoParseEnabled` 为 `false` 时客户端隐藏视频解析入口，审核通过后将环境变量 `VIDEO_PARSE_ENABLED` 设为 `"true"` 重新部署即可放开（未配置时默认关闭）。响应禁止缓存（`Cache-Control: no-store`），开关改动实时生效。

**响应示例**（默认，解析入口隐藏）:
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "videoParseEnabled": false
  }
}
```

---

## 12. 通用音乐获取（多音乐源聚合）

**接口**: `GET /api/music`

**说明**: 多音乐源聚合接口（默认上游 music-api.gdstudio.xyz，覆盖网易云/酷我/JOOX/QQ音乐等曲库）。通过 `action` 分流**四种**能力，适合「搜歌 → 试听/下载 → 封面 → 歌词」一体化流程；`url` / `pic` 分支另支持 `bin=1` 直接返回文件字节（见下文）：

> **部署环境注意（Vercel/海外机房）**：默认公共上游对数据中心/海外出口会返回 Cloudflare 人机校验页，导致本接口在 Vercel 等云函数环境恒 502（本机 dev 因走家用宽带而正常）。服务端已在各分支对该情况记 warn 日志并把风控页归类为 `502 sources-down`（不再把校验页当歌词/封面）。
>
> 上游支持**多基址回退链**：环境变量 `MUSIC_API_BASES`（逗号/空白分隔，按序）或单基址 `MUSIC_API_BASE` 覆盖默认公共实例；每类上游请求按序尝试，主源网络异常 / HTTP 错误 / CF 风控页时自动切换下一个基址（业务级 `rejected` / `not-found` 不回退），总耗时受 8s 预算约束并均分到剩余基址。注意：接入基址必须同为 gdstudio 契约（`types=search/url/pic/lyric` 参数一致）且对该部署出口可达——实测不可达的地址只会拖慢失败；可用线上请求日志 `music … all bases down … reason=` 定位不可用的基址。若基址均不可达，最终仍回落到 `502 sources-down`，前端 `music-client.ts` 随即走浏览器直连兜底（用户民用网络不受数据中心出口拦截影响）。

> 若 GD 代理与浏览器直连通道均不可用，`netease`/`kuwo` 的搜索会自动回退到**自研直连搜索通道**（`/api/music/self`）；此外 `tencent`/`kugou`/`migu` 在 GD 未开放搜索，作为内置自研搜索源 chips 直接走该通道（见 12.4）。
>
> **内置播放引擎总开关（部署可配，2026-09）**：除平台二维矩阵外，另有**独立于平台矩阵的第四维总开关**——「内置播放引擎」= 站点自带取直链通道（GD 公共上游 `/api/music` + 自研直连 `/api/music/self`）的总闸。**关闭后**：站点不再经上述内置通道取任何试听直链，`/api/music?action=url` 与 `/api/music/self?action=url` 一律 400 `source-unavailable`（文案含开启指引）、`/api/music/resolve` 识别成功但回 `engine-missing`、前端跨源现搜候选剔除全部内置源、内置取链请求一律被拒（`requestPlayDirect` 报「内置播放引擎当前已停用…」）；**搜索维度完全不受影响**（`action=search`、歌词 / 封面 / 链接识别等数据通道照常）。真源同为 `src/lib/music-platform-flags.js`，env `MUSIC_BUILTIN_PLAY`（`off` = **运维终闸**，配置文档无法复活、设置页显示「部署锁定」；`on` / 留空 / `default` = 基线开启，面板可自由开关），也可在设置页 `/music/settings` 直接改（写入文档字段 `builtinPlay`，`null` = 被终闸锁定）；状态经 `/api/music/caps` 的 `builtinPlay: { enabled, locked }` 下发（见 12.6）。
>
> **平台能力开关（部署可配，2026-09）**：对面向用户的 6 平台（`netease`/`tencent`/`kugou`/`kuwo`/`migu`/`joox`）维护二维开关——`search`（搜索引擎）与 `play`（播放引擎 = 取直链通道）。后端唯一真源 `src/lib/music-platform-flags.js`，可用 env `MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY` 正向覆盖，或用 `MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` 黑名单按平台列表强制停用（另有 `MUSIC_PLATFORM_OFF` 便捷变量把平台整体下线 = 同时写入两个黑名单；最终闸门，格式见「环境变量配置」）。默认值（2026-09 起）：`search` / `play` 两维均 6 平台全开（此前为 `search` 停 `tencent`、`play` 停 `tencent`/`kugou`/`migu`）。注意**开关放开 ≠ 取链必然可用**：tencent 的 GD 取链上游不开放（实测 400）、migu 无内置直链引擎，取链失败回业务报错；需要收敛时用 env 黑名单 / `MUSIC_PLATFORM_OFF` 或设置面板单独停用。开关关闭 = 前端不展示该源 chip / 候选，后端 `action=search` / `action=url` 拒绝并回 400 `source-unavailable`（`supportedSources` 随开关过滤，文案含开启指引）；歌词 / 封面 / 链接识别等数据通道不受约束；GD-only 源不在全集内，恒视为启用。生效矩阵经 `/api/music/caps` 下发前端（见 12.6）。除 env 外还可在音乐页齿轮进入的独立设置页 `/music/settings`（登录鉴权，见 12.6）里直接改（写入 Turso 配置文档 `music.flags`，需配 `SETTINGS_API_KEY`，改完全站生效无需重新部署；env 禁用黑名单仍是压在最后的终闸，被锁定的平台在设置页上显示「部署锁定」）。面板同时可调**自动换源**四项行为：总开关、单轮直链尝试上限（队列候选 + 跨源现搜合计，1–8，默认 4）、跨音源现搜、失败后弹人工选版面板（默认均开启）。

| action | 能力 | 适用场景 |
|--------|------|----------|
| `url`（默认） | 按「音乐源 + 曲目ID」取播放直链 | 已持有曲目 ID 的调用方 |
| `search` | 按歌名/歌手搜歌，支持服务端分页 | 前端关键词搜索 |
| `pic` | 用 search 结果里的 `pic_id` 换专辑封面直链 | 播放器显示封面 |
| `lyric` | 按曲目 ID（`id`/`lyric_id`）取歌词 | 播放器滚动歌词 |

共用参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | string | 选填 | 音乐源，默认 `netease`。可选：`netease`、`tencent`、`kuwo`、`tidal`、`qobuz`、`joox`、`bilibili`、`apple`、`ytmusic`、`spotify`（部分源暂未开放） |
| action | string | 选填 | `url` / `search` / `pic` / `lyric`，默认 `url` |
| fmt | string | 选填 | `text` 时返回纯文本（仅 `url`/`pic` 有效，成功为直链一行；搜索恒为 JSON） |
| bin | string | 选填 | `1` 时：`url` 分支命中直链后服务端字节代理下载（`Content-Disposition: attachment`，文件名带音质标签、扩展名跟随上游 Content-Type）；`pic` 分支返回封面图片字节（同源取色用，带 5 分钟缓存）。不与 `fmt=text` 组合 |

### 12.1 `action=url`：取播放直链

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 曲目 ID（即 track_id），不同源取值规则不同，可通过 `action=search` 获得 |
| br | string | 选填 | 音质，默认 `999`。可选 `128`、`192`、`320`、`740`（16bit 无损）、`999`（24bit 无损） |

> `track_id` 可作为 `id` 的兼容别名传入。参数白名单在入口先校验（source 需在可选项、br 需在可选值内），减少无效上游流量。

**示例请求**:
```
GET /api/music?source=netease&id=347230&br=128
GET /api/music?source=kuwo&id=777777&br=320
GET /api/music?source=netease&id=347230&br=999&fmt=text
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "获取成功",
  "data": {
    "url": "https://m701.music.126.net/20260908114356/xxx.mp3",
    "br": 128,
    "size": 5217010,
    "source": "netease",
    "id": "347230"
  }
}
```

> 说明：`data.br` 为上游实际返回的音质；`data.size` 为文件大小（**实测单位为字节**，与上游文档标注的 KB 不符，此处原样透传不做换算）。

### 12.2 `action=search`：关键词搜歌（服务端分页）

搜索源仅开放 `netease` / `kuwo` / `joox` 三家，其余 source 返回 400。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyword | string | 是 | 搜索关键词（歌名/歌手），空返回 400 |
| count | string | 选填 | 每页条数，默认 `20`，最大 `20` |
| page | string | 选填 | 页码，默认 `1`，最大 `20` |

分页语义：`netease` / `kuwo` 支持按 `count`/`page` 逐页翻；`joox` 实测无视分页、首屏整页返回（约 30 条）。因此响应带 `hasMore` 由后端判定——仅「实回条数回满请求数且未到页码上限」为 `true`，joox 整页超量时自动判为无更多，前端无需感知各源差异，按 `hasMore` 决定是否展示「加载更多」即可。

**示例请求**:
```
GET /api/music?action=search&source=netease&keyword=晴天&count=20&page=1
GET /api/music?action=search&source=kuwo&keyword=晴天&count=20&page=2
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "搜索成功",
  "data": {
    "source": "netease",
    "keyword": "晴天",
    "page": 1,
    "hasMore": true,
    "count": 20,
    "line": {
      "kind": "proxy",
      "base": "https://music-api.gdstudio.xyz/api.php"
    },
    "items": [
      {
        "id": "2652820720",
        "urlId": "2652820720",
        "picId": "109951173569626660",
        "name": "晴天",
        "artist": ["周杰伦"],
        "album": "叶惠美",
        "source": "netease"
      }
    ]
  }
}
```

> 字段说明：`urlId` 为请求直链应使用的 ID（个别源与 `id` 不一致）；`picId` 为专辑封面 id，需经 `action=pic` 二次换取真实图片 URL（无专辑歌曲可能为空串）。`line` 标记本页结果取回的通道与上游实例：`kind=proxy` 表示经本站同源代理（命中 `MUSIC_API_BASES`/`MUSIC_API_BASE` 中的哪个基址由 `base` 给出，多基址链下每页可能不同），浏览器端在代理不可用时还会用直连通道兜底（此时由前端自行标注 `kind=direct`，指向公共 GD 源）。

### 12.3 `action=pic`：专辑封面换取

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | `action=search` 结果里的 `picId`（封面 id，非曲目 id） |
| size | string | 选填 | `300`（默认）/ `500`，其他值回落 300 |

**示例请求**:
```
GET /api/music?action=pic&source=netease&id=109951173569626660&size=300
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "获取成功",
  "data": {
    "url": "https://p2.music.126.net/xxx/109951173569626660.jpg?param=300y300",
    "source": "netease",
    "id": "109951173569626660",
    "size": 300
  }
}
```

> 封面 URL 统一升级为 https（酷我等图床原生返回 http，但其 CDN 支持 TLS），避免线上 https 页面 mixed-content 被浏览器拦截。

**`action=lyric`（获取歌词）**：参数同直链（`source` + `id`，兼容 `lyric_id` 别名），返回 `data.lyric`（LRC 时间轴或纯文本；上游直接返回 LRC 纯文本时原样透传）。歌词接口没有 `fmt=text` 形态。

> `bin=1` 仅作用于 `url` / `pic` 分支：`url` 命中直链后不回 JSON，改为服务端字节代理下载（`attachment`，文件名自动带上音质标签，如「曲名 - 无损音质·24bit.flac」）；`pic` 分支返回封面图片字节，用于浏览器端 `<canvas>` 取色（规避第三方图床无 CORS 导致画布污染）。
>
> `url` 的 `bin=1` 有两条硬约束（都是踩过的坑）：
> - **命中直链缓存也要真的去源站取字节**。缓存里存的是解析结果 JSON，直接回它等于把 JSON 当文件下发——前端 `<a download>` 会把这段 JSON 存成 `.json` 文件（「能播放却下载成 JSON」就是这么来的：播放过 = 已缓存 = 必命中）。
> - **只下发音频字节**。上游返回非音频（`application/json` 风控 / 过期提示 / `text/html` 校验页）或 HTTP 非 2xx 时，一律回 `502 sources-down` 的 JSON，**不带** `Content-Disposition`；同时失效该直链缓存，避免 TTL 内反复复用死链。

**失败分类**（各 action 通用，响应带 `failType` 便于程序判断）:

| 状态码 | failType | 场景 |
|--------|----------|------|
| 400 | - | 参数非法：`source` 不在白名单 / `br` 不在可选值 / `id` 缺失 / 搜索 `keyword` 为空 / `pic` 缺 `id` |
| 400 | `source-unavailable` | source 在上游侧被拒（暂未开放/不可用）；搜索源未开放；或该平台 `search` / `play` 开关被部署侧关闭（两维默认全开；可用 `MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_PLAY_DISABLED` / `MUSIC_PLATFORM_OFF` 或设置面板停用，文案含指引）；或该请求命中**内置播放引擎总开关**关闭（`MUSIC_BUILTIN_PLAY=off` / 设置页关闭，`action=url` 一律拦截、`supportedSources` 为空数组，文案含开启指引；`action=search` / `lyric` / `pic` 不受影响） |
| 404 | `not-found` | 直链：曲目不存在或该源无可用音源；封面：pic_id 无效或无专辑封面 |
| 502 | `sources-down` | 上游接口网络异常 / 响应无法解析 |

---

### 12.4 自研直连搜索（补充搜索源，仅 `search`）

**接口**: `GET /api/music/self`（`runtime=nodejs`）

**说明**: 服务端直连各大音源搜索 API 的补充通道（签名 / 请求构造为代码内自研实现，移植自 lx-music 的 musicSdk），用于补上 GD 通道搜索能力的缺口。`source` 键沿用 GD 通道命名，支持 `netease` / `tencent` / `kugou` / `kuwo` / `migu`。搜索结果与 `/api/music` 的 `action=search` 对齐统一契约，播放 / 歌词 / 封面不在此接口（仍走既有 GD 通道 / 自研直连取链）。

该通道承载两类用途：
1. **独立搜索源 chips（tencent / kugou / migu）**：GD 未开放这三家搜索（kugou/migu 连直链引擎也没有），前端把三家注册为内置搜索源 chip 直接走本通道；
2. **双通道源（netease / kuwo）的搜索主通道**：netease / kuwo 的搜索以本通道为主；自研通道失败时前端才回退 GD 搜索引擎（同源代理 → 浏览器直连），并把该源会话置位——后续翻页直接走 GD，不再每次空转本通道。

> 各源是否可被调用还受平台能力矩阵的 `search` 开关约束（见 12 开头；默认 6 平台全开）：开关关闭的源即使实现存在也不展示 chip、不接受请求——返回 400 `source-unavailable`（文案含「可配置 MUSIC_PLATFORM_SEARCH 开启」），响应 `supportedSources` 只列出当前放开的源。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | string | 选填 | 仅支持 `search`（默认），其余返回 400 |
| source | string | 是 | `netease` / `tencent` / `kugou` / `kuwo` / `migu`（不在白名单返回 400，响应带 `supportedSources` 目录） |
| keyword | string | 是 | 搜索关键词（歌名/歌手），也兼容 `name` 别名，空返回 400 |
| count | string | 选填 | 每页条数，默认 `20`，最大 `30` |
| page | string | 选填 | 页码，默认 `1`，上限 `50`（平台翻页价值有限，防御空转） |

**示例请求**:
```
GET /api/music/self?action=search&source=tencent&keyword=晴天&count=20&page=1
GET /api/music/self?source=kugou&keyword=晴天
```

**响应示例**:
```json
{
  "code": 200,
  "msg": "搜索成功",
  "data": {
    "source": "tencent",
    "keyword": "晴天",
    "page": 1,
    "hasMore": false,
    "count": 20,
    "total": 20,
    "line": { "kind": "self", "base": "self-search" },
    "items": [
      {
        "id": "0039MnYb0qxYhV",
        "urlId": "0039MnYb0qxYhV",
        "lyricId": "0039MnYb0qxYhV",
        "name": "晴天",
        "artist": ["周杰伦"],
        "album": "叶惠美",
        "source": "tencent",
        "picUrlDirect": "https://y.qq.com/music/photo_new/T002R300x300M000xxx.jpg"
      }
    ]
  }
}
```

> 字段说明：`hasMore` 由服务端判定（有 total 的平台按 `page*count < total` 精确算，缺失时按「回满整页且未到页码上限」兜底）；`line.kind=self` 标注这是自研直连通道的产物（区别于 GD 的 `proxy` / 浏览器直连的 `direct`）。封面**不强求**：能随搜索响应直接携带的图床 URL 写入 `picUrlDirect` 供前端直接展示（跳过 GD 式 `pic_id` 二次换取），没有则缺省该字段、前端兜底占位封面；任何情况下不会为拿封面额外打一次搜索源接口。

各源产物与其直链通道的衔接关系：

| source | 自研搜索结果 id 语义 | 播放 / 歌词 / 封面 |
|--------|----------------------|---------------------|
| `tencent` | `id=urlId=lyricId=songmid` | 复用 GD `tencent` 通道（songmid 直链） |
| `netease` | 网易云曲目 id | 复用 GD `netease` 通道 |
| `kuwo` | 酷我 rid | 复用 GD `kuwo` 通道 |
| `kugou` | `id`=酷狗 audio_id / hash（`urlId`=hash） | 自研直连取链（`/api/music/self?action=url`）：官方免费试听 128k mp3，VIP/付费曲回 `vip-only` |
| `migu` | 咪咕 songId（`urlId` 为空） | 无内置直链引擎，**仅搜索展示** |

> kugou 已内置官方免费试听直链（`/api/music/self?action=url` → 官方 `getSongInfo`，免费档 128k mp3，VIP/付费曲回 `failType=vip-only`）；migu 无内置直链引擎：默认只能展示搜索结果（封面不强求即源于此），前端点播 / 切音质给出明确提示「该音源暂未接入试听直链引擎；可切到网易云/QQ/酷我等音源搜索同一首歌」，不会把请求空打到 GD 上游。

**失败分类**:

| 状态码 | failType | 场景 |
|--------|----------|------|
| 400 | - | 参数非法：`action` 非 `search` / `source` 不在白名单（响应带 `supportedSources`）/ `keyword` 为空 |
| 400 | `source-unavailable` | source 不在自研搜索白名单，或该平台搜索引擎开关被部署侧停用（默认全开；`MUSIC_PLATFORM_SEARCH_DISABLED` / `MUSIC_PLATFORM_OFF` / 设置面板可停用；文案含开启指引）；`action=url` 另受**内置播放引擎总开关**（`MUSIC_BUILTIN_PLAY` / 设置页）与 `MUSIC_PLATFORM_PLAY` 约束，关闭时同样回此态；`action=search` 不受二者影响 |
| 502 | `sources-down` | 该源搜索接口网络异常 / 响应无法解析 / 命中平台风控 |

> 成功结果走进程内存 5 分钟缓存（与主接口一致），IP 级限流 / 黑名单拦截与主接口同策略。

### 12.5 音乐「链接解析」

**接口**: `GET /api/music/resolve?link=<歌曲分享链接或整段分享文本>`

**说明**: 解决「已知歌曲链接 → 归一曲目（`source` + `id` + 元数据）」的问题，与 `/api/music`（解决「关键词搜索 → 直链」）互补。输入先做平台识别与曲目 ID 提取（纯函数，**不直接请求用户链接**，SSRF 面收敛到白名单短链域；官方分享短链如 `163cn.tv` / `c.y.qq.com` 由服务端跟随一次重定向后再识别）。解析产物为标准 SearchItem，播放 / 下载仍走既有 `/api/music` 直链链路（含代理 / 直连降级、`bin=1` 下载、歌词、封面）。

| 状态 | 说明 |
|------|------|
| `playable` | 网易云 / QQ音乐 / 酷我歌曲已识别并补齐元数据：`data { status, platform, songId, metadata: "full"\|"fallback", item }`。`metadata="full"` 表示官方详情成功取回（封面为图床直链 `item.picUrlDirect`）；详情通道失败不致命，自动降级为 ID 占位标题，仍可播放 / 下载 |
| `engine-missing` | 已识别为酷狗歌曲（直链引擎尚未接入）；QQ音乐（`tencent`）在部署侧停用播放引擎时同样回此态（默认放开 `MUSIC_PLATFORM_PLAY` 即回 `playable`）；**内置播放引擎总开关关闭时任意平台均回此态**（`MUSIC_BUILTIN_PLAY=off` / 设置页关闭，优先于平台级播放开关判定，文案含 `MUSIC_BUILTIN_PLAY`）：`data { status, platform, songId, message }`，`message` 含开关指引 |
| HTTP 400 | 无法识别（非歌曲详情页链接，如歌单 / 歌手主页 / 视频页 / 未知 host），响应带 `supported: { ready: ["netease", "tencent", "kuwo"], pending: ["kugou"] }` |

> 受支持链接示例：`https://music.163.com/song?id=347230`、`https://y.qq.com/n/ryqq/songDetail/<songmid>`、`https://www.kuwo.cn/play_detail/<rid>`、`163cn.tv` 分享短链、整段分享文案（自动抽链）。直链引擎 = 官方元数据通道 + GD 直链通道的组合（QQ 以 songmid、酷我以 rid 走 GD `action=url`，但受该平台 `play` 播放引擎开关约束），网易云详情走官方 song/detail；三平台详情成功时各自缓存 5 分钟，直链不在本接口预取，由播放端按 `id` 实时请求。

### 12.6 平台能力矩阵与设置写入

**接口**（`runtime=nodejs`，音乐页齿轮跳转的专用设置页 `/music/settings` 即调用本组接口）:

| 方法与路径 | 鉴权 | 用途 |
|---|---|---|
| `GET /api/music/caps` | 无（公开） | 下发生效矩阵 + 面板所需的 `baseline` / `overrides` / `locked` / `behavior` / `editable`（前端 `src/lib/music-caps.ts` 启动时拉取） |
| `PUT /api/music/caps` | `Authorization: Bearer <SETTINGS_API_KEY>` 或登录会话 Cookie | 保存配置文档（全量矩阵 + 自动换源行为） |
| `DELETE /api/music/caps` | 同上 | 删除配置文档，恢复部署基线 |
| `POST /api/music/settings/session` | body `{ key }`（即 `SETTINGS_API_KEY`） | 设置页登录：校验密钥后下发 httpOnly 会话 Cookie（HMAC 签名令牌，见 `lib/music-settings-auth.js`） |
| `GET /api/music/settings/session` | 无 | 查询当前会话：`{ authenticated, configured }` |
| `DELETE /api/music/settings/session` | 无 | 退出登录（清除会话 Cookie） |

**页面路由与鉴权**：设置页为独立路由 `/music/settings`（`src/app/music/settings/page.tsx`），服务端读取会话 Cookie 校验，无有效会话即 `redirect` 到 `/music/settings/login?next=/music/settings`；登录页校验已登录则跳回 `next`（仅允许 `/music/settings` 前缀，防开放重定向）。会话令牌 = `<exp>.<hmac-sha256>`，签名密钥优先 `SETTINGS_SESSION_SECRET`、回落 `SETTINGS_API_KEY`，有效期 12h（改密钥即让全部会话失效）。

**说明**: 下发「平台搜索引擎 / 播放引擎」的生效矩阵（env `MUSIC_PLATFORM_SEARCH` / `MUSIC_PLATFORM_PLAY` 合并内置默认后的结果）与**内置播放引擎总开关**（`builtinPlay: { enabled, locked }`：站点自带取直链通道 GD / 自研直连的总闸，独立于平台矩阵；关闭后前端跨源候选剔除内置源、内置取链请求一律被拒，搜索不受影响），供前端首帧过滤 chips / 聚合候选源，保证部署侧开关与 UI 一致。前端在请求到达前先按与后端同值的内置默认矩阵渲染，拉取成功后再按覆盖结果刷新（失败静默保留默认）。

**求值（两段式）**：无配置文档时 = 内置默认 → env 正向覆盖 → env 禁用黑名单（终闸）；有配置文档时 = 文档全量矩阵 → env 禁用黑名单（终闸）。**env 终闸始终压在最后**，为不可让渡的运维紧急下线能力：被终闸锁定的平台槽位在文档里恒存 `null`（面板显示「部署锁定」且不可编辑）。**内置播放引擎总开关**独立求值：env 终闸（`MUSIC_BUILTIN_PLAY=off`）→ 文档 `builtinPlay`（布尔值）→ 部署基线（默认开启）；被终闸锁定时文档值恒规范化为 `null`。

**存储**：配置文档存于 Turso `app_settings` 表（key = `music.flags`，单行 JSON），进程内 TTL 15s 缓存 + 写后立即失效；多副本部署下最坏 15s 传播延迟。

**响应示例**:（字段示意，截取 6 平台中的两行；实际 `search`/`play` 与 `platforms` 均含全部 6 平台键）
```json
{
  "code": 200,
  "msg": "ok",
  "data": {
    "defaults": { "search": { "netease": true, "tencent": false }, "play": { "netease": true, "tencent": false } },
    "flags": { "search": { "netease": true, "tencent": false }, "play": { "netease": true, "tencent": false } },
    "baseline": { "search": { "netease": true, "tencent": false }, "play": { "netease": true, "tencent": false } },
    "platforms": [
      { "key": "netease", "search": true, "play": true, "selfSearch": true, "locked": { "search": false, "play": false } },
      { "key": "tencent", "search": false, "play": false, "selfSearch": true, "locked": { "search": false, "play": false } }
    ],
    "locked": { "search": [], "play": ["migu"] },
    "overrides": { "search": { "tencent": true }, "play": { "migu": null }, "behavior": { "autoFallback": { "enabled": true, "maxAttempts": 6, "crossSearch": true, "showManualDialog": true } } },
    "behavior": { "autoFallback": { "enabled": true, "maxAttempts": 6, "crossSearch": true, "showManualDialog": true } },
    "builtinPlay": { "enabled": true, "locked": false },
    "editable": true,
    "blockedReason": null,
    "storeAvailable": true,
    "writeKeyConfigured": true
  }
}
```

PUT 请求体（`behavior.autoFallback` 四项均可选，`maxAttempts` 需为 `1..8` 的整数；平台槽位 `null` = 不写入该槽，被锁定的槽位服务端强制存 `null`；`builtinPlay` 为布尔值，`null` / 缺省 = 不写入（回部署基线），被 env 终闸锁定时服务端强制存 `null`）：
```json
{
  "search": { "netease": true, "tencent": true, "kugou": true, "kuwo": true, "migu": true, "joox": true },
  "play": { "netease": true, "tencent": false, "kugou": true, "kuwo": true, "migu": null, "joox": true },
  "builtinPlay": true,
  "behavior": { "autoFallback": { "enabled": true, "maxAttempts": 6, "crossSearch": true, "showManualDialog": true } }
}
```

**写入状态码**：`401` 密钥 / 会话不正确（`POST /api/music/settings/session` 登录失败同此）；`403` 未配置 `SETTINGS_API_KEY`（写入与登录均不可用）；`400` body 不合法（如 `maxAttempts` 越界）；`429` 触发 IP 限流；`503` 持久化不可用：未配置 Turso，**或已配置但写入失败**（连不上 / 超时——`msg` 带真实原因，如 `持久化存储写入失败：Turso 请求超时（>8000ms）`）；`200` 成功，`data` 与 GET 同构（省一次往返）。设置页保存走会话 Cookie（同源自动携带，无 Bearer），会话失效（过期 / 轮换密钥）时写入回 `401`，前端跳回登录页。

> `defaults` 为内置默认矩阵，`baseline` 为 env 层面（默认 + 正向覆盖 + 终闸）的结果，`flags` 为叠加配置文档后的最终生效矩阵（三者相等即未配置任何覆盖）；`overrides` 为配置文档原文（无文档 = `null`）；`locked` 为被 env 终闸锁定的平台键；`editable = 存储可用 && SETTINGS_API_KEY 已配置`，不可写时 `blockedReason` 为 `no-store`（优先，更根本）或 `no-key`。`behavior.autoFallback` 供播放引擎消费自动换源四项配置。`builtinPlay` 为「内置播放引擎」总开关的生效值 / 锁定态（`locked=true` 表示被 env `MUSIC_BUILTIN_PLAY=off` 终闸锁定，面板不可开启）。`platforms` 面向 UI 逐平台展开，`selfSearch` 标注该平台是否存在自研直连搜索实现。仅面向用户的 6 平台（`netease`/`tencent`/`kugou`/`kuwo`/`migu`/`joox`）在此矩阵内；GD-only 源不在此列，恒视为启用。`storeAvailable` / `storeError` / `writeKeyConfigured` 为设置页「运行状态」区块的只读诊断字段：`storeAvailable` **只代表 env 是否配置**（配置 ≠ 连得上，对应的只是 `blockedReason=no-store` 的判定），`storeError` 为 Turso 最近一次故障原因（`null` / 缺省 = 正常，成功一次即清空，例如 `Turso 请求超时（>8000ms）`），`writeKeyConfigured` 对应 `SETTINGS_API_KEY`；三者合起来既能区分 `no-store` 与 `no-key`，也能把「未配置」与「配了但连不上」分开。

> 设置页（`/music/settings`）共五个区块：A 平台引擎（6×2 矩阵；**内置播放引擎总开关**关闭时 6 个播放开关整体呈从属停用态，槽位存储值不变，重新开启即恢复，此时区块标题挂「内置播放已停用」提示）· B 自动换源四项 · C 内置播放引擎（**总开关**）· D 运行状态（存储 / 写入密钥 / 配置来源）· E 底部操作条。

> 降级语义：存储不可用 / 文档损坏时，**读路径**回落 env 基线继续供曲（绝不因面板不可用阻塞听歌），只有**写路径**返回 `503`。故障原因由 `getStoreStatus()` 记录并随 `storeError` / 503 的 `msg` 透出（如 `Turso 请求超时（>8000ms）`），以区分「未配置」与「连不上」。Turso 单次请求超时默认 **8000ms**，可用 `TURSO_HTTP_TIMEOUT_MS`（夹在 500~60000）调整：跨境链路或经代理访问 `turso.io` 时握手常需 1~3s，超时过紧会把「网络慢」误报成「存储不可用」，表现为读静默回落基线 + 写 503。

### 12.7 音乐域共享缓存（候选 / 降级负缓存 / 失败黑名单 / 源健康度 / 官方详情）

**接口**（`runtime=nodejs`，旁路缓存通道：把「哪些版本能播」这类全站共享的事实从进程内存提到共享库）:

| 方法与路径 | 用途 |
|---|---|
| `GET /api/music/cache?kind=<candidate\|negative\|fail\|health\|detail>&key=<key>` | 读一条缓存：`data { value, stored, store }`；`value=null` = 无该条（不是错误） |
| `POST /api/music/cache` | 旁路上报，body `{ events: [...] }`（1~20 条），逐条独立成败 |

**事件类型**:

| type | 必填字段 | 写入时机 | TTL |
|---|---|---|---|
| `candidate` | `key`（歌曲身份 = 归一化歌名+歌手）、`items[{source,id,album?}]` | **仅真实播放成功**（`<audio>` 出声）才写；服务端**合并写**（新成功在前、按 `source:id` 去重、上限 20 条） | 7 天 |
| `negative` | `key`（同 `candidate` 口径的歌曲身份）、`reason`（`no-candidate` / `all-attempts-failed`，缺省 `no-candidate`） | **降级负缓存**：换源轮以 fail/manual 收尾、层① 一条可用候选都没给出、且本轮**真跑过**跨源现搜时才写；命中即让同曲在 TTL 内跳过整轮现搜（跳过现搜的轮次不写，避免 TTL 被无限续期） | 10min（设计口径 5–10min，取上界） |
| `fail` | `key`（`source:id`）、`source`、`id`、`reason`、可选 `lookupKey` | resolve / 媒体层 / 音质档失败；带 `lookupKey` 时**同时**给候选缓存里的同版本打 `failUntil`（读侧据此本地过滤） | `transient` 2min、`sources-down` 30min、`not-found` 30 天 |
| `health` | `source`、`ok`、`stage`、可选 `ms` / `msg` | 每次 resolve / play / quality 的结果；服务端累加 `failStreak`（成功归零） | 24h |

**示例请求**:
```
GET /api/music/cache?kind=candidate&key=%E6%99%B4%E5%A4%A9%7C%E5%91%A8%E6%9D%B0%E4%BC%A6

POST /api/music/cache
{ "events": [
  { "type": "candidate", "key": "晴天|周杰伦", "items": [{ "source": "kugou", "id": "hash", "album": "叶惠美" }] },
  { "type": "negative", "key": "冷门歌|某歌手", "reason": "no-candidate" },
  { "type": "fail", "key": "netease:123", "lookupKey": "晴天|周杰伦", "source": "netease", "id": "123", "reason": "not-found" },
  { "type": "health", "source": "kuwo", "ok": false, "stage": "resolve", "ms": 3210, "msg": "上游超时" } ] }
```

**响应示例**（POST）:
```json
{ "code": 200, "msg": "ok", "data": { "accepted": 3, "written": 2, "store": "turso", "errors": [] } }
```

**失败分类**:

| 状态码 | 场景 |
|---|---|
| 400 | `kind` / `key` 非法（GET）、`events` 非 1~20 条数组（POST）、单条事件字段校验不通过（写入 `errors` 前 5 条，其余事件照常处理） |
| 429 | IP 限流（与其它音乐端点同策略） |
| 200 | **包含存储未配置 / 写入失败**：`store:"unavailable"`、`written` 相应减少——旁路上报绝不 5xx |

**说明**: 单表 KV `music_cache`（`kind` 命名空间 + `cache_key` 主键 + `payload` + `expires_at`，与 `app_settings` 同库）。五类数据各自的服务端读写点：候选 / 负缓存 / 黑名单 / 健康度由本接口承载，**官方详情**由 `/api/music/resolve` 内部读写（进程内 5min → 共享 30 天 → 上游，覆盖网易云 / QQ / 酷我 / 酷狗四平台）。降级语义与 12.6 一致：未配置 Turso / 连接失败一律静默跳过（读侧按「无缓存」继续，绝不阻断播放）；过期清理无定时任务，读时判 `expires_at`、写时每 50 次顺手清一批。浏览器侧客户端 `src/lib/music-remote-cache.ts` 负责合并窗口（1.2s 或满 20 条）+ `keepalive` 上报，且只在真实播放成功时写候选。**层③ 与层④ 的分工**：`fail` 挡的是「某个 `source:id` 不可播」的解析成本，`negative` 挡的是「连一轮跨源现搜都不必发」的搜索成本——因此 `negative` 命中只跳过现搜，队列内近似候选与共享候选（两个 0 成本来源）照常尝试，手动搜索也不受影响。

---

## 限制说明

### 速率限制
- **IP 级**：每个 IP 每分钟最多 **60** 次请求（单次解析会触发多次上游请求，故阈值较高），超出返回 `429`（msg 为「请求过于频繁」）
- **平台级（上游抓取保护）**：每个平台每分钟最多 **30** 次「真实抓取」——只统计缓存未命中的解析，缓存命中不消耗配额；同一链接的并发请求共享一次配额。超出返回 `429`（msg 为「该平台解析请求较多」）。目的：把对目标平台（抖音/快手/B 站等）的请求频率压在不触发其风控的区间，保护服务出口 IP

### 缓存机制
- **统一入口 `/api/parse`**：成功解析的结果缓存 **24 小时**（Cloudflare Cache API，跨实例共享），好友/他人再打开同一分享链接时直接返回缓存结果，不再全量重新解析；命中时服务端会先探测主直链，明确死链（404/410，如抖音签名直链过期）自动重新解析并回写，避免拿到过期直链打不开
- **平台专用接口**（`/api/douyin` 等）：进程内存缓存 **5 分钟**（单实例内有效）
- **并发去重**：同一链接在解析进行中被多人同时请求时，只真实抓取一次，其余请求复用同一次解析（与缓存互补：缓存针对「已完成」的解析，去重针对「进行中」的解析）
- 失败结果不缓存（可能是瞬时反爬），相同链接立即重试解析

### 环境变量配置

如需完整功能，需配置以下环境变量：

```env
# 抖音（可选）：匿名 ttwid + UA 轮询为主链路；配置登录 Cookie 仅作增强
# （连续 5 次命中风控时日志会打出「DOUYIN_COOKIE 疑似失效」告警，成功解析自动复位）
# UA 已改为代码内轮询，不存在 DOUYIN_USER_AGENT 变量
DOUYIN_COOKIE=your_cookie

# 哔哩哔哩
# BILIBILI_COOKIE 强烈建议配置：服务器为数据中心/海外出口时，匿名请求会被 B 站 WAF
# 风控（-412/-352，表现为解析失败）。填入浏览器登录态的完整 Cookie（必含 SESSDATA）
# 即可穿透，且登录态下 B 站基本不拦数据中心 IP。
# 获取：浏览器登录 bilibili.com（务必勾选「记住我」，有效期可达一年以上，到期才需
# 再配一次）→ F12 → Application → Cookies → https://www.bilibili.com →
# 复制全部 Cookie 字符串作为该环境变量值。
# 失效自检（低维护）：Cookie 过期后服务会自动降级并告警——连续 5 次带 Cookie 请求
# 仍被风控时日志打出「BILIBILI_COOKIE 疑似失效」，任一次成功解析自动复位；解析失败
# 的提示文案也会区分「服务器 Cookie 失效」与「临时风控」，便于定位是换 Cookie 还是重试。
BILIBILI_COOKIE=your_cookie
BILIBILI_USER_AGENT=your_user_agent

# 微博：自动游客模式，无需配置 Cookie（WEIBO_COOKIE 已废弃，勿再配置）

# 小红书（可选）：数据中心 / 海外出口被风控时，配置登录 Cookie 可稳定解析
# XHS_COOKIE=your_cookie

# Instagram（可选但强烈建议）：匿名请求已全面登录墙，需配置登录态 Cookie 才可稳定解析
# IG_COOKIE=your_cookie
# IG_TIMEOUT_MS=20000

# QQ音乐 source+id 解析（可选）：登录 Cookie 可降低 vkey 试听接口风控
# QQMUSIC_COOKIE=your_cookie

# X/Twitter 解析（可选）：逗号分隔的 fxTwitter / fixupx / vxtwitter 等 fixer 服务，覆盖默认集
# TWITTER_FIXER_SERVICES=https://api.fxtwitter.com,...

# YouTube（可选）：官方 Data API v3 密钥仅作优先元数据源（无直链）；Piped / Invidious 为
# 直链解析源，可指向自托管实例覆盖默认集（Invidious 默认不启用）
# YOUTUBE_API_KEY=your_key
# YOUTUBE_PIPED_HOSTS=https://piped.example.com,...
# YOUTUBE_INVIDIOUS_HOSTS=https://inv.example.com,...
# YOUTUBE_API_TIMEOUT_MS=5000
# YOUTUBE_SOURCE_TIMEOUT_MS=6000

# 音乐聚合上游（/api/music，GD 契约）：MUSIC_API_BASES（逗号 / 空白分隔，按序回退）
# 优先于单基址 MUSIC_API_BASE；不配置时默认公共实例 music-api.gdstudio.xyz
# MUSIC_API_BASE=https://your-gd-api.example.com/api.php
# MUSIC_API_BASES=https://a.example.com/api.php, https://b.example.com/api.php

# 平台能力矩阵（/api/music、/api/music/self、/api/music/resolve 生效，见 12）：
# 二维开关分别约束各平台的 search（搜索引擎）与 play（播放引擎=取直链）。
# 取值：留空 / "default" → 内置默认（search / play 两维均 6 平台全开）；
#   "all" → 6 平台全开；JSON 对象 → 部分覆盖（未列平台保持当前值），如
#   MUSIC_PLATFORM_SEARCH={"netease":false,"tencent":true}
# 非法值忽略并告警（回退默认）。生效矩阵经 /api/music/caps 下发前端。
# MUSIC_PLATFORM_SEARCH=
# MUSIC_PLATFORM_PLAY=
# 另有禁用黑名单 *_DISABLED（逗号分隔平台键，最终闸门，优先级最高——可压过上述
# "all" / JSON 覆盖；留空 / "default" 回退内置默认），如：
# MUSIC_PLATFORM_SEARCH_DISABLED=tencent
# MUSIC_PLATFORM_PLAY_DISABLED=tencent,kugou,migu
# 整体下线便捷变量 MUSIC_PLATFORM_OFF（逗号分隔平台键，最终闸门）——等效于把列出的平台
# 同时写进上面两个黑名单（search/play 一并强制关），供「整体下线某平台」时只配一个变量：
# MUSIC_PLATFORM_OFF=tencent,kugou,migu

# 内置播放引擎总开关（第四维，独立于上面的平台矩阵，见 12）：
# 内置播放引擎 = 站点自带取直链通道（GD 公共上游 /api/music + 自研直连 /api/music/self）。
# 关闭后不再经内置通道取试听直链（action=url 一律 400 source-unavailable）；
# 搜索 / 歌词 / 封面 / 链接识别等数据通道不受影响。
# 取值：留空 / "default" / "on" → 基线开启（设置页可自由开关）；
#   "off"（也接受 false / 0 / disabled）= 运维终闸：强制关闭且配置文档无法复活，
#   设置页显示「部署锁定」不可再开启；非法值忽略并告警（回退默认开启）。
# 状态经 /api/music/caps 的 builtinPlay:{enabled,locked} 下发前端。
# MUSIC_BUILTIN_PLAY=off

# 自研直连搜索（/api/music/self）：代码内直连实现（签名/deviceId 等自研构造），
# 覆盖 netease/kuwo/tencent/kugou/migu 五家（netease/kuwo 为搜索主通道，GD 搜索引擎
# 仅兜底；tencent/kugou/migu 为独立搜索源 chips）。某平台是否可被搜索仍受上述
# MUSIC_PLATFORM_SEARCH 开关约束（默认 6 平台全开，无需额外配置）。

# 解析行为统计（Turso/libsql；未配置时记录功能自动禁用）
# 同一个库还被音乐域复用：app_settings（平台引擎设置文档）与 music_cache
# （候选 / 失败黑名单 / 源健康度 / 官方详情，见 12.7），未配置时同样静默跳过。
TURSO_DB_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_token
# 可选：Turso 单次请求超时（ms，默认 8000，夹在 500~60000）
# 跨境链路 / 经代理访问 turso.io 慢时放宽；过紧会把「网络慢」误报成「存储不可用」
TURSO_HTTP_TIMEOUT_MS=8000
STATS_API_KEY=your_stats_key

# 平台引擎设置写入密钥（音乐页齿轮 → /music/settings 设置页；见 12.6）：
# 未配置时 GET /api/music/caps 仍可读，但 editable=false（blockedReason=no-key），
# 设置页显示只读横幅且不出现保存按钮，且无法登录（403）；
# 配置后设置页用该密钥登录换会话 Cookie，PUT / DELETE 亦支持 Bearer 该密钥。
# 与 STATS_API_KEY 相互独立，建议用不同的随机串。
# SETTINGS_API_KEY=your_settings_key
# 可选：设置页会话令牌签名密钥（缺省回落 SETTINGS_API_KEY）；
# 轮换它等价于让全部已登录会话立即失效。
# SETTINGS_SESSION_SECRET=your_session_secret

# 功能开关：视频解析入口（/api/config 读取；仅值为 "true" 时放开，未配置默认关闭）
# VIDEO_PARSE_ENABLED=true
```

> Cloudflare Workers 部署时：`BILIBILI_USER_AGENT` 已写入 `wrangler.toml` 的 `[vars]`；Cookie 类敏感值在 CI 中由 GitHub Secrets 自动 `wrangler secret put` 注入，无需手动配置。

---

## 错误处理

### 常见错误

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| url为空 | 未传入 url 参数 | 检查请求参数 |
| 无效的URL格式 | URL 格式错误 | 检查链接是否完整 |
| 请求过于频繁 | 当前 IP 超出速率限制 | 等待后重试 |
| 该平台解析请求较多 | 平台级上游节流触发（该平台 1 分钟内真实抓取超过 30 次） | 稍等片刻再试；如持续触发请反馈，可能需要调高配额 |
| 解析失败 | 平台接口变化或内容不可用 | 检查链接是否有效 |
| 服务器错误 | 服务器内部异常 | 稍后重试或联系管理员 |

---

## 使用示例

### JavaScript/TypeScript

```javascript
// 抖音解析示例
const response = await fetch('/api/douyin?url=' + encodeURIComponent('https://v.douyin.com/xxx/'));
const data = await response.json();

if (data.code === 200) {
  console.log('视频地址:', data.data.url);
} else {
  console.error('解析失败:', data.msg);
}
```

### cURL

```bash
# 抖音解析
curl "https://get.hotier.cc.cd/api/douyin?url=https://v.douyin.com/xxx/"

# 通用音乐源获取（多源聚合）
curl "https://get.hotier.cc.cd/api/music?source=netease&id=347230&br=128"

# 健康检查
curl "https://get.hotier.cc.cd/api/health"
```
