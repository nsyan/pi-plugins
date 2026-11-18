// core/config.ts —— 主机配置。0600、原子写、按 mtime 缓存。不依赖 pi。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EMPTY_HOST_FILE, type HostFile } from "./types.js";

export function defaultConfigPath(): string {
  return join(homedir(), ".pi", "agent", "ssh-hosts.json");
}

const cache = new Map<string, { mtimeMs: number; size: number; data: HostFile }>();

export function clearConfigCache(): void {
  cache.clear();
}

export function loadHosts(file = defaultConfigPath()): HostFile {
  if (!existsSync(file)) return structuredClone(EMPTY_HOST_FILE);
  const stat = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return structuredClone(hit.data);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HostFile>;
    const data: HostFile = {
      hosts: parsed.hosts && typeof parsed.hosts === "object" ? parsed.hosts : {},
      activeHost: typeof parsed.activeHost === "string" ? parsed.activeHost : undefined,
      policy: parsed.policy,
    };
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return structuredClone(data);
  } catch {
    return structuredClone(EMPTY_HOST_FILE);
  }
}

export function saveHosts(file: string, data: HostFile): void {
  const next = JSON.stringify(data, null, 2) + "\n";
  if (existsSync(file) && readFileSync(file, "utf8") === next) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  const stat = statSync(file);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data: structuredClone(data) });
}
