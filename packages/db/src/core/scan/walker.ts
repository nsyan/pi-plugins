// scan/walker.ts —— 目录漫步：默认忽略常见无关目录；resolveRoot 越界拒绝（Spec §8.5 红线）
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

// 忽略的目录：只列**确定无关**的（依赖/构建产物/版本控制元数据/工具缓存）。
// 注意 docs 不在此列：本模块不对「目录名是否与配置有关」做猜测（见 tree.ts 设计注释），
// 配置样例/真实配置放 docs 下的项目是存在的，漏扫比多扫代价大。
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "target", "dist", "venv", ".venv", "logs",
  "build", "coverage", "__pycache__", ".idea", ".vscode", ".next", ".nuxt", ".cache",
  ".gradle", ".tox", ".pytest_cache", ".mypy_cache", ".turbo", ".parcel-cache", ".sass-cache",
]);

const MAX_FILES = 2000;
/** 目录访问预算：软链别名会重复走到同一个真实目录（见 walk 的断环说明），
 *  需要一个上界防止病态目录图把扫描拖死；超限经 depthCapped 上报，不静默。 */
const MAX_DIRS = 20000;
/** 深度上限：Java 多模块可达 `m/src/main/java/com/x/.../service/mapper/impl`（实测 14 层）、
 *  monorepo 嵌套更深；超限会通过 depthCapped 如实上报。导出供工具提示引用，避免硬编码层数漂移。 */
export const MAX_DEPTH = 16;

/** 扫描目标配置文件：不受普通文件配额挤占（大型 Java 工程源码文件可轻易冲爆 MAX_FILES） */
const CONFIG_EXTS = new Set([".yml", ".yaml", ".properties"]);
function isConfigFile(name: string): boolean {
  const base = name.toLowerCase();
  return base === ".env" || base.startsWith(".env.") || CONFIG_EXTS.has(extname(base));
}

/** target 是否在 base 子树内（纯路径判定，用于拦住软链逃逸） */
function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * 把输入路径解析为绝对路径；越界（anchor 子树之外、`..` 上跳）直接抛
 * "scan path out of scope"——与「密码不进上下文」同级别的红线。
 *
 * anchor 必须由调用方显式传入「会话工作目录」（pi 的 `ctx.cwd`），不能取 `process.cwd()`：
 * 扩展与 pi 主进程同进程，`process.cwd()` 是**宿主进程的 OS cwd**。pi-web 下宿主 cwd 是
 * pi-web 包目录、TUI 下是 pi 的启动目录，都与会话 cwd 不同源（会话 cwd 存在 session header
 * 里，`/resume` 后可与启动目录不同）。锚错对象的后果是双向的：
 *   - fail-closed：项目路径全被拒（pi-web 下的必然结果）；
 *   - fail-open：宿主 cwd 子树反而被放行——红线保护了不相干的目录树。
 * 因此锚点只能来自 `ctx.cwd`，绝不能由模型传入的 input 反推。
 *
 * 判定分两道：
 *   ① 字面路径必须在 anchor 子树内（拦 `..` 上跳与绝对路径）；
 *   ② **真实路径**（realpath）也必须在 anchor 的真实路径子树内——字面合法 ≠ 真实位置合法：
 *      仓库里一个 `dbconf -> /etc` 的软链会让 abs 字面在子树内、真实位置在外（仅比对
 *      「root 的 realpath 与其子项」会让软链扫描根自我授权）。两端都取 realpath 再比对，
 *      因此「项目本身位于软链路径下」（如 macOS `/tmp → /private/tmp`）不会被误伤。
 */
