"use client";

/**
 * 平台引擎设置表单（卡片主体，弹层与专用设置页共用）。
 *
 * 四区块：A 平台引擎（6×2 矩阵）· B 自动换源四项配置
 *        · C 内置播放引擎总开关
 *        · D 运行状态（存储 / 密钥 / 配置来源）· E 底部操作条。
 * 本组件只做渲染与事件透传：草稿 / diff / 提交 / 密钥全部委派 use-music-settings。
 *
 * 三态：
 *   - 只读（editable=false）：全部控件禁用 + 顶部横幅说明原因，隐藏保存；
 *   - 锁定项（locked[kind]）：该项禁用 + 「部署锁定」标签（editable 时也可能出现）；
 *   - 可编辑未解锁：控件可交互，主按钮为「解锁并保存」，点击内联展开密钥输入。
 *
 * 两种授权模式：
 *   - `key`（默认）：内联密钥（sessionStorage + Bearer），用于从音乐页快捷入口进入的弹层；
 *   - `session`：专用设置页 `/music/settings` 已由服务端登录鉴权（httpOnly 会话 Cookie），
 *     无需再输密钥；会话失效（401）时回调 `onUnauthorized` 让调用方跳回登录页，
 *     「退出登录」由调用方通过 `onLogout` 注入到 D 区列表末尾（弹层不传即不渲染）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  Check,
  Database,
  Hash,
  History,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  LogOut,
  MousePointerClick,
  Play,
  Power,
  Radar,
  Repeat,
  RotateCcw,
  Search,
  ShieldCheck,
  Sliders,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MUSIC_BEHAVIOR_LIMITS,
  MUSIC_FLAG_PLATFORM_KEYS,
} from "@/lib/music-platform-flags";
import type { MusicCapsData } from "@/lib/music-caps";
import { PlatformIcon } from "./platform-icons";
import { platformBrandFor } from "./platform-brand";
import {
  clampMaxAttempts,
  clearStoredKey,
  countDraftChanges,
  createDraftFromCaps,
  describeBlockedReason,
  getStoredKey,
  isBehaviorValid,
  setStoredKey,
  submitMusicSettings,
  type MusicSettingsDraft,
  type SettingsAction,
} from "./use-music-settings";

/** 授权模式：内联密钥 / 已登录会话 */
export type SettingsAuthMode = "key" | "session";

export interface MusicSettingsFormProps {
  /** 服务端全量 caps 数据（含 baseline / overrides / locked / editable / behavior） */
  caps: MusicCapsData | null;
  /** 保存 / 恢复基线成功：携带服务端最新数据，父层据此刷新平台矩阵 */
  onSaved: (data: MusicCapsData | null) => void;
  /** 是否处于激活态（弹层 = open；设置页恒 true）：决定草稿何时按 caps 重建 */
  active: boolean;
  /** 授权模式，默认 "key" */
  authMode?: SettingsAuthMode;
  /** session 模式会话失效（401）回调：调用方跳回登录页 */
  onUnauthorized?: () => void;
  /** session 模式「退出登录」：传入后在 D 区列表末尾渲染登出行（弹层不传即不渲染） */
  onLogout?: () => void;
  /** 退出登录进行中：禁用按钮并显示载入图标 */
  loggingOut?: boolean;
  /** 卡片附加类名（设置页传 is-page 去掉居中宽度与动画） */
  className?: string;
  /** 弹层关闭按钮；不传则不渲染（设置页用头部「返回音乐」代替） */
  onRequestClose?: () => void;
  /** 头部右侧附加内容（设置页放「返回音乐」） */
  headerExtra?: React.ReactNode;
}

/** 平台行 / 引擎槽位定义 */
const ROWS = MUSIC_FLAG_PLATFORM_KEYS;
const COLUMNS: Array<{
  kind: "search" | "play";
  label: string;
  short: string;
  hint: string;
  Icon: LucideIcon;
}> = [
  {
    kind: "search",
    label: "搜索引擎",
    short: "搜索",
    hint: "关闭后该平台不出现在搜索源，也不可被聚合搜索",
    Icon: Search,
  },
  {
    kind: "play",
    label: "播放引擎",
    short: "播放",
    hint: "关闭后拒绝为该平台取播放直链，resolve 不再宣称可播",
    Icon: Play,
  },
];

