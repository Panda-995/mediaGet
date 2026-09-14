"use client";

import type { MouseEvent } from "react";
import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { musicKey } from "@/lib/music-match";
import type { SearchItem } from "@/lib/client/music-client";
import IconButton from "./IconButton";
import { toggleFavoriteItem, useFavorites } from "./favorites-store";

export interface FavoriteButtonProps {
  /** 目标曲目。为空（无在播内容）时按钮禁用 */
  item: SearchItem | null;
  /** 附加类名：三处落点各自决定尺寸与显隐（.mp-fav / .mp-ptrack .mp-like 等） */
  className?: string;
  /** 自定义提示文案；默认按收藏态生成「收藏 / 取消收藏 <歌名>」 */
  title?: string;
  /** 动作完成回调：供父层弹轻提示（added = 本次是否加入到收藏） */
  onToggled?: (result: { added: boolean; persistFailed: boolean }) => void;
}

/**
 * 收藏星标按钮：自持状态（读 `favorites-store`，不接收 `active` / `onToggle` 之类的 props），
 * 因此结果行 / 正在播放卡片 / 底部播放条三处都只需给一个 `item`。
 *
 * 两个交互要点：
 * - **必须 `stopPropagation`**：它嵌在「整行即播放按钮」的结果行里，不拦截冒泡就会点星变播放；
 * - **挂载读盘前不去禁用**：禁用会让首帧后按钮突兀地由灰变亮；未水合时点击由 store 内部
 *   兜底先补读盘（见 `toggleFavoriteItem`），语义安全。
 */
export default function FavoriteButton({
  item,
  className,
  title,
  onToggled,
}: FavoriteButtonProps) {
  const { keys } = useFavorites();
  const active = !!item && keys.has(musicKey(item));

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!item) return;
    onToggled?.(toggleFavoriteItem(item));
  };

  const label = item ? item.name : "";
  return (
    <IconButton
      className={cn("mp-fav", active && "is-fav", className)}
      active={active}
      ariaPressed={active}
      disabled={!item}
      onClick={handleClick}
      title={title ?? (active ? `取消收藏 ${label}` : `收藏 ${label}`)}
      ariaLabel={active ? `取消收藏 ${label}` : `收藏 ${label}`}>
      {/* 实心 / 描边表达收藏态：形状差异不依赖颜色，色盲与高对比模式下同样可辨 */}
      <Heart fill={active ? "currentColor" : "none"} />
    </IconButton>
  );
}
