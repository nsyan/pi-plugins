// transports/ssh2.ts —— 一条已认证连接上的多路 channel。最多 6 路，空闲 5 分钟关闭。
import { connect, createServer, type AddressInfo } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ConnectConfig } from "ssh2";

const { Client: SshClient } = createRequire(import.meta.url)("ssh2") as typeof import("ssh2");
import { wrapSudo, wrapWithWatchdog } from "../core/guard.js";
import { StringDecoder } from "node:string_decoder";
import { clipUtf8, parseRemoteHash, remoteHashCommand, sha256File } from "../core/hash.js";
import { hostKeyFingerprint } from "../core/known-hosts.js";
import { AuthFailedError, HostKeyUnknownError, TransferMismatchError, type HostProfile } from "../core/types.js";

const MAX_CHANNELS = 6;
const IDLE_MS = 5 * 60 * 1000;
const KEEPALIVE_MS = 30 * 1000;

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
  maxBytes?: number;
  /** 只给 sudo 用。写到通道后不进入命令文本。 */
  stdin?: string;
  sudo?: boolean;
}

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  spillPath?: string;
}

export interface TransferRequest {
  localPath: string;
  remotePath: string;
  /** 覆盖前把原文件改到这里。不传就不备份。 */
  backupPath?: string;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

export interface TransferOutcome {
  bytes: number;
  sha256: string;
  backupPath?: string;
  backupCopied?: boolean;
}

interface Lease {
  release(): void;
}

interface Stored {
  client: Client;
  leases: number;
  timer?: NodeJS.Timeout;
  /** 握手阶段记下的主机密钥，供后续比对。 */
  fingerprint: string;
}

export interface ConnectHooks {
  /** 返回 false 拒绝。未知主机由调用方决定记不记。 */
  verifyHostKey?: (key: Buffer) => boolean;
  /** 连接被远端踢掉时通知，池会丢掉它。 */
  onLost?: () => void;
}

export interface PoolOptions {
  idleMs?: number;
  /** 第 5 路及以后开始排队时调用，测试用来观察上限。 */
  onQueue?: (profileId: string, waiting: number) => void;
  /** 测试用来替换远端 sha256 命令，制造校验失败。生产调用不传。 */
  hashCommand?: (remotePath: string) => string;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class Ssh2Pool {
  private readonly connections = new Map<string, Stored>();
  private readonly opening = new Map<string, Promise<Client>>();
  private readonly idleMs: number;
  private readonly onQueue?: PoolOptions["onQueue"];
  private readonly hashCommand: (remotePath: string) => string;

  constructor(options: PoolOptions | number = {}) {
    const normalized = typeof options === "number" ? { idleMs: options } : options;
    this.idleMs = normalized.idleMs ?? IDLE_MS;
    this.onQueue = normalized.onQueue;
    this.hashCommand = normalized.hashCommand ?? remoteHashCommand;
  }

  async connect(profile: HostProfile, hooks: ConnectHooks = {}): Promise<Client> {
    const existing = this.connections.get(profile.id);
    if (existing) return existing.client;
    const pending = this.opening.get(profile.id);
    if (pending) return pending;
    const created = this.openConnection(profile, hooks);
    this.opening.set(profile.id, created);
    try {
      return await created;
    } finally {
      if (this.opening.get(profile.id) === created) this.opening.delete(profile.id);
    }
  }

  private async openConnection(profile: HostProfile, hooks: ConnectHooks): Promise<Client> {
    const client = new SshClient();
    let fingerprint = "";
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port ?? 22,
      username: profile.user,
      readyTimeout: 20_000,
      keepaliveInterval: KEEPALIVE_MS,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        fingerprint = hostKeyFingerprint(key);
        return hooks.verifyHostKey ? hooks.verifyHostKey(key) : true;
      },
    };
    if (profile.auth.kind === "agent") {
      if (!process.env.SSH_AUTH_SOCK) throw new AuthFailedError("没有 SSH_AUTH_SOCK，agent 认证不可用。");
      config.agent = process.env.SSH_AUTH_SOCK;
    } else if (profile.auth.kind === "key" && profile.auth.privateKeyPath) {
      config.privateKey = readFileSync(profile.auth.privateKeyPath);
      if (profile.auth.passphrase) config.passphrase = profile.auth.passphrase;
    } else if (profile.auth.kind === "password") {
      const secret = profile.auth.password ?? profile.auth.secretRef;
      if (!secret || secret.startsWith("file:") || secret.startsWith("keychain:")) {
        throw new AuthFailedError("没有可用的密码。");
      }
      config.password = secret;
    }

