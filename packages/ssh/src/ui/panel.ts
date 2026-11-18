// src/ui/panel.ts —— /ssh 管理面板（对齐 db 插件的两级菜单）。
//
// 修的真实问题（用户截图反馈）：`/ssh` 无参数时只发一条 notify，pi web 里就是右上角一个
// 短暂 toast，没有任何可点的东西；用户只能背子命令。db 插件用的是 ctx.ui.select，
// 在 TUI 与 pi web 里都会渲染成可选的对话框，这里补上同一套形态。
//
// 分层（与 packages/db/index.ts 的 /db 一致）：
// - 纯函数：文案/解析/合并（hostSummaryLine、hostDetailLines、auditLines、parseHostSpec、
//   buildProfile、withProdTag…），给单测用，不碰 ctx；
// - 交互函数：只用 ctx.ui 的 select/confirm/input/notify 与 deps，不 import 任何 pi 模块，
//   所以 TUI 和 RPC（pi web）走同一份代码。
import { randomUUID } from "node:crypto";
import { defaultAuditPath, readAudit } from "../core/audit.js";
import { defaultConfigPath, loadHosts, saveHosts } from "../core/config.js";
import { doctorLines } from "../core/doctor.js";
import { isProdHost, type ConfirmLevel } from "../core/policy.js";
import { defaultSecretsPath, deleteSecret, getSecret, putSecret } from "../core/secrets.js";
import {
  HostKeyUnknownError,
  type DeployLayout,
  type HostFile,
  type HostProfile,
  type TransportKind,
} from "../core/types.js";

export const BACK = "← 返回";
const USAGE =
  "用法：/ssh [ls|add|edit [主机]|rm [主机]|test [主机]|testall|use <主机>|exec <命令>|grant <主机> <分钟>|log [主机|条数]|config|scan|doctor]\n" +
  "  无参数 = 打开管理面板";

// ── 依赖注入：面板不自己 new 运行时，全部由 index.ts 传进来 ──────────────

export interface HostTestResult {
  ok: boolean;
  auth: string;
  fingerprint: string;
  keyType?: string;
  latencyMs: number;
  transport?: string;
}

export interface PanelRuntime {
  testHost(input: { host?: string; acceptNewHostKey?: boolean; allowActive?: boolean }): Promise<HostTestResult>;
  testProfile(profile: HostProfile, acceptNewHostKey?: boolean): Promise<HostTestResult>;
  grantWrite(hostName: string, minutes: number): void;
  exec(input: { host?: string; command: string; allowActive?: boolean; ui?: unknown }): Promise<{ exitCode: number | null; text: string }>;
}

export interface PanelDeps {
  runtime: PanelRuntime;
  /** 远端动作确认（index.ts 的 confirmUiOf(ctx)），执行命令时用 */
  confirmUi(ctx: any): unknown;
  /** 掩码输入密码（index.ts 的 readSecret），密码不进对话记录 */
  readSecret(ctx: any, title: string, prompt: string): Promise<string | undefined>;
  configPath?: string;
  secretsPath?: string;
  auditPath?: string;
}

function configPathOf(deps: PanelDeps): string {
  return deps.configPath ?? defaultConfigPath();
}

function secretsPathOf(deps: PanelDeps): string {
  return deps.secretsPath ?? defaultSecretsPath();
}

function auditPathOf(deps: PanelDeps): string {
  return deps.auditPath ?? defaultAuditPath();
}

function load(deps: PanelDeps): HostFile {
  return loadHosts(configPathOf(deps));
}

function persist(deps: PanelDeps, file: HostFile): void {
  saveHosts(configPathOf(deps), file);
}

// ── 纯文案 / 解析（单测覆盖） ────────────────────────────────────────

export function transportLabel(transport: HostProfile["transport"]): string {
  switch (transport) {
    case "auto":
      return "auto（按 ~/.ssh/config 选）";
    case "openssh":
      return "openssh（系统 ssh）";
    case "ssh2":
      return "ssh2（内置）";
    case "ftp":
      return "ftp（仅文件传输）";
    case "ftps":
      return "ftps（仅文件传输）";
    default:
      return String(transport);
  }
}

/** 认证方式的人话。密码只说有没有存过，绝不含明文。 */
export function authSummary(profile: HostProfile, hasSecret: boolean): string {
  switch (profile.auth.kind) {
    case "key":
      return `密钥 ${profile.auth.privateKeyPath ?? "(未设路径)"}`;
    case "agent":
      return "ssh-agent";
    default:
      return profile.auth.secretRef || hasSecret ? "密码（已保存）" : "密码（未保存）";
  }
}

/** 主机列表的一行。活动主机与 prod 都标出来，避免选错。 */
export function hostSummaryLine(profile: HostProfile, file: HostFile): string {
  const marks: string[] = [];
  if (file.activeHost === profile.name) marks.push("●活动");
  if (isProdHost(profile)) marks.push("prod");
  const where = `${profile.user}@${profile.host}${profile.port ? `:${profile.port}` : ""}`;
  const deploy = profile.deploy?.root ? ` · 部署根 ${profile.deploy.root}` : "";
  const mark = marks.length > 0 ? ` · ${marks.join("/")}` : "";
  return `${profile.name} [${profile.transport}] ${where}${mark}${deploy}`;
}

/** 选择列表 + 显示串到「hosts 键名」的映射。按名字排序，活动主机排最前。 */
export function buildHostList(file: HostFile): { list: string[]; map: Map<string, string> } {
  // 排序与映射都用 hosts 的键：profile.name 可能因为手改 JSON 与键名不一致，
  // 以前 map 存 profile.name，选中后就查不到 hosts[...]（操作直接 no-op）。
  const entries = Object.entries(file.hosts).sort(([a], [b]) => {
    if (file.activeHost === a) return -1;
    if (file.activeHost === b) return 1;
    return a.localeCompare(b);
  });
  const list: string[] = [];
  const map = new Map<string, string>();
  for (const [key, profile] of entries) {
    const line = hostSummaryLine({ ...profile, name: key }, file);
    list.push(line);
    map.set(line, key);
  }
  return { list, map };
}

export function deployLayoutLines(layout: DeployLayout | undefined): string[] {
  if (!layout?.root) return ["未配置部署布局（不能 ssh_deploy / release 回滚）"];
  return [
    `部署根 ${layout.root}`,
    `releases ${layout.releasesDir ?? "releases"} · current ${layout.currentLink ?? "current"} · shared ${layout.sharedDir ?? "shared"}`,
    `重启 ${layout.restartCmd ?? "（未配置，部署后不会重启）"}`,
    `健康检查 ${layout.healthCmd ?? "（未配置，失败不会自动回退）"}`,
    `保留 ${layout.keepReleases ?? 5} 个版本`,
  ];
}

