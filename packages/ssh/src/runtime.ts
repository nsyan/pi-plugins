// runtime.ts —— 工具背后的执行。选主机、确认、审计，然后交给连接池。
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, defaultAuditPath } from "./core/audit.js";
import { backupLocation, checkReleaseId, planRelease, rejectArchiveMembers, releaseIdNow, staleBackups } from "./core/deploy.js";
import { waitCommand, type WaitFor } from "./core/wait.js";
import { loadHosts } from "./core/config.js";
import { shellQuote } from "./core/guard.js";
import { getSecret, platformKeychain } from "./core/secrets.js";
import { appendKnownHost, checkHostKey, hostKeyFingerprint } from "./core/known-hosts.js";
import { classify, decide, isProdHost, type Policy } from "./core/policy.js";
import {
  BoundsError,
  ConfirmRejectedError,
  HostKeyChangedError,
  HostKeyUnknownError,
  PolicyDeniedError,
  UnsupportedError,
  type HostFile,
  type HostProfile,
} from "./core/types.js";
import { Ssh2Pool, type ConnectHooks } from "./transports/ssh2.js";
import { chooseTransport } from "./scan/auto.js";
import { copyOpenSsh, execOpenSsh, putOpenSsh } from "./transports/openssh.js";
import { ftpExecRejected, ftpGet, ftpList, ftpPut } from "./transports/ftp.js";

const OUTPUT_LIMIT = 50_000;

export interface ConfirmUi {
  confirm(title: string, message: string): Promise<boolean>;
  secret?(title: string, prompt: string): Promise<string | undefined>;
}

export interface RuntimeOptions {
  pool?: Ssh2Pool;
  hosts?: () => HostFile;
  auditPath?: string;
  knownHostsPath?: string;
}

export function selectHost(file: HostFile, name?: string, allowActive = false): HostProfile {
  const names = Object.keys(file.hosts);
  if (name) {
    const found = file.hosts[name];
    if (!found) throw new PolicyDeniedError(`没有名为 ${name} 的主机。已有：${names.join("、") || "无"}`);
    return found;
  }
  if (names.length === 1) return file.hosts[names[0]];
  if (allowActive && file.activeHost && file.hosts[file.activeHost]) return file.hosts[file.activeHost];
  if (names.length === 0) throw new PolicyDeniedError("还没有主机。先用 /ssh add 添加。");
  throw new PolicyDeniedError(`已配置 ${names.length} 台主机，调用必须传 host：${names.join("、")}`);
}

function policyOf(file: HostFile): Policy {
  return {
    readonly: file.policy?.readonly === true,
    confirm: file.policy?.confirm ?? "destructive",
  };
}

function withPassword(profile: HostProfile): HostProfile {
  const ref = profile.auth.secretRef;
  let next = profile;
  if (profile.auth.kind === "password" && ref?.startsWith("file:")) {
    const [file, name] = ref.slice("file:".length).split("#");
    next = { ...next, auth: { ...next.auth, password: getSecret(file, name) } };
  }
  return next;
}

function keyType(blob: Buffer): string {
  if (blob.length < 4) return "unknown";
  const length = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + length).toString("utf8");
}

function tail(text: string, spillPath?: string): { text: string; truncated: boolean; spillPath?: string } {
  const lines = text.split("\n");
  if (!spillPath && text.length <= OUTPUT_LIMIT && lines.length <= 2000) return { text, truncated: false };
  const path = spillPath ?? join(tmpdir(), `pi-ssh-${Date.now()}.log`);
  if (!spillPath) {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(path, text);
  }
  const clipped = lines.slice(-2000).join("\n").slice(-OUTPUT_LIMIT);
  return {
    text: `${clipped}\n\n[输出已截断，全文在 ${path}]`,
    truncated: true,
    spillPath: path,
  };
}

