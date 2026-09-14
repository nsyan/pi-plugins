// test/scan-ai.test.ts —— v1.3.0 AI 扫描：候选校验（防幻觉）+ 文件树收集
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCandidates } from "../src/core/scan/validate.js";
import { collectTree } from "../src/core/scan/tree.js";
import { resolveRoot, walk, MAX_DEPTH } from "../src/core/scan/walker.js";
import { assessSourceTrust, envOf } from "../src/core/scan/trust.js";
import path from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("validateCandidates（AI 候选校验/防幻觉）", () => {
  const existing = new Set<string>(["old-conn"]);

  it("accepts a well-formed pg candidate and fills defaults", () => {
    const { candidates, rejected } = validateCandidates([
      { dialectId: "postgresql", host: "10.2.12.50", port: 15432, database: "zt_gacydmx", username: "postgres", password: "x", source: "application.yml" },
    ], existing);
    assert.equal(rejected.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "ready");
    assert.equal(candidates[0].partial.name, "postgresql-10.2.12.50-zt_gacydmx");
    assert.equal(candidates[0].source, "application.yml");
  });

  it("rejects unknown dialect (hallucinated type)", () => {
    const { candidates, rejected } = validateCandidates([{ dialectId: "oracle9i", host: "h" }], existing);
    assert.equal(candidates.length, 0);
    assert.match(rejected[0], /未知数据库类型/);
  });

  it("rejects url that the claimed dialect cannot parse (hallucination guard)", () => {
    const { candidates, rejected } = validateCandidates([
      { dialectId: "mysql", host: "1.2.3.4", url: "jdbc:postgresql://10.0.0.1:5432/db" },
      { dialectId: "redis", host: "h", url: "redis://x:${PORT:6379}/0" },
    ], existing);
    assert.equal(candidates.length, 0);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0], /无法被 mysql 方言解析/);
  });

  it("url wins over claimed fields (parsed values normalized in)", () => {
    const { candidates } = validateCandidates([
      { dialectId: "postgresql", host: "wrong-host", port: 1, url: "jdbc:postgresql://10.2.12.50:15432/zt?currentSchema=public", username: "u", password: "p" },
    ], existing);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].partial.host, "10.2.12.50");
    assert.equal(candidates[0].partial.port, 15432);
    assert.equal(candidates[0].partial.database, "zt");
  });

  it("marks missing required fields as incomplete per dialect", () => {
    const { candidates } = validateCandidates([
      { dialectId: "redis", host: "10.2.16.78", port: 31541 },                      // 缺 password
      { dialectId: "mongodb", host: "h", port: 27017 },                             // 无必缺（账号/库可选）
      { dialectId: "neo4j", host: "h", port: 7687 },                                // 缺 username/password
    ], existing);
    const [redis, mongo, neo] = candidates;
    assert.deepEqual(redis.missing, ["password"]);
    assert.equal(mongo.status, "ready");
    assert.deepEqual(neo.missing, ["username", "password"]);
  });

  it("marks name collision as exists", () => {
    const { candidates } = validateCandidates([
      { dialectId: "redis", name: "old-conn", host: "h", port: 6379, password: "x" },
    ], existing);
    assert.equal(candidates[0].status, "exists");
  });

  it("rejects missing host and bad port", () => {
    const { rejected } = validateCandidates([
      { dialectId: "redis", port: 6379 },
      { dialectId: "redis", host: "h", port: 99999, password: "x" },
      "not-an-object",
    ], existing);
    assert.equal(rejected.length, 3);
    assert.match(rejected[0], /缺 host/);
    assert.match(rejected[1], /port 非法/);
  });

  it("supports password as placeholder string from model extraction", () => {
    const { candidates } = validateCandidates([
      { dialectId: "dm", host: "10.2.12.50", port: 32036, database: "x", username: "SYSDBA", password: "${DB-PASSWORD:real}" },
    ], existing);
    assert.equal(candidates[0].status, "ready");
  });
});

