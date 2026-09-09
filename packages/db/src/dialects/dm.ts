// src/dialects/dm.ts
import dmdb from "dmdb";
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  ListTablesResult, DescribeTableResult, ColumnInfo } from "../core/types.js";
import { RelationalDialect } from "./relational-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析（JDBC 主形态 + 原生 URI 双形态，Spec §7）───

const DM_DEFAULT_PORT = 5236;
const JDBC_RE = /^jdbc:dm:\/\/([^:/?#]+)(?::(\d+))?\/([^?#]+)$/;
const NATIVE_RE = /^dm:\/\/([^:/?#@]+)(?::(\d+))?\/([^?#]+)$/;

function parseDmUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0];
  const m = clean.match(JDBC_RE) ?? clean.match(NATIVE_RE);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : DM_DEFAULT_PORT;
  const database = m[3];
  if (!host || !database) return null;
  return { host, port, database };
}

// ── DM（达梦）方言 ─────────────────────────────────
// 注：dmdb 为官方 JS 驱动（API 仿 oracledb），macOS ARM64 已验证可安装加载
// （见 Task 9 spike）。DM9 兼容性未验证（Spec §12：仅声明测过 DM8）。

class DmDialect extends RelationalDialect {
  id = "dm" as const;
  label = "DM";
  family = "relational" as const;
  defaultPort = DM_DEFAULT_PORT;
  fingerprints: Fingerprints = {
    urlPatterns: [/^jdbc:dm:\/\//, /^dm:\/\//],
    configKeys: ["spring.datasource.url"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseDmUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    return `jdbc:dm://${config.host}:${config.port}/${config.database}`;
  }

  protected async doConnect(config: ConnConfig, _timeoutMs: number): Promise<DbConnection> {
    const conn = await dmdb.getConnection({
      user: config.username,
      password: config.password,
      connectString: `${config.host}:${config.port}`,
      schema: config.database,
    });
    return {
      type: "dm",
      client: conn,
      async close() { await conn.close(); },
    };
  }

  protected async doExecute(client: unknown, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
    const dmConn = client as dmdb.Connection;
    const maxRows = opts.maxRows;
    const res = await dmConn.execute(stmt, [], {
      maxRows,
      fetchArraySize: maxRows,
    });
    if (res.metaData && res.metaData.length > 0) {
      const columns = res.metaData.map((m: any) => m.name);
      const rows = (res.rows ?? []).slice(0, maxRows).map((r: any) => [...r]);
      return { columns, rows, rowCount: res.rows?.length ?? 0 };
    }
    return { columns: [], rows: [], rowCount: res.rowsAffected ?? 0 };
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const dmConn = conn.client as dmdb.Connection;
    const res = await dmConn.execute("SELECT * FROM V$VERSION");
    return (res.rows ?? [])[0]?.[0] as string ?? "unknown";
  }

  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables = await this.withConnection(config, async (conn) => {
        const dmConn = conn.client as dmdb.Connection;
        const res = await dmConn.execute(
          `SELECT TABLE_NAME, OWNER, COMMENTS FROM ALL_TABLES T
           LEFT JOIN ALL_TAB_COMMENTS C ON T.TABLE_NAME = C.TABLE_NAME AND T.OWNER = C.OWNER
           WHERE T.OWNER NOT IN ('SYS', 'SYSDBA', 'SYSSSO', 'CTISYS')
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
        const dmConn = conn.client as dmdb.Connection;
        const res = await dmConn.execute(
          `SELECT
            COLUMN_NAME,
            DATA_TYPE || CASE WHEN DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')' WHEN DATA_LENGTH IS NOT NULL AND DATA_TYPE LIKE '%CHAR%' THEN '(' || DATA_LENGTH || ')' ELSE '' END,
            NULLABLE,
            DATA_DEFAULT,
            COMMENTS
          FROM ALL_TAB_COLUMNS C
          LEFT JOIN ALL_COL_COMMENTS COM ON C.TABLE_NAME = COM.TABLE_NAME AND C.COLUMN_NAME = COM.COLUMN_NAME AND C.OWNER = COM.OWNER
          WHERE C.TABLE_NAME = :1 AND C.OWNER NOT IN ('SYS', 'SYSDBA', 'SYSSSO', 'CTISYS')
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
          const pkRes = await dmConn.execute(
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

export const dmDialect = new DmDialect();
register(dmDialect);
