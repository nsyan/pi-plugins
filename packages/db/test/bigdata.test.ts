// test/bigdata.test.ts
// 注：Task 2 registry 桩风格延续——直接 import 方言文件触发自注册后断言
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/dialects/index.js";
import "../src/dialects/hive.js";
import "../src/dialects/spark.js";
import { hiveDialect } from "../src/dialects/hive.js";
import { sparkDialect } from "../src/dialects/spark.js";

describe("hive", () => {
  it("parses hive2 url", () => {
    assert.deepEqual(hiveDialect.parseUrl("jdbc:hive2://h:10000/mydb"),
      { host: "h", port: 10000, database: "mydb" });
  });
  it("treats INSERT OVERWRITE as write", () => {
    assert.equal(hiveDialect.isAllowed("INSERT OVERWRITE TABLE t SELECT 1", false).isWrite, true);
  });
  it("blocks DROP TABLE always", () => {
    assert.equal(hiveDialect.isAllowed("DROP TABLE t", false).ok, false);
  });
});

describe("spark", () => {
  it("parses hive2 url with custom port", () => {
    assert.equal(sparkDialect.parseUrl("jdbc:hive2://h:10015/mydb")?.port, 10015);
  });
  it("treats CACHE TABLE as write", () => {
    assert.equal(sparkDialect.isAllowed("CACHE TABLE t", false).isWrite, true);
  });
});

describe("bigdata registry", () => {
  it("registers hive and spark as bigdata family", () => {
    assert.equal(registry.get("hive")?.family, "bigdata");
    assert.equal(registry.get("spark")?.family, "bigdata");
  });
});
