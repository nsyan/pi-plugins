// test/smoke.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWriteStatement, isDropStatement } from "../src/core/sql-text.js";

describe("smoke: existing pure functions", () => {
  it("isWriteStatement identifies INSERT", () => {
    assert.equal(isWriteStatement("INSERT INTO t VALUES (1)"), true);
  });
  it("isWriteStatement passes SELECT", () => {
    assert.equal(isWriteStatement("SELECT * FROM t"), false);
  });
  it("isDropStatement identifies DROP TABLE", () => {
    assert.equal(isDropStatement("DROP TABLE users"), true);
  });
});
