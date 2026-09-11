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
  it("classifies PING/TIME as read even in writable mode（不再误判为写）", () => {
    const ping = redisDialect.isAllowed("PING", false);
    assert.equal(ping.ok, true);
    assert.equal(ping.isWrite, false);
    assert.equal(redisDialect.isAllowed("TIME", false).isWrite, false);
  });
});

// SCAN 调用形态回归锁：ioredis 的 scan 重载要求 MATCH/COUNT 固定次序、不能靠 spread 拼参，
// 而 Redis 的 SCAN 命令不区分选项顺序——此处同时锁住「调用形态」与「LIKE→通配 的转换」。
describe("redis listTables 的 SCAN 采样", () => {
  interface TableRow { name: string; type: string; description: string }
  interface ListResult { success: boolean; tables?: TableRow[] }

  async function runListTables(pattern?: string): Promise<{ calls: unknown[][]; result: ListResult }> {
    const calls: unknown[][] = [];
    const fakeClient = {
      dbsize: async () => 3,
      scan: async (...args: unknown[]) => { calls.push(args); return ["0", ["k1", "k2"]]; },
      type: async () => "string",
    };
    const patched = redisDialect as unknown as {
      withConnection: (config: unknown, fn: (conn: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    patched.withConnection = (_config, fn) => fn({ client: fakeClient });
    try {
      const result = await (redisDialect as unknown as { listTables: (c: unknown, p?: string) => Promise<ListResult> })
        .listTables({}, pattern);
      return { calls, result };
    } finally {
      // 删除实例上的覆盖，落回基类原型方法（避免污染其它用例）
      delete (patched as { withConnection?: unknown }).withConnection;
    }
  }

  it("无 pattern 时以 (cursor, COUNT, 100) 调用", async () => {
    const { calls, result } = await runListTables();
    assert.deepEqual(calls, [["0", "COUNT", 100]]);
    assert.equal(result.success, true);
    assert.equal(result.tables?.[0]?.name, "string");
    assert.equal(result.tables?.[0]?.type, "KEYSPACE");
  });

  it("有 pattern 时把 LIKE 通配转成 SCAN 通配，并按 MATCH 在前的次序调用", async () => {
    const { calls } = await runListTables("user_%");
    assert.deepEqual(calls, [["0", "MATCH", "user?*", "COUNT", 100]]);
  });
});
