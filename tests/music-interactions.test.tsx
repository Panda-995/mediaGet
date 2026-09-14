// @vitest-environment jsdom
/**
 * 交互域两个新 hook 的行为测试（`useMobileViewport` / `useOverlayDismiss` / `useMobileGestures`）。
 *
 * 这三个是从 `MusicExplorer` 里搬出来的纯 DOM 副作用：搬运行为本不该改语义，
 * 所以这里锁的不是"能不能跑"，而是**搬之前靠人眼保证、现在必须机械保证**的几条约定：
 * - `useOverlayDismiss`：**Esc 让位规则**（`.mp-alt-mask` 在上时不关底层）、
 *   **关闭时还原打开前的 overflow**（浮层可叠开，写死空串会提前解掉底层的锁）、
 *   **`onDismiss` 不入依赖但也不许变陈旧**（每次渲染都换闭包，按 Esc 必须调到最新的那个）。
 * - `useMobileGestures`：**手势识别的边界**（死区 / 方向 / 交互元素起手不拦截 / 歌词区已滚动不抢滚动），
 *   以及过阈值才收起、不足则回弹。
 * - `useMobileViewport`：断点跟随 + 旧版 Safari 的 `addListener` 回退路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMobileViewport } from "@/components/music/use-mobile-viewport";
import { useOverlayDismiss } from "@/components/music/use-overlay-dismiss";
import { useMobileGestures } from "@/components/music/use-mobile-gestures";

/** jsdom 没有 TouchEvent 构造器：用普通 Event 挂 `touches` 即可（手势只读 clientY 与 target） */
function fireTouch(el: Element, type: string, clientY: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "touches", { value: [{ clientY }] });
  el.dispatchEvent(ev);
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

/** 可控的 matchMedia：matches 由变量决定，且能手动触发 change */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const legacyListeners = new Set<() => void>();
  const mql = {
    media: "",
    get matches() {
      return matches;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => legacyListeners.add(cb),
    removeListener: (cb: () => void) => legacyListeners.delete(cb),
  };
  const impl = vi.fn((query: string) => {
    mql.media = query;
    return mql;
  });
  vi.stubGlobal("matchMedia", impl);
  return {
    impl,
    set(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
      legacyListeners.forEach((cb) => cb());
    },
  };
}

describe("useMobileViewport（移动端断点跟随）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("窄屏 → true；断点变化后跟随更新", () => {
    const mm = installMatchMedia(true);
    const { result } = renderHook(() => useMobileViewport());
    expect(result.current).toBe(true);
    expect(mm.impl.mock.calls[0][0]).toBe("(max-width: 700px)");

    act(() => mm.set(false));
    expect(result.current).toBe(false);
  });

  it("自定义断点拼进查询串（组件与 CSS 断点保持一致才不会错位）", () => {
    const mm = installMatchMedia(false);
    renderHook(() => useMobileViewport(480));
    expect(mm.impl.mock.calls[0][0]).toBe("(max-width: 480px)");
  });

  it("旧版 Safari 回退：没有 addEventListener 时走 addListener，change 照样生效", () => {
    let matches = false;
    const legacy = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      // 故意只给旧接口：没有 addEventListener / removeEventListener
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addListener: (cb: () => void) => legacy.add(cb),
        removeListener: (cb: () => void) => legacy.delete(cb),
      }))
    );

    const { result } = renderHook(() => useMobileViewport());
    expect(result.current).toBe(false);
    expect(legacy.size).toBe(1);

    act(() => {
      matches = true;
      legacy.forEach((cb) => cb());
    });
    expect(result.current).toBe(true);
  });
});

describe("useOverlayDismiss（Esc 收起 + 锁背景滚动）", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    document.body.innerHTML = "";
  });

  it("未打开 → 不挂 Esc、不锁滚动", () => {
    const onDismiss = vi.fn();
    renderHook(() => useOverlayDismiss(false, onDismiss));
    pressEscape();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
  });

  it("打开 → 锁滚动；Esc → 回调；关闭后还原（不是写死空串）", () => {
    // 关键：打开前 body 已被底层锁成 hidden（浮层叠开），关闭后必须还原成 hidden 而不是 ""
    document.body.style.overflow = "hidden";
    const onDismiss = vi.fn();
    const { unmount } = renderHook(() => useOverlayDismiss(true, onDismiss));
    expect(document.body.style.overflow).toBe("hidden");

    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => unmount());
    expect(document.body.style.overflow).toBe("hidden");
    document.body.style.overflow = "";
  });

  it("人工选版面板（.mp-alt-mask）在上时 Esc 让位：不关掉底层浮层", () => {
    const mask = document.createElement("div");
    mask.className = "mp-alt-mask";
    document.body.appendChild(mask);
    const onDismiss = vi.fn();
    renderHook(() => useOverlayDismiss(true, onDismiss));

    pressEscape();
    expect(onDismiss).not.toHaveBeenCalled();

    mask.remove();
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("onDismiss 不入依赖，但按 Esc 调到的是最新的那个（不是首次渲染的陈旧闭包）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => useOverlayDismiss(true, cb),
      { initialProps: { cb: first } }
    );
    // 调用方每次渲染都新建闭包（如 `() => setInfoTrack(null)`）；若 hook 把它写进依赖数组，
    // 这里会反复重挂监听（反复改写 overflow），而若写成只捕获首次又会调到陈旧的那个
    rerender({ cb: second });
    pressEscape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    document.body.style.overflow = "";
  });

  it("让位选择器可替换：换成 .my-blocker 后只认它，.mp-alt-mask 不再挡", () => {
    const mask = document.createElement("div");
    mask.className = "mp-alt-mask";
    document.body.appendChild(mask);
    const blocker = document.createElement("div");
    blocker.className = "my-blocker";
    document.body.appendChild(blocker);

    const onDismiss = vi.fn();
    renderHook(() => useOverlayDismiss(true, onDismiss, ".my-blocker"));

    // 传入的 blocker 在 → 挡住（此时 .mp-alt-mask 也在，但它已不在让位名单里）
    pressEscape();
    expect(onDismiss).not.toHaveBeenCalled();

    // 只移掉 blocker → 不再有人挡；即便 .mp-alt-mask 还在也照常关闭
    blocker.remove();
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    document.body.style.overflow = "";
  });
});

