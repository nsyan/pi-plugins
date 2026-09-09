// test/relational.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelationalDialect } from "../src/dialects/relational-dialect.js";

class Stub extends RelationalDialect {
  id = "postgresql" as const; label = "PostgreSQL"; family = "relational" as const; defaultPort = 5432;
  fingerprints = { urlPatterns: [/^jdbc:postgresql:\/\//], configKeys: [] as string[] };
  parseUrl = () => null; displayUrl = () => "";
  protected async doConnect() { throw new Error("no conn in unit test"); }
  protected async doExecute() { throw new Error("no conn in unit test"); }
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
