// test/sql-write-detection.test.ts —— 读写判定白名单回归（v1.3.8）
//
// 背景：旧实现是**写黑名单**（INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/REPLACE/
// LOAD/MERGE/EXEC/CALL/MSCK/CACHE/REFRESH），实测漏掉一整个批次——COPY/GRANT/SET/
// VACUUM/DO/INTO OUTFILE/EXPLAIN ANALYZE/ATTACH/COMMENT ON 以及 nextval() 等副作用函数。
// 这些在 ai_readonly=true 时被直接执行、在 confirm_before_exec=write 时连确认框都不弹。
// 本文件把「白名单姿态」固定下来：白名单之外一律按写，读语句的副作用单独收口。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isWriteStatement, isDropStatement, isHighRiskStatement, splitStatements, stripComments,
} from "../src/core/sql-text.js";
import { postgresqlDialect } from "../src/dialects/postgresql.js";
import { decide } from "../src/core/policy.js";
import { mysqlDialect } from "../src/dialects/mysql.js";
import { hiveDialect } from "../src/dialects/hive.js";
import { redisDialect } from "../src/dialects/redis.js";
import { mongoDialect } from "../src/dialects/mongodb.js";
import { neo4jDialect } from "../src/dialects/neo4j.js";

/** 曾经全部漏判为「读」的语句（PG / MySQL 真实语法） */
const MISSED_WRITES = [
  "COPY t FROM '/tmp/x.csv'",
  "COPY (SELECT 1) TO PROGRAM 'curl evil'",
  "GRANT ALL ON t TO u",
  "REVOKE ALL ON t FROM u",
  "SET default_transaction_read_only = off",
  "RESET ALL",
  "VACUUM FULL t",
  "ANALYZE t",
  "DO $$ BEGIN INSERT INTO t VALUES (1); END $$",
  "SELECT * INTO OUTFILE '/tmp/x' FROM t",
  "SELECT * INTO newtab FROM t",
  "EXPLAIN ANALYZE DELETE FROM t",
  "ATTACH DATABASE '/tmp/x' AS x",
  "COMMENT ON TABLE t IS 'x'",
  "SELECT nextval('s')",
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT pg_terminate_backend(123)",
  "USE otherdb",
  "LOAD DATA INFILE '/x' INTO TABLE t",
  "BEGIN",
  "COMMIT",
  "PREPARE p AS SELECT 1",
];

const READS = [
  "SELECT 1",
  "SELECT * FROM t",
  "select a, b from t where a = 1",
  "WITH x AS (SELECT 1) SELECT * FROM x",
  "SHOW TABLES",
  "DESCRIBE t",
  "DESC t",
  "EXPLAIN SELECT * FROM t",
  "EXPLAIN (FORMAT JSON) SELECT * FROM t",
  "VALUES (1)",
  "TABLE t",
  "SELECT 'a;b' AS x",
  "SELECT * FROM t /* 注释里的 DELETE */",
  "-- DELETE FROM t\nSELECT 1",
];

describe("isWriteStatement（白名单姿态）", () => {
  it("曾经漏判的写语句现在全部识别为写", () => {
    for (const sql of MISSED_WRITES) {
      assert.equal(isWriteStatement(sql), true, `应判为写: ${sql}`);
    }
  });

  it("读语句不被误判（含字符串/注释里的写关键字）", () => {
    for (const sql of READS) {
      assert.equal(isWriteStatement(sql), false, `应判为读: ${sql}`);
    }
  });

  it("CTE 内夹 DML 仍按写", () => {
    assert.equal(isWriteStatement("WITH x AS (SELECT 1) DELETE FROM t"), true);
    assert.equal(isWriteStatement("WITH x AS (SELECT 1) UPDATE t SET a = 1"), true);
  });

  it("FOR UPDATE / FOR SHARE 按写（行锁是写事务意图）", () => {
    assert.equal(isWriteStatement("SELECT * FROM t FOR UPDATE"), true);
    assert.equal(isWriteStatement("SELECT * FROM t FOR NO KEY UPDATE"), true);
    assert.equal(isWriteStatement("SELECT * FROM t FOR SHARE"), true);
  });

  it("空语句不算写", () => {
    assert.equal(isWriteStatement(""), false);
    assert.equal(isWriteStatement("   \n "), false);
    assert.equal(isWriteStatement("-- 只有注释"), false);
  });
});

