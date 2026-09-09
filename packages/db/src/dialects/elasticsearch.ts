// dialects/elasticsearch.ts —— Elasticsearch 方言（SearchDialect + v7/v8 双客户端分发）
import { Client as ClientV8 } from "@elastic/elasticsearch";
import { Client as ClientV7 } from "es7";
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget,
  TestConnectionResult, ListTablesResult, DescribeTableResult,
  TableInfo, ColumnInfo } from "../core/types.js";
import { SearchDialect, type DslKind } from "./search-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析：http(s)://host:port（认证走账号/密码字段，API Key 二期）───
const ES_RE = /^(https?):\/\/([^:/?#@]+)(?::(\d+))?(\/.*)?$/;

function parseEsUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0].replace(/\/+$/, "");
  const m = clean.match(ES_RE);
  if (!m) return null;
  const host = m[2];
  const defaultPort = m[1] === "https" ? 443 : 9200;
  const port = m[3] ? parseInt(m[3], 10) : defaultPort;
  const ssl = m[1] === "https";
  if (!host) return null;
  return { host, port, ssl };
}

/** 从 `version.number`（如 "7.17.0"）取大版本号 */
export function pickMajor(versionNumber: string): number {
  const major = parseInt(versionNumber.split(".")[0], 10);
  return Number.isNaN(major) ? 0 : major;
}

type AnyClient = ClientV8 | ClientV7;

function makeClient(config: ConnConfig, ClientClass: new (opts: Record<string, unknown>) => AnyClient): AnyClient {
  const scheme = (config.port === 443 || config.options?.scheme === "https") ? "https" : "http";
  const node = `${scheme}://${config.host ?? "localhost"}:${config.port ?? 9200}`;
  const opts: Record<string, unknown> = { node, requestTimeout: 30_000 };
  if (config.username) {
    opts.auth = { username: config.username, password: config.password ?? "" };
  }
  return new ClientClass(opts);
}

class ElasticsearchDialect extends SearchDialect {
  id = "elasticsearch" as const;
  label = "Elasticsearch";
  family = "search" as const;
  defaultPort = 9200;
  fingerprints: Fingerprints = {
    urlPatterns: [/^https?:\/\/[^/]*:9200/],
    configKeys: ["spring.elasticsearch.uris", "spring.data.elasticsearch.client.reactive.endpoints", "spring.data.elasticsearch.uris"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseEsUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    const scheme = (config.port === 443 || config.options?.scheme === "https") ? "https" : "http";
    return `${scheme}://${config.host}:${config.port}`;
  }

  protected async doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection> {
    // 先用"最新客户端"做无版本探测 GET /（testConnection 与 withConnection 共用）；
    // GET / 返回 version.number 后按大版本分发（详见 testConnection）
    const probe = makeClient(config, ClientV8 as unknown as new (opts: Record<string, unknown>) => AnyClient);
    try {
      const info = await (probe as ClientV8).info();
      const versionNumber = (info as unknown as { version?: { number?: string } }).version?.number ?? "";
      const major = pickMajor(versionNumber);
      if (major === 7) {
        const v7 = makeClient(config, ClientV7 as unknown as new (opts: Record<string, unknown>) => AnyClient);
        return { type: "elasticsearch", client: v7, async close() { await v7.close(); } };
      }
      // 8 及未知更高大版本：一律用最新客户端尝试（未知版本不硬拒，warning 由 testConnection 给出）
      return { type: "elasticsearch", client: probe, async close() { await probe.close(); } };
    } catch (err: unknown) {
      try { await probe.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    // 连接建立时已做版本探测，这里复用一次 GET / 取完整版本号
    const client = conn.client as ClientV8;
    const info = await client.info();
    return (info as unknown as { version?: { number?: string } }).version?.number ?? "unknown";
  }

  // testConnection 复写基类：同时返回服务端版本号 + 未知大版本的 warning（Spec §12）
  async testConnection(config: ConnConfig): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const probe = makeClient(config, ClientV8 as unknown as new (opts: Record<string, unknown>) => AnyClient);
      let versionNumber = "";
      try {
        const info = await (probe as ClientV8).info();
        versionNumber = (info as unknown as { version?: { number?: string } }).version?.number ?? "";
      } finally {
        try { await probe.close(); } catch { /* ignore */ }
      }
      const major = pickMajor(versionNumber);
      if (major !== 7 && major !== 8) {
        // 未知/更高大版本：用最新客户端建连验证 + 版本警告（不硬拒）
        const version = await this.withConnection(config, (conn) => this.versionQuery(conn));
        return { success: true, version, latency: `${Date.now() - start}ms`, warning: `未识别的 ES 大版本（${versionNumber || "unknown"}），已用最新客户端尝试，结果可能不准确` };
      }
      const version = await this.withConnection(config, (conn) => this.versionQuery(conn));
      return { success: true, version, latency: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), latency: `${Date.now() - start}ms` };
    }
  }

