import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadHosts, saveHosts } from "../src/core/config.js";
import { getSecret, putSecret } from "../src/core/secrets.js";
import {
  addHostInteractive,
  auditLines,
  authSummary,
  buildHostList,
  buildProfile,
  confirmLabel,
  deployLayoutLines,
  describeTestResult,
  editHostInteractive,
  effectivePolicy,
  updateCredentialInteractive,
  handleSshCommand,
  hostDetailLines,
  hostSummaryLine,
  parseHostSpec,
  policyLines,
  withProdTag,
  type PanelDeps,
} from "../src/ui/panel.js";
import type { HostFile, HostProfile } from "../src/core/types.js";

function host(name: string, extra: Partial<HostProfile> = {}): HostProfile {
  return {
    id: name,
    name,
    transport: "auto",
    host: "10.0.0.21",
    user: "deploy",
    auth: { kind: "key", privateKeyPath: "~/.ssh/id_ed25519" },
    createdAt: "2026-11-18T00:00:00.000Z",
    ...extra,
  };
}

function file(hosts: HostProfile[], activeHost?: string): HostFile {
  return { hosts: Object.fromEntries(hosts.map((item) => [item.name, item])), activeHost };
}

describe("parseHostSpec", () => {
  it("解析 user@host:port", () => {
    assert.deepEqual(parseHostSpec("deploy@10.0.0.21:2222"), { user: "deploy", host: "10.0.0.21", port: 2222 });
  });

  it("省略 user 与端口", () => {
    assert.deepEqual(parseHostSpec("10.0.0.21"), { user: undefined, host: "10.0.0.21", port: undefined });
  });

  it("支持 IPv6 方括号形态", () => {
    assert.deepEqual(parseHostSpec("root@[::1]:22"), { user: "root", host: "::1", port: 22 });
  });

  it("端口越界、空串、含空格都拒绝", () => {
    assert.equal(parseHostSpec("host:70000"), null);
    assert.equal(parseHostSpec(""), null);
    assert.equal(parseHostSpec("a b"), null);
  });
});

describe("withProdTag", () => {
  it("加上和去掉 prod，其余标签保留", () => {
    assert.deepEqual(withProdTag(["db"], true), ["db", "prod"]);
    assert.deepEqual(withProdTag(["db", "prod"], false), ["db"]);
  });

  it("清空后返回 undefined 而不是空数组", () => {
    assert.equal(withProdTag(["prod"], false), undefined);
    assert.equal(withProdTag(undefined, false), undefined);
  });
});

describe("hostSummaryLine", () => {
  it("标出活动主机、prod 与部署根", () => {
    const prod = host("web", { tags: ["prod"], port: 2222, deploy: { root: "/srv/app" } });
    const line = hostSummaryLine(prod, file([prod], "web"));
    assert.match(line, /●活动/);
    assert.match(line, /prod/);
    assert.match(line, /deploy@10\.0\.0\.21:2222/);
    assert.match(line, /部署根 \/srv\/app/);
  });

  it("没有活动主机和标签时不加标记", () => {
    assert.equal(hostSummaryLine(host("db"), file([host("db")])), "db [auto] deploy@10.0.0.21");
  });
});

describe("buildHostList", () => {
  it("活动主机排最前，其余按名字排序", () => {
    const { list, map } = buildHostList(file([host("zeta"), host("web"), host("alpha")], "web"));
    assert.deepEqual(list.map((line) => line.split(" ")[0]), ["web", "alpha", "zeta"]);
    assert.equal(map.get(list[0]), "web");
  });
});

describe("authSummary", () => {
  it("密码只说有没有保存，不出现明文", () => {
    const profile = host("web", { auth: { kind: "password", secretRef: "file:/x/ssh-secrets.json#web" } });
    assert.equal(authSummary(profile, true), "密码（已保存）");
    assert.equal(authSummary({ ...profile, auth: { kind: "password" } }, false), "密码（未保存）");
  });

  it("密钥与 agent 各自成句", () => {
    assert.match(authSummary(host("web"), false), /密钥 ~\/\.ssh\/id_ed25519/);
    assert.equal(authSummary(host("web", { auth: { kind: "agent" } }), false), "ssh-agent");
  });
});

