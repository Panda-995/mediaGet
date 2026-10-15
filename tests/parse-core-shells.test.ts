/**
 * parse-core 薄壳一致性守卫（桌面化的耦合面）。
 *
 * 真源在 packages/parse-core/src/**，web 侧 src/{lib,types,config,utils} 只留
 * 2 行 re-export 薄壳；桌面仓（mediaGet-desktop）经 `@/lib/*` 物理链接穿过这些
 * 薄壳消费内核。任何一侧掉链子（新增内核模块忘了配壳、壳指错路径、壳被改成
 * 第二份实现）都会让桌面解析在运行时才炸——所以在这里、在提交时就拦住。
 *
 * 三条不变式：
 * 1. 包内每个源文件恰好被一个薄壳转发，且没有指向不存在真源的孤儿壳；
 * 2. 薄壳必须是「纯转发」：只有注释 + 单行 export * from，不得夹实现；
 * 3. 注册表覆盖识别面全平台（桌面 localCoverage 据此声称「全本地」）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = "src";
const PKG = "packages/parse-core/src";
const SHELL_DIRS = ["lib", "types", "config", "utils"];
/**
 * 包内入口文件，不需要 web 侧薄壳：index.ts 是工件发布用的 exports 白名单，
 * 物理链接期无人 import（其余包内模块一律要求有壳，见下方不变式 1）。
 */
const PKG_EXEMPT = ["index.ts"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const forwardRe = /^export \* from "\.\.\/\.\.\/packages\/parse-core\/src\/([^"]+)";$/;

/**
 * 解析一个 src 文件：是薄壳则返回其转发目标（包内相对路径，无扩展名）。
 * 非纯转发（除注释外还有别的语句、或不止一条 export）→ pure=false。
 */
function inspectShell(file: string): { target: string | null; pure: boolean; extra: string } {
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("/*") && !l.startsWith("*/") && !l.startsWith("//"));
  const exports = lines.filter((l) => l.startsWith("export"));
  const others = lines.filter((l) => !l.startsWith("export"));
  const one = exports.length === 1 ? exports[0].match(forwardRe) : null;
  return {
    target: one ? one[1].replace(/\.(js|ts)$/, "") : null,
    pure: exports.length === 1 && others.length === 0 && !!one,
    extra: [...others, ...exports.filter((e) => !forwardRe.test(e))].join("\n"),
  };
}

/** 包内文件 → 薄壳目标 id（去扩展名） */
const pkgId = (file: string) => relative(PKG, file).split(sep).join("/").replace(/\.(js|ts)$/, "");

describe("parse-core 薄壳 ↔ 真源 一一对应", () => {
  const shells = SHELL_DIRS.flatMap((d) => {
    const root = join(SRC, d);
    return existsSync(root) ? walk(root) : [];
  })
    .map((f) => ({ file: f, ...inspectShell(f) }))
    .filter((s) => readFileSync(s.file, "utf8").includes("packages/parse-core"));

  it("包内每个源文件都被恰好一个 web 薄壳转发", () => {
    const pkgFiles = walk(PKG).filter((f) => !PKG_EXEMPT.includes(relative(PKG, f).split(sep).join("/")));
    const problems: string[] = [];
    for (const id of pkgFiles.map(pkgId)) {
      const hits = shells.filter((s) => s.target === id);
      if (hits.length === 0) problems.push(`${id}: 没有薄壳转发（web/desktop 侧按原路径取不到该模块）`);
      if (hits.length > 1) problems.push(`${id}: 被多个薄壳转发 ${hits.map((h) => h.file).join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("每个薄壳都纯转发到存在的真源", () => {
    const problems: string[] = [];
    for (const s of shells) {
      if (!s.pure) {
        problems.push(`${s.file}: 不是纯转发（只允许注释 + 一行 export * from），多余内容：\n${s.extra}`);
        continue;
      }
      const hit = [".js", ".ts"].some((ext) => existsSync(join(PKG, s.target! + ext)));
      if (!hit) problems.push(`${s.file}: 转发的 ${PKG}/${s.target}.{js,ts} 不存在`);
    }
    expect(problems).toEqual([]);
  });

  it("桌面消费的入口存在：@/lib/unifiedCore → parse-core 统一入口", () => {
    expect(existsSync("src/lib/unifiedCore.js")).toBe(true);
    expect(existsSync("packages/parse-core/src/lib/unified-core.js")).toBe(true);
    expect(existsSync("packages/parse-core/src/lib/parser-registry.js")).toBe(true);
  });

  it("注册表覆盖识别面全平台 + 汽水音乐特判，且每项可调用", async () => {
    const { PLATFORM_INFO } = await import("@/lib/platforms");
    const { localParserKeys } = await import("@/lib/unifiedCore");
    const { parserRegistry } = await import("@/lib/parserRegistry");
    const keys = new Set(localParserKeys());
    expect(Object.keys(PLATFORM_INFO).filter((p) => !keys.has(p))).toEqual([]);
    expect(keys.has("qsmusic")).toBe(true);
    for (const [, fn] of Object.entries(parserRegistry as Record<string, unknown>)) {
      expect(typeof fn).toBe("function");
    }
  });
});
