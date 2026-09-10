// dialects/document-dialect.ts —— 文档家族基类（JSON 命令信封解析、读写分类、limit 注入、结果拍平）
// 注：交互语义是"发 JSON 命令文档、拿文档结果"（db.runCommand 形态），与关系型/KV/搜索的
//     语句·命令·DSL 语义均不同，独立成基类。首个实现为 MongoDB（Spec 共识：Q1 选 JSON 信封）。

import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  QueryResult } from "../core/types.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";

// ── 信封分类（读写管控核心，Spec 共识 Q3）──────────────
// 读白名单 + 写需确认 + 管理/DDL/服务端 JS 恒拒 + 未知命令保守按写（ES parseDsl 同款兜底）

/** 读命令白名单（小写；find/count/distinct/aggregate 分类前会先过 JS/写回深扫） */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  "find", "count", "distinct", "aggregate",
  "collstats", "dbstats", "listcollections", "listindexes", "dataSize",
  "ping", "buildinfo", "hello", "ismaster", "isdbgrid", "serverstatus",
]);

/** 恒拒命令前缀（小写匹配；与只读开关无关）：DDL/复制集/分片/运维一刀切 */
const DENY_PREFIXES: readonly string[] = [
  "drop",       // drop / dropDatabase / dropIndexes / dropUsers ...
  "create",     // create / createIndexes / createUser / createSearchIndexes ...
  "replset",    // replSetInitiate / replSetReconfig / replSetStepDown ...
  "addshard", "removeshard", "balancer",
  "eval",       // eval / $eval 不走前缀也命中 DENY_COMMANDS，此处兜底变体
  "shutdown", "kill", "fsync", "repair", "compact", "configurefailpoint",
];

/** 恒拒命令（精确小写匹配） */
const DENY_COMMANDS: ReadonlySet<string> = new Set([
  "collmod", "renamecollection", "converttocapped", "clonecollectionascapped",
  "reindex", "setparameter", "setfeaturecompatibilityversion", "logrotate",
  "enablesharding", "shardcollection", "movechunk", "moveprimary", "split",
  "applyops", "currentop", "clone", "copydb", "clonecollection", "$eval",
]);

/** 服务端 JS 执行（任意深度出现即恒拒，Q3 共识） */
const JS_KEYS: ReadonlySet<string> = new Set(["$where", "$function", "$accumulator"]);
/** aggregate 写回管道阶段（任意深度出现 → 整条按写分类） */
const AGG_WRITE_KEYS: ReadonlySet<string> = new Set(["$out", "$merge"]);

/** 深度扫描：任意层的对象 key（小写）命中 targets 即 true */
export function hasAnyKey(node: unknown, targets: ReadonlySet<string>): boolean {
  if (Array.isArray(node)) return node.some((n) => hasAnyKey(n, targets));
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).some(([k, v]) =>
      targets.has(k.toLowerCase()) || hasAnyKey(v, targets));
  }
  return false;
}

export interface EnvelopeClassified {
  envelope?: Record<string, unknown>;
  verdict: Verdict;
}

/** 解析 + 分类一条命令信封（isAllowed 与 executeOn 共用，保证裁决与执行一致） */
export function classifyEnvelope(sql: string): EnvelopeClassified {
  let body: unknown;
  try {
    body = JSON.parse(sql.trim());
  } catch {
    return {
      verdict: {
        ok: false,
        reason: "MongoDB 命令信封必须是合法 JSON 对象，如 {\"find\":\"users\",\"filter\":{}}（单命令一次执行，不支持多语句）",
      },
    };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      verdict: { ok: false, reason: "命令信封必须是 JSON 对象（顶层 key 为命令名），如 {\"find\":\"users\"}" },
    };
  }
  const envelope = body as Record<string, unknown>;
  const cmd = Object.keys(envelope)[0] ?? "";
  const target = envelope[cmd];
  const summary = `${cmd}${typeof target === "string" ? " " + target.slice(0, 40) : ""}`;

  // 1) 服务端 JS 恒拒（比命令分类优先：$match 里夹带 $where 也拦）
  if (hasAnyKey(envelope, JS_KEYS)) {
    return {
      envelope,
      verdict: {
        ok: false,
        reason: "禁止服务端 JS 执行（$where / $function / $accumulator），与只读开关无关",
        isWrite: true,
        summary: `${summary}（硬限制）`,
      },
    };
  }
  // 2) 管理/DDL 恒拒（前缀 + 精确名单）
  const cmdLower = cmd.toLowerCase();
  if (DENY_PREFIXES.some((p) => cmdLower.startsWith(p)) || DENY_COMMANDS.has(cmdLower)) {
    return {
      envelope,
      verdict: {
        ok: false,
        reason: `禁止执行管理/DDL 命令：${cmd}（硬限制）`,
        isWrite: true,
        summary: `${summary}（硬限制）`,
      },
    };
  }
  // 3) aggregate 含 $out/$merge → 整条按写（readonly 由 isAllowed 统一裁决）
  if (cmdLower === "aggregate" && hasAnyKey(envelope, AGG_WRITE_KEYS)) {
    return { envelope, verdict: { ok: true, isWrite: true, summary: `${summary}（$out/$merge 写回）` } };
  }
  // 4) 读白名单
  if (READ_COMMANDS.has(cmdLower)) {
    return { envelope, verdict: { ok: true, isWrite: false, summary } };
  }
  // 5) 已知写命令与其余未知命令一律按写（未知写意图不可排除）
  return { envelope, verdict: { ok: true, isWrite: true, summary } };
}

// ── limit 注入（Spec 共识 Q8：无界查询自动封顶，bulk 上限 1000）───

