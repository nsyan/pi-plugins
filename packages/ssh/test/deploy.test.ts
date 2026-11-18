import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backupLocation, planRelease, rejectArchiveMembers, staleBackups } from "../src/core/deploy.js";
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

describe("rejectArchiveMembers", () => {
  it("拒绝绝对路径、反斜杠和逃出目标目录的成员", () => {
    const rejected = rejectArchiveMembers(["dist/index.html", "/etc/passwd", "../secret", "ok/../../secret"], "/srv/app/releases/1");
    assert.deepEqual(rejected, ["/etc/passwd", "../secret", "ok/../../secret"]);
  });

  it("目录自身和当前目录不算逃逸", () => {
    assert.deepEqual(rejectArchiveMembers(["./dist/app.js", "dist/", ""], "/srv/app/releases/1"), [""]);
  });
});