describe("assessSourceTrust（来源可信度：能连通 ≠ 属于当前环境）", () => {
  it("含远端检索证据（dataId/URL/显式「远端」）→ high", () => {
    const [t] = assessSourceTrust(["远端 Nacos dataId=workflow.yaml（https://nacos.corp/nacos/v1/cs/configs）"]);
    assert.equal(t.level, "high");
    assert.match(t.reasons[0], /远端检索证据/);
  });

  it("仅自述配置中心产品名、无远端证据 → medium（签入副本会漂移，不升级为可信）", () => {
    const [t] = assessSourceTrust(["nacos:bmj-devops/workflow.yaml"]);
    assert.equal(t.level, "medium");
    assert.equal(t.env, "devops");
    assert.match(t.reasons.join(" "), /未写远端证据/);
  });

  it("本地文件无环境标识 → low", () => {
    const [t] = assessSourceTrust(["bmj-workflow/udp7-cloud-workflow/src/main/resources/config/workflow.yaml"]);
    assert.equal(t.level, "low");
    assert.equal(t.env, null);
  });

  it("本地文件带环境标识 → medium，并提示核对生效 profile", () => {
    const [t] = assessSourceTrust(["pom.xml#devops → application-devops.yml"]);
    assert.equal(t.level, "medium");
    assert.equal(t.env, "devops");
    assert.match(t.reasons.join(" "), /生效 profile/);
  });

  it("一批里出现多个环境 → 全部降为 low（至少一半不属于当前环境）", () => {
    const [a, b] = assessSourceTrust(["application-dev.yml", "application-devops.yml"]);
    assert.equal(a.level, "low");
    assert.equal(b.level, "low");
    assert.match(a.reasons[0], /多个环境（dev、devops）/);
  });

  it("生产环境附加只读提示，dev 不附加", () => {
    const [p] = assessSourceTrust(["application-prod.yml"]);
    assert.match(p.reasons.join(" "), /强制只读/);
    const [d] = assessSourceTrust(["application-dev.yml"]);
    assert.ok(!/强制只读/.test(d.reasons.join(" ")));
  });

  it("envOf 按分隔符整段比对（dev 不吃 devops；`group=devops` 也能识别）", () => {
    assert.equal(envOf("application-devops.yml"), "devops");
    assert.equal(envOf("lark-data-transfer.yaml"), null);
    assert.equal(envOf("src/test/resources/application.yml"), "test");
    assert.equal(envOf("dataId=workflow.yaml group=prod"), "prod");
    // 仅产品名自述（无远端证据）不足以升级：冒充 🟢 已不可能
    assert.equal(assessSourceTrust(["repo/config/nacos-stale.yaml"])[0].level, "medium");
  });

  it("validateCandidates 把 trust 挂到候选上", () => {
    const { candidates } = validateCandidates([
      { dialectId: "mysql", host: "10.2.16.78", port: 31579, database: "bmp-dev", username: "bmp", password: "x", source: "application-dev.yml" },
    ], new Set());
    assert.equal(candidates[0].trust.env, "dev");
    assert.equal(candidates[0].trust.level, "medium");
  });
});

