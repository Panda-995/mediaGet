"use client";
/**
 * 媒体域容器 hook：把「在播曲目的附属资源」这一整条链路从 `MusicExplorer` 里收进来 ——
 * 专辑封面、封面配色（整页歌词动态背景）、歌词（LRC 主通道 + AMLL 词库逐字通道）、
 * 以及歌词原文转出的可下载 Blob。
 *
 * 拆它的动因（见 docs/REFACTOR-PLAN.md P2-5）：这几条链路**只依赖「当前曲目 + 音源」**，
 * 与搜索域 / 播放编排 / 视图切换都没有耦合，是组件里最"外挂"的一块——
 * 却占了 5 个 effect、12 个 useState，纯属按注释分区时挤在一起。
 *
 * 边界（**不属于**本 hook，留在调用方编排）：
 * - 歌词高亮行的下标 `activeLyricIndex`：它是「歌词 × 播放进度」的交叉结果，
 *   进度在播放引擎里，故留在调用方用 `getActiveLyricIndex` 现算；
 * - 暗色主题 `isDark`：只服务于本 hook 内的取色（封面主色的深/浅变体），不外传；
 * - 系统媒体会话（Windows 通知栏）用的封面：读本 hook 输出的 `coverUrl`，由调用方接。
 *
 * 生命周期约定（与抽离前逐字一致，勿在重构中悄悄改）：
 * - 三条请求链各自持一个 `AbortController`：换曲 / 卸载时掐断在途请求，
 *   且 `aborted` 后**不写任何 state**（避免旧曲目的封面盖掉新曲目的）；
 * - 歌词在途时不清空旧歌词？——不，这里选择清空（`picked` 一变即复位四态）：
 *   整页歌词与迷你条都按"加载中"渲染，比残留上一首的歌词更不容易误读。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  coverBinUrl,
  requestAmllLyric,
  requestLyric,
  requestPic,
  sourceSupportsAmllLyric,
  type SearchItem,
} from "@/lib/client/music-client";
import type { SearchSourceKey } from "@/types/music";
import { type CoverPalette, sampleCoverPalette } from "@/lib/cover-palette";
import {
  readCachedLyric,
  readCachedPalette,
  writeCachedLyric,
  writeCachedPalette,
} from "./media-cache";
import { parseLrc, type LyricLine } from "./lyric-utils";
import { parseTtmlAmll, type AmllRichResult } from "./ttml-amll";

export interface UseMusicMediaOptions {
  /** 当前在播曲目（播放引擎的 `picked`）；null = 无在播内容 → 清空全部媒体态 */
  picked: SearchItem | null;
  /** 曲目自身未带 `source`（如链接解析产物）时回落的当前音源 */
  source: SearchSourceKey;
}

export interface MusicMediaState {
  /** 封面可用地址（图床直链或经 GD pic 换取的 blob/链接），空串 = 尚未取到 */
  coverUrl: string;
  coverLoading: boolean;
  /** 封面取图失败（图源 404 / 代理失败）：展示态退化为占位图，且跳过取色 */
  coverFailed: boolean;
  /**
   * 图片元素 `onError` 的回调：已经拿到 URL 但浏览器加载不出来时，由展示层回调标记失败
   * （与「请求阶段失败」区分开——那条路径在 hook 内部自己置位）。
   */
  markCoverFailed: () => void;
  /** 封面主色 / 明暗采样结果：整页歌词据此推导背景渐变与对比文字色 */
  palette: CoverPalette | null;
  /** 解析后的歌词行；null = 未取到（与"空数组"区分：空数组代表源确实没有歌词） */
  lyricLines: LyricLine[] | null;
  /** 原始 LRC 文本（详情弹窗内可下载） */
  lyricRaw: string;
  lyricsLoading: boolean;
  lyricError: string;
  /** AMLL 词库命中时的逐字行（毫秒级 words + 翻译）；未命中 / 源不支持时为 null */
  amllRich: AmllRichResult | null;
  /** 原始 LRC 转出的可下载 Blob 地址（详情弹窗「歌词链接」行点击下载用） */
  lyricBlobUrl: string;
  /**
   * 立刻清空媒体态并掐断在途歌词请求（清空播放会话 / 切源 / 重新解析前调用）。
   * 引擎复位后 `picked` 变 null 会通过 effect 再清一次，这里是**当帧就清**，
   * 免得旧封面 / 旧歌词在复位那一帧还挂在界面上。
   */
  resetMedia: () => void;
}

