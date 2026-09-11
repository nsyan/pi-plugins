// dialects/neo4j.ts —— Neo4j 方言（GraphDialect + neo4j-driver 官方 Bolt 驱动）
// 交互形态：query_database 的 sql 参数填 Cypher 原文，如 MATCH (n:Person) RETURN n LIMIT 10
// 版本声明（对齐官方兼容矩阵）：驱动 neo4j-driver@^5.28，server 4.4 ~ 2025.x 兼容；
//   已验证 4.4.29 community（10.2.15.249 真连冒烟）。驱动纯 JS 零原生编译。
// 图结构语义：label/关系类型 当"表"（关系类型带 rel: 前缀）；describeTable 采样 ≤100 推断
//   属性键（对齐 Mongo Q5 共识），只依赖核心过程与 SHOW，不依赖 APOC。

import neo4j, { Driver } from "neo4j-driver";
import type { ConnConfig, DbConnection, ParsedTarget,
  ListTablesResult, DescribeTableResult, TableInfo, ColumnInfo } from "../core/types.js";
import { GraphDialect, cellOf } from "./graph-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析：bolt(s|+s|+ssc):// 与 neo4j(s|+s|+ssc):// ────
// neo4j:// 是集群路由 scheme（多主机 seed list 逗号分隔）；路径段 = database 名。
// IPv6 字面量主机（[::1]:7687）不拆端口（与 mongodb.ts 同款处理）。

