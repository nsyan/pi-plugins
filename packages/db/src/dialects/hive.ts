// src/dialects/hive.ts —— Hive 方言（BigDataDialect + hive-driver HS2）
// Spike 结论（Task 8）：本机无可用 Hive/Spark Thrift 端点，SPIKE-SKIPPED；
// 写法依据 hive-driver@1.0.1 实际 API（HiveClient.connect → openSession →
// session.executeStatement → operation.fetch/hasMoreRows/getSchema/getData/flush/cancel/close），
// 与 brief 示例的裸 client.fetchResults 写法不同，按实际调整。live 端到端待真实环境验证。
// 注：hive-driver 的 dist/index.js 无 default export（经 macOS tsx 实测确认：
// `import hive from` 得 undefined，必须用 namespace import），故用 `import * as`。
import * as hive from "hive-driver";
import type { ConnConfig, DbConnection, ParsedTarget,
  DescribeTableResult, ColumnInfo } from "../core/types.js";
import { BigDataDialect, type Hs2Session } from "./bigdata-dialect.js";
import { register, type Fingerprints } from "./dialect.js";

// ── URL 解析：jdbc:hive2://host:port/database（默认端口 10000）───
const HIVE2_RE = /^jdbc:hive2:\/\/([^:/?#]+)(?::(\d+))?\/([^?#]*)$/;
const DEFAULT_PORT = 10000;

function parseHiveUrl(url: string): ParsedTarget | null {
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

export function buildSessionConfig(config: ConnConfig): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.options ?? {})) {
    const key = k.startsWith("hive.") ? k : `hive.${k}`;
    vars[key] = v;
  }
  return vars;
}

class HiveDialect extends BigDataDialect {
  id = "hive" as const;
  label = "Hive";
  family = "bigdata" as const;
  defaultPort = DEFAULT_PORT;
  fingerprints: Fingerprints = {
    urlPatterns: [/^jdbc:hive2:\/\//],
    configKeys: ["spring.datasource.url"],
  };
  // Task 1 WRITE_RE 已含 MSCK|CACHE|REFRESH；家族集补 HiveQL 特有写形态
  protected writeKeywords = /\b(INSERT\s+(INTO|OVERWRITE)|CREATE\s+TABLE(\s+AS)?|LOAD\s+DATA|MSCK|ALTER|DROP)\b/i;
  protected sessionPrefix = "hive.";

  parseUrl(url: string): ParsedTarget | null {
    return parseHiveUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    return `jdbc:hive2://${config.host}:${config.port ?? DEFAULT_PORT}/${config.database ?? "default"}`;
  }

  protected async doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection> {
    // 上游 hive-driver 的 TCLIServiceTypes 声明不完整（缺 25 个请求类型），与其运行时实际
    // 使用的 thrift 定义不一致；仅放宽类型断言，运行时对象未做任何改动。
    const client = new hive.HiveClient(TCLIService, TCLIService_types as any);
    await client.connect(
      { host: config.host ?? "localhost", port: config.port ?? DEFAULT_PORT },
      new hive.connections.TcpConnection(),
      config.password
        ? new hive.auth.PlainTcpAuthentication({ username: config.username ?? "", password: config.password })
        : new hive.auth.NoSaslAuthentication(),
    );
    const configuration = buildSessionConfig(config);
    if (config.database) configuration["hive.cli.currentDb"] = config.database;
    const session = await client.openSession({
      client_protocol: TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
      username: config.username || undefined,
      password: config.password || undefined,
      configuration,
    });
    void timeoutMs;
    const hs2session = session as unknown as Hs2Session;
    return {
      type: "hive",
      client: hs2session,
      async close() {
        try { await session.close(); } catch { /* ignore */ }
        client.close();
      },
    };
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const session = conn.client as Hs2Session;
    // 走基类受保护拉取路径（超时 + cancel + close），Hive 无统一版本函数时兜底 "unknown"
    return this.fetchVersion(session);
  }

  // DESCRIBE FORMATTED → 列名/类型/注释（遇 # 分区信息段即停）
  async describeTable(config: ConnConfig, table: string): Promise<DescribeTableResult> {
    if (!table.trim()) {
      return { success: false, error: "表名不能为空" };
    }
    try {
      const columns: ColumnInfo[] = await this.withConnection(config, async (conn) => {
        const session = conn.client as Hs2Session;
        const r = await this.runStatement(session, `DESCRIBE FORMATTED ${table}`,
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

export const hiveDialect = new HiveDialect();
register(hiveDialect);
