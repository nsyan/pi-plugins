// test/elasticsearch.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esDialect, pickMajor } from "../src/dialects/elasticsearch.js";

describe("pickMajor", () => {
  it("parses 7.17.0 -> 7", () => assert.equal(pickMajor("7.17.0"), 7));
  it("parses 8.12.1 -> 8", () => assert.equal(pickMajor("8.12.1"), 8));
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