describe("hostDetailLines", () => {
  it("展示传输、认证、标签与部署布局", () => {
    const prod = host("web", { tags: ["prod"], deploy: { root: "/srv/app", restartCmd: "systemctl restart app" } });
    const lines = hostDetailLines(prod, file([prod], "web"), false).join("\n");
    assert.match(lines, /【传输】 auto（按 ~\/\.ssh\/config 选）/);
    assert.match(lines, /【标签】 prod/);
    assert.match(lines, /【活动主机】 是/);
    assert.match(lines, /重启 systemctl restart app/);
    assert.match(lines, /健康检查 （未配置/);
  });

  it("ftps 报加密方式，未配置部署时给出提示", () => {
    const lines = hostDetailLines(
      host("nas", { transport: "ftps", secure: "implicit", auth: { kind: "password" } }),
      file([]),
      true,
    ).join("\n");
    assert.match(lines, /隐式 TLS/);
    assert.match(lines, /未配置部署布局/);
  });
});

describe("deployLayoutLines", () => {
  it("缺布局时说明不能部署", () => {
    assert.deepEqual(deployLayoutLines(undefined), ["未配置部署布局（不能 ssh_deploy / release 回滚）"]);
  });
});

describe("policy", () => {
  it("缺省是关只读 + 仅破坏性确认（与 runtime.policyOf 一致）", () => {
    assert.deepEqual(effectivePolicy({ hosts: {} }), { readonly: false, confirm: "destructive" });
    assert.match(confirmLabel("destructive"), /仅破坏性/);
    assert.match(confirmLabel("write"), /写操作/);
    assert.match(confirmLabel("always"), /每次/);
  });

  it("policyLines 把当前策略读出来", () => {
    const lines = policyLines({ hosts: {}, policy: { readonly: true, confirm: "always" } }).join("\n");
    assert.match(lines, /只读模式：开/);
    assert.match(lines, /每次都确认/);
  });
});

