# db 方言化重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `packages/db` 从 PG/MySQL/Oracle 硬编码重构为四家族 Dialect 架构，修复 DROP/只读绕过漏洞，新增 DM/Redis/ES/Hive/Spark 支持，并交付 `/db scan` 与 P0 体验项。

**Architecture:** `src/core/` 放纯逻辑（sql-text、policy、scan、config），`src/dialects/` 放 Dialect 接口 + 4 个家族基类 + 8 个方言，`index.ts` 只保留 pi 接线（工具注册、命令、提示注入）。所有内部 import 沿用现有 `.js` 后缀约定。

**Tech Stack:** Node v22.19.0, pnpm 10.16.1, TypeScript（pi 自带加载，无需 tsc）, 测试 `tsx --test` + `node:test` + `node:assert/strict`, 驱动：pg / mysql2 / oracledb / dmdb / ioredis / @elastic/elasticsearch v8+v7 / hive-driver。

**Spec:** `docs/superpowers/specs/2026-09-09-db-dialect-redesign-design.md` — 计划中的每个验收点都可回溯到 Spec 章节；执行者开工前必读 Spec §2.0（类型清单）、§3（接口）、§6（策略流程）。

## Global Constraints

- `src/core/` 与 `src/dialects/` 除 `import type` 外不得 import 任何 pi 运行时模块（B 验收：`grep -rn "from ['\"]@earendil\|require(.*pi" src/core src/dialects | grep -v "import type"` 结果为空）。
- 内部 import 一律用 `.js` 后缀（现有约定，pi 与 tsx 均可解析）。
- 所有方言失败返回 `{ success: false, error }`，不抛异常穿透工具层。
- 写盘类操作（建连/覆盖/删除）必须经用户确认；密码只走 TUI，不进模型上下文。
- `scan_project_configs(path?)` 的 path 强制约束在 cwd 子树内，越界直接拒绝。
- 每轮 `before_agent_start` 注入每连接只一行（名称[家族] + 一行语义）。
- 版本范围写入 README；`testConnection` 必须返回服务端版本号。

---

## File Structure

| 文件 | 职责 | 任务 |
|------|------|------|
| `src/core/types.ts` | DbTypeId/DbFamily/ConnConfig/ParsedTarget/DbConnection/ExecOpts/Candidate（照抄 Spec §2.0） | Task 2 |
| `src/core/sql-text.ts` | stripComments / splitStatements / isWriteStatement / isDropStatement | Task 1 |
| `src/core/whitelist.ts` | 命令白名单匹配（KV/搜索共用） | Task 6 |
| `src/core/policy.ts` | decide(verdict, readonly, confirm) → run/confirm/deny（见 Task 5 签名） | Task 5 |
| `src/config.ts` | loadConfigs/saveConfigs/loadPluginConfig + mtime 内存缓存 | Task 5 |
| `src/core/index.ts` | core 聚合 re-export（package.json exports "./core" 的入口） | Task 5 |
| `src/core/export.ts` | toCsv / toJsonFile 纯函数（查询结果导出） | Task 11 |
| `src/dialects/dialect.ts` | Dialect 接口 + fingerprints + registry（约定式聚合） | Task 2 |
| `src/dialects/relational-dialect.ts` | 关系型基类：逐语句检查、执行、格式化 | Task 3 |
| `src/dialects/postgresql.ts, mysql.ts, oracle.ts` | 现有三库迁入（连接参数+元数据 SQL+版本查询） | Task 4 |
| `src/dialects/kv-dialect.ts, redis.ts` | 命令解析、白名单、keyspace/key 详情 | Task 6 |
| `src/dialects/search-dialect.ts, elasticsearch.ts` | DSL 解析、端点白名单、双客户端分发 | Task 7 |
| `src/dialects/bigdata-dialect.ts, hive.ts, spark.ts` | HS2 连接、batch 拉取、取消 operation | Task 8 |
| `src/dialects/dm.ts` | DM 连接参数 + 数据字典 SQL | Task 9 |
| `src/core/scan/*.ts` | walker/parsers/spring/placeholders/scoring/candidates | Task 10 |
| `src/ui/*` | 从 index.ts 拆出的菜单/表单/scan 向导（Task 11 统一拆分；Task 5 只改菜单执行路径、不拆文件） | Task 11 |
| `index.ts` | 工具注册（verdict 流程）、命令（含 scan）、提示注入 | Task 5, 10, 11 |
| `test/**/*.test.ts` | 与 src 一一对应的单测 | 各任务内 |

---

### Task 0: 环境准备（测试跑道 + 依赖安装）

**Files:**
- Modify: `packages/db/package.json`
- Create: `packages/db/test/smoke.test.ts`

**Interfaces:**
- Consumes: 现有 `src/db.ts`（冒烟用，不改）
- Produces: `pnpm --filter db test` 可运行；后续所有任务的测试命令统一为它

- [ ] **Step 1: 安装依赖并引入 tsx（先删 npm 产物 lock 文件）**

```bash
cd /Users/sny/01_work/02_code/39_pi/pi-extensions/packages/db && rm -f package-lock.json && pnpm install && pnpm add -D tsx
```

Expected: `node_modules/` 生成，`tsx` 在 devDependencies。

- [ ] **Step 2: package.json 加 test 脚本**

```json
"scripts": {
  "test": "tsx --test \"test/**/*.test.ts\""
}
```

- [ ] **Step 3: 写冒烟测试（验证跑道 + 现有纯函数可测）**

```ts
// test/smoke.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWriteSql, isDropTable } from "../src/db.js";

describe("smoke: existing pure functions", () => {
  it("isWriteSql identifies INSERT", () => {
    assert.equal(isWriteSql("INSERT INTO t VALUES (1)"), true);
  });
  it("isWriteSql passes SELECT", () => {
    assert.equal(isWriteSql("SELECT * FROM t"), false);
  });
  it("isDropTable identifies DROP TABLE", () => {
    assert.equal(isDropTable("DROP TABLE users"), true);
  });
});
```

- [ ] **Step 4: 运行冒烟测试**

Run: `pnpm --filter db test`
Expected: PASS（3/3）。若 `isWriteSql` 等签名与假设不符，以 `src/db.ts` 实际导出为准修正 import。

- [ ] **Step 5: git 初始化（目录尚无版本控制时执行）**

```bash
cd /Users/sny/01_work/02_code/39_pi/pi-extensions && git rev-parse || git init
```

---

### Task 1: sql-text.ts（A 阶段核心：注释剥离 + 语句拆分 + 逐语句检查）

**Files:**
- Create: `packages/db/src/core/sql-text.ts`
- Test: `packages/db/test/sql-text.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `stripComments(sql: string): string`、`splitStatements(sql: string): string[]`、`isWriteStatement(stmt: string): boolean`、`isDropStatement(stmt: string): boolean` — Task 3 的 RelationalDialect 直接使用

- [ ] **Step 1: 写 failing test（注释剥离 + 双写转义 + 注释内分号）**

```ts
// test/sql-text.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripComments, splitStatements, isWriteStatement, isDropStatement } from "../src/core/sql-text.js";

