// test/elasticsearch.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esDialect, pickMajor, hitsToRows } from "../src/dialects/elasticsearch.js";

describe("pickMajor", () => {
  it("parses 7.17.0 -> 7", () => assert.equal(pickMajor("7.17.0"), 7));
  it("parses 8.12.1 -> 8", () => assert.equal(pickMajor("8.12.1"), 8));
});

describe("es parseUrl", () => {
  it("parses plain url without credentials", () => {
    assert.deepEqual(esDialect.parseUrl("http://10.2.15.249:19200"),
      { host: "10.2.15.249", port: 19200, ssl: false });
  });
  it("extracts userinfo with url-encoded password（扫描 .env 带凭据 URL）", () => {
    const r = esDialect.parseUrl("http://elastic:hxsjzt%402025@10.2.15.249:19200")!;
    assert.equal(r.host, "10.2.15.249");
    assert.equal(r.port, 19200);
    assert.equal(r.username, "elastic");
    assert.equal(r.password, "hxsjzt@2025");
  });
  it("extracts username-only userinfo and https default port", () => {
    const r = esDialect.parseUrl("https://elastic@es.example.com")!;
    assert.equal(r.host, "es.example.com");
    assert.equal(r.port, 443);
    assert.equal(r.ssl, true);
    assert.equal(r.username, "elastic");
    assert.equal(r.password, undefined);
  });
});

describe("es hitsToRows（聚合渲染与截断标注）", () => {
  it("无命中但有聚合时展开桶为行（size:0 纯聚合查询）", () => {
    const r = hitsToRows({ hits: { total: { value: 0, relation: "eq" }, hits: [] }, aggregations: { by_type: { buckets: [{ key: "A", doc_count: 12 }, { key: "B", doc_count: 5 }] } } });
    assert.deepEqual(r.columns, ["aggregation", "key", "doc_count", "value"]);
    assert.deepEqual(r.rows, [["by_type", "A", 12, null], ["by_type", "B", 5, null]]);
    assert.equal(r.truncated, undefined);
  });
  it("桶内子聚合折叠进 value 列 JSON", () => {
    const r = hitsToRows({ hits: { total: 0, hits: [] }, aggregations: { by_day: { buckets: [{ key: 100, doc_count: 3, avg: { value: 1.5 } }] } } });
    assert.deepEqual(r.rows, [["by_day", 100, 3, JSON.stringify({ avg: { value: 1.5 } })]]);
  });
  it("metric 聚合取值", () => {
    const r = hitsToRows({ hits: { total: 0, hits: [] }, aggregations: { avg_score: { value: 88.5 } } });
    assert.deepEqual(r.rows, [["avg_score", null, null, 88.5]]);
  });
  it("total 大于取回行数 → truncated", () => {
    const r = hitsToRows({ hits: { total: { value: 88, relation: "eq" }, hits: [{ _id: "1", _source: {} }] } });
    assert.equal(r.rowCount, 88);
    assert.equal(r.truncated, true);
  });
  it("全部取回 → 不标 truncated", () => {
    const r = hitsToRows({ hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: "1", _source: {} }] } });
    assert.equal(r.truncated, false);
  });
  it("命中与聚合共存时保持文档视图", () => {
    const r = hitsToRows({ hits: { total: 1, hits: [{ _id: "x", _source: { a: 1 } }] }, aggregations: { g: { value: 1 } } });
    assert.deepEqual(r.columns, ["_id", "_source"]);
    assert.equal(r.rows.length, 1);
  });
});

describe("es isAllowed", () => {
  it("allows search DSL in readonly", () => {
    assert.equal(esDialect.isAllowed(JSON.stringify({ query: { match_all: {} } }), true).ok, true);
  });
  it("denies _bulk in readonly", () => {
    assert.equal(esDialect.isAllowed(JSON.stringify({ bulk: [] }), true).ok, false);
  });
  it("always denies index deletion", () => {
    assert.equal(esDialect.isAllowed("DELETE my-index", false).ok, false);
  });
  it("classifies aggs-only body as read (无 query 键)", () => {
    const v = esDialect.isAllowed(JSON.stringify({ size: 0, aggs: { by_type: { terms: { field: "type" } } } }), true);
    assert.equal(v.ok, true);
    assert.equal(v.isWrite, false);
  });
  it("denies write endpoints early even when readonly=false（早期拒绝，不进确认框）", () => {
    const v = esDialect.isAllowed(JSON.stringify({ mapping: { properties: {} } }), false);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /写端点不支持/);
  });
  it("still treats unknown JSON as write", () => {
    const v = esDialect.isAllowed(JSON.stringify({ whatever: { x: 1 } }), false);
    assert.equal(v.ok, false);
  });
});

