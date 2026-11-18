// scripts/e2e-tools.mts —— 工具层 e2e：用 mock 的 pi 宿主装载 index.ts，直接调 query_database 等工具
//
// 验证三件只有走工具层才看得到的行为：
//   ① 只读/强制只读连接上，写语句被拒且**不执行**（新白名单姿态的收益）
//   ② 写语句缺 reason 被拒
//   ③ 生产连接的写操作**先写审计再执行**（fail-closed 顺序），普通连接按开关
//
// 安全性：所有写语句的目标表都不存在（`__pi_e2e_probe__`），即使真的下发也只会报
// relation does not exist，不会改动任何数据。临时连接写盘后立刻恢复原配置。
import { copyFileSync, existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CONFIG = join(process.env.HOME ?? "", ".pi", "agent", "db-configs.json");
const AUDIT_DIR = join(process.env.HOME ?? "", ".pi", "agent", "db-audit");

if (!existsSync(CONFIG)) {
  console.log("没有 db-configs.json，跳过");
  process.exit(0);
}

const backupDir = mkdtempSync(join(tmpdir(), "pi-e2e-"));
const backup = join(backupDir, "db-configs.json");
copyFileSync(CONFIG, backup);

const originals = JSON.parse(readFileSync(CONFIG, "utf-8")) as Array<Record<string, unknown>>;
const base = originals.find((c) => c.type === "postgresql")!;
if (!base) { console.log("没有 PG 连接可用于 e2e"); process.exit(0); }

// 临时连接：同一个真实库，但强制只读 / 标 prod
const roConn = { ...base, id: randomUUID(), name: "__e2e_ro", forceReadonly: true, isDefault: false, envTag: undefined, createdAt: new Date().toISOString() };
const prodConn = { ...base, id: randomUUID(), name: "__e2e_prod", forceReadonly: false, isDefault: false, envTag: "prod", createdAt: new Date().toISOString() };
const plainConn = { ...base, id: randomUUID(), name: "__e2e_plain", forceReadonly: false, isDefault: false, envTag: undefined, createdAt: new Date().toISOString() };

writeFileSync(CONFIG, JSON.stringify([...originals, roConn, prodConn, plainConn], null, 2));

// ── mock 宿主 ──────────────────────────────────────
type Tool = { name: string; execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any> };
const tools = new Map<string, Tool>();
const pi = {
  registerTool(t: Tool) { tools.set(t.name, t); },
  registerCommand() {},
  on() {},
};

const notifications: string[] = [];
function makeCtx(confirmAnswer = false) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      async confirm(_t: string, msg: string) { notifications.push(`[confirm] ${msg.slice(0, 120)}`); return confirmAnswer; },
      async notify(msg: string, kind?: string) { notifications.push(`[${kind ?? "info"}] ${msg}`); },
      async select() { return undefined; },
      async input() { return undefined; },
      async editor() { return undefined; },
    },
  };
}

const { default: dbExtension } = await import("../index.ts");
dbExtension(pi as any);

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

let pass = 0, fail = 0;
function check(cond: boolean, label: string, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); fail++; }
}

