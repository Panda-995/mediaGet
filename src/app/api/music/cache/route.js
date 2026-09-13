import {
  beijingNow,
  getClientIP,
  getCorsHeaders,
  isBlockedIP,
  logger,
  rateLimit,
} from "@/lib/api-utils";
import { honeypotResponse } from "@/lib/honeypot";
import { normalizeResult } from "@/lib/normalize-result";
import {
  MUSIC_CACHE_FAIL_REASONS,
  MUSIC_CACHE_FAIL_TTL,
  MUSIC_CACHE_KINDS,
  MUSIC_CACHE_NEGATIVE_REASONS,
  MUSIC_CACHE_TTL,
  isMusicCacheAvailable,
  readMusicCache,
  writeMusicCache,
} from "@/lib/music-cache-store";

export const runtime = "nodejs";

/**
 * 音乐域共享缓存的读写端点（musicEngine.md §7.1 层①③④ 的载体）。
 *
 *   GET  /api/music/cache?kind=<candidate|negative|fail|health|detail>&key=<key>
 *        → { code:200, data:{ value, stored, store } }；value=null 表示无该条
 *   POST /api/music/cache  body { events: [ ... ] }
 *        → { code:200, data:{ accepted, written, store, errors } }（逐条独立成败）
 *
 * 事件类型（白名单，其余一律拒绝）：
 *   { type:"candidate", key, items:[{source,id,album?,score?}] }  —— **仅真实播放成功**才上报
 *   { type:"negative", key, reason:"no-candidate"|"all-attempts-failed" }
 *                                                 —— 层③ 降级负缓存（短 TTL，挡重复现搜）
 *   { type:"fail", key, source, id, reason:"transient"|"sources-down"|"not-found" }
 *   { type:"health", source, ok, stage, ms?, msg? }               —— 源健康度（连续失败数累加）
 *
 * 定位：这是**旁路上报**接口。调用方（播放引擎）fire-and-forget，失败不影响播放；
 * 存储未配置时一律静默跳过并如实回报 store="unavailable"，绝不 5xx。
 * 与之相对，读接口是「换源前读候选 / 判黑名单」的加速路径，miss 即按无缓存继续。
 *
 * 安全：读 / 写均走与其它音乐端点同款的前置（蜜罐黑名单 / IP 限流 / CORS）；
 * 写入侧另有事件条数、字段长度、候选条数与白名单校验，避免被当成任意 KV 滥用。
 */

/** 单次请求最多接受的事件条数（引擎一次换源轮次的上报量远小于此） */
const MAX_EVENTS = 20;
/** 单条候选缓存的候选上限 */
const MAX_CANDIDATE_ITEMS = 20;

/** 统一前置：返回 response 即拦截，否则放行 */
function guard(request, tag) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const clientIP = getClientIP(request);

  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music:cache:${tag}): ip=${clientIP}`);
    return {
      response: Response.json(normalizeResult(honeypotResponse("music")), {
        status: 200,
        headers: corsHeaders,
      }),
      corsHeaders,
      clientIP,
    };
  }
  if (!rateLimit(clientIP)) {
    return {
      response: Response.json(
        { code: 429, msg: "请求过于频繁，请稍后再试" },
        { status: 429, headers: corsHeaders }
      ),
      corsHeaders,
      clientIP,
    };
  }
  return { response: null, corsHeaders, clientIP };
}

/** 取值 + 长度上限（不合法返回 null） */
function str(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** 归一化单个候选：source + id 必填，其余可选且限长 */
function normalizeCandidateItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = str(raw.source, 40);
  const id = str(raw.id, 80);
  if (!source || !id) return null;
  const item = { source, id };
  const album = str(raw.album, 120);
  if (album) item.album = album;
  const provenance = str(raw.provenance, 40);
  if (provenance) item.provenance = provenance;
  const score = Number(raw.score);
  if (Number.isFinite(score)) item.score = score;
  return item;
}

/**
 * 候选缓存写入：**合并**而非覆盖。
 * 播放成功一次只会上报「刚播成功的那一个版本」，若直接覆盖，候选池永远只剩最后一条，
 * 层①「多源互为备份」的价值就没了。因此读旧值（fresh，绕进程缓存）合并：
 * 新成功的排前、按 source:id 去重、保留旧条目上的 failUntil 标记、上限截断。
 */
async function applyCandidate(ev) {
  const key = str(ev.key, 200);
  if (!key) return { error: "candidate.key 缺失或过长" };
  const list = Array.isArray(ev.items) ? ev.items.slice(0, MAX_CANDIDATE_ITEMS) : [];
  const incoming = list.map(normalizeCandidateItem).filter(Boolean);
  if (!incoming.length) return { error: "candidate.items 需要至少 1 个合法候选" };

  const prev = await readMusicCache("candidate", key, { fresh: true });
  const prevItems =
    prev.value && Array.isArray(prev.value.items) ? prev.value.items : [];

  const seen = new Set();
  const items = [];
  for (const it of [...incoming, ...prevItems]) {
    if (!it || typeof it.source !== "string" || typeof it.id !== "string") continue;
    const dedupe = `${it.source}:${it.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    items.push(it);
    if (items.length >= MAX_CANDIDATE_ITEMS) break;
  }

  return {
    written: await writeMusicCache(
      "candidate",
      key,
      { items, at: Date.now() },
      MUSIC_CACHE_TTL.candidate
    ),
  };
}