describe("isHighRiskStatement（never 策略不豁免的一类）", () => {
  it("DDL / 授权 / 会话设置 / 写文件 / 副作用函数为高风险", () => {
    for (const sql of [
      "CREATE TABLE x (a int)", "ALTER TABLE t ADD b int", "DROP INDEX i", "TRUNCATE t",
      "GRANT ALL ON t TO u", "SET x = 1", "COPY t FROM '/tmp/x'", "DO $$ BEGIN END $$",
      "SELECT * INTO OUTFILE '/tmp/x' FROM t", "SELECT nextval('s')",
      "WITH x AS (SELECT 1) DELETE FROM t",
    ]) {
      assert.equal(isHighRiskStatement(sql), true, `应判为高风险: ${sql}`);
    }
  });

  it("普通 DML 不算高风险（never 策略下可直执行）", () => {
    for (const sql of ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t"]) {
      assert.equal(isHighRiskStatement(sql), false, sql);
    }
  });
});

describe("isDropStatement（文档承诺口径）", () => {
  it("DROP TABLE/DATABASE/SCHEMA 恒拒", () => {
    assert.equal(isDropStatement("DROP TABLE users"), true);
    assert.equal(isDropStatement("drop database app"), true);
    assert.equal(isDropStatement("DROP SCHEMA public CASCADE"), true);
  });
  it("DROP INDEX/VIEW 不是恒拒（走确认），文档已按此口径改写", () => {
    assert.equal(isDropStatement("DROP INDEX idx"), false);
    assert.equal(isDropStatement("DROP VIEW v"), false);
  });
});

describe("dollar-quoted 块", () => {
  it("函数体内的分号不切语句", () => {
    assert.deepEqual(splitStatements("DO $$ BEGIN x; y; END $$; SELECT 1"),
      ["DO $$ BEGIN x; y; END $$", "SELECT 1"]);
  });
  it("带标签的 dollar quote", () => {
    assert.deepEqual(splitStatements("SELECT $tag$ a;b $tag$; SELECT 2"),
      ["SELECT $tag$ a;b $tag$", "SELECT 2"]);
  });
  it("函数体内的 -- 不被当注释剥掉", () => {
    const out = stripComments("SELECT $$ -- keep $$");
    assert.ok(out.includes("-- keep"), out);
  });
});

describe("方言层：只读模式真的拦得住", () => {
  it("PG/MySQL 只读模式下拒绝此前漏判的写语句", () => {
    for (const d of [postgresqlDialect, mysqlDialect]) {
      for (const sql of MISSED_WRITES) {
        const v = d.isAllowed(sql, true);
        assert.equal(v.ok, false, `${d.id} 只读模式应拒绝: ${sql}`);
        assert.equal(v.isWrite, true);
      }
    }
  });

  it("拒绝理由带上判定依据（不是裸的「非查询语句」）", () => {
    const v = postgresqlDialect.isAllowed("GRANT ALL ON t TO u", true);
    assert.match(v.reason ?? "", /GRANT/);
  });

  it("只读模式下读语句仍放行", () => {
    for (const sql of READS) {
      assert.equal(postgresqlDialect.isAllowed(sql, true).ok, true, sql);
    }
  });

  it("Hive 只读模式同样拦 COPY/GRANT 这类非白名单语句", () => {
    assert.equal(hiveDialect.isAllowed("GRANT ROLE r TO USER u", true).ok, false);
    assert.equal(hiveDialect.isAllowed("SHOW TABLES", true).ok, true);
  });

  it("highRisk 标记贯通到方言 verdict", () => {
    assert.equal(postgresqlDialect.isAllowed("CREATE TABLE x (a int)", false).highRisk, true);
    assert.equal(postgresqlDialect.isAllowed("INSERT INTO t VALUES (1)", false).highRisk, false);
    assert.equal(postgresqlDialect.isAllowed("SELECT 1", false).highRisk, false);
  });
});

describe("其他家族的 highRisk 口径", () => {
  it("Redis：DEL/RENAME/EVAL 为高风险，SET 不算", () => {
    assert.equal(redisDialect.isAllowed("DEL k", false).highRisk, true);
    assert.equal(redisDialect.isAllowed("EVAL 'return 1' 0", false).highRisk, true);
    assert.equal(redisDialect.isAllowed("SET k v", false).highRisk, false);
  });

  it("MongoDB：普通 DML 不算高风险，索引/未知命令算", () => {
    assert.equal(mongoDialect.isAllowed(JSON.stringify({ insert: "t", documents: [{}] }), false).highRisk, false);
    assert.equal(mongoDialect.isAllowed(JSON.stringify({ someUnknownCmd: 1 }), false).highRisk, true);
    assert.equal(mongoDialect.isAllowed(JSON.stringify({ aggregate: "t", pipeline: [{ $out: "b" }] }), false).highRisk, true);
  });

  it("Neo4j：CREATE/DROP 为高风险，普通 SET 不算", () => {
    assert.equal(neo4jDialect.isAllowed("CREATE (n:P)", false).highRisk, true);
    assert.equal(neo4jDialect.isAllowed("MATCH (n:P) SET n.x = 1", false).highRisk, false);
  });
});