/** 锁定槽位提示里的 env 名（部署侧强制关闭该平台时用） */
const LOCK_HINT: Record<"search" | "play", string> = {
  search: "MUSIC_PLATFORM_SEARCH_DISABLED / MUSIC_PLATFORM_OFF",
  play: "MUSIC_PLATFORM_PLAY_DISABLED / MUSIC_PLATFORM_OFF",
};

/** 内置播放引擎总开关被部署终闸锁定时提示里的 env 名 */
const BUILTIN_PLAY_LOCK_HINT = "MUSIC_BUILTIN_PLAY=off";

/** 诊断项状态胶囊：ok=开 / 否=关；null=未获取到（caps 未到达） */
function DiagState({
  ok,
  okLabel = "已连接",
  offLabel = "未配置",
}: {
  ok: boolean | null;
  okLabel?: string;
  offLabel?: string;
}) {
  if (ok === null) return <span className="mp-settings-pill">—</span>;
  return (
    <span className={cn("mp-settings-pill", ok ? "is-ok" : "is-off")}>
      {ok ? okLabel : offLabel}
    </span>
  );
}

export default function MusicSettingsForm({
  caps,
  onSaved,
  active,
  authMode = "key",
  onUnauthorized,
  onLogout,
  loggingOut = false,
  className,
  onRequestClose,
  headerExtra,
}: MusicSettingsFormProps) {
  const editable = caps?.editable === true;
  const sessionAuth = authMode === "session";
  const [draft, setDraft] = useState<MusicSettingsDraft>(() =>
    createDraftFromCaps(caps),
  );
  const [unlocked, setUnlocked] = useState(sessionAuth);
  const [keyInput, setKeyInput] = useState("");
  /** 需要密钥的待执行动作（非空 = 底部内联展开密钥输入框） */
  const [pending, setPending] = useState<SettingsAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  /** 最近一次用于初始化草稿的 caps（身份变化 = 服务端数据已刷新） */
  const draftFromRef = useRef<MusicCapsData | null | undefined>(undefined);

  // 激活 / 服务端数据刷新 → 以 overrides ?? 生效值重建草稿
  useEffect(() => {
    if (!active) return;
    if (draftFromRef.current === caps) return;
    draftFromRef.current = caps;
    setDraft(createDraftFromCaps(caps));
  }, [active, caps]);

  // 激活时同步密钥解锁态（session 模式恒为已解锁）
  useEffect(() => {
    if (!active) return;
    setUnlocked(sessionAuth || Boolean(getStoredKey()));
    setPending(null);
    setError("");
    setNotice("");
    setKeyInput("");
  }, [active, sessionAuth]);

  // Esc 关闭（仅弹层传入 onRequestClose 时生效）
  useEffect(() => {
    if (!active || !onRequestClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRequestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onRequestClose]);

  const changes = useMemo(() => countDraftChanges(draft, caps), [draft, caps]);
  const behaviorValid = isBehaviorValid(draft.behavior);

  // 运行状态：新服务端给出 storeAvailable / writeKeyConfigured，旧服务端按 blockedReason 推导
  const storeOn = caps
    ? caps.storeAvailable ?? caps.blockedReason !== "no-store"
    : null;
  const keyOn = caps
    ? caps.writeKeyConfigured ?? caps.editable === true
    : null;
  /** 存储最近一次故障原因：env 配了也可能连不上（超时 / 被代理黑洞），需如实展示 */
  const storeError = caps?.storeError || "";
  const storeOk = storeOn === null ? null : storeOn && !storeError;

  const setSlot = useCallback(
    (kind: "search" | "play", key: string, value: boolean) => {
      setDraft((d) => ({ ...d, [kind]: { ...d[kind], [key]: value } }));
      setNotice("");
    },
    [],
  );

  const setBehavior = useCallback(
    (patch: Partial<MusicSettingsDraft["behavior"]>) => {
      setDraft((d) => ({ ...d, behavior: { ...d.behavior, ...patch } }));
      setNotice("");
    },
    [],
  );

  /** 内置播放引擎总开关（null = 被部署终闸锁定，不可点） */
  const setBuiltinPlay = useCallback((value: boolean) => {
    setDraft((d) => ({ ...d, builtinPlay: value }));
    setNotice("");
  }, []);

  const runAction = useCallback(
    async (action: SettingsAction, key: string) => {
      setSubmitting(true);
      setError("");
      setNotice("");

      const res = await submitMusicSettings({
        action,
        key: key || undefined,
        draft,
      });
      setSubmitting(false);
      if (!res.ok) {
        setError(res.error);
        if (res.unauthorized) {
          if (sessionAuth) {
            // 会话失效：交由调用方跳回登录页
            onUnauthorized?.();
            return;
          }
          // 密钥被拒：清掉本地密钥，回到「索要密钥」态
          clearStoredKey();
          setUnlocked(false);
          setPending(action);
        }
        return;
      }
      setStoredKey(key);
      setUnlocked(true);
      setPending(null);
      setKeyInput("");
      setNotice(action === "save" ? "已保存，全站立即生效" : "已恢复部署基线");
      if (res.data) {
        draftFromRef.current = res.data;
        setDraft(createDraftFromCaps(res.data));
      }
      onSaved(res.data);
    },
    [draft, onSaved, sessionAuth, onUnauthorized],
  );

  /** 动作入口：会话模式直接提交（靠 Cookie），密钥模式已有密钥直接提交、否则内联展开输入 */
  const startAction = useCallback(
    (action: SettingsAction) => {
      if (sessionAuth) {
        void runAction(action, "");
        return;
      }
      const stored = getStoredKey();
      if (stored) {
        void runAction(action, stored);
        return;
      }
      setError("");
      setNotice("");
      setPending(action);
    },
    [runAction, sessionAuth],
  );

  const submitKey = useCallback(() => {
    const key = keyInput.trim();
    if (!key) {
      setError("请输入设置写入密钥");
      return;
    }
    if (!pending) return;
    void runAction(pending, key);
  }, [keyInput, pending, runAction]);

  const lockEditing = useCallback(() => {
    clearStoredKey();
    setUnlocked(false);
    setPending(null);
    setKeyInput("");
    setNotice("已锁定编辑");
  }, []);

  const discard = useCallback(() => {
    setDraft(createDraftFromCaps(caps));
    setError("");
    setNotice("已放弃未保存的改动");
  }, [caps]);

  if (!active) return null;

  const readonly = !editable;
  const controlsDisabled = readonly || submitting;
  const canSave = editable && changes > 0 && behaviorValid && !submitting;
  // 内置播放引擎总开关：null = 部署终闸锁定；false = 已关闭（播放列整体从属停用）
  const builtinPlayValue = draft.builtinPlay;
  const builtinPlayLocked = builtinPlayValue === null;
  const builtinPlayOff = builtinPlayValue === false;

  return (
    <div
      className={cn("mp-settings-card", className)}
      role="dialog"
      aria-label="平台引擎设置"
    >
      <div className="mp-settings-head">
        <div className="mp-settings-headtext">
          <div className="mp-settings-headline">
            <Sliders className="mp-settings-headicon" aria-hidden />
            <span className="mp-settings-caption">音乐控制台</span>
          </div>
        </div>
        {headerExtra ??
          (onRequestClose ? (
            <button
              type="button"
              className="mp-settings-close"
              onClick={onRequestClose}
              aria-label="关闭设置面板"
              title="关闭"
            >
              <X />
            </button>
          ) : null)}
      </div>

      {readonly && (
        <div className="mp-settings-banner" role="status">
          <AlertCircle />
          <span>
            {caps
              ? describeBlockedReason(caps.blockedReason)
              : "正在读取部署配置，请稍候…"}
          </span>
        </div>
      )}

      <div className="mp-settings-body">
        {/* A. 平台引擎：每行一个平台的两个引擎开关（播放列受「内置播放引擎」区块的总开关从属约束） */}
        <section className="mp-settings-sec">
          <div className="mp-settings-sectitle">
            <span>平台引擎</span>
            {builtinPlayOff && (
              <span
                className="mp-settings-sectag"
                title="内置播放引擎总开关已关闭（见下方「内置播放引擎」区块）：各平台取链通道整体停用"
              >
                内置播放已停用
              </span>
            )}
          </div>
          <div className="mp-list">
            {/* 列标题行：平台 / 两个引擎列（复用各行槽位布局，故与开关列天然对齐；纯装饰不参与交互） */}
            <div className="mp-list-item mp-engine-head" aria-hidden="true">
              <span className="mp-engine-headic" />
              <span className="mp-engine-headname">平台</span>
              <span className="mp-engine-slots">
                {COLUMNS.map((c) => (
                  <span className="mp-engine-slot" key={c.kind}>
                    <span className="mp-engine-slotlabel">{c.short}</span>
                  </span>
                ))}
              </span>
            </div>
            {ROWS.map((key) => {
              const brand = platformBrandFor(key);
              return (
                <div className="mp-list-item mp-engine-item" key={key}>
                  <span className="mp-list-ic">
                    <PlatformIcon source={key} size={17} />
                  </span>
                  <span className="mp-engine-name">{brand.label}</span>
                  <span className="mp-engine-slots">
                    {COLUMNS.map((c) => {
                      const value = draft[c.kind][key];
                      const locked = value === null;
                      // 内置播放引擎总开关关闭 → 播放列整体从属停用（槽位存储值保持不变，
                      // 重新开启总开关即恢复原配置）
                      const gated = c.kind === "play" && builtinPlayOff;
                      const on = value === true && !gated;
                      const disabled = controlsDisabled || locked || gated;
                      const tip = gated
                        ? "内置播放引擎总开关已关闭：该平台取链通道整体停用"
                        : locked
                          ? `部署锁定：${LOCK_HINT[c.kind]} 已强制关闭该平台，无法在此开启`
                          : readonly
                            ? "当前配置只读"
                            : `${brand.label} · ${c.label}：点击${on ? "关闭" : "开启"}`;
                      return (
                        <span
                          key={c.kind}
                          title={tip}
                          className={cn(
                            "mp-engine-slot",
                            on && !locked && "is-on",
                            (locked || gated) && "is-locked",
                          )}
                        >
                          {locked && <Lock className="mp-engine-slotic" />}
                          <Toggle
                            on={on}
                            locked={locked}
                            disabled={disabled}
                            label={`${brand.label} ${c.label}`}
                            onChange={(v) => setSlot(c.kind, key, v)}
                          />
                        </span>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* B. 自动换源：列表，主开关在首行，其余为从属项 */}
        <section className="mp-settings-sec">
          <div className="mp-settings-sectitle">
            <span>自动换源</span>
          </div>
          <div className="mp-list">
            <div className="mp-list-item">
              <span className="mp-list-ic">
                <Repeat />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">自动换源</span>
                <span className="mp-list-desc">
                  播放失败后自动尝试同曲其他可播版本
                </span>
              </span>
              <Toggle
                on={draft.behavior.enabled}
                disabled={controlsDisabled}
                label="自动换源总开关"
                onChange={(v) => setBehavior({ enabled: v })}
              />
            </div>

            <div
              className={cn(
                "mp-list-item",
                !draft.behavior.enabled && "is-off",
              )}
            >
              <span className="mp-list-ic">
                <Hash />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">单轮尝试上限</span>
                <span className="mp-list-desc">
                  队列候选 + 跨源现搜候选合计，
                  {MUSIC_BEHAVIOR_LIMITS.maxAttempts.min}-
                  {MUSIC_BEHAVIOR_LIMITS.maxAttempts.max} 次
                </span>
              </span>
              <div className="mp-settings-stepper">
                <button
                  type="button"
                  className="mp-settings-step"
                  disabled={
                    controlsDisabled ||
                    !draft.behavior.enabled ||
                    draft.behavior.maxAttempts <=
                      MUSIC_BEHAVIOR_LIMITS.maxAttempts.min
                  }
                  aria-label="减少尝试上限"
                  onClick={() =>
                    setBehavior({
                      maxAttempts: clampMaxAttempts(
                        draft.behavior.maxAttempts - 1,
                      ),
                    })
                  }
                >
                  −
                </button>
                <input
                  className={cn("mp-settings-num", !behaviorValid && "is-bad")}
                  type="number"
                  inputMode="numeric"
                  min={MUSIC_BEHAVIOR_LIMITS.maxAttempts.min}
                  max={MUSIC_BEHAVIOR_LIMITS.maxAttempts.max}
                  step={1}
                  value={draft.behavior.maxAttempts}
                  disabled={controlsDisabled || !draft.behavior.enabled}
                  aria-label="单轮自动换源尝试上限"
                  onChange={(e) =>
                    setBehavior({ maxAttempts: Number(e.target.value) })
                  }
                  onBlur={(e) =>
                    setBehavior({
                      maxAttempts: clampMaxAttempts(Number(e.target.value)),
                    })
                  }
                />
                <button
                  type="button"
                  className="mp-settings-step"
                  disabled={
                    controlsDisabled ||
                    !draft.behavior.enabled ||
                    draft.behavior.maxAttempts >=
                      MUSIC_BEHAVIOR_LIMITS.maxAttempts.max
                  }
                  aria-label="增加尝试上限"
                  onClick={() =>
                    setBehavior({
                      maxAttempts: clampMaxAttempts(
                        draft.behavior.maxAttempts + 1,
                      ),
                    })
                  }
                >
                  +
                </button>
              </div>
            </div>

            <div
              className={cn(
                "mp-list-item",
                !draft.behavior.enabled && "is-off",
              )}
            >
              <span className="mp-list-ic">
                <Radar />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">跨音源现搜</span>
                <span className="mp-list-desc">
                  队列内无可自动候选时，去其它可播平台现搜同名歌曲
                </span>
              </span>
              <Toggle
                on={draft.behavior.crossSearch}
                disabled={controlsDisabled || !draft.behavior.enabled}
                label="跨音源现搜"
                onChange={(v) => setBehavior({ crossSearch: v })}
              />
            </div>

            <div
              className={cn(
                "mp-list-item",
                !draft.behavior.enabled && "is-off",
              )}
            >
              <span className="mp-list-ic">
                <MousePointerClick />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">失败后弹人工选版</span>
                <span className="mp-list-desc">
                  自动换源收尾仍失败时，列出同曲其他版本供人工确认
                </span>
              </span>
              <Toggle
                on={draft.behavior.showManualDialog}
                disabled={controlsDisabled || !draft.behavior.enabled}
                label="失败后弹人工选版面板"
                onChange={(v) => setBehavior({ showManualDialog: v })}
              />
            </div>
          </div>
        </section>

        {/* C. 内置播放引擎：站点自带取直链通道（GD 公共上游 + 自研直连）的总闸 */}
        <section className="mp-settings-sec">
          <div className="mp-settings-sectitle">
            <span>内置播放引擎</span>
          </div>

          <div className="mp-list">
            {/* 内置播放引擎总开关：站点自带取直链通道（GD 公共上游 + 自研直连）的总闸 */}
            <div className={cn("mp-list-item", builtinPlayOff && "is-off")}>
              <span className="mp-list-ic">
                <Power />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">内置播放引擎</span>
                <span className="mp-list-desc">
                  站点自带的取直链通道（GD 公共上游 + 自研直连）；关闭后不再取试听直链，
                  搜索不受影响
                </span>
              </span>
              <span
                className={cn(
                  "mp-engine-slot",
                  builtinPlayValue === true && !builtinPlayLocked && "is-on",
                  builtinPlayLocked && "is-locked",
                )}
                title={
                  builtinPlayLocked
                    ? `部署锁定：${BUILTIN_PLAY_LOCK_HINT} 已强制停用内置播放引擎，无法在此开启`
                    : readonly
                      ? "当前配置只读"
                      : builtinPlayOff
                        ? "点击开启内置播放引擎（恢复各平台取链）"
                        : "点击停用内置播放引擎"
                }
              >
                {builtinPlayLocked && <Lock className="mp-engine-slotic" />}
                <Toggle
                  on={builtinPlayValue === true}
                  locked={builtinPlayLocked}
                  disabled={controlsDisabled || builtinPlayLocked}
                  label="内置播放引擎总开关"
                  onChange={setBuiltinPlay}
                />
              </span>
            </div>

          </div>
        </section>

        {/* D. 运行状态：存储 / 密钥 / 配置来源（只读诊断） */}
        <section className="mp-settings-sec">
          <div className="mp-settings-sectitle">
            <span>运行状态</span>
          </div>
          <div className="mp-list">
            <div className="mp-list-item">
              <span className="mp-list-ic">
                <Database />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">持久化存储</span>
                <span className="mp-list-desc">
                  {storeError
                    ? `Turso app_settings 表最近一次请求失败：${storeError}`
                    : "Turso app_settings 表，保存平台引擎与自动换源配置"}
                </span>
              </span>
              <DiagState
                ok={storeOk}
                offLabel={storeError ? "连接异常" : "未配置"}
              />
            </div>
            <div className="mp-list-item">
              <span className="mp-list-ic">
                <KeyRound />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">写入密钥</span>
                <span className="mp-list-desc">
                  SETTINGS_API_KEY，保护配置保存
                </span>
              </span>
              <DiagState ok={keyOn} okLabel="已配置" offLabel="未配置" />
            </div>
            <div className="mp-list-item">
              <span className="mp-list-ic">
                <History />
              </span>
              <span className="mp-list-text">
                <span className="mp-list-title">配置来源</span>
                <span className="mp-list-desc">
                  {caps?.overrides
                    ? "控制台保存的配置，覆盖部署环境变量基线"
                    : "部署环境变量基线（尚未在控制台保存过）"}
                </span>
              </span>
              <span className="mp-settings-pill">
                {caps?.overrides ? "控制台" : "部署基线"}
              </span>
            </div>
            {/* 会话模式专用：退出登录与其余设置项同级，放在列表最末（弹层不传 onLogout，不渲染） */}
            {onLogout && (
              <div className="mp-list-item">
                <span className="mp-list-ic">
                  <LogOut />
                </span>
                <span className="mp-list-text">
                  <span className="mp-list-title">退出登录</span>
                  <span className="mp-list-desc">
                    结束当前控制台会话，返回登录页重新输入密钥
                  </span>
                </span>
                <button
                  type="button"
                  className="mp-settings-btn is-ghost mp-list-danger"
                  disabled={loggingOut}
                  onClick={onLogout}
                >
                  {loggingOut ? <Loader2 className="mp-spin" /> : null}
                  退出
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* E. 底部操作条 */}
      <div className="mp-settings-foot">
        <div className="mp-settings-status">
          {error ? (
            <span className="mp-settings-msg is-err" role="alert">
              <AlertCircle />
              {error}
            </span>
          ) : notice ? (
            <span className="mp-settings-msg is-ok" role="status">
              <Check />
              {notice}
            </span>
          ) : (
            <span className="mp-settings-msg">
              {changes > 0 ? `${changes} 项待保存` : "配置与当前生效值一致"}
              <span className="mp-settings-auth">
                {sessionAuth ? (
                  <>
                    <ShieldCheck />
                    已登录
                  </>
                ) : unlocked ? (
                  <>
                    <LockOpen />
                    已解锁编辑
                  </>
                ) : (
                  <>
                    <Lock />
                    未解锁编辑
                  </>
                )}
              </span>
            </span>
          )}
        </div>

        {pending && (
          <div className="mp-settings-keyrow">
            <KeyRound className="mp-settings-keyicon" />
            <input
              className="mp-settings-keyinput"
              type="password"
              autoFocus
              value={keyInput}
              placeholder="设置写入密钥（SETTINGS_API_KEY）"
              aria-label="设置写入密钥"
              disabled={submitting}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitKey();
              }}
            />
            <button
              type="button"
              className="mp-settings-btn is-primary"
              disabled={submitting}
              onClick={submitKey}
            >
              {submitting ? <Loader2 className="mp-spin" /> : null}
              {pending === "restore" ? "解锁并恢复基线" : "解锁并保存"}
            </button>
            <button
              type="button"
              className="mp-settings-btn"
              disabled={submitting}
              onClick={() => {
                setPending(null);
                setKeyInput("");
                setError("");
              }}
            >
              取消
            </button>
          </div>
        )}

        <div className="mp-settings-actions">
          {!sessionAuth && unlocked && (
            <button
              type="button"
              className="mp-settings-btn is-ghost"
              disabled={submitting}
              title="清除本标签页保存的密钥"
              onClick={lockEditing}
            >
              <Lock />
              锁定编辑
            </button>
          )}
          <button
            type="button"
            className="mp-settings-btn is-ghost"
            disabled={submitting || readonly}
            title="删除保存的配置文档，回到部署环境变量基线"
            onClick={() => startAction("restore")}
          >
            <RotateCcw />
            恢复部署基线
          </button>
          <button
            type="button"
            className="mp-settings-btn"
            disabled={submitting || changes === 0}
            title="回填当前生效值"
            onClick={discard}
          >
            <Undo2 />
            放弃
          </button>
          {!readonly && (
            <button
              type="button"
              className={cn("mp-settings-btn", "is-primary")}
              disabled={!canSave}
              title={
                behaviorValid
                  ? "保存并全站生效"
                  : `尝试上限需为 ${MUSIC_BEHAVIOR_LIMITS.maxAttempts.min}-${MUSIC_BEHAVIOR_LIMITS.maxAttempts.max} 的整数`
              }
              onClick={() => startAction("save")}
            >
              {submitting ? <Loader2 className="mp-spin" /> : null}
              {!sessionAuth && !unlocked ? "解锁并保存" : "保存"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 自研 pill 开关（对齐 .mp-* 风格，不用 Radix Switch）；locked = 部署强锁的禁用态 */
function Toggle({
  on,
  disabled,
  locked,
  label,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  locked?: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={cn(
        "mp-settings-sw",
        on && !locked && "is-on",
        locked && "is-locked",
      )}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="mp-settings-knob" />
    </button>
  );
}