/** 失败黑名单事件 → 待写入项；不合法返回 { error } */
function buildFailWrite(ev) {
  const key = str(ev.key, 200);
  if (!key) return { error: "fail.key 缺失或过长" };
  const reason = str(ev.reason, 40) || "transient";
  if (!MUSIC_CACHE_FAIL_REASONS.includes(reason)) {
    return { error: `fail.reason 不合法: ${reason}` };
  }
  return {
    write: {
      kind: "fail",
      key,
      value: {
        source: str(ev.source, 40) || "",
        id: str(ev.id, 80) || "",
        reason,
        at: Date.now(),
      },
      ttl: MUSIC_CACHE_FAIL_TTL[reason],
    },
  };
}

/**
 * 失败黑名单写入，并**联动**把候选缓存里的同版本打上 failUntil。
 *
 * 为什么要联动：读取方（换源前的层①查询）只发一次 GET 拿候选列表，不可能再为每条候选
 * 单查一次黑名单（请求放大）。把失效标记直接写进候选条目，读侧本地过滤即可，
 * 保证「已经播不动的版本」不会被候选池反复排到前面重试。
 */
async function applyFail(ev) {
  const build = buildFailWrite(ev);
  if (build.error) return { error: build.error };
  const { kind, key, value, ttl } = build.write;
  const written = await writeMusicCache(kind, key, value, ttl);

  const lookupKey = str(ev.lookupKey, 200);
  if (lookupKey && value.source && value.id) {
    const cand = await readMusicCache("candidate", lookupKey, { fresh: true });
    const items =
      cand.value && Array.isArray(cand.value.items) ? cand.value.items : null;
    if (items) {
      const failUntil = Date.now() + ttl;
      const marked = items.map((it) =>
        it && it.source === value.source && it.id === value.id
          ? { ...it, failUntil }
          : it
      );
      await writeMusicCache(
        "candidate",
        lookupKey,
        { ...cand.value, items: marked },
        MUSIC_CACHE_TTL.candidate
      );
    }
  }
  return { written };
}

/**
 * 层③ 降级负缓存：记下「这首歌最近跨源现搜也搜不出合格候选」。
 *
 * 与层④ 的分工：层④ 挡的是**解析成本**（某个 `source:id` 不可播），层③ 挡的是**搜索成本**
 * （连一轮现搜都不必发）。所以读侧语义很硬——命中即跳过整轮现搜——写入门槛就必须窄：
 * 由调用方（播放引擎）保证「本轮真的跑过现搜，且层① 一条可用候选都没给出」才写。
 */
async function applyNegative(ev) {
  const key = str(ev.key, 200);
  if (!key) return { error: "negative.key 缺失或过长" };
  const reason = str(ev.reason, 40) || MUSIC_CACHE_NEGATIVE_REASONS[0];
  if (!MUSIC_CACHE_NEGATIVE_REASONS.includes(reason)) {
    return { error: `negative.reason 不合法: ${reason}` };
  }
  return {
    written: await writeMusicCache(
      "negative",
      key,
      { reason, at: Date.now() },
      MUSIC_CACHE_TTL.negative
    ),
  };
}

/**
 * 源健康度：读-改-写累加「连续失败数」（成功即归零）。
 * 读用 fresh 跳过进程内缓存——否则 30s 内的连续上报会读到同一份旧快照，把 streak 吃掉。
 */
