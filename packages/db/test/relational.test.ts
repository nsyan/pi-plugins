// test/relational.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelationalDialect } from "../src/dialects/relational-dialect.js";
import type { ConnConfig } from "../src/core/types.js";

class Stub extends RelationalDialect {
  id = "postgresql" as const; label = "PostgreSQL"; family = "relational" as const; defaultPort = 5432;
  fingerprints = { urlPatterns: [/^jdbc:postgresql:\/\//], configKeys: [] as string[] };
  parseUrl = () => null; displayUrl = () => "";
  // 返回类型标注 Promise<never>：方法只抛错，never 是基类返回类型的子类型，避免被推断成 Promise<void>。
  protected async doConnect(): Promise<never> { throw new Error("no conn in unit test"); }
  protected async doExecute(): Promise<never> { throw new Error("no conn in unit test"); }
  async versionQuery() { return ""; }
  async listTables() { return { success: false as const, error: "nope" }; }
  async describeTable() { return { success: false as const, error: "nope" }; }
}

describe("RelationalDialect.isAllowed", () => {
  const d = new Stub();
  it("blocks DROP in second statement even when readonly off", () => {
    const v = d.isAllowed("SELECT 1; DROP TABLE users;", false);
    assert.equal(v.ok, false);
  });
  it("blocks CTE-DML in readonly mode", () => {
    const v = d.isAllowed("WITH t AS (SELECT 1) DELETE FROM users", true);
    assert.equal(v.ok, false);
  });
  it("allows SELECT and reports isWrite=false with summary", () => {
    const v = d.isAllowed("SELECT a FROM users", true);
    assert.equal(v.ok, true);
    assert.equal(v.isWrite, false);
    assert.match(v.summary ?? "", /SELECT/i);
  });
  it("marks INSERT as write in non-readonly mode", () => {
    const v = d.isAllowed("INSERT INTO t VALUES (1)", false);
    assert.equal(v.ok, true);
    assert.equal(v.isWrite, true);
  });
});

/** 结果集桩：doExecute 返回给定 columns/rows/rowCount，用于验证 executeOn 的 truncated 标注 */
class DataStub extends RelationalDialect {
  id = "postgresql" as const; label = "PostgreSQL"; family = "relational" as const; defaultPort = 5432;
  fingerprints = { urlPatterns: [/^jdbc:postgresql:\/\//], configKeys: [] as string[] };
  parseUrl = () => null; displayUrl = () => "";
  private payload: { columns: string[]; rows: unknown[][]; rowCount: number };
  constructor(payload: { columns: string[]; rows: unknown[][]; rowCount: number }) { super(); this.payload = payload; }
  protected async doConnect() { return { type: "postgresql" as const, client: {}, async close() {} }; }
  protected async doExecute() { return this.payload; }
  async versionQuery() { return ""; }
  async listTables() { return { success: false as const, error: "nope" }; }
  async describeTable() { return { success: false as const, error: "nope" }; }
}

describe("RelationalDialect.executeOn 截断标注", () => {
  it("结果集被 maxRows 截断时标 truncated（rowCount 为服务端全量）", async () => {
    const stub = new DataStub({ columns: ["a"], rows: [[1]], rowCount: 100 });
    const r = await stub.executeOn({} as ConnConfig, "SELECT a FROM t", { readonly: true, maxRows: 1, timeoutSec: 5 });
    assert.equal(r.success, true);
    assert.equal(r.truncated, true);
  });
  it("全部取回时不标 truncated", async () => {
    const stub = new DataStub({ columns: ["a"], rows: [[1], [2]], rowCount: 2 });
    const r = await stub.executeOn({} as ConnConfig, "SELECT a FROM t", { readonly: true, maxRows: 50, timeoutSec: 5 });
    assert.equal(r.truncated, false);
  });
  it("写操作（无列、rows 空、rowCount=影响行数）不得误标截断", async () => {
    const stub = new DataStub({ columns: [], rows: [], rowCount: 5 });
    const r = await stub.executeOn({} as ConnConfig, "UPDATE t SET a=1", { readonly: false, maxRows: 50, timeoutSec: 5 });
    assert.equal(r.truncated, false);
  });
});