describe("useMobileGestures（迷你条上滑展开 / 整页下拉收起）", () => {
  function setup(overrides: Partial<Parameters<typeof useMobileGestures>[0]> = {}) {
    const mini = document.createElement("div");
    const page = document.createElement("div");
    document.body.append(mini, page);
    const openLyric = vi.fn();
    const closeLyric = vi.fn();
    const options = {
      isMobile: true,
      lyricOpen: false,
      miniPlayerRef: { current: mini },
      lyricPageRef: { current: page },
      openLyricRef: { current: openLyric },
      closeLyricRef: { current: closeLyric },
      ...overrides,
    } as Parameters<typeof useMobileGestures>[0];
    renderHook(() => useMobileGestures(options));
    return { mini, page, openLyric, closeLyric, options };
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("手势①：上滑超过阈值（>56px）→ 展开；非移动端形态下不挂手势", () => {
    const mobile = setup();
    fireTouch(mobile.mini, "touchstart", 300);
    fireTouch(mobile.mini, "touchmove", 200);
    expect(mobile.openLyric).toHaveBeenCalledTimes(1);

    const desktop = setup({ isMobile: false });
    fireTouch(desktop.mini, "touchstart", 300);
    fireTouch(desktop.mini, "touchmove", 100);
    expect(desktop.openLyric).not.toHaveBeenCalled();
  });

  it("手势①：位移不够 / 从控制区起手 → 不展开（避免误触）", () => {
    const { mini, openLyric } = setup();
    fireTouch(mini, "touchstart", 300);
    fireTouch(mini, "touchmove", 260); // 差 40px
    expect(openLyric).not.toHaveBeenCalled();

    const btn = document.createElement("button");
    btn.className = "mp-ctrls";
    mini.appendChild(btn);
    fireTouch(btn, "touchstart", 300);
    fireTouch(btn, "touchmove", 100);
    expect(openLyric).not.toHaveBeenCalled();
  });

  it("手势②：下拉过阈值 → 收起；不足 → 回弹（清掉 transform，不调收起）", () => {
    const { page, closeLyric } = setup({ lyricOpen: true });

    // 死区：位移 <8px 不判定方向
    fireTouch(page, "touchstart", 100);
    fireTouch(page, "touchmove", 105);
    expect(closeLyric).not.toHaveBeenCalled();

    // 未过阈值（<110px）→ 回弹
    fireTouch(page, "touchstart", 100);
    fireTouch(page, "touchmove", 160);
    fireTouch(page, "touchend", 160);
    expect(closeLyric).not.toHaveBeenCalled();
    expect(page.style.transform).toBe("");

    // 过阈值 → 收起，且打上拖拽收起的类（关掉 CSS 收起动画，由 JS 拖出屏幕）
    fireTouch(page, "touchstart", 100);
    fireTouch(page, "touchmove", 260);
    fireTouch(page, "touchend", 260);
    expect(closeLyric).toHaveBeenCalledTimes(1);
    expect(page.classList.contains("is-drag-close")).toBe(true);
  });

  it("手势②：向上滑 / 交互元素起手 / 歌词区已滚动 → 都交还给原生滚动，不收起", () => {
    const { page, closeLyric } = setup({ lyricOpen: true });

    // 向上：dy < 0
    fireTouch(page, "touchstart", 300);
    fireTouch(page, "touchmove", 200);
    fireTouch(page, "touchend", 200);
    expect(closeLyric).not.toHaveBeenCalled();

    // 交互元素起手（如整页的收起按钮 / 视图切换）
    const btn = document.createElement("button");
    page.appendChild(btn);
    fireTouch(btn, "touchstart", 100);
    fireTouch(btn, "touchmove", 300);
    fireTouch(btn, "touchend", 300);
    expect(closeLyric).not.toHaveBeenCalled();

    // 歌词区已滚过（scrollTop > 2）→ 下拉是滚歌词，不是收起
    const right = document.createElement("div");
    right.className = "mplp-right";
    const body = document.createElement("div");
    body.className = "mp-lyric-body-lg";
    Object.defineProperty(body, "scrollTop", { value: 40, writable: true });
    right.appendChild(body);
    page.appendChild(right);
    fireTouch(body, "touchstart", 100);
    fireTouch(body, "touchmove", 300);
    fireTouch(body, "touchend", 300);
    expect(closeLyric).not.toHaveBeenCalled();
  });

  it("手势②：整页未展开时不挂（避免在 DOM 里空跑拖拽监听）", () => {
    const { page, closeLyric } = setup({ lyricOpen: false });
    fireTouch(page, "touchstart", 100);
    fireTouch(page, "touchmove", 300);
    fireTouch(page, "touchend", 300);
    expect(closeLyric).not.toHaveBeenCalled();
    expect(page.style.transform).toBe("");
  });
});
