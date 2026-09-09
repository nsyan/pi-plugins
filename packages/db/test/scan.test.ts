import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanProject } from "../src/core/scan/candidates.js";
import path from "node:path";

const FIX = path.join(import.meta.dirname, "fixtures", "spring-demo");

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
