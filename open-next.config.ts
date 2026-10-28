import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// 站点为 SSG + API 模式：静态页由 ASSETS 绑定直出，API 全为 dynamic，
// 无 ISR / 增量缓存需求，故不配置 incrementalCache / queue / tagCache（无需 R2/KV/DO）。
// 解析结果缓存是应用层自己的 Cache API 封装（src/lib/result-cache.js），与本配置无关。
// 日后若要 ISR：incrementalCache 用 @opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache
// 并补 R2 绑定；需要 tag 失效再引入 DO 队列。
export default defineCloudflareConfig({});
