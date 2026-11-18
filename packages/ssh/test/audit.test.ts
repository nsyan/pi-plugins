import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendAudit, readAudit } from "../src/core/audit.js";
import { AuditUnavailableError } from "../src/core/types.js";

describe("audit", () => {
  it("追加 JSONL，stdin 脱敏，文件 0600", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pi-ssh-")), "audit.jsonl");
    appendAudit(file, { host: "web", tool: "ssh_sudo", command: "sudo systemctl restart app", stdin: "s3cret" });
    const [row] = readAudit(file);
    assert.equal(row.stdin, "<redacted>");
    assert.equal(row.command, "sudo systemctl restart app");
    assert.equal(JSON.stringify(row).includes("s3cret"), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("required 时写失败抛 AuditUnavailableError，否则吞掉", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-ssh-"));
    const blocked = join(root, "not-a-dir");
    writeFileSync(blocked, "x");
    const target = join(blocked, "audit.jsonl");
    const entry = { host: "web", tool: "ssh_exec", command: "rm -rf /tmp/x" };
    assert.doesNotThrow(() => appendAudit(target, entry));
    assert.throws(() => appendAudit(target, entry, { required: true }), AuditUnavailableError);
  });

  it("超过上限就滚动，只保留最近几份", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-ssh-"));
    const file = join(root, "ssh-audit.jsonl");
    for (let index = 0; index < 5; index += 1) {
      appendAudit(file, { host: "web", tool: "ssh_exec", command: `echo ${index}` }, { maxBytes: 40, keep: 2 });
    }
    const names = readdirSync(root).sort();
    assert.equal(names.length, 3);
    assert.equal(names.some((name) => name === "ssh-audit.jsonl"), true);
    assert.equal(statSync(file).size > 0, true);
  });
});
