// test/neo4j.test.ts —— Neo4j 方言：Cypher 读写分类器 + URL 解析（无网络，纯单测）
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyStatement, classifyCypher, cellOf } from "../src/dialects/graph-dialect.js";
import { parseNeo4jUrl } from "../src/dialects/neo4j.js";

const read = (s: string) => assert.equal(classifyStatement(s).isWrite, false, s);
const write = (s: string) => assert.equal(classifyStatement(s).isWrite, true, s);
const denied = (s: string) => assert.equal(classifyStatement(s).ok, false, s);

describe("neo4j classifier", () => {
  it("reads: MATCH/RETURN/WITH/UNWIND/SHOW/CALL whitelisted", () => {
    read("MATCH (n:Person) RETURN n LIMIT 10");
    read("OPTIONAL MATCH (n:Person)-[r:KNOWS]->(m) WHERE n.age > 18 RETURN n, r, m");
    read("MATCH (n) WITH n.name AS name, count(*) AS c RETURN name, c ORDER BY c DESC");
    read("UNWIND [1,2,3] AS x RETURN x");
    read("SHOW INDEXES");
    read("SHOW CONSTRAINTS YIELD name, type RETURN *");
    read("CALL db.labels() YIELD label RETURN label");
    read("CALL db.schema.visualization()");
    read("CALL db.labels() YIELD label CALL { MATCH (n) RETURN count(n) AS c } RETURN label, c");
    read("RETURN 1");
    read("MATCH (n) WHERE n.desc = 'please delete me' RETURN n"); // 字符串内的写词不误判
    read("MATCH (n) RETURN n.create, n.remove");                  // 属性名写词不误判
    read("MATCH (n:`Create`) RETURN n");                          // 反引号标识符不误判
    read("-- CREATE comment\nMATCH (n) RETURN n");                // 注释内写词不误判
  });

  it("writes: any-depth write keywords", () => {
    write("CREATE (n:Person {name: 'x'})");
    write("MERGE (n:Person {id: 1}) ON CREATE SET n.c = 1");
    write("MATCH (n:Person {id: 1}) SET n.age = 20");
    write("MATCH (n:Person {id: 1}) DETACH DELETE n");
    write("MATCH (n) DELETE n");
    write("MATCH (n) REMOVE n.age");
    write("DROP INDEX my_index");
    write("MATCH (n) FOREACH (_ IN range(1,3) | CREATE (m:Tmp)) RETURN n");
    write("LOAD CSV WITH HEADERS FROM 'file:///a.csv' AS row MERGE (n:P {id: row.id})");
    write("CREATE INDEX FOR (n:Person) ON (n.id)");
    write("CALL { MATCH (n) DETACH DELETE n }");  // CALL {} 子查询写
    write("CALL apoc.meta.data() YIELD x RETURN x"); // 未知过程保守按写
    write("MATCH (n) CALL { WITH n CREATE (m:Tmp) } RETURN n"); // 读外壳夹写子查询
    write("SHOW TRANSACTIONS YIELD transactionId CALL { CREATE (n) }"); // 写词优先于 SHOW
  });

  it("denies: dbms.* management procedures", () => {
    denied("CALL dbms.shutdown()");
    denied("CALL dbms.security.createUser('x', 'y')");
    denied("CALL dbms.setConfig('x', 'y')");
  });

  it("multi-statement: any write or deny propagates", () => {
    const v = classifyCypher("MATCH (n) RETURN n; CREATE (m:X)");
    assert.equal(v.isWrite, true);
    assert.equal(classifyCypher("MATCH (n) RETURN n; CALL dbms.shutdown()").ok, false);
    assert.equal(classifyCypher("MATCH (n) RETURN n LIMIT 1; MATCH (m) RETURN m").isWrite, false);
    assert.equal(classifyCypher("   ").ok, false);
  });

  it("string literal with semicolon is not split", () => {
    const v = classifyCypher("MATCH (n) WHERE n.a = 'x;y' RETURN n");
    assert.equal(v.isWrite, false);
  });
});

describe("neo4j cellOf", () => {
  it("converts Integer / Node / Relationship / Path", () => {
    assert.equal(cellOf({ __isInteger__: true, toString: () => "42" }), 42);
    assert.equal(cellOf({ __isInteger__: true, toString: () => "90071992547409937" }), "90071992547409937");
    assert.deepEqual(cellOf({ labels: ["Person", "Employee"], properties: { name: "x" } }), ":Person:Employee {\"name\":\"x\"}");
    assert.equal(cellOf({ type: "KNOWS", startNodeElementId: "4:a", properties: { since: 2020 } }), "-(KNOWS)-> {\"since\":2020}");
    assert.equal(cellOf({ segments: [1, 2, 3] }), "<path:3>");
    assert.equal(cellOf(new Date("2024-01-01T00:00:00Z")), "2024-01-01T00:00:00.000Z");
    assert.equal(cellOf(null), null);
  });
});

describe("neo4j parseUrl", () => {
  it("parses bolt:// and neo4j:// forms", () => {
    assert.deepEqual(
      parseNeo4jUrl("neo4j://user:p%40ss@10.0.0.1:17474/mydb"),
      { host: "10.0.0.1", port: 17474, username: "user", password: "p@ss", database: "mydb", ssl: false },
    );
    const bolt = parseNeo4jUrl("bolt://10.0.0.1:7687")!;
    assert.equal(bolt.port, 7687);
    assert.equal(bolt.database, undefined);
    assert.equal(parseNeo4jUrl("neo4j+s://host:7687")?.ssl, true);
    assert.equal(parseNeo4jUrl("bolt+ssc://host")?.ssl, true);
    // 集群多主机 seed list 原样保留
    const cluster = parseNeo4jUrl("neo4j://h1:7687,h2:7687,h3:7687/db1")!;
    assert.equal(cluster.host, "h1:7687,h2:7687,h3:7687");
    // IPv6 字面量不拆端口（与 mongodb.ts 同款：整体保留，建连/展示侧不再追加端口）
    assert.equal(parseNeo4jUrl("bolt://[::1]:7687")!.host, "[::1]:7687");
    // 非 Neo4j URL 不认领
    assert.equal(parseNeo4jUrl("postgresql://host:5432/db"), null);
    assert.equal(parseNeo4jUrl("http://host:9200"), null);
  });
});
