// src/dialects/spark.ts —— Spark 方言（Spark Thrift Server，同 HS2 协议栈）
// 与 Hive 共享 BigDataDialect 基类；差异：写关键字 +CACHE|REFRESH|UNCACHE、
// 会话变量前缀 spark.、DESCRIBE 输出列差异适配。Spark Connect（DataFrame/gRPC）
// 明确不支持（Spec §1 非目标）。
// 注：hive-driver 无 default export（见 hive.ts），用 namespace import。
import * as hive from "hive-driver";
import type { ConnConfig, DbConnection, ParsedTarget,
  DescribeTableResult, ColumnInfo } from "../core/types.js";
import { BigDataDialect, type Hs2Session } from "./bigdata-dialect.js";
import { register, type Fingerprints } from "./dialect.js";

const HIVE2_RE = /^jdbc:hive2:\/\/([^:/?#]+)(?::(\d+))?\/([^?#]*)$/;
const DEFAULT_PORT = 10000; // Spark Thrift Server 默认 10000（部分发行版 10015，可配）

function parseSparkUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0];
  const m = clean.match(HIVE2_RE);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : DEFAULT_PORT;
  const database = m[3] || undefined;
  if (!host) return null;
  return { host, port, database };
}

const { TCLIService, TCLIService_types } = hive.thrift as unknown as {
  TCLIService: object; TCLIService_types: { TProtocolVersion: Record<string, number> };
};

export function buildSparkSessionConfig(config: ConnConfig): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.options ?? {})) {
    const key = k.startsWith("spark.") ? k : `spark.${k}`;
    vars[key] = v;
  }
  return vars;
}

class SparkDialect extends BigDataDialect {
  id = "spark" as const;
  label = "Spark";
  family = "bigdata" as const;
  defaultPort = DEFAULT_PORT;
  fingerprints: Fingerprints = {
    urlPatterns: [/^jdbc:hive2:\/\//],
    configKeys: ["spring.datasource.url"],
  };
  // Hive 集 + SparkSQL 特有：CACHE|REFRESH|UNCACHE
  protected writeKeywords = /\b(INSERT\s+(INTO|OVERWRITE)|CREATE\s+TABLE(\s+AS)?|LOAD\s+DATA|MSCK|ALTER|DROP|CACHE\s+TABLE|UNCACHE\s+TABLE|REFRESH(\s+TABLE|\s+RESOURCE|\s+CACHE)?)\b/i;
  protected sessionPrefix = "spark.";

  parseUrl(url: string): ParsedTarget | null {
    return parseSparkUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    return `jdbc:hive2://${config.host}:${config.port ?? DEFAULT_PORT}/${config.database ?? "default"}`;
  }

  protected async doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection> {
    // 同 hive.ts：上游 hive-driver 的 TCLIServiceTypes 声明不完整，仅放宽类型断言，不动运行时。
    const client = new hive.HiveClient(TCLIService, TCLIService_types as any);
    await client.connect(
      { host: config.host ?? "localhost", port: config.port ?? DEFAULT_PORT },
      new hive.connections.TcpConnection(),
      config.password
        ? new hive.auth.PlainTcpAuthentication({ username: config.username ?? "", password: config.password })
        : new hive.auth.NoSaslAuthentication(),
    );
    const configuration = buildSparkSessionConfig(config);
    if (config.database) configuration["spark.sql.currentDb"] = config.database;
    const session = await client.openSession({
      client_protocol: TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
      username: config.username || undefined,
      password: config.password || undefined,
      configuration,
    });
    void timeoutMs;
    const hs2session = session as unknown as Hs2Session;
    return {
      type: "spark",
      client: hs2session,
      async close() {
        try { await session.close(); } catch { /* ignore */ }
        client.close();
      },
    };
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const session = conn.client as Hs2Session;
    return this.fetchVersion(session);
  }

  // DESCRIBE TABLE → col_name/data_type/comment；Spark 输出含 # Partition Information 等段，遇 # 段即停
  async describeTable(config: ConnConfig, table: string): Promise<DescribeTableResult> {
    if (!table.trim()) {
      return { success: false, error: "表名不能为空" };
    }
    try {
      const columns: ColumnInfo[] = await this.withConnection(config, async (conn) => {
        const session = conn.client as Hs2Session;
        const r = await this.runStatement(session, `DESCRIBE TABLE ${table}`,
          { readonly: true, maxRows: 500, timeoutSec: 30 });
        const cols: ColumnInfo[] = [];
        for (const row of r.rows) {
          const [name, type, comment] = row.map((v) => String(v ?? "").trim());
          if (!name || name.startsWith("#")) break;
          cols.push({ name, type, nullable: true, default: null, primaryKey: false, comment: comment ?? "" });
        }
        return cols;
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const sparkDialect = new SparkDialect();
register(sparkDialect);