/** 单条写命令文档数组上限（防手滑不防恶意；writable 模式另有确认框兜底） */
export const MAX_BULK_DOCS = 1000;

export function injectLimits(envelope: Record<string, unknown>, maxRows: number): void {
  const cmd = (Object.keys(envelope)[0] ?? "").toLowerCase();
  if (cmd === "find") {
    // Mongo 语义：limit ≤ 0 等价于“不限”，与未提供同等对待，一并收敛到 maxRows
    const userLimit = typeof envelope.limit === "number" && Number.isFinite(envelope.limit) && envelope.limit > 0
      ? envelope.limit : undefined;
    const limit = Math.min(Math.max(1, Math.trunc(userLimit ?? maxRows)), maxRows);
    envelope.limit = limit;
    envelope.batchSize = limit; // db.command 走 firstBatch，batchSize 决定单批返回量
    return;
  }
  if (cmd === "aggregate" && Array.isArray(envelope.pipeline)) {
    // 空 pipeline 同样需要封顶（全集合扫描）
    const last = envelope.pipeline.length > 0
      ? envelope.pipeline[envelope.pipeline.length - 1] as Record<string, unknown> | null
      : null;
    const hasTailLimit = last !== null && typeof last === "object"
      && ("$limit" in last || "$count" in last);
    if (!hasTailLimit) {
      envelope.pipeline = [...(envelope.pipeline as unknown[]), { $limit: maxRows }];
    }
    const cursor = (envelope.cursor !== null && typeof envelope.cursor === "object"
      ? { ...(envelope.cursor as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    cursor.batchSize = maxRows;
    envelope.cursor = cursor;
    return;
  }
  // 写命令文档数组封顶（insert/update/delete 的 documents 字段）
  for (const field of ["documents", "updates", "deletes"]) {
    const arr = envelope[field];
    if (Array.isArray(arr) && arr.length > MAX_BULK_DOCS) {
      envelope[field] = arr.slice(0, MAX_BULK_DOCS);
    }
  }
}

// ── 结果拍平（Spec 共识 Q7：顶层字段并集，上限 50 列）───

export const MAX_QUERY_COLUMNS = 50;

/** BSON 值 → 展示原语：ObjectId 取 hex、其余 BSON 优先 toJSON（Binary/UUID → base64，避免 [object Object]）、Date ISO、对象/数组 JSON */
function cellOf(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return v;
  const b = v as { toHexString?: () => string; _bsontype?: string; toJSON?: () => unknown };
  if (typeof b.toHexString === "function") return b.toHexString();
  if (b._bsontype) {
    const j = typeof b.toJSON === "function" ? b.toJSON() : undefined;
    return j !== undefined && j !== null && typeof j !== "object" ? j : JSON.stringify(v);
  }
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

export function flattenDocs(
  docs: unknown[],
  maxRows: number,
): { columns: string[]; rows: unknown[][]; rowCount: number; truncated?: boolean } {
  const shown = docs.slice(0, maxRows);
  // 列 = 顶层字段并集，首现顺序，封顶 MAX_QUERY_COLUMNS
  // truncated 语义对齐 bigdata 方言：结果数达 maxRows 上限即标截断（无法区分“恰好等于”）
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const d of shown) {
    if (columns.length >= MAX_QUERY_COLUMNS) break;
    if (d !== null && typeof d === "object" && !Array.isArray(d)) {
      for (const k of Object.keys(d as Record<string, unknown>)) {
        if (!seen.has(k)) {
          seen.add(k);
          columns.push(k);
          if (columns.length >= MAX_QUERY_COLUMNS) break;
        }
      }
    }
  }
  const rows = shown.map((d) => {
    if (d === null || typeof d !== "object" || Array.isArray(d)) return [cellOf(d)];
    const obj = d as Record<string, unknown>;
    return columns.map((c) => cellOf(obj[c]));
  });
  return { columns, rows, rowCount: rows.length, truncated: docs.length >= maxRows };
}

// ── 基类 ──────────────────────────────────────────

export abstract class DocumentDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ParsedTarget | null;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;
  /** 执行一条已过白名单的命令信封，返回驱动原始响应 */
  protected abstract doCommand(client: unknown, config: ConnConfig,
    envelope: Record<string, unknown>): Promise<unknown>;
  /** 原始响应 → 文档数组（MongoDB 取 cursor.firstBatch / distinct.values，默认整响应单行） */
  protected extractDocs(raw: unknown): unknown[] {
    return [raw];
  }
  abstract listTables(config: ConnConfig, pattern?: string): Promise<import("../core/types.js").ListTablesResult>;
  abstract describeTable(config: ConnConfig, target: string): Promise<import("../core/types.js").DescribeTableResult>;

  isAllowed(sql: string, readonly: boolean): Verdict {
    const { verdict } = classifyEnvelope(sql);
    if (!verdict.ok) return verdict;
    if (verdict.isWrite && readonly) {
      return { ...verdict, ok: false, reason: `只读模式下不允许执行写命令：${verdict.summary}` };
    }
    return verdict;
  }

  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const { envelope, verdict } = classifyEnvelope(sql);
    if (!envelope || !verdict.ok) {
      return { success: false, error: verdict.reason ?? "命令被拒绝", duration: `${Date.now() - start}ms` };
    }
    injectLimits(envelope, opts.maxRows);
    try {
      const raw = await this.withConnection(
        config,
        (conn) => this.doCommand(conn.client, config, envelope),
        opts.timeoutSec * 1000,
      );
      const docs = this.extractDocs(raw);
      const { columns, rows, rowCount, truncated } = flattenDocs(docs, opts.maxRows);
      return { success: true, columns, rows, rowCount, truncated, duration: `${Date.now() - start}ms` };
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
}
