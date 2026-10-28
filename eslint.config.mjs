import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  // Next 16 起 eslint-config-next 直接导出 flat config，不再需要 FlatCompat 包一层
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // React Compiler 规则（Next 16 起随 eslint-config-next 默认 error）：本仓库大量
    // 「挂载后同步客户端状态」与 latest-value ref 写法，属水合安全的历史模式，改造需
    // 逐个换成惰性初始化 / useSyncExternalStore，另行排期。降级为 warn 保持可见，
    // 不让升级 PR 卡在无关重构上。
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    // 测试文件：mock / 桩 / 第三方响应形状大量依赖 `any` 与 `@ts-nocheck`，
    // 强行类型化会把样板放大数倍、且把注意力从被测行为挪到类型体操上。
    // 这里降级为 warn（仍可见、不计入失败），「未使用变量」这类真错误保持 error。
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
    },
  },
];

export default eslintConfig;
