import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanProject } from "../src/core/scan/candidates.js";
import { springKeysToRaw } from "../src/core/scan/spring.js";
import path from "node:path";

const FIX = path.join(import.meta.dirname, "fixtures", "spring-demo");

describe("springKeysToRaw", () => {
  it("splits baomidou dynamic-datasource keys into per-name candidates", () => {
    const raws = springKeysToRaw({
      "spring.datasource.dynamic.datasource.dm.driver-class-name": "dm.jdbc.driver.DmDriver",
      "spring.datasource.dynamic.datasource.dm.url": "jdbc:dm://10.2.12.50:32036?schema=zhrs_ls",
      "spring.datasource.dynamic.datasource.dm.username": "SYSDBA",
      "spring.datasource.dynamic.datasource.dm.password": "pw1",
      "spring.datasource.dynamic.datasource.pg.url": "jdbc:postgresql://10.2.12.50:15432/lsjb",
      "spring.datasource.dynamic.datasource.pg.username": "postgres",
      "spring.datasource.dynamic.datasource.pg.password": "pw2",
    }, "application-dev.yml", 0.9);
    assert.equal(raws.length, 2);
    const dm = raws.find((r) => r.url?.includes("jdbc:dm"));
    const pg = raws.find((r) => r.url?.includes("jdbc:postgresql"));
    assert.equal(dm?.username, "SYSDBA");
    assert.equal(pg?.username, "postgres");
    assert.ok(dm && pg); // 两个具名数据源各自成候选
  });
  it("keeps flat datasource keys unchanged", () => {
    const raws = springKeysToRaw({
      "spring.datasource.url": "jdbc:mysql://h/db",
      "spring.datasource.username": "root",
    }, "application.yml", 0.9);
    assert.equal(raws.length, 1);
    assert.equal(raws[0].username, "root");
  });
});

describe("scanProject", () => {
  it("finds mysql ready candidate with placeholder default", async () => {
    const cs = await scanProject(FIX);
    const mysql = cs.find((c) => c.dialectId === "mysql");
    assert.equal(mysql?.status, "ready");
    assert.equal(mysql?.partial.username, "root");
  });
  it("marks empty-password redis as incomplete", async () => {
    const cs = await scanProject(FIX);
    const redis = cs.find((c) => c.dialectId === "redis");
    assert.equal(redis?.status, "incomplete");
    assert.ok(redis?.missing.includes("password"));
  });
  it("rejects out-of-tree path", async () => {
    await assert.rejects(() => scanProject("/etc"), /out of scope/i);
  });
  it("marks jasypt ENC as encrypted", async () => {
    const cs = await scanProject(FIX);
    assert.ok(cs.every((c) => !(typeof c.partial.password === "string" && c.partial.password.startsWith("ENC(")) || c.status === "encrypted"));
  });
  it("parses docker-compose service into postgresql candidate", async () => {
    const cs = await scanProject(FIX);
    const pg = cs.find((c) => c.dialectId === "postgresql");
    assert.equal(pg?.status, "ready");
    assert.equal(pg?.partial.host, "postgres");
    assert.equal(pg?.partial.port, 5432);
  });
});
