// src/dialects/dm.ts
import dmdb from "dmdb";
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  ListTablesResult, DescribeTableResult, ColumnInfo } from "../core/types.js";
import { RelationalDialect } from "./relational-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析（JDBC 主形态 + 原生 URI 双形态，Spec §7）───

const DM_DEFAULT_PORT = 5236;
const JDBC_RE = /^jdbc:dm:\/\/([^:/?#]+)(?::(\d+))?(?:\/([^?#]*))?$/;
const NATIVE_RE = /^dm:\/\/([^:/?#@]+)(?::(\d+))?(?:\/([^?#]*))?$/;

function parseDmUrl(url: string): ParsedTarget | null {
  const qIdx = url.indexOf("?");
  const clean = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const m = clean.match(JDBC_RE) ?? clean.match(NATIVE_RE);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : DM_DEFAULT_PORT;
  // 库名 = URL 路径段；缺失时回退 query 的 schema= 参数（jdbc:dm://host:port?schema=x 常见形态）
  let database = m[3] || undefined;
  if (!database && qIdx >= 0) {
    const schema = new URLSearchParams(url.slice(qIdx + 1)).get("schema");
    if (schema) database = schema;
  }
  if (!host) return null;
  return database !== undefined ? { host, port, database } : { host, port };
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
    return `jdbc:dm://${config.host}:${config.port}${config.database ? "/" + config.database : ""}`;
  }

  protected async doConnect(config: ConnConfig, _timeoutMs: number): Promise<DbConnection> {
    let conn: dmdb.Connection;
    try {
      // loginEncrypt=false：跳过握手消息加密。dmdb 默认走 MD5/RSA 遗留算法，
      // Node≥17（OpenSSL 3）报 digital envelope routines::unsupported；
      // 若服务端强制加密，请以 NODE_OPTIONS=--openssl-legacy-provider 启动宿主
      conn = await dmdb.getConnection({
        user: config.username,
        password: config.password,
        connectString: `${config.host}:${config.port}`,
        schema: config.database,
        loginEncrypt: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/digital envelope routines|ERR_OSSL/i.test(msg)) {
        throw new Error(`${msg}（DM 登录加密与 Node≥17 OpenSSL 3 不兼容；请以 NODE_OPTIONS=--openssl-legacy-provider 启动 pi）`);
      }
      throw err;
    }
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
          // 列名全部加表前缀：DM 对 JOIN 中的裸列名报 -2112 有歧义
          `SELECT T.TABLE_NAME, T.OWNER, C.COMMENTS FROM ALL_TABLES T
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
        // schema 限定："schema.table" 显式指定，否则用连接 schema（config.database，大小写保持原样，
        // DM 建库时可能带引号存为小写）；都无时不限定，保持旧兼容。避免同名表跨 schema 列重复
        const dotIdx = table.indexOf(".");
        const owner = (dotIdx > 0 ? table.slice(0, dotIdx) : config.database) || undefined;
        const tableName = (dotIdx > 0 ? table.slice(dotIdx + 1) : table).toUpperCase();
        const ownerFilter = owner ? " AND C.OWNER = :2" : "";
        const binds = owner ? [tableName, owner] : [tableName];
        const res = await dmConn.execute(
          `SELECT
            C.COLUMN_NAME,
            C.DATA_TYPE || CASE WHEN C.DATA_PRECISION IS NOT NULL THEN '(' || C.DATA_PRECISION || ',' || C.DATA_SCALE || ')' WHEN C.DATA_LENGTH IS NOT NULL AND C.DATA_TYPE LIKE '%CHAR%' THEN '(' || C.DATA_LENGTH || ')' ELSE '' END,
            C.NULLABLE,
            C.DATA_DEFAULT,
            COM.COMMENTS
          FROM ALL_TAB_COLUMNS C
          LEFT JOIN ALL_COL_COMMENTS COM ON C.TABLE_NAME = COM.TABLE_NAME AND C.COLUMN_NAME = COM.COLUMN_NAME AND C.OWNER = COM.OWNER
          WHERE C.TABLE_NAME = :1${ownerFilter} AND C.OWNER NOT IN ('SYS', 'SYSDBA', 'SYSSSO', 'CTISYS')
          ORDER BY C.COLUMN_ID`,
          binds,
        );
        const cols: ColumnInfo[] = (res.rows ?? []).map((r: any) => ({
          name: r[0],
          type: r[1],
          nullable: r[2] === "Y",
          default: r[3] || null,
          primaryKey: false,
          comment: r[4] || "",
        }));

        // 查主键（与列查询同 schema 限定）
        try {
          const ownerFilterPk = owner ? " AND c.OWNER = :2" : "";
          const bindsPk = owner ? [tableName, owner] : [tableName];
          const pkRes = await dmConn.execute(
            `SELECT cc.COLUMN_NAME
             FROM ALL_CONS_COLUMNS cc
             JOIN ALL_CONSTRAINTS c ON cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.OWNER = c.OWNER
             WHERE c.CONSTRAINT_TYPE = 'P' AND c.TABLE_NAME = :1${ownerFilterPk}`,
            bindsPk,
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