/** 单台主机的详情。密码只报「有没有」，不读出来。 */
export function hostDetailLines(profile: HostProfile, file: HostFile, hasSecret: boolean): string[] {
  const lines = [
    `【名称】 ${profile.name}`,
    `【地址】 ${profile.user}@${profile.host}${profile.port ? `:${profile.port}` : "（默认端口）"}`,
    `【传输】 ${transportLabel(profile.transport)}`,
    `【认证】 ${authSummary(profile, hasSecret)}`,
    `【主机密钥】 ${profile.strictHostKey === false ? "跳过校验（不安全）" : "校验 known_hosts"}`,
    `【标签】 ${profile.tags?.length ? profile.tags.join("、") : "无"}`,
    `【活动主机】 ${file.activeHost === profile.name ? "是" : "否"}`,
    `【创建时间】 ${profile.createdAt}`,
  ];
  if (profile.lastUsedAt) lines.push(`【最近使用】 ${profile.lastUsedAt}`);
  if (profile.transport === "ftp" || profile.transport === "ftps") {
    lines.push(`【加密】 ${profile.transport === "ftps" ? (profile.secure === "implicit" ? "隐式 TLS" : "显式 TLS") : "无"}${profile.insecure ? "（不校验证书）" : ""}`);
  }
  if (profile.defaults?.cwd || profile.defaults?.timeoutSec) {
    lines.push(`【默认】 工作目录 ${profile.defaults.cwd ?? "无"} · 超时 ${profile.defaults.timeoutSec ?? "无"}s`);
  }
  lines.push("【部署布局】", ...deployLayoutLines(profile.deploy).map((line) => `  ${line}`));
  return lines;
}

export function confirmLabel(level: ConfirmLevel): string {
  if (level === "always") return "每次都确认";
  if (level === "write") return "写操作与破坏性都确认";
  return "仅破坏性确认";
}

/** 策略缺省值与 runtime.policyOf 保持一致：只读关，确认级别 destructive。 */
export function effectivePolicy(file: HostFile): { readonly: boolean; confirm: ConfirmLevel } {
  return { readonly: file.policy?.readonly === true, confirm: file.policy?.confirm ?? "destructive" };
}

export function policyLines(file: HostFile): string[] {
  const policy = effectivePolicy(file);
  return [
    `只读模式：${policy.readonly ? "开（拒绝 write/destructive）" : "关"}`,
    `确认级别：${confirmLabel(policy.confirm)}`,
    `审计日志：${defaultAuditPath()}`,
    "生产主机（tags 含 prod）：破坏性必须带 reason，写授权不可授予，审计不可写时拒绝执行",
  ];
}

/** 审计行的展示。命令截断到 80 字符，避免一屏一条。 */
export function auditLines(
  rows: Record<string, unknown>[],
  opts: { host?: string; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? 20;
  const filtered = opts.host ? rows.filter((row) => row.host === opts.host) : rows;
  return filtered.slice(-limit).map((row) => {
    const parts = [
      String(row.ts ?? ""),
      String(row.tool ?? ""),
      String(row.host ?? ""),
    ];
    if (row.danger) parts.push(String(row.danger));
    if (row.summary) parts.push(String(row.summary));
    if (row.exitCode !== undefined && row.exitCode !== null) parts.push(`exit=${String(row.exitCode)}`);
    const command = row.command === undefined ? "" : String(row.command).replace(/\s+/g, " ");
    const body = parts.filter(Boolean).join(" ");
    if (!command) return body;
    return `${body} · ${command.length > 80 ? `${command.slice(0, 80)}…` : command}`;
  });
}

/** 测试结果的一行摘要。 */
export function describeTestResult(result: HostTestResult): string {
  const transport = result.transport ? `${result.transport} ` : "";
  const fingerprint = result.fingerprint ? ` ${result.fingerprint}` : "";
  return `✓ ${transport}${result.auth}${fingerprint} ${result.latencyMs}ms`;
}

/**
 * 解析「user@host:port」。支持 IPv6 的 [::1]:22 形态。
 * 解析不出来返回 null，由调用方提示而不是猜：
 * 以前 `host:abc` 会把整串当主机名存进去，`a@b@c` 会拆成 user=`a@b`，都不报错。
 */
export function parseHostSpec(text: string): { user?: string; host: string; port?: number } | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  const at = value.lastIndexOf("@");
  if (at === 0) return null;
  const user = at > 0 ? value.slice(0, at) : undefined;
  // 用户名里不该再有 @；有就说明输入本身不对（IPv6 地址不需要 @）。
  if (user !== undefined && user.includes("@")) return null;
  let rest = at > 0 ? value.slice(at + 1) : value;
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    rest = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if (rest.startsWith("[")) {
    return null;
  } else {
    const match = /^([^:]+):(\d+)$/.exec(rest);
    if (match) {
      rest = match[1];
      port = Number(match[2]);
    } else if (rest.includes(":")) {
      // 含冒号但不是 host:数字 → 裸 IPv6（直接接受）或畸形（`host:`、`host:abc`）
      const bare = /^[0-9a-fA-F:.]+$/.test(rest) && rest.split(":").length > 2;
      if (!bare) return null;
    }
  }
  if (!rest) return null;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { user, host: rest, port };
}

/** prod 标签的唯一入口：勾上就加，取消就去，其余标签原样保留。 */
export function withProdTag(tags: string[] | undefined, prod: boolean): string[] | undefined {
  const rest = (tags ?? []).filter((tag) => tag !== "prod");
  const next = prod ? [...rest, "prod"] : rest;
  return next.length > 0 ? Array.from(new Set(next)) : undefined;
}

export interface ProfileInput {
  name: string;
  host: string;
  user: string;
  /** 显式 null = 清空（回到默认端口）；undefined = 不动 */
  port?: number | null;
  transport?: TransportKind | "auto";
  authKind?: "key" | "password" | "agent";
  privateKeyPath?: string;
  secretRef?: string;
  secure?: "explicit" | "implicit";
  insecure?: boolean;
  /** 显式 undefined 会被当成「清空」——由 withProdTag 产出的 undefined 必须能真的去掉标签 */
  tags?: string[];
  existing?: HostProfile;
}

/**
 * 由表单字段拼出 HostProfile。编辑时以 existing 为底：
 * id / createdAt / deploy / defaults 不能因为改地址就被抹掉。
 *
 * 注意 tags / port 不能用 `??`：`??` 会把「显式传 undefined = 清空」当成「没传 = 保留」，
 * 导致取消 prod 标签、清空端口全部失效（实测：取消 prod 后 tags 仍是 ["prod"]）。
 */
