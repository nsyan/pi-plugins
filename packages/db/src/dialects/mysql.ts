// src/dialects/mysql.ts
import mysql from "mysql2/promise";
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  ListTablesResult, DescribeTableResult, ColumnInfo } from "../core/types.js";
import { RelationalDialect } from "./relational-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析（JDBC + 原生 URI 双形态，Spec §7）───

const JDBC_RE = /^jdbc:mysql:\/\/([^:/?#]+)(?::(\d+))?\/([^?#]+).*$/;
const NATIVE_RE = /^mysql:\/\/(?:([^:/?#@]+)(?::([^/?#@]*))?@)?([^:/?#]+)(?::(\d+))?\/([^?#]+).*$/;

function parseMysqlUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0];
  const m = clean.match(JDBC_RE);
  if (m) {
    const host = m[1];
    const port = m[2] ? parseInt(m[2], 10) : 3306;
    const database = m[3];
    if (!host || !database) return null;
    return { host, port, database };
  }
  const n = clean.match(NATIVE_RE);
  if (n) {
    const host = n[3];
    const port = n[4] ? parseInt(n[4], 10) : 3306;
    const database = n[5];
    if (!host || !database) return null;
    const out: ParsedTarget = { host, port, database };
    if (n[1] !== undefined) out.username = decodeURIComponent(n[1]);
    if (n[2] !== undefined) out.password = decodeURIComponent(n[2]);
    return out;
  }
  return null;
}

// ── MySQL 方言（逻辑从 src/db.ts 原样搬入）───

class MysqlDialect extends RelationalDialect {
  id = "mysql" as const;
  label = "MySQL";
  family = "relational" as const;
  defaultPort = 3306;
  fingerprints: Fingerprints = {
    urlPatterns: [/^jdbc:mysql:\/\//, /^mysql:\/\//],
    configKeys: ["spring.datasource.url"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseMysqlUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    return `jdbc:mysql://${config.host}:${config.port}/${config.database}`;
  }

  protected async doConnect(config: ConnConfig, _timeoutMs: number): Promise<DbConnection> {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      charset: "utf8mb4",
    });
    return {
      type: "mysql",
      client: conn,
      async close() { await conn.end(); },
    };
  }

  protected async doExecute(client: unknown, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
    const mysqlConn = client as mysql.Connection;
    const timeoutMs = opts.timeoutSec * 1000;
    const maxRows = opts.maxRows;
    // 设置 max_execution_time；老版本服务端（<5.7.8）SET 失败时忽略，客户端超时仍生效
    try {
      await mysqlConn.execute(`SET max_execution_time = ${timeoutMs}`);
    } catch { /* ignore: server too old for max_execution_time */ }
    const [rows, fields] = await mysqlConn.execute(stmt);
    if (Array.isArray(fields) && fields.length > 0) {
      const columns = fields.map((f: any) => f.name);
      const data = (rows as any[]).slice(0, maxRows).map((r: any) => columns.map((col: string) => r[col]));
      return { columns, rows: data, rowCount: (rows as any[]).length };
    }
    const affected = (rows as any)?.affectedRows ?? 0;
    return { columns: [], rows: [], rowCount: affected };
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const mysqlConn = conn.client as mysql.Connection;
    const [rows] = await mysqlConn.execute("SELECT version() AS v");
    return (rows as any[])[0].v;
  }

  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables = await this.withConnection(config, async (conn) => {
        const mysqlConn = conn.client as mysql.Connection;
        const [rows] = await mysqlConn.execute(
          "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
          [config.database],
        );
        const all = (rows as any[]).map((r: any) => ({
          schema: "",
          name: r.TABLE_NAME,
          type: r.TABLE_TYPE === "BASE TABLE" ? "TABLE" : r.TABLE_TYPE,
          description: r.TABLE_COMMENT || "",
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
        const mysqlConn = conn.client as mysql.Connection;
        const safeTable = table.replace(/`/g, "``");
        const [rows] = await mysqlConn.execute(`DESCRIBE \`${safeTable}\``);
        const cols: ColumnInfo[] = (rows as any[]).map((r: any) => ({
          name: r.Field,
          type: r.Type,
          nullable: r.Null === "YES",
          default: r.Default,
          primaryKey: r.Key === "PRI",
          comment: "",
        }));

        // 获取注释
        try {
          const [commentRows] = await mysqlConn.execute(
            "SELECT COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            [config.database, table],
          );
          const commentMap = new Map((commentRows as any[]).map((r: any) => [r.COLUMN_NAME, r.COLUMN_COMMENT]));
          for (const col of cols) {
            col.comment = commentMap.get(col.name) || "";
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

export const mysqlDialect = new MysqlDialect();
register(mysqlDialect);
