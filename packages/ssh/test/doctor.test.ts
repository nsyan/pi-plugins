import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { doctorLines, which } from "../src/core/doctor.js";

function fakeBin(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ssh-doctor-"));
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

describe("which", () => {
  it("按 PATH 找可执行文件，不写死 /usr/bin", () => {
    const dir = fakeBin(["ssh", "scp", "sftp"]);
    assert.equal(which("ssh", { PATH: dir }), join(dir, "ssh"));
    assert.equal(which("不存在的命令", { PATH: dir }), undefined);
  });

  it("PATH 为空时找不到", () => {
    assert.equal(which("ssh", { PATH: "" }), undefined);
  });

  it("不可执行的文件不算命中", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ssh-doctor-"));
    writeFileSync(join(dir, "ssh"), "x");
    chmodSync(join(dir, "ssh"), 0o644);
    assert.equal(which("ssh", { PATH: dir }), undefined);
  });
});

describe("doctorLines", () => {
  const savedPath = process.env.PATH;

  it("openssh 三件套齐全时报可用", () => {
    const dir = fakeBin(["ssh", "scp", "sftp"]);
    process.env.PATH = dir;
    try {
      const lines = doctorLines();
      const openssh = lines.find((line) => line.includes("openssh"));
      assert.ok(openssh?.includes("可用"), `应报可用，实际：${openssh}`);
      assert.ok(openssh?.includes(join(dir, "ssh")), "应给出实际路径");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("缺 sftp 时点名缺什么，不含糊报可用", () => {
    const dir = fakeBin(["ssh", "scp"]);
    process.env.PATH = dir;
    try {
      const lines = doctorLines();
      const openssh = lines.find((line) => line.includes("openssh"));
      assert.ok(openssh?.includes("缺 sftp"), `应点名缺 sftp，实际：${openssh}`);
      assert.ok(openssh?.includes("不可用"), `应报不可用，实际：${openssh}`);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("三个都没有时建议改用 ssh2", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ssh-empty-"));
    mkdirSync(dir, { recursive: true });
    process.env.PATH = dir;
    try {
      const lines = doctorLines();
      const openssh = lines.find((line) => line.includes("openssh"));
      assert.ok(openssh?.includes("ssh、scp、sftp"), `应列全缺失项，实际：${openssh}`);
      assert.ok(openssh?.includes("ssh2"), `应给出 ssh2 出路，实际：${openssh}`);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