export function buildProfile(input: ProfileInput): HostProfile {
  const existing = input.existing;
  const authKind = input.authKind ?? existing?.auth.kind ?? (input.privateKeyPath ? "key" : "password");
  const port = "port" in input ? (input.port ?? undefined) : existing?.port;
  const tags = "tags" in input ? input.tags : existing?.tags;
  return {
    id: existing?.id ?? randomUUID(),
    name: input.name,
    transport: input.transport ?? existing?.transport ?? "auto",
    host: input.host,
    port,
    user: input.user,
    auth: {
      kind: authKind,
      privateKeyPath: authKind === "key" ? input.privateKeyPath ?? existing?.auth.privateKeyPath : undefined,
      secretRef: authKind === "password" ? input.secretRef ?? existing?.auth.secretRef : undefined,
      passphraseRef: existing?.auth.passphraseRef,
    },
    strictHostKey: existing?.strictHostKey,
    secure: input.secure ?? existing?.secure,
    insecure: input.insecure ?? existing?.insecure,
    tags,
    defaults: existing?.defaults,
    deploy: existing?.deploy,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastUsedAt: existing?.lastUsedAt,
  };
}

// ── 交互（只用 ctx.ui 与 deps） ─────────────────────────────────────

async function pickHost(ctx: any, file: HostFile, title: string): Promise<string | undefined> {
  const { list, map } = buildHostList(file);
  if (list.length === 0) {
    ctx.ui.notify("还没有主机。用「➕ 新增主机」，或在对话里说「把我 ~/.ssh/config 里的主机加进来」。", "info");
    return undefined;
  }
  const choice = await ctx.ui.select(title, list);
  return choice ? map.get(choice) : undefined;
}

function hasSecretOf(deps: PanelDeps, profile: HostProfile): boolean {
  const ref = profile.auth.secretRef;
  if (!ref) return false;
  if (ref.startsWith("keychain:")) return true;
  const parsed = secretRefKey(ref);
  if (!parsed) return false;
  try {
    return getSecret(parsed.path, parsed.key) !== undefined;
  } catch {
    return false;
  }
}

/** `file:/path#name` → 路径与键名。不是 file: 引用时返回 undefined。 */
function secretRefKey(ref: string | undefined): { path: string; key: string } | undefined {
  if (!ref?.startsWith("file:")) return undefined;
  const [path, key] = ref.slice("file:".length).split("#");
  if (!path || !key) return undefined;
  return { path, key };
}

/**
 * 还有哪些主机在用同一份凭据。
 * 「从现有复制」会让多台主机共用一个 secretRef，改名/删除时不查这个就会互相踩：
 * 删掉一台的密码条目，另一台立刻连不上。
 */
function otherReferences(file: HostFile, path: string, key: string, exceptName: string): string[] {
  return Object.entries(file.hosts)
    .filter(([name]) => name !== exceptName)
    .filter(([, profile]) => {
      const parsed = secretRefKey(profile.auth.secretRef);
      return parsed?.path === path && parsed.key === key;
    })
    .map(([name]) => name);
}

/**
 * 改名时把凭据条目从旧键挪到新键。
 * 旧键还有别的主机在用时改为「复制一份」，不删旧键——否则会把别人正在用的密码带走。
 */
function migrateSecret(
  deps: PanelDeps,
  file: HostFile,
  ref: string,
  newKey: string,
  oldKey: string,
): string {
  const parsed = secretRefKey(ref);
  if (!parsed) return ref;
  let secret: string | undefined;
  try {
    secret = getSecret(parsed.path, parsed.key);
  } catch {
    return ref;
  }
  if (!secret) return ref;
  const shared = otherReferences(file, parsed.path, parsed.key, oldKey).length > 0;
  try {
    putSecret(parsed.path, newKey, secret);
    if (!shared) deleteSecret(parsed.path, parsed.key);
  } catch {
    // 凭据文件损坏时不挡住配置保存：引用保持原样，连接仍能解析到旧键。
    return ref;
  }
  return `file:${parsed.path}#${newKey}`;
}

/** 首次连接的指纹必须给人看过才算数（与 index.ts 的 TOFU 一致）。 */
async function testWithTofu(ctx: any, deps: PanelDeps, name: string): Promise<HostTestResult> {
  try {
    return await deps.runtime.testHost({ host: name });
  } catch (error) {
    if (!(error instanceof HostKeyUnknownError)) throw error;
    const accepted = await ctx.ui.confirm(
      "未知主机密钥",
      `${error.message}\n\n用 ssh-keygen -lf 核对后，确认记录这个指纹并继续？`,
    );
    if (!accepted) throw new Error("指纹未确认，本次没有连接。");
    return deps.runtime.testHost({ host: name, acceptNewHostKey: true });
  }
}

