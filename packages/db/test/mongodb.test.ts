// test/mongodb.test.ts —— MongoDB 方言纯单测（无真实实例；isAllowed 分类矩阵 / parseUrl 双形态 / limit 注入 / 拍平）
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mongoDialect } from "../src/dialects/mongodb.js";
import { classifyEnvelope, injectLimits, flattenDocs, hasAnyKey, MAX_QUERY_COLUMNS } from "../src/dialects/document-dialect.js";
import { registry } from "../src/dialects/index.js";

const env = (o: unknown): string => JSON.stringify(o);

describe("mongo parseUrl", () => {
  it("标准 URI：账号/密码/库/authSource", () => {
    const p = mongoDialect.parseUrl("mongodb://user:pass@localhost:27017/mydb?authSource=admin&replicaSet=rs0")!;
    assert.equal(p.host, "localhost");
    assert.equal(p.port, 27017);
    assert.equal(p.username, "user");
    assert.equal(p.password, "pass");
    assert.equal(p.database, "mydb");
    assert.equal(p.options?.authSource, "admin");
    assert.equal(p.options?.replicaSet, "rs0");
    assert.equal(p.options?.srv, undefined);
  });

  it("无端口缺省 27017，无库为 undefined", () => {
    const p = mongoDialect.parseUrl("mongodb://mongo.internal/mydb")!;
    assert.equal(p.host, "mongo.internal");
    assert.equal(p.port, 27017);
    assert.equal(p.database, "mydb");
  });

  it("SRV URI：options.srv 标记 + 默认 tls", () => {
    const p = mongoDialect.parseUrl("mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true")!;
    assert.equal(p.host, "cluster0.abc.mongodb.net");
    assert.equal(p.port, 27017);
    assert.equal(p.options?.srv, "true");
    assert.equal(p.options?.tls, "true");
    assert.equal(p.options?.retryWrites, "true");
  });

  it("多主机 seed list 原样保留", () => {
    const p = mongoDialect.parseUrl("mongodb://h1:27017,h2:27018/?replicaSet=rs0")!;
    assert.equal(p.host, "h1:27017,h2:27018");
    assert.equal(p.options?.replicaSet, "rs0");
  });

  it("URL 编码密码解码", () => {
    const p = mongoDialect.parseUrl("mongodb://user:p%40ss%3Aword@h/db")!;
    assert.equal(p.password, "p@ss:word");
  });

  it("非 mongo URL 返回 null", () => {
    assert.equal(mongoDialect.parseUrl("redis://localhost:6379"), null);
    assert.equal(mongoDialect.parseUrl("jdbc:postgresql://h/db"), null);
  });
});