describe("stripComments", () => {
  it("removes line comments but keeps string content", () => {
    assert.equal(stripComments("SELECT 1 -- hello\nFROM t"), "SELECT 1 \nFROM t");
    assert.equal(stripComments("SELECT '-- not a comment'"), "SELECT '-- not a comment'");
  });
  it("removes block comments", () => {
    assert.equal(stripComments("SELECT /* x */ 1"), "SELECT  1");
  });
});

describe("splitStatements", () => {
  it("handles doubled-quote escape", () => {
    assert.deepEqual(splitStatements("SELECT 'it''s'; SELECT 2"), ["SELECT 'it''s'", "SELECT 2"]);
  });
  it("ignores semicolons inside comments", () => {
    assert.deepEqual(splitStatements("SELECT 1 -- a;b\n; SELECT 2"), ["SELECT 1", "SELECT 2"]);
  });
});

describe("write/drop detection", () => {
  it("catches second-statement DROP (existing bypass)", () => {
    const stmts = splitStatements("SELECT 1; DROP TABLE users;");
    assert.equal(stmts.some(isDropStatement), true);
  });
  it("catches CTE-DML", () => {
    assert.equal(isWriteStatement("WITH t AS (SELECT 1) DELETE FROM users"), true);
  });
  it("catches SELECT FOR UPDATE", () => {
    assert.equal(isWriteStatement("SELECT * FROM t FOR UPDATE"), true);
  });
  it("catches commented-out DELETE prefix", () => {
    assert.equal(isWriteStatement("/* c */ DELETE FROM t"), true);
  });
  it("passes plain SELECT", () => {
    assert.equal(isWriteStatement("SELECT * FROM t"), false);
    assert.equal(isDropStatement("SELECT * FROM t"), false);
  });
  it("conservative: DML keyword inside CTE string literal counts as write", () => {
    // 有意保守：不剥离字符串字面量，偏安全方向（Spec §4.1）
    assert.equal(isWriteStatement("WITH t AS (SELECT 'DELETE FROM x') SELECT * FROM t"), true);
  });
  it("MySQL backslash escape does not hide DROP", () => {
    const stmts = splitStatements("SELECT 'a\\'; DROP TABLE t");
    assert.equal(stmts.some(isDropStatement), true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter db test`
Expected: FAIL with "Cannot find module '../src/core/sql-text.js'"。

- [ ] **Step 3: 最小实现**

```ts
// src/core/sql-text.ts
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let q: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (q) {
      out += ch;
      if (ch === q) {
        if (sql[i + 1] === q) { out += sql[i + 1]; i += 2; continue; } // '' 转义
        q = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; out += ch; i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

export function splitStatements(sql: string): string[] {
  // 注：先 stripComments 再切分——注释文本不进入语句，注释内分号自然消失；
  // 这里只处理字符串字面量（含 '' 双写转义）内的分号
  const clean = stripComments(sql);
  const stmts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const nx = clean[i + 1];
    if (q) {
      cur += ch;
      if (ch === q) {
        if (nx === q) { cur += nx; i++; continue; }
        q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; cur += ch; continue; }
    if (ch === ";") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|LOAD|MERGE|EXEC|EXECUTE|CALL|MSCK|CACHE|REFRESH)\b/i;
const WITH_DML_RE = /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE|MERGE)\b/i;
const FOR_UPDATE_RE = /\bFOR\s+UPDATE\b/i;
const DROP_TABLE_RE = /^\s*DROP\s+(TABLE|DATABASE)\b/i;

export function isWriteStatement(stmt: string): boolean {
  const clean = stripComments(stmt);
  return WRITE_RE.test(clean) || WITH_DML_RE.test(clean) || FOR_UPDATE_RE.test(clean);
}

export function isDropStatement(stmt: string): boolean {
  return DROP_TABLE_RE.test(stripComments(stmt));
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS（含冒烟共 12+ 用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/core/sql-text.ts packages/db/test/sql-text.test.ts packages/db/package.json
git commit -m "feat: add sql-text with comment stripping and per-statement checks"
```

---

### Task 2: types.ts + Dialect 接口 + registry（B 阶段地基）

**Files:**
- Create: `packages/db/src/core/types.ts`, `packages/db/src/dialects/dialect.ts`, `packages/db/src/dialects/index.ts`
- Test: `packages/db/test/registry.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `DbTypeId/DbFamily/ConnConfig/ParsedTarget/DbConnection/ExecOpts/Candidate`（照抄 Spec §2.0，一字不差）；`Dialect` 接口（照抄 Spec §3，含 `withConnection/executeOn/isAllowed→{ok,reason,isWrite,summary}/listTables(config,pattern?)`）；`registry: Map<DbTypeId, Dialect>` + `register(d)` + `fingerprints` 字段

- [ ] **Step 1: 写 failing test（registry 注册与查找）**

```ts
// test/registry.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry, register, type Dialect } from "../src/dialects/index.js";

const fake: Dialect = {
  id: "postgresql", label: "PostgreSQL", family: "relational", defaultPort: 5432,
  fingerprints: { urlPatterns: [/^jdbc:postgresql:\/\//], configKeys: ["spring.datasource.url"] },
  parseUrl: () => null,
  withConnection: async (_c, _fn) => { throw new Error("nope"); },
  testConnection: async () => ({ success: false, error: "nope" }),
  isAllowed: () => ({ ok: true }),
  executeOn: async () => ({ success: false, error: "nope" }),
  listTables: async () => ({ success: false, error: "nope" }),
  describeTable: async () => ({ success: false, error: "nope" }),
  displayUrl: () => "",
  versionQuery: async () => "",
};

describe("registry", () => {
  it("registers and resolves a dialect", () => {
    register(fake);
    assert.equal(registry.get("postgresql")?.label, "PostgreSQL");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter db test -- --test-name-pattern="registry"`
Expected: FAIL with "Cannot find module"。

- [ ] **Step 3: 写 types.ts（照抄 Spec §2.0）+ dialect.ts + index.ts**

```ts
// src/core/types.ts — 照抄 Spec §2.0 代码块，一字不差（含 database 家族语义注释）
```

```ts
// src/dialects/dialect.ts
import type { ConnConfig, ParsedTarget, DbConnection, ExecOpts, DbTypeId, DbFamily,
  QueryResult, ListTablesResult, DescribeTableResult, TestConnectionResult } from "../core/types.js";

export interface Fingerprints { urlPatterns: RegExp[]; configKeys: string[]; }
export interface Verdict { ok: boolean; reason?: string; isWrite?: boolean; summary?: string; }

export interface Dialect {
  id: DbTypeId;
  label: string;
  family: DbFamily;
  defaultPort: number;
  fingerprints: Fingerprints;
  parseUrl(url: string): ParsedTarget | null;
  withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs?: number): Promise<T>;
  testConnection(config: ConnConfig): Promise<TestConnectionResult>;
  isAllowed(sql: string, readonly: boolean): Verdict;
  executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult>;
  listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult>;
  describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult>;
  displayUrl(config: ConnConfig): string;
  versionQuery(conn: DbConnection): Promise<string>;
}

export const registry = new Map<DbTypeId, Dialect>();
export function register(d: Dialect): void { registry.set(d.id, d); }
```

```ts
// src/dialects/index.ts —— 聚合各方言（新增方言时加一行 re-export；
// 方言文件自带 register() 副作用，遗漏聚合行时 registry 规模断言失败）
export { registry, register } from "./dialect.js";
export type { Dialect, Verdict, Fingerprints } from "./dialect.js";
// export { postgresqlDialect } from "./postgresql.js";  // Task 4 起逐个追加
```

`QueryResult/ListTablesResult/DescribeTableResult/TestConnectionResult/TableInfo/ColumnInfo` 从现有 `src/db.ts` 原样搬入 `core/types.ts`（字段不变）。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/core/types.ts packages/db/src/dialects/ packages/db/test/registry.test.ts
git commit -m "feat: add core types, Dialect interface and registry"
```

---

### Task 3: RelationalDialect 基类（A 收尾 + B 核心）

**Files:**
- Create: `packages/db/src/dialects/relational-dialect.ts`
- Test: `packages/db/test/relational.test.ts`

**Interfaces:**
- Consumes: Task 1（sql-text）、Task 2（types/dialect）
- Produces: `RelationalDialect` 抽象基类（实现 `withConnection/isAllowed/executeOn` 通用逻辑，留 `doConnect/doExecute/metaSql` 抽象点）；供 Task 4 三方言继承

- [ ] **Step 1: 写 failing test（逐语句 verdict + summary）**

```ts
// test/relational.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelationalDialect } from "../src/dialects/relational-dialect.js";

class Stub extends RelationalDialect {
  id = "postgresql" as const; label = "PostgreSQL"; family = "relational" as const; defaultPort = 5432;
  fingerprints = { urlPatterns: [/^jdbc:postgresql:\/\//], configKeys: [] as string[] };
  parseUrl = () => null; displayUrl = () => "";
  protected async doConnect() { throw new Error("no conn in unit test"); }
  protected async doExecute() { throw new Error("no conn in unit test"); }
  async versionQuery() { return ""; }
  async listTables() { return { success: false as const, error: "nope" }; }
  async describeTable() { return { success: false as const, error: "nope" }; }
}

describe("RelationalDialect.isAllowed", () => {
  const d = new Stub();
  it("blocks DROP in second statement even when readonly off", () => {
    const v = d.isAllowed("SELECT 1; DROP TABLE users;", false);
    assert.equal(v.ok, false);
  });
  it("blocks CTE-DML in readonly mode", () => {
    const v = d.isAllowed("WITH t AS (SELECT 1) DELETE FROM users", true);
    assert.equal(v.ok, false);
  });
  it("allows SELECT and reports isWrite=false with summary", () => {
    const v = d.isAllowed("SELECT a FROM users", true);
    assert.equal(v.ok, true);
    assert.equal(v.isWrite, false);
    assert.match(v.summary ?? "", /SELECT/i);
  });
  it("marks INSERT as write in non-readonly mode", () => {
    const v = d.isAllowed("INSERT INTO t VALUES (1)", false);
    assert.equal(v.ok, true);
    assert.equal(v.isWrite, true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL with "Cannot find module"。

- [ ] **Step 3: 最小实现**

```ts
// src/dialects/relational-dialect.ts
import type { ConnConfig, DbConnection, ExecOpts, ParsedTarget } from "../core/types.js";
import type { QueryResult } from "../core/types.js";
import { splitStatements, isWriteStatement, isDropStatement } from "../core/sql-text.js";
import type { Dialect, Verdict, Fingerprints } from "./dialect.js";

export abstract class RelationalDialect implements Dialect {
  abstract id: Dialect["id"];
  abstract label: string;
  abstract family: Dialect["family"];
  abstract defaultPort: number;
  abstract fingerprints: Fingerprints;
  abstract parseUrl(url: string): ParsedTarget | null;
  abstract displayUrl(config: ConnConfig): string;
  abstract versionQuery(conn: DbConnection): Promise<string>;
  protected abstract doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection>;
  // 注：doExecute 直接收驱动 client（unknown），各方言内部收窄为私有连接类型
  protected abstract doExecute(client: unknown, stmt: string, opts: ExecOpts): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }>;

  async withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs = 10_000): Promise<T> {
    const conn = await this.doConnect(config, timeoutMs);
    try { return await fn(conn); }
    finally { await conn.close(); }
  }

  // testConnection 复用 withConnection（连接泄漏防护）；versionQuery 由各方言实现

  isAllowed(sql: string, readonly: boolean): Verdict {
    const stmts = splitStatements(sql);
    if (stmts.length === 0) return { ok: false, reason: "SQL 语句为空" };
    for (const s of stmts) {
      if (isDropStatement(s)) {
        return { ok: false, reason: `禁止执行 DROP 操作：${s.slice(0, 80)}`, summary: `DROP（硬限制）: ${s.slice(0, 60)}` };
      }
    }
    const first = stmts[0];
    const kind = /^\s*(\w+)/.exec(first)?.[1]?.toUpperCase() ?? "SQL";
    const targets = [...first.matchAll(/\b(?:FROM|INTO|UPDATE|TABLE)\s+([A-Za-z0-9_."]+)/gi)].map((m) => m[1]).slice(0, 3).join(", ");
    const summary = `${kind}${targets ? " " + targets : ""}（共 ${stmts.length} 条语句）`;
    if (readonly) {
      for (const s of stmts) {
        if (isWriteStatement(s)) {
          return { ok: false, reason: `只读模式下不允许执行非查询语句：${s.slice(0, 80)}`, isWrite: true, summary };
        }
      }
    }
    const isWrite = stmts.some(isWriteStatement);
    return { ok: true, isWrite, summary };
  }

  async executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult> {
    const start = Date.now();
    const stmts = splitStatements(sql);
    try {
      let last = { columns: [] as string[], rows: [] as unknown[][], rowCount: 0 };
      await this.withConnection(config, async (conn) => {
        for (const s of stmts) last = await this.doExecute(conn.client, s, opts);
      }, opts.timeoutSec * 1000);
      return { success: true, ...last, duration: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), duration: `${Date.now() - start}ms` };
    }
  }

  async testConnection(config: ConnConfig): Promise<import("../core/types.js").TestConnectionResult> {
    const start = Date.now();
    try {
      const version = await this.withConnection(config, (conn) => this.versionQuery(conn));
      return { success: true, version, latency: `${Date.now() - start}ms` };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err), latency: `${Date.now() - start}ms` };
    }
  }
  abstract listTables(config: ConnConfig, pattern?: string): Promise<import("../core/types.js").ListTablesResult>;
  abstract describeTable(config: ConnConfig, target: string): Promise<import("../core/types.js").DescribeTableResult>;
}
```

注：`client: unknown` 是有意为之——基类不感知各驱动类型，各方言在 doExecute 内部收窄为私有连接类型。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/dialects/relational-dialect.ts packages/db/test/relational.test.ts
git commit -m "feat: add RelationalDialect base with per-statement verdict"
```

---

### Task 4: 迁移 PG/MySQL/Oracle 三方言（B 收尾旧逻辑搬家）

**Files:**
- Create: `packages/db/src/dialects/postgresql.ts`, `mysql.ts`, `oracle.ts`
- Modify: `packages/db/src/dialects/index.ts`（追加三方言注册）
- Test: `packages/db/test/dialects-relational.test.ts`（parseUrl + displayUrl 纯函数）

**Interfaces:**
- Consumes: Task 3（RelationalDialect）
- Produces: `postgresqlDialect/mysqlDialect/oracleDialect` 已注册；`doConnect/doExecute/listTables/describeTable/testConnection` 逻辑与现有 `src/db.ts` 行为一致

- [ ] **Step 1: 写 failing test（URL 解析 + display 掩码）**

```ts
// test/dialects-relational.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registry } from "../src/dialects/index.js";
import "../src/dialects/postgresql.js";
import "../src/dialects/mysql.js";
import "../src/dialects/oracle.js";

describe("relational dialects registered", () => {
  it("parses postgres JDBC url", () => {
    const d = registry.get("postgresql")!;
    assert.deepEqual(d.parseUrl("jdbc:postgresql://h:5432/mydb"),
      { host: "h", port: 5432, database: "mydb" });
  });
  it("parses mysql JDBC url with default port", () => {
    const d = registry.get("mysql")!;
    assert.deepEqual(d.parseUrl("jdbc:mysql://h/mydb"),
      { host: "h", port: 3306, database: "mydb" });
  });
  it("parses oracle service url", () => {
    const d = registry.get("oracle")!;
    const p = d.parseUrl("jdbc:oracle:thin:@//h:1521/svc");
    assert.equal(p?.host, "h");
    assert.equal(p?.port, 1521);
    assert.equal(p?.database, "svc");
  });
  it("parses native postgres URI with credentials (Spec §7 双形态)", () => {
    const d = registry.get("postgresql")!;
    assert.deepEqual(d.parseUrl("postgresql://u:p@h:5432/mydb"),
      { host: "h", port: 5432, username: "u", password: "p", database: "mydb" });
  });
  it("displayUrl omits password", () => {
    const d = registry.get("postgresql")!;
    const shown = d.displayUrl({ id: "x", name: "n", type: "postgresql", host: "h", port: 5432, username: "u", password: "secret", database: "db", createdAt: "" });
    assert.ok(!shown.includes("secret"));
  });
  it("registry size is exactly 3 after migration (Spec §9 规模断言)", () => {
    assert.equal(registry.size, 3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现（从 `src/db.ts` 搬运，不改行为）**
  - `doConnect`：照搬 `_connect` 内对应 case（含 pg.Client / mysql.createConnection / oracledb.getConnection 参数）。
  - `doExecute`：照搬 `executeWithTimeout` 对应分支（PG `SET statement_timeout`、MySQL `SET max_execution_time` + ≥5.7.8 失败忽略、Oracle `maxRows/fetchArraySize/timeout`）。
  - `listTables/describeTable/testConnection`：照搬现有 SQL 与字段映射，原样保留（`pattern?` 参数本任务先透传忽略，G 任务实现过滤）。
  - `versionQuery`：PG `SELECT version()` 取逗号前、MySQL `SELECT version()`、Oracle `SELECT version FROM v$instance`。
  - `parseUrl/displayUrl`：从 `index.ts` 现有 `parseJdbcUrl/reconstructJdbcUrl` 搬对应分支（含 Oracle SID 形式），并扩展兼收原生 URI（`postgresql://u:p@h/db`、`mysql://u:p@h/db`）——与 Task 11 一键连接串共用同一解析入口（Spec §7）。
  - 每个文件末尾 `register(xxxDialect)`；`dialects/index.ts` 追加三行 re-export。
  - `src/db.ts` 本任务不动（删除是 Task 5 收尾的事）。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/dialects/postgresql.ts packages/db/src/dialects/mysql.ts packages/db/src/dialects/oracle.ts packages/db/src/dialects/index.ts packages/db/test/dialects-relational.test.ts
git commit -m "feat: migrate pg/mysql/oracle to dialect classes"
```

---

### Task 5: policy.ts + config.ts + index.ts 接线（B 落地 + 效率项）

**Files:**
- Create: `packages/db/src/core/policy.ts`, `packages/db/src/config.ts`
- Modify: `packages/db/index.ts`（工具走 verdict 流程、提示注入一行一连接、mtime 缓存经 config.ts）
- Test: `packages/db/test/policy.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4（registry + isAllowed verdict）
- Produces: `decide(verdict, readonly, confirm)` → `"run" | "confirm" | "deny"`；config 读写与旧文件兼容；工具 `database` 参数仍必填（可选化是 Task 11）

- [ ] **Step 1: 写 failing test（确认策略矩阵）**

```ts
// test/policy.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/core/policy.js";

describe("decide", () => {
  it("denies when verdict not ok", () => {
    assert.equal(decide({ ok: false, reason: "x" }, true, "write"), "deny");
  });
  it("runs read directly under write-confirm", () => {
    assert.equal(decide({ ok: true, isWrite: false }, true, "write"), "run");
  });
  it("confirms write under write-confirm", () => {
    assert.equal(decide({ ok: true, isWrite: true }, false, "write"), "confirm");
  });
  it("confirms everything under always", () => {
    assert.equal(decide({ ok: true, isWrite: false }, true, "always"), "confirm");
  });
  it("runs everything under never (except denied)", () => {
    assert.equal(decide({ ok: true, isWrite: true }, false, "never"), "run");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 policy.ts + config.ts + index.ts 接线**

```ts
// src/core/policy.ts
import type { Verdict } from "../dialects/dialect.js";
export type ConfirmMode = "never" | "write" | "always";
export function decide(verdict: Verdict, _readonly: boolean, confirm: ConfirmMode): "run" | "confirm" | "deny" {
  if (!verdict.ok) return "deny";
  if (confirm === "always") return "confirm";
  if (confirm === "write" && verdict.isWrite) return "confirm";
  return "run";
}
```

`src/config.ts`：搬 `index.ts` 的 loadConfigs/saveConfigs/loadPluginConfig/savePluginConfig（含 LEGACY 兼容），加 mtime 内存缓存：

```ts
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
// 注：必须用 Map 按文件名 key——单槽缓存在 db-configs.json 与 db-config.json 交替读时永不命中
const caches = new Map<string, { mtime: number; data: unknown }>();
function readJsonCached<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const mtime = statSync(file).mtimeMs;
  const hit = caches.get(file);
  if (hit && hit.mtime === mtime) return hit.data as T;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as T;
    caches.set(file, { mtime, data });
    return data;
  } catch { return fallback; }
}
export function invalidateConfigCache(file?: string): void {
  if (file) caches.delete(file); else caches.clear();
}
// saveConfigs/savePluginConfig 写盘后调用 invalidateConfigCache(对应文件名)
```

`index.ts` 接线（四改；**含菜单执行路径迁移**——旧 `query()`/`toConnConfig()` 删除后，菜单的
“执行查询/列出表/详情”必须同步改走 registry + policy，否则运行时 ReferenceError）：
1. `query_database` execute：`verdict = registry.get(config.type)!.isAllowed(sql, cfg.ai_readonly)` → `decide(...)` → deny 直接返回 reason；confirm 走现有 `ctx.ui.confirm`（verdict.summary 置顶，原文附后；**保留 `ctx?.hasUI` 检查**——无 UI 环境直接取消并返回文案，Spec §6）；run 走 `dialect.executeOn`。
2. 菜单执行路径迁移：`/db` 菜单内“执行查询/列出表/查看详情”三处改走 `registry.get(type)` +
   `decide`（deny 时向用户展示 reason 文案）；函数签名不变，UI 流程不动。
   （行为变更声明：菜单路径此前不弹确认框、可绕过确认策略，本次修复为与工具一致——有意为之。）
3. `buildDbListHint`：每连接一行 `名称[家族] - label，一行语义`（Redis/ES/Hive/Spark 行由后
续任务的 dialect.label 提供，本任务三库先行）。
4. 删除 `index.ts` 内已搬走的 parseJdbcUrl/reconstructJdbcUrl/config 读写函数，改从新模块 import；删除旧 `query/listTables/describeTable/isWriteSql/isDropTable` 的 import（改走 registry）；**`DbConfig` 与 `toConnConfig` 一并删除**——`ConnConfig` 已合并存储态字段（Spec §2.0 配置类型裁决），配置数组直接用 `ConnConfig[]`；`loadConfigs` 读取旧文件时把历史字段 `extraParams` 并入 `options`（兼容迁移）。
5. `src/db.ts` 删除（逻辑已全部迁入方言）；`package.json` 加 `exports`：`{ ".": "./index.ts", "./core": "./src/core/index.ts", "./dialects": "./src/dialects/index.ts" }` 并补 `src/core/index.ts` / 确认 `src/dialects/index.ts` 可被外部 import。
注：`src/ui/` 文件拆分不在本任务做，统一划归 Task 11（本任务只改执行路径、不拆文件）。

- [ ] **Step 4: 运行测试 + 回归冒烟**

Run: `pnpm --filter db test`
Expected: PASS。注意 Task 0 的 smoke.test.ts 仍 import `../src/db.js`——本步同步改为从新模块 import（`isWriteStatement/isDropStatement`），保持绿色。

Run: `grep -rn "from ['\"]@earendil\|require(.*pi" src/core src/dialects | grep -v "import type"`
Expected: 空输出（B 验收）。

- [ ] **Step 5: 手工回归 `/db` 菜单（在 pi 里跑一次 add/ls/查询），然后 Commit**

```bash
git add -A && git commit -m "feat: wire policy layer and rewire index.ts to dialects"
```

---

### Task 6: Redis（D 阶段：KvDialect + redis 方言）

**Files:**
- Create: `packages/db/src/dialects/kv-dialect.ts`, `packages/db/src/dialects/redis.ts`
- Modify: `packages/db/package.json`（+ `ioredis`）、`packages/db/src/dialects/index.ts`
- Test: `packages/db/test/redis.test.ts`

**Interfaces:**
- Consumes: Task 2（Dialect/whitelist 位置）、Task 5（policy/verdict）
- Produces: `KvDialect`（命令切分、白名单判定、FLUSHALL 恒拒）+ `redisDialect`（连接、keyspace、key 详情）；`core/whitelist.ts` 的 `matchCommand(cmd, list)` 被 kv-dialect 使用

- [ ] **Step 1: 写 failing test（白名单 + 硬限制 + 切分）**

```ts
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
```

- [ ] **Step 2: 运行确认失败；Step 3: 实现**
  - `core/whitelist.ts`：`matchCommand(cmd: string, list: string[]): boolean`（首词大写精确匹配）。
  - `kv-dialect.ts`：`splitCommand`（空白+双引号切分）；基类实现 `isAllowed`（白名单∈READ_CMDS→ok；FLUSHALL/FLUSHDB/CONFIG/SHUTDOWN/SLAVEOF/REPLICAOF/DEBUG→恒拒；其余读外命令→readonly 下拒/非 readonly 下 isWrite=true 放行）；`executeOn` 经 `sendCommand`，集合结果截断 maxRows。
  - `redis.ts`：`parseUrl` 解析 `redis(s)://[:password@]host:port[/db]`→ParsedTarget（含 dbIndex/ssl）；`withConnection` 用 ioredis（`lazyConnect` + `select(dbIndex)`）；`listTables`→DBSIZE+SCAN 采样≤200 key 统计类型（附“无表，用 SCAN”文案）；`describeTable(key)`→TYPE+长度命令+TTL+MEMORY USAGE（≥4.0 失败跳过）+OBJECT ENCODING+值预览截断。
  - `package.json` 加 `ioredis` 依赖并 `pnpm install`。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS（无真实 Redis 也全绿；集成测试标记 `describe.skip` 留待有环境时开）。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/dialects/kv-dialect.ts packages/db/src/dialects/redis.ts packages/db/src/core/whitelist.ts packages/db/test/redis.test.ts packages/db/package.json
git commit -m "feat: add Redis dialect with command whitelist"
```

---

### Task 7: Elasticsearch（E 阶段：SearchDialect + 双客户端）

**Files:**
- Create: `packages/db/src/dialects/search-dialect.ts`, `packages/db/src/dialects/elasticsearch.ts`
- Modify: `packages/db/package.json`（+ `@elastic/elasticsearch` + 别名 `es7`，安装命令：
  `pnpm add @elastic/elasticsearch && pnpm add es7@npm:@elastic/elasticsearch@7`）、`dialects/index.ts`
- Test: `packages/db/test/elasticsearch.test.ts`

**Interfaces:**
- Consumes: Task 2/5；`ConnConfig.database` = 默认 index（Spec §2.0）
- Produces: `SearchDialect`（DSL 解析、端点白名单、`DELETE index` 恒拒）+ `esDialect`（`GET /` 探测→v7/v8 分发、`warning` 版本警告）

- [ ] **Step 1: 写 failing test**

```ts
// test/elasticsearch.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { esDialect, pickMajor } from "../src/dialects/elasticsearch.js";

describe("pickMajor", () => {
  it("parses 7.17.0 -> 7", () => assert.equal(pickMajor("7.17.0"), 7));
  it("parses 8.12.1 -> 8", () => assert.equal(pickMajor("8.12.1"), 8));
});

describe("es isAllowed", () => {
  it("allows search DSL in readonly", () => {
    assert.equal(esDialect.isAllowed(JSON.stringify({ query: { match_all: {} } }), true).ok, true);
  });
  it("denies _bulk in readonly", () => {
    assert.equal(esDialect.isAllowed(JSON.stringify({ bulk: [] }), true).ok, false);
  });
  it("always denies index deletion", () => {
    assert.equal(esDialect.isAllowed("DELETE my-index", false).ok, false);
  });
});
```

DSL 信封约定（实现端点白名单判断依据）：JSON 顶层 key 映射端点——`query/count`→_search/_count（读），`mget/mget_docs`→_mget（读），`bulk/doc_write/delete/update/mapping/settings`→写；`DELETE <index>` 纯字符串形式恒拒；其余纯字符串走 `query_string` 简化搜索。

- [ ] **Step 2: 运行确认失败；Step 3: 实现**
  - `search-dialect.ts`：`parseDsl`（JSON.parse 失败→纯字符串分支）；`isAllowed` 按上表；`summary` 形如 `SEARCH index（query/match）`。
  - `elasticsearch.ts`：`testConnection` 先无版本请求 `GET /` 取 `version.number`→`pickMajor`→7 用 `es7` 包客户端、8 用 v8 包；未知大版本用 v8 尝试 + 版本警告（`TestConnectionResult` 加可选 `warning?: string`，在 core/types.ts 补，命名与 Spec §12 对齐）。
  - `listTables`→`cat.indices({format:"json", health:"green,yellow,red"})` 截断；`describeTable`→`indices.getMapping+getSettings` 转字段/类型/分片副本。
  - system prompt hint 行：`名称[搜索] - ES，sql 参数填 Query DSL JSON`。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/dialects/search-dialect.ts packages/db/src/dialects/elasticsearch.ts packages/db/test/elasticsearch.test.ts packages/db/package.json packages/db/src/core/types.ts
git commit -m "feat: add Elasticsearch dialect with v7/v8 dispatch"
```

---

### Task 8: Hive + Spark（F 阶段：BigDataDialect，前置 spike）

**Files:**
- Create: `packages/db/src/dialects/bigdata-dialect.ts`, `hive.ts`, `spark.ts`
- Modify: `packages/db/package.json`（+ `hive-driver`）、`dialects/index.ts`
- Test: `packages/db/test/bigdata.test.ts`
- Spike（先做，不合入）：`/tmp/spike-hive/` 验证 hive-driver 连 Hive 2/4 + Spark Thrift

**Interfaces:**
- Consumes: Task 1（sql-text 复用）、Task 2/5
- Produces: `BigDataDialect`（HS2 会话、batch 拉取达 maxRows 即停、超时取消 operation）+ `hiveDialect`/`sparkDialect`（`jdbc:hive2://`、SHOW/DESCRIBE、写关键字集）

- [ ] **Step 1: 先跑 spike（阻塞项，结果决定 hive.ts 写法；hive-driver 的类名以其 README 为准，
  下示例类名若与实际不符按实际调整——spike 的目的正是确认这件事，不要对着错类名死磕）**

```bash
mkdir -p /tmp/spike-hive && cd /tmp/spike-hive && npm init -y >/dev/null && npm i hive-driver
```

```js
// /tmp/spike-hive/spike.mjs
import hive from "hive-driver";
const { TCLIService, TCLIService_types } = hive.thrift;
const client = new hive.HiveClient(TCLIService, TCLIService_types);
await client.connect({ host: "<HIVE_HOST>", port: 10000 }, new hive.connections.TcpConnection(), new hive.auth.PlainTcpAuthentication({ username: "hive", password: "" }));
const session = await client.openSession({ client_protocol: hive.thrift.TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10 });
const op = await client.executeStatement(session, "SHOW TABLES");
await client.fetchResults(op);
console.log("OK");
await client.closeSession(session);
```

Spike 通过标准：SHOW TABLES 有返回。失败→Hive 4.x 换 `client_protocol` 版本重试；仍失败→文档声明仅支持 2/3，hive.ts 照 V10 写。

- [ ] **Step 2: 写 failing test（写关键字 + URL 解析）**

```ts
// test/bigdata.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hiveDialect } from "../src/dialects/hive.js";
import { sparkDialect } from "../src/dialects/spark.js";

describe("hive", () => {
  it("parses hive2 url", () => {
    assert.deepEqual(hiveDialect.parseUrl("jdbc:hive2://h:10000/mydb"),
      { host: "h", port: 10000, database: "mydb" });
  });
  it("treats INSERT OVERWRITE as write", () => {
    assert.equal(hiveDialect.isAllowed("INSERT OVERWRITE TABLE t SELECT 1", false).isWrite, true);
  });
  it("blocks DROP TABLE always", () => {
    assert.equal(hiveDialect.isAllowed("DROP TABLE t", false).ok, false);
  });
});

describe("spark", () => {
  it("parses hive2 url with custom port", () => {
    assert.equal(sparkDialect.parseUrl("jdbc:hive2://h:10015/mydb")?.port, 10015);
  });
  it("treats CACHE TABLE as write", () => {
    assert.equal(sparkDialect.isAllowed("CACHE TABLE t", false).isWrite, true);
  });
});
```

- [ ] **Step 3: 实现**
  - `bigdata-dialect.ts`：`withConnection`（openSession→fn→closeSession）；`executeOn`（executeStatement→循环 fetchResults batch→达 maxRows 停+`truncated` 标注；超时 `withTimeout` 兜底+`cancelOperation`）；`listTables`（SHOW TABLES，可选 pattern 过滤）；`testConnection` 返回版本（`SELECT version()`/Hive `SET -v` 兜底）。
  - `hive.ts`：写关键字集 +`INSERT INTO/OVERWRITE|CREATE TABLE AS|LOAD DATA|MSCK|ALTER`；`describeTable`→`DESCRIBE FORMATTED` 解析列/类型/注释。
  - `spark.ts`：继承同一基类，写关键字 +`CACHE|REFRESH|UNCACHE`；会话变量前缀 `spark.`；DESCRIBE 列差异适配。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/dialects/bigdata-dialect.ts packages/db/src/dialects/hive.ts packages/db/src/dialects/spark.ts packages/db/test/bigdata.test.ts packages/db/package.json
git commit -m "feat: add Hive and Spark dialects over HiveServer2"
```

---

### Task 9: DM（C 阶段：dm 方言，前置 spike）

**Files:**
- Create: `packages/db/src/dialects/dm.ts`
- Modify: `packages/db/package.json`（+ `dmdb`）、`dialects/index.ts`
- Test: `packages/db/test/dm.test.ts`
- Spike（先做）：`/tmp/spike-dm/` 验证 dmdb 在本机（macOS ARM64）可安装加载

**Interfaces:**
- Consumes: Task 3（RelationalDialect）
- Produces: `dmDialect`（`jdbc:dm://`、5236、DM 数据字典、V$VERSION）

- [ ] **Step 1: 先跑 spike**

```bash
mkdir -p /tmp/spike-dm && cd /tmp/spike-dm && npm init -y >/dev/null && npm i dmdb && node -e "require('dmdb'); console.log('dmdb loads OK')"
```

Expected: `dmdb loads OK`。失败→DM 降级为“仅 Linux 可用”，dm.ts 仍写（不阻塞），README 声明平台限制。

- [ ] **Step 2: 写 failing test**

```ts
// test/dm.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dmDialect } from "../src/dialects/dm.js";

describe("dm", () => {
  it("parses dm jdbc url with default port", () => {
    assert.deepEqual(dmDialect.parseUrl("jdbc:dm://h/myschema"),
      { host: "h", port: 5236, database: "myschema" });
  });
  it("masks password in display", () => {
    const shown = dmDialect.displayUrl({ id: "x", name: "n", type: "dm", host: "h", port: 5236, username: "u", password: "secret", database: "s", createdAt: "" });
    assert.ok(!shown.includes("secret") && shown.includes("jdbc:dm://"));
  });
});
```

- [ ] **Step 3: 实现**（`doConnect` 用 dmdb，`doExecute` 仿 oracledb 分支；listTables 用 `ALL_TABLES+ALL_TAB_COMMENTS` 过滤 `SYS/SYSDBA/SYSSSO/CTISYS`；describeTable 用 `ALL_TAB_COLUMNS+ALL_COL_COMMENTS+ALL_CONSTRAINTS(P)`；versionQuery `SELECT * FROM V$VERSION`；hint 行 `名称[关系型] - DM`）

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/dialects/dm.ts packages/db/test/dm.test.ts packages/db/package.json
git commit -m "feat: add DM (Dameng) dialect"
```

---

### Task 10: `/db scan`（G 阶段：扫描建连）

**Files:**
- Create: `packages/db/src/core/scan/walker.ts, parsers.ts, spring.ts, placeholders.ts, scoring.ts, candidates.ts`
- Modify: `packages/db/index.ts`（`/db scan` 命令 + `scan_project_configs` 工具 + 系统提示触发词文案）
- Test: `packages/db/test/scan.test.ts`（用 `test/fixtures/spring-demo/` 固件目录断言）

**Interfaces:**
- Consumes: Task 2（fingerprints/Candidate）、Task 5（config/testConnection）
- Produces: `scanProject(root: string): Promise<Candidate[]>`（root 越界抛错）；`/db scan [path]`；`scan_project_configs` 工具（返回掩码候选，不写盘）

- [ ] **Step 1: 准备固件 + 写 failing test**

```yaml
# test/fixtures/spring-demo/src/main/resources/application.yml
spring:
  datasource:
    url: jdbc:mysql://10.0.0.5:3306/demo?serverTimezone=Asia/Shanghai
    username: root
    password: ${DB_PASSWORD:secret123}
  data:
    redis:
      host: 10.0.0.6
      port: 6379
      password: ${REDIS_PASSWORD:}
```

```ts
// test/scan.test.ts
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
});
```

（固件另加一个含 `password: ENC(xxx)` 的 yml 片段覆盖第 4 条。）

- [ ] **Step 2: 运行确认失败；Step 3: 实现六个模块**
  - `walker.ts`：递归漫步，默认忽略 `node_modules/.git/target/dist/venv/logs/docs`；`resolveRoot(input)`：越界（`..` 上跳、绝对路径不在 cwd 内）抛 `Error("scan path out of scope")`。
  - `parsers.ts`：`.env`（KEY=VAL）、`.properties`（点分键）、yml/yaml（缩进解析只取 `spring.datasource|data.redis|elasticsearch|data.elasticsearch` 子树 + 通用 URL 正则全文件扫）、docker-compose.yml（services[].image 判类型 + environment/ports）。
  - `spring.ts`：键→Partial<ConnConfig> 映射 + profile 文件名分组（`application-dev.yml`→profile=dev）。
  - `placeholders.ts`：`${KEY:default}`→default；`${KEY}`→同目录 `.env`→`process.env`→缺省标 missing。
  - `scoring.ts`：docker-compose/.env/application.yml 高权重；`*test*/*example*/.md/logs` 降权或排除；输出 confidence。
  - `candidates.ts`：`scanProject` 组装 + `exists` 状态（调 config.ts 查同名）+ 密码掩码（输出时 `password: "***"`，内部 partial 保留真实值仅 TUI 用）。

- [ ] **Step 4: index.ts 接线**
  - `/db scan [path]`：Q&A 向导三步（分组展示→逐个确认命名/补字段/同名三选→逐个 testConnection 保存）。
  - `scan_project_configs` 工具：参数 `{ path?: string }`，返回掩码候选 JSON + “请在终端用 /db scan 完成建连”指引；不写盘。
  - 系统提示追加触发词文案：“当用户说‘连一下这个项目的数据库’等，调用 scan_project_configs；建连写盘前必须经用户确认。”

- [ ] **Step 5: 运行测试 + 真实项目验证**

Run: `pnpm --filter db test`
Expected: PASS。另在 `zt_gacydmx` 跑一次 `/db scan` 人工确认能扫出 PG+Redis 候选（含占位符 default 与待补标记）。

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/core/scan/ packages/db/test/scan.test.ts packages/db/test/fixtures/ packages/db/index.ts
git commit -m "feat: add /db scan project config scanner"
```

---

### Task 11: P0 体验项（G 阶段剩余：表单分支/连接串/默认连接/pattern/导出）

**Files:**
- Create: `packages/db/src/ui/forms.ts`（家族分支新增表单 + 一键连接串）、`packages/db/src/ui/default-conn.ts`（默认连接标记/切换）、`packages/db/src/ui/export.ts`（CSV/JSON 落盘）、`packages/db/src/ui/scan-wizard.ts`（scan 向导，本任务从 index.ts 迁出；Task 10 只在 index.ts 内实现向导逻辑）
- Create: `packages/db/src/core/export.ts`（`toCsv(rows, columns)` / `toJsonFile(payload)` 纯函数）
- Modify: `packages/db/index.ts`（add 表单分支、一键连接串、默认连接标记、`/db` 菜单导出项）、`packages/db/src/config.ts`（`isDefault` 字段）、工具参数（`database?` 可选、`pattern?`）。注：`ConnConfig.isDefault?` 已随 Spec §2.0 在 Task 2 就位，本任务只接线不改类型。
- Test: `packages/db/test/ux.test.ts`（连接串解析矩阵）

**Interfaces:**
- Consumes: Task 2（parseUrl 各方言）、Task 5（config）
- Produces: `parseConnectionString(input)`（自动识别家族）；`database?` 缺省走默认连接；`listTables(pattern?)` 生效；导出 CSV/JSON 到文件

- [ ] **Step 1: 写 failing test（连接串矩阵）**

```ts
// test/ux.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConnectionString } from "../src/config.js";

describe("parseConnectionString", () => {
  it("postgres uri", () => {
    assert.deepEqual(parseConnectionString("postgresql://u:p@h:5432/db"),
      { dialectId: "postgresql", host: "h", port: 5432, username: "u", password: "p", database: "db" });
  });
  it("redis uri with db index", () => {
    assert.deepEqual(parseConnectionString("redis://:p@h:6379/2"),
      { dialectId: "redis", host: "h", port: 6379, password: "p", dbIndex: 2 });
  });
  it("es http url", () => {
    assert.deepEqual(parseConnectionString("http://h:9200"),
      { dialectId: "elasticsearch", host: "h", port: 9200 });
  });
  it("hive jdbc", () => {
    assert.deepEqual(parseConnectionString("jdbc:hive2://h:10000/db"),
      { dialectId: "hive", host: "h", port: 10000, database: "db" });
  });
});
```

- [ ] **Step 2: 运行确认失败；Step 3: 实现**
  - `parseConnectionString`：遍历 registry 各方言 `parseUrl`，首个非 null 胜出，附带 `dialectId`（各方言 `parseUrl` 自 Task 4 起兼收 JDBC + 原生 URI 双形态，此处直接复用）。
  - add 流程：首问“粘贴连接串（一键）/ 逐步填写”；逐步填写按家族分支字段（Redis：URL+密码+库号；ES：URL+账号+密码；其余：URL+账号+密码）。
  - `ConnConfig` 加 `isDefault?: boolean`；`/db` 菜单加“设为默认”；工具 `database` 参数改可选（Typebox `Type.Optional`），缺省→默认连接→无默认则报错指引。
  - 各方言 `listTables(config, pattern?)` 实现过滤（SQL `LIKE`、Redis SCAN MATCH、ES 通配、SHOW TABLES LIKE）。
  - 查询结果导出：UI 菜单与工具结果超 50 行时写 `/tmp` CSV/JSON 并返回路径（工具返回路径文本，不贴全量）。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter db test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: P0 UX - branched forms, conn string, default conn, pattern, export"
```

---

### Task 12: 发布准备（H 阶段：README + 市场元数据）

**Files:**
- Modify: `packages/db/README.md`（8 库+版本矩阵+scan+默认连接文档）、`packages/db/package.json`（keywords 补齐 8 库名，确认 `pi-package` 在列、exports 有效）
- Test: 无代码测试；验收为清单核对

**Interfaces:**
- Consumes: Task 0–11 全部完成
- Produces: 可发布的包 + pi.dev/packages 可搜到

- [ ] **Step 1: 更新 README**
  - 支持列表 8 种库 + §12 版本矩阵照搬（含 Oracle ≥12.1 / ES 双客户端说明）。
  - `/db scan` 用法、`database` 可选（默认连接）、`pattern?`、导出路径说明。
  - 驱动安装说明：dmdb/hive-driver 平台限制、Instant Client（Thick，二期）一句话。

- [ ] **Step 2: package.json 核对**

```bash
cd /Users/sny/01_work/02_code/39_pi/pi-extensions/packages/db && node -e "const p=require('./package.json'); console.log(p.keywords); console.log(p.exports)"
```

Expected: keywords 含 `pi-package` + 8 库名；exports 含 `.`/`./core`/`./dialects`。

- [ ] **Step 3: registry 规模断言收尾（Spec §9）**

把 Task 4 引入的规模断言更新为 `assert.equal(registry.size, 8)`（8 种方言全部注册），运行 `pnpm --filter db test` 确认——防止“加了方言文件、忘了 index.ts 聚合行”。

- [ ] **Step 4: 打包演练**

```bash
npm pack --dry-run
```

Expected: files 含 index.ts/src/README.md；体积合理（无多余驱动打入——驱动是 dependencies，装时拉取）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: release prep for pi.dev/packages"
```

发布动作（`npm publish`）由用户手动执行，不进计划。

---

## 推荐执行顺序

任务编号按里程碑字母排，但 DM（C 阶段）无前置依赖、不阻塞 Redis/ES/Hive。
推荐执行顺序：**Task 0 → 1 → 2 → 3 → 4 → 5 → 9（DM）→ 6（Redis）→ 7（ES）→ 8（Hive/Spark）→ 10（scan）→ 11（P0）→ 12（发布）**。
其中 Task 8 与 Task 9 的前置 spike（hive-driver / dmdb 可用性）可与 Task 2 并行提前跑，
失败只影响对应方言的 README 声明，不阻塞主线。

注：Task 0 含 `rm packages/db/package-lock.json`（npm 产物，pnpm workspace 下多余且会误导包管理器选型）。

## Self-Review

**1. Spec coverage（逐节映射）：**
- §2.0 类型清单→Task 2（照抄） ✅
- §2 包结构/exports→Task 2/5 ✅
- §3 接口（withConnection/executeOn/verdict/registry）→Task 2/3/5 ✅
- §4.1 关系型→Task 1/3/4；§4.2 KV→Task 6；§4.3 搜索→Task 7；§4.4 大数据→Task 8 ✅
- §5.1–5.5 方言→Task 9/6/7/8（DM 在 Task 9，顺序按依赖：DM 无前置但放后，避免阻塞 Redis/ES/Hive ✅ 里程碑字母顺序≠执行顺序，任务内已注明）
- §6 策略→Task 5；效率项（注入预算/mtime）→Task 5 ✅
- §7 配置→Task 5/11；§8 错误→各方言任务内 ✅
- §8.5 scan→Task 10（含 path 越界、掩码、ENC 四原则） ✅
- §9 测试→各任务内单测 + Task 5 回归；registry 规模断言→Task 4（=3）/ Task 12 Step 3（=8）✅
- §10 里程碑 A–H→Task 1/（2–5)/(9)/(6)/(7)/(8)/(10+11)/(12) ✅
- §11 P0→Task 10/11；P1/P2 不进计划 ✅
- §12 版本矩阵→Task 4/6/7/8/9 内兜底逻辑 + Task 12 文档 ✅
- §14/15→Thick 二期、spike 任务内 ✅

**2. Placeholder scan：** 全文无 TBD/TODO/“类似 Task N”式引用；每个代码步骤含真实可运行代码；`ConnConfig` 字面量字段与 §2.0 一致（id/name/type/description/host/port/username/password/database/createdAt + 新增可选字段）。

**3. Type consistency：** `Verdict` 在 Task 2 定义、Task 3/5/6/7/8 使用一致；`registry/register` 签名统一；测试 import 一律 `../src/...js` 后缀；`TestConnectionResult.warning?` 在 Task 7 补（types.ts 修改已列入该任务文件清单）。

## 修订记录

- 2026-09-09 结合现有代码（index.ts 808 行 / src/db.ts 504 行）复审修订：
  1. `parseUrl` 统一为 JDBC + 原生 URI 双形态（修 Spec §7 与 Task 4/11 的形态矛盾，Task 4 补原生 URI 测试）；
  2. 补 registry 规模断言（Task 4 断言 3、Task 12 Step 3 断言 8，落实 Spec §9）；
  3. 删除 `RelationalDialect` 公开 `connect`（对齐 Spec §3“裸 connect 不公开”），修 registry fake 桩多余字段与 Task 3 Stub 缺失的抽象方法实现；
  4. 明确 `DbConfig`/`toConnConfig` 废止、`extraParams`→`options` 兼容迁移（对齐 Spec §2.0 配置类型裁决）；
  5. Task 0 补 `rm package-lock.json`；Task 5 显式保留 `hasUI` 检查并声明菜单确认行为变更；
  6. Task 1 固化 WITH-DML 保守误报与 MySQL 反斜杠转义两条用例；`warning` 字段命名对齐 Spec §12；
  7. File Structure 表补 `src/core/index.ts` 与 `src/core/export.ts`；Task 2 “§2.5” 笔误更正为 §2.0。
