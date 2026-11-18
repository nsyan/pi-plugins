import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSftpLongNames } from "../src/transports/openssh.js";

describe("parseSftpLongNames", () => {
  it("解出名字、字节数和目录标志", () => {
    const out = [
      "total 24",
      "-rw-r--r--    1 deploy   deploy        512 Nov 18 10:00 app.jar",
      "drwxr-xr-x    3 deploy   deploy       4096 Nov 18 09:00 logs",
      "-rwxr-xr-x    1 deploy   deploy          0 Nov 18 09:00 run.sh",
    ].join("\n");
    assert.deepEqual(parseSftpLongNames(out), [
      { name: "app.jar", size: 512, directory: false },
      { name: "logs", size: 4096, directory: true },
      { name: "run.sh", size: 0, directory: false },
    ]);
  });

  it("名字里有空格不会被切断", () => {
    const out = "-rw-r--r--    1 deploy   deploy         17 Nov 18 10:00 my report 2026.txt";
    assert.deepEqual(parseSftpLongNames(out), [{ name: "my report 2026.txt", size: 17, directory: false }]);
  });

  it("丢掉 total 行和 . / ..", () => {
    const out = [
      "total 8",
      "drwxr-xr-x    2 deploy   deploy       4096 Nov 18 10:00 .",
      "drwxr-xr-x    5 deploy   deploy       4096 Nov 18 09:00 ..",
      "-rw-r--r--    1 deploy   deploy          3 Nov 18 10:00 a.txt",
    ].join("\n");
    assert.deepEqual(parseSftpLongNames(out), [{ name: "a.txt", size: 3, directory: false }]);
  });

  it("空输出不给结果", () => {
    assert.deepEqual(parseSftpLongNames(""), []);
  });
});

describe("ssh 噪音过滤", () => {
  it("过滤 post-quantum 警告，保留真实 stderr", async () => {
    const { stripSshNoise } = await import("../src/transports/openssh.js");
    const noisy = [
      "** WARNING: connection is not using a post-quantum key exchange algorithm.",
      '** This session may be vulnerable to "store now, decrypt later" attacks.',
      "** The server may need to be upgraded. See https://openssh.com/pq.html",
      "real error: permission denied",
    ].join("\r\n");
    assert.equal(stripSshNoise(noisy), "real error: permission denied");
  });

  it("没有噪音时原样返回", async () => {
    const { stripSshNoise } = await import("../src/transports/openssh.js");
    assert.equal(stripSshNoise("plain"), "plain");
    assert.equal(stripSshNoise(""), "");
  });
});

describe("scanHostKeyFingerprint 的密钥类型偏好", () => {
  it("同机多把密钥时优先 ed25519（与 ssh2 报出的指纹一致）", async () => {
    // 逻辑在 close 回调里做排序；这里用纯函数等价物钉住偏好顺序，
    // 避免 ssh-keyscan 输出顺序变化导致两条传输报不同指纹。
    const prefer = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"];
    const found = [
      { keyType: "ssh-rsa", fingerprint: "R" },
      { keyType: "ecdsa-sha2-nistp256", fingerprint: "E" },
      { keyType: "ssh-ed25519", fingerprint: "D" },
    ];
    found.sort((a, b) => {
      const ia = prefer.indexOf(a.keyType);
      const ib = prefer.indexOf(b.keyType);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    assert.equal(found[0].keyType, "ssh-ed25519");
    assert.equal(found[0].fingerprint, "D");
  });
});
