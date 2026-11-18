import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createRequire } from "node:module";
import type { Connection, ServerChannel } from "ssh2";

const ssh2 = createRequire(import.meta.url)("ssh2") as typeof import("ssh2") & {
  utils: { generateKeyPairSync: (type: string) => { private: string } };
};
const { Server } = ssh2;
import { Ssh2Pool } from "../src/transports/ssh2.js";
import { TransferMismatchError, type HostProfile } from "../src/core/types.js";

const STATUS_NO_SUCH_FILE = 2;

interface TestServer {
  port: number;
  hostKey: Buffer;
  files: Map<string, Buffer>;
  openExec: () => number;
  close(): Promise<void>;
}

function startServer(): Promise<TestServer> {
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519").private;
  const files = new Map<string, Buffer>();
  const connections = new Set<Connection>();
  let openExec = 0;
  const server = new Server({ hostKeys: [hostKey as string] }, (connection) => {
    connections.add(connection);
    connection.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === "secret") ctx.accept();
      else ctx.reject();
    });
    connection.on("session", (acceptSession) => {
      const session = acceptSession();
      if (!session) return;
      const onExec = (acceptExec: () => ServerChannel | undefined, _rejectExec: unknown, info: { command: string }) => {
        const channel = acceptExec();
        if (!channel) return;
        channel.allowHalfOpen = true;
        channel.on("data", (chunk: Buffer) => channel.stdin.write(chunk));
        channel.on("eof", () => channel.stdin.end());
        openExec += 1;
        channel.on("close", () => {
          openExec -= 1;
        });
        handleExec(info.command, files, channel);
      };
      session.on("exec", onExec);
      const onSftp = (acceptSftp: () => import("ssh2").SFTPWrapper) => {
        const sftp = acceptSftp();
        sftp.on("OPEN", (reqid, filename) => {
          const handle = Buffer.from(String(filename));
          if (!files.has(String(filename))) files.set(String(filename), Buffer.alloc(0));
          sftp.handle(reqid, handle);
        });
        sftp.on("WRITE", (reqid, handle, offset, data) => {
          const name = handle.toString();
          const current = files.get(name) ?? Buffer.alloc(0);
          const next = Buffer.alloc(Math.max(current.length, offset + data.length));
          current.copy(next);
          data.copy(next, offset);
          files.set(name, name.includes("corrupt") ? Buffer.concat([next, Buffer.from([1])]) : next);
          sftp.status(reqid, 0);
        });
        sftp.on("READ", (reqid, handle, offset, length) => {
          const content = files.get(handle.toString()) ?? Buffer.alloc(0);
          if (offset >= content.length) sftp.status(reqid, 1);
          else sftp.data(reqid, content.subarray(offset, offset + length));
        });
        sftp.on("STAT", stat);
        sftp.on("LSTAT", stat);
        sftp.on("CLOSE", (reqid) => sftp.status(reqid, 0));
        sftp.on("OPENDIR", (reqid, dirname) => sftp.handle(reqid, Buffer.from(String(dirname))));
        sftp.on("READDIR", (reqid, handle) => {
          const dir = handle.toString().replace(/\/$/, "") || "/";
          const seen = files.get(`__dir__${dir}`);
          if (seen) {
            sftp.status(reqid, 1);
            return;
          }
          files.set(`__dir__${dir}`, Buffer.from("1"));
          const names = [...files.keys()].filter((name) => name.startsWith(`${dir}/`) && !name.slice(dir.length + 1).includes("/") && !name.includes("__dir__"));
          if (names.length === 0) {
            sftp.status(reqid, 1);
            return;
          }
          sftp.name(reqid, names.map((name) => ({
            filename: name.slice(dir.length + 1),
            longname: name,
            attrs: { mode: 0o100644, size: files.get(name)?.length ?? 0, uid: 0, gid: 0, atime: 0, mtime: 0 },
          })));
        });
        function stat(reqid: number, name: string) {
          const content = files.get(String(name));
          if (!content) sftp.status(reqid, STATUS_NO_SUCH_FILE);
          else sftp.attrs(reqid, { mode: 0o100644, size: content.length, uid: 0, gid: 0, atime: 0, mtime: 0 });
        }
      };
      session.on("sftp", onSftp);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        hostKey: Buffer.from("test-host-key"),
        files,
        openExec: () => openExec,
        close: () =>
          new Promise((done) => {
            for (const connection of connections) connection.end();
            server.close(() => done());
          }),
      });
    });
  });
}