export function useMusicMedia({
  picked,
  source,
}: UseMusicMediaOptions): MusicMediaState {
  const [coverUrl, setCoverUrl] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [palette, setPalette] = useState<CoverPalette | null>(null);
  /** 是否处于暗色主题（监听 <html> 的 .dark class），整页歌词取色据此切「深色变体」 */
  const [isDark, setIsDark] = useState(false);

  const [lyricLines, setLyricLines] = useState<LyricLine[] | null>(null);
  const [lyricRaw, setLyricRaw] = useState("");
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricError, setLyricError] = useState("");
  const [amllRich, setAmllRich] = useState<AmllRichResult | null>(null);
  const [lyricBlobUrl, setLyricBlobUrl] = useState("");

  const coverAbortRef = useRef<AbortController | null>(null);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const lyricAbortRef = useRef<AbortController | null>(null);

  /**
   * 用「LRC 原文 + AMLL TTML 原文」刷新歌词三态。
   * 在线请求结果与本地缓存命中走同一套落值逻辑，避免两条路径的渲染分支漂移。
   * @returns 是否渲染出了可用歌词（false = 两个通道都没有内容）
   */
  const applyLyricData = useCallback((lrc: string, amllTtml: string): boolean => {
    const rich = amllTtml ? parseTtmlAmll(amllTtml) : null;
    const richOk = rich && rich.timed.length ? rich : null;
    if (lrc) {
      const lines = parseLrc(lrc);
      setLyricRaw(lrc);
      setLyricLines(lines.length ? lines : null);
      // 词库命中 → 整页视图改用真逐字渲染；未命中保持 LRC 估算
      setAmllRich(richOk);
      return true;
    }
    if (richOk) {
      // 平台 LRC 通道失败但词库命中：用词库句级行顶替，避免整页空态报错
      setLyricLines(richOk.timed);
      setAmllRich(richOk);
      return true;
    }
    return false;
  }, []);

  // 专辑封面
  useEffect(() => {
    coverAbortRef.current?.abort();
    setCoverUrl("");
    setCoverFailed(false);
    setCoverLoading(false);
    if (!picked) return;
    const picId = picked.picId ?? "";
    const directPic = picked.picUrlDirect ?? "";
    if (!picId && !directPic) return;

    // 链接解析产物的封面是图床直链，直接展示，无需经 GD pic 换取
    if (directPic) {
      setCoverUrl(directPic);
      return;
    }

    const controller = new AbortController();
    coverAbortRef.current = controller;
    setCoverLoading(true);

    (async () => {
      try {
        const url = await requestPic(picked.source || source, picId, controller.signal);
        if (controller.signal.aborted) return;
        setCoverUrl(url);
      } catch {
        if (!controller.signal.aborted) setCoverFailed(true);
      } finally {
        if (!controller.signal.aborted) setCoverLoading(false);
      }
    })();

    return () => controller.abort();
  }, [picked, source]);

  // 跟随站点主题：ThemeToggle / 系统偏好都会反映在 <html> 的 class 上
  useEffect(() => {
    const el = document.documentElement;
    const apply = () => setIsDark(el.classList.contains("dark"));
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // 整页歌词动态配色：封面到位后降采样取「主色/明暗」，据此推导背景渐变与
  // 对比文字色。暗色主题强制「深背景浅字」变体（仅保留封面主色调），避免亮色
  // 封面在深色模式下把整页切成刺眼的浅色背景；浅色主题仍按封面明暗自适应。
  // 优先直接读外部 CDN 图（仅当其开放 CORS），失败回退同源字节代理。
  useEffect(() => {
    paletteAbortRef.current?.abort();
    setPalette(null);
    if (!picked || coverFailed || !coverUrl) return;
    const picId = picked.picId ?? "";
    // 链接解析产物的封面为图床直链，无法走 GD bin 代理取色，跳过即可（直链 CORS 失败会静默回退默认配色）
    if (!picId && !picked.picUrlDirect) return;
    const srcName = picked.source || source;
    // 同源 bin 字节代理仅 GD 源且同源代理可用时存在（self 源封面为直链、直连模式下 bin 同样 502）；
    // 无 bin 时仅尝试外部直链取色，取不到色就回退整页歌词默认配色（不阻断功能）
    const binUrl = !picked.picUrlDirect ? coverBinUrl(srcName, picId) : "";
    const controller = new AbortController();
    paletteAbortRef.current = controller;
    // 配色只取决于「封面 + 主题模式」，结果是确定的：本地缓存命中即免掉一次图片降采样。
    // key 用 picId / 曲目 id 而非封面 URL——图床直链可能带签名参数，每次不同会击穿缓存。
    const paletteCacheKey = `${srcName}:${picId || picked.id || "cover"}|${
      isDark ? "dark" : "auto"
    }`;
    (async () => {
      const cached = await readCachedPalette(paletteCacheKey);
      if (controller.signal.aborted) return;
      if (cached) {
        setPalette(cached);
        return;
      }
      const pal = await sampleCoverPalette(coverUrl, binUrl, controller.signal, {
        mode: isDark ? "dark" : "auto",
      });
      if (controller.signal.aborted || !pal) return;
      setPalette(pal);
      void writeCachedPalette(paletteCacheKey, pal);
    })();
    return () => controller.abort();
  }, [coverUrl, coverFailed, picked, source, isDark]);

  // 歌词（LRC 主通道 + AMLL 词库逐字通道并行）
  useEffect(() => {
    lyricAbortRef.current?.abort();
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    setAmllRich(null);
    setLyricsLoading(false);
    if (!picked) return;
    const lyricId = picked.lyricId ?? picked.id ?? "";
    if (!lyricId) return;

    const controller = new AbortController();
    lyricAbortRef.current = controller;
    setLyricsLoading(true);

    const srcName = picked.source || source;
    (async () => {
      // 本地缓存优先：歌词是准静态数据，命中即直接渲染（省掉一次第三方请求），
      // 存储不可用时 readCachedLyric 返回 null，自动退回正常请求
      const cached = await readCachedLyric(srcName, lyricId);
      if (controller.signal.aborted) return;
      if (cached && applyLyricData(cached.lrc, cached.amll)) {
        setLyricsLoading(false);
        return;
      }
      const lrcTask = requestLyric(srcName, lyricId, controller.signal).then(
        (raw): { ok: true; raw: string } | { ok: false; err: unknown } => ({
          ok: true,
          raw,
        }),
        (err): { ok: true; raw: string } | { ok: false; err: unknown } => ({
          ok: false,
          err,
        })
      );
      // 词库通道取原始 TTML 字符串（而非解析结果）：缓存落盘与原串一致，命中后再解析
      const richTask = sourceSupportsAmllLyric(srcName)
        ? requestAmllLyric(srcName, lyricId, controller.signal)
            .then((ttml) => ttml || "")
            .catch(() => "")
        : Promise.resolve("");

      const [lrcResult, amllTtml] = await Promise.all([lrcTask, richTask]);
      if (controller.signal.aborted) return;
      const hasLrc = lrcResult.ok && !!lrcResult.raw;
      if (!applyLyricData(hasLrc ? lrcResult.raw : "", amllTtml) && !lrcResult.ok) {
        const err = lrcResult.err;
        setLyricError(err instanceof Error ? err.message : "歌词加载失败");
      }
      // 有内容才落缓存：双通道皆空 = 源不支持或暂时失败，不写负缓存，下次仍可重试
      if (hasLrc || amllTtml) {
        void writeCachedLyric(srcName, lyricId, {
          lrc: hasLrc ? lrcResult.raw : "",
          amll: amllTtml,
        });
      }
      if (!controller.signal.aborted) setLyricsLoading(false);
    })();

    return () => controller.abort();
    // applyLyricData 是 useCallback([]) 的稳定引用，列入依赖不会改变执行时机
  }, [picked, source, applyLyricData]);

  // 原始 LRC 转可下载 Blob：歌词就绪后详情弹窗里可点击超链接下载该 .lrc 文件
  useEffect(() => {
    if (!lyricRaw) {
      setLyricBlobUrl("");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([lyricRaw], { type: "text/plain;charset=utf-8" })
    );
    setLyricBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [lyricRaw]);

  const resetMedia = useCallback(() => {
    lyricAbortRef.current?.abort();
    setCoverUrl("");
    setCoverFailed(false);
    setLyricLines(null);
    setLyricRaw("");
    setLyricError("");
    setAmllRich(null);
  }, []);

  const markCoverFailed = useCallback(() => setCoverFailed(true), []);

  return {
    coverUrl,
    coverLoading,
    coverFailed,
    markCoverFailed,
    palette,
    lyricLines,
    lyricRaw,
    lyricsLoading,
    lyricError,
    amllRich,
    lyricBlobUrl,
    resetMedia,
  };
}
