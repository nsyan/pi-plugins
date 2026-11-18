// core/audit.ts —— 追加 JSONL。stdin 永不落明文。单文件超过 1MB 就滚动，只保留最近 7 份归档。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AuditUnavailableError } from "./types.js";

const MAX_AUDIT_BYTES = 1024 * 1024;
const MAX_AUDIT_ARCHIVES = 7;

export interface AuditEntry {
  ts?: string;
  host: string;
  tool: string;
  danger?: string;
  summary?: string;
  command?: string;
  stdin?: string;
  confirmed?: boolean;
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  [key: string]: unknown;
}

export function defaultAuditPath(): string {
  return join(homedir(), ".pi", "agent", "ssh-audit.jsonl");
}

export function redact(entry: AuditEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry, ts: entry.ts ?? new Date().toISOString() };
  if (entry.stdin !== undefined) out.stdin = "<redacted>";
  return out;
}

export function appendAudit(
  file: string,
  entry: AuditEntry,
  opts?: { required?: boolean; maxBytes?: number; keep?: number },
): void {
  const line = JSON.stringify(redact(entry)) + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateAudit(file, opts?.maxBytes ?? MAX_AUDIT_BYTES, opts?.keep ?? MAX_AUDIT_ARCHIVES);
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    if (opts?.required) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AuditUnavailableError(`审计日志不可写：${message}`);
    }
  }
}

function rotateAudit(file: string, maxBytes: number, keep: number): void {
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const archive = file.replace(/\.jsonl$/, `.${stamp}.jsonl`);
  renameSync(file, archive);
  chmodSync(archive, 0o600);
  const prefix = `${basename(file, ".jsonl")}.`;
  const old = readdirSync(dirname(file))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .map((name) => join(dirname(file), name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const path of old.slice(0, Math.max(0, old.length - keep))) unlinkSync(path);
}

export function readAudit(file = defaultAuditPath()): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