    await new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", (error: Error) => reject(error));
      client.connect(config);
    }).catch((error: Error) => {
      client.end();
      throw error;
    });

    const stored: Stored = { client, leases: 0, fingerprint };
    client.on("close", () => {
      if (this.connections.get(profile.id)?.client === client) {
        this.connections.delete(profile.id);
        hooks.onLost?.();
      }
    });
    this.connections.set(profile.id, stored);
    this.arm(profile.id);
    return client;
  }

  /** 取一条已连接的客户端。没有就抛 HostKeyUnknownError，调用方先 connect。 */
  require(profileId: string): Client {
    const stored = this.connections.get(profileId);
    if (!stored) throw new HostKeyUnknownError(`主机 ${profileId} 还没有连接`);
    return stored.client;
  }

  /**
   * 已建立的连接上握手阶段算过的指纹。
   * 连接复用时 `hostVerifier` 不会再被调用，调用方拿不到指纹，
   * 只能从这里取；否则第二次 `ssh_hosts test` 会报一个空指纹。
   */
  fingerprintOf(profileId: string): string {
    return this.connections.get(profileId)?.fingerprint ?? "";
  }

  /** 占一个 channel 名额。满 4 个就等。 */
  async acquire(profileId: string): Promise<Lease> {
    const stored = this.connections.get(profileId);
    if (!stored) throw new HostKeyUnknownError(`主机 ${profileId} 还没有连接`);
    if (stored.leases >= MAX_CHANNELS) this.onQueue?.(profileId, stored.leases - MAX_CHANNELS + 1);
    while (stored.leases >= MAX_CHANNELS) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!this.connections.has(profileId)) throw new HostKeyUnknownError(`主机 ${profileId} 的连接已断开`);
    }
    if (!this.connections.has(profileId)) throw new HostKeyUnknownError(`主机 ${profileId} 的连接已断开`);
    stored.leases += 1;
    if (stored.timer) clearTimeout(stored.timer);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        stored.leases = Math.max(0, stored.leases - 1);
        if (stored.leases === 0) this.arm(profileId);
      },
    };
  }

  async exec(profileId: string, request: ExecRequest): Promise<ExecOutcome> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    const started = Date.now();
    const remote = request.cwd
      ? `cd ${quote(request.cwd)} && ${request.command}`
      : request.command;
    const command = request.sudo ? wrapSudo(remote) : wrapWithWatchdog(remote);
    try {
      return await this.run(client, command, request, started);
    } finally {
      lease.release();
    }
  }

  async put(profileId: string, request: TransferRequest): Promise<TransferOutcome> {
    const local = await sha256File(request.localPath);
    const part = `${request.remotePath}.part`;
    const upload = await this.acquire(profileId);
    try {
      await this.fastPut(this.require(profileId), { ...request, remotePath: part });
    } finally {
      upload.release();
    }
    const checked = await this.execLeased(profileId, this.hashCommand(part));
    if (checked.exitCode !== 0 || !checked.stdout.trim()) {
      throw new TransferMismatchError(`远端校验失败：${checked.stderr || checked.stdout || "没有输出"}。${part} 保留，原文件未动`);
    }
    const remote = parseRemoteHash(checked.stdout);
    if (remote !== local.hash) {
      throw new TransferMismatchError(
        `sha256 不一致：本地 ${local.hash}，远端 ${remote}。原文件未动，${part} 保留`,
      );
    }
    const saved = await this.backup(profileId, request);
    await this.execLeased(profileId, `mv ${quote(part)} ${quote(request.remotePath)}`);
    return { bytes: local.bytes, sha256: local.hash, backupPath: saved.path, backupCopied: saved.copied };
  }

  async list(profileId: string, remotePath: string): Promise<Array<{ name: string; size: number; directory: boolean }>> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    try {
      return await new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) return reject(error);
          sftp.readdir(remotePath, (listError, entries) => {
            sftp.end();
            if (listError) return reject(listError);
            resolve(entries.map((entry) => ({
              name: entry.filename,
              size: entry.attrs.size,
              directory: (entry.attrs.mode & 0o170000) === 0o040000,
            })));
          });
        });
      });
    } finally {
      lease.release();
    }
  }

  async read(profileId: string, remotePath: string, offset = 1, limit = 200): Promise<string> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    try {
      return await new Promise<string>((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) return reject(error);
          const picked: string[] = [];
          let seen = 0;
          let bytes = 0;
          let pending = "";
          const start = Math.max(1, offset);
          const maxBytes = 512 * 1024;
          const stream = sftp.createReadStream(remotePath);
          // SFTP 的 data 块边界与字符边界无关：逐块 chunk.toString("utf8") 会把一个
          // 多字节字符切成两半，各块各解一次就得到两个替换符。必须用 StringDecoder 续接。
          const decoder = new StringDecoder("utf8");
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            if (pending !== "" && seen + 1 >= start && picked.length < limit && bytes < maxBytes) {
              picked.push(clipUtf8(pending, maxBytes - bytes));
            }
            sftp.end();
            resolve(picked.join("\n"));
          };
          stream.on("data", (chunk: Buffer) => {
            const parts = (pending + decoder.write(chunk)).split(/\n/);
            pending = parts.pop() ?? "";
            for (const line of parts) {
              seen += 1;
              if (seen < start || picked.length >= limit) continue;
              const room = maxBytes - bytes;
              if (room <= 0) {
                stream.destroy();
                return;
              }
              const clipped = clipUtf8(line, room);
              picked.push(clipped);
              bytes += Buffer.byteLength(clipped) + 1;
              if (clipped !== line || bytes >= maxBytes) stream.destroy();
            }
            if (picked.length >= limit) stream.destroy();
          });
          stream.on("error", (readError: Error) => {
            if (picked.length > 0 || seen > 0) finish();
            else reject(readError);
          });
          stream.on("close", finish);
        });
      });
    } finally {
      lease.release();
    }
  }

  async get(profileId: string, request: TransferRequest): Promise<TransferOutcome> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    try {
      await new Promise<void>((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) return reject(error);
          sftp.fastGet(request.remotePath, request.localPath, (getError) => {
            sftp.end();
            if (getError) reject(getError);
            else resolve();
          });
        });
      });
      const local = await sha256File(request.localPath);
      const checked = await this.execRaw(client, { command: this.hashCommand(request.remotePath), timeoutMs: 120_000 });
      const remote = parseRemoteHash(checked.stdout);
      if (checked.exitCode !== 0 || remote !== local.hash) {
        throw new TransferMismatchError(`下载后 sha256 不一致：本地 ${local.hash}，远端 ${remote ?? "无"}`);
      }
      return { bytes: local.bytes, sha256: local.hash };
    } finally {
      lease.release();
    }
  }

  async tunnel(profileId: string, listenPort: number, destHost: string, destPort: number): Promise<{ port: number; close: () => Promise<void> }> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    const server = createServer((socket) => {
      client.forwardOut("127.0.0.1", socket.localPort ?? 0, destHost, destPort, (error, stream) => {
        if (error || !stream) {
          socket.end();
          return;
        }
        socket.pipe(stream);
        stream.pipe(socket);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    const address = server.address() as AddressInfo;
    return {
      port: address.port,
      close: () => new Promise((resolve) => {
        lease.release();
        server.close(() => resolve());
      }),
    };
  }

  async tunnelRemote(profileId: string, listenPort: number, destHost: string, destPort: number): Promise<{ port: number; close: () => Promise<void> }> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    try {
      await new Promise<void>((resolve, reject) => {
        client.forwardIn("127.0.0.1", listenPort, (error?: Error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    const onConnection = (info: { destPort: number }, accept: () => NodeJS.ReadWriteStream) => {
      const channel = accept();
      if (info.destPort !== listenPort) {
        channel.end();
        return;
      }
      const socket = connect(destPort, destHost);
      channel.pipe(socket);
      socket.pipe(channel);
    };
    (client as unknown as { on(event: string, listener: typeof onConnection): void }).on("tcp connection", onConnection);
    return {
      port: listenPort,
      close: () => new Promise((resolve) => {
        (client as unknown as { removeListener(event: string, listener: typeof onConnection): void }).removeListener("tcp connection", onConnection);
        client.unforwardIn("127.0.0.1", listenPort, () => {
          lease.release();
          resolve();
        });
      }),
    };
  }

  discard(profileId: string): void {
    const stored = this.connections.get(profileId);
    this.connections.delete(profileId);
    if (!stored) return;
    if (stored.timer) clearTimeout(stored.timer);
    stored.client.end();
  }

  async close(profileId?: string): Promise<void> {
    const ids = profileId ? [profileId] : [...this.connections.keys()];
    for (const id of ids) {
      const stored = this.connections.get(id);
      if (!stored) continue;
      if (stored.timer) clearTimeout(stored.timer);
      stored.client.end();
      this.connections.delete(id);
    }
  }

  private arm(profileId: string): void {
    const stored = this.connections.get(profileId);
    if (!stored) return;
    if (stored.timer) clearTimeout(stored.timer);
    stored.timer = setTimeout(() => {
      if (stored.leases === 0) void this.close(profileId);
    }, this.idleMs);
    stored.timer.unref?.();
  }

  private run(client: Client, command: string, request: ExecRequest, started: number): Promise<ExecOutcome> {
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error || !channel) return reject(error ?? new Error("exec channel missing"));
        if (request.stdin !== undefined) channel.write(`${request.stdin}\n`);
        let stdout = "";
        let stderr = "";
        let spillPath: string | undefined;
        let finished = false;
        const overBudget = (prospective: number, lines: number) => prospective > 50_000 || lines > 2000;
        const absorb = (which: "out" | "err", chunk: string) => {
          // 预算看的是「加上本块之后」的总量。只看已累积量的话，
          // 一次到达的 3001 行（~14KB）永远触发不了 2000 行上限。
          const prospective = stdout.length + stderr.length + chunk.length;
          const lines = `${stdout}${chunk}`.split("\n").length + stderr.split("\n").length - 1;
          if (!spillPath && overBudget(prospective, lines)) {
            spillPath = join(tmpdir(), `pi-ssh-${process.pid}-${Date.now()}.log`);
            mkdirSync(tmpdir(), { recursive: true });
            writeFileSync(spillPath, stdout + stderr);
          }
          if (spillPath) appendFileSync(spillPath, chunk);
          if (which === "out") stdout = (stdout + chunk).slice(-50_000);
          else stderr = (stderr + chunk).slice(-50_000);
        };
        const finish = (outcome: ExecOutcome) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", abort);
          resolve({ ...outcome, spillPath });
        };
        const abort = () => {
          channel.close();
          finish({ stdout, stderr, exitCode: null, durationMs: Date.now() - started });
        };
        const timeoutMs = request.timeoutMs ?? 120_000;
        const timer = setTimeout(() => {
          channel.close();
          finish({ stdout, stderr, exitCode: null, durationMs: Date.now() - started });
        }, timeoutMs);
        request.signal?.addEventListener("abort", abort, { once: true });
        // 命令输出可能含中文：块边界不等于字符边界，逐块 toString 会切出替换符。
        // 用 StringDecoder 续接，close 时 end() 冲掉残留的半个字符。
        const outDecoder = new StringDecoder("utf8");
        const errDecoder = new StringDecoder("utf8");
        channel.on("data", (chunk: Buffer) => {
          const text = outDecoder.write(chunk);
          if (text === "") return;
          absorb("out", text);
          request.onData?.(text);
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          const text = errDecoder.write(chunk);
          if (text !== "") absorb("err", text);
        });
        channel.on("close", (code: number | null) => {
          const tailOut = outDecoder.end();
          if (tailOut !== "") {
            absorb("out", tailOut);
            request.onData?.(tailOut);
          }
          const tailErr = errDecoder.end();
          if (tailErr !== "") absorb("err", tailErr);
          finish({ stdout, stderr, exitCode: code, durationMs: Date.now() - started });
        });
      });
    });
  }

  private execRaw(client: Client, request: ExecRequest): Promise<ExecOutcome> {
    return this.run(client, request.command, request, Date.now());
  }

  private fastPut(client: Client, request: TransferRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) return reject(error);
        sftp.fastPut(request.localPath, request.remotePath, {
          step: (sent: number, _chunk: number, total: number) => request.onProgress?.(sent, total),
        }, (putError) => {
          sftp.end();
          if (putError) reject(putError);
          else resolve();
        });
      });
    });
  }

  private async execLeased(profileId: string, command: string): Promise<ExecOutcome> {
    const client = this.require(profileId);
    const lease = await this.acquire(profileId);
    try {
      return await this.execRaw(client, { command, timeoutMs: 120_000 });
    } finally {
      lease.release();
    }
  }

  private async backup(profileId: string, request: TransferRequest): Promise<{ path?: string; copied: boolean }> {
    if (!request.backupPath) return { copied: false };
    const exists = await this.remoteExists(profileId, request.remotePath);
    if (!exists) return { copied: false };
    const source = quote(request.remotePath);
    const dest = quote(request.backupPath);
    // 备份可能收进 <root>/.pi-ssh-backup/<相对路径>.<ts>，那个目录还不存在。
    const prepared = await this.execLeased(profileId, `mkdir -p $(dirname ${dest})`);
    if (prepared.exitCode !== 0) {
      throw new TransferMismatchError(`建备份目录失败：${prepared.stderr || prepared.stdout}`);
    }
    const moved = await this.execLeased(profileId, `mv ${source} ${dest}`);
    if (moved.exitCode === 0) return { path: request.backupPath, copied: false };
    const copied = await this.execLeased(profileId, `cp -p ${source} ${dest} && rm -f ${source}`);    if (copied.exitCode !== 0) {
      throw new TransferMismatchError(`备份失败：${moved.stderr || copied.stderr || "mv 与 cp 都失败"}`);
    }
    return { path: request.backupPath, copied: true };
  }

  private async remoteExists(profileId: string, remotePath: string): Promise<boolean> {
    const result = await this.execLeased(profileId, `if [ -e ${quote(remotePath)} ]; then echo yes; fi`);
    return result.stdout.trim() === "yes";
  }
}

