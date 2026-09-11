// dialects/kv-dialect.ts —— KV 家族基类（命令切分、白名单 verdict、sendCommand 执行）
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  QueryResult } from "../core/types.js";
import { matchCommand } from "../core/whitelist.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";

// ── 命令切分（空白 + 双引号）───
// 注：Redis 无分号语句概念，sql 整体视为一条命令
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (cur) { parts.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

// ── 只读命令白名单（Spec §4.2；KEYS 已移除，生产库一律 SCAN）───
const READ_CMDS = [
  "GET", "MGET", "HGETALL", "HGET", "HMGET", "HKEYS", "HVALS", "HLEN",
  "LRANGE", "LLEN", "LINDEX", "SMEMBERS", "SCARD", "SISMEMBER",
  "ZRANGE", "ZSCORE", "ZCARD", "SCAN", "TYPE", "TTL", "PTTL", "EXISTS",
  "STRLEN", "GETRANGE", "INFO", "DBSIZE", "RANDOMKEY", "OBJECT", "MEMORY",
  "PING", "TIME", "ECHO", "LOLWUT", "LASTSAVE",
];

// ── 恒拒命令（与只读开关无关；CONFIG 一刀切含 CONFIG GET，有意从紧）───
const DENY_ALWAYS = ["FLUSHALL", "FLUSHDB", "CONFIG", "SHUTDOWN", "SLAVEOF", "REPLICAOF", "DEBUG"];

export abstract class KvDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ParsedTarget | null;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;
  // 注：doSendCommand 直接收驱动 client（unknown），各方言内部收窄为私有连接类型
  protected abstract doSendCommand(client: unknown, args: string[]): Promise<unknown>;

  isAllowed(sql: string, readonly: boolean): Verdict {
    const args = splitCommand(sql);
    if (args.length === 0) return { ok: false, reason: "命令为空" };
    const cmd = args[0].toUpperCase();
    const rest = args.slice(1).join(" ");
    const summary = `${cmd}${rest ? " " + rest.slice(0, 40) : ""}`;
    if (matchCommand(cmd, DENY_ALWAYS)) {
      return { ok: false, reason: `禁止执行危险命令：${cmd}`, isWrite: true, summary: `${cmd}（硬限制）` };
    }
    if (matchCommand(cmd, READ_CMDS)) {
      return { ok: true, isWrite: false, summary };
    }
    if (readonly) {
      return { ok: false, reason: `只读模式下不允许执行写命令：${cmd}`, isWrite: true, summary };
    }
    return { ok: true, isWrite: true, summary };
  }

  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const args = splitCommand(sql);
    if (args.length === 0) {
      return { success: false, error: "命令为空" };
    }
    try {
      const raw = await this.withConnection(config, (conn) => this.doSendCommand(conn.client, args), opts.timeoutSec * 1000);
      const rows = toRows(args[0], raw).slice(0, opts.maxRows);
      const columns = ["result"];
      return { success: true, columns, rows, rowCount: rows.length, duration: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), duration: `${Date.now() - start}ms` };
    }
  }

  async withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs = 10_000): Promise<T> {
    const conn = await this.doConnect(config, timeoutMs);
    try { return await fn(conn); }
    finally { await conn.close(); }
  }

  async testConnection(config: ConnConfig): Promise<import("../core/types.js").TestConnectionResult> {
    const start = Date.now();
    try {
      const version = await this.withConnection(config, (conn) => this.versionQuery(conn));
      return { success: true, version, latency: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), latency: `${Date.now() - start}ms` };
    }
  }
  abstract listTables(config: ConnConfig, pattern?: string): Promise<import("../core/types.js").ListTablesResult>;
  abstract describeTable(config: ConnConfig, target: string): Promise<import("../core/types.js").DescribeTableResult>;
}

// ── 命令结果转行（展示层统一转字符串，保持原类型）───
// ioredis sendCommand 对字符串响应可能返回 Buffer，先递归解码为 UTF-8
// （否则 INFO/SCAN/GET 等会按字节逐行渲染成乱码数字）
function decodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, decodeValue(x)]));
  }
  return v;
}

function toRows(cmd: string, raw: unknown): unknown[][] {
  raw = decodeValue(raw);
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    // 偶数长度数组（HGETALL 等）按 k/v 配对展示
    if (cmd.toUpperCase() === "HGETALL" && raw.length % 2 === 0) {
      const out: unknown[][] = [];
      for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
      return out;
    }
    return raw.map((v) => [Array.isArray(v) ? JSON.stringify(v) : v]);
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, v]);
  }
  return [[raw]];
}
