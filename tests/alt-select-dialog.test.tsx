// @ts-nocheck
// @vitest-environment jsdom
/**
 * 换源人工选版面板（P2-5 组件测试基础设施的第一块砖）。
 *
 * 这是仓库里**第一个渲染级测试**：此前 993 个用例全是 node 环境的纯函数 / 路由测试，
 * 组件层（含 MusicExplorer、use-player-engine）覆盖为 0 —— 拆分超长文件因此没有安全网。
 * 选 `AltSelectDialog` 打头是刻意的：它纯 props 进出（无 hook、无 store、不碰 <audio>），
 * 能先把 jsdom + RTL 跑通，而不被 Audio / matchMedia / ResizeObserver 的 mock 干扰。
 *
 * 环境按文件 opt-in（`// @vitest-environment jsdom`），`vitest.config.mts` 仍以 node 为默认，
 * 故既有 993 个用例的运行环境完全不受影响。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AltSelectDialog from "@/components/music/AltSelectDialog";
import { buildSearchChips } from "@/components/music/source-meta";

// vitest 未开 globals，RTL 的自动 cleanup 不会注册，手动挂
afterEach(cleanup);

const chips = buildSearchChips();
const item = (source: string, id: string, extra: any = {}) => ({
  source,
  id,
  name: "晴天",
  artist: ["周杰伦"],
  album: "叶惠美",
  ...extra,
});

const renderDialog = (props: any = {}) => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <AltSelectDialog
      open
      picked={item("netease", "N1")}
      alternatives={[]}
      sourceChips={chips}
      artistText={(it: any) => (it.artist || []).join(" / ") || "未知歌手"}
      onPick={onPick}
      onClose={onClose}
      {...props}
    />
  );
  return { ...view, onPick, onClose };
};

describe("AltSelectDialog 渲染", () => {
  it("open=false → 不渲染（父层由 failStage/autoTrying 推导，未打开时不应占 DOM）", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("open=true → 渲染模态，带 aria-modal 与可访问名", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("选择同曲其他版本");
  });

  it("标题带上失败曲目名；无 picked 时退化为通用文案", () => {
    const { unmount } = renderDialog({ picked: item("netease", "N1", { name: "稻香" }) });
    expect(screen.getByRole("dialog").textContent).toContain("“稻香”当前版本播放失败");
    unmount();
    renderDialog({ picked: null });
    expect(screen.getByRole("dialog").textContent).toContain("当前版本播放失败");
    expect(screen.getByRole("dialog").textContent).not.toContain("”当前版本");
  });

  it("每个候选渲染一行：来源标签 + 歌名 + 歌手·专辑，来源标签走 sourceMetaFor", () => {
    renderDialog({
      alternatives: [
        { item: item("kugou", "K1"), auto: true, provenance: "list" },
        {
          item: item("netease", "N2", { album: "" }),
          auto: false,
          provenance: "list",
        },
      ],
    });
    expect(screen.getByText("酷狗音乐")).toBeTruthy();
    expect(screen.getByText("网易云音乐")).toBeTruthy();
    expect(screen.getAllByText("晴天")).toHaveLength(2);
    // 专辑为空时不追加 " · "
    expect(screen.getByText("周杰伦 · 叶惠美")).toBeTruthy();
    expect(screen.getByText("周杰伦")).toBeTruthy();
  });

  it("artistText 由父层注入（面板不自持歌手拼接口径）", () => {
    renderDialog({
      artistText: () => "自定义歌手",
      alternatives: [{ item: item("kugou", "K1"), auto: true, provenance: "list" }],
    });
    expect(screen.getByText("自定义歌手 · 叶惠美")).toBeTruthy();
  });
});

describe("AltSelectDialog 候选徽标与注释（与自动换源的 auto 判定同源解释）", () => {
  const noteOf = (c: any) => {
    const { container } = renderDialog({ alternatives: [c] });
    return container.querySelector(".mp-alt-note")?.textContent ?? null;
  };

  it("高置信候选无注释（不会出现在面板里，万一露出也不该有注角）", () => {
    expect(noteOf({ item: item("kugou", "K1"), auto: true, provenance: "list" })).toBeNull();
    expect(
      noteOf({
        item: item("kugou", "K1"),
        auto: true,
        provenance: "multi-search",
        score: 90,
      })
    ).toBeNull();
  });

  it("队列内候选专辑不同 → 提示可能为现场 / 翻唱", () => {
    expect(noteOf({ item: item("kugou", "K1"), auto: false, provenance: "list" })).toBe(
      "专辑不同，可能为现场 / 翻唱等其他录音版本"
    );
  });

  it("跨源现搜候选：区分「专辑不同」与「置信度不足」，并打「现搜」标签", () => {
    expect(
      noteOf({
        item: item("kuwo", "W1"),
        auto: false,
        provenance: "multi-search",
        albumDiff: true,
      })
    ).toBe("跨源现搜候选：专辑不同，可能为现场 / 翻唱等其他录音，未自动尝试");
    cleanup();
    expect(
      noteOf({
        item: item("kuwo", "W1"),
        auto: false,
        provenance: "multi-search",
        score: 65,
      })
    ).toBe("跨源现搜候选：同曲置信度不足，未自动尝试");
    cleanup();
    const { container } = renderDialog({
      alternatives: [
        { item: item("kuwo", "W1"), auto: false, provenance: "multi-search" },
      ],
    });
    expect(container.querySelector(".mp-alt-tag")?.textContent).toBe("现搜");
  });

  it("共享缓存候选（曾真实播放成功过）单独标注，避免被误认成「专辑不同」的人工候选", () => {
    expect(noteOf({ item: item("kugou", "K1"), auto: true, provenance: "cache" })).toBe(
      "曾成功播放过的版本（本次自动尝试次数已用尽）"
    );
  });
});

describe("AltSelectDialog 交互", () => {
  const alt = { item: item("kugou", "K1"), auto: true, provenance: "list" };

  it("点某一行 → onPick 收到该版本（父层负责换算索引并起播）", () => {
    const { onPick } = renderDialog({ alternatives: [alt] });
    fireEvent.click(screen.getByTitle("播放 晴天"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ source: "kugou", id: "K1" });
  });

  it("点关闭按钮 → onClose（保留当前曲目不动）", () => {
    const { onClose } = renderDialog({ alternatives: [alt] });
    fireEvent.click(screen.getByLabelText("关闭选版面板"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩空白处 → onClose；点卡片内部 → 不关闭（stopPropagation）", () => {
    const { container, onClose } = renderDialog({ alternatives: [alt] });
    const mask = container.querySelector(".mp-alt-mask");
    const card = container.querySelector(".mp-alt-card");
    fireEvent.mouseDown(card);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(mask);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
