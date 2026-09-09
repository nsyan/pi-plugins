// src/dialects/bigdata-dialect.ts —— 大数据 SQL 引擎家族基类（Hive / Spark Thrift Server 共享 HS2 协议栈）
// 注：Hive 与 Spark Thrift Server 同协议（HiveServer2 Thrift），连接建立、会话变量、
// 会话关闭、batch 拉取、取消 operation 全部在基类实现，方言只提供差异点
// （写关键字集、会话变量前缀、版本查询、DESCRIBE 解析）。
import type { ConnConfig, DbConnection, ExecOpts, QueryResult,
  ListTablesResult, DescribeTableResult, TestConnectionResult, TableInfo } from "../core/types.js";
import { splitStatements, isWriteStatement, isDropStatement } from "../core/sql-text.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";
import { likeMatch } from "./dialect.js";

// ── HS2 会话/操作最小结构（按 hive-driver 实际 API: HiveSession/HiveOperation）───
// 用 unknown + 收窄避免对 hive-driver 强类型依赖；仅单元测试可构造 FakeHs2Session。
export interface Hs2Operation {
  setMaxRows(n: number): void;
  fetch(): Promise<Hs2Status>;
  hasMoreRows(): boolean;
  getSchema(): { columns: Array<{ columnName: string; comment?: string }> } | null;
  getData(): Array<{ rows?: Array<{ colVals: Array<{ value?: unknown }> }> }>;
  flush(): void;
  cancel(): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface Hs2Session {
  executeStatement(stmt: string): Promise<Hs2Operation>;
  close(): Promise<unknown>;
}
interface Hs2Status { statusCode?: number; errorMessage?: string; }

function statusFailed(s: Hs2Status): string | null {
  const code = s?.statusCode;
  if (code === undefined || code === 0) return null;
  return s.errorMessage || `operation failed (statusCode=${code})`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时（超过 ${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export abstract class BigDataDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ReturnType<Dialect["parseUrl"]>;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  /** 方言的写关键字集（大小写不敏感正则片段，逐语句匹配） */
  protected abstract writeKeywords: RegExp;
  /** 会话变量前缀：hive. / spark.（SET <prefix>key=value 在 withConnection 内下发） */
  protected abstract sessionPrefix: string;

  // ── HS2 会话建立：openSession 由方言 doConnect 完成，client 即 Hs2Session ──
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;

  async withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs = 30_000): Promise<T> {
    // 建连（TCP 握手 + openSession）同样纳入超时，避免无界挂起；
    // 默认 30s（HS2 握手慢于关系型），各方言不再各自加超时
    const conn = await withTimeout(this.doConnect(config, timeoutMs), timeoutMs, "连接数据库");
    try { return await fn(conn); }
    finally { await conn.close(); }
  }

  // ── 只读检查：复用 sql-text 逐语句机制 + 家族写关键字（与 Task 1 WRITE_RE 一致方向）───
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
    const flagged = (s: string): boolean => isWriteStatement(s) || this.writeKeywords.test(s);
    if (readonly) {
      for (const s of stmts) {
        if (flagged(s)) {
          return { ok: false, reason: `只读模式下不允许执行非查询语句：${s.slice(0, 80)}`, isWrite: true, summary };
        }
      }
    }
    const isWrite = stmts.some(flagged);
    return { ok: true, isWrite, summary };
  }

  // ── 执行：executeStatement → 循环 fetch batch → 达 maxRows 即停 + truncated 标注 ──
  // 超时用客户端 withTimeout 兜底，超时后尝试 cancel 释放服务端资源
  protected async runStatement(session: Hs2Session, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }> {
    const op = await session.executeStatement(stmt);
    const execMs = opts.timeoutSec * 1000;
    try {
      const maxRows = Math.max(1, opts.maxRows);
      const status = await withTimeout(op.fetch(), execMs, "执行查询");
      const failed = statusFailed(status);
      if (failed) throw new Error(failed);
      op.setMaxRows(Math.min(maxRows, 1000));
      const schema = op.getSchema();
      const columns = (schema?.columns ?? []).map((c) => c.columnName);
      const rows: unknown[][] = [];
      let truncated = false;
      // 首批已在 fetch() 内拉取；逐批 hasMoreRows 拉取，达 maxRows 即停
      for (;;) {
        for (const rs of op.getData()) {
          for (const row of rs.rows ?? []) {
            if (rows.length >= maxRows) { truncated = true; break; }
            rows.push((row.colVals ?? []).map((cv) => cv?.value ?? null));
          }
          if (truncated) break;
        }
        op.flush();
        if (truncated || !op.hasMoreRows()) break;
        const st = await withTimeout(op.fetch(), execMs, "拉取结果");
        const f = statusFailed(st);
        if (f) throw new Error(f);
      }
      return { columns, rows, rowCount: rows.length, truncated };
    } catch (err: unknown) {
      try { await op.cancel(); } catch { /* 释放资源尽力而为 */ }
      throw err;
    } finally {
      try { await op.close(); } catch { /* ignore */ }
    }
  }

  // 版本查询统一走 runStatement 的受保护拉取路径（超时 + cancel + close），失败兜底 "unknown"
  protected async fetchVersion(session: Hs2Session, stmt = "SELECT version()", timeoutSec = 30): Promise<string> {
    try {
      const r = await this.runStatement(session, stmt, { readonly: true, maxRows: 1, timeoutSec });
      const val = r.rows[0]?.[0];
      return val !== undefined && val !== null ? String(val) : "unknown";
    } catch {
      return "unknown";
    }
  }
  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const stmts = splitStatements(sql);
    try {
      let last = { columns: [] as string[], rows: [] as unknown[][], rowCount: 0 };
      let truncated = false;
      await this.withConnection(config, async (conn) => {
        const session = conn.client as Hs2Session;
        for (const s of stmts) {
          const r = await this.runStatement(session, s, opts);
          last = { columns: r.columns, rows: r.rows, rowCount: r.rowCount };
          if (r.truncated) truncated = true;
        }
      }, opts.timeoutSec * 1000);
      const duration = `${Date.now() - start}ms`;
      return { success: true, ...last, duration, truncated: truncated || undefined };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), duration: `${Date.now() - start}ms` };
    }
  }

  async testConnection(config: ConnConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const version = await this.withConnection(config, (conn) => this.versionQuery(conn));
      return { success: true, version, latency: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), latency: `${Date.now() - start}ms` };
    }
  }

  // SHOW TABLES + 可选 pattern 过滤（HS2 无 LIKE 下推，内存过滤）
  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables = await this.withConnection(config, async (conn) => {
        const session = conn.client as Hs2Session;
        const r = await this.runStatement(session, "SHOW TABLES", { readonly: true, maxRows: 5000, timeoutSec: 30 });
        const nameIdx = r.columns.findIndex((c) => /table/i.test(c));
        const rows: TableInfo[] = r.rows
          .map((row) => String(row[nameIdx >= 0 ? nameIdx : 0] ?? ""))
          .filter((name) => name && (!pattern || likeMatch(name, pattern)))
          .map((name) => ({ schema: config.database ?? "", name, type: "TABLE", description: "" }));
        return rows;
      });
      return { success: true, tables, count: tables.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  abstract describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult>;
}
