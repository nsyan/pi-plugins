// test/connmgmt.test.ts —— 连接管理 UX（v1.1）纯单测：生效只读 / 摘要行 / 相对时间 / 环境标签 / 写理由校验 / 审计日志
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveReadonly, writeRequiresReason } from "../src/core/policy.js";
import { connSummaryLine, envTagLabel, formatRelativeTime, DEFAULT_PLUGIN_CONFIG } from "../src/config.js";
import { appendAuditLog, auditFilePath, localDateStr, type AuditEntry } from "../src/core/audit.js";
import type { ConnConfig, Verdict } from "../src/core/types.js";

const base: ConnConfig = {
  id: "x", name: "jail-pg", type: "postgresql", createdAt: "2026-01-01T00:00:00Z",
};

describe("effectiveReadonly（连接级强制只读）", () => {
  it("全局只读时恒只读", () => {
    assert.equal(effectiveReadonly(true, {}), true);
    assert.equal(effectiveReadonly(true, { forceReadonly: false }), true);
  });
  it("全局可写时由连接级决定", () => {
    assert.equal(effectiveReadonly(false, {}), false);
    assert.equal(effectiveReadonly(false, { forceReadonly: false }), false);
    assert.equal(effectiveReadonly(false, { forceReadonly: true }), true);
  });
  it("forceReadonly=true 时无视全局开关", () => {
    assert.equal(effectiveReadonly(false, { forceReadonly: true }), true);
  });
});

describe("formatRelativeTime", () => {
  it("分钟/小时/天档位", () => {
    const now = Date.now();
    assert.equal(formatRelativeTime(new Date(now - 30_000).toISOString()), "刚刚");
    assert.equal(formatRelativeTime(new Date(now - 5 * 60_000).toISOString()), "5 分钟前");
    assert.equal(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString()), "3 小时前");
    assert.equal(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString()), "2 天前");
  });
  it("超 30 天回退日期；非法输入空串", () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    assert.equal(formatRelativeTime(old), old.slice(0, 10));
    assert.equal(formatRelativeTime("not-a-date"), "");
  });
});

describe("envTagLabel", () => {
  it("无标签空串；prod+强制只读完整展示", () => {
    assert.equal(envTagLabel({}), "");
    assert.equal(envTagLabel({ envTag: "dev" }), "[dev]");
    assert.equal(envTagLabel({ envTag: "prod", forceReadonly: true }), "[prod·强制只读]");
    assert.equal(envTagLabel({ envTag: "prod" }), "[prod]");
  });
});

describe("connSummaryLine", () => {
  it("极简连接：名称 + 类型", () => {
    assert.equal(connSummaryLine(base), "jail-pg [PG]");
  });
  it("全量字段拼接顺序：名称/类型/默认/标签/最近使用/测试/说明", () => {
    const line = connSummaryLine({
      ...base,
      isDefault: true,
      envTag: "prod",
      forceReadonly: true,
      description: "狱政库",
      lastUsedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      lastTest: { ok: true, latency: "45ms", version: "17.2", at: new Date().toISOString() },
    });
    assert.match(line, /^jail-pg \[PG\] · ⭐默认 · \[prod·强制只读\] · 上次使用 2 天前 · 测试 ✓45ms - 狱政库$/);
  });
  it("失败的测试标 ✗", () => {
    const line = connSummaryLine({ ...base, lastTest: { ok: false, at: new Date().toISOString() } });
    assert.match(line, /测试 ✗/);
  });
});

describe("writeRequiresReason（写操作理由强校验）", () => {
  const read: Verdict = { ok: true, isWrite: false, summary: "find users" };
  const write: Verdict = { ok: true, isWrite: true, summary: "insert users" };
  const denied: Verdict = { ok: false, reason: "只读拒绝", isWrite: true };

  it("写操作缺理由/空白理由 → true", () => {
    assert.equal(writeRequiresReason(write, undefined), true);
    assert.equal(writeRequiresReason(write, ""), true);
    assert.equal(writeRequiresReason(write, "   "), true);
  });
  it("写操作有理由 → false；读操作/被拒 verdict 恒 false", () => {
    assert.equal(writeRequiresReason(write, "归档历史订单，预计影响 1.2 万行"), false);
    assert.equal(writeRequiresReason(read, undefined), false);
    assert.equal(writeRequiresReason(denied, undefined), false);
  });
  it("审计日志默认关闭（可配置修订），理由强校验不受开关影响", () => {
    assert.equal(DEFAULT_PLUGIN_CONFIG.audit_enabled, false);
    const write: Verdict = { ok: true, isWrite: true };
    assert.equal(writeRequiresReason(write, "归档"), false); // 审计关不豁免理由
    assert.equal(writeRequiresReason(write, undefined), true);
  });
});

describe("audit 日志（按天轮转 + 完整 SQL）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "db-audit-test-"));

  it("localDateStr/auditFilePath：按本地日期命名", () => {
    assert.equal(localDateStr(new Date(2026, 8, 10, 23, 59)), "2026-09-10");
    const p = auditFilePath(new Date(2026, 8, 10), join(tmp, "audit"));
    assert.ok(p.endsWith(join("audit", "2026-09-10.jsonl")));
  });

  it("JSONL 逐行追加；SQL 存完整原文不截断；字段齐全", () => {
    const dir = join(tmp, "audit");
    const longSql = "UPDATE orders SET status = 2 WHERE id IN (" + Array.from({ length: 1000 }, (_, i) => i + 1).join(",") + ")";
    const entry: AuditEntry = {
      time: new Date(2026, 8, 10, 12, 0, 0).toISOString(),
      project: "/work/orders",
      connection: "prod-orders",
      type: "mysql",
      summary: "UPDATE orders（共 1 条语句）",
      reason: "将 status=2 的历史订单归档，预计影响 1.2 万行",
      sql: longSql,
      readonly: false,
    };
    appendAuditLog(entry, dir);
    appendAuditLog({ ...entry, time: new Date(2026, 8, 10, 13, 0, 0).toISOString() }, dir);

    const file = auditFilePath(new Date(2026, 8, 10), dir);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.sql, longSql); // 不截断
    assert.equal(rec.project, "/work/orders");
    assert.equal(rec.connection, "prod-orders");
    assert.equal(rec.reason, "将 status=2 的历史订单归档，预计影响 1.2 万行");
    assert.equal(rec.readonly, false);
    assert.ok(rec.time);
  });

  rmSync(tmp, { recursive: true, force: true });
});
