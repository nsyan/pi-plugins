// core/doctor.ts —— 本机能力体检。不连接远端。
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function ok(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按 PATH 找可执行文件，和 spawn 用裸命令名时的查找方式一致。
 * 不能写死 /usr/bin：Homebrew、/usr/local/bin、NixOS 都不在那里，
 * 写死会把实际可用的 ssh 报成不可用。
 */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (ok(candidate, constants.X_OK)) return candidate;
  }
  return undefined;
}

/** openssh 传输依赖这三个：ssh 跑命令，scp 传文件，sftp 列目录和按行读。 */
function opensshLines(): string[] {
  const found = ["ssh", "scp", "sftp"].map((name) => ({ name, path: which(name) }));
  const missing = found.filter((item) => !item.path).map((item) => item.name);
  if (missing.length === 0) {
    return [`本机 openssh 可用（${found.map((item) => item.path).join("、")}）`];
  }
  const present = found.filter((item) => item.path);
  return [
    `PATH 里缺 ${missing.join("、")}，openssh 传输不可用${present.length > 0 ? `（只找到 ${present.map((item) => item.path).join("、")}）` : ""}。` +
    "需要 ProxyJump、证书或 ssh-agent 时请装上，否则把主机的 transport 设成 ssh2。",
  ];
}

function keychainLine(): string {
  if (process.platform === "linux") {
    const tool = which("secret-tool");
    return tool
      ? `钥匙串可读写（${tool}）`
      : "没有 secret-tool，密码只进 0600 的 ssh-secrets.json";
  }
  if (process.platform === "darwin") {
    const tool = which("security");
    return tool
      ? `钥匙串可读取已有项（${tool}）；新密码不进 security 的进程参数，写入 0600 的 ssh-secrets.json`
      : "没有 security，密码只进 0600 的 ssh-secrets.json";
  }
  return "当前系统没有钥匙串，密码只进 0600 的 ssh-secrets.json";
}

export function doctorLines(): string[] {
  const lines = [`node ${process.version}`];
  try {
    createRequire(import.meta.url)("ssh2");
    lines.push("ssh2 可用");
  } catch {
    lines.push("ssh2 不可用");
  }
  lines.push(...opensshLines());
  const known = join(homedir(), ".ssh", "known_hosts");
  lines.push(ok(join(homedir(), ".ssh"), constants.W_OK) ? `known_hosts 目录可写（${known}）` : "~/.ssh 不可写，首次连接无法记录主机密钥");
  const auditDir = join(homedir(), ".pi", "agent");
  lines.push(ok(auditDir, constants.W_OK) ? "审计目录可写" : "审计目录不可写，生产主机的破坏性操作会被拒绝");
  lines.push(keychainLine());
  return lines;
}