export function resolveRoot(input: string, anchor: string): string {
  const cwd = resolve(anchor);
  const abs = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const rel = relative(cwd, abs);
  // 注意：不能写 rel.startsWith("..")——cwd 内合法的 `..foo/` 也会命中前缀，属假阳性误杀
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`scan path out of scope: ${input}（允许根目录: ${cwd}）`);
  }
  let anchorReal: string;
  try { anchorReal = realpathSync(cwd); } catch { throw new Error(`scan anchor does not exist: ${cwd}`); }
  let absReal: string;
  try { absReal = realpathSync(abs); } catch { throw new Error(`scan path does not exist: ${input}`); }
  if (!within(anchorReal, absReal)) {
    throw new Error(`scan path out of scope: ${input}（真实路径 ${absReal} 不在允许根目录 ${anchorReal} 子树内）`);
  }
  return abs;
}

export interface WalkResult {
  files: string[];
  /** 是否有目录未展开（超 MAX_DEPTH 深度上限或 MAX_DIRS 目录预算），静默截断会让模型误判「项目里没有更深的配置」 */
  depthCapped: boolean;
}

/** 递归收集文本候选文件（上限 MAX_FILES）；配置类文件单独收集不被挤占。
 * 与 v1.3.1 的行为差异：
 *   ① 不再跳过 `.` 开头的目录（`.config/db.yml` 这类配置此前永远扫不到），改为靠 IGNORED_DIRS 排噪；
 *   ② 软链不再静默忽略：目标 realpath 在 root 子树内则按真实类型访问（拦越界逃逸）；
 *   ③ 深度超限不再静默：通过 depthCapped 如实上报；
 *   ④ 输出确定：目录项排序 + 只用祖先链断环（不做全局 realpath 去重），
 *      真目录与软链别名两条路径都保留，不随文件系统的 readdir 顺序变化。*/
export function walk(root: string): WalkResult {
  const out: string[] = [];
  const configs: string[] = [];
  let rootReal = resolve(root);
  try { rootReal = realpathSync(root); } catch { /* root 不存在时由 readdir 兜底 */ }
  let depthCapped = false;
  let dirsVisited = 0;

  const push = (path: string, isConfig: boolean): void => {
    if (isConfig) {
      if (configs.length < MAX_FILES) configs.push(path);
    } else if (out.length < MAX_FILES) {
      out.push(path);
    }
  };

  /**
   * ancestors 只装「当前遍历路径上」的目录 realpath，用于断环，**不做全局去重**：
   * 全局去重会让真目录与软链别名按 readdir 顺序互相吞掉（谁先遍历到谁赢），
   * 同一项目因此在 APFS/ext4 上产出不同的文件树——别名路径照样要走，只是不能成环。
   */
  const visit = (dir: string, depth: number, ancestors: ReadonlySet<string>): void => {
    if (depth > MAX_DEPTH || dirsVisited >= MAX_DIRS) { depthCapped = true; return; }
    let real: string;
    try { real = realpathSync(dir); } catch { return; }
    if (ancestors.has(real)) return;   // 软链环（a/self -> a）：断环即可
    dirsVisited++;
    const next = new Set(ancestors);
    next.add(real);
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // readdir 顺序随文件系统而变（APFS 插入序 / ext4 哈希序），排序后文件树才是确定的
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { visit(p, depth + 1, next); continue; }
      if (e.isFile()) { push(p, isConfigFile(e.name)); continue; }
      // 软链：readdir 的 Dirent 对软链 isDirectory/isFile 均为 false，需按 realpath 判定。
      // 指向 root 子树之外的一律忽略——扫描目录树不能成为越界的第二个入口。
      if (!e.isSymbolicLink()) continue;
      let target: string;
      try { target = realpathSync(p); } catch { continue; }
      if (!within(rootReal, target)) continue;
      let targetIsDir = false, targetIsFile = false;
      try {
        const st = statSync(target);
        targetIsDir = st.isDirectory();
        targetIsFile = st.isFile();
      } catch { continue; }
      if (targetIsDir) visit(p, depth + 1, next);
      // 软链文件名可能不带配置后缀（.env 被链接成 env.local）：名字与目标名任一像配置就按配置收
      else if (targetIsFile) push(p, isConfigFile(e.name) || isConfigFile(basename(target)));
    }
  };
  visit(root, 0, new Set<string>());
  return { files: [...configs, ...out], depthCapped };
}
