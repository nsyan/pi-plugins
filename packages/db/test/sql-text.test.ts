// test/sql-text.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripComments, splitStatements, isWriteStatement, isDropStatement } from "../src/core/sql-text.js";

describe("stripComments", () => {
  it("removes line comments but keeps string content", () => {
    assert.equal(stripComments("SELECT 1 -- hello\nFROM t"), "SELECT 1 \nFROM t");
    assert.equal(stripComments("SELECT '-- not a comment'"), "SELECT '-- not a comment'");
  });
  it("removes block comments", () => {
    assert.equal(stripComments("SELECT /* x */ 1"), "SELECT  1");
  });
});

describe("splitStatements", () => {
  it("handles doubled-quote escape", () => {
    assert.deepEqual(splitStatements("SELECT 'it''s'; SELECT 2"), ["SELECT 'it''s'", "SELECT 2"]);
  });
  it("ignores semicolons inside comments", () => {
    assert.deepEqual(splitStatements("SELECT 1 -- a;b\n; SELECT 2"), ["SELECT 1", "SELECT 2"]);
  });
});

describe("write/drop detection", () => {
  it("catches second-statement DROP (existing bypass)", () => {
    const stmts = splitStatements("SELECT 1; DROP TABLE users;");
    assert.equal(stmts.some(isDropStatement), true);
  });
  it("catches CTE-DML", () => {
    assert.equal(isWriteStatement("WITH t AS (SELECT 1) DELETE FROM users"), true);
  });
  it("catches SELECT FOR UPDATE", () => {
    assert.equal(isWriteStatement("SELECT * FROM t FOR UPDATE"), true);
  });
  it("catches commented-out DELETE prefix", () => {
    assert.equal(isWriteStatement("/* c */ DELETE FROM t"), true);
  });
  it("passes plain SELECT", () => {
    assert.equal(isWriteStatement("SELECT * FROM t"), false);
    assert.equal(isDropStatement("SELECT * FROM t"), false);
  });
  it("conservative: DML keyword inside CTE string literal counts as write", () => {
    // 有意保守：不剥离字符串字面量，偏安全方向（Spec §4.1）
    assert.equal(isWriteStatement("WITH t AS (SELECT 'DELETE FROM x') SELECT * FROM t"), true);
  });
  it("MySQL backslash escape does not hide DROP", () => {
    const stmts = splitStatements("SELECT 'a\\'; DROP TABLE t");
    assert.equal(stmts.some(isDropStatement), true);
  });
});
