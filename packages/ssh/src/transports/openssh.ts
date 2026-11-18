// transports/openssh.ts —— 调用本机 ssh。继承 ~/.ssh/config、代理跳转和密钥。
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, wrapWithWatchdog } from "../core/guard.js";
import { StringDecoder } from "node:string_decoder";
import { clipUtf8, parseRemoteHash, remoteHashCommand, sha256File } from "../core/hash.js";
import { hostKeyFingerprint } from "../core/known-hosts.js";
import { TransferMismatchError, UnsupportedError, type HostProfile } from "../core/types.js";

export function controlPath(): string {
  const dir = join(homedir(), ".pi", "agent", "ssh-cm");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return join(dir, "%C");
}

/** ssh 与 sftp 共用的选项。`-i` 必须在这里，否则 sftp 走不到密钥认证。 */
function sshOptions(profile: HostProfile): string[] {
  if (profile.auth.kind === "password") {
    throw new UnsupportedError("openssh 传输不接受密码或 MFA。需要密码时改用 ssh2；ProxyJump、证书和 agent 继续走 openssh。");
  }
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath()}`,
    "-o", "ControlPersist=5m",
  ];
  if (profile.auth.privateKeyPath) args.push("-i", profile.auth.privateKeyPath);
  return args;
}

/**
 * sftp / scp 自己不会留下常驻 master（只有 ssh 会），
 * 所以不先把 master 起起来，ControlPath 就是摆设，每次都重新握手。
 * `-O check` 只碰本地 socket，不走网络，比一次握手便宜得多。
 * 起 master 失败不当致命：后续 sftp 会自己握手，并报出自己的错。
 */
async function ensureControlMaster(profile: HostProfile): Promise<void> {
  const target = `${profile.user}@${profile.host}`;
  const cp = controlPath();
  const check = await runQuiet("ssh", ["-o", `ControlPath=${cp}`, "-O", "check", target]);
  if (check.code === 0) return;
  const started = await runQuiet("ssh", [
    ...sshOptions(profile),
    "-p", String(profile.port ?? 22),
    "-f", "-N", target,
  ]);
  if (started.code !== 0) return;
  masters.add(target);
}


/**
 * 取远端主机密钥指纹。
 * openssh 传输本身不解析主机密钥（校验交给系统 ssh 与 known_hosts），但 `ssh_hosts test`
 * 仍要能报出指纹供人核对——此前这里返回空串，用户在用 openssh 传输时无法对照
 * `ssh-keygen -lf`。改用 ssh-keyscan 取密钥原文，再算和 ssh2 路径同一个 SHA256。
 */
export async function scanHostKeyFingerprint(
  host: string,
  port: number,
  opts?: { timeoutMs?: number },
): Promise<{ fingerprint: string; keyType: string } | undefined> {
  const args = ["-T", String(Math.max(1, Math.floor((opts?.timeoutMs ?? 5000) / 1000))), "-p", String(port), "-t", "ed25519,ecdsa,rsa", host];
  return new Promise((resolve) => {
    const child = spawn("ssh-keyscan", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = collect(child.stdout);
    const timer = setTimeout(() => child.kill("SIGTERM"), (opts?.timeoutMs ?? 5000) + 2000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      out.end();
      // 输出形如 `host ssh-ed25519 AAAAC3...`；注释行与空行跳过。
      // 同一台机器可能同时有 ed25519 / ecdsa / rsa 三把密钥，ssh-keyscan 的输出顺序
      // 不保证。必须按 ssh2 的偏好取 ed25519，否则两条传输报出不同指纹，
      // 用户拿它跟 `ssh-keygen -lf` 对照就会以为密钥变了。
      const found: Array<{ keyType: string; fingerprint: string }> = [];
      for (const line of out.text().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3 || line.startsWith("#")) continue;
        const [, keyType, key] = parts;
        try {
          found.push({ keyType, fingerprint: hostKeyFingerprint(Buffer.from(key, "base64")) });
        } catch {
          // 解不出来就跳过这一行
        }
      }
      const prefer = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"];
      found.sort((a, b) => {
        const ia = prefer.indexOf(a.keyType);
        const ib = prefer.indexOf(b.keyType);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      resolve(found[0]);
    });
  });
}

/**
 * 把子进程的流收成字符串。
 * 不能逐块 `chunk.toString("utf8")`：块边界与字符边界无关，中文输出会在每个
 * 块边界被切成两半、各解出两个替换符。StringDecoder 会保留半个字符到下一块。
 */
function collect(stream: NodeJS.ReadableStream): { text: () => string; end: () => void } {
  const decoder = new StringDecoder("utf8");
  let value = "";
  stream.on("data", (chunk: Buffer) => {
    value += decoder.write(chunk);
  });
  return {
    text: () => value,
    end: () => {
      value += decoder.end();
    },
  };
}

function runQuiet(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const err = collect(child.stderr);
    child.on("error", () => resolve({ code: -1, stderr: err.text() }));
    child.on("close", (code) => {
      err.end();
      resolve({ code, stderr: err.text() });
    });
  });
}

const masters = new Set<string>();

/** 会话结束时把后台 master 收掉，不留 5 分钟的孤儿进程。 */
export async function closeControlMasters(): Promise<void> {
  const targets = [...masters];
  masters.clear();
  await Promise.all(targets.map((target) => runQuiet("ssh", ["-o", `ControlPath=${controlPath()}`, "-O", "exit", target])));
}

/**
 * 用 `sftp -b -` 跑一批命令，复用同一条 ControlMaster 连接，不另开握手。
 * 退出码非 0 就报错，不默默返回半个结果。
 */
async function sftpBatch(profile: HostProfile, commands: string[]): Promise<string> {
  await ensureControlMaster(profile);
  const args = [...sshOptions(profile), "-P", String(profile.port ?? 22), "-b", "-", `${profile.user}@${profile.host}`];
  return new Promise((resolve, reject) => {
    const child = spawn("sftp", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    child.stdin.end(`${commands.join("\n")}\n`);
    child.on("error", reject);
    child.on("close", (code) => {
      out.end();
      err.end();
      if (code === 0) resolve(out.text());
      else reject(new Error(err.text().trim() || `sftp 退出码 ${code}`));
    });
  });
}

/**
 * 解 `sftp` 的 `ls -l` 输出。longname 是 SFTP 协议给的，不是 shell 的 ls：
 * 首列是权限串，第 5 列是字节数，名字从第 9 列起（名字里可以有空格）。
 */
export function parseSftpLongNames(output: string): Array<{ name: string; size: number; directory: boolean }> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-dlbcps][rwxstT-]{9}/.test(line))
    .map((line) => {
      const fields = line.split(/\s+/);
      return {
        name: fields.slice(8).join(" "),
        size: Number(fields[4]) || 0,
        directory: line.startsWith("d"),
      };
    })
    .filter((entry) => entry.name !== "" && entry.name !== "." && entry.name !== "..");
}

export async function listOpenSsh(profile: HostProfile, remotePath: string): Promise<Array<{ name: string; size: number; directory: boolean }>> {
  const out = await sftpBatch(profile, [`ls -l ${shellQuote(remotePath)}`]);
  return parseSftpLongNames(out);
}

/** 不解析远端文本：get 到本地临时文件，再按行切。 */
export async function readOpenSsh(profile: HostProfile, remotePath: string, offset = 1, limit = 200): Promise<string> {
  const tmp = join(tmpdir(), `pi-ssh-read-${process.pid}-${Date.now()}`);
  try {
    await sftpBatch(profile, [`get ${shellQuote(remotePath)} ${shellQuote(tmp)}`]);
    const whole = readFileSync(tmp, "utf8");
    const maxBytes = 512 * 1024;
    const picked: string[] = [];
    let seen = 0;
    let bytes = 0;
    for (const line of whole.split("\n")) {
      seen += 1;
      if (seen < offset || picked.length >= limit) continue;
      const room = maxBytes - bytes;
      if (room <= 0) break;
      const clipped = clipUtf8(line, room);
      picked.push(clipped);
      bytes += Buffer.byteLength(clipped) + 1;
      if (clipped !== line) break;
    }
    return picked.join("\n");
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * OpenSSH 对老服务器会打一串 post-quantum 警告。它是 ssh 自己的提示，
 * 不是命令的输出；合进结果里会让「退出码 0」看起来像出错。
 */
export function stripSshNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/WARNING: connection is not using a post-quantum key exchange algorithm/.test(line))
    .filter((line) => !/This session may be vulnerable to "store now, decrypt later" attacks/.test(line))
    .filter((line) => !/The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html/.test(line))
    .join("\n");
}

export interface OpenSshRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
}

export function execOpenSsh(profile: HostProfile, request: OpenSshRequest): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const remote = request.cwd ? `cd ${shellQuote(request.cwd)} && ${request.command}` : request.command;
  const args = [
    ...sshOptions(profile),
    "-o", "ServerAliveInterval=30",
    "-p", String(profile.port ?? 22),
  ];
  args.push("-l", profile.user, profile.host, wrapWithWatchdog(remote));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // stdin 必须是 pipe 且不能 end()：watchdog 脚本靠 `exec 3<&0` 拿一条通道，
    // 通道 EOF 就当作「客户端放弃」立即 kill 命令。stdio 用 "ignore" 时 fd 0 是
    // /dev/null，fd 3 立刻 EOF，命令会被自己的 watcher 秒杀（exit 143 + 空输出）。
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    const timer = request.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), request.timeoutMs)
      : undefined;
    const abort = () => child.kill("SIGTERM");
    request.signal?.addEventListener("abort", abort, { once: true });
    // 中文输出的块边界续接见 collect()；onData 只在解出完整字符后回调。
    let pushed = 0;
    child.stdout.on("data", () => {
      const text = out.text();
      if (text.length > pushed) {
        const delta = text.slice(pushed);
        pushed = text.length;
        request.onData?.(delta);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      out.end();
      err.end();
      const text = out.text();
      if (text.length > pushed) request.onData?.(text.slice(pushed));
      resolve({ stdout: text, stderr: stripSshNoise(err.text()), exitCode: code, durationMs: Date.now() - started });
    });
  });
}

export function copyOpenSsh(profile: HostProfile, direction: "put" | "get", localPath: string, remotePath: string): Promise<void> {
  const remote = `${profile.user}@${profile.host}:${remotePath}`;
  const args = ["-P", String(profile.port ?? 22), ...sshOptions(profile)];
  if (direction === "put") args.push(localPath, remote);
  else args.push(remote, localPath);
  return ensureControlMaster(profile).then(() => new Promise<void>((resolve, reject) => {
    // 同上：scp 也走同一套 ControlMaster，stdin 必须保持 pipe。
    const child = spawn("scp", args, { stdio: ["pipe", "pipe", "pipe"] });
    const err = collect(child.stderr);
    child.on("error", reject);
    child.on("close", (code) => {
      err.end();
      if (code === 0) resolve();
      else reject(new Error(err.text().trim() || `scp 退出码 ${code}`));
    });
  }));
}

/**
 * scp 直接传到目标路径并做双端 sha256 校验，不额外加 `.part` 后缀。
 * 部署场景自己就把目标定成了 `<releaseDir>.part`，这里再加一层会变成 `.part.part`。
 */
export async function scpPutVerified(profile: HostProfile, localPath: string, remotePath: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const local = await sha256File(localPath);
  await copyOpenSsh(profile, "put", localPath, remotePath);
  const checked = await execOpenSsh(profile, { command: remoteHashCommand(remotePath), signal });
  const remote = parseRemoteHash(checked.stdout);
  if (checked.exitCode !== 0 || remote !== local.hash) {
    throw new TransferMismatchError(`sha256 不一致：本地 ${local.hash}，远端 ${remote ?? "无"}。${remotePath} 保留，原文件未动`);
  }
  return { bytes: local.bytes, sha256: local.hash };
}

/**
 * scp 下载后做双端 sha256 比对。scp 退出码 0 不代表内容完整，
 * 传输中断、磁盘满、服务端限流都可能静默截断。
 */
export async function getOpenSsh(profile: HostProfile, remotePath: string, localPath: string): Promise<{ bytes: number; sha256: string }> {
  await copyOpenSsh(profile, "get", localPath, remotePath);
  const local = await sha256File(localPath);
  const checked = await execOpenSsh(profile, { command: remoteHashCommand(remotePath) });
  const remote = parseRemoteHash(checked.stdout);
  if (checked.exitCode !== 0 || remote !== local.hash) {
    throw new TransferMismatchError(`下载后 sha256 不一致：本地 ${local.hash}，远端 ${remote ?? "无"}。${localPath} 可能不完整`);
  }
  return { bytes: local.bytes, sha256: local.hash };
}

export async function putOpenSsh(profile: HostProfile, localPath: string, remotePath: string, backupPath?: string): Promise<{ bytes: number; sha256: string; backupPath?: string; backupCopied?: boolean }> {
  const local = await sha256File(localPath);
  const part = `${remotePath}.part`;
  await copyOpenSsh(profile, "put", localPath, part);
  const checked = await execOpenSsh(profile, { command: remoteHashCommand(part) });
  const remote = parseRemoteHash(checked.stdout);
  if (checked.exitCode !== 0 || remote !== local.hash) {
    throw new TransferMismatchError(`sha256 不一致：本地 ${local.hash}，远端 ${remote ?? "无"}。${part} 保留，原文件未动`);
  }
  let backupCopied = false;
  if (backupPath) {
    const source = shellQuote(remotePath);
    const dest = shellQuote(backupPath);
    // rename 只改目录项。跨文件系统时 mv 报 EXDEV，降级为复制。
    const moved = await execOpenSsh(profile, { command: `if [ -e ${source} ]; then mv ${source} ${dest} || { mkdir -p $(dirname ${dest}) && cp -p ${source} ${dest} && rm -f ${source} && echo __COPIED__; }; fi` });
    if (moved.exitCode !== 0) throw new TransferMismatchError(`备份失败：${moved.stderr || moved.stdout}`);
    backupCopied = moved.stdout.includes("__COPIED__");
  }
  const renamed = await execOpenSsh(profile, { command: `mv ${shellQuote(part)} ${shellQuote(remotePath)}` });
  if (renamed.exitCode !== 0) throw new TransferMismatchError(`转正失败：${renamed.stderr || renamed.stdout}`);
  return { bytes: local.bytes, sha256: local.hash, backupPath, backupCopied };
}
