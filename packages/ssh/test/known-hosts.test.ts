import { createHmac, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkHostKey } from "../src/core/known-hosts.js";
import { AuditUnavailableError, HostKeyChangedError } from "../src/core/types.js";

function file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pi-ssh-")), "known_hosts");
  writeFileSync(path, text);
  return path;
}

function hashed(host: string, keyType: string, key: string): string {
  const salt = randomBytes(20);
  const mac = createHmac("sha1", salt).update(host).digest("base64");
  return `|1|${salt.toString("base64")}|${mac} ${keyType} ${key}`;
}

describe("known_hosts", () => {
  it("明文、哈希、端口形式能对上同一把钥", () => {
    const known = file(["10.0.0.21 ssh-ed25519 AAAA", hashed("10.0.0.22", "ssh-ed25519", "BBBB"), "[10.0.0.23]:2222 ssh-ed25519 CCCC"].join("\n"));
    assert.equal(checkHostKey(known, "10.0.0.21", 22, "ssh-ed25519", "AAAA"), "match");
    assert.equal(checkHostKey(known, "10.0.0.22", 22, "ssh-ed25519", "BBBB"), "match");
    assert.equal(checkHostKey(known, "10.0.0.23", 2222, "ssh-ed25519", "CCCC"), "match");
  });

  it("同类型不同钥是 changed，不同类型仍是 unknown", () => {
    const known = file("10.0.0.21 ssh-ed25519 AAAA\n");
    assert.equal(checkHostKey(known, "10.0.0.21", 22, "ssh-ed25519", "ZZZZ"), "changed");
    assert.equal(checkHostKey(known, "10.0.0.21", 22, "ssh-rsa", "ZZZZ"), "unknown");
  });

  it("吊销命中该钥，证书行不作为信任", () => {
    const known = file(["@revoked 10.0.0.21 ssh-ed25519 AAAA", "@cert-authority 10.0.0.24 ssh-ed25519 CERT"].join("\n"));
    assert.equal(checkHostKey(known, "10.0.0.21", 22, "ssh-ed25519", "AAAA"), "revoked");
    assert.equal(checkHostKey(known, "10.0.0.21", 22, "ssh-ed25519", "BBBB"), "unknown");
    assert.equal(checkHostKey(known, "10.0.0.24", 22, "ssh-ed25519", "CERT"), "unknown");
  });

  it("文件不存在是 unknown", () => {
    assert.equal(checkHostKey(join(tmpdir(), "missing-known-hosts"), "10.0.0.21", 22, "ssh-ed25519", "AAAA"), "unknown");
  });
});

describe("错误类型", () => {
  it("保留名字，方便工具层按类型翻译", () => {
    assert.equal(new HostKeyChangedError("changed").name, "HostKeyChangedError");
    assert.equal(new AuditUnavailableError("no audit").name, "AuditUnavailableError");
  });
});
