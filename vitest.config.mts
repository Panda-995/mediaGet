import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/live/setup-dotenv.ts", "./tests/setup-unit.ts"],
  },
  // 组件测试（.tsx）用 JSX：tsconfig 的 jsx 是 Next 要求的 "preserve"，此处必须覆写成
  // automatic runtime，否则 JSX 被原样保留、下游解析直接失败（Vite 8 起转换器是 oxc，
  // `esbuild.jsx` / `tsconfigRaw` 不再生效，必须走 `oxc.jsx`）。
  oxc: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": resolve(rootDir, "./src"),
    },
  },
});