describe("auditLines", () => {
  const rows = [
    { ts: "t1", tool: "ssh_exec", host: "web", danger: "read", summary: "只读命令", command: "ls -l /var/log" },
    { ts: "t2", tool: "ssh_put", host: "db", command: "a -> b", exitCode: 0 },
    { ts: "t3", tool: "ssh_exec", host: "web", command: "x".repeat(200) },
  ];

  it("按主机过滤并限制条数", () => {
    const lines = auditLines(rows, { host: "web", limit: 1 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /t3 ssh_exec web/);
  });

  it("长命令截断，退出码出现在行内", () => {
    const all = auditLines(rows, { limit: 10 });
    assert.match(all[1], /exit=0/);
    assert.ok(all[2].includes("…"));
    assert.ok(all[2].length < 140);
  });
});

describe("describeTestResult", () => {
  it("带传输、认证、指纹与延迟", () => {
    const line = describeTestResult({ ok: true, auth: "key", fingerprint: "SHA256:abc", latencyMs: 42, transport: "ssh2" });
    assert.equal(line, "✓ ssh2 key SHA256:abc 42ms");
  });
});

describe("buildProfile", () => {
  it("编辑时保留 id/createdAt/deploy/defaults，不被改地址抹掉", () => {
    const existing = host("web", { deploy: { root: "/srv/app" }, defaults: { timeoutSec: 30 }, tags: ["prod"] });
    const next = buildProfile({ name: "web", host: "10.0.0.99", user: "root", existing });
    assert.equal(next.id, existing.id);
    assert.equal(next.createdAt, existing.createdAt);
    assert.deepEqual(next.deploy, { root: "/srv/app" });
    assert.equal(next.defaults?.timeoutSec, 30);
    assert.equal(next.host, "10.0.0.99");
    assert.deepEqual(next.tags, ["prod"]);
  });

  it("换认证方式时清掉另一路的引用", () => {
    const keyed = host("web");
    const asPassword = buildProfile({
      name: "web",
      host: "10.0.0.21",
      user: "deploy",
      authKind: "password",
      secretRef: "file:/x#web",
      existing: keyed,
    });
    assert.equal(asPassword.auth.kind, "password");
    assert.equal(asPassword.auth.privateKeyPath, undefined);
    assert.equal(asPassword.auth.secretRef, "file:/x#web");
  });
});

// ── 交互层：用一个假的 ctx.ui 把面板流程跑一遍（不进单测的部分只测路由与写盘） ──

interface ScriptedUi {
  ctx: any;
  notes: string[];
  selects: (string | undefined)[];
  confirms: boolean[];
  inputs: (string | undefined)[];
}

function scriptedUi(options: {
  selects?: (string | undefined)[];
  confirms?: boolean[];
  inputs?: (string | undefined)[];
}): ScriptedUi {
  const notes: string[] = [];
  const selects = [...(options.selects ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const ctx = {
    mode: "rpc",
    ui: {
      notify: (message: string) => notes.push(message),
      select: async (_title: string, _options: string[]) => selects.shift(),
      confirm: async () => confirms.shift() ?? false,
      input: async () => inputs.shift(),
    },
  };
  return { ctx, notes, selects, confirms, inputs };
}

function tempDeps(overrides: Partial<PanelDeps> = {}): PanelDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-ssh-panel-"));
  const deps: PanelDeps = {
    runtime: {
      testHost: async () => ({ ok: true, auth: "key", fingerprint: "SHA256:x", latencyMs: 5 }),
      testProfile: async () => ({ ok: true, auth: "key", fingerprint: "SHA256:x", latencyMs: 5 }),
      grantWrite: () => undefined,
      exec: async () => ({ exitCode: 0, text: "ok" }),
    },
    confirmUi: () => ({}),
    readSecret: async () => "s3cret",
    configPath: join(dir, "ssh-hosts.json"),
    secretsPath: join(dir, "ssh-secrets.json"),
    auditPath: join(dir, "ssh-audit.jsonl"),
    ...overrides,
  };
  return Object.assign(deps, { dir });
}

describe("handleSshCommand 路由", () => {
  it("无参数打开面板：先给出菜单选项，返回即退出", async () => {
    const deps = tempDeps();
    const ui = scriptedUi({ selects: ["← 返回"] });
    let offered: readonly string[] = [];
    ui.ctx.ui.select = async (_title: string, options: readonly string[]) => {
      offered = options;
      return "← 返回";
    };
    await handleSshCommand("", ui.ctx, deps);
    assert.ok(offered.some((item) => item.includes("主机列表")));
    assert.ok(offered.some((item) => item.includes("策略")));
    assert.ok(offered.some((item) => item.includes("审计")));
  });

  it("/ssh ls 走 notify 而不是 select（与旧行为一致）", async () => {
    const deps = tempDeps();
    const ui = scriptedUi({});
    await handleSshCommand("ls", ui.ctx, deps);
    assert.match(ui.notes[0], /还没有主机/);
    assert.equal(ui.selects.length, 0);
  });

  it("/ssh config 循环到返回，改动落盘", async () => {
    const deps = tempDeps();
    const ui = scriptedUi({ selects: ["🔒 只读模式：关", "← 返回"] });
    await handleSshCommand("config", ui.ctx, deps);
    const { loadHosts } = await import("../src/core/config.js");
    assert.equal(loadHosts(deps.configPath!).policy?.readonly, true);
    assert.match(ui.notes.join("\n"), /只读模式：开/);
  });

  it("/ssh rm <名> 需要确认才删", async () => {
    const deps = tempDeps();
    const { saveHosts } = await import("../src/core/config.js");
    saveHosts(deps.configPath!, file([host("web")], "web"));
    const ui = scriptedUi({ confirms: [false] });
    await handleSshCommand("rm web", ui.ctx, deps);
    assert.ok(ui.notes.every((note) => !note.includes("已删除")));
    const ui2 = scriptedUi({ confirms: [true] });
    await handleSshCommand("rm web", ui2.ctx, deps);
    const { loadHosts } = await import("../src/core/config.js");
    assert.deepEqual(loadHosts(deps.configPath!).hosts, {});
  });

  it("/ssh use 切换与取消活动主机", async () => {
    const deps = tempDeps();
    const { saveHosts, loadHosts } = await import("../src/core/config.js");
    saveHosts(deps.configPath!, file([host("web"), host("db")]));
    await handleSshCommand("use web", scriptedUi({}).ctx, deps);
    assert.equal(loadHosts(deps.configPath!).activeHost, "web");
    await handleSshCommand("use web", scriptedUi({}).ctx, deps);
    assert.equal(loadHosts(deps.configPath!).activeHost, undefined);
  });

  it("/ssh grant 拒绝生产主机", async () => {
    const deps = tempDeps();
    const { saveHosts } = await import("../src/core/config.js");
    saveHosts(deps.configPath!, file([host("prod-web", { tags: ["prod"] })]));
    const ui = scriptedUi({});
    await handleSshCommand("grant prod-web 10", ui.ctx, deps);
    assert.match(ui.notes.join("\n"), /生产主机/);
  });

  it("未知子命令给用法", async () => {
    const deps = tempDeps();
    const ui = scriptedUi({});
    await handleSshCommand("nonsense", ui.ctx, deps);
    assert.match(ui.notes.join("\n"), /用法：\/ssh/);
  });
});

// ── 写盘边界：凭据与名字的对齐（真实踩过的坑） ──────────────────

/** 往现有配置里加一台主机（合并，不覆盖已有主机）。 */
function seed(deps: PanelDeps & { dir: string }, name: string, password?: string): void {
  if (password) putSecret(deps.secretsPath!, name, password);
  const current = existsSync(deps.configPath!) ? loadHosts(deps.configPath!) : { hosts: {} };
  const profile = host(name, {
    transport: "ssh2",
    auth: password
      ? { kind: "password", secretRef: `file:${deps.secretsPath}#${name}` }
      : { kind: "password" },
  });
  saveHosts(deps.configPath!, {
    ...current,
    hosts: { ...current.hosts, [name]: profile },
    activeHost: current.activeHost ?? name,
  });
}

/** 某台主机在 select 列表里的显示串（与面板用同一份 buildHostList） */
function listLine(deps: PanelDeps, name: string): string {
  return buildHostList(loadHosts(deps.configPath!)).list.find((line) => line.startsWith(`${name} `))!;
}

describe("新增与编辑的凭据对齐", () => {
  it("同名冲突自动改名时，密码只落在最终名字上", async () => {
    const deps = tempDeps();
    seed(deps, "web-01", "old");
    const ui = scriptedUi({
      selects: ["📝 逐步填写", "ssh2（内置，支持密码）", "密码", "自动改名"],
      inputs: ["web-01", "10.0.0.21", "deploy", ""],
    });
    await addHostInteractive(ui.ctx, deps);
    const hosts = loadHosts(deps.configPath!).hosts;
    assert.deepEqual(Object.keys(hosts).sort(), ["web-01", "web-01-2"]);
    assert.equal(getSecret(deps.secretsPath!, "web-01"), "old");
    assert.equal(getSecret(deps.secretsPath!, "web-01-2"), "s3cret");
    assert.match(hosts["web-01-2"].auth.secretRef!, /#web-01-2$/);
  });

  it("编辑沿用旧密码并改名：密码条目与活动指针一起迁移", async () => {
    const deps = tempDeps();
    seed(deps, "web", "pw-old");
    const ui = scriptedUi({
      selects: ["ssh2（当前）", "密码（当前）", "沿用已保存的密码"],
      inputs: ["1.1.1.2", "web-prod", "root", ""],
    });
    await editHostInteractive(ui.ctx, deps, "web");
    const saved = loadHosts(deps.configPath!);
    assert.deepEqual(Object.keys(saved.hosts), ["web-prod"]);
    assert.equal(saved.activeHost, "web-prod");
    assert.equal(getSecret(deps.secretsPath!, "web"), undefined);
    assert.equal(getSecret(deps.secretsPath!, "web-prod"), "pw-old");
    assert.match(saved.hosts["web-prod"].auth.secretRef!, /#web-prod$/);
  });

  it("编辑改传输方式时按名字解析，不把「ssh2（当前）」当传输值", async () => {
    const deps = tempDeps();
    seed(deps, "web", "pw");
    const ui = scriptedUi({
      selects: ["ftps（当前）", "密码（当前）", "沿用已保存的密码"],
      inputs: ["1.1.1.2", "web", "root", ""],
    });
    await editHostInteractive(ui.ctx, deps, "web");
    assert.equal(loadHosts(deps.configPath!).hosts.web.transport, "ftps");
  });

  it("实测失败不写盘，已写入的密码一并回滚", async () => {
    const deps = tempDeps({
      runtime: {
        testHost: async () => ({ ok: true, auth: "key", fingerprint: "", latencyMs: 1 }),
        testProfile: async () => {
          throw new Error("认证失败");
        },
        grantWrite: () => undefined,
        exec: async () => ({ exitCode: 0, text: "" }),
      },
    });
    const ui = scriptedUi({
      selects: ["📝 逐步填写", "ssh2（内置，支持密码）", "密码"],
      inputs: ["web", "10.0.0.21", "deploy", ""],
    });
    await addHostInteractive(ui.ctx, deps);
    assert.deepEqual(loadHosts(deps.configPath!).hosts, {});
    assert.equal(getSecret(deps.secretsPath!, "web"), undefined);
    assert.match(ui.notes.join("\n"), /未保存：认证失败/);
  });
});

// ── 代码审查发现的问题：每条一个回归 ─────────────────────────────

/** 只让 testProfile 失败的 deps（模拟「密码输错」） */
function failingDeps(): PanelDeps & { dir: string } {
  return tempDeps({
    runtime: {
      testHost: async () => ({ ok: true, auth: "key", fingerprint: "", latencyMs: 1 }),
      testProfile: async () => {
        throw new Error("认证失败");
      },
      grantWrite: () => undefined,
      exec: async () => ({ exitCode: 0, text: "" }),
    },
  });
}

describe("P0-1 实测失败不销毁旧密码", () => {
  it("编辑时重输密码但测试失败：旧密码原封不动", async () => {
    const deps = failingDeps();
    seed(deps, "web", "OLDPW");
    const ui = scriptedUi({
      selects: ["ssh2（当前）", "密码（当前）", "重新输入密码"],
      inputs: ["1.1.1.1", "web", "root", ""],
    });
    await editHostInteractive(ui.ctx, deps, "web");
    assert.equal(getSecret(deps.secretsPath!, "web"), "OLDPW", "旧密码被销毁了");
    assert.equal(loadHosts(deps.configPath!).hosts.web.auth.secretRef, `file:${deps.secretsPath}#web`);
    assert.match(ui.notes.join("\n"), /未保存：认证失败/);
  });

  it("更新凭据失败：旧密码保留", async () => {
    const deps = failingDeps();
    seed(deps, "web", "OLDPW");
    const ui = scriptedUi({ selects: ["密码（当前）", "重新输入密码"] });
    await updateCredentialInteractive(ui.ctx, deps, "web");
    assert.equal(getSecret(deps.secretsPath!, "web"), "OLDPW");
  });

  it("实测成功后临时键转正，不残留 .pending- 条目", async () => {
    const deps = tempDeps();
    seed(deps, "web", "OLDPW");
    const ui = scriptedUi({
      selects: ["ssh2（当前）", "密码（当前）", "重新输入密码"],
      inputs: ["1.1.1.1", "web", "root", ""],
    });
    await editHostInteractive(ui.ctx, deps, "web");
    assert.equal(getSecret(deps.secretsPath!, "web"), "s3cret");
    const all = JSON.parse(readFileSync(deps.secretsPath!, "utf8")) as { hosts: Record<string, string> };
    assert.deepEqual(Object.keys(all.hosts), ["web"], `残留临时键：${Object.keys(all.hosts)}`);
  });
});

describe("P0-2 复制不覆盖同名主机", () => {
  it("复制到已存在的名字会先问，选跳过则原主机不变", async () => {
    const deps = tempDeps();
    seed(deps, "web", "pw-web");
    seed(deps, "db", "pw-db");
    const ui = scriptedUi({
      selects: ["📋 从现有复制", listLine(deps, "db"), "跳过"],
      inputs: ["web"],
    });
    await addHostInteractive(ui.ctx, deps);
    const hosts = loadHosts(deps.configPath!).hosts;
    assert.equal(hosts.web.host, "10.0.0.21", "原 web 被覆盖了");
    assert.equal(hosts.db.host, "10.0.0.21");
    assert.equal(hosts.web.id, "web", "原 web 的 id 被换掉了");
  });

  it("选自动改名时副本落在新名字上，原主机不动", async () => {
    const deps = tempDeps();
    seed(deps, "web", "pw-web");
    seed(deps, "db", "pw-db");
    const ui = scriptedUi({
      selects: ["📋 从现有复制", listLine(deps, "db"), "自动改名"],
      inputs: ["web"],
      confirms: [false],
    });
    await addHostInteractive(ui.ctx, deps);
    const hosts = loadHosts(deps.configPath!).hosts;
    assert.deepEqual(Object.keys(hosts).sort(), ["db", "web", "web-2"]);
    assert.equal(hosts.web.id, "web", "原 web 的 id 被换掉了");
  });
});

describe("P0-3 复制出的主机不共用凭据引用", () => {
  it("复制时把密码复制成新键，改名/删除互不影响", async () => {
    const deps = tempDeps();
    seed(deps, "web", "WEB-PASSWORD");
    const ui = scriptedUi({ selects: ["📋 从现有复制", listLine(deps, "web")], inputs: ["web-copy"], confirms: [false] });
    await addHostInteractive(ui.ctx, deps);
    const copy = loadHosts(deps.configPath!).hosts["web-copy"];
    assert.equal(copy.auth.secretRef, `file:${deps.secretsPath}#web-copy`);
    assert.equal(getSecret(deps.secretsPath!, "web-copy"), "WEB-PASSWORD");

    // 删掉来源主机，副本仍能解析到自己的密码
    const rm = scriptedUi({ confirms: [true] });
    await handleSshCommand("rm web", rm.ctx, deps);
    assert.equal(getSecret(deps.secretsPath!, "web-copy"), "WEB-PASSWORD");
  });

  it("副本改名并沿用密码：来源主机的密码不被带走", async () => {
    const deps = tempDeps();
    seed(deps, "web", "WEB-PASSWORD");
    const add = scriptedUi({ selects: ["📋 从现有复制", listLine(deps, "web")], inputs: ["web-copy"], confirms: [false] });
    await addHostInteractive(add.ctx, deps);
    const edit = scriptedUi({
      selects: ["ssh2（当前）", "密码（当前）", "沿用已保存的密码"],
      inputs: ["1.1.1.1", "web-copy2", "root", ""],
    });
    await editHostInteractive(edit.ctx, deps, "web-copy");
    assert.equal(getSecret(deps.secretsPath!, "web"), "WEB-PASSWORD", "来源主机的密码被删了");
    assert.equal(getSecret(deps.secretsPath!, "web-copy2"), "WEB-PASSWORD");
  });

  it("删除一台不删别台还在用的凭据条目", async () => {
    const deps = tempDeps();
    putSecret(deps.secretsPath!, "shared", "SHARED-PW");
    saveHosts(deps.configPath!, {
      hosts: {
        a: host("a", { auth: { kind: "password", secretRef: `file:${deps.secretsPath}#shared` } }),
        b: host("b", { auth: { kind: "password", secretRef: `file:${deps.secretsPath}#shared` } }),
      },
    });
    const ui = scriptedUi({ confirms: [true] });
    await handleSshCommand("rm a", ui.ctx, deps);
    assert.equal(getSecret(deps.secretsPath!, "shared"), "SHARED-PW", "共用凭据被删了");
    assert.deepEqual(Object.keys(loadHosts(deps.configPath!).hosts), ["b"]);
  });
});

describe("P1-4 FTP/FTPS 必须问密码", () => {
  it("新增 ftp 主机会调用 readSecret 并保存凭据", async () => {
    const asked: string[] = [];
    const deps = tempDeps({ readSecret: async (_ctx, title) => { asked.push(title); return "FTPPW"; } });
    const ui = scriptedUi({
      selects: ["📝 逐步填写", "ftp（仅文件传输）"],
      inputs: ["nas", "10.0.0.9", "ftpuser", "21"],
    });
    await addHostInteractive(ui.ctx, deps);
    assert.deepEqual(asked, ["登录密码"]);
    const nas = loadHosts(deps.configPath!).hosts.nas;
    assert.equal(nas.auth.kind, "password");
    assert.equal(getSecret(deps.secretsPath!, "nas"), "FTPPW");
    assert.equal(nas.auth.secretRef, `file:${deps.secretsPath}#nas`);
  });

  it("不给密码就不保存", async () => {
    const deps = tempDeps({ readSecret: async () => undefined });
    const ui = scriptedUi({
      selects: ["📝 逐步填写", "ftp（仅文件传输）"],
      inputs: ["nas", "10.0.0.9", "ftpuser", "21"],
    });
    await addHostInteractive(ui.ctx, deps);
    assert.deepEqual(loadHosts(deps.configPath!).hosts, {});
    assert.match(ui.notes.join("\n"), /没有密码，未保存/);
  });
});

describe("P1-5 端口留空回到默认", () => {
  it("编辑时清空端口 → 保存为无 port（默认 22）", async () => {
    const deps = tempDeps();
    saveHosts(deps.configPath!, file([host("web", { port: 2222, transport: "ssh2" })], "web"));
    const ui = scriptedUi({
      selects: ["ssh2（当前）", "密钥文件（当前）"],
      inputs: ["1.1.1.1", "web", "root", "", "~/.ssh/id_ed25519"],
    });
    await editHostInteractive(ui.ctx, deps, "web");
    assert.equal(loadHosts(deps.configPath!).hosts.web.port, undefined);
  });
});

describe("P1-6 审计文件损坏不崩面板", () => {
  it("末尾半行 → 报错提示而不是抛异常", async () => {
    const deps = tempDeps();
    writeFileSync(deps.auditPath!, '{"ts":"t1","tool":"ssh_exec","host":"web"}\n{"ts":"t2","tool":"ssh_ex');
    const ui = scriptedUi({});
    await handleSshCommand("log", ui.ctx, deps);
    assert.match(ui.notes.join("\n"), /审计文件读不出来/);
  });
});

describe("P1-7 /ssh exec 单主机无活动主机", () => {
  it("只有一台且没设活动主机时直接执行，不弹选择框", async () => {
    const calls: Array<{ host?: string }> = [];
    const deps = tempDeps({
      runtime: {
        testHost: async () => ({ ok: true, auth: "key", fingerprint: "", latencyMs: 1 }),
        testProfile: async () => ({ ok: true, auth: "key", fingerprint: "", latencyMs: 1 }),
        grantWrite: () => undefined,
        exec: async (input) => {
          calls.push({ host: input.host });
          return { exitCode: 0, text: "ok" };
        },
      },
    });
    saveHosts(deps.configPath!, file([host("web")]));
    let askedSelect = false;
    const ui = scriptedUi({});
    ui.ctx.ui.select = async () => {
      askedSelect = true;
      return undefined;
    };
    await handleSshCommand("exec uptime", ui.ctx, deps);
    assert.equal(askedSelect, false, "不该弹选择框");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, "web");
  });
});

describe("P1-8 编辑时能取消 prod 标签", () => {
  it("回答「不是生产主机」→ tags 去掉 prod", async () => {
    const deps = tempDeps();
    saveHosts(deps.configPath!, file([host("web", { tags: ["prod", "db"], transport: "ssh2" })], "web"));
    const ui = scriptedUi({
      selects: ["ssh2（当前）", "密钥文件（当前）"],
      inputs: ["1.1.1.1", "web", "root", "", "~/.ssh/id_ed25519"],
      confirms: [false],
    });
    await editHostInteractive(ui.ctx, deps, "web");
    assert.deepEqual(loadHosts(deps.configPath!).hosts.web.tags, ["db"]);
  });
});

describe("其他：键名与 profile.name 不一致", () => {
  it("选择列表按 hosts 键名索引，操作落到正确的键上", async () => {
    const deps = tempDeps();
    saveHosts(deps.configPath!, {
      hosts: { "web-01": host("web", { auth: { kind: "key" } }) },
    });
    const { list, map } = buildHostList(loadHosts(deps.configPath!));
    assert.equal(map.get(list[0]), "web-01");
    const notes: string[] = [];
    const ui = scriptedUi({});
    ui.ctx.ui.select = async () => list[0];
    ui.ctx.ui.notify = (message: string) => notes.push(message);
    await handleSshCommand("test", ui.ctx, deps);
    assert.match(notes.join("\n"), /web-01/);
  });
});
