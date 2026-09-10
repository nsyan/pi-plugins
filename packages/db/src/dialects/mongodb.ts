// dialects/mongodb.ts —— MongoDB 方言（DocumentDialect + mongodb 官方驱动）
// 交互形态：query_database 的 sql 参数填 JSON 命令信封（db.runCommand 文档），
//   如 {"find":"users","filter":{"age":{"$gt":18}},"limit":20}
// 版本声明（Spec 共识 Q2）：驱动 mongodb@^6，server 4.2~8.x 可用；已验证主流区 6.0/7.0/8.0。
//   驱动纯 JS 零原生编译；4.2/4.4 可用未验证（5.0 已 EOL 不承诺）。

import { MongoClient } from "mongodb";
import type { ConnConfig, DbConnection, ParsedTarget,
  ListTablesResult, DescribeTableResult, TableInfo, ColumnInfo } from "../core/types.js";
import { DocumentDialect } from "./document-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析：mongodb(srv)://[user:pass@]host[:port][,host2...][/db][?opts] ───
// 兼收 Atlas SRV；IPv6 主机不在 v1 支持范围（split(":") 会误切，见 parseHosts 注释）

const MONGO_RE = /^mongodb(?:\+srv)?:\/\/(?:([^:/?#@]+)(?::([^@]*))?@)?([^/?#]+)(?:\/([^?]*))?(?:\?(.*))?$/;

function parseMongoUrl(url: string): ParsedTarget | null {
  const m = url.trim().match(MONGO_RE);
  if (!m) return null;
  const srv = url.trim().startsWith("mongodb+srv://");
  let username: string | undefined;
  let password: string | undefined;
  if (m[1] !== undefined) {
    try {
      username = decodeURIComponent(m[1]);
      password = m[2] !== undefined ? decodeURIComponent(m[2]) : undefined;
    } catch { /* 编码异常按原文 */ username = m[1]; password = m[2]; }
  }
  // 多主机 seed list 原样保留（驱动接受逗号分隔）；单主机拆出端口
  let port = 27017;
  const hosts = m[3].split(",").map((s) => s.trim()).filter(Boolean);
  if (hosts.length === 0) return null;
  let hostStr = hosts.join(",");
  if (hosts.length === 1 && !hosts[0].startsWith("[")) { // [ 开头 = IPv6 字面量，不拆端口
    const colon = hosts[0].lastIndexOf(":");
    if (colon > 0) {
      const p = parseInt(hosts[0].slice(colon + 1), 10);
      if (Number.isFinite(p)) { hostStr = hosts[0].slice(0, colon); port = p; }
    }
  }
  let database = m[4] !== undefined && m[4] !== "" ? decodeURIComponent(m[4]) : undefined;
  const options: Record<string, string> = {};
  if (m[5]) {
    for (const [k, v] of new URLSearchParams(m[5])) options[k] = v;
  }
  if (srv) {
    options.srv = "true"; // 建连侧据此还原 +srv scheme
    if (options.tls === undefined && options.ssl === undefined) options.tls = "true"; // SRV 默认 TLS
  }
  const out: ParsedTarget = { host: hostStr, port };
  if (username !== undefined) out.username = username;
  if (password !== undefined) out.password = password;
  if (database !== undefined) out.database = database;
  out.ssl = srv || options.tls === "true" || options.ssl === "true";
  out.options = options;
  return out;
}

/** ConnConfig → 标准连接 URI（authSource 缺省 admin，与官方 URI 语义一致；Q6 共识） */
function buildUri(config: ConnConfig): string {
  const opts = config.options ?? {};
  const srv = opts.srv === "true";
  const scheme = srv ? "mongodb+srv" : "mongodb";
  const host = config.host ?? "localhost";
  // 多主机/ srv / IPv6 字面量（含 ]）不追加端口（seed 自带、SRV 解析或字面量内含端口）
  const hostPart = srv || host.includes(",") || host.includes("]")
    ? host
    : `${host}:${config.port ?? 27017}`;
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@`
    : "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (k === "srv") continue; // 内部标记不透传
    params.set(k, v);
  }
  if (config.username && !params.has("authSource") && !params.has("authMechanism")) {
    params.set("authSource", "admin");
  }
  // 注：不用 URLSearchParams#size（Node <19.8 无此属性）
  const qs = [...params.keys()].length > 0 ? `?${params.toString()}` : "";
  return `${scheme}://${auth}${hostPart}${config.database ? `/${config.database}` : ""}${qs}`;
}

// ── 工具函数 ──────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtBytes(n: unknown): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : undefined;
  if (v === undefined) return "?";
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

interface RawCommandResult {
  cursor?: { firstBatch?: unknown[] };
  values?: unknown[];
  version?: string;
  [k: string]: unknown;
}

interface CollectionInfo {
  name: string;
  type?: string;
  options?: { validator?: { $jsonSchema?: Record<string, unknown> } };
}

interface IndexInfo { name?: string; key?: Record<string, unknown> }

interface JsonSchemaNode {
  bsonType?: string | string[];
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

interface SampledField { name: string; count: number; types: string[] }

// describeTable 采样推断参数（Spec 共识 Q5：validator 权威 > 采样 ≤100 推断）
const SAMPLE_DOCS = 100;
const MAX_DESCRIBE_FIELDS = 100;

function bsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  if (typeof v === "object") {
    const b = v as { _bsontype?: string };
    if (b._bsontype) return b._bsontype.toLowerCase();
    return "object";
  }
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "double";
  return typeof v as string;
}

/** $jsonSchema validator → 字段清单（权威 schema，顶层 properties） */
function fieldsFromJsonSchema(schema: JsonSchemaNode): Array<{ name: string; type: string; required: boolean; authoritative: true }> {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return Object.entries(props).map(([name, node]) => {
    const bt = node.bsonType ?? node.type;
    const type = Array.isArray(bt) ? bt.join("/") : (bt ?? "any");
    return { name, type, required: required.has(name), authoritative: true as const };
  });
}

/** 采样 ≤100 文档推断顶层字段（variety 思路：出现次数 + 类型分布），返回实际采样总数 */
async function sampleFields(db: { command: (cmd: Record<string, unknown>) => Promise<RawCommandResult> }, collection: string): Promise<{ fields: SampledField[]; total: number }> {
  const res = await db.command({ find: collection, filter: {}, limit: SAMPLE_DOCS, batchSize: SAMPLE_DOCS });
  const docs = (res.cursor?.firstBatch ?? []) as unknown[];
  const counts = new Map<string, number>();
  const types = new Map<string, Set<string>>();
  for (const d of docs) {
    if (d === null || typeof d !== "object" || Array.isArray(d)) continue;
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      const set = types.get(k) ?? new Set<string>();
      set.add(bsonTypeOf(v));
      types.set(k, set);
    }
  }
  const fields = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_DESCRIBE_FIELDS)
    .map(([name, count]) => ({ name, count, types: [...(types.get(name) ?? [])] }));
  return { fields, total: docs.length };
}

// ── 方言实现 ──────────────────────────────────────

class MongoDialect extends DocumentDialect {
  id = "mongodb" as const;
  label = "MongoDB";
  family = "document" as const;
  defaultPort = 27017;
  fingerprints: Fingerprints = {
    urlPatterns: [/^mongodb(\+srv)?:\/\//],
    configKeys: ["spring.data.mongodb.uri", "spring.mongodb.uri"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseMongoUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    const srv = config.options?.srv === "true";
    const scheme = srv ? "mongodb+srv" : "mongodb";
    const host = config.host ?? "localhost";
    const hostPart = srv || host.includes(",") || host.includes("]") ? host : `${host}:${config.port ?? 27017}`;
    return `${scheme}://${hostPart}${config.database ? `/${config.database}` : ""}`;
  }

  protected async doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection> {
    const client = new MongoClient(buildUri(config), {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      socketTimeoutMS: Math.max(timeoutMs, 1_000),
    });
    try {
      await client.connect();
    } catch (err: unknown) {
      try { await client.close(); } catch { /* ignore */ }
      throw err;
    }
    return {
      type: "mongodb",
      client,
      async close() { try { await client.close(); } catch { /* ignore */ } },
    };
  }

  protected async doCommand(client: unknown, config: ConnConfig, envelope: Record<string, unknown>): Promise<unknown> {
    const db = (client as MongoClient).db(config.database || "test");
    return db.command(envelope);
  }

  protected extractDocs(raw: unknown): unknown[] {
    const r = raw as RawCommandResult;
    if (r?.cursor?.firstBatch !== undefined) return r.cursor.firstBatch;
    if (Array.isArray(r?.values)) return r.values.map((v) => ({ value: v })); // distinct
    return [raw]; // count/collStats/写结果等单文档响应
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const r = await (conn.client as MongoClient).db("admin").command({ buildInfo: 1 }) as RawCommandResult;
    return r.version ?? "unknown";
  }

  // listTables → listCollections（Q5 共识；nameOnly 快路径，LIKE 过滤走共用 filterTables）
  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables: TableInfo[] = await this.withConnection(config, async (conn) => {
        const db = (conn.client as MongoClient).db(config.database || "test");
        const res = await db.command({ listCollections: 1, nameOnly: true }) as RawCommandResult;
        const batch = (res.cursor?.firstBatch ?? []) as Array<{ name: string; type?: string }>;
        return batch.map((i) => ({
          schema: config.database ?? "",
          name: i.name,
          type: (i.type ?? "collection").toUpperCase(),
          description: "",
        }));
      });
      const filtered = filterTables(tables, pattern);
      return { success: true, tables: filtered, count: filtered.length };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }

  // describeTable → collStats + listIndexes + validator $jsonSchema / 采样 ≤100 推断（Q5 共识）
  async describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult> {
    const name = target.trim();
    if (!name) return { success: false, error: "集合名不能为空" };
    try {
      const columns = await this.withConnection(config, async (conn) => {
        const client = conn.client as MongoClient;
        const db = client.db(config.database || "test");
        // 集合元数据（含 validator；nameOnly=false 才带 options）
        const lc = await db.command({ listCollections: 1, filter: { name }, nameOnly: false }) as RawCommandResult;
        const infos = (lc.cursor?.firstBatch ?? []) as CollectionInfo[];
        const info = infos[0];
        if (!info) throw new Error(`集合不存在: ${name}（库: ${config.database || "test"}）`);

        // collStats / 索引失败降级（权限不足时元数据照常返回）
        let stats: Record<string, unknown> = {};
        try { stats = await db.command({ collStats: name }) as RawCommandResult; } catch { /* ignore */ }
        let indexes: IndexInfo[] = [];
        try {
          const ir = await db.command({ listIndexes: name }) as RawCommandResult;
          indexes = (ir.cursor?.firstBatch ?? []) as IndexInfo[];
        } catch { /* ignore */ }

        const cols: ColumnInfo[] = [
          {
            name: "documents", type: "meta", nullable: true, default: null, primaryKey: false,
            comment: `文档数 ${typeof stats.count === "number" ? stats.count : "?"}；数据量 ${fmtBytes(stats.size)}；`
              + `平均文档 ${fmtBytes(stats.avgObjSize)}；存储 ${fmtBytes(stats.storageSize)}${stats.capped ? "；capped" : ""}`,
          },
          {
            name: "indexes", type: "meta", nullable: true, default: null, primaryKey: false,
            comment: indexes.length === 0 ? "（无索引信息）"
              : indexes.slice(0, 10).map((i) => i.name).join(", ")
                + (indexes.length > 10 ? ` 等 ${indexes.length} 个` : ""),
          },
        ];
        const validator = info.options?.validator?.$jsonSchema;
        if (validator) {
          cols.push({
            name: "validator", type: "meta", nullable: true, default: null, primaryKey: false,
            comment: `$jsonSchema（权威 schema）：${JSON.stringify(validator).slice(0, 300)}`,
          });
        }

        // 字段清单：validator 权威优先，缺失时采样推断
        if (validator) {
          for (const f of fieldsFromJsonSchema(validator as JsonSchemaNode)) {
            cols.push({
              name: f.name, type: f.type, nullable: !f.required, default: null,
              primaryKey: f.name === "_id", comment: `${f.authoritative ? "来自 $jsonSchema" : ""}${f.required ? "；required" : ""}`,
            });
          }
        } else {
          const { fields, total } = await sampleFields({ command: (c) => db.command(c) }, name);
          for (const f of fields) {
            cols.push({
              name: f.name, type: f.types.slice(0, 3).join("/"), nullable: f.count < total,
              default: null, primaryKey: f.name === "_id",
              comment: `出现 ${f.count}/${total}（采样 ≤${SAMPLE_DOCS} 推断，非权威 schema）`,
            });
          }
          if (fields.length === 0) {
            cols.push({
              name: "(fields)", type: "meta", nullable: true, default: null, primaryKey: false,
              comment: "集合为空或采样失败，无法推断字段",
            });
          }
        }
        return cols;
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }
}

export const mongoDialect = new MongoDialect();
register(mongoDialect);