/** 保存前实测；指纹未知时摆出来确认。拒绝指纹 = 不保存。 */
async function testCandidate(ctx: any, deps: PanelDeps, profile: HostProfile): Promise<HostTestResult> {
  try {
    return await deps.runtime.testProfile(profile);
  } catch (error) {
    if (!(error instanceof HostKeyUnknownError)) throw error;
    const accepted = await ctx.ui.confirm(
      "未知主机密钥",
      `${error.message}\n\n用 ssh-keygen -lf 核对后，确认记录这个指纹并继续？`,
    );
    if (!accepted) throw new Error("指纹未确认，未保存。");
    return deps.runtime.testProfile(profile, true);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 同名冲突：覆盖 / 改名 / 跳过。改名时自己找第一个空位，不再追问。 */
async function resolveName(
  ctx: any,
  file: HostFile,
  name: string,
  editing?: string,
): Promise<string | undefined> {
  const taken = file.hosts[name] !== undefined && name !== editing;
  if (!taken) return name;
  const choice = await ctx.ui.select(`主机名 ${name} 已存在`, ["覆盖同名主机", "自动改名", "跳过"]);
  if (!choice || choice === "跳过") return undefined;
  if (choice === "覆盖同名主机") return name;
  let suffix = 2;
  while (file.hosts[`${name}-${suffix}`]) suffix += 1;
  return `${name}-${suffix}`;
}

async function askAuth(
  ctx: any,
  deps: PanelDeps,
  draft: ProfileInput,
): Promise<{ authKind: "key" | "password" | "agent"; privateKeyPath?: string; password?: string } | undefined> {
  const transport = draft.transport ?? "auto";
  // FTP/FTPS 只有账号密码一条路，且没有主机密钥——但密码必须问：
  // 曾经这里直接 return，不调 readSecret，存下来的主机没有任何凭据却报测试成功。
  if (transport === "ftp" || transport === "ftps") {
    if (draft.existing?.auth.kind === "password" && draft.existing.auth.secretRef) {
      const keep = await ctx.ui.select("密码", ["沿用已保存的密码", "重新输入密码"]);
      if (!keep) return undefined;
      if (keep === "沿用已保存的密码") return { authKind: "password" };
    }
    const ftpPassword = await deps.readSecret(ctx, "登录密码", "密码不进入对话记录");
    if (!ftpPassword) {
      ctx.ui.notify("没有密码，未保存", "warning");
      return undefined;
    }
    return { authKind: "password", password: ftpPassword };
  }
  const current = draft.existing?.auth.kind;
  const choice = await ctx.ui.select(
    "认证方式",
    [
      `密钥文件${current === "key" ? "（当前）" : ""}`,
      `密码${current === "password" ? "（当前）" : ""}`,
      `ssh-agent${current === "agent" ? "（当前）" : ""}`,
    ],
  );
  if (!choice) return undefined;
  if (choice.startsWith("密钥文件")) {
    const path = (await ctx.ui.input("私钥路径", draft.existing?.auth.privateKeyPath ?? "~/.ssh/id_ed25519"))?.trim();
    if (!path) {
      ctx.ui.notify("私钥路径不能为空", "error");
      return undefined;
    }
    return { authKind: "key", privateKeyPath: path };
  }
  if (choice.startsWith("ssh-agent")) return { authKind: "agent" };
  // 编辑时已有密码就别逼人重输：只改地址/端口的场景很常见。
  if (draft.existing?.auth.kind === "password" && draft.existing.auth.secretRef) {
    const keep = await ctx.ui.select("密码", ["沿用已保存的密码", "重新输入密码"]);
    if (!keep) return undefined;
    if (keep === "沿用已保存的密码") return { authKind: "password" };
  }
  const password = await deps.readSecret(ctx, "登录密码", "密码不进入对话记录");
  if (!password) {
    ctx.ui.notify("没有密码，未保存", "warning");
    return undefined;
  }
  return { authKind: "password", password };
}

/** 新增/编辑的收尾：问认证 → 问 prod → 实测 → 写盘。 */
async function finishDraft(ctx: any, deps: PanelDeps, draft: ProfileInput): Promise<boolean> {
  if (!draft.name || !draft.host || !draft.user) {
    ctx.ui.notify("主机名、地址、用户都不能为空", "error");
    return false;
  }
  const auth = await askAuth(ctx, deps, draft);
  if (!auth) return false;

  const prod = await ctx.ui.confirm(
    "生产主机",
    "这台机器的标签要包含 prod 吗？\n生产主机的破坏性操作必须填理由、写授权不可授予、覆盖上传也要确认。",
  );
  const tags = withProdTag(draft.tags ?? draft.existing?.tags, prod);

  const profile = buildProfile({
    ...draft,
    authKind: auth.authKind,
    privateKeyPath: auth.privateKeyPath,
    secretRef: draft.existing?.auth.secretRef,
    tags,
  });

  const file = load(deps);
  const editing = draft.existing?.name;
  // 先定名字再写凭据：改名/冲突是常态，按候选名先落密码会留孤儿条目。
  const finalName = await resolveName(ctx, file, profile.name, editing);
  if (!finalName) {
    ctx.ui.notify("已取消，未保存", "info");
    return false;
  }
  // 改名既可能来自新增时的同名冲突（对比 draft.name），也可能来自编辑时手改名字（对比旧键）。
  const renamed = (editing ?? draft.name) !== finalName;

  let secretRef = profile.auth.secretRef;
  let pendingKey: string | undefined;
  if (auth.authKind === "password" && auth.password) {
    // 先写临时键：实测失败只删临时键，不能碰配置里原有 secretRef 指向的旧密码。
    // （曾经直接写正式键，失败后 deleteSecret 把旧密码一起删了，主机直接失去凭据。）
    pendingKey = `${finalName}.pending-${randomUUID().slice(0, 8)}`;
    putSecret(secretsPathOf(deps), pendingKey, auth.password);
    secretRef = `file:${secretsPathOf(deps)}#${pendingKey}`;
  }
  const finalProfile: HostProfile = {
    ...profile,
    name: finalName,
    auth: { ...profile.auth, secretRef: auth.authKind === "password" ? secretRef : undefined },
  };

  let tested: HostTestResult;
  try {
    tested = await testCandidate(ctx, deps, finalProfile);
  } catch (error) {
    // 只回收临时键；旧密码原封不动。
    if (pendingKey) {
      try {
        deleteSecret(secretsPathOf(deps), pendingKey);
      } catch {
        // 凭据文件坏了也不该盖住真实错误
      }
    }
    ctx.ui.notify(`未保存：${messageOf(error)}`, "error");
    return false;
  }

  // 实测通过：把临时键转正。
  if (pendingKey) {
    try {
      putSecret(secretsPathOf(deps), finalName, auth.password!);
      deleteSecret(secretsPathOf(deps), pendingKey);
      secretRef = `file:${secretsPathOf(deps)}#${finalName}`;
    } catch {
      // 转正失败就保留临时键引用，至少还能连上
    }
  }

  const hosts = { ...file.hosts };
  if (editing && editing !== finalName) delete hosts[editing];
  hosts[finalName] = { ...finalProfile, auth: { ...finalProfile.auth, secretRef: auth.authKind === "password" ? secretRef : undefined } };
  // 改名要同时迁移活动指针与凭据引用，否则编辑旧名后就断了。
  const activeHost = file.activeHost === editing && editing !== finalName ? finalName : file.activeHost;
  if (renamed && !pendingKey && finalProfile.auth.kind === "password") {
    // 沿用旧密码且改了名字：把密码条目从旧名挪到新名，否则改名后立刻连不上。
    // 旧键若还有别的主机在用（「从现有复制」会共用引用），只复制不删。
    const ref = finalProfile.auth.secretRef;
    const parsed = secretRefKey(ref);
    if (ref && parsed) {
      const nextRef = migrateSecret(deps, file, ref, finalName, editing ?? parsed.key);
      hosts[finalName] = { ...finalProfile, auth: { ...finalProfile.auth, secretRef: nextRef } };
    }
  }
  persist(deps, { ...file, hosts, activeHost });
  ctx.ui.notify(`已保存 ${finalName}，${describeTestResult(tested)}`, "success");
  return true;
}

export async function addHostInteractive(ctx: any, deps: PanelDeps): Promise<void> {
  const mode = await ctx.ui.select("新增主机", [
    "⚡ 粘贴 user@host:port（一键）",
    "📝 逐步填写",
    "📋 从现有复制",
  ]);
  if (!mode) return;

  if (mode.startsWith("📋")) {
    const file = load(deps);
    const source = await pickHost(ctx, file, "选择要复制的主机");
    if (!source) return;
    const original = file.hosts[source];
    const name = (await ctx.ui.input("新主机名", `${source}-copy`))?.trim();
    if (!name) {
      ctx.ui.notify("已取消复制", "info");
      return;
    }
    // 复制也必须走同名冲突确认：曾经直接 delete + 赋值，把已有主机的地址和 id 静默覆盖掉了。
    const finalName = await resolveName(ctx, file, name);
    if (!finalName) {
      ctx.ui.notify("已取消复制", "info");
      return;
    }
    // 凭据引用不能两台共用：否则改名/删除其中一台会把另一台的密码一起带走。
    let secretRef = original.auth.secretRef;
    const parsed = secretRefKey(secretRef);
    if (parsed) {
      try {
        const secret = getSecret(parsed.path, parsed.key);
        if (secret) {
          putSecret(parsed.path, finalName, secret);
          secretRef = `file:${parsed.path}#${finalName}`;
        }
      } catch {
        // 凭据文件读不到：保持原引用（副本与原本共用），至少不会当场失效
      }
    }
    const copy: HostProfile = {
      ...original,
      id: randomUUID(),
      name: finalName,
      auth: { ...original.auth, secretRef },
      createdAt: new Date().toISOString(),
      lastUsedAt: undefined,
    };
    const next = { ...file, hosts: { ...file.hosts, [finalName]: copy } };
    persist(deps, next);
    ctx.ui.notify(`已复制为 ${finalName}（凭据、部署布局一并带上）`, "success");
    if (await ctx.ui.confirm("从现有复制", "立即编辑副本（地址/端口/用户/传输/认证）？")) {
      await editHostInteractive(ctx, deps, finalName);
    }
    return;
  }

  let draft: ProfileInput;
  if (mode.startsWith("⚡")) {
    const spec = (await ctx.ui.input("地址", "deploy@10.0.0.21:2222"))?.trim();
    if (!spec) return;
    const parsed = parseHostSpec(spec);
    if (!parsed) {
      ctx.ui.notify("地址无法解析。形如 deploy@10.0.0.21:2222、10.0.0.21:2222 或 [::1]:22", "error");
      return;
    }
    const name = (await ctx.ui.input("主机名", parsed.host))?.trim();
    if (!name) return;
    const user = parsed.user ?? (await ctx.ui.input("用户", "root"))?.trim();
    if (!user) return;
    draft = { name, host: parsed.host, port: parsed.port, user };
  } else {
    const name = (await ctx.ui.input("主机名", ""))?.trim();
    if (!name) return;
    const host = (await ctx.ui.input("地址（IP 或域名）", ""))?.trim();
    if (!host) return;
    const user = (await ctx.ui.input("用户", "root"))?.trim();
    if (!user) return;
    const portText = (await ctx.ui.input("端口（留空用默认）", ""))?.trim();
    const port = portText ? Number(portText) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      ctx.ui.notify("端口必须是 1-65535 的整数", "error");
      return;
    }
    draft = { name, host, user, port };
  }

  const transportChoice = await ctx.ui.select("传输方式", [
    "auto（有 ProxyJump/证书时自动走系统 ssh）",
    "ssh2（内置，支持密码）",
    "openssh（系统 ssh，继承 agent/证书）",
    "ftp（仅文件传输）",
    "ftps（仅文件传输，显式 TLS）",
  ]);
  if (!transportChoice) return;
  const transport = (["openssh", "ssh2", "ftps", "ftp", "auto"] as const).find((item) => transportChoice.startsWith(item));
  if (!transport) {
    ctx.ui.notify(`无法识别的传输方式：${transportChoice}`, "error");
    return;
  }
  draft.transport = transport;

  if (transport === "ftps") {
    const modeChoice = await ctx.ui.select("FTPS 加密方式", ["显式 TLS（AUTH TLS，默认）", "隐式 TLS（端口 990）"]);
    if (!modeChoice) return;
    draft.secure = modeChoice.startsWith("隐式") ? "implicit" : "explicit";
    if (await ctx.ui.confirm("证书校验", "跳过 FTPS 证书校验吗？（仅限自签证书的内网环境）")) {
      draft.insecure = true;
    }
  }

  await finishDraft(ctx, deps, draft);
}

export async function editHostInteractive(ctx: any, deps: PanelDeps, name?: string): Promise<void> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "选择要编辑的主机"));
  if (!target) return;
  const current = file.hosts[target];
  if (!current) {
    ctx.ui.notify(`没有名为 ${target} 的主机`, "error");
    return;
  }
  const host = (await ctx.ui.input("地址", current.host))?.trim();
  if (host === undefined) return;
  const newName = (await ctx.ui.input("主机名", current.name))?.trim();
  if (!newName) return;
  const user = (await ctx.ui.input("用户", current.user))?.trim();
  if (!user) return;
  const portText = (await ctx.ui.input("端口（留空 = 默认端口）", current.port ? String(current.port) : ""))?.trim();
  // 留空 = 显式回到默认端口（以前 `port ?? current.port` 把空输入回落成旧值，2222 永远改不回 22）。
  const port = portText ? Number(portText) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    ctx.ui.notify("端口必须是 1-65535 的整数", "error");
    return;
  }
  const transportChoice = await ctx.ui.select("传输方式", [
    `auto${current.transport === "auto" ? "（当前）" : ""}`,
    `ssh2${current.transport === "ssh2" ? "（当前）" : ""}`,
    `openssh${current.transport === "openssh" ? "（当前）" : ""}`,
    `ftp${current.transport === "ftp" ? "（当前）" : ""}`,
    `ftps${current.transport === "ftps" ? "（当前）" : ""}`,
  ]);
  if (!transportChoice) return;
  // 选项带「（当前）」后缀，解析要按传输名而不是第一段空白。
  const transport = (["openssh", "ftps", "ftp", "ssh2", "auto"] as const).find((item) => transportChoice.startsWith(item));
  if (!transport) {
    ctx.ui.notify(`无法识别的传输方式：${transportChoice}`, "error");
    return;
  }
  await finishDraft(ctx, deps, {
    name: newName,
    host: host || current.host,
    user,
    port,
    transport,
    existing: current,
  });
}