function boundedTimeoutMs(requested: number | undefined, fallback: number | undefined): number {
  const seconds = requested ?? fallback ?? 120;
  if (!Number.isFinite(seconds) || seconds <= 0) return 120_000;
  return Math.min(3600, Math.floor(seconds)) * 1000;
}

export function createRuntime(options: RuntimeOptions = {}) {
  const pool = options.pool ?? new Ssh2Pool();
  const hosts = options.hosts ?? loadHosts;
  const auditPath = options.auditPath ?? defaultAuditPath();
  const tunnels: Array<{ close: () => Promise<void> }> = [];
  const grants = new Map<string, number>();

  async function resolveProfile(profile: HostProfile): Promise<HostProfile> {
    const ready = withPassword(profile);
    const auth = ready.auth;
    if (auth.passphraseRef?.startsWith("keychain:")) {
      const passphrase = await platformKeychain().get("pi-ssh", auth.passphraseRef.slice("keychain:".length));
      ready.auth = { ...ready.auth, passphrase };
    } else if (auth.passphraseRef?.startsWith("file:")) {
      const [file, name] = auth.passphraseRef.slice("file:".length).split("#");
      ready.auth = { ...ready.auth, passphrase: getSecret(file, name) };
    }
    if (!auth.secretRef?.startsWith("keychain:")) return ready;
    const account = auth.secretRef.slice("keychain:".length);
    const secret = await platformKeychain().get("pi-ssh", account);
    return { ...ready, auth: { ...ready.auth, password: secret } };
  }

  async function connect(profile: HostProfile, acceptNewHostKey = false): Promise<{ fingerprint: string; keyType: string; auth: string }> {
    const ready = await resolveProfile(profile);
    const knownFile = options.knownHostsPath ?? join(process.env.HOME ?? "", ".ssh", "known_hosts");
    let keyError: Error | undefined;
    const identity = { fingerprint: "", keyType: "", auth: ready.auth.kind };
    const hooks: ConnectHooks = {
      verifyHostKey: (key) => {
        const type = keyType(key);
        const encoded = key.toString("base64");
        identity.fingerprint = hostKeyFingerprint(key);
        identity.keyType = type;
        if (ready.strictHostKey === false) return true;
        const status = checkHostKey(knownFile, ready.host, ready.port ?? 22, type, encoded);
        if (status === "match") return true;
        if (status === "unknown" && acceptNewHostKey) {
          appendKnownHost(knownFile, ready.host, ready.port ?? 22, type, encoded);
          return true;
        }
        keyError = status === "changed" || status === "revoked"
          ? new HostKeyChangedError(`主机密钥已变化或被吊销（${identity.fingerprint}）。确认后用 ssh-keygen -R 删除旧记录。`)
          : new HostKeyUnknownError(`主机密钥不在 known_hosts（${identity.fingerprint}）。先用 ssh_hosts 的 test 并带 acceptNewHostKey 核对指纹。`);
        return false;
      },
    };
    await pool.connect(ready, hooks).catch((error: Error) => {
      throw keyError ?? error;
    });
    return identity;
  }

  function requireReason(host: HostProfile, danger: string, reason?: string): void {
    if (isProdHost(host) && danger === "destructive" && !reason?.trim()) {
      throw new PolicyDeniedError("生产主机的破坏性操作必须填写 reason，说明动机和影响范围。");
    }
  }

  async function remoteLines(profileId: string, command: string): Promise<string[]> {
    const listed = await pool.exec(profileId, { command, timeoutMs: 120_000 });
    return listed.stdout.split(/\n/).map((item) => item.trim()).filter(Boolean);
  }

  async function checked(profileId: string, command: string) {
    const result = await pool.exec(profileId, { command, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new PolicyDeniedError(`远端命令失败（退出码 ${result.exitCode}）：${result.stderr || result.stdout || command}`);
    }
    return result;
  }

  async function pruneBackups(profileId: string, backupPath: string): Promise<void> {
    const slash = backupPath.lastIndexOf("/");
    if (slash < 0) return;
    const dir = backupPath.slice(0, slash);
    const name = backupPath.slice(slash + 1);
    const stamp = name.lastIndexOf(".");
    const stem = stamp > 0 ? name.slice(0, stamp) : name;
    const names = await remoteLines(profileId, `ls -1 ${shellQuote(dir)} 2>/dev/null || true`);
    for (const old of staleBackups(names, stem)) {
      await checked(profileId, `rm -f ${shellQuote(`${dir}/${old}`)}`);
    }
  }

function concrete(profile: HostProfile): HostProfile {
  if (profile.transport !== "auto") return profile;
  let text = "";
  try {
    text = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
  } catch {
    text = "";
  }
  return { ...profile, transport: chooseTransport(profile, text) };
}

async function ask(ui: ConfirmUi | undefined, title: string, message: string): Promise<void> {
    if (!ui) throw new PolicyDeniedError("这次操作需要确认，但当前没有界面。");
    const accepted = await ui.confirm(title, message);
    if (!accepted) throw new ConfirmRejectedError("用户拒绝了这次操作，停止，不要换一种写法重试。");
  }

  return {
    pool,
    async closeTunnels() {
      const open = tunnels.splice(0);
      grants.clear();
      await Promise.all(open.map((item) => item.close()));
      await pool.close();
    },
    grantWrite(hostName: string, minutes: number) {
      const host = selectHost(hosts(), hostName);
      if (isProdHost(host)) throw new PolicyDeniedError("生产主机不能授予会话级写授权。");
      grants.set(host.id, Date.now() + minutes * 60_000);
    },
    async testHost(input: { host?: string; acceptNewHostKey?: boolean }) {
      const host = concrete(selectHost(hosts(), input.host));
      const started = Date.now();
      const identity = await connect(host, input.acceptNewHostKey === true);
      const result = await pool.exec(host.id, { command: "echo ok" });
      return {
        ok: result.exitCode === 0,
        auth: identity.auth,
        fingerprint: identity.fingerprint,
        keyType: identity.keyType,
        latencyMs: Date.now() - started,
        transport: host.transport,
      };
    },
    async exec(input: { host?: string; command: string; cwd?: string; timeoutSec?: number; signal?: AbortSignal; reason?: string; waitFor?: WaitFor; onData?: (chunk: string) => void; allowActive?: boolean; ui?: ConfirmUi }) {
      const file = hosts();
      const host = concrete(selectHost(file, input.host, input.allowActive === true));
      const verdict = classify(input.command);
      requireReason(host, verdict.danger, input.reason);
      const grant = grants.get(host.id);
      const decision = decide(verdict, policyOf(file), host, grant ? { hostId: host.id, untilMs: grant } : null);
      if (decision === "deny") throw new PolicyDeniedError(`只读模式拒绝这条${verdict.danger === "destructive" ? "破坏性" : "写"}命令：${verdict.summary}`);
      if (host.transport === "ftp" || host.transport === "ftps") ftpExecRejected();
      if (decision === "confirm") await ask(input.ui, `${host.name}：${verdict.summary}`, input.command);
      if (isProdHost(host) && verdict.danger === "destructive") {
        appendAudit(auditPath, {
          host: host.name,
          tool: "ssh_exec",
          danger: verdict.danger,
          summary: verdict.summary,
          command: input.command,
          reason: input.reason,
          confirmed: decision === "confirm",
        }, { required: true });
      }
      const command = input.waitFor ? `${input.command} && ${waitCommand(input.waitFor)}` : input.command;
      const request = {
        command,
        cwd: input.cwd,
        timeoutMs: boundedTimeoutMs(input.timeoutSec, host.defaults?.timeoutSec),
        signal: input.signal,
        onData: input.onData,
      };
      let result;
      if (host.transport === "openssh") {
        result = await execOpenSsh(host, request);
      } else {
        try {
          await connect(host);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Not connected|ECONNRESET|EPIPE|closed/i.test(message)) throw error;
          pool.discard(host.id);
          await connect(host);
        }
        result = await pool.exec(host.id, request);
      }
      const spill = result && typeof result === "object" && "spillPath" in result && typeof result.spillPath === "string"
        ? result.spillPath
        : undefined;
      const output = tail(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, spill);
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_exec",
        danger: verdict.danger,
        summary: verdict.summary,
        command: input.command,
        reason: input.reason,
        confirmed: decision === "confirm",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      return { ...result, text: output.text, truncated: output.truncated };
    },
    async sudo(input: { host?: string; command: string; reason?: string; ui?: ConfirmUi }) {
      const file = hosts();
      const host = concrete(selectHost(file, input.host));
      if (policyOf(file).readonly) throw new PolicyDeniedError("只读模式拒绝 sudo。");
      if (host.transport === "openssh") throw new PolicyDeniedError("sudo 目前只走 ssh2 连接。");
      const verdict = classify(input.command);
      requireReason(host, verdict.danger, input.reason);
      await ask(input.ui, `${host.name}：sudo ${verdict.summary}`, input.command);
      const password = await input.ui?.secret?.(`${host.name} 的 sudo 密码`, "密码不进入对话记录");
      if (!password) throw new ConfirmRejectedError("没有拿到 sudo 密码，已停止。");
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_sudo",
        danger: verdict.danger,
        summary: verdict.summary,
        command: input.command,
        stdin: password,
        confirmed: true,
      }, { required: isProdHost(host) && verdict.danger === "destructive" });
      await connect(host);
      const result = await pool.exec(host.id, {
        command: input.command,
        sudo: true,
        stdin: password,
        timeoutMs: boundedTimeoutMs(undefined, host.defaults?.timeoutSec),
      });
      const output = tail(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, result.spillPath);
      return { ...result, text: output.text };
    },
    async put(input: { host?: string; localPath: string; remotePath: string; ui?: ConfirmUi; onProgress?: (sent: number, total: number) => void }) {
      const file = hosts();
      const host = concrete(selectHost(file, input.host));
      if (policyOf(file).readonly) throw new PolicyDeniedError("只读模式拒绝上传。");
      const backupPath = backupLocation(input.remotePath, host.deploy?.root);
      const exists = host.transport === "openssh"
        ? (await execOpenSsh(host, { command: `if [ -e ${shellQuote(input.remotePath)} ]; then echo yes; fi` })).stdout.includes("yes")
        : false;
      if (host.transport === "ftp" || host.transport === "ftps") {
        if (isProdHost(host)) await ask(input.ui, `${host.name}：上传`, `${input.localPath} -> ${input.remotePath}`);
        const result = await ftpPut(withPassword(host), input.localPath, input.remotePath, true);
        appendAudit(auditPath, { host: host.name, tool: "ssh_put", danger: "write", summary: "FTP 上传", command: input.remotePath, confirmed: isProdHost(host) });
        return { bytes: result.bytes, sha256: "local-only", backupPath: result.backupPath };
      }
      if (host.transport === "openssh") {
        if (isProdHost(host) || exists) await ask(input.ui, `${host.name}：上传${exists ? "并覆盖" : ""}`, `${input.localPath} -> ${input.remotePath}`);
        const result = await putOpenSsh(host, input.localPath, input.remotePath, exists ? backupPath : undefined);
        appendAudit(auditPath, { host: host.name, tool: "ssh_put", danger: "write", summary: "scp 上传", command: input.remotePath, confirmed: isProdHost(host) || exists });
        return result;
      }
      await connect(host);
      const listed = await pool.exec(host.id, { command: `if [ -e ${shellQuote(input.remotePath)} ]; then echo yes; fi` });
      const overwrite = listed.stdout.includes("yes");
      if (isProdHost(host) || overwrite) {
        await ask(input.ui, `${host.name}：上传${overwrite ? "并覆盖" : ""}`, `${input.localPath} -> ${input.remotePath}`);
      }
      const result = await pool.put(host.id, { localPath: input.localPath, remotePath: input.remotePath, backupPath: overwrite ? backupPath : undefined, onProgress: input.onProgress });
      if (overwrite && result.backupPath) await pruneBackups(host.id, result.backupPath);
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_put",
        danger: "write",
        summary: overwrite ? "覆盖远端文件" : "上传新文件",
        command: `${input.localPath} -> ${input.remotePath}`,
        confirmed: isProdHost(host) || overwrite,
      });
      return result;
    },
    async list(input: { host?: string; path: string }) {
      const host = concrete(selectHost(hosts(), input.host));
      if (host.transport === "ftp" || host.transport === "ftps") {
        const entries = await ftpList(withPassword(host), input.path);
        return entries.map((entry) => `${entry.directory ? "d" : "-"} ${entry.size}\t${entry.name}`).join("\n");
      }
      if (host.transport === "openssh") throw new UnsupportedError("系统 ssh 传输暂不支持列目录，请把这台主机的传输改成 ssh2。");
      await connect(host);
      const entries = await pool.list(host.id, input.path);
      return entries.map((entry) => `${entry.directory ? "d" : "-"} ${entry.size}\t${entry.name}`).join("\n");
    },
    async read(input: { host?: string; path: string; offset?: number; limit?: number }) {
      const host = concrete(selectHost(hosts(), input.host));
      if (host.transport === "ftp" || host.transport === "ftps" || host.transport === "openssh") {
        throw new UnsupportedError("读取文件目前只走 ssh2。FTP 和 openssh 请改用 ssh_get。");
      }
      await connect(host);
      return pool.read(host.id, input.path, input.offset, input.limit);
    },
    async deploy(input: {
      host?: string;
      localPath: string;
      kind?: "file" | "tar";
      releaseId?: string;
      dryRun?: boolean;
      reason?: string;
      ui?: ConfirmUi;
    }) {
      const file = hosts();
      const host = concrete(selectHost(file, input.host));
      if (policyOf(file).readonly) throw new PolicyDeniedError("只读模式拒绝部署。");
      const layout = host.deploy;
      if (!layout?.root) throw new PolicyDeniedError(`${host.name} 没有 deploy 布局。先在主机配置里写 root，不接受调用时临时给路径。`);
      const releaseId = input.releaseId ?? releaseIdNow();
      checkReleaseId(releaseId);
      const fileName = input.localPath.split(/[\\/]/).pop() || "artifact";
      const plan = planRelease(layout, releaseId, fileName);
      const kind = input.kind ?? "tar";
      const restartCmd = layout.restartCmd;
      const healthCmd = layout.healthCmd;
      requireReason(host, "destructive", input.reason);
      if (input.dryRun) return { releaseId, current: plan.releaseDir, rolledBack: false, dryRun: true, plan };
      await connect(host);
      const existing = await remoteLines(host.id, `ls -1 ${shellQuote(plan.releasesDir)} 2>/dev/null || true`);
      const keep = layout.keepReleases ?? 5;
      const doomed = existing.filter((item) => item !== releaseId).sort().slice(0, Math.max(0, existing.length + 1 - keep));
      await ask(
        input.ui,
        `${host.name}：部署 ${releaseId}`,
        [
          `${input.localPath} -> ${plan.releaseDir}`,
          `切换 ${plan.currentLink}`,
          restartCmd ? `重启：${restartCmd}` : "没有重启命令",
          healthCmd ? "健康检查失败会自动切回上一版，这一步不再次确认。" : "没有健康检查，失败不会自动回滚。",
          doomed.length > 0 ? `将删除旧版本：${doomed.join("、")}` : "没有旧版本需要删除。",
          "shared/ 不写入。",
        ].join("\n"),
      );
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_deploy",
        danger: "destructive",
        summary: "部署开始",
        command: `${input.localPath} -> ${plan.releaseDir}`,
        confirmed: true,
      }, { required: isProdHost(host) });
      const bytes = statSync(input.localPath).size;
      const factor = kind === "tar" ? 3 : 2;
      const space = await checked(host.id, `df -Pk ${shellQuote(layout.root)} | awk 'NR==2 { print $4 }'`);
      const freeKb = Number(space.stdout.trim());
      if (!Number.isFinite(freeKb)) throw new PolicyDeniedError(`读不到 ${layout.root} 的剩余空间，取消部署。`);
      if (freeKb * 1024 < bytes * factor) {
        throw new PolicyDeniedError(`${layout.root} 剩余 ${freeKb}KB，小于制品的 ${factor} 倍，取消部署。`);
      }
      await checked(host.id, `mkdir -p ${shellQuote(plan.sharedDir)} ${shellQuote(plan.releaseDir)}`);
      const previous = (await checked(host.id, `readlink ${shellQuote(plan.currentLink)} || true`)).stdout.trim();
      if (kind === "tar") {
        await pool.put(host.id, { localPath: input.localPath, remotePath: plan.partPath });
        const listed = await checked(host.id, `tar -tzf ${shellQuote(plan.partPath)}`);
        const rejected = rejectArchiveMembers(listed.stdout.split(/\n/), plan.releaseDir);
        if (rejected.length > 0) throw new BoundsError(`压缩包成员越界：${rejected.join(", ")}`);
        await checked(host.id, `tar -xzf ${shellQuote(plan.partPath)} -C ${shellQuote(plan.releaseDir)} && rm -f ${shellQuote(plan.partPath)}`);
      } else {
        await pool.put(host.id, { localPath: input.localPath, remotePath: `${plan.releaseDir}/${fileName}` });
      }
      await checked(host.id, `ln -sfn ${shellQuote(plan.releaseDir)} ${shellQuote(plan.currentLink)}`);
      if (restartCmd) await checked(host.id, restartCmd);
      let rolledBack = false;
      if (healthCmd) {
        const health = await pool.exec(host.id, { command: `${healthCmd}; exit $?` });
        if (health.exitCode !== 0) {
          if (!previous) throw new PolicyDeniedError(`健康检查失败，而且没有上一版可切回。当前停在 ${plan.releaseDir}`);
          await checked(host.id, `ln -sfn ${shellQuote(previous)} ${shellQuote(plan.currentLink)}`);
          if (restartCmd) await checked(host.id, restartCmd);
          const again = await pool.exec(host.id, { command: healthCmd });
          if (again.exitCode !== 0) throw new PolicyDeniedError(`已切回 ${previous}，但健康检查仍然失败。`);
          rolledBack = true;
        }
      }
      for (const old of doomed) {
        if (previous.endsWith(`/${old}`)) continue;
        checkReleaseId(old);
        await checked(host.id, `rm -rf ${shellQuote(`${plan.releasesDir}/${old}`)}`);
      }
      return { releaseId, current: rolledBack ? previous : plan.releaseDir, rolledBack };
    },
    async rollback(input: { host?: string; to?: string; file?: string; reason?: string; ui?: ConfirmUi }) {
      const file = hosts();
      const host = concrete(selectHost(file, input.host));
      if (policyOf(file).readonly) throw new PolicyDeniedError("只读模式拒绝回滚。");
      requireReason(host, "destructive", input.reason);
      if (input.file) {
        await ask(input.ui, `${host.name}：恢复文件`, input.file);
        await connect(host);
        const quoted = shellQuote(input.file);
        const moved = await pool.exec(host.id, { command: `latest=$(ls -1t ${quoted}.bak.* 2>/dev/null | head -1); test -n "$latest" && mv "$latest" ${quoted}` });
        if (moved.exitCode !== 0) throw new PolicyDeniedError(`没有可用备份，或恢复 ${input.file} 失败。`);
        return { releaseId: "", current: input.file };
      }
      const root = host.deploy?.root;
      if (!root) throw new PolicyDeniedError(`${host.name} 没有 deploy 布局，不能回滚 release。`);
      const restartCmd = host.deploy?.restartCmd;
      const plan = planRelease(host.deploy!, input.to && input.to !== "previous" ? input.to : "placeholder", "artifact");
      await connect(host);
      const current = (await pool.exec(host.id, { command: `readlink ${shellQuote(plan.currentLink)} || true` })).stdout.trim();
      const listed = await pool.exec(host.id, { command: `ls -1 ${shellQuote(root + "/releases")}` });
      const releases = listed.stdout.split(/\n/).map((item) => item.trim()).filter(Boolean).sort();
      const target = input.to && input.to !== "previous"
        ? input.to
        : releases.filter((item) => !current.endsWith(`/${item}`)).at(-1);
      if (!target) throw new PolicyDeniedError("没有可回滚的上一版。");
      checkReleaseId(target);
      const releaseDir = `${root}/releases/${target}`;
      await ask(input.ui, `${host.name}：回滚到 ${target}`, [
        `${plan.currentLink} -> ${releaseDir}`,
        restartCmd ? `重启：${restartCmd}` : "没有重启命令",
      ].join("\n"));
      await pool.exec(host.id, { command: `ln -sfn ${shellQuote(releaseDir)} ${shellQuote(plan.currentLink)}` });
      if (restartCmd) await pool.exec(host.id, { command: restartCmd });
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_rollback",
        danger: "destructive",
        summary: `回滚到 ${target}`,
        command: releaseDir,
        confirmed: true,
      }, { required: isProdHost(host) });
      return { releaseId: target, current: releaseDir };
    },
    async tunnel(input: { host?: string; listenPort: number; destHost: string; destPort: number; direction?: "local" | "remote"; ui?: ConfirmUi }) {
      const host = concrete(selectHost(hosts(), input.host));
      if (host.transport !== "ssh2") {
        throw new PolicyDeniedError("端口转发目前只走 ssh2。");
      }
      if (!Number.isInteger(input.listenPort) || input.listenPort < 0 || input.listenPort > 65535) {
        throw new PolicyDeniedError("listenPort 必须是 0 到 65535 的整数。0 表示由系统选空闲端口。");
      }
      await ask(
        input.ui,
        `${host.name}：端口转发`,
        `本机 127.0.0.1:${input.listenPort || "自动"} -> ${input.destHost}:${input.destPort}`,
      );
      await connect(host);
      const opened = input.direction === "remote"
        ? await pool.tunnelRemote(host.id, input.listenPort, input.destHost, input.destPort)
        : await pool.tunnel(host.id, input.listenPort, input.destHost, input.destPort);
      tunnels.push(opened);
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_tunnel",
        danger: "write",
        summary: "本地端口转发",
        command: `127.0.0.1:${opened.port} -> ${input.destHost}:${input.destPort}`,
        confirmed: true,
      });
      return opened;
    },
    async get(input: { host?: string; remotePath: string; localPath: string }) {
      const host = concrete(selectHost(hosts(), input.host));
      if (host.transport === "ftp" || host.transport === "ftps") {
        const result = await ftpGet(withPassword(host), input.remotePath, input.localPath);
        appendAudit(auditPath, { host: host.name, tool: "ssh_get", danger: "read", summary: "FTP 下载", command: input.remotePath });
        return { bytes: result.bytes, sha256: "local-only" };
      }
      if (host.transport === "openssh") {
        await copyOpenSsh(host, "get", input.localPath, input.remotePath);
        appendAudit(auditPath, { host: host.name, tool: "ssh_get", danger: "read", summary: "scp 下载", command: input.remotePath });
        return { bytes: 0, sha256: "" };
      }
      await connect(host);
      const result = await pool.get(host.id, { remotePath: input.remotePath, localPath: input.localPath });
      appendAudit(auditPath, {
        host: host.name,
        tool: "ssh_get",
        danger: "read",
        summary: "下载远端文件",
        command: `${input.remotePath} -> ${input.localPath}`,
      });
      return result;
    },
  };
}