describe("collectTree（文件树发现，语言无关）", () => {
  let dir = "";

  it("lists all-language files, ignores node_modules, sorted shallow-first", () => {
    // setup 必须在 it 内（node:test describe 体与 it 的执行时序不可靠）
    dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "dbtree-")); // cwd 子树内（resolveRoot 红线）
    mkdirSync(join(dir, "udp-be", "src", "main", "resources"), { recursive: true });
    mkdirSync(join(dir, "pyapp"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "udp-be", "src", "main", "resources", "application.yml"), "a: 1");
    writeFileSync(join(dir, "pyapp", "settings.py"), "DB = 'x'");
    writeFileSync(join(dir, "pyapp", "config.toml"), "[db]");
    writeFileSync(join(dir, "Dockerfile"), "FROM node");
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(dir, "go.mod"), "module x");
    try {
      const t = collectTree(dir, process.cwd());
      assert.equal(t.truncated, false);
      assert.ok(t.lines.includes("udp-be/src/main/resources/application.yml"));
      assert.ok(t.lines.includes("pyapp/settings.py"));
      assert.ok(t.lines.includes("pyapp/config.toml"));
      assert.ok(t.lines.includes("Dockerfile"));
      assert.ok(t.lines.includes("go.mod"));
      assert.ok(!t.lines.some((l) => l.includes("node_modules")));
      // 浅层在前
      assert.ok(t.lines.indexOf("Dockerfile") < t.lines.indexOf("udp-be/src/main/resources/application.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveRoot rejects out-of-anchor paths", () => {
    assert.throws(() => resolveRoot("/etc", process.cwd()), /out of scope/);
    assert.throws(() => resolveRoot("../..", process.cwd()), /out of scope/);
  });

  it("resolveRoot anchors on the passed anchor, not process.cwd()（pi-web：宿主 cwd ≠ 会话 cwd）", () => {
    const anchor = mkdtempSync(join(process.cwd(), "test", "fixtures", "anchor-"));
    try {
      // 会话 cwd 之外的一切（包括宿主 process.cwd() 自身）一律拒绝
      assert.throws(() => resolveRoot(process.cwd(), anchor), /out of scope/);
      // 会话 cwd 子树内放行，且相对路径以会话 cwd 为基准
      mkdirSync(join(anchor, "svc"), { recursive: true });
      assert.equal(resolveRoot("svc", anchor), join(anchor, "svc"));
      // 报错必须带上允许根目录，否则调用方（模型）无法自我纠正
      try {
        resolveRoot("/etc", anchor);
        assert.fail("should throw");
      } catch (err) {
        assert.ok((err as Error).message.includes(anchor), "报错信息应包含允许根目录");
      }
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("resolveRoot allows in-tree names starting with '..'（前缀假阳性回归）", () => {
    const anchor = mkdtempSync(join(process.cwd(), "test", "fixtures", "dotdot-"));
    try {
      mkdirSync(join(anchor, "..foo"), { recursive: true });
      assert.equal(resolveRoot("..foo", anchor), join(anchor, "..foo"));
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it("隐藏目录里的配置不再漏扫（.config/db.yml）", () => {
    const dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "hidden-"));
    try {
      mkdirSync(join(dir, ".config"), { recursive: true });
      writeFileSync(join(dir, ".config", "db.yml"), "url: x");
      assert.ok(collectTree(dir, process.cwd()).lines.includes(".config/db.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("软链：子树内跟随（真目录与别名两条路径都保留，结果与 readdir 顺序无关）", () => {
    const dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "link-"));
    const outside = mkdtempSync(join(process.cwd(), "test", "fixtures", "outside-"));
    try {
      mkdirSync(join(dir, "shared"), { recursive: true });
      writeFileSync(join(dir, "shared", "application.yml"), "url: inner");
      writeFileSync(join(outside, "secret.yml"), "url: outer");
      symlinkSync(join(dir, "shared"), join(dir, "link"), "dir");
      symlinkSync(outside, join(dir, "escape"), "dir");
      const t = collectTree(dir, process.cwd());
      // 回归：v1.3.1 用全局 realpath 去重，真目录与别名按 readdir 顺序互相吞掉（同一项目不同文件系统→不同树）
      assert.ok(t.lines.includes("shared/application.yml"), `真目录应在清单内: ${t.lines.join(",")}`);
      assert.ok(t.lines.includes("link/application.yml"), `子树内软链别名也应在清单内: ${t.lines.join(",")}`);
      assert.equal(collectTree(dir, process.cwd()).lines.join("|"), t.lines.join("|"), "同一目录重复扫描必须一致");
      assert.ok(!t.lines.some((l) => l.includes("secret.yml")), "子树外软链不应被读");
      assert.ok(!t.lines.some((l) => l.startsWith("escape/")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("文件树与 readdir 顺序无关（别名名在前 / 真目录名在前都不吞路径）", () => {
    for (const [realName, linkName] of [["zshared", "alink"], ["ashared", "zlink"]] as const) {
      const dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "order-"));
      try {
        mkdirSync(join(dir, realName), { recursive: true });
        writeFileSync(join(dir, realName, "application.yml"), "x");
        symlinkSync(join(dir, realName), join(dir, linkName), "dir");
        const lines = collectTree(dir, process.cwd()).lines;
        assert.ok(lines.includes(`${realName}/application.yml`), `${realName} 应保留: ${lines.join(",")}`);
        assert.ok(lines.includes(`${linkName}/application.yml`), `${linkName} 应保留: ${lines.join(",")}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("扫描根本身是软链且指向子树外 → 拒绝（字面路径合法 ≠ 真实路径合法）", () => {
    const anchor = mkdtempSync(join(process.cwd(), "test", "fixtures", "linkroot-"));
    const outside = mkdtempSync(join(process.cwd(), "test", "fixtures", "linkroot-out-"));
    try {
      writeFileSync(join(outside, "secret-application.yml"), "password: x");
      symlinkSync(outside, join(anchor, "dbconf"), "dir");
      // 回归：v1.3.1 只比对「root 的 realpath 与子项」，扫描根本身是软链时自我授权，子树外目录被列出
      assert.throws(() => resolveRoot("dbconf", anchor), /out of scope/);
      assert.throws(() => collectTree("dbconf", anchor), /out of scope/);
    } finally {
      rmSync(anchor, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("软链环不死循环（a/self -> a）", () => {
    const dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "cycle-"));
    try {
      mkdirSync(join(dir, "a"), { recursive: true });
      writeFileSync(join(dir, "a", "application.yml"), "url: x");
      symlinkSync(join(dir, "a"), join(dir, "a", "self"), "dir");
      assert.ok(collectTree(dir, process.cwd()).lines.includes("a/application.yml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("软链文件名不带配置后缀时按目标名归入配置段（0-link -> conf/app.yml）", () => {
    const dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "linkcfg-"));
    try {
      mkdirSync(join(dir, "conf"), { recursive: true });
      writeFileSync(join(dir, "conf", "app.yml"), "url: x");
      writeFileSync(join(dir, "a-real.yml"), "url: y");
      // 链接名排序最靠前：若只按链接名判配置，它会落入普通文件段（排在所有配置之后）
      symlinkSync(join(dir, "conf", "app.yml"), join(dir, "0-link"), "file");
      const files = walk(dir).files;
      assert.equal(files[0], join(dir, "0-link"), `应按目标名识别为配置（配置段优先）: ${files.join(",")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveRoot 对不存在的路径给出可诊断错误", () => {
    assert.throws(() => resolveRoot("no-such-dir", process.cwd()), /does not exist/);
  });

  it("超过 MAX_DEPTH 时如实上报 depthCapped（不静默漏扫）", () => {
    const dir = mkdtempSync(join(process.cwd(), "test", "fixtures", "deep-"));
    try {
      const deep = join(dir, ...Array.from({ length: MAX_DEPTH + 2 }, (_, i) => `d${i}`));
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "application.yml"), "url: deep");
      const t = collectTree(dir, process.cwd());
      assert.equal(t.depthCapped, true);
      assert.ok(!t.lines.some((l) => l.endsWith("application.yml")), "超深文件确实未收录");
      // 浅树不应误报（单独建目录：此时上面那个深目录还在）
      const shallow = mkdtempSync(join(process.cwd(), "test", "fixtures", "shallow-"));
      try {
        writeFileSync(join(shallow, "application.yml"), "a: 1");
        assert.equal(collectTree(shallow, process.cwd()).depthCapped, false, "浅树不应误报");
      } finally {
        rmSync(shallow, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
