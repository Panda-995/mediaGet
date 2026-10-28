/// <reference lib="webworker" />
import { NetworkFirst, NetworkOnly, StaleWhileRevalidate, Serwist } from "serwist";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // 构建期由 webpack 插件替换成实际的预缓存清单
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // 解析 API 与代理：绝不在 SW 层缓存（视频流/音频流/接口不应被缓存），
    // 必须排在所有静态资源规则之前——Serwist 按顺序取第一条命中的规则。
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/"),
      method: "GET",
      handler: new NetworkOnly(),
    },
    // 页面导航：网络优先，超时回退缓存
    {
      matcher: ({ request }) => request.destination === "document",
      handler: new NetworkFirst({
        cacheName: "pages",
        networkTimeoutSeconds: 10,
      }),
    },
    // 静态资源：后台重新校验
    {
      matcher: ({ request }) =>
        ["style", "script", "worker", "image", "font"].includes(
          request.destination
        ),
      handler: new StaleWhileRevalidate({ cacheName: "assets" }),
    },
  ],
});

serwist.addEventListeners();
