import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backupLocation, discardPartialCommand, healthLoopCommand, planRelease, rejectArchiveMembers, staleBackups } from "../src/core/deploy.js";
import { withinRoot } from "../src/core/guard.js";

describe("withinRoot", () => {
  it("只接受部署根目录里面的路径", () => {
    assert.equal(withinRoot("/srv/app", "/srv/app/releases/1"), true);
    assert.equal(withinRoot("/srv/app", "/srv/app"), false);
    assert.equal(withinRoot("/srv/app", "/srv/app-other/file"), false);
    assert.equal(withinRoot("/srv/app", "/srv/app/releases/../../etc/passwd"), false);
  });
});

describe("planRelease", () => {
  it("生成 release、current、shared 和上传中的 part", () => {
    const plan = planRelease({ root: "/srv/app" }, "20261118", "app.tar.gz");
    assert.equal(plan.releaseDir, "/srv/app/releases/20261118");
    assert.equal(plan.currentLink, "/srv/app/current");
    assert.equal(plan.sharedDir, "/srv/app/shared");
    assert.equal(plan.partPath, "/srv/app/releases/20261118.part");
    assert.equal(plan.releasesDir, "/srv/app/releases");
  });

  it("自定义目录名也不能逃出部署根", () => {
    assert.throws(() => planRelease({ root: "/srv/app", releasesDir: "../../etc" }, "1", "app.tar.gz"), /越出部署根目录/);
  });
});

describe("backupLocation", () => {
  it("部署根内收进备份目录，根外留在原目录", () => {
    assert.equal(backupLocation("/srv/app/current/app.jar", "/srv/app", 5), "/srv/app/.pi-ssh-backup/current/app.jar.5");
    assert.equal(backupLocation("/tmp/app.jar", "/srv/app", 5), "/tmp/app.jar.bak.5");
  });

  it("同一路径只留最近 3 份", () => {
    const stale = staleBackups(["app.jar.1", "app.jar.3", "app.jar.2", "other.1", "app.jar.bak.9"], "app.jar", 3);
    assert.deepEqual(stale, ["app.jar.1"]);
  });
});

describe("healthLoopCommand", () => {
  it("在预算内循环，并把最后一轮输出留给失败报告", () => {
    const script = healthLoopCommand("curl -fsS localhost", 5);
    assert.equal(script.includes("while [ \"$i\" -lt 5 ]"), true);
    assert.equal(script.includes("if { curl -fsS localhost; } >/dev/null 2>&1; then exit 0; fi"), true);
    // 循环结束后再裸跑一次，让 stdout 带上失败原因
    assert.equal(script.endsWith("curl -fsS localhost\nexit 1"), true);
  });

  it("预算至少一轮", () => {
    assert.equal(healthLoopCommand("false", 0).includes('-lt 1 ]'), true);
  });
});

describe("rejectArchiveMembers", () => {
  it("拒绝绝对路径、反斜杠和逃出目标目录的成员", () => {
    const rejected = rejectArchiveMembers(["dist/index.html", "/etc/passwd", "../secret", "ok/../../secret"], "/srv/app/releases/1");
    assert.deepEqual(rejected, ["/etc/passwd", "../secret", "ok/../../secret"]);
  });

  it("目录自身和当前目录不算逃逸", () => {
    assert.deepEqual(rejectArchiveMembers(["./dist/app.js", "dist/", ""], "/srv/app/releases/1"), []);
  });

  it("尾部空行不算成员，否则任何合法包都被判越界", () => {
    // tar -tzf 输出总以换行结尾，split 之后最后一项是空串
    assert.deepEqual(rejectArchiveMembers("dist/app.js\ndist/assets/\n".split(/\n/), "/srv/app/releases/1"), []);
  });
});

describe("rejectArchiveMembers 空行", () => {
  it("tar -tzf 末尾空行不算越界成员", () => {
    // tar 输出总以换行结尾，split 后最后一项是空串
    const listed = "ok.txt\napp/\napp/i.html\n".split(/\n/);
    assert.deepEqual(rejectArchiveMembers(listed, "/srv/app/releases/1"), []);
  });

  it("真越界成员照旧被点名，不被空行掩盖", () => {
    const listed = "ok.txt\n../escape\n/etc/passwd\n".split(/\n/);
    assert.deepEqual(rejectArchiveMembers(listed, "/srv/app/releases/1"), ["../escape", "/etc/passwd"]);
  });
});

describe("staleBackups 与备份目录", () => {
  it("部署根内收进 .pi-ssh-backup，根外留在同目录", () => {
    assert.equal(backupLocation("/srv/app/web/index.html", "/srv/app", 123), "/srv/app/.pi-ssh-backup/web/index.html.123");
    assert.equal(backupLocation("/tmp/x.txt", "/srv/app", 123), "/tmp/x.txt.bak.123");
  });
});

describe("discardPartialCommand", () => {
  const plan = planRelease({ root: "/srv/app" }, "20261118-082236", "rel.tar.gz");

  it("只删本次 release 目录与它的 .part，不碰 releases/ 里其他版本", () => {
    const cmd = discardPartialCommand(plan);
    assert.equal(cmd, "rm -rf '/srv/app/releases/20261118-082236' '/srv/app/releases/20261118-082236.part'");
    // 不能出现通配或上层目录：多删一个就等于毁掉回滚点
    assert.equal(cmd.includes("*"), false);
    assert.equal(cmd.includes("releases'"), false);
  });

  it("自定义 releasesDir 时跟着走", () => {
    const custom = planRelease({ root: "/srv/app", releasesDir: "versions" }, "v1", "a.tar.gz");
    assert.equal(discardPartialCommand(custom), "rm -rf '/srv/app/versions/v1' '/srv/app/versions/v1.part'");
  });

  it("路径含单引号时被正确转义，不会拼出额外命令", () => {
    const tricky = planRelease({ root: "/srv/it's" }, "v1", "a.tar.gz");
    const cmd = discardPartialCommand(tricky);
    assert.equal(cmd.includes(`'/srv/it'"'"'s/releases/v1'`), true);
  });
});
