// core/deploy.ts —— 发布路径和压缩包成员检查。只判断，不连远端。
import { withinRoot } from "./guard.js";

export interface ReleaseLayout {
  root: string;
  releasesDir?: string;
  currentLink?: string;
  sharedDir?: string;
}

export interface ReleasePlan {
  releaseDir: string;
  releasesDir: string;
  currentLink: string;
  sharedDir: string;
  partPath: string;
}

function clean(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function planRelease(layout: ReleaseLayout, releaseId: string, fileName: string): ReleasePlan {
  const releases = clean(layout.releasesDir ?? "releases");
  const current = clean(layout.currentLink ?? "current");
  const shared = clean(layout.sharedDir ?? "shared");
  const releaseDir = `${layout.root}/${releases}/${releaseId}`;
  assertInside(layout.root, [releaseDir, `${layout.root}/${current}`, `${layout.root}/${shared}`]);
  return {
    releaseDir,
    releasesDir: `${layout.root}/${releases}`,
    currentLink: `${layout.root}/${current}`,
    sharedDir: `${layout.root}/${shared}`,
    partPath: `${releaseDir}.part`,
  };
}

/** 部署根内的文件收进 .pi-ssh-backup，其余放在同目录的 .bak。 */
export function backupLocation(remotePath: string, root?: string, stamp = Date.now()): string {
  if (root && withinRoot(root, remotePath)) {
    return `${root}/.pi-ssh-backup/${remotePath.slice(root.length + 1)}.${stamp}`;
  }
  return `${remotePath}.bak.${stamp}`;
}

/**
 * 部署失败时清理本次的半成品：只删这个 release 目录与它的 `.part`。
 * 必须只针对本次 releaseId——`releases/` 里还有上一版，多删一个就等于毁掉回滚点。
 * 失败后留下的空 release 目录会被 `ssh_rollback` 当成有效候选，也会被 `keepReleases` 算进配额，
 * 所以上传成功到切软链之间任何一步失败都要调这里。
 */
export function discardPartialCommand(plan: ReleasePlan): string {
  return `rm -rf ${quote(plan.releaseDir)} ${quote(plan.partPath)}`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** 同一路径只留最近 keep 份。返回要删的文件名，不含目录。 */
export function staleBackups(names: string[], fileName: string, keep = 3): string[] {
  const mine = names.filter((name) => {
    const mark = name.lastIndexOf(".");
    if (mark <= 0) return false;
    const stamp = name.slice(mark + 1);
    const stem = name.slice(0, mark);
    if (!/^\d+$/.test(stamp)) return false;
    return stem === fileName || stem === `${fileName}.bak`;
  });
  return mine.sort().slice(0, Math.max(0, mine.length - keep));
}

/** 健康检查的预算（秒）。在这个窗口内反复跑，退出码 0 即通过。 */
export const HEALTH_BUDGET_SEC = 60;

/**
 * 把 healthCmd 包成远端循环，一次往返。
 * 最后一轮的输出保留在 stdout，失败时能看到原因。
 */
export function healthLoopCommand(healthCmd: string, timeoutSec = HEALTH_BUDGET_SEC): string {
  const ticks = Math.max(1, Math.floor(timeoutSec));
  return [
    `i=0; while [ "$i" -lt ${ticks} ]; do`,
    `  if { ${healthCmd}; } >/dev/null 2>&1; then exit 0; fi`,
    "  i=$((i+1))",
    `  [ "$i" -lt ${ticks} ] && sleep 1`,
    "done",
    healthCmd,
    "exit 1",
  ].join("\n");
}

/**
 * 压缩包里任一成员逃出目标目录，整包拒绝。绝对路径和 `..` 都算逃逸。
 * 空行必须在这里滤掉：`tar -tzf` 的输出总以换行结尾，split 之后最后一项是空串，
 * 当成成员会让任何一个合法压缩包都被判越界。
 */
export function rejectArchiveMembers(members: string[], destination: string): string[] {
  return members
    .map((member) => member.trim())
    .filter((value) => value !== "")
    .filter((value) => {
      if (value.startsWith("/") || value.includes("\\")) return true;
      return !withinRoot(destination, `${destination}/${value}`) && normalizeMember(value) !== "";
    });
}

function normalizeMember(value: string): string {
  return value
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

export function releaseIdNow(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

export function checkReleaseId(releaseId: string): void {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(releaseId)) throw new Error(`发布号只能包含字母、数字、点、下划线和横线：${releaseId}`);
}

function assertInside(root: string, paths: string[]): void {
  for (const path of paths) {
    if (!withinRoot(root, path)) throw new Error(`发布路径越出部署根目录：${path}`);
  }
}