describe("mongo isAllowed / classifyEnvelope", () => {
  it("读命令 readonly 放行", () => {
    for (const body of [
      { find: "users", filter: {} },
      { count: "users" },
      { distinct: "users", key: "age" },
      { aggregate: "users", pipeline: [{ $match: {} }] },
      { collStats: "users" },
      { dbStats: 1 },
      { listCollections: 1 },
      { listIndexes: "users" },
    ]) {
      const v = mongoDialect.isAllowed(env(body), true);
      assert.equal(v.ok, true, `应放行: ${env(body)} → ${v.reason}`);
      assert.equal(v.isWrite, false);
    }
  });

  it("写命令 readonly 拒绝、writable 放行且标记 isWrite", () => {
    for (const body of [
      { insert: "users", documents: [{ a: 1 }] },
      { update: "users", updates: [{ q: {}, u: { $set: { a: 1 } } }] },
      { delete: "users", deletes: [{ q: {}, limit: 1 }] },
      { findAndModify: "users", update: { $set: { a: 1 } } },
    ]) {
      assert.equal(mongoDialect.isAllowed(env(body), true).ok, false, env(body));
      const v = mongoDialect.isAllowed(env(body), false);
      assert.equal(v.ok, true, env(body));
      assert.equal(v.isWrite, true);
    }
  });

  it("未知命令保守按写处理", () => {
    assert.equal(mongoDialect.isAllowed(env({ setParameter: 1 }), true).ok, false);
    assert.equal(mongoDialect.isAllowed(env({ someUnknown: 1 }), false).isWrite, true);
  });

  it("管理/DDL 恒拒（连 writable 也拒）", () => {
    for (const body of [
      { dropDatabase: 1 },
      { drop: "users" },
      { createIndexes: "users", indexes: [] },
      { create: "users" },
      { createUser: { user: "x", pwd: "y", roles: [] } },
      { dropIndexes: "users", index: "*" },
      { eval: "db.users.drop()" },
      { $eval: "x" },
      { applyOps: [] },
      { shutdown: 1 },
      { renameCollection: "a.b" },
      { shardCollection: "a.b" },
    ]) {
      const v = mongoDialect.isAllowed(env(body), false);
      assert.equal(v.ok, false, `应恒拒: ${env(body)}`);
    }
  });

  it("aggregate 含 $out/$merge → 按写分类", () => {
    const v1 = mongoDialect.isAllowed(env({ aggregate: "a", pipeline: [{ $match: {} }, { $out: "b" }] }), false);
    assert.equal(v1.isWrite, true);
    const v2 = mongoDialect.isAllowed(env({ aggregate: "a", pipeline: [{ $merge: { into: "b" } }] }), true);
    assert.equal(v2.ok, false); // readonly 下拒绝
  });

  it("服务端 JS（$where/$function/$accumulator）恒拒，任意深度", () => {
    for (const body of [
      { find: "users", filter: { $where: "this.a > 1" } },
      { aggregate: "users", pipeline: [{ $match: { $expr: { $function: { body: "true", args: [], lang: "js" } } } }] },
      { aggregate: "users", pipeline: [{ $group: { _id: null, n: { $accumulator: { init: "1", accumulate: "1", accumulateArgs: [], merge: "1", lang: "js" } } } }] },
    ]) {
      const v = mongoDialect.isAllowed(env(body), false); // writable 也拒
      assert.equal(v.ok, false, `应恒拒 JS: ${env(body)}`);
    }
  });

  it("非 JSON / 数组 / null 信封拒绝", () => {
    assert.equal(mongoDialect.isAllowed("db.users.find()", true).ok, false);
    assert.equal(mongoDialect.isAllowed("find users; drop users", true).ok, false);
    assert.equal(mongoDialect.isAllowed(env([1, 2]), true).ok, false);
    assert.equal(mongoDialect.isAllowed("null", true).ok, false);
  });

  it("summary 携带命令名与集合名", () => {
    const v = classifyEnvelope(env({ find: "users", filter: {} })).verdict;
    assert.equal(v.summary, "find users");
  });
});

describe("mongo injectLimits", () => {
  it("find 无 limit → 补 maxRows + batchSize", () => {
    const e: Record<string, unknown> = { find: "users", filter: {} };
    injectLimits(e, 100);
    assert.equal(e.limit, 100);
    assert.equal(e.batchSize, 100);
  });

  it("find 用户 limit 超 maxRows → 收敛到 maxRows", () => {
    const e: Record<string, unknown> = { find: "users", limit: 5000 };
    injectLimits(e, 100);
    assert.equal(e.limit, 100);
  });

  it("aggregate 末尾无 $limit → 追加 $limit 阶段 + cursor.batchSize", () => {
    const e: Record<string, unknown> = { aggregate: "users", pipeline: [{ $match: {} }, { $sort: { a: 1 } }] };
    injectLimits(e, 50);
    assert.equal((e.pipeline as unknown[]).length, 3);
    assert.deepEqual((e.pipeline as unknown[])[2], { $limit: 50 });
    assert.equal((e.cursor as Record<string, unknown>).batchSize, 50);
  });

  it("aggregate 末尾已是 $count → 不追加", () => {
    const e: Record<string, unknown> = { aggregate: "users", pipeline: [{ $count: "n" }] };
    injectLimits(e, 50);
    assert.equal((e.pipeline as unknown[]).length, 1);
  });

  it("find limit 0/负数（Mongo 语义=不限）→ 收敛到 maxRows 而非 1", () => {
    const e0: Record<string, unknown> = { find: "users", limit: 0 };
    injectLimits(e0, 100);
    assert.equal(e0.limit, 100);
    const eN: Record<string, unknown> = { find: "users", limit: -5 };
    injectLimits(eN, 100);
    assert.equal(eN.limit, 100);
  });

  it("写命令文档数组封顶 MAX_BULK_DOCS", () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({ i }));
    const e: Record<string, unknown> = { insert: "users", documents: big };
    injectLimits(e, 100);
    assert.equal((e.documents as unknown[]).length, 1000);
  });
});

