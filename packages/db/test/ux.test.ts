import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConnectionString, shortTypeLabel, fullTypeLabel } from "../src/config.js";
import { toCsv } from "../src/core/export.js";
import { registry } from "../src/dialects/index.js";

describe("parseConnectionString", () => {
  it("postgres uri", () => {
    assert.deepEqual(parseConnectionString("postgresql://u:p@h:5432/db"),
      { dialectId: "postgresql", host: "h", port: 5432, username: "u", password: "p", database: "db" });
  });
  it("redis uri with db index", () => {
    assert.deepEqual(parseConnectionString("redis://:p@h:6379/2"),
      { dialectId: "redis", host: "h", port: 6379, password: "p", dbIndex: 2 });
  });
  it("es http url", () => {
    assert.deepEqual(parseConnectionString("http://h:9200"),
      { dialectId: "elasticsearch", host: "h", port: 9200 });
  });
  it("hive jdbc", () => {
    assert.deepEqual(parseConnectionString("jdbc:hive2://h:10000/db"),
      { dialectId: "hive", host: "h", port: 10000, database: "db" });
  });
  it("returns null for unknown scheme", () => {
    assert.equal(parseConnectionString("ftp://h:21"), null);
  });
});

describe("toCsv", () => {
  it("renders header, separator-free rows and quotes commas", () => {
    const csv = toCsv(["id", "name"], [[1, "a,b"], [2, "plain"]]);
    const lines = csv.split("\n");
    assert.equal(lines[0], "id,name");
    assert.equal(lines[1], '1,"a,b"');
    assert.equal(lines[2], "2,plain");
  });
});

// v1.3.1 修复回归：标签表曾只覆盖 pg/mysql/oracle/mongodb/neo4j，
// dm/redis/ES/hive/spark 静默 fallback 成原始小写 id，污染 AI 系统提示与 db_connections 输出。
describe("type labels", () => {
  it("覆盖注册表中全部方言（新增方言漏补标签即失败）", () => {
    assert.ok(registry.size >= 10, `注册表方言数异常: ${registry.size}`);
    for (const id of registry.keys()) {
      assert.notEqual(shortTypeLabel(id), id, `${id} 缺短标签（fallback 成原始 id）`);
      assert.notEqual(fullTypeLabel(id), id, `${id} 缺全称（fallback 成原始 id）`);
      assert.ok(shortTypeLabel(id).trim().length > 0, `${id} 短标签为空`);
      assert.ok(fullTypeLabel(id).trim().length > 0, `${id} 全称为空`);
    }
  });
  it("达梦/ES 等曾被遗漏的类型返回预期标签", () => {
    assert.equal(shortTypeLabel("dm"), "DM");
    assert.equal(fullTypeLabel("dm"), "达梦");
    assert.equal(shortTypeLabel("elasticsearch"), "ES");
    assert.equal(fullTypeLabel("elasticsearch"), "Elasticsearch");
    assert.equal(shortTypeLabel("redis"), "Redis");
    assert.equal(shortTypeLabel("hive"), "Hive");
    assert.equal(shortTypeLabel("spark"), "Spark");
  });
  it("既有类型标签保持不变", () => {
    assert.equal(shortTypeLabel("postgresql"), "PG");
    assert.equal(fullTypeLabel("postgresql"), "PostgreSQL");
    assert.equal(shortTypeLabel("mysql"), "MySQL");
    assert.equal(shortTypeLabel("oracle"), "Oracle");
    assert.equal(shortTypeLabel("mongodb"), "MongoDB");
    assert.equal(shortTypeLabel("neo4j"), "Neo4j");
  });
});
