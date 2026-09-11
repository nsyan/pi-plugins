// dialects/graph-dialect.ts —— 图家族基类（Cypher 语句切分、读写分类、结果拍平）
// 交互形态：query_database 的 sql 参数填 Cypher 原文（与关系型"逐条执行取最后一条结果"一致，
//     支持分号分隔多语句；注释与字符串字面量内的分号不切分）。
// 首个实现为 Neo4j（bolt 协议官方驱动）。与 Mongo JSON 信封语义不同，独立成基类。

import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  QueryResult } from "../core/types.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";
import { stripComments, splitStatements } from "../core/sql-text.js";

// ── Cypher 读写分类（本家族管控核心，Spec 共识：关键字白名单 + 保守兜底）──────
// 读 = MATCH/OPTIONAL MATCH/RETURN/WITH/UNWIND/SHOW（白名单类目）/CALL 只读过程白名单；
// 写 = CREATE/MERGE/DELETE/DETACH/SET/REMOVE/DROP/FOREACH/LOAD CSV/TERMINATE 任意出现；
// 恒拒 = CALL dbms.*（管理过程，与只读开关无关）；未知语句保守按写。

/** 只读 CALL 过程白名单（小写精确前缀匹配；schema/元数据核心过程，不依赖 APOC） */
const READ_PROCEDURES: ReadonlySet<string> = new Set([
  "db.labels", "db.relationshipTypes", "db.propertyKeys",
  "db.indexes", "db.constraints",
  "db.schema.visualization", "db.schema.nodeTypeProperties", "db.schema.relTypeProperties",
]);

/** SHOW 允许的类目（其后第一个词）；TRANSACTIONS 需进一步排除 TERMINATE */
const SHOW_CATEGORIES = /^(INDEX(?:ES)?|CONSTRAINT(?:S)?|PROCEDURES?|FUNCTIONS?|SETTINGS|DATABASES?|TRANSACTIONS?)\b/i;

/** 写关键字（任意深度出现即整条按写）；字面量已剥离，不受字符串内容误伤 */
// 注：(?<![\w.$`]) 防止 n.create / `Remove` 这类属性名·反引号标识符误命中；
//     CALL {} 子查询本身不算写——子查询内的写关键字会被扫到，纯读子查询放行 */
const WRITE_KEYWORD_RE =
  /(?<![\w.$`])(?:CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|TERMINATE)(?![\w$`])|LOAD\s+CSV/i;

/** 剥离字符串字面量（' "）与反引号标识符内容，防止值内写词误判 */
function stripLiterals(text: string): string {
  let out = "";
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q) q = null; // 字面量内容整体丢弃（Cypher '' 双写转义已随内容消失）
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; out += " "; continue; }
    out += ch;
  }
  return out;
}

/** 单条 Cypher 语句分类（isAllowed 与 executeOn 共用，保证裁决与执行一致） */
export function classifyStatement(stmt: string): Verdict {
  const clean = stripComments(stmt);
  const head = clean.trim().slice(0, 80);
  const text = stripLiterals(clean);
  const summary = head.replace(/\s+/g, " ");

  // 1) CALL dbms.* 管理过程恒拒（版本查询走 versionQuery 直连，不经此裁决）
  if (/\bCALL\s+dbms\./i.test(text)) {
    return { ok: false, reason: `禁止执行管理过程：CALL dbms.*（硬限制）`, isWrite: true, summary: `${summary}（硬限制）` };
  }
  // 2) SHOW 类目白名单；TERMINATE 已被写关键字拦截（TRANSACTION ... TERMINATE）
  const showM = /^\s*SHOW\s+(\w+)/i.exec(text);
  if (showM) {
    if (!SHOW_CATEGORIES.test(showM[1])) {
      return { ok: false, reason: `未知 SHOW 类目：${showM[1]}（按拒绝处理）`, isWrite: true, summary };
    }
    return { ok: true, isWrite: WRITE_KEYWORD_RE.test(text), summary };
  }
  // 3) 任意深度写关键字 → 按写（含 MATCH ... DELETE、FOREACH 内写、CALL {} 子查询写）
  const isWrite = WRITE_KEYWORD_RE.test(text);
  if (isWrite) return { ok: true, isWrite: true, summary };
  // 4) CALL 过程：扫描全部过程名，任一不在白名单 → 保守按写
  //    （apoc.* 无法安全区分读写，统一走写确认；dbms.* 已在步骤 1 恒拒）
  const procs = [...text.matchAll(/\bCALL\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());
  if (procs.length > 0) {
    if (procs.every((p) => READ_PROCEDURES.has(p))) return { ok: true, isWrite: false, summary };
    return { ok: true, isWrite: true, summary: `${summary}（未知过程，按写）` };
  }
  // 5) 已知读开头（MATCH/OPTIONAL/RETURN/WITH/UNWIND）→ 读；其余未知保守按写
  if (/^\s*(MATCH|OPTIONAL|RETURN|WITH|UNWIND)\b/i.test(text)) {
    return { ok: true, isWrite: false, summary };
  }
  return { ok: true, isWrite: true, summary: `${summary}（未知语句，按写）` };
}

/** 多语句分类：任一写 → 整体按写；任一恒拒 → 整体拒绝 */
export function classifyCypher(sql: string): Verdict {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) {
    return { ok: false, reason: "Cypher 语句不能为空，如 MATCH (n:Person) RETURN n LIMIT 10" };
  }
  let anyWrite = false;
  const parts: string[] = [];
  for (const s of stmts) {
    const v = classifyStatement(s);
    if (!v.ok) return v;
    if (v.isWrite) anyWrite = true;
    if (v.summary) parts.push(v.summary);
  }
  return { ok: true, isWrite: anyWrite, summary: stmts.length > 1 ? `${stmts.length} 条语句` : parts[0] ?? "" };
}