/** 只换凭据，不动地址。编辑地址请走「编辑连接信息」。 */
export async function updateCredentialInteractive(ctx: any, deps: PanelDeps, name?: string): Promise<void> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "选择要更新凭据的主机"));
  if (!target) return;
  const current = file.hosts[target];
  if (!current) return;
  const auth = await askAuth(ctx, deps, {
    name: target,
    host: current.host,
    user: current.user,
    transport: current.transport,
    existing: current,
  });
  if (!auth) return;

  let secretRef = current.auth.secretRef;
  let pendingKey: string | undefined;
  if (auth.authKind === "password" && auth.password) {
    // 同 finishDraft：先写临时键，实测失败只删临时键，不碰旧密码。
    pendingKey = `${target}.pending-${randomUUID().slice(0, 8)}`;
    putSecret(secretsPathOf(deps), pendingKey, auth.password);
    secretRef = `file:${secretsPathOf(deps)}#${pendingKey}`;
  }
  const next: HostProfile = {
    ...current,
    auth: {
      kind: auth.authKind,
      privateKeyPath: auth.authKind === "key" ? auth.privateKeyPath : undefined,
      secretRef: auth.authKind === "password" ? secretRef : undefined,
      passphraseRef: current.auth.passphraseRef,
    },
  };
  try {
    const tested = await testCandidate(ctx, deps, next);
    if (pendingKey) {
      // 实测通过：临时键转正
      putSecret(secretsPathOf(deps), target, auth.password!);
      deleteSecret(secretsPathOf(deps), pendingKey);
      next.auth = { ...next.auth, secretRef: `file:${secretsPathOf(deps)}#${target}` };
    }
    const hosts = { ...file.hosts, [target]: next };
    persist(deps, { ...file, hosts });
    ctx.ui.notify(`凭据已更新，${describeTestResult(tested)}`, "success");
  } catch (error) {
    if (pendingKey) {
      try {
        deleteSecret(secretsPathOf(deps), pendingKey);
      } catch {
        // 不盖住真实错误
      }
    }
    ctx.ui.notify(`未保存：${messageOf(error)}`, "error");
  }
}

