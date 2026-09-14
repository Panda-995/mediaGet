"use client";

/**
 * 极简外部 store 的订阅者集合工厂（useSyncExternalStore 配套）。
 *
 * 此前 `music-view-store.ts` 与 `favorites-store.ts` 各自手写 listeners / subscribe /
 * notify 样板；hook 层（快照 getter、服务端快照语义）两边差异较大，仍由各 store 自己写，
 * 这里只统一「订阅者集合」这一块真正的重复。
 */
import { useSyncExternalStore } from "react";

export function createExternalStore() {
  const listeners = new Set<() => void>();

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** 状态变化后通知全部订阅者 */
  function notify(): void {
    listeners.forEach((listener) => listener());
  }

  /** 单测用：清空订阅者，避免用例间互相污染 */
  function clear(): void {
    listeners.clear();
  }

  return { subscribe, notify, clear };
}

export { useSyncExternalStore };
