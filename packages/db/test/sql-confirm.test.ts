import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { confirmSqlExecution, buildSqlConfirmMarkdown } from "../src/ui/sql-confirm.js";

const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe("buildSqlConfirmMarkdown（弹窗正文，TUI 与 pi web 共用）", () => {
  it("结构：引用块(理由) + 列表(摘要/数据库) + sql 代码块", () => {
    assert.equal(
      buildSqlConfirmMarkdown({
        reason: "归档历史订单\n 预计影响 1.2 万行",
        summary: "CREATE IF（共 1 条语句）",
        database: "tyjkpt-dev-bmj_tyjkpt",
        sql: "create table if not exists t (id int)",
        type: "mysql",
      }),
      [
        "> **📝 执行理由**：归档历史订单 预计影响 1.2 万行",
        "",
        "- **📋 影响摘要**：`CREATE IF（共 1 条语句）`",
        "- **🗄️ 数据库**：`tyjkpt-dev-bmj_tyjkpt`",
        "",
        "```sql",
        "CREATE table IF NOT EXISTS t (id int)",
        "```",
      ].join("\n"),
    );
  });

  it("无理由/摘要/数据库时只留代码块", () => {
    assert.equal(buildSqlConfirmMarkdown({ sql: "select 1", type: "mysql" }), ["```sql", "SELECT 1", "```"].join("\n"));
  });

  it("菜单执行路径无 reason 时不含引用块", () => {
    const md = buildSqlConfirmMarkdown({ summary: "CREATE", sql: "select 1", type: "mysql" });
    assert.ok(!md.includes("执行理由"), md);
    assert.ok(md.startsWith("- **📋 影响摘要**"), md);
  });

  it("Redis 无同类语法 → 围栏不带语言标记", () => {
    assert.equal(
      buildSqlConfirmMarkdown({ reason: "缓存清理", sql: "DEL foo", type: "redis" }),
      ["> **📝 执行理由**：缓存清理", "", "```", "DEL foo", "```"].join("\n"),
    );
  });

  it("SQL 内含 ``` 时自动加长围栏，避免撑破代码块", () => {
    assert.equal(
      buildSqlConfirmMarkdown({ sql: "select '```' from t", type: "postgresql" }),
      ["````sql", "SELECT '```'", "FROM t", "````"].join("\n"),
    );
  });

  it("理由里的换行压成一行（Markdown 单换行会折叠）", () => {
    const md = buildSqlConfirmMarkdown({ reason: "第一行\n第二行", sql: "select 1", type: "mysql" });
    assert.ok(md.startsWith("> **📝 执行理由**：第一行 第二行\n"), md);
  });

  it("JSON 方言（MongoDB）用 json 围栏 + 2 空格缩进", () => {
    const md = buildSqlConfirmMarkdown({ sql: '{"find":"users","filter":{"a":1}}', type: "mongodb" });
    assert.ok(md.startsWith("```json\n{\n  \"find\": \"users\""), md);
  });
});

describe("confirmSqlExecution", () => {
  it("TUI：走 custom 组件，Enter 确认 / Esc 取消", async () => {
    let comp: any;
    let resolved: boolean | undefined;
    const ctx = {
      mode: "tui",
      ui: {
        custom: async (factory: any) => {
          comp = factory(null, fakeTheme, null, (v: boolean) => { resolved = v; });
          return undefined;
        },
      },
    };
    const ok = await confirmSqlExecution(ctx, { sql: "select 1", type: "mysql" });
    assert.equal(ok, false);
    assert.ok(comp, "未构造 TUI 组件");
    assert.equal(typeof comp.render, "function");
    comp.handleInput("\r"); // Enter
    assert.equal(resolved, true);
    resolved = undefined;
    comp.handleInput("\x1b"); // Esc
    assert.equal(resolved, false);
  });

  it("非 TUI（rpc/pi web）：confirm 收到 Markdown（含 ```sql 围栏）", async () => {
    let message = "";
    const ctx = {
      mode: "rpc",
      ui: { confirm: async (_t: string, m: string) => { message = m; return true; } },
    };
    const ok = await confirmSqlExecution(ctx, {
      reason: "归档",
      database: "prod",
      sql: "update t set a=1 where b=2",
      type: "mysql",
    });
    assert.equal(ok, true);
    assert.ok(message.includes("> **📝 执行理由**：归档"), message);
    assert.ok(message.includes("- **🗄️ 数据库**：`prod`"), message);
    assert.ok(message.includes("```sql\nUPDATE t\nSET a = 1\nWHERE b = 2\n```"), message);
  });

  it("custom 抛错时回退 confirm（确认环节不被跳过）", async () => {
    let confirmed = false;
    let message = "";
    const ctx = {
      mode: "tui",
      ui: {
        custom: async () => { throw new Error("boom"); },
        confirm: async (_t: string, m: string) => { confirmed = true; message = m; return false; },
      },
    };
    const ok = await confirmSqlExecution(ctx, { sql: "delete from t", type: "postgresql" });
    assert.equal(ok, false);
    assert.equal(confirmed, true);
    assert.ok(message.includes("```sql"), message);
  });
});