/** 部署布局：留空 root = 清除布局（这台机器就只做文件与命令，不发布）。 */
export async function editDeployInteractive(ctx: any, deps: PanelDeps, name?: string): Promise<void> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "选择要配置部署布局的主机"));
  if (!target) return;
  const current = file.hosts[target];
  if (!current) return;
  if (current.transport === "ftp" || current.transport === "ftps") {
    ctx.ui.notify(`${target} 是 ${current.transport}，只能传文件，不能部署。`, "error");
    return;
  }
  const layout = current.deploy;
  const root = (await ctx.ui.input("部署根目录（留空 = 清除部署布局）", layout?.root ?? "/srv/app"))?.trim();
  if (root === undefined) return;

  const hosts = { ...file.hosts };
  if (!root) {
    const next = { ...current, deploy: undefined };
    hosts[target] = next;
    persist(deps, { ...file, hosts });
    ctx.ui.notify(`已清除 ${target} 的部署布局（不能再 ssh_deploy / release 回滚）`, "info");
    return;
  }
  const releasesDir = (await ctx.ui.input("releases 目录名", layout?.releasesDir ?? "releases"))?.trim() || "releases";
  const currentLink = (await ctx.ui.input("current 软链名", layout?.currentLink ?? "current"))?.trim() || "current";
  const sharedDir = (await ctx.ui.input("shared 目录名", layout?.sharedDir ?? "shared"))?.trim() || "shared";
  const restartCmd = (await ctx.ui.input("重启命令（留空 = 部署后不重启）", layout?.restartCmd ?? ""))?.trim() || undefined;
  const healthCmd = (await ctx.ui.input("健康检查命令（留空 = 失败不自动回退）", layout?.healthCmd ?? ""))?.trim() || undefined;
  const keepText = (await ctx.ui.input("保留版本数", String(layout?.keepReleases ?? 5)))?.trim();
  const keepReleases = keepText ? Number(keepText) : undefined;
  if (keepReleases !== undefined && (!Number.isInteger(keepReleases) || keepReleases < 1)) {
    ctx.ui.notify("保留版本数必须是正整数", "error");
    return;
  }
  const deploy: DeployLayout = { root, releasesDir, currentLink, sharedDir, restartCmd, healthCmd, keepReleases };
  hosts[target] = { ...current, deploy };
  persist(deps, { ...file, hosts });
  ctx.ui.notify(`部署布局已保存\n${deployLayoutLines(deploy).join("\n")}`, "success");
}

async function runRemoteCommand(ctx: any, deps: PanelDeps, name?: string, preset?: string): Promise<void> {
  const file = load(deps);
  // /ssh exec 的语义是「打活动主机」：没设活动主机但只有一台时也直接打它，
  // 与旧版 runtime.allowActive 的行为保持一致（以前单主机无 activeHost 会弹选择框且空跑）。
  const names = Object.keys(file.hosts);
  const only = names.length === 1 ? names[0] : undefined;
  const target = name ?? file.activeHost ?? only ?? (await pickHost(ctx, file, "在哪个主机执行"));
  if (!target) {
    ctx.ui.notify("没有活动主机。先「⚡ 切换活动主机」，或在 /ssh exec 前指定主机。", "warning");
    return;
  }
  if (!file.hosts[target]) {
    ctx.ui.notify(`没有名为 ${target} 的主机`, "error");
    return;
  }
  const command = preset ?? (await ctx.ui.input("远端命令（无 TTY，sudo 请用 ssh_sudo）", ""))?.trim();
  if (!command) return;
  try {
    const result = await deps.runtime.exec({
      command,
      host: target,
      ui: deps.confirmUi(ctx),
    });
    const status = result.exitCode === null ? "超时或中止" : `退出码 ${result.exitCode}`;
    ctx.ui.notify(`${target} ${status}\n${result.text}`, result.exitCode === 0 ? "info" : "error");
  } catch (error) {
    ctx.ui.notify(messageOf(error), "error");
  }
}

async function grantInteractive(ctx: any, deps: PanelDeps, name?: string, minutesArg?: string): Promise<void> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "给哪台主机写授权"));
  if (!target) return;
  const host = file.hosts[target];
  if (!host) return;
  if (isProdHost(host)) {
    ctx.ui.notify(`${target} 是生产主机，不能授予会话级写授权。`, "error");
    return;
  }
  const minutesText = minutesArg ?? (await ctx.ui.input("授权分钟数", "10"))?.trim();
  const minutes = Number(minutesText);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    ctx.ui.notify("分钟数必须是正数", "error");
    return;
  }
  const accepted = await ctx.ui.confirm("写授权", `${target} 在 ${minutes} 分钟内不再逐条确认写操作。破坏性操作仍要确认。`);
  if (!accepted) return;
  try {
    deps.runtime.grantWrite(target, minutes);
    ctx.ui.notify(`${target} 的写操作在 ${minutes} 分钟内不再逐条确认。`, "success");
  } catch (error) {
    ctx.ui.notify(messageOf(error), "error");
  }
}

