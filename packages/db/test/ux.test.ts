import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConnectionString } from "../src/config.js";
import { toCsv } from "../src/core/export.js";

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
