// test/dialects-relational.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/dialects/index.js";
import "../src/dialects/postgresql.js";
import "../src/dialects/mysql.js";
import "../src/dialects/oracle.js";
import "../src/dialects/dm.js";
import "../src/dialects/elasticsearch.js";
import "../src/dialects/hive.js";
import "../src/dialects/spark.js";

describe("relational dialects registered", () => {
  it("parses postgres JDBC url", () => {
    const d = registry.get("postgresql")!;
    assert.deepEqual(d.parseUrl("jdbc:postgresql://h:5432/mydb"),
      { host: "h", port: 5432, database: "mydb" });
  });
  it("parses mysql JDBC url with default port", () => {
    const d = registry.get("mysql")!;
    assert.deepEqual(d.parseUrl("jdbc:mysql://h/mydb"),
      { host: "h", port: 3306, database: "mydb" });
  });
  it("parses oracle service url", () => {
    const d = registry.get("oracle")!;
    const p = d.parseUrl("jdbc:oracle:thin:@//h:1521/svc");
    assert.equal(p?.host, "h");
    assert.equal(p?.port, 1521);
    assert.equal(p?.database, "svc");
  });
  it("parses oracle SID url (Task 5 carry-over)", () => {
    const d = registry.get("oracle")!;
    const p = d.parseUrl("jdbc:oracle:thin:@h:1521:sid");
    assert.deepEqual(p, { host: "h", port: 1521, database: "sid" });
  });
  it("parses native postgres URI with credentials (Spec §7 双形态)", () => {
    const d = registry.get("postgresql")!;
    assert.deepEqual(d.parseUrl("postgresql://u:p@h:5432/mydb"),
      { host: "h", port: 5432, username: "u", password: "p", database: "mydb" });
  });
  it("displayUrl omits password", () => {
    const d = registry.get("postgresql")!;
    const shown = d.displayUrl({ id: "x", name: "n", type: "postgresql", host: "h", port: 5432, username: "u", password: "secret", database: "db", createdAt: "" });
    assert.ok(!shown.includes("secret"));
  });
  it("registry size is exactly 10 after neo4j dialect (Spec §9 规模断言)", () => {
    assert.equal(registry.size, 10);
  });
});
