// test/scan-ai.test.ts —— v1.3.0 AI 扫描：候选校验（防幻觉）+ 文件树收集
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCandidates } from "../src/core/scan/validate.js";
import { collectTree } from "../src/core/scan/tree.js";
import { resolveRoot } from "../src/core/scan/walker.js";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("validateCandidates（AI 候选校验/防幻觉）", () => {
  const existing = new Set<string>(["old-conn"]);

  it("accepts a well-formed pg candidate and fills defaults", () => {
    const { candidates, rejected } = validateCandidates([
      { dialectId: "postgresql", host: "10.2.12.50", port: 15432, database: "zt_gacydmx", username: "postgres", password: "x", source: "application.yml" },
    ], existing);
    assert.equal(rejected.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "ready");
    assert.equal(candidates[0].partial.name, "postgresql-10.2.12.50-zt_gacydmx");
    assert.equal(candidates[0].source, "application.yml");
  });

  it("rejects unknown dialect (hallucinated type)", () => {
    const { candidates, rejected } = validateCandidates([{ dialectId: "oracle9i", host: "h" }], existing);
    assert.equal(candidates.length, 0);
    assert.match(rejected[0], /未知数据库类型/);
  });

  it("rejects url that the claimed dialect cannot parse (hallucination guard)", () => {
    const { candidates, rejected } = validateCandidates([
      { dialectId: "mysql", host: "1.2.3.4", url: "jdbc:postgresql://10.0.0.1:5432/db" },
      { dialectId: "redis", host: "h", url: "redis://x:${PORT:6379}/0" },
    ], existing);
    assert.equal(candidates.length, 0);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0], /无法被 mysql 方言解析/);
  });

  it("url wins over claimed fields (parsed values normalized in)", () => {
    const { candidates } = validateCandidates([
      { dialectId: "postgresql", host: "wrong-host", port: 1, url: "jdbc:postgresql://10.2.12.50:15432/zt?currentSchema=public", username: "u", password: "p" },
    ], existing);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].partial.host, "10.2.12.50");
    assert.equal(candidates[0].partial.port, 15432);
    assert.equal(candidates[0].partial.database, "zt");
  });

  it("marks missing required fields as incomplete per dialect", () => {
    const { candidates } = validateCandidates([
      { dialectId: "redis", host: "10.2.16.78", port: 31541 },                      // 缺 password
      { dialectId: "mongodb", host: "h", port: 27017 },                             // 无必缺（账号/库可选）
      { dialectId: "neo4j", host: "h", port: 7687 },                                // 缺 username/password
    ], existing);
    const [redis, mongo, neo] = candidates;
    assert.deepEqual(redis.missing, ["password"]);
    assert.equal(mongo.status, "ready");
    assert.deepEqual(neo.missing, ["username", "password"]);
  });

  it("marks name collision as exists", () => {
    const { candidates } = validateCandidates([
      { dialectId: "redis", name: "old-conn", host: "h", port: 6379, password: "x" },
    ], existing);
    assert.equal(candidates[0].status, "exists");
  });

  it("rejects missing host and bad port", () => {
    const { rejected } = validateCandidates([
      { dialectId: "redis", port: 6379 },
      { dialectId: "redis", host: "h", port: 99999, password: "x" },
      "not-an-object",
    ], existing);
    assert.equal(rejected.length, 3);
    assert.match(rejected[0], /缺 host/);
    assert.match(rejected[1], /port 非法/);
  });

  it("supports password as placeholder string from model extraction", () => {
    const { candidates } = validateCandidates([
      { dialectId: "dm", host: "10.2.12.50", port: 32036, database: "x", username: "SYSDBA", password: "${DB-PASSWORD:real}" },
    ], existing);
    assert.equal(candidates[0].status, "ready");
  });
});

describe("collectTree（文件树发现，语言无关）", () => {
  let dir = "";

  it("lists all-language files, ignores node_modules, sorted shallow-first", () => {
    // setup 必须在 it 内（node:test describe 体与 it 的执行时序不可靠）
    dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "dbtree-")); // cwd 子树内（resolveRoot 红线）
    mkdirSync(join(dir, "udp-be", "src", "main", "resources"), { recursive: true });
    mkdirSync(join(dir, "pyapp"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "udp-be", "src", "main", "resources", "application.yml"), "a: 1");
    writeFileSync(join(dir, "pyapp", "settings.py"), "DB = 'x'");
    writeFileSync(join(dir, "pyapp", "config.toml"), "[db]");
    writeFileSync(join(dir, "Dockerfile"), "FROM node");
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(dir, "go.mod"), "module x");
    try {
      const t = collectTree(dir);
      assert.equal(t.truncated, false);
      assert.ok(t.lines.includes("udp-be/src/main/resources/application.yml"));
      assert.ok(t.lines.includes("pyapp/settings.py"));
      assert.ok(t.lines.includes("pyapp/config.toml"));
      assert.ok(t.lines.includes("Dockerfile"));
      assert.ok(t.lines.includes("go.mod"));
      assert.ok(!t.lines.some((l) => l.includes("node_modules")));
      // 浅层在前
      assert.ok(t.lines.indexOf("Dockerfile") < t.lines.indexOf("udp-be/src/main/resources/application.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveRoot rejects out-of-cwd paths", () => {
    assert.throws(() => resolveRoot("/etc"), /out of scope/);
    assert.throws(() => resolveRoot("../.."), /out of scope/);
  });
});