  protected async doSearch(client: unknown, config: ConnConfig, sql: string, kind: DslKind, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
    const es = client as ClientV8;
    const index = config.database;
    if (!index) throw new Error("ES 连接缺少默认 index（database 字段）");
    // 注：DSL 需整体透传为 body——kind 只做分类，原文从 sql 取（JSON.parse 失败即 query_string，已在上游分支处理）
    const body = kind.type === "read" && kind.endpoint === "_search"
      ? (JSON.parse(sql) as Record<string, unknown>)
      : undefined;
    if (kind.type === "query_string") {
      const res = await es.search({ index, size: opts.maxRows, q: kind.text });
      return hitsToRows(res);
    }
    if (kind.type === "read") {
      if (kind.endpoint === "_count") {
        const res = await es.count({ index });
        const count = (res as unknown as { count?: number }).count ?? 0;
        return { columns: ["count"], rows: [[count]], rowCount: count };
      }
      if (kind.endpoint === "_mget") {
        const res = await es.mget({ index, body: { docs: [] } });
        return docsToRows(res);
      }
      // _search：DSL 整体即 body
      const res = await es.search({ index, body, size: opts.maxRows });
      return hitsToRows(res);
    }
    throw new Error(`ES 写端点 ${kind.endpoint} 需走非只读确认流程执行，本方言 executeOn 仅执行读查询`);
  }

  // listTables → cat.indices（名称/健康/文档数/大小）
  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables: TableInfo[] = await this.withConnection(config, async (conn) => {
        const es = conn.client as ClientV8;
        const res = await es.cat.indices({ format: "json", h: "index,health,docs.count,store.size", s: "index" });
        const rows = (res as unknown as Array<Record<string, string>>).slice(0, 500);
        return filterTables(rows.map((r) => ({
          schema: "",
          name: r["index"] ?? "",
          type: "INDEX",
          description: `健康:${r["health"] ?? "?"} 文档数:${r["docs.count"] ?? "?"} 大小:${r["store.size"] ?? "?"}`,
        })), pattern);
      });
      return { success: true, tables, count: tables.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // describeTable → getMapping + getSettings（字段/类型/可搜索性 + 分片副本）
  async describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult> {
    if (!target.trim()) {
      return { success: false, error: "index 名不能为空" };
    }
    try {
      const columns: ColumnInfo[] = await this.withConnection(config, async (conn) => {
        const es = conn.client as ClientV8;
        const mappingRes = await es.indices.getMapping({ index: target });
        const settingsRes = await es.indices.getSettings({ index: target });
        const mapping = mappingRes as unknown as Record<string, { mappings?: { properties?: Record<string, { type?: string; index?: boolean; analyzer?: string }> } }>;
        const props = mapping[target]?.mappings?.properties ?? {};
        const settings = settingsRes as unknown as Record<string, { settings?: { index?: Record<string, string> } }>;
        const idxSettings = settings[target]?.settings?.index ?? {};
        const cols: ColumnInfo[] = Object.entries(props).map(([name, def]) => ({
          name,
          type: def.type ?? "object",
          nullable: true,
          default: null,
          primaryKey: false,
          comment: def.index === false ? "不可搜索" : (def.analyzer ? `analyzer:${def.analyzer}` : ""),
        }));
        cols.push({
          name: "_settings",
          type: "meta",
          nullable: true,
          default: null,
          primaryKey: false,
          comment: `分片:${idxSettings["number_of_shards"] ?? "?"} 副本:${idxSettings["number_of_replicas"] ?? "?"}`,
        });
        return cols;
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── 结果转换 ──────────────────────────────
function hitsToRows(res: unknown): { columns: string[]; rows: unknown[][]; rowCount: number } {
  const body = res as { hits?: { total?: number | { value?: number }; hits?: Array<{ _id?: string; _source?: unknown }> } };
  const hits = body.hits?.hits ?? [];
  const total = typeof body.hits?.total === "number" ? body.hits.total : (body.hits?.total?.value ?? hits.length);
  const rows = hits.map((h) => [h._id, typeof h._source === "object" ? JSON.stringify(h._source) : h._source]);
  return { columns: ["_id", "_source"], rows, rowCount: typeof total === "number" ? total : hits.length };
}

function docsToRows(res: unknown): { columns: string[]; rows: unknown[][]; rowCount: number } {
  const body = res as { docs?: Array<{ _id?: string; _source?: unknown; found?: boolean }> };
  const docs = body.docs ?? [];
  const rows = docs.map((d) => [d._id, d.found ? JSON.stringify(d._source) : "not found"]);
  return { columns: ["_id", "_source"], rows, rowCount: rows.length };
}

export const esDialect = new ElasticsearchDialect();
register(esDialect);
