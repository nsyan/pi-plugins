// test/redis.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitCommand } from "../src/dialects/kv-dialect.js";
import { redisDialect } from "../src/dialects/redis.js";

describe("splitCommand", () => {
  it("splits with quoted args", () => {
    assert.deepEqual(splitCommand(`SET mykey "hello world"`), ["SET", "mykey", "hello world"]);
  });
});

describe("redis isAllowed", () => {
  it("allows GET in readonly", () => {
    assert.equal(redisDialect.isAllowed("GET foo", true).ok, true);
  });
  it("denies SET in readonly", () => {
    assert.equal(redisDialect.isAllowed("SET foo 1", true).ok, false);
  });
  it("always denies FLUSHALL even when writable", () => {
    const v = redisDialect.isAllowed("FLUSHALL", false);
    assert.equal(v.ok, false);
  });
  it("marks SET as write when writable", () => {
    const v = redisDialect.isAllowed("SET foo 1", false);
    assert.equal(v.ok, true);
    assert.equal(v.isWrite, true);
  });
  it("denies CONFIG/SHUTDOWN regardless of mode", () => {
    assert.equal(redisDialect.isAllowed("CONFIG GET maxmemory", false).ok, false);
    assert.equal(redisDialect.isAllowed("SHUTDOWN", false).ok, false);
  });
});