async function deleteInteractive(ctx: any, deps: PanelDeps, name?: string): Promise<boolean> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "选择要删除的主机"));
  if (!target) return false;
  const accepted = await ctx.ui.confirm("删除主机", `确定删除 ${target}？\n配置文件里的这一项会被移除，密码留在 ssh-secrets.json 里的条目一并清掉。`);
  if (!accepted) return false;
  const hosts = { ...file.hosts };
  const removed = hosts[target];
  delete hosts[target];
  const activeHost = file.activeHost === target ? undefined : file.activeHost;
  persist(deps, { ...file, hosts, activeHost });
  // 凭据只在这一台用的时候才删：复制出来的主机可能共用同一个 secretRef。
  const parsed = secretRefKey(removed?.auth.secretRef);
  if (parsed && otherReferences(file, parsed.path, parsed.key, target).length === 0) {
    try {
      deleteSecret(parsed.path, parsed.key);
    } catch {
      // 凭据文件损坏时删除失败不该挡住配置删除，密码条目本身已无法定位。
    }
  }
  ctx.ui.notify(`已删除 ${target}`, "success");
  return true;
}

async function setActiveInteractive(ctx: any, deps: PanelDeps, name?: string): Promise<void> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "切换活动主机"));
  if (!target) return;
  if (!file.hosts[target]) {
    ctx.ui.notify(`没有名为 ${target} 的主机`, "error");
    return;
  }
  if (file.activeHost === target) {
    persist(deps, { ...file, activeHost: undefined });
    ctx.ui.notify(`已取消活动主机（${target}）`, "info");
    return;
  }
  persist(deps, { ...file, activeHost: target });
  ctx.ui.notify(`活动主机已切换为 ${target}`, "success");
}

async function testInteractive(ctx: any, deps: PanelDeps, name?: string): Promise<void> {
  const file = load(deps);
  const target = name ?? (await pickHost(ctx, file, "测试哪台主机"));
  if (!target) return;
  try {
    const result = await testWithTofu(ctx, deps, target);
    ctx.ui.notify(`${target} ${describeTestResult(result)}`, "success");
  } catch (error) {
    ctx.ui.notify(`${target} ✗ ${messageOf(error)}`, "error");
  }
}

async function testAllInteractive(ctx: any, deps: PanelDeps): Promise<void> {
  const file = load(deps);
  const names = Object.keys(file.hosts);
  if (names.length === 0) {
    ctx.ui.notify("还没有主机", "info");
    return;
  }
  const lines: string[] = [];
  for (const name of names) {
    try {
      // 全量测试不弹指纹确认：未知指纹只报出来，避免一串弹窗点到底。
      const result = await deps.runtime.testHost({ host: name });
      lines.push(`✓ ${name} ${describeTestResult(result).replace(/^✓ /, "")}`);
    } catch (error) {
      const hint = error instanceof HostKeyUnknownError ? "（未知主机密钥，请单独测试并核对指纹）" : "";
      lines.push(`✗ ${name} ${messageOf(error)}${hint}`);
    }
  }
  ctx.ui.notify(`连接测试（${names.length} 台）\n${lines.join("\n")}`, "info");
}

async function showHostDetail(ctx: any, deps: PanelDeps, name: string): Promise<void> {
  const file = load(deps);
  const profile = file.hosts[name];
  if (!profile) return;
  ctx.ui.notify(hostDetailLines(profile, file, hasSecretOf(deps, profile)).join("\n"), "info");
}

async function showAudit(ctx: any, deps: PanelDeps, arg?: string): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    rows = readAudit(auditPathOf(deps));
  } catch (error) {
    // 审计文件末尾被截断（进程被杀/磁盘满）时 readAudit 会抛 SyntaxError，
    // 以前这个异常直接冒出去把面板打崩，用户什么都看不到。
    ctx.ui.notify(
      `审计文件读不出来：${messageOf(error)}\n${auditPathOf(deps)}\n` +
      "文件可能被截断（进程中断或磁盘满），可以手工清空或移到别处后再试。",
      "error",
    );
    return;
  }
  if (rows.length === 0) {
    ctx.ui.notify("还没有审计记录", "info");
    return;
  }
  const hosts = Array.from(new Set(rows.map((row) => String(row.host ?? "")))).filter(Boolean);
  const limit = arg && /^\d+$/.test(arg) ? Number(arg) : 20;
  let host: string | undefined = arg && !/^\d+$/.test(arg) ? arg : undefined;
  if (!host && hosts.length > 0 && !arg) {
    const choice = await ctx.ui.select("审计范围", ["全部主机", ...hosts.map((item) => `只看 ${item}`)]);
    if (!choice) return;
    if (choice !== "全部主机") host = choice.replace(/^只看 /, "");
  }
  const lines = auditLines(rows, { host, limit });
  ctx.ui.notify(`审计（最近 ${lines.length} 条${host ? `，主机 ${host}` : ""}）\n${lines.join("\n")}`, "info");
}

async function showDoctor(ctx: any): Promise<void> {
  ctx.ui.notify(doctorLines().join("\n"), "info");
}

async function showHostList(ctx: any, deps: PanelDeps): Promise<void> {
  const file = load(deps);
  const names = Object.keys(file.hosts);
  if (names.length === 0) {
    ctx.ui.notify("还没有主机。用「➕ 新增主机」，或在对话里说「把我 ~/.ssh/config 里的主机加进来」。", "info");
    return;
  }
  const { list } = buildHostList(file);
  const active = file.activeHost ? `活动主机：${file.activeHost}` : "没有活动主机";
  ctx.ui.notify(`SSH 主机（${names.length}）· ${active}\n${list.map((line) => `  ${line}`).join("\n")}`, "info");
}

export async function runPolicyMenu(ctx: any, deps: PanelDeps): Promise<void> {
  // 当前值写在选项文字里，不再每轮 notify 一遍（pi web 下那是一个个 toast，刷屏）。
  while (true) {
    const file = load(deps);
    const policy = effectivePolicy(file);
    const choice = await ctx.ui.select("SSH 策略设置", [
      `🔒 只读模式：${policy.readonly ? "开" : "关"}`,
      `✅ 确认级别：${confirmLabel(policy.confirm)}`,
      "♻️ 恢复默认（关只读 + 仅破坏性确认）",
      BACK,
    ]);
    if (!choice || choice === BACK) return;
    const next = { ...file, policy: { ...policy } };
    if (choice.startsWith("🔒")) {
      next.policy.readonly = !policy.readonly;
    } else if (choice.startsWith("✅")) {
      const level = await ctx.ui.select("确认级别", [
        "仅破坏性确认（默认）",
        "写操作与破坏性都确认",
        "每次都确认（含只读命令）",
      ]);
      if (!level) continue;
      next.policy.confirm = level.startsWith("写操作") ? "write" : level.startsWith("每次") ? "always" : "destructive";
    } else if (choice.startsWith("♻️")) {
      next.policy = { readonly: false, confirm: "destructive" };
    }
    persist(deps, next);
    ctx.ui.notify(`策略已保存\n${policyLines(next).join("\n")}`, "success");
  }
}

