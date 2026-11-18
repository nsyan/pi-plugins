import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapSudo, wrapWithWatchdog } from "../src/core/guard.js";

describe("看门狗脚本", () => {
  it("用 $- 判断 job control，不看 set -m 的退出码", () => {
    // dash 下 `set -m` 返回 0 但 job control 没开启，靠退出码判断会走错分支
    const script = wrapWithWatchdog("echo hi");
    assert.equal(script.includes('case "$-" in'), true);
    assert.equal(script.includes("set -m"), false);
  });

  it("没有 job control 时用 setsid 建独立进程组", () => {
    const script = wrapWithWatchdog("sleep 1");
    assert.equal(script.includes("setsid sh -c"), true);
  });

  it("既没 job control 也没 setsid 时明确警告并放弃组杀", () => {
    const script = wrapWithWatchdog("sleep 1");
    assert.equal(script.includes("超时只能关掉通道，进程组不会被杀"), true);
    assert.equal(script.includes("PI_SSH_NO_GROUP=1"), true);
  });

  it("通道在 fd 3，命令的 stdin 指到 /dev/null", () => {
    const script = wrapWithWatchdog("cat");
    const lines = script.split("\n");
    assert.equal(lines.indexOf("exec 3<&0") < lines.indexOf("exec 0</dev/null"), true);
  });

  it("watcher 在后台，不阻塞通道 EOF", () => {
    assert.equal(wrapWithWatchdog("true").includes(") >/dev/null 2>&1 &"), true);
  });
});

describe("sudo 包装", () => {
  it("密码经 heredoc 进 sudo，不进命令参数", () => {
    const script = wrapSudo("systemctl restart app");
    assert.equal(script.includes("sudo -S -p '' -- systemctl restart app"), true);
    assert.equal(script.includes("<<PI_SSH_PW_END"), true);
    // 密码变量只出现在 heredoc 体内，不出现在 sudo 命令行上
    const sudoLine = script.split("\n").find((line) => line.includes("sudo -S"))!;
    assert.equal(sudoLine.includes("$PI_SSH_PW"), false);
  });

  it("heredoc 挂在最外层调用上，$PI_SSH_PW 才到得了内层", () => {
    // 放进 sh -c '...' 的引号里，内层 shell 拿不到未 export 的变量
    const script = wrapSudo("id -u");
    const setsidLine = script.split("\n").find((line) => line.includes("setsid sh -c"))!;
    assert.equal(setsidLine.includes("$PI_SSH_PW"), false);
    assert.equal(setsidLine.endsWith("<<PI_SSH_PW_END &"), true);
  });

  it("结束后清掉内存里的密码变量", () => {
    assert.equal(wrapSudo("id -u").includes("unset PI_SSH_PW"), true);
  });
});
