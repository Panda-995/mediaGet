import withSerwistInit from "@serwist/next";

// Serwist 取代已停止维护的 next-pwa：SW 仍由 webpack 插件在构建期产出到 public/sw.js。
// Next 16 默认 Turbopack，webpack 插件只有 `next build --webpack` 才会执行（见 package.json）。
const withSerwist = withSerwistInit({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  // 开发模式下关闭 SW，避免缓存干扰热更新（与旧 next-pwa 行为一致）；
  // 同时这也是 @serwist/next 在 Turbopack dev 下不告警的条件。
  disable: process.env.NODE_ENV === "development",
  // 页面跳转时按需缓存，配合 SW 内的 NetworkFirst 文档策略
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 真机联调（iOS Safari 经局域网 IP 直连 dev server）：dev 资源与 RSC 端点默认只
  // 放行 localhost，来自局域网 IP 的请求会被挡下，表现为「页面能开但取直链接口挂」。
  // 只按 hostname 匹配（无协议、无端口），`*` 匹配一个 label。仅 dev 生效。
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],
  // standalone：构建时裁剪出最小运行时依赖（仅生产所需 node_modules 子集），
  // 配合多阶段 Dockerfile，让生产镜像不含 devDependencies，体积更小、攻击面更低。
  output: "standalone",
  // Docker 滚动发布时若每次构建 ID 都不同，旧容器与新容器混跑会导致
  // Server Action / RSC 与「找不到 action」类错误。构建时传入稳定 ID（如 git sha）。
  generateBuildId: async () => {
    return (
      process.env.NEXT_BUILD_ID ||
      process.env.BUILD_ID ||
      `build-${Date.now()}`
    );
  },
  images: {
    // Cloudflare Workers 上无内置图片优化器，禁用优化、原图直出（配合前端 <Image unoptimized>）。
    // 注意：unoptimized 为 true 时 remotePatterns 完全不参与校验（没有请求会走优化器），
    // 此前手写的 12 组图床 remotePatterns 属死配置，已删除；若日后开启优化需一并补回。
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: ["tailwindcss"],
  },
};

export default withSerwist(nextConfig);
