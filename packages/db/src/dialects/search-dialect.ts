// dialects/search-dialect.ts —— 搜索家族基类（DSL 解析、端点白名单 verdict）
// 注：搜索交互是"发 DSL JSON、拿文档结果"，与关系型/KV 的语句·命令语义不同，独立成基类

import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  QueryResult } from "../core/types.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";

// ── DSL 解封（Spec §4.3 DSL 信封约定）───
// JSON 顶层 key 映射端点：query/count→读（_search/_count）；mget/mget_docs→读（_mget）；
// bulk/doc_write/delete/update/mapping/settings→写；非 JSON 纯字符串→query_string 简化搜索
export type DslKind =
  | { type: "read"; endpoint: "_search" | "_count" | "_mget"; detail: string }
  | { type: "write"; endpoint: string; detail: string }
  | { type: "query_string"; text: string };

const READ_KEYS: Record<string, "_search" | "_count" | "_mget"> = {
  query: "_search",
  count: "_count",
  mget: "_mget",
  mget_docs: "_mget",
};

const WRITE_KEYS = ["bulk", "doc_write", "delete", "update", "mapping", "settings"];

/** 无 query 键的纯检索体安全键（aggs-only / size/sort 等 _search body），按读分类 */
const SEARCH_BODY_KEYS: ReadonlySet<string> = new Set([
  "aggs", "aggregations", "size", "from", "sort", "_source", "fields",
  "docvalue_fields", "stored_fields", "highlight", "suggest", "collapse",
  "track_total_hits", "min_score", "post_filter", "indices_boost",
  "terminate_after", "timeout", "version", "seq_no_primary_term", "explain", "knn",
]);

// `DELETE <index>` 纯字符串形式（删索引）恒拒——大小写不敏感、前导空白容忍
const DELETE_INDEX_RE = /^\s*DELETE\s+\S+/i;

export function parseDsl(input: string): DslKind {
  const trimmed = input.trim();
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { type: "query_string", text: trimmed };
    }
    const keys = Object.keys(body);
    for (const k of keys) {
      const ep = READ_KEYS[k.toLowerCase()];
      if (ep) return { type: "read", endpoint: ep, detail: describeDetail(body) };
    }
    for (const k of keys) {
      if (WRITE_KEYS.includes(k.toLowerCase())) {
        return { type: "write", endpoint: k, detail: describeDetail(body) };
      }
    }
    // 纯检索体（aggs/sort/size 等无 query 键的 _search body）按读
    if (keys.some((k) => SEARCH_BODY_KEYS.has(k.toLowerCase()))) {
      return { type: "read", endpoint: "_search", detail: describeDetail(body) };
    }
    // JSON 但无已知信封 key——保守按写处理（未知操作的写意图不可排除）
    return { type: "write", endpoint: keys[0] ?? "unknown", detail: describeDetail(body) };
  } catch {
    return { type: "query_string", text: trimmed };
  }
}

function describeDetail(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  const first = keys[0] ?? "";
  const sub = body[first];
  if (sub !== null && typeof sub === "object" && !Array.isArray(sub)) {
    const subKeys = Object.keys(sub as Record<string, unknown>);
    if (subKeys.length > 0) return `${first}/${subKeys[0]}`;
  }
  return first;
}

export abstract class SearchDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ParsedTarget | null;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;
  // 注：doSearch 直接收驱动 client（unknown），各方言内部收窄为私有客户端类型
  protected abstract doSearch(client: unknown, config: ConnConfig, sql: string, kind: DslKind, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }>;

  isAllowed(sql: string, readonly: boolean): Verdict {
    const trimmed = sql.trim();
    if (!trimmed) return { ok: false, reason: "查询内容为空" };
    // DELETE <index> 纯字符串形式恒拒（与只读开关无关）
    if (DELETE_INDEX_RE.test(trimmed)) {
      return { ok: false, reason: `禁止删除索引：${trimmed.slice(0, 80)}`, isWrite: true, summary: `DELETE 索引（硬限制）: ${trimmed.slice(0, 40)}` };
    }
    const kind = parseDsl(trimmed);
    if (kind.type === "query_string") {
      const summary = `SEARCH（query_string 简化搜索）`;
      return { ok: true, isWrite: false, summary };
    }
    if (kind.type === "read") {
      const summary = `SEARCH（${kind.endpoint}/${kind.detail || "match"}）`;
      return { ok: true, isWrite: false, summary };
    }
    // 写端点：本方言 executeOn 仅实现读，早期明确拒绝
    // （原先只读模式才拒、可写模式放行到确认后才报“仅执行读查询”，体验差）
    const summary = `SEARCH（${kind.endpoint}/${kind.detail || "write"}）`;
    return {
      ok: false,
      reason: `ES 方言仅支持读查询（_search/_count/_mget），写端点不支持：${kind.endpoint}`,
      isWrite: true,
      summary,
    };
  }

  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const kind = parseDsl(sql.trim());
    try {
      const last = await this.withConnection(config, (conn) => this.doSearch(conn.client, config, sql, kind, opts), opts.timeoutSec * 1000);
      return { success: true, ...last, duration: `${Date.now() - start}ms` };
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
