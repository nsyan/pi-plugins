// test/config-atomic.test.ts —— 配置落盘回归（v1.3.7）
//
// 背景：旧 saveConfigs 直接 writeFileSync 原文件，读侧解析失败时静默返回空数组。
// 组合起来的后果是：写一半崩溃/磁盘满 → 文件截断 → loadConfigs() 得到 [] →
// 用户再保存一次就把全部连接（含明文密码）覆盖掉，且没有任何提示。
//
// CONFIG_FILE 在模块加载时按 homedir 求值，所以这里用子进程 + 临时 HOME 隔离，
// 不碰用户真实的 ~/.pi/agent/db-configs.json。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

const CONN = (name: string) => ({
  id: name, name, type: "postgresql", host: "h", port: 5432,
  username: "u", password: "p", database: "d", createdAt: "2026-01-01T00:00:00Z",
});

describe("saveConfigs / loadConfigsStrict", () => {
  it("原子写：保存后文件权限 0600、内容可解析、无残留 .tmp", () => {
    const home = mkdtempSync(join(tmpdir(), "db-cfg-atomic-"));
    try {
      const script = `
        import { saveConfigs, loadConfigs, CONFIG_FILE } from "./src/config.ts";
        import { statSync, readdirSync } from "node:fs";
        saveConfigs([${JSON.stringify(CONN("a"))}]);
        const st = statSync(CONFIG_FILE);
        console.log(JSON.stringify({
          mode: st.mode & 0o777,
          loaded: loadConfigs().map(c => c.name),
          tmp: readdirSync(require("node:path").dirname(CONFIG_FILE)).filter(n => n.endsWith(".tmp")),
        }));
      `;
      const out = execFileSync("npx", ["tsx", "-e", script], {
        cwd: pkgDir, env: { ...process.env, HOME: home }, encoding: "utf-8",
      });
      const r = JSON.parse(out.trim().split("\n").pop()!);
      assert.equal(r.mode, 0o600);
      assert.deepEqual(r.loaded, ["a"]);
      assert.deepEqual(r.tmp, [], "不应留下 .tmp 文件");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("内容未变时跳过写盘（mtime 不变，避免无谓 IO）", () => {
    const home = mkdtempSync(join(tmpdir(), "db-cfg-skip-"));
    try {
      const script = `
        import { saveConfigs, CONFIG_FILE } from "./src/config.ts";
        import { statSync } from "node:fs";
        const data = [${JSON.stringify(CONN("a"))}];
        saveConfigs(data);
        const t1 = statSync(CONFIG_FILE).mtimeMs;
        saveConfigs(data);
        const t2 = statSync(CONFIG_FILE).mtimeMs;
        console.log(JSON.stringify({ same: t1 === t2 }));
      `;
      const out = execFileSync("npx", ["tsx", "-e", script], {
        cwd: pkgDir, env: { ...process.env, HOME: home }, encoding: "utf-8",
      });
      assert.equal(JSON.parse(out.trim().split("\n").pop()!).same, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("文件损坏时 loadConfigsStrict 抛错（而不是返回空数组）", () => {
    const home = mkdtempSync(join(tmpdir(), "db-cfg-broken-"));
    try {
      const dir = join(home, ".pi", "agent");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "db-configs.json"), '[{"name":"a","type":"postgresql"', "utf-8");
      const script = `
        import { loadConfigsStrict, loadConfigs } from "./src/config.ts";
        let strictError = "";
        try { loadConfigsStrict(); } catch (e) { strictError = e.message; }
        console.log(JSON.stringify({ strictError, lenient: loadConfigs().length }));
      `;
      const out = execFileSync("npx", ["tsx", "-e", script], {
        cwd: pkgDir, env: { ...process.env, HOME: home }, encoding: "utf-8",
      });
      const r = JSON.parse(out.trim().split("\n").pop()!);
      assert.match(r.strictError, /不是合法 JSON/);
      assert.match(r.strictError, /已中止写入/);
      // 宽松读仍返回空（只读展示路径不因此崩溃），但写盘路径已由 strict 挡住
      assert.equal(r.lenient, 0);
      // 原文件保持原样，未被任何保存动作覆盖
      assert.match(readFileSync(join(dir, "db-configs.json"), "utf-8"), /"name":"a"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("顶层不是数组时同样抛错", () => {
    const home = mkdtempSync(join(tmpdir(), "db-cfg-shape-"));
    try {
      const dir = join(home, ".pi", "agent");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "db-configs.json"), '{"hosts":[]}', "utf-8");
      const script = `
        import { loadConfigsStrict } from "./src/config.ts";
        let msg = "";
        try { loadConfigsStrict(); } catch (e) { msg = e.message; }
        console.log(JSON.stringify({ msg }));
      `;
      const out = execFileSync("npx", ["tsx", "-e", script], {
        cwd: pkgDir, env: { ...process.env, HOME: home }, encoding: "utf-8",
      });
      assert.match(JSON.parse(out.trim().split("\n").pop()!).msg, /顶层不是数组/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("导出文件权限 0600（查询结果可能含敏感数据）", () => {
    const home = mkdtempSync(join(tmpdir(), "db-cfg-export-"));
    try {
      const script = `
        import { writeQueryExport } from "./src/config.ts";
        import { statSync } from "node:fs";
        const r = writeQueryExport(["id","name"], [[1,"张三"]], "t");
        console.log(JSON.stringify({
          csv: statSync(r.csvPath).mode & 0o777,
          json: statSync(r.jsonPath).mode & 0o777,
        }));
      `;
      const out = execFileSync("npx", ["tsx", "-e", script], {
        cwd: pkgDir, env: { ...process.env, HOME: home }, encoding: "utf-8",
      });
      const r = JSON.parse(out.trim().split("\n").pop()!);
      assert.equal(r.csv, 0o600);
      assert.equal(r.json, 0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
