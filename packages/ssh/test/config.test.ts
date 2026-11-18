import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearConfigCache, loadHosts, saveHosts } from "../src/core/config.js";
import { deleteSecret, getSecret, putSecret } from "../src/core/secrets.js";
import type { HostFile } from "../src/core/types.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "pi-ssh-"));
}

const sample = (): HostFile => ({
  activeHost: "web",
  hosts: {
    web: {
      id: "1",
      name: "web",
      transport: "auto",
      host: "10.0.0.21",
      user: "deploy",
      auth: { kind: "key", privateKeyPath: "~/.ssh/id_ed25519" },
      createdAt: "2026-11-18T00:00:00.000Z",
    },
  },
});

describe("hosts config", () => {
  it("原子写成 0600，内容不变时不重写", async () => {
    const file = join(dir(), "ssh-hosts.json");
    saveHosts(file, sample());
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const before = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    saveHosts(file, sample());
    assert.equal(statSync(file).mtimeMs, before);
  });

  it("坏文件回退为空，外部改动能被读到", () => {
    const file = join(dir(), "ssh-hosts.json");
    writeFileSync(file, "{not json");
    assert.deepEqual(loadHosts(file), { hosts: {} });

    clearConfigCache();
    saveHosts(file, sample());
    const loaded = loadHosts(file);
    loaded.hosts.web.host = "changed-in-memory";
    assert.equal(loadHosts(file).hosts.web.host, "10.0.0.21");

    writeFileSync(file, JSON.stringify({ hosts: {}, activeHost: "other" }));
    chmodSync(file, 0o600);
    assert.equal(loadHosts(file).activeHost, "other");
  });
});

describe("secrets", () => {
  it("按主机读写并保持 0600", () => {
    const file = join(dir(), "ssh-secrets.json");
    putSecret(file, "web", "s3cret");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(getSecret(file, "web"), "s3cret");
    deleteSecret(file, "web");
    assert.equal(getSecret(file, "web"), undefined);
  });

  it("文件损坏时拒绝写入，避免盖掉其他主机", () => {
    const file = join(dir(), "broken.json");
    writeFileSync(file, "{");
    assert.throws(() => putSecret(file, "web", "next"), /凭据文件损坏/);
  });
});

describe("sha256File 拒绝目录", () => {
  it("传目录抛可读错误，不是 EISDIR 逃逸成 unhandledRejection", async () => {
    const { sha256File } = await import("../src/core/hash.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-ssh-dir-"));
    await assert.rejects(() => sha256File(dir), /是目录/);
  });

  it("普通文件照旧算出 sha256 与字节数", async () => {
    const { sha256File } = await import("../src/core/hash.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-ssh-file-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    const result = await sha256File(file);
    assert.equal(result.bytes, 5);
    assert.equal(result.hash, createHash("sha256").update("hello").digest("hex"));
  });
});
