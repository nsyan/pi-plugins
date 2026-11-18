// scripts/e2e-write.mts —— 反向验证：收紧后「该能写的仍能写」
//
// 用一个临时 schema 里的临时表做完整写-读-清理，确认白名单姿态没有把合法写操作也拦掉。
// 全部动作落在 __pi_e2e__ schema 内，结束时 DROP SCHEMA 清干净（DROP TABLE/SCHEMA 走方言直连，
// 不经 query_database——工具层的 DROP 是硬限制，这是设计如此）。
import { registry } from "../src/dialects/index.ts";
import { loadConfigs, toRuntimeConfig } from "../src/config.ts";
import { decide } from "../src/core/policy.ts";

const conn = loadConfigs().find((c) => c.type === "postgresql" && c.name === "数字警员-dev-szjybj")
  ?? loadConfigs().find((c) => c.type === "postgresql")!;
const dialect = registry.get("postgresql")!;
const rt = toRuntimeConfig(conn, dialect.defaultPort);
const SCHEMA = "__pi_e2e__";

const run = (sql: string, readonly = false) =>
  dialect.executeOn(rt, sql, { readonly, maxRows: 20, timeoutSec: 30 });

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); fail++; }
};

console.log(`目标: ${conn.name} (${conn.host}:${conn.port}/${conn.database})\n`);

// 0. 清理可能残留
await run(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);

// 1. DDL：CREATE SCHEMA / CREATE TABLE 必须被判为高风险写但允许执行
console.log("── DDL ──");
for (const sql of [`CREATE SCHEMA ${SCHEMA}`, `CREATE TABLE ${SCHEMA}.t (id serial primary key, name text, n int)`]) {
  const v = dialect.isAllowed(sql, false);
  check(v.isWrite === true && v.highRisk === true, `${pad("高风险写标记", 16)} ${sql.slice(0, 56)}`);
  const r = await run(sql);
  check(r.success, `${pad("执行成功", 16)} ${sql.slice(0, 56)}`, r.error);
}

// 2. DML：INSERT / UPDATE / SELECT / DELETE 全链路
console.log("\n── DML ──");
const dml: Array<[string, boolean]> = [
  [`INSERT INTO ${SCHEMA}.t (name, n) VALUES ('a', 1), ('b', 2), ('c', 3)`, true],
  [`UPDATE ${SCHEMA}.t SET n = n * 10 WHERE name <> 'b'`, true],
  [`SELECT id, name, n FROM ${SCHEMA}.t ORDER BY id`, false],
  [`DELETE FROM ${SCHEMA}.t WHERE name = 'c'`, true],
  [`SELECT count(*) AS left_rows FROM ${SCHEMA}.t`, false],
];
for (const [sql, expectWrite] of dml) {
  const v = dialect.isAllowed(sql, false);
  check(v.isWrite === expectWrite, `${pad(expectWrite ? "判为写" : "判为读", 8)} ${sql.slice(0, 64)}`);
  check(v.highRisk === false, `${pad("非高风险", 8)} ${sql.slice(0, 64)}`);
  const r = await run(sql);
  check(r.success, `${pad("执行成功", 8)} ${sql.slice(0, 64)}`, r.error);
  if (!r.success) continue;
  if (expectWrite) console.log(`         → 影响 ${r.rowCount} 行 (${r.duration})`);
  else console.log(`         → ${r.rowCount} 行: ${JSON.stringify(r.rows?.[0] ?? [])} (${r.duration})`);
}

// 3. 只读模式：同一批写语句必须被拒
console.log("\n── 只读模式复核（同一批写语句）──");
for (const sql of [
  `INSERT INTO ${SCHEMA}.t (name) VALUES ('z')`,
  `UPDATE ${SCHEMA}.t SET n = 0`,
  `DELETE FROM ${SCHEMA}.t`,
  `TRUNCATE ${SCHEMA}.t`,
  `ALTER TABLE ${SCHEMA}.t ADD COLUMN extra int`,
]) {
  const v = dialect.isAllowed(sql, true);
  const action = decide(v, true, "write", v.highRisk === true);
  check(action === "deny", `${pad(action, 5)} ${sql.slice(0, 70)}`, v.reason);
}

// 4. 事务控制：BEGIN/COMMIT 现在按写处理（此前漏判），确认不会被只读模式放过
console.log("\n── 事务控制语句判定 ──");
for (const sql of ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT sp1"]) {
  const v = dialect.isAllowed(sql, true);
  check(v.ok === false, `${pad("只读拒绝", 8)} ${sql}`);
}

// 5. 清理（DROP SCHEMA 在工具层是硬限制，这里走方言直连演示清理路径）
console.log("\n── 清理 ──");
const cleanup = await run(`DROP SCHEMA ${SCHEMA} CASCADE`);
check(cleanup.success, `DROP SCHEMA ${SCHEMA} CASCADE`, cleanup.error);
check(dialect.isAllowed(`DROP SCHEMA ${SCHEMA} CASCADE`, false).ok === false,
  "同一语句经 isAllowed 被硬限制拒绝（工具层不可执行，清理须走运维通道）");

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