function auditLineCount(): number {
  try {
    return readFileSync(join(AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8")
      .split("\n").filter(Boolean).length;
  } catch { return 0; }
}

try {
  const q = tools.get("query_database")!;
  check(!!q, "query_database 已注册");

  console.log("\n── ① 强制只读连接：写语句必须被拒且不执行 ──");
  for (const sql of [
    "UPDATE __pi_e2e_probe__ SET a = 1",
    "COPY __pi_e2e_probe__ FROM '/tmp/x.csv'",
    "GRANT ALL ON __pi_e2e_probe__ TO public",
    "SET default_transaction_read_only = off",
    "SELECT * FROM __pi_e2e_probe__ FOR UPDATE",
    "DO $$ BEGIN DELETE FROM __pi_e2e_probe__; END $$",
    "EXPLAIN ANALYZE DELETE FROM __pi_e2e_probe__",
    "VACUUM FULL __pi_e2e_probe__",
  ]) {
    const r = await q.execute("t", { database: "__e2e_ro", sql }, undefined, undefined, makeCtx());
    const out = text(r);
    const denied = /只读|不允许|拒绝/.test(out);
    check(denied, `拒绝 ${pad(sql.slice(0, 52), 54)} → ${out.split("\n")[0].slice(0, 70)}`);
  }

  console.log("\n── ② 只读连接：读语句照常放行 ──");
  const readRes = await q.execute("t", { database: "__e2e_ro", sql: "SELECT 1 AS n" }, undefined, undefined, makeCtx());
  check(/查询完成/.test(text(readRes)), `SELECT 1 放行 → ${text(readRes).split("\n")[0]}`);

  console.log("\n── ③ 写语句缺 reason 被拒（可写连接）──");
  const noReason = await q.execute("t", { database: "__e2e_plain", sql: "UPDATE __pi_e2e_probe__ SET a = 1" }, undefined, undefined, makeCtx());
  check(/必须附执行理由/.test(text(noReason)), `缺 reason → ${text(noReason).slice(0, 80)}`);

  console.log("\n── ④ 生产连接：审计先落盘再执行（fail-closed）──");
  const before = auditLineCount();
  const prodWrite = await q.execute("t", {
    database: "__e2e_prod",
    sql: "UPDATE __pi_e2e_probe__ SET a = 1",
    reason: "e2e 探针：目标表不存在，验证审计先于执行落盘，不影响任何数据",
  }, undefined, undefined, makeCtx(true));
  const after = auditLineCount();
  const prodOut = text(prodWrite);
  check(after === before + 1, `审计新增 1 行（${before} → ${after}）`, prodOut.slice(0, 200));
  const lastLine = readFileSync(join(AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8").trim().split("\n").pop()!;
  const rec = JSON.parse(lastLine);
  check(rec.connection === "__e2e_prod", `审计记录 connection=${rec.connection}`);
  check(/UPDATE __pi_e2e_probe__/.test(rec.sql), "审计记录完整 SQL");
  check(/目标表不存在/.test(rec.reason), "审计记录理由全文");
  check(/查询失败/.test(prodOut), `写真的下发了（表不存在 → 报错），不是被静默跳过 → ${prodOut.split("\n")[0]}`);

  console.log("\n── ⑤ 普通连接：审计默认关闭 ──");
  const plainBefore = auditLineCount();
  await q.execute("t", {
    database: "__e2e_plain",
    sql: "UPDATE __pi_e2e_probe__ SET a = 1",
    reason: "e2e 探针：普通连接，审计默认关闭",
  }, undefined, undefined, makeCtx(true));
  check(auditLineCount() === plainBefore, `普通连接未新增审计（${plainBefore} → ${auditLineCount()}）`);

  console.log("\n── ⑥ 其余工具可用 ──");
  const lt = await tools.get("list_tables")!.execute("t", { database: "__e2e_ro", pattern: "act_%" }, undefined, undefined, makeCtx());
  check(/共 \d+ 张表/.test(text(lt)), `list_tables → ${text(lt).split("\n")[0]}`);
  const dt = await tools.get("describe_table")!.execute("t", { database: "__e2e_ro", table: "public.act_evt_log" }, undefined, undefined, makeCtx());
  check(/共 \d+ 列/.test(text(dt)), `describe_table → ${text(dt).split("\n")[1] ?? ""}`);
  const conns = await tools.get("db_connections")!.execute("t", {}, undefined, undefined, makeCtx());
  check(/共 \d+ 个连接/.test(text(conns)), `db_connections → ${text(conns).split("\n")[0]}`);
} finally {
  copyFileSync(backup, CONFIG);
  rmSync(backupDir, { recursive: true, force: true });
  console.log(`\n配置已恢复（临时连接 __e2e_* 已移除）`);
}

console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
