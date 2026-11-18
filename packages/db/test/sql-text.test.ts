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
  it("CTE 里的真 DML 仍判写（字面量剥离不削弱检测）", () => {
    assert.equal(isWriteStatement("WITH t AS (SELECT 1) DELETE FROM users"), true);
  });
  it("字面量里的 DML 关键词不再误判（v1.3.7 修正：剥离字面量后再判副作用）", () => {
    // 旧断言（"有意保守：不剥离字符串字面量"）把 `SELECT 'FOR UPDATE'`、
    // `WHERE note = 'x INTO y'` 这类纯读语句也判成写——白名单姿态下误报面进一步扩大。
    // 现在只剥字面量做判定（执行仍用原语句），误报消失、真写不漏。
    assert.equal(isWriteStatement("WITH t AS (SELECT 'DELETE FROM x') SELECT * FROM t"), false);
    assert.equal(isWriteStatement("SELECT 'FOR UPDATE' AS note"), false);
    assert.equal(isWriteStatement("SELECT a FROM t WHERE note = 'FOR UPDATE'"), false);
    assert.equal(isWriteStatement("SELECT REPLACE(name, 'a INTO b', '') FROM t"), false);
    assert.equal(isWriteStatement("SELECT 'nextval(' AS s"), false);
  });
  it("MySQL backslash escape does not hide DROP", () => {
    const stmts = splitStatements("SELECT 'a\\'; DROP TABLE t");
    assert.equal(stmts.some(isDropStatement), true);
  });
});