// ── v1.3.7 自查回归：信封字段传递 ──────────────────────────
// 修 _count/_mget 丢条件时踩了两个坑，都是「把信封字段当通用字段删掉/取错层级」：
//   ① `{size:0, aggs:{...}}` 的 size 被当通用字段摘掉 → 注入 maxRows → 聚合退化成普通搜索
//   ② count 的 query 挂在 count 值里，取 envelope.query 恒 undefined → 条件仍被忽略
// 这里直接对 doSearch 的入参构造做断言（不连库：stub 掉 withConnection）。
describe("es 信封传递（doSearch 内部构造）", () => {
  type Captured = { search?: Record<string, unknown>; count?: Record<string, unknown>; mget?: Record<string, unknown> };

  /** 用假 client 截获传给 ES 客户端的参数 */
  function capture(sql: string): Promise<Captured> {
    const cap: Captured = {};
    const fakeClient = {
      search: async (p: any) => { cap.search = p; return { hits: { total: 0, hits: [] } }; },
      count: async (p: any) => { cap.count = p; return { count: 0 }; },
      mget: async (p: any) => { cap.mget = p; return { docs: [] }; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDialect = esDialect as any;
    const kind = (anyDialect as any).constructor;
    // doSearch 是 protected：从原型上直接取
    const proto = Object.getPrototypeOf(esDialect);
    const doSearch = proto.doSearch as (c: unknown, cfg: unknown, s: string, k: unknown, o: unknown) => Promise<unknown>;
    const cfg = { id: "x", name: "n", type: "elasticsearch", host: "h", port: 9200, database: "idx", createdAt: "" };
    const dslKind = JSON.parse(sql) as Record<string, unknown>;
    const parsedKind = "bulk" in dslKind
      ? { type: "write", endpoint: "bulk", detail: "bulk" }
      : "mget" in dslKind || "mget_docs" in dslKind
        ? { type: "read", endpoint: "_mget", detail: "mget" }
        : "count" in dslKind
          ? { type: "read", endpoint: "_count", detail: "count" }
          : { type: "read", endpoint: "_search", detail: "query" };
    void kind;
    return doSearch.call(esDialect, fakeClient, cfg, sql, parsedKind, { readonly: true, maxRows: 25, timeoutSec: 5 })
      .then(() => cap);
  }

  it("size:0 的纯聚合查询保留 size，不被注入 maxRows", async () => {
    const cap = await capture(JSON.stringify({ size: 0, aggs: { by_type: { terms: { field: "type" } } } }));
    assert.equal(cap.search?.size, undefined, "顶层不应注入 size（body 里已有 size:0）");
    assert.equal((cap.search?.body as Record<string, unknown>)?.size, 0, "body.size 必须保留 0");
  });

  it("_count 的 query 从 count 值里取出并下传", async () => {
    const cap = await capture(JSON.stringify({ count: { query: { match: { status: "paid" } } } }));
    assert.deepEqual(cap.count?.query, { match: { status: "paid" } });
  });

  it("_count 无 query 时不传空条件", async () => {
    const cap = await capture(JSON.stringify({ count: {} }));
    assert.equal(cap.count?.query, undefined);
  });

  it("_mget 的 docs 真的下传（此前恒为空数组）", async () => {
    const cap = await capture(JSON.stringify({ mget_docs: [{ _id: "1" }, { _id: "2" }] }));
    assert.deepEqual(cap.mget?.docs, [{ _id: "1" }, { _id: "2" }]);
    assert.deepEqual((cap.mget?.body as { docs?: unknown[] })?.docs, [{ _id: "1" }, { _id: "2" }]);
  });

  it("信封顶层 index 可覆盖默认 index，且不混进 body", async () => {
    const cap = await capture(JSON.stringify({ index: "other", query: { match_all: {} } }));
    assert.equal(cap.search?.index, "other");
    assert.equal((cap.search?.body as Record<string, unknown>)?.index, undefined);
  });
});
