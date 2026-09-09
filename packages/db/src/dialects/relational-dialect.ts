// src/dialects/relational-dialect.ts
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget } from "../core/types.js";
import type { QueryResult } from "../core/types.js";
import { splitStatements, isWriteStatement, isDropStatement } from "../core/sql-text.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";

export abstract class RelationalDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ParsedTarget | null;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;
  // 注：doExecute 直接收驱动 client（unknown），各方言内部收窄为私有连接类型
  protected abstract doExecute(client: unknown, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }>;

  async withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs = 10_000): Promise<T> {
    const conn = await this.doConnect(config, timeoutMs);
    try { return await fn(conn); }
    finally { await conn.close(); }
  }

  // testConnection 复用 withConnection（连接泄漏防护）；versionQuery 由各方言实现

  isAllowed(sql: string, readonly: boolean): Verdict {
    const stmts = splitStatements(sql);
    if (stmts.length === 0) return { ok: false, reason: "SQL 语句为空" };
    for (const s of stmts) {
      if (isDropStatement(s)) {
        return { ok: false, reason: `禁止执行 DROP 操作：${s.slice(0, 80)}`, summary: `DROP（硬限制）: ${s.slice(0, 60)}` };
      }
    }
    const first = stmts[0];
    const kind = /^\s*(\w+)/.exec(first)?.[1]?.toUpperCase() ?? "SQL";
    const targets = [...first.matchAll(/\b(?:FROM|INTO|UPDATE|TABLE)\s+([A-Za-z0-9_."]+)/gi)].map((m) => m[1]).slice(0, 3).join(", ");
    const summary = `${kind}${targets ? " " + targets : ""}（共 ${stmts.length} 条语句）`;
    if (readonly) {
      for (const s of stmts) {
        if (isWriteStatement(s)) {
          return { ok: false, reason: `只读模式下不允许执行非查询语句：${s.slice(0, 80)}`, isWrite: true, summary };
        }
      }
    }
    const isWrite = stmts.some(isWriteStatement);
    return { ok: true, isWrite, summary };
  }

  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const stmts = splitStatements(sql);
    try {
      let last = { columns: [] as string[], rows: [] as unknown[][], rowCount: 0 };
      await this.withConnection(config, async (conn) => {
        for (const s of stmts) last = await this.doExecute(conn.client, s, opts);
      }, opts.timeoutSec * 1000);
      return { success: true, ...last, duration: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), duration: `${Date.now() - start}ms` };
    }
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