export async function runHostPanel(ctx: any, deps: PanelDeps, name: string): Promise<void> {
  while (true) {
    const file = load(deps);
    const host = file.hosts[name];
    if (!host) {
      ctx.ui.notify(`主机 ${name} 已不存在`, "error");
      return;
    }
    const active = file.activeHost === name;
    const prod = isProdHost(host);
    const title = `主机 ${name}${active ? "（活动）" : ""}${prod ? "（生产）" : ""}`;
    const choice = await ctx.ui.select(title, [
      "🧪 测试连接",
      "🔍 查看详情",
      active ? "⭕ 取消活动主机" : "⚡ 设为活动主机",
      prod ? "🏷️ 移除 prod 标签" : "🏷️ 标记为生产主机",
      "🔑 更新凭据",
      "✏️ 编辑连接信息",
      "🚀 编辑部署布局",
      "💻 执行命令",
      "🔓 会话写授权",
      "📜 该主机的审计",
      "🗑️ 删除主机",
      BACK,
    ]);
    if (!choice || choice === BACK) return;

    if (choice === "🧪 测试连接") {
      await testInteractive(ctx, deps, name);
    } else if (choice === "🔍 查看详情") {
      await showHostDetail(ctx, deps, name);
    } else if (choice === "⭕ 取消活动主机" || choice === "⚡ 设为活动主机") {
      // 以前用 endsWith("活动主机") 同时命中两个选项，靠内部再判当前状态兜；改成显式分支。
      await setActiveInteractive(ctx, deps, name);
    } else if (choice.startsWith("🏷️")) {
      const latest = load(deps);
      const profile = latest.hosts[name];
      if (!profile) return;
      const hosts = { ...latest.hosts, [name]: { ...profile, tags: withProdTag(profile.tags, !prod) } };
      persist(deps, { ...latest, hosts });
      ctx.ui.notify(!prod ? `${name} 已标记为生产主机` : `${name} 已移除 prod 标签`, "success");
    } else if (choice === "🔑 更新凭据") {
      await updateCredentialInteractive(ctx, deps, name);
    } else if (choice === "✏️ 编辑连接信息") {
      await editHostInteractive(ctx, deps, name);
    } else if (choice === "🚀 编辑部署布局") {
      await editDeployInteractive(ctx, deps, name);
    } else if (choice === "💻 执行命令") {
      await runRemoteCommand(ctx, deps, name);
    } else if (choice === "🔓 会话写授权") {
      await grantInteractive(ctx, deps, name);
    } else if (choice === "📜 该主机的审计") {
      await showAudit(ctx, deps, name);
    } else if (choice === "🗑️ 删除主机") {
      const deleted = await deleteInteractive(ctx, deps, name);
      if (deleted) return;
    }
  }
}

export async function runSshPanel(ctx: any, deps: PanelDeps): Promise<void> {
  while (true) {
    const file = load(deps);
    const count = Object.keys(file.hosts).length;
    const active = file.activeHost ? `，活动 ${file.activeHost}` : "";
    const choice = await ctx.ui.select(`SSH 管理（${count} 台${active}）`, [
      "🖥️ 主机列表 / 单台管理",
      "⚡ 切换活动主机",
      "➕ 新增主机",
      "🔎 扫描建连（会话 AI）",
      "🧪 测试全部连接",
      "⚙️ 策略设置",
      "📜 审计日志",
      "🩺 本机体检",
      BACK,
    ]);
    if (!choice || choice === BACK) return;

    if (choice.startsWith("🖥️")) {
      const target = await pickHost(ctx, load(deps), "选择主机");
      if (target) await runHostPanel(ctx, deps, target);
    } else if (choice.startsWith("⚡")) {
      await setActiveInteractive(ctx, deps);
    } else if (choice.startsWith("➕")) {
      await addHostInteractive(ctx, deps);
    } else if (choice.startsWith("🔎")) {
      ctx.ui.notify(
        "扫描建连由会话 AI 驱动：在对话框直接说「把我 ~/.ssh/config 里的主机加进来」或「扫一下这个项目的部署配置」。\n" +
        "AI 会走 ssh_scan_sources → 读文件提取 → ssh_host_save，逐个弹框确认后建连，绝不静默写盘。",
        "info",
      );
    } else if (choice.startsWith("🧪")) {
      await testAllInteractive(ctx, deps);
    } else if (choice.startsWith("⚙️")) {
      await runPolicyMenu(ctx, deps);
    } else if (choice.startsWith("📜")) {
      await showAudit(ctx, deps);
    } else if (choice.startsWith("🩺")) {
      await showDoctor(ctx);
    }
  }
}

/**
 * `/ssh` 子命令路由。无参数打开面板；子命令直达同一个面板里的动作，
 * 不另写一套流程，避免面板与命令行为分叉。
 */
export async function handleSshCommand(args: string, ctx: any, deps: PanelDeps): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  const rest = parts.slice(1);
  const file = load(deps);

  switch (sub) {
    case undefined:
      return runSshPanel(ctx, deps);
    case "ls":
    case "list":
      return showHostList(ctx, deps);
    case "add":
    case "new":
      return addHostInteractive(ctx, deps);
    case "edit":
      return editHostInteractive(ctx, deps, rest[0]);
    case "rm":
    case "remove":
    case "del":
    case "delete":
      return void (await deleteInteractive(ctx, deps, rest[0]));
    case "use":
      return setActiveInteractive(ctx, deps, rest[0]);
    case "test":
      return testInteractive(ctx, deps, rest[0]);
    case "testall":
      return testAllInteractive(ctx, deps);
    case "exec":
      return runRemoteCommand(ctx, deps, file.activeHost, rest.join(" "));
    case "grant":
      return grantInteractive(ctx, deps, rest[0], rest[1]);
    case "log":
      return showAudit(ctx, deps, rest[0]);
    case "config":
      return runPolicyMenu(ctx, deps);
    case "scan":
      ctx.ui.notify(
        "扫描建连已交给会话 AI：在对话框说「把我 ~/.ssh/config 里的主机加进来」或「扫一下这个项目的部署配置」。\n" +
        "AI 会解析 ~/.ssh/config、列项目里的部署文件，提取候选后逐个确认保存。",
        "info",
      );
      return;
    case "doctor":
      return showDoctor(ctx);
    default:
      ctx.ui.notify(USAGE, "info");
  }
}
