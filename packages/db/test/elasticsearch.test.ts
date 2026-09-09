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
});