describe("mongo flattenDocs", () => {
  it("顶层字段并集，首现顺序；缺失补 null；嵌套 JSON 字符串", () => {
    const { columns, rows } = flattenDocs([
      { _id: "a", name: "x", meta: { tags: [1, 2] } },
      { _id: "b", extra: true }, // name/meta 缺失
    ], 100);
    assert.deepEqual(columns, ["_id", "name", "meta", "extra"]);
    assert.equal(rows[0][0], "a");
    assert.equal(rows[0][1], "x");
    assert.equal(rows[0][2], JSON.stringify({ tags: [1, 2] }));
    assert.equal(rows[1][1], null);
    assert.equal(rows[1][3], true);
  });

  it("列数封顶 MAX_QUERY_COLUMNS", () => {
    const doc: Record<string, number> = {};
    for (let i = 0; i < MAX_QUERY_COLUMNS + 30; i++) doc[`f${i}`] = i;
    const { columns, rows } = flattenDocs([doc], 100);
    assert.equal(columns.length, MAX_QUERY_COLUMNS);
    assert.equal(rows[0].length, MAX_QUERY_COLUMNS);
  });

  it("超过 maxRows → truncated 标记", () => {
    const docs = [{ i: 1 }, { i: 2 }, { i: 3 }];
    const r = flattenDocs(docs, 2);
    assert.equal(r.rowCount, 2);
    assert.equal(r.truncated, true);
  });

  it("恰好等于 maxRows 也标 truncated（对齐 bigdata 方言语义）", () => {
    const docs = [{ i: 1 }, { i: 2 }];
    assert.equal(flattenDocs(docs, 2).truncated, true);
    assert.equal(flattenDocs([{ i: 1 }], 2).truncated, false);
  });

  it("Binary/UUID 形态（_bsontype + toJSON）取 toJSON 字符串而非 [object Object]", () => {
    const uuid = { _bsontype: "Binary", toJSON: () => "c68fbe10-3b4f-4c0a-8f2d-9a1b2c3d4e5f" };
    const { rows } = flattenDocs([{ uid: uuid }], 10);
    assert.equal(rows[0][0], "c68fbe10-3b4f-4c0a-8f2d-9a1b2c3d4e5f");
    const weird = { _bsontype: "Weird", toJSON: () => ({ x: 1 }) };
    const r2 = flattenDocs([{ w: weird }], 10);
    assert.equal(r2.rows[0][0], JSON.stringify(weird));
  });

  it("ObjectId 形态（toHexString）取 hex 而非带引号 JSON", () => {
    const oid = { toHexString: () => "64b000000000000000000000" };
    const { rows } = flattenDocs([{ _id: oid }], 10);
    assert.equal(rows[0][0], "64b000000000000000000000");
  });
});

describe("mongo registry", () => {
  it("注册为 document 家族", () => {
    assert.equal(registry.get("mongodb")?.family, "document");
    assert.equal(registry.get("mongodb")?.label, "MongoDB");
  });
});

describe("mongo scan 路由（Fix 3 回归）", () => {
  it("带 query 的 mongo URL 原样解析（authSource 不丢）", () => {
    const p = mongoDialect.parseUrl("mongodb://u:p@h1:27017/db?authSource=admin&replicaSet=rs0")!;
    assert.equal(p.options?.authSource, "admin");
    assert.equal(p.options?.replicaSet, "rs0");
  });

  it("buildUri 对 IPv6 字面量不重复补端口", () => {
    // 经 displayUrl 侧面验证 hostPart 判定（含 ] 不追加端口）
    const url = mongoDialect.displayUrl({
      id: "x", name: "x", type: "mongodb", host: "[::1]:27017", port: 27017,
      createdAt: "",
    } as never);
    assert.equal(url, "mongodb://[::1]:27017");
  });
});

describe("mongo hasAnyKey", () => {
  it("数组与嵌套对象内的 key 均可命中", () => {
    assert.equal(hasAnyKey({ a: [{ b: { $where: "x" } }] }, new Set(["$where"])), true);
    assert.equal(hasAnyKey({ a: { b: 1 } }, new Set(["$where"])), false);
    assert.equal(hasAnyKey("scalar", new Set(["$where"])), false);
  });
});
