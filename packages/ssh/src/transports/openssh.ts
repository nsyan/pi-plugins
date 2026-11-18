// transports/openssh.ts —— 调用本机 ssh。继承 ~/.ssh/config、代理跳转和密钥。
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellQuote, wrapWithWatchdog } from "../core/guard.js";
import { parseRemoteHash, remoteHashCommand, sha256File } from "../core/hash.js";
import { TransferMismatchError, UnsupportedError, type HostProfile } from "../core/types.js";

export function controlPath(): string {
  const dir = join(homedir(), ".pi", "agent", "ssh-cm");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return join(dir, "%C");
}

function sshOptions(profile: HostProfile): string[] {
  if (profile.auth.kind === "password") {
    throw new UnsupportedError("openssh 传输不接受密码或 MFA。需要密码时改用 ssh2；ProxyJump、证书和 agent 继续走 openssh。");
  }
  return [
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath()}`,
    "-o", "ControlPersist=5m",
  ];
}

export interface OpenSshRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function execOpenSsh(profile: HostProfile, request: OpenSshRequest): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const remote = request.cwd ? `cd ${shellQuote(request.cwd)} && ${request.command}` : request.command;
  const args = [
    ...sshOptions(profile),
    "-o", "ServerAliveInterval=30",
    "-p", String(profile.port ?? 22),
  ];
  if (profile.auth.privateKeyPath) args.push("-i", profile.auth.privateKeyPath);
  args.push("-l", profile.user, profile.host, wrapWithWatchdog(remote));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = request.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), request.timeoutMs)
      : undefined;
    const abort = () => child.kill("SIGTERM");
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - started });
    });
  });
}

export function copyOpenSsh(profile: HostProfile, direction: "put" | "get", localPath: string, remotePath: string): Promise<void> {
  const remote = `${profile.user}@${profile.host}:${remotePath}`;
  const args = ["-P", String(profile.port ?? 22), ...sshOptions(profile)];
  if (profile.auth.privateKeyPath) args.push("-i", profile.auth.privateKeyPath);
  if (direction === "put") args.push(localPath, remote);
  else args.push(remote, localPath);
  return new Promise((resolve, reject) => {
    const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `scp 退出码 ${code}`));
    });
  });
}

export async function putOpenSsh(profile: HostProfile, localPath: string, remotePath: string, backupPath?: string): Promise<{ bytes: number; sha256: string; backupPath?: string }> {
  const local = await sha256File(localPath);
  const part = `${remotePath}.part`;
  await copyOpenSsh(profile, "put", localPath, part);
  const checked = await execOpenSsh(profile, { command: remoteHashCommand(part) });
  const remote = parseRemoteHash(checked.stdout);
  if (checked.exitCode !== 0 || remote !== local.hash) {
    throw new TransferMismatchError(`sha256 不一致：本地 ${local.hash}，远端 ${remote ?? "无"}。${part} 保留，原文件未动`);
  }
  if (backupPath) {
    const moved = await execOpenSsh(profile, { command: `if [ -e ${shellQuote(remotePath)} ]; then mv ${shellQuote(remotePath)} ${shellQuote(backupPath)}; fi` });
    if (moved.exitCode !== 0) throw new TransferMismatchError(`备份失败：${moved.stderr || moved.stdout}`);
  }
  const renamed = await execOpenSsh(profile, { command: `mv ${shellQuote(part)} ${shellQuote(remotePath)}` });
  if (renamed.exitCode !== 0) throw new TransferMismatchError(`转正失败：${renamed.stderr || renamed.stdout}`);
  return { bytes: local.bytes, sha256: local.hash, backupPath };
}
