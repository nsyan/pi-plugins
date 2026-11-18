import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntime, selectHost } from "../src/runtime.js";
import { ConfirmRejectedError, PolicyDeniedError, type HostFile, type HostProfile } from "../src/core/types.js";

function host(name: string, tags?: string[]): HostProfile {
  return {
    id: name,
    name,
    transport: "ssh2",
    host: "127.0.0.1",
    user: "deploy",
    auth: { kind: "key" },
    strictHostKey: false,
    tags,
    createdAt: "2026-11-18T00:00:00.000Z",
  };
}

function file(hosts: HostProfile[], readonly = false): HostFile {
  return {
    hosts: Object.fromEntries(hosts.map((item) => [item.name, item])),
    policy: { readonly, confirm: "destructive" },
  };
}

describe("selectHost", () => {
  it("一台时可以省略，两台时必须点名", () => {
    assert.equal(selectHost(file([host("web")])).name, "web");
    assert.throws(() => selectHost(file([host("web"), host("db")])), PolicyDeniedError);
    assert.equal(selectHost(file([host("web"), host("db")]), "db").name, "db");
  });
});

describe("runtime 确认", () => {
  const runtime = createRuntime({ hosts: () => file([host("web")]) });

  it("生产主机的破坏性命令没有 reason 就拒绝", async () => {
    const prod = createRuntime({ hosts: () => file([host("web", ["prod"])]) });
    await assert.rejects(prod.exec({ command: "rm -rf /tmp/x", ui: { confirm: async () => true } }), /reason/);
  });

  it("生产主机不能授予写授权", () => {
    const prod = createRuntime({ hosts: () => file([host("web", ["prod"])]) });
    assert.throws(() => prod.grantWrite("web", 10), /生产主机/);
  });

  it("只读模式在连接前拒绝破坏性命令", async () => {
    const readonly = createRuntime({ hosts: () => file([host("web")], true) });
    await assert.rejects(readonly.exec({ command: "rm -rf /tmp/x" }), PolicyDeniedError);
  });

  it("用户拒绝后不执行，并写明不要换写法重试", async () => {
    await assert.rejects(
      runtime.exec({
        command: "rm -rf /tmp/x",
        ui: { confirm: async () => false },
      }),
      (error: Error) => {
        assert.equal(error instanceof ConfirmRejectedError, true);
        assert.match(error.message, /不要换一种写法重试/);
        return true;
      },
    );
  });

  });
