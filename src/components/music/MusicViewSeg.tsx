"use client";

import {
  MUSIC_VIEWS,
  setMusicView,
  useMusicView,
  type MusicView,
} from "@/components/music/music-view-store";
import { cn } from "@/lib/utils";

/**
 * 音乐页视图切换器（发现歌曲 / 播放列表）。
 * 渲染在 /music 内容区顶部功能区左上角，与 MusicExplorer 共享外部 store 状态：
 * 用户提交搜索后视图会自动切到「播放列表」，按钮高亮随之联动。
 *
 * 本组件**只切换、不恢复**：视图偏好的挂载恢复统一由 MusicExplorer 的挂载恢复
 * 流程负责（见 music-view-store.restoreMusicView）。放在这里做会因「子组件 effect
 * 先于父组件执行」而被父组件的挂载恢复覆盖，刷新落点不可预测。
 *
 * @param initialView 服务端从 Cookie 读到的落点，由 MusicExplorer 透传。必须给：
 * 否则服务端渲染的按钮高亮只能是默认「发现歌曲」，水合后再被 store 里的真实值纠正
 * ——即使用页面板已经对了，这里还会单独闪一下高亮。
 */
export default function MusicViewSeg({ initialView }: { initialView?: MusicView }) {
  const view = useMusicView(initialView);
  return (
    <div
      role="group"
      aria-label="音乐页视图"
      className="flex flex-none items-center gap-0.5 rounded-[10px] bg-black/5 p-[3px] dark:bg-white/10">
      {MUSIC_VIEWS.map((option) => {
        const active = view === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            title={active ? `当前页面：${option.label}` : `切换到${option.label}`}
            onClick={() => setMusicView(option.key)}
            className={cn(
              "whitespace-nowrap rounded-lg px-1.5 py-1 text-[11px] font-medium transition-colors sm:px-2.5 sm:text-xs",
              active
                ? "bg-white text-primary shadow-sm dark:bg-white/20 dark:shadow-none"
                : "text-secondary hover:text-primary"
            )}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