// ── 结果拍平（Record → 行；Node/Relationship/Path 等 graph 类型转展示原语）───

/** 驱动值 → 展示原语：Node/Relationship 摘要、Integer 取数值、时间类型 ISO、其余 JSON */
export function cellOf(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  const t = v as { __isInteger__?: boolean; toString?: () => string;
    labels?: string[]; properties?: Record<string, unknown>;
    type?: string; startNodeElementId?: string; endNodeElementId?: string;
    elementId?: string; segments?: unknown[];
    toISOString?: () => string };
  // neo4j Integer（驱动返回自定义类型，防超长精度丢失）
  if (typeof v === "object" && t.__isInteger__ && typeof t.toString === "function") {
    const n = Number(t.toString());
    return Number.isSafeInteger(n) ? n : t.toString();
  }
  // Node：label(:a:b) + 属性 JSON
  if (Array.isArray(t.labels)) {
    return (t.labels.map((l) => `:${l}`).join("") || ":?")
      + " " + JSON.stringify(t.properties ?? {});
  }
  // Relationship：-[TYPE]-> + 属性 JSON
  if (typeof t.type === "string" && t.startNodeElementId !== undefined) {
    return `-(${t.type})-> ${JSON.stringify(t.properties ?? {})}`;
  }
  // Path：段数摘要（节点/关系全展开过于冗长）
  if (Array.isArray(t.segments)) return `<path:${t.segments.length}>`;
  // 时间类型：统一 ISO 字符串
  if (typeof t.toISOString === "function") return t.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

export function flattenRecords(
  records: unknown[],
  maxRows: number,
): { columns: string[]; rows: unknown[][]; rowCount: number; truncated?: boolean } {
  const shown = records.slice(0, maxRows);
  const columns: string[] = [];
  const rows: unknown[][] = [];
  for (const r of shown) {
    const keys = (r as { keys?: string[] }).keys ?? [];
    const values = (r as { _fields?: unknown[] })._fields ?? [];
    for (const k of keys) if (!columns.includes(k)) columns.push(k);
    rows.push(keys.map((_, i) => cellOf(values[i])));
  }
  return { columns, rows, rowCount: rows.length, truncated: records.length >= maxRows };
}

// ── 基类 ──────────────────────────────────────────

export abstract class GraphDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ParsedTarget | null;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;
  /** 在图数据库上执行一条 Cypher 语句，返回驱动 Record 数组（database 缺省由方言决定） */
  protected abstract runCypher(conn: DbConnection, config: ConnConfig,
    cypher: string): Promise<{ records: unknown[]; summary: unknown }>;
  abstract listTables(config: ConnConfig, pattern?: string): Promise<import("../core/types.js").ListTablesResult>;
  abstract describeTable(config: ConnConfig, target: string): Promise<import("../core/types.js").DescribeTableResult>;

  isAllowed(sql: string, readonly: boolean): Verdict {
    const verdict = classifyCypher(sql);
    if (!verdict.ok) return verdict;
    if (verdict.isWrite && readonly) {
      return { ...verdict, ok: false, reason: `只读模式下不允许执行写语句：${verdict.summary}` };
    }
    return verdict;
  }

  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const verdict = classifyCypher(sql);
    if (!verdict.ok) {
      return { success: false, error: verdict.reason ?? "语句被拒绝", duration: `${Date.now() - start}ms` };
    }
    try {
      const stmts = splitStatements(sql);
      const result = await this.withConnection(config, async (conn) => {
        let last: { records: unknown[]; summary: unknown } = { records: [], summary: null };
        for (const s of stmts) last = await this.runCypher(conn, config, s);
        return last;
      }, opts.timeoutSec * 1000);
      const { columns, rows, rowCount, truncated } = flattenRecords(result.records, opts.maxRows);
      const counters = summarizeCounters(result.summary);
      // 写语句无返回记录时，用单列结果行回显变更统计（否则 rowCount=0 无反馈）
      const outColumns = counters && columns.length === 0 ? ["result"] : columns;
      const outRows = counters && columns.length === 0 ? [[counters]] : rows;
      return {
        success: true, columns: outColumns, rows: outRows, rowCount: outRows.length,
        truncated, duration: `${Date.now() - start}ms`,
      };
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

/** 写语句统计摘要（driver summary.counters → "created 2 nodes, set 3 props"） */
function summarizeCounters(summary: unknown): string | undefined {
  const c = (summary as { counters?: { _stats?: Record<string, number> } })?.counters?._stats;
  if (!c) return undefined;
  const LABELS: Record<string, string> = {
    nodesCreated: "创建节点", nodesDeleted: "删除节点", relationshipsCreated: "创建关系",
    relationshipsDeleted: "删除关系", propertiesSet: "设置属性", labelsAdded: "添加标签",
    labelsRemoved: "移除标签", indexesAdded: "创建索引", indexesRemoved: "删除索引",
    constraintsAdded: "创建约束", constraintsRemoved: "删除约束",
  };
  const parts = Object.entries(c)
    .filter(([k, v]) => v > 0 && LABELS[k])
    .map(([k, v]) => `${LABELS[k]} ${v}`);
  return parts.length > 0 ? parts.join("，") : undefined;
}