function handleExec(command: string, files: Map<string, Buffer>, channel: ServerChannel) {
  const sum = command.match(/sha256sum '([^']+)'/);
  if (sum) {
    const content = files.get(sum[1]);
    if (!content) channel.stderr.write(`missing ${sum[1]}\n`);
    else channel.stdout.write(`${sha256(content)}  ${sum[1]}\n`);
    channel.exit(content ? 0 : 1);
    channel.close();
    return;
  }
  const mv = command.match(/mv '([^']+)' '([^']+)'/);
  if (mv) {
    const content = files.get(mv[1]);
    if (content) {
      files.set(mv[2], content);
      files.delete(mv[1]);
    }
    channel.exit(content ? 0 : 1);
    channel.close();
    return;
  }
  const exists = command.match(/if \[ -e '([^']+)' \]/);
  if (exists) {
    if (files.has(exists[1])) channel.stdout.write("yes\n");
    channel.exit(0);
    channel.close();
    return;
  }
  if (command.includes("sleep 30")) {
      channel.stdout.write("running\n");
    const timer = setTimeout(() => {
      channel.stdout.write("SHOULD_NOT\n");
      channel.exit(0);
      channel.close();
    }, 30_000);
    channel.on("close", () => clearTimeout(timer));
    return;
  }
  channel.stdout.write(`ran:${command}\n`);
  channel.exit(0);
  channel.close();
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("ssh2 pool", () => {
  let server: TestServer;
  let pool: Ssh2Pool;
  const dir = mkdtempSync(join(tmpdir(), "pi-ssh2-"));

  before(async () => {
    server = await startServer();
    pool = new Ssh2Pool({
      idleMs: 50,
      hashCommand: (remotePath) => (remotePath.includes("corrupt") ? `echo deadbeef  ${remotePath}` : `sha256sum '${remotePath}'`),
    });
  });

  after(async () => {
    await pool.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function profile(id: string): HostProfile {
    return {
      id,
      name: id,
      transport: "ssh2",
      host: "127.0.0.1",
      port: server.port,
      user: "deploy",
      auth: { kind: "password", secretRef: "secret" },
      createdAt: "2026-11-18T00:00:00.000Z",
    };
  }

  it("同一 profile 复用一条连接，不同 profile 不合并", async () => {
    let checks = 0;
    await pool.connect(profile("web"), { verifyHostKey: () => (checks += 1) >= 0 });
    await pool.connect(profile("web"));
    await pool.connect(profile("ops"));
    assert.equal(checks, 1);
  });

  it("上传走 .part，校验通过后转正并备份旧文件", async () => {
    await pool.connect(profile("web"));
    const local = join(dir, "app.txt");
    writeFileSync(local, "alpha");
    server.files.set("/srv/app.txt", Buffer.from("old"));
    const first = await pool.put("web", { localPath: local, remotePath: "/srv/app.txt", backupPath: "/srv/app.txt.bak" });
    assert.equal(server.files.get("/srv/app.txt.bak")?.toString(), "old");
    assert.equal(server.files.get("/srv/app.txt")?.toString(), "alpha");
    assert.equal(server.files.has("/srv/app.txt.part"), false);
    assert.equal(first.backupPath, "/srv/app.txt.bak");

    const corrupt = join(dir, "corrupt.txt");
    writeFileSync(corrupt, "beta");
    await assert.rejects(
      pool.put("web", { localPath: corrupt, remotePath: "/srv/corrupt.txt" }),
      (error: Error) => {
        assert.equal(error instanceof TransferMismatchError, true);
        return true;
      },
    );
    assert.equal(server.files.has("/srv/corrupt.txt"), false);
    assert.equal(server.files.has("/srv/corrupt.txt.part"), true);
  });

  it("能列出目录并按行读取", async () => {
    await pool.connect(profile("web"));
    const listed = await pool.list("web", "/srv");
    assert.equal(listed.some((entry) => entry.name === "app.txt" && entry.size === 5), true);
    assert.equal(await pool.read("web", "/srv/app.txt", 1, 1), "alpha");
  });

  it("下载回来的内容一致", async () => {
    await pool.connect(profile("web"));
    const local = join(dir, "down.txt");
    await pool.get("web", { localPath: local, remotePath: "/srv/app.txt" });
    assert.equal(readFileSync(local, "utf8"), "alpha");
  });

  it("超过 6 个并发会排队，第 7 个等前面释放", async () => {
      await pool.connect(profile("web"));
      const calls = Array.from({ length: 7 }, () => pool.exec("web", { command: "sleep 30", timeoutMs: 5_000 }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(server.openExec() <= 6);
      assert.ok(server.openExec() >= 1);
      await pool.close();
      await Promise.allSettled(calls);
    });

    it("中止后远端的 sleep 不再有机会输出", async () => {
      await pool.connect(profile("web"));
      const controller = new AbortController();
      const pending = pool.exec("web", { command: "sleep 30", signal: controller.signal, timeoutMs: 5_000 });
      setTimeout(() => controller.abort(), 30);
      const result = await pending;
      assert.equal(result.stdout.includes("running"), true);
      assert.equal(result.stdout.includes("SHOULD_NOT"), false);
      assert.equal(result.exitCode, null);
    });

    it("空闲到期后连接被关掉", async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await pool.connect(profile("idle"));
      await new Promise((resolve) => setTimeout(resolve, 120));
      await assert.rejects(pool.exec("idle", { command: "echo hi" }), /还没有连接/);
    });
});

describe("端口占用", () => {
  it("测试服务器能拿到空闲端口", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    probe.close();
    assert.ok(true);
  });
});
