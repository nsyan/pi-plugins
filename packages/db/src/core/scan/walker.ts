// scan/walker.ts —— 目录漫步：默认忽略常见无关目录；resolveRoot 越界拒绝（Spec §8.5 红线）
import { readdirSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "target", "dist", "venv", "logs", "docs",
  "build", "coverage", "__pycache__", ".idea", ".vscode",
]);

const MAX_FILES = 2000;
const MAX_DEPTH = 8;

/**
 * 把输入路径解析为绝对路径；越界（cwd 子树之外、`..` 上跳、cwd 本身除外）
 * 直接抛 "scan path out of scope"——与「密码不进上下文」同级别的红线。
 */
export function resolveRoot(input: string): string {
  const cwd = process.cwd();
  const abs = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`scan path out of scope: ${input}`);
  }
  return abs;
}

/** 递归收集文本候选文件（忽略无关目录与隐藏目录，上限 MAX_FILES）。 */
export function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      if (e.isDirectory() && e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile()) {
        try { if (statSync(p).isFile()) out.push(p); } catch { /* ignore */ }
        if (out.length >= MAX_FILES) return;
      }
    }
  };
  visit(root, 0);
  return out;
}