// ── v1.3.8 自查回归：字面量剥离 ──────────────────────────
// 白名单改造时把 SELECT_SIDE_EFFECTS 的匹配面扩大了，若不在判定前剥掉字符串字面量，
// `SELECT 'FOR UPDATE' AS note`、`WHERE note = 'x INTO y'` 这类纯读会被误判成写
// （多弹确认框、只读模式下还会直接拒绝——对只读用户是不可用的功能回归）。
describe("字面量剥离：读语句不被值内容误判", () => {
  it("字面量里出现写关键字仍是读", () => {
    for (const sql of [
      "SELECT 'FOR UPDATE' AS note",
      "SELECT a FROM t WHERE note = 'FOR UPDATE'",
      "SELECT 'x INTO y' AS s",
      "SELECT REPLACE(name, 'a INTO b', '') FROM t",
      "SELECT 'nextval(' AS s",
      "SELECT 'it''s FOR UPDATE' AS x",
    ]) {
      assert.equal(isWriteStatement(sql), false, `应判为读: ${sql}`);
    }
  });

  it("真副作用不因剥离而漏判", () => {
    for (const sql of [
      "SELECT * INTO OUTFILE '/tmp/x' FROM t",
      "SELECT * INTO newtab FROM t",
      "SELECT * FROM t FOR UPDATE",
      "SELECT nextval('s')",
      "EXPLAIN ANALYZE DELETE FROM t",
      "WITH x AS (SELECT 1) DELETE FROM t",
    ]) {
      assert.equal(isWriteStatement(sql), true, `应判为写: ${sql}`);
    }
  });

  it("INSERT 值里的 INTO 不影响判定", () => {
    const v = postgresqlDialect.isAllowed("INSERT INTO t VALUES ('a INTO b')", false);
    assert.equal(v.isWrite, true);
    assert.equal(v.highRisk, false); // 普通 DML，不是「SELECT INTO 建表」
  });
});

// ── v1.3.8 真机回归：EXPLAIN ANALYZE 的 highRisk 漏判 ──────────────
// 真机测试（pi 1.3.7 + 真实 PG）抓到：EXPLAIN 在 READ_STARTERS 里，
// isHighRiskStatement 会走「读语句副作用」分支，而该分支没有 EXPLAIN ANALYZE 规则
// → highRisk=false → confirm_before_exec=never 时**直接执行** `EXPLAIN ANALYZE DELETE`。
// 只读模式（isAllowed 里的 isWriteStatement）是拦得住的，所以纯单测没暴露，
// 必须同时断言「可写 + never」这条路径。
describe("EXPLAIN ANALYZE：可写模式下也不得直执行", () => {
  const never = (sql: string) => {
    const v = postgresqlDialect.isAllowed(sql, false); // 可写模式
    return { verdict: v, action: decide(v, false, "never", v.highRisk === true) };
  };

  it("EXPLAIN ANALYZE <DML> 在 never 策略下仍要确认", () => {
    for (const sql of [
      "EXPLAIN ANALYZE DELETE FROM t",
      "EXPLAIN ANALYZE UPDATE t SET a = 1",
      "EXPLAIN ANALYZE INSERT INTO t VALUES (1)",
      "EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t",
    ]) {
      const { verdict, action } = never(sql);
      assert.equal(verdict.isWrite, true, `应判为写: ${sql}`);
      assert.equal(verdict.highRisk, true, `应判为高风险: ${sql}`);
      assert.equal(action, "confirm", `never 策略下仍须确认: ${sql}`);
    }
  });

  it("EXPLAIN <SELECT> 仍是读，never 下直执行", () => {
    for (const sql of ["EXPLAIN SELECT 1", "EXPLAIN (FORMAT JSON) SELECT * FROM t", "EXPLAIN ANALYZE SELECT 1"]) {
      const { verdict, action } = never(sql);
      assert.equal(verdict.isWrite, false, `应判为读: ${sql}`);
      assert.equal(action, "run", `读语句应直执行: ${sql}`);
    }
  });

  it("普通 DML 在 never 下仍直执行（豁免未被误扩大）", () => {
    for (const sql of ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t"]) {
      const { action } = never(sql);
      assert.equal(action, "run", `普通 DML 应直执行: ${sql}`);
    }
  });
});
