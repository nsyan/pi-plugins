// src/dialects/postgresql.ts
import pg from "pg";
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  ListTablesResult, DescribeTableResult } from "../core/types.js";
import { RelationalDialect } from "./relational-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析（JDBC + 原生 URI 双形态，Spec §7）───

const JDBC_RE = /^jdbc:postgresql:\/\/([^:/?#]+)(?::(\d+))?\/([^?#]+).*$/;
const NATIVE_RE = /^postgresql:\/\/(?:([^:/?#@]+)(?::([^/?#@]*))?@)?([^:/?#]+)(?::(\d+))?\/([^?#]+).*$/;

function parsePostgresUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0];
  const m = clean.match(JDBC_RE);
  if (m) {
    const host = m[1];
    const port = m[2] ? parseInt(m[2], 10) : 5432;
    const database = m[3];
    if (!host || !database) return null;
    return { host, port, database };
  }
  const n = clean.match(NATIVE_RE);
  if (n) {
    const host = n[3];
    const port = n[4] ? parseInt(n[4], 10) : 5432;
    const database = n[5];
    if (!host || !database) return null;
    const out: ParsedTarget = { host, port, database };
    if (n[1] !== undefined) out.username = decodeURIComponent(n[1]);
    if (n[2] !== undefined) out.password = decodeURIComponent(n[2]);
    return out;
  }
  return null;
}

// ── PostgreSQL 方言（逻辑从 src/db.ts 原样搬入）───

class PostgresqlDialect extends RelationalDialect {
  id = "postgresql" as const;
  label = "PostgreSQL";
  family = "relational" as const;
  defaultPort = 5432;
  fingerprints: Fingerprints = {
    urlPatterns: [/^jdbc:postgresql:\/\//, /^postgresql:\/\//],
    configKeys: ["spring.datasource.url"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parsePostgresUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    return `jdbc:postgresql://${config.host}:${config.port}/${config.database}`;
  }

  protected async doConnect(config: ConnConfig, _timeoutMs: number): Promise<DbConnection> {
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
    });
    await client.connect();
    return {
      type: "postgresql",
      client,
      async close() { await client.end(); },
    };
  }

  protected async doExecute(client: unknown, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
    const pgClient = client as pg.Client;
    const timeoutMs = opts.timeoutSec * 1000;
    const maxRows = opts.maxRows;
    // 设置 statement_timeout
    await pgClient.query(`SET statement_timeout = '${timeoutMs}'`);
    const res = await pgClient.query(stmt);
    if (res.fields && res.fields.length > 0) {
      const columns = res.fields.map((f: any) => f.name);
      const rows = res.rows.slice(0, maxRows).map((r: any) => columns.map((col: string) => r[col]));
      return { columns, rows, rowCount: res.rows.length };
    }
    return { columns: [], rows: [], rowCount: res.rowCount ?? 0 };
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const pgClient = conn.client as pg.Client;
    const res = await pgClient.query("SELECT version()");
    return res.rows[0].version.split(",")[0].trim();
  }

  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables = await this.withConnection(config, async (conn) => {
        const pgClient = conn.client as pg.Client;
        const res = await pgClient.query(`
          SELECT schemaname, tablename, obj_description(c.oid) AS description
          FROM pg_catalog.pg_tables t
          JOIN pg_catalog.pg_class c ON c.relname = t.tablename AND c.relnamespace = (
            SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = t.schemaname
          )
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY schemaname, tablename
        `);
        const all = res.rows.map((r: any) => ({
          schema: r.schemaname,
          name: r.tablename,
          type: "TABLE",
          description: r.description || "",
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
      const columns = await this.withConnection(config, async (conn) => {
        const pgClient = conn.client as pg.Client;
        const parts = table.split(".");
        const schema = parts.length === 2 ? parts[0] : "public";
        const tableName = parts.length === 2 ? parts[1] : table;
        const res = await pgClient.query(`
          SELECT
            a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '') AS default_val,
            COALESCE(ct.contype = 'p', FALSE) AS primary_key,
            COALESCE(cd.description, '') AS comment
          FROM pg_catalog.pg_attribute a
          LEFT JOIN pg_catalog.pg_attrdef ad ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
          LEFT JOIN pg_catalog.pg_description cd ON a.attrelid = cd.objoid AND a.attnum = cd.objsubid
          LEFT JOIN pg_catalog.pg_constraint ct ON a.attrelid = ct.conrelid
              AND ct.contype = 'p' AND a.attnum = ANY(ct.conkey)
          WHERE a.attrelid = (
            SELECT c.oid FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
            WHERE c.relname = $1 AND n.nspname = $2
          ) AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum
        `, [tableName, schema]);
        return res.rows.map((r: any) => ({
          name: r.name,
          type: r.type,
          nullable: r.nullable,
          default: r.default_val || null,
          primaryKey: r.primary_key,
          comment: r.comment,
        }));
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const postgresqlDialect = new PostgresqlDialect();
register(postgresqlDialect);
