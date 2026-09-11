// test/elasticsearch.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esDialect, pickMajor } from "../src/dialects/elasticsearch.js";

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
