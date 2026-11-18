import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSshConfig } from "../src/scan/ssh-config.js";

const sample = `
# comment
Host *
  User nobody

Host web jump
  HostName 10.0.0.21
  User deploy
  Port 2222
  IdentityFile ~/.ssh/web
  IdentityFile ~/.ssh/second
  ProxyJump bastion

Host "quoted host"
  HostName "10.0.0.22"

Host bastion
  HostName bastion.example
  PKCS11Provider /usr/lib/libykcs11.so
`;

describe("parseSshConfig", () => {
  const hosts = parseSshConfig(sample);

  it("跳过通配，拆开具体别名", () => {
    assert.deepEqual(hosts.map((host) => host.name), ["web", "quoted host", "bastion"]);
    assert.equal(hosts.some((host) => host.user === "nobody"), false);
  });

  it("保留第一把密钥，并标出 ssh2 做不到的跳转", () => {
    assert.equal(hosts[0].hostName, "10.0.0.21");
    assert.equal(hosts[0].port, 2222);
    assert.equal(hosts[0].identityFile, "~/.ssh/web");
    assert.equal(hosts[0].proxyJump, "bastion");
    assert.equal(hosts[0].needsOpenSsh, true);
  });

  it("去掉引号，安全钥匙也归到系统 ssh", () => {
    assert.equal(hosts[1].hostName, "10.0.0.22");
    assert.equal(hosts[2].needsOpenSsh, true);
  });
});
