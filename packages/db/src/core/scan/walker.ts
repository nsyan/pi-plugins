// scan/walker.ts —— 目录漫步：默认忽略常见无关目录；resolveRoot 越界拒绝（Spec §8.5 红线）
import { readdirSync, statSync, type Dirent } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "target", "dist", "venv", "logs", "docs",
  "build", "coverage", "__pycache__", ".idea", ".vscode",
]);

const MAX_FILES = 2000;
const MAX_DEPTH = 8;

/** 扫描目标配置文件：不受普通文件配额挤占（大型 Java 工程源码文件可轻易冲爆 MAX_FILES） */
const CONFIG_EXTS = new Set([".yml", ".yaml", ".properties"]);
function isConfigFile(name: string): boolean {
  const base = name.toLowerCase();
  return base === ".env" || base.startsWith(".env.") || CONFIG_EXTS.has(extname(base));
}

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

/** 递归收集文本候选文件（忽略无关目录与隐藏目录，上限 MAX_FILES）；配置类文件单独收集不被挤占 */
export function walk(root: string): string[] {
  const out: string[] = [];
  const configs: string[] = [];
  const visit = (dir: string, depth: number): void => {
    // 不因 out 满而提前返回：必须走完整棵树，否则后遍历到的目录里的配置文件永远收不到
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      if (e.isDirectory() && e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile()) {
        try {
          if (statSync(p).isFile()) {
            if (isConfigFile(e.name)) {
              if (configs.length < MAX_FILES) configs.push(p);
            } else if (out.length < MAX_FILES) {
              out.push(p);
            }
          }
        } catch { /* ignore */ }
      }
    }
  };
  visit(root, 0);
  return [...configs, ...out];
}