const NEO4J_RE = /^(bolt|neo4j)(\+s|\+ssc)?:\/\/(?:([^:/?#@]+)(?::([^@]*))?@)?([^/?#]+)(?:\/([^?]*))?(?:\?(.*))?$/;

export function parseNeo4jUrl(url: string): ParsedTarget | null {
  const m = url.trim().match(NEO4J_RE);
  if (!m) return null;
  const ssl = m[2] === "+s" || m[2] === "+ssc";
  let username: string | undefined;
  let password: string | undefined;
  if (m[3] !== undefined) {
    try {
      username = decodeURIComponent(m[3]);
      password = m[4] !== undefined ? decodeURIComponent(m[4]) : undefined;
    } catch { /* 编码异常按原文 */ username = m[3]; password = m[4]; }
  }
  let port = 7687;
  const hosts = m[5].split(",").map((s) => s.trim()).filter(Boolean);
  if (hosts.length === 0) return null;
  let hostStr = hosts.join(",");
  if (hosts.length === 1 && !hosts[0].startsWith("[")) {
    const colon = hosts[0].lastIndexOf(":");
    if (colon > 0) {
      const p = parseInt(hosts[0].slice(colon + 1), 10);
      if (Number.isFinite(p)) { hostStr = hosts[0].slice(0, colon); port = p; }
    }
  }
  let database = m[6] !== undefined && m[6] !== "" ? decodeURIComponent(m[6]) : undefined;
  const options: Record<string, string> = {};
  if (m[7]) {
    for (const [k, v] of new URLSearchParams(m[7])) options[k] = v;
  }
  if (ssl) options.ssl = "true";
  const out: ParsedTarget = { host: hostStr, port };
  if (username !== undefined) out.username = username;
  if (password !== undefined) out.password = password;
  if (database !== undefined) out.database = database;
  out.ssl = ssl;
  if (Object.keys(options).length > 0) out.options = options;
  return out;
}

/** ConnConfig → 标准 Bolt URI（直连 bolt:// 起底——单机社区版无路由服务，
 *  neo4j:// 集群路由 scheme 会导致 "No routing servers available"；
 *  options.ssl=true 还原 +s scheme。集群用户可改用 options 存路由地址，后续按需扩展） */
function buildUri(config: ConnConfig): string {
  const ssl = config.options?.ssl === "true";
  const scheme = ssl ? "bolt+s" : "bolt";
  const host = config.host ?? "localhost";
  const hostPart = host.includes(",") || host.includes("]")
    ? host
    : `${host}:${config.port ?? 7687}`;
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@`
    : "";
  return `${scheme}://${auth}${hostPart}`;
}

// ── 工具函数 ──────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RawRecord { keys?: string[]; _fields?: unknown[] }
interface RawSummary { counters?: { _stats?: Record<string, number> } }

interface SampledProp { name: string; count: number; types: string[] }

const SAMPLE_NODES = 100;
const MAX_DESCRIBE_PROPS = 100;

/** 驱动值的类型名（describeTable 采样推断用） */
function typeOf(v: unknown): string {
  if (v === null) return "null";
  const t = v as { __isInteger__?: boolean; labels?: string[]; type?: string;
    segments?: unknown[]; constructor?: { name?: string } };
  if (typeof v === "number" || t.__isInteger__) return Number.isInteger(Number(v)) ? "integer" : "float";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (v instanceof Date) return "datetime";
  if (Array.isArray(t.labels)) return "node";
  if (typeof t.type === "string") return "relationship";
  if (Array.isArray(t.segments)) return "path";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object" && t.constructor?.name?.startsWith("Duration")) return "duration";
  if (typeof v === "object" && t.constructor?.name) return t.constructor.name.toLowerCase();
  return typeof v;
}

/** 采样 ≤100 个实体，推断属性键清单（出现次数 + 类型分布），返回实际采样总数 */
function sampleProps(records: RawRecord[]): { fields: SampledProp[]; total: number } {
  const counts = new Map<string, number>();
  const types = new Map<string, Set<string>>();
  let total = 0;
  for (const r of records) {
    const fields = r._fields ?? [];
    const entity = fields[0];
    if (entity === null || entity === undefined || typeof entity !== "object") continue;
    const props = (entity as { properties?: Record<string, unknown> }).properties;
    if (!props || typeof props !== "object") continue;
    total++;
    for (const [k, v] of Object.entries(props)) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      const set = types.get(k) ?? new Set<string>();
      set.add(typeOf(v));
      types.set(k, set);
    }
  }
  const fields = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_DESCRIBE_PROPS)
    .map(([name, count]) => ({ name, count, types: [...(types.get(name) ?? [])] }));
  return { fields, total };
}

/** 反引号引用 Cypher 标识符（label 可能是 `0` 这类数字/特殊字符名，实测环境已出现） */
function quoteId(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

// ── 方言实现 ──────────────────────────────────────

class Neo4jDialect extends GraphDialect {
  id = "neo4j" as const;
  label = "Neo4j";
  family = "graph" as const;
  defaultPort = 7687;
  fingerprints: Fingerprints = {
    urlPatterns: [/^(bolt|neo4j)(\+s|\+ssc)?:\/\//],
    configKeys: ["spring.neo4j.uri", "spring.data.neo4j.uri"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseNeo4jUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    const ssl = config.options?.ssl === "true";
    const scheme = ssl ? "bolt+s" : "bolt";
    const host = config.host ?? "localhost";
    const hostPart = host.includes(",") || host.includes("]") ? host : `${host}:${config.port ?? 7687}`;
    return `${scheme}://${hostPart}${config.database ? `/${config.database}` : ""}`;
  }

  protected async doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection> {
    const driver: Driver = neo4j.driver(buildUri(config), neo4j.auth.basic(config.username ?? "", config.password ?? ""), {
      connectionTimeout: timeoutMs,
      maxConnectionPoolSize: 10,
    });
    // 首次使用即验证可达性，失败立即释放（testConnection/查询统一走此路径）
    try {
      await driver.verifyConnectivity();
    } catch (err: unknown) {
      try { await driver.close(); } catch { /* ignore */ }
      throw err;
    }
    return {
      type: "neo4j",
      client: driver,
      async close() { try { await driver.close(); } catch { /* ignore */ } },
    };
  }

  /** 执行一条 Cypher（每连接单 session；缺省库 neo4j） */
  protected async runCypher(conn: DbConnection, config: ConnConfig,
    cypher: string): Promise<{ records: RawRecord[]; summary: RawSummary }> {
    const driver = conn.client as Driver;
    const session = driver.session({ database: config.database || "neo4j" });
    try {
      const result = await session.run(cypher);
      return {
        records: result.records as unknown as RawRecord[],
        summary: result.summary as unknown as RawSummary,
      };
    } finally {
      try { await session.close(); } catch { /* ignore */ }
    }
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const driver = conn.client as Driver;
    const session = driver.session({ database: "system", defaultAccessMode: neo4j.session.READ });
    try {
      const r = await session.run("CALL dbms.components() YIELD versions, edition RETURN versions[0] AS version, edition");
      const rec = r.records[0];
      const v = rec?.get("version") ?? "unknown";
      const e = rec?.get("edition") ?? "";
      return `${v}${e ? ` (${e})` : ""}`;
    } catch {
      // system 库不可读时回退默认库
      const s2 = driver.session({ database: "neo4j", defaultAccessMode: neo4j.session.READ });
      try {
        const r2 = await s2.run("CALL dbms.components() YIELD versions RETURN versions[0] AS version");
        return r2.records[0]?.get("version") ?? "unknown";
      } finally { try { await s2.close(); } catch { /* ignore */ } }
    } finally {
      try { await session.close(); } catch { /* ignore */ }
    }
  }

  // listTables → db.labels()（NODE）+ db.relationshipTypes()（RELATIONSHIP，rel: 前缀）
  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables: TableInfo[] = await this.withConnection(config, async (conn) => {
        const db = config.database || "neo4j";
        const out: TableInfo[] = [];
        const labels = await this.runCypher(conn, config, "CALL db.labels() YIELD label RETURN label");
        for (const r of labels.records) {
          const name = String((r._fields ?? [])[0] ?? "");
          if (name) out.push({ schema: db, name, type: "NODE LABEL", description: "" });
        }
        const rels = await this.runCypher(conn, config, "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType");
        for (const r of rels.records) {
          const name = String((r._fields ?? [])[0] ?? "");
          if (name) out.push({ schema: db, name: `rel:${name}`, type: "RELATIONSHIP", description: "" });
        }
        return out;
      });
      const filtered = filterTables(tables, pattern);
      return { success: true, tables: filtered, count: filtered.length };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }

  // describeTable → 节点/关系计数 + SHOW INDEXES/CONSTRAINTS + 采样 ≤100 推断属性（不依赖 APOC）
  // target：label 名；关系类型用 `rel:TYPE` 形式（与 listTables 输出一致）
  async describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult> {
    const name = target.trim();
    if (!name) return { success: false, error: "目标不能为空（label 名或 rel:关系类型）" };
    const isRel = name.toLowerCase().startsWith("rel:");
    const graphName = isRel ? name.slice(4) : name;
    if (!graphName) return { success: false, error: "目标名不能为空" };

    try {
      const columns = await this.withConnection(config, async (conn) => {
        const matchPart = isRel
          ? `MATCH ()-[e:${quoteId(graphName)}]->()`
          : `MATCH (e:${quoteId(graphName)})`;
        // 实体计数
        let count = "?";
        try {
          const c = await this.runCypher(conn, config, `${matchPart} RETURN count(e) AS n`);
          count = String(cellOf((c.records[0]?._fields ?? [])[0]));
        } catch { /* 计数失败不阻断元数据 */ }

        // 索引/约束（SHOW 全量取回，内存过滤目标 label/类型）
        const indexLines: string[] = [];
        const uniqueProps = new Set<string>();
        try {
          const idx = await this.runCypher(conn, config,
            "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state RETURN *");
          for (const r of idx.records) {
            const f = r._fields ?? [];
            const types = f[3] as string[] | null;
            if (!Array.isArray(types) || !types.includes(graphName)) continue;
            indexLines.push(`${f[0]}(${f[1]}, ${f[5] ?? "online"}) ON ${isRel ? "rel" : "node"}(${types.join(":")}).(${(f[4] ?? []).join(",")})`);
          }
        } catch { /* SHOW 失败降级 */ }
        try {
          const cons = await this.runCypher(conn, config,
            "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN *");
          for (const r of cons.records) {
            const f = r._fields ?? [];
            const types = f[3] as string[] | null;
            if (!Array.isArray(types) || !types.includes(graphName)) continue;
            for (const p of (f[4] ?? []) as string[]) if (String(f[1]).toUpperCase().includes("UNIQUE")) uniqueProps.add(p);
            indexLines.push(`${f[0]}(${f[1]}) ON ${types.join(":")}.(${(f[4] ?? []).join(",")})`);
          }
        } catch { /* 降级 */ }

        const cols: ColumnInfo[] = [
          {
            name: isRel ? "relationships" : "nodes", type: "meta", nullable: true, default: null, primaryKey: false,
            comment: `${isRel ? "关系" : "节点"}数 ${count}${indexLines.length > 0 ? `；${indexLines.slice(0, 10).join("；")}` : ""}`,
          },
        ];

        // 采样推断属性键（返回实体本体，驱动侧聚合）
        const sampled = await this.runCypher(conn, config, `${matchPart} RETURN e LIMIT ${SAMPLE_NODES}`);
        const { fields, total } = sampleProps(sampled.records);
        if (fields.length === 0) {
          cols.push({
            name: "(properties)", type: "meta", nullable: true, default: null, primaryKey: false,
            comment: `无样本或实体为空（采样 ≤${SAMPLE_NODES} 推断，非权威 schema）`,
          });
        }
        for (const f of fields) {
          cols.push({
            name: f.name, type: f.types.slice(0, 3).join("/"), nullable: f.count < total,
            default: null, primaryKey: uniqueProps.has(f.name),
            comment: `出现 ${f.count}/${total}（采样 ≤${SAMPLE_NODES} 推断）${uniqueProps.has(f.name) ? "；UNIQUE" : ""}`,
          });
        }
        return cols;
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: errMsg(err) };
    }
  }
}

export const neo4jDialect = new Neo4jDialect();
register(neo4jDialect);
