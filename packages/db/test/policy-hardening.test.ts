// test/policy-hardening.test.ts —— 策略层收紧回归（v1.3.7）
//
// 覆盖三件本轮修复：
//   ① decide 的 highRisk 通道：confirm_before_exec=never 不再豁免 DDL/授权/写文件类语句
//   ② auditRequired：生产/强制只读连接的写操作必须 fail-closed 写审计
//   ③ 配置落盘：原子写 + 损坏文件不被当成空列表（否则保存一次就丢光连接）
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, effectiveReadonly, auditRequired, writeRequiresReason } from "../src/core/policy.js";
import { appendAuditLog, AUDIT_DIR, auditFilePath } from "../src/core/audit.js";
import { postgresqlDialect } from "../src/dialects/postgresql.js";

describe("decide：highRisk 通道", () => {
  const ddl = postgresqlDialect.isAllowed("CREATE TABLE x (a int)", false);
  const dml = postgresqlDialect.isAllowed("UPDATE t SET a = 1", false);
  const read = postgresqlDialect.isAllowed("SELECT 1", false);

  it("never 策略：普通 DML 直执行，DDL 仍要确认", () => {
    assert.equal(decide(dml, false, "never", dml.highRisk), "run");
    assert.equal(decide(ddl, false, "never", ddl.highRisk), "confirm");
  });

  it("never 策略：读语句不受影响", () => {
    assert.equal(decide(read, false, "never", read.highRisk), "run");
  });

  it("write 策略：所有写都要确认（highRisk 不改变结果）", () => {
    assert.equal(decide(dml, false, "write", dml.highRisk), "confirm");
    assert.equal(decide(ddl, false, "write", ddl.highRisk), "confirm");
  });

  it("always 策略：一律确认", () => {
    assert.equal(decide(read, false, "always", false), "confirm");
  });

  it("verdict.ok=false 恒 deny（DROP TABLE 等硬限制不受策略影响）", () => {
    const drop = postgresqlDialect.isAllowed("DROP TABLE t", false);
    assert.equal(decide(drop, false, "never", true), "deny");
  });
});

describe("auditRequired：生产/强制只读连接的审计 fail-closed", () => {
  it("prod 标签与强制只读都要求审计", () => {
    assert.equal(auditRequired({ envTag: "prod" }), true);
    assert.equal(auditRequired({ forceReadonly: true }), true);
    assert.equal(auditRequired({ envTag: "prod", forceReadonly: true }), true);
  });
  it("dev/test/无标签的连接不强制", () => {
    assert.equal(auditRequired({ envTag: "dev" }), false);
    assert.equal(auditRequired({ envTag: "test" }), false);
    assert.equal(auditRequired({}), false);
    assert.equal(auditRequired({ forceReadonly: false }), false);
  });
});

describe("appendAuditLog：返回落盘结果而不是永远静默", () => {
  it("正常目录返回 true 并真的写进去", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-audit-ok-"));
    try {
      const ok = appendAuditLog({
        time: new Date().toISOString(),
        project: "/work/x", connection: "c", type: "postgresql",
        summary: "UPDATE", reason: "测试", sql: "UPDATE t SET a = 1", readonly: false,
      }, dir);
      assert.equal(ok, true);
      const file = auditFilePath(new Date(), dir);
      assert.match(readFileSync(file, "utf-8"), /UPDATE t SET a = 1/);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不可写目录返回 false（调用方据此拒绝执行）", () => {
    // 用一个普通文件当目录：mkdir/append 必然失败
    const base = mkdtempSync(join(tmpdir(), "db-audit-fail-"));
    try {
      const blocker = join(base, "blocker");
      writeFileSync(blocker, "x");
      const ok = appendAuditLog({
        time: new Date().toISOString(),
        project: "", connection: "c", type: "postgresql",
        summary: "", reason: "", sql: "DELETE FROM t", readonly: false,
      }, join(blocker, "sub"));
      assert.equal(ok, false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("默认审计目录在 ~/.pi/agent/db-audit 下", () => {
    assert.match(AUDIT_DIR, /\.pi[/\\]agent[/\\]db-audit$/);
  });
});

describe("写操作理由校验与 highRisk 正交", () => {
  it("高风险写同样必须有 reason", () => {
    const ddl = postgresqlDialect.isAllowed("GRANT ALL ON t TO u", false);
    assert.equal(writeRequiresReason(ddl, undefined), true);
    assert.equal(writeRequiresReason(ddl, "给只读账号授权"), false);
  });
  it("effectiveReadonly 与 auditRequired 口径一致：prod+强制只读必然只读+必审计", () => {
    const cfg = { envTag: "prod" as const, forceReadonly: true };
    assert.equal(effectiveReadonly(false, cfg), true);
    assert.equal(auditRequired(cfg), true);
  });
});

// 说明：配置原子写/损坏检测的用例见 test/config-atomic.test.ts
// （CONFIG_FILE 路径在模块加载时绑定 homedir，需要独立进程注入 HOME 才能安全测试）
