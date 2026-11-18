// core/secrets.ts —— 凭据只进 0600 文件。钥匙串只负责读取已有项。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface SecretFile {
  hosts: Record<string, string>;
}

function load(file: string): SecretFile {
  if (!existsSync(file)) return { hosts: {} };
  let parsed: Partial<SecretFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SecretFile>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`凭据文件损坏，拒绝覆盖 ${file}：${message}`);
  }
  if (!parsed.hosts || typeof parsed.hosts !== "object") {
    throw new Error(`凭据文件缺少 hosts，拒绝覆盖 ${file}`);
  }
  return { hosts: parsed.hosts };
}

function save(file: string, data: SecretFile): void {
  const next = JSON.stringify(data, null, 2) + "\n";
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function defaultSecretsPath(): string {
  return join(homedir(), ".pi", "agent", "ssh-secrets.json");
}

export function putSecret(file: string, host: string, secret: string): void {
  const data = load(file);
  data.hosts[host] = secret;
  save(file, data);
}

export function getSecret(file: string, host: string): string | undefined {
  return load(file).hosts[host];
}

export function deleteSecret(file: string, host: string): void {
  const data = load(file);
  delete data.hosts[host];
  save(file, data);
}

export interface Keychain {
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, secret: string): Promise<void>;
}

export function linuxKeychain(): Keychain {
  return {
    async get(service, account) {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = spawn("secret-tool", ["lookup", "service", service, "account", account], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        child.on("close", (code) => resolve(code === 0 ? out.trim() : undefined));
        child.on("error", () => resolve(undefined));
      });
    },
    async set(service, account, secret) {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn("secret-tool", ["store", "--label", "pi-ssh", "service", service, "account", account], { stdio: ["pipe", "ignore", "ignore"] });
        child.stdin.end(secret);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`secret-tool 退出码 ${code}`))));
        child.on("error", reject);
      });
    },
  };
}

export function macKeychain(): Keychain {
  return {
    async get(service, account) {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = spawn("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        child.on("close", (code) => resolve(code === 0 ? out.trim() : undefined));
        child.on("error", () => resolve(undefined));
      });
    },
    async set(_service, _account, _secret) {
      throw new Error("macOS 的 security 不能从 stdin 收密码，-w 会把密码留在进程参数里。密码改写入 0600 的 ssh-secrets.json。");
    },
  };
}

export function platformKeychain(): Keychain {
  if (process.platform === "linux") return linuxKeychain();
  if (process.platform === "darwin") return macKeychain();
  throw new Error("当前系统没有钥匙串。密码只写入 0600 的 ssh-secrets.json。");
}