async function applyHealth(ev) {
  const source = str(ev.source, 40);
  if (!source) return false;
  const ok = ev.ok === true;
  const ms = Number(ev.ms);
  const prev = await readMusicCache("health", source, { fresh: true });
  const old = prev.value && typeof prev.value === "object" ? prev.value : {};
  return writeMusicCache(
    "health",
    source,
    {
      source,
      ok,
      failStreak: ok ? 0 : Number(old.failStreak || 0) + 1,
      stage: str(ev.stage, 40) || "resolve",
      lastAt: Date.now(),
      lastMs: Number.isFinite(ms) ? ms : 0,
      lastError: str(ev.msg, 120) || "",
    },
    MUSIC_CACHE_TTL.health
  );
}

export async function GET(request) {
  const startTime = Date.now();
  // 读侧同样走前置：GET 是公开可批量探测的（可遍历 key 猜歌），不能只给写侧上闸
  const { response, corsHeaders } = guard(request, "read");
  if (response) return response;

  const { searchParams } = new URL(request.url);
  const kind = (searchParams.get("kind") || "").trim();
  const key = (searchParams.get("key") || "").trim();

  if (!MUSIC_CACHE_KINDS.includes(kind) || !key || key.length > 200) {
    return Response.json(
      {
        code: 400,
        msg: "kind / key 不合法",
        usage: `/api/music/cache?kind=<${MUSIC_CACHE_KINDS.join("|")}>&key=<key>`,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const res = await readMusicCache(kind, key);
  // found=读到值 / stored=读成功（两者都为 false 才是「库不可用」，便于区分「确认无该条」）
  console.log(
    `[music-cache] time=${beijingNow()} code=200 kind=${kind} duration=${
      Date.now() - startTime
    }ms found=${res.value !== null} stored=${res.ok}`
  );
  return Response.json(
    {
      code: 200,
      msg: "ok",
      data: {
        value: res.value,
        stored: res.ok,
        store: isMusicCacheAvailable() ? "turso" : "unavailable",
      },
    },
    { status: 200, headers: { ...corsHeaders, "cache-control": "no-store" } }
  );
}

export async function POST(request) {
  const startTime = Date.now();
  const { response, corsHeaders, clientIP } = guard(request, "report");
  if (response) return response;

  let raw;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { code: 400, msg: "body 必须为合法 JSON 对象" },
      { status: 400, headers: corsHeaders }
    );
  }

  const events = Array.isArray(raw?.events) ? raw.events : null;
  if (!events || events.length === 0 || events.length > MAX_EVENTS) {
    return Response.json(
      { code: 400, msg: `events 必须为 1~${MAX_EVENTS} 条的数组` },
      { status: 400, headers: corsHeaders }
    );
  }

  let accepted = 0;
  let written = 0;
  const errors = [];
  // 串行处理：health 的读-改-写累加不能并发乱序；上报量级很小（≤20），无需并行
  for (const raw of events) {
    const ev = raw && typeof raw === "object" ? raw : {};
    const type = str(ev.type, 20);

    if (type === "health") {
      if (!str(ev.source, 40)) {
        errors.push("health.source 缺失或过长");
        continue;
      }
      accepted += 1;
      if (await applyHealth(ev)) written += 1;
      continue;
    }

    if (type === "candidate" || type === "fail" || type === "negative") {
      const applied =
        type === "candidate"
          ? await applyCandidate(ev)
          : type === "fail"
          ? await applyFail(ev)
          : await applyNegative(ev);
      if (applied.error) {
        errors.push(applied.error);
        continue;
      }
      accepted += 1;
      if (applied.written) written += 1;
      continue;
    }

    errors.push(`不支持的 event.type: ${type || "(空)"}`);
  }

  console.log(
    `[music-cache] time=${beijingNow()} code=200 duration=${
      Date.now() - startTime
    }ms ip=${clientIP} accepted=${accepted} written=${written}`
  );
  return Response.json(
    {
      code: 200,
      msg: "ok",
      data: {
        accepted,
        written,
        store: isMusicCacheAvailable() ? "turso" : "unavailable",
        errors: errors.slice(0, 5),
      },
    },
    { status: 200, headers: { ...corsHeaders, "cache-control": "no-store" } }
  );
}
