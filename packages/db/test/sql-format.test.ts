import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSql, formatSqlForDisplay, displayLangFor } from "../src/core/sql-format.js";
import { registry } from "../src/dialects/index.js";

describe("formatSql（确认框展示用美化）", () => {
  it("UPDATE 单行拆成子句 + 赋值列", () => {
    assert.equal(
      formatSql("UPDATE users SET status=2, updated_at=now() WHERE id=1 AND deleted=false"),
      [
        "UPDATE users",
        "SET status = 2,",
        "  updated_at = now()",
        "WHERE id = 1",
        "  AND deleted = FALSE",
      ].join("\n"),
    );
  });

  it("SELECT/JOIN/ORDER BY 全链路换行，关键字统一大写", () => {
    assert.equal(
      formatSql(
        "select id, name, count(*) from users u left join logs l on l.uid=u.id where u.age>=18 and u.name like '%a%' group by id, name order by id desc limit 10",
      ),
      [
        "SELECT id,",
        "  name,",
        "  count(*)",
        "FROM users u",
        "LEFT JOIN logs l",
        "  ON l.uid = u.id",
        "WHERE u.age >= 18",
        "  AND u.name LIKE '%a%'",
        "GROUP BY id,",
        "  name",
        "ORDER BY id DESC",
        "LIMIT 10",
      ].join("\n"),
    );
  });

  it("子查询：内部子句缩进，收尾括号单独成行", () => {
    assert.equal(
      formatSql("SELECT * FROM (SELECT a FROM b WHERE c=1) t WHERE d=2"),
      [
        "SELECT *",
        "FROM (",
        "  SELECT a",
        "  FROM b",
        "  WHERE c = 1",
        ") t",
        "WHERE d = 2",
      ].join("\n"),
    );
  });

  it("多语句之间留空行", () => {
    assert.equal(
      formatSql("UPDATE a SET x=1; DELETE FROM b WHERE y=2"),
      ["UPDATE a", "SET x = 1;", "", "DELETE FROM b", "WHERE y = 2"].join("\n"),
    );
  });

  it("字符串字面量内的逗号/关键字原样保留", () => {
    const out = formatSql("update users set note='a, b AND c' where id=1");
    assert.ok(out.includes("'a, b AND c'"), out);
    assert.ok(out.includes("SET note = 'a, b AND c'"), out);
  });

  it("行注释保留且不影响后续子句换行", () => {
    const out = formatSql("UPDATE users SET note='x' -- trailing\nWHERE id=1");
    assert.ok(out.includes("SET note = 'x' -- trailing"), out);
    assert.ok(out.includes("\nWHERE id = 1"), out);
  });

  it("幂等：二次美化结果不变", () => {
    const once = formatSql("select a, b from t where x=1 and y=2");
    assert.equal(formatSql(once), once);
  });

  it("空串/纯空白返回空", () => {
    assert.equal(formatSql("   "), "");
  });

  it("长括号组（CREATE TABLE 列定义）拆成块状列表，短括号组保持内联", () => {
    assert.equal(
      formatSql("CREATE TABLE t (id BIGINT NOT NULL, name VARCHAR(50) NOT NULL, age INT DEFAULT 0, PRIMARY KEY (id))"),
      [
        "CREATE TABLE t (",
        "  id BIGINT NOT NULL,",
        "  name VARCHAR(50) NOT NULL,",
        "  age INT DEFAULT 0,",
        "  PRIMARY KEY (id)",
        ")",
      ].join("\n"),
    );
    // 短括号组不拆：count(*) 与 IN (1, 2, 3) 保持内联
    const short = formatSql("SELECT count(*) FROM t WHERE a IN (1,2,3)");
    assert.ok(short.includes("count(*)"), short);
    assert.ok(short.includes("IN (1, 2, 3)"), short);
  });

  it("ON DUPLICATE KEY UPDATE / FOR UPDATE / VALUES(col) 不误判为新语句头", () => {
    assert.equal(
      formatSql("INSERT INTO t (a,b) VALUES (1,2) ON DUPLICATE KEY UPDATE a=VALUES(a), b=2"),
      ["INSERT INTO t (a, b)", "VALUES (1, 2)", "  ON DUPLICATE KEY UPDATE a = VALUES(a),", "  b = 2"].join("\n"),
    );
    assert.ok(formatSql("SELECT * FROM t WHERE x=1 FOR UPDATE").endsWith("WHERE x = 1 FOR UPDATE"));
  });
});

describe("displayLangFor（高亮语言映射）", () => {
  it("关系型/大数据/图为 sql，文档/搜索为 json，Redis 无语言", () => {
    assert.equal(displayLangFor("postgresql"), "sql");
    assert.equal(displayLangFor("mysql"), "sql");
    assert.equal(displayLangFor("oracle"), "sql");
    assert.equal(displayLangFor("dm"), "sql");
    assert.equal(displayLangFor("hive"), "sql");
    assert.equal(displayLangFor("spark"), "sql");
    assert.equal(displayLangFor("neo4j"), "sql");
    assert.equal(displayLangFor("mongodb"), "json");
    assert.equal(displayLangFor("elasticsearch"), "json");
    assert.equal(displayLangFor("redis"), undefined);
  });

  it("覆盖注册表中全部方言（新增方言漏映射即失败）", () => {
    for (const id of registry.keys()) {
      assert.ok(["sql", "json", undefined].includes(displayLangFor(id)), `${id} 返回了未预期的高亮语言`);
    }
    // 十种方言里只有 Redis 命令语法与 SQL/JSON 都不同源，允许走代码块配色
    assert.equal([...registry.keys()].filter((id) => displayLangFor(id) === undefined).join(","), "redis");
  });
});

describe("formatSqlForDisplay", () => {
  it("MongoDB JSON 信封按 2 空格缩进", () => {
    assert.equal(
      formatSqlForDisplay('{"find":"users","filter":{"a":1}}', "mongodb"),
      '{\n  "find": "users",\n  "filter": {\n    "a": 1\n  }\n}',
    );
  });

  it("Elasticsearch DSL 同样按 JSON 处理", () => {
    assert.equal(formatSqlForDisplay('{"query":{"match_all":{}}}', "elasticsearch"), '{\n  "query": {\n    "match_all": {}\n  }\n}');
  });

  it("非法 JSON 原样返回（宁可不好看也不显示错）", () => {
    assert.equal(formatSqlForDisplay("{oops", "mongodb"), "{oops");
  });

  it("关系型走 SQL 美化", () => {
    assert.equal(formatSqlForDisplay("select 1 from t where a=1", "mysql"), ["SELECT 1", "FROM t", "WHERE a = 1"].join("\n"));
  });

  it("空串返回空", () => {
    assert.equal(formatSqlForDisplay("   ", "postgresql"), "");
  });
});
