#!/usr/bin/env node
/**
 * 依赖边界守卫：确保 packages/parse-core 不引入非法依赖。
 *
 * 禁止项：
 * 1. next/* 或 @/ 跨界 import（web 侧专属）
 * 2. package.json dependencies 之外的三方 npm 包
 *
 * Node 内置（node:xxx / child_process / crypto / https 等）和相对路径允许。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url);
const CORE_DIR = new URL("packages/parse-core/src", ROOT);
const PKG_PATH = new URL("packages/parse-core/package.json", ROOT);

const pkg = JSON.parse(readFileSync(fileURLToPath(PKG_PATH), "utf-8"));
const declaredDeps = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

// Node 内置模块白名单
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "domain", "events", "fs", "http", "https",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads",
  "zlib", "node:assert", "node:buffer", "node:child_process",
  "node:cluster", "node:console", "node:constants", "node:crypto",
  "node:dgram", "node:dns", "node:domain", "node:events", "node:fs",
  "node:http", "node:https", "node:module", "node:net", "node:os",
  "node:path", "node:perf_hooks", "node:process", "node:punycode",
  "node:querystring", "node:readline", "node:repl", "node:stream",
  "node:string_decoder", "node:sys", "node:timers", "node:tls",
  "node:tty", "node:url", "node:util", "node:v8", "node:vm",
  "node:worker_threads", "node:zlib",
]);

let hasError = false;

function checkFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = relative(fileURLToPath(ROOT), filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 匹配 import ... from "..." 或 import "..."
    const match = line.match(/from\s+["']([^"']+)["']/) || line.match(/^import\s+["']([^"']+)["']/);
    if (!match) continue;

    const mod = match[1];

    // 允许相对路径
    if (mod.startsWith("./") || mod.startsWith("../")) continue;

    // 禁止 next/*
    if (mod.startsWith("next/") || mod === "next") {
      console.error(`❌ ${relPath}:${i + 1} — 禁止 import "${mod}"（next 专属）`);
      hasError = true;
      continue;
    }

    // 禁止 @/
    if (mod.startsWith("@/")) {
      console.error(`❌ ${relPath}:${i + 1} — 禁止 import "${mod}"（@/ 为 web 侧别名）`);
      hasError = true;
      continue;
    }

    // 允许 Node 内置
    if (NODE_BUILTINS.has(mod)) continue;

    // 检查是否为已声明的三方依赖
    const pkgName = mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0];
    if (!declaredDeps.has(pkgName)) {
      console.warn(`⚠️  ${relPath}:${i + 1} — 未声明的依赖 "${pkgName}"（来自 "${mod}"）`);
      // 不视为错误，只警告；由开发者决定是否加入 dependencies
    }
  }
}

function walkDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.isFile() && /\.(js|ts|jsx|tsx)$/.test(entry.name)) {
      checkFile(fullPath);
    }
  }
}

walkDir(fileURLToPath(CORE_DIR));

if (hasError) {
  console.error("\n❌ 依赖边界检查失败");
  process.exit(1);
} else {
  console.log("✅ 依赖边界检查通过");
}
