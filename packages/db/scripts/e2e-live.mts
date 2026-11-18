// scripts/e2e-live.ts —— 用本机已配置的真实连接跑最新源码（不经 pi 宿主，直接驱动方言 + 策略层）
//
// 跑法：npx tsx scripts/e2e-live.mts [连接名过滤]
// 只做只读动作：测试连接 / list_tables / describe_table / SELECT。
// 另外用「只读模式」的 isAllowed 断言写语句被拦（不真的执行写）。
import { registry } from "../src/dialects/index.js";
import { loadConfigs, loadPluginConfig, toRuntimeConfig, connSummaryLine } from "../src/config.js";
import { decide, effectiveReadonly } from "../src/core/policy.js";
import { postgresqlDialect } from "../src/dialects/postgresql.js";
import { mysqlDialect } from "../src/dialects/mysql.js";

const filter = process.argv[2];
const cfg = loadPluginConfig();
const configs = loadConfigs().filter((c) => !filter || c.name.includes(filter));

if (configs.length === 0) {
  console.log("没有匹配的连接");
  process.exit(0);
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

console.log(`插件配置: ai_readonly=${cfg.ai_readonly} confirm=${cfg.confirm_before_exec} max_rows=${cfg.max_rows} timeout=${cfg.query_timeout}s\n`);

// ── 1. 读写判定矩阵（不连库，纯策略）──────────────────
console.log("── 读写判定（只读模式下是否被拦）──");
const guardCases = [
  "SELECT 1",
  "SELECT * FROM information_schema.tables LIMIT 1",
  "COPY t FROM '/tmp/x.csv'",
  "GRANT ALL ON t TO u",
  "SET default_transaction_read_only = off",
  "SELECT * FROM t FOR UPDATE",
  "EXPLAIN ANALYZE DELETE FROM t",
  "DROP TABLE t",
  "UPDATE t SET a = 1",
];
for (const sql of guardCases) {
  const v = postgresqlDialect.isAllowed(sql, true);
  const action = decide(v, true, cfg.confirm_before_exec, v.highRisk === true);
  console.log(`  ${action === "deny" ? "⛔" : action === "confirm" ? "✋" : "✅"} ${pad(action, 8)} ${sql}`);
}
console.log();

// ── 2. 真实连接：测试 + 列表 + 结构 + 查询 ──────────────
let ok = 0;
let fail = 0;

for (const config of configs) {
  const dialect = registry.get(config.type);
  const effRo = effectiveReadonly(cfg.ai_readonly, config);
  console.log(`── ${connSummaryLine(config)}  (生效只读=${effRo}) ──`);
  if (!dialect) { console.log("  ⛔ 未知方言\n"); fail++; continue; }
  const rt = toRuntimeConfig(config, dialect.defaultPort);

  // 测试连接
  const t0 = Date.now();
  const test = await dialect.testConnection(rt);
  if (!test.success) {
    console.log(`  ✗ 连接失败 (${Date.now() - t0}ms): ${String(test.error).split("\n")[0].slice(0, 160)}\n`);
    fail++;
    continue;
  }
  console.log(`  ✓ 连接 ${test.latency} · ${test.version ?? "?"}${test.warning ? ` · ⚠ ${test.warning}` : ""}`);

  // 列表
  const lt = await dialect.listTables(rt);
  if (!lt.success) {
    console.log(`  ✗ list_tables: ${String(lt.error).slice(0, 160)}`);
    fail++;
  } else {
    const names = (lt.tables ?? []).slice(0, 5).map((t) => `${t.schema ? t.schema + "." : ""}${t.name}`).join(", ");
    console.log(`  ✓ list_tables ${lt.count} 项${names ? `: ${names}${(lt.count ?? 0) > 5 ? " …" : ""}` : ""}`);
    ok++;
  }

  // 结构（取第一张表 / 第一个 key）
  const first = lt.tables?.[0];
  if (first) {
    const target = config.type === "redis" ? "missing-key-probe"
      : config.type === "neo4j" ? `rel:${first.name.replace(/^rel:/, "")}`
      : config.type === "elasticsearch" ? first.name
      : `${first.schema ? first.schema + "." : ""}${first.name}`;
    const dt = await dialect.describeTable(rt, target);
    if (dt.success) {
      console.log(`  ✓ describe_table ${target}: ${dt.count} 列`);
      ok++;
    } else {
      console.log(`  ✗ describe_table ${target}: ${String(dt.error).slice(0, 160)}`);
      fail++;
    }
  }

  // 查询：按家族给一条只读语句
  const probe =
    config.type === "redis" ? "PING"
    : config.type === "elasticsearch" ? JSON.stringify({ count: { query: { match_all: {} } } })
    : config.type === "mongodb" ? JSON.stringify({ count: first?.name ?? "users" })
    : config.type === "neo4j" ? "CALL db.labels() YIELD label RETURN label LIMIT 3"
    : config.type === "hive" || config.type === "spark" ? "SELECT 1"
    : "SELECT 1 AS n";
  const verdict = dialect.isAllowed(probe, effRo);
  if (!verdict.ok) {
    console.log(`  ⛔ 查询被策略拒绝（不应发生）: ${verdict.reason}`);
    fail++;
  } else {
    const q = await dialect.executeOn(rt, probe, { readonly: effRo, maxRows: cfg.max_rows, timeoutSec: cfg.query_timeout });
    if (q.success) {
      console.log(`  ✓ 查询 ${q.duration} · ${q.rowCount} 行 · 列 ${(q.columns ?? []).join(",").slice(0, 80)}`);
      ok++;
    } else {
      console.log(`  ✗ 查询失败: ${String(q.error).slice(0, 160)}`);
      fail++;
    }
  }

  // 写语句必须在只读/强制只读连接上被拒（不执行，只裁决）
  const writeVerdict = dialect.isAllowed(
    config.type === "redis" ? "SET probe k"
      : config.type === "mongodb" ? JSON.stringify({ insert: "probe", documents: [{}] })
      : config.type === "neo4j" ? "CREATE (n:Probe)"
      : "UPDATE probe SET a = 1",
    effRo,
  );
  if (effRo) {
    if (writeVerdict.ok) {
      console.log("  ⛔ 只读连接未拦住写语句（策略漏洞！）");
      fail++;
    } else {
      console.log(`  ✓ 只读拦截生效: ${String(writeVerdict.reason).slice(0, 90)}`);
      ok++;
    }
  }
  console.log();
}

console.log(`结果: ${ok} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
