// core/doctor.ts —— 本机能力体检。不连接远端。
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

function ok(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function keychainLine(): string {
  if (process.platform === "linux") {
    return ok("/usr/bin/secret-tool", constants.X_OK)
      ? "钥匙串 secret-tool 可读写"
      : "没有 secret-tool，密码只进 0600 的 ssh-secrets.json";
  }
  if (process.platform === "darwin") {
    return ok("/usr/bin/security", constants.X_OK)
      ? "钥匙串可读取已有项；新密码不进 security 的进程参数，写入 0600 的 ssh-secrets.json"
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
  lines.push(ok("/usr/bin/ssh", constants.X_OK) ? "本机 ssh 可用" : "本机没有 /usr/bin/ssh，openssh 传输不可用");
  const known = join(homedir(), ".ssh", "known_hosts");
  lines.push(ok(join(homedir(), ".ssh"), constants.W_OK) ? `known_hosts 目录可写（${known}）` : "~/.ssh 不可写，首次连接无法记录主机密钥");
  const auditDir = join(homedir(), ".pi", "agent");
  lines.push(ok(auditDir, constants.W_OK) ? "审计目录可写" : "审计目录不可写，生产主机的破坏性操作会被拒绝");
  lines.push(keychainLine());
  return lines;
}
