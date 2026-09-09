// src/dialects/oracle.ts
import oracledb from "oracledb";
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  ListTablesResult, DescribeTableResult, ColumnInfo, TestConnectionResult } from "../core/types.js";
import { RelationalDialect } from "./relational-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析（从 index.ts parseJdbcUrl 原样搬入：service 名 + SID 双分支）───

const SVC_RE = /^jdbc:oracle:thin:@\/\/([^:/?#]+)(?::(\d+))?\/([^?#]+)$/;
const SID_RE = /^jdbc:oracle:thin:@([^:/?#]+)(?::(\d+))?:([^?#]+)$/;

function parseOracleUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0];
  const svc = clean.match(SVC_RE);
  if (svc) {
    const host = svc[1];
    const port = svc[2] ? parseInt(svc[2], 10) : 1521;
    const database = svc[3];
    if (!host || !database) return null;
    return { host, port, database };
  }
  const sid = clean.match(SID_RE);
  if (sid) {
    const host = sid[1];
    const port = sid[2] ? parseInt(sid[2], 10) : 1521;
    const database = sid[3];
    if (!host || !database) return null;
    return { host, port, database };
  }
  return null;
}

// ── Oracle 方言（逻辑从 src/db.ts 原样搬入）───

class OracleDialect extends RelationalDialect {
  id = "oracle" as const;
  label = "Oracle";
  family = "relational" as const;
  defaultPort = 1521;
  fingerprints: Fingerprints = {
    urlPatterns: [/^jdbc:oracle:thin:@/],
    configKeys: ["spring.datasource.url"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseOracleUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    return `jdbc:oracle:thin:@//${config.host}:${config.port}/${config.database}`;
  }

  // Spec §12：Thin 模式硬性要求 DB ≥12.1；连接失败且疑似老版本时给出版本原因指引
  async testConnection(config: ConnConfig): Promise<TestConnectionResult> {
    const result = await super.testConnection(config);
    if (!result.success
        && /ORA-28040|ORA-03134|no matching authentication protocol/i.test(result.error ?? "")) {
      result.error += "\n疑似 Oracle 服务端版本过低（<12.1）：Thin 模式要求服务端 ≥12.1，11g 及以下需 Thick 模式（Instant Client），暂未支持。请联系 DBA 升级或使用其他客户端。";
    }
    return result;
  }

  protected async doConnect(config: ConnConfig, _timeoutMs: number): Promise<DbConnection> {
    const conn = await oracledb.getConnection({
      user: config.username,
      password: config.password,
      connectString: `${config.host}:${config.port}/${config.database}`,
    });
    return {
      type: "oracle",
      client: conn,
      async close() { await conn.close(); },
    };
  }

  protected async doExecute(client: unknown, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
    const oracleConn = client as oracledb.Connection;
    const timeoutMs = opts.timeoutSec * 1000;
    const maxRows = opts.maxRows;
    const res = await oracleConn.execute(stmt, [], {
      maxRows,
      fetchArraySize: maxRows,
      timeout: timeoutMs,
    });
    if (res.metaData && res.metaData.length > 0) {
      const columns = res.metaData.map((m: any) => m.name);
      const rows = (res.rows ?? []).slice(0, maxRows).map((r: any) => [...r]);
      return { columns, rows, rowCount: res.rows?.length ?? 0 };
    }
    return { columns: [], rows: [], rowCount: res.rowsAffected ?? 0 };
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const oracleConn = conn.client as oracledb.Connection;
    const res = await oracleConn.execute("SELECT version FROM v$instance");
    return (res.rows ?? [])[0]?.[0] as string ?? "unknown";
  }

  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables = await this.withConnection(config, async (conn) => {
        const oracleConn = conn.client as oracledb.Connection;
        const res = await oracleConn.execute(
          `SELECT TABLE_NAME, OWNER, COMMENTS FROM ALL_TABLES T
           LEFT JOIN ALL_TAB_COMMENTS C ON T.TABLE_NAME = C.TABLE_NAME AND T.OWNER = C.OWNER
           WHERE T.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'XDB')
           ORDER BY T.OWNER, T.TABLE_NAME`,
        );
        const all = (res.rows ?? []).map((r: any) => ({
          schema: r[1],
          name: r[0],
          type: "TABLE",
          description: r[2] || "",
        }));
        return filterTables(all, pattern);
      });
      return { success: true, tables, count: tables.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async describeTable(config: ConnConfig, table: string): Promise<DescribeTableResult> {
    if (!table.trim()) {
      return { success: false, error: "表名不能为空" };
    }
    try {
      const columns: ColumnInfo[] = await this.withConnection(config, async (conn) => {
        const oracleConn = conn.client as oracledb.Connection;
        const res = await oracleConn.execute(
          `SELECT
            COLUMN_NAME,
            DATA_TYPE || CASE WHEN DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')' WHEN DATA_LENGTH IS NOT NULL AND DATA_TYPE LIKE '%CHAR%' THEN '(' || DATA_LENGTH || ')' ELSE '' END,
            NULLABLE,
            DATA_DEFAULT,
            COMMENTS
          FROM ALL_TAB_COLUMNS C
          LEFT JOIN ALL_COL_COMMENTS COM ON C.TABLE_NAME = COM.TABLE_NAME AND C.COLUMN_NAME = COM.COLUMN_NAME AND C.OWNER = COM.OWNER
          WHERE C.TABLE_NAME = :1 AND C.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'XDB')
          ORDER BY C.COLUMN_ID`,
          [table.toUpperCase()],
        );
        const cols: ColumnInfo[] = (res.rows ?? []).map((r: any) => ({
          name: r[0],
          type: r[1],
          nullable: r[2] === "Y",
          default: r[3] || null,
          primaryKey: false,
          comment: r[4] || "",
        }));

        // 查主键
        try {
          const pkRes = await oracleConn.execute(
            `SELECT cc.COLUMN_NAME
             FROM ALL_CONS_COLUMNS cc
             JOIN ALL_CONSTRAINTS c ON cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.OWNER = c.OWNER
             WHERE c.CONSTRAINT_TYPE = 'P' AND c.TABLE_NAME = :1`,
            [table.toUpperCase()],
          );
          const pkSet = new Set((pkRes.rows ?? []).map((r: any) => r[0]));
          for (const col of cols) {
            if (pkSet.has(col.name)) col.primaryKey = true;
          }
        } catch { /* ignore */ }
        return cols;
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const oracleDialect = new OracleDialect();
register(oracleDialect);
