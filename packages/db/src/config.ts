// config.ts —— 连接配置与插件配置读写（含旧文件名兼容 + mtime 内存缓存）
// 注：本模块只做 JSON 文件 IO，不依赖任何 pi 运行时模块
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "./dialects/index.js";
import type { ConnConfig, DbTypeId, TestConnectionResult } from "./core/types.js";

// ── 路径 ──────────────────────────────────────────

export const CONFIG_FILE = join(homedir(), ".pi", "agent", "db-configs.json");
export const PLUGIN_CONFIG_FILE = join(homedir(), ".pi", "agent", "db-config.json");
const LEGACY_PLUGIN_CONFIG_FILE = join(homedir(), ".pi", "agent", "db-plugin-config.json");

// ── 插件全局配置 ──────────────────────────────────

export interface PluginConfig {
  /** AI 是否只能执行 SELECT（禁止写入） */
  ai_readonly: boolean;
  /** SQL 执行前确认策略: never=不确认 / write=写操作前确认 / always=每次都确认 */
  confirm_before_exec: "never" | "write" | "always";
  /** 查询返回的最大行数 */
  max_rows: number;
  /** 单条 SQL 超时秒数 */
  query_timeout: number;
  /** 写操作审计日志（v1.1 UX 共识 Q4 修订：默认关闭，/db config 开启；reason 强校验不受此开关影响） */
  audit_enabled: boolean;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  ai_readonly: true,
  confirm_before_exec: "write",
  max_rows: 100,
  query_timeout: 30,
  audit_enabled: false,
};

// ── mtime 内存缓存 ────────────────────────────────

// 注：必须用 Map 按文件名 key——单槽缓存在 db-configs.json 与 db-config.json 交替读时永不命中
const caches = new Map<string, { mtime: number; data: unknown }>();

function readJsonCached<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const mtime = statSync(file).mtimeMs;
  const hit = caches.get(file);
  if (hit && hit.mtime === mtime) return hit.data as T;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as T;
    caches.set(file, { mtime, data });
    return data;
  } catch { return fallback; }
}

export function invalidateConfigCache(file?: string): void {
  if (file) caches.delete(file); else caches.clear();
}

// ── 连接配置读写（存储态即 ConnConfig[]，Spec §2.0 配置类型裁决）───

interface LegacyStoredConfig extends Record<string, unknown> {
  extraParams?: Record<string, string>;
}

function migrateStored(raw: unknown): ConnConfig {
  const c = raw as LegacyStoredConfig & Partial<ConnConfig>;
  const { extraParams, ...rest } = c;
  const out = rest as ConnConfig;
  // 旧文件 extraParams（历史 DbConfig 字段，代码未使用）并入 options
  if (extraParams && typeof extraParams === "object") {
    out.options = { ...(out.options ?? {}), ...extraParams };
  }
  return out;
}

export function loadConfigs(): ConnConfig[] {
  const raw = readJsonCached<unknown[]>(CONFIG_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(migrateStored);
}

export function saveConfigs(configs: ConnConfig[]): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
  // 降险（v1.1 UX 共识 Q4）：配置含明文密码，限制为仅当前用户可读写
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* 只读文件系统等场景容错 */ }
  invalidateConfigCache(CONFIG_FILE);
}

// ── 插件全局配置读写（含旧名 db-plugin-config.json 兼容）───

export function loadPluginConfig(): PluginConfig {
  if (!existsSync(PLUGIN_CONFIG_FILE)) {
    // 兼容旧版配置文件名
    if (existsSync(LEGACY_PLUGIN_CONFIG_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(LEGACY_PLUGIN_CONFIG_FILE, "utf-8"));
        return { ...DEFAULT_PLUGIN_CONFIG, ...raw };
      } catch {
        return { ...DEFAULT_PLUGIN_CONFIG };
      }
    }
    return { ...DEFAULT_PLUGIN_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(PLUGIN_CONFIG_FILE, "utf-8"));
    return { ...DEFAULT_PLUGIN_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_PLUGIN_CONFIG };
  }
}

export function savePluginConfig(cfg: PluginConfig): void {
  writeFileSync(PLUGIN_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  invalidateConfigCache(PLUGIN_CONFIG_FILE);
}

export function getConfigSummary(cfg: PluginConfig): string {
  const readonlyLabel = cfg.ai_readonly ? "是" : "否";
  const confirmLabel =
    cfg.confirm_before_exec === "never" ? "不确认" :
    cfg.confirm_before_exec === "write" ? "写操作确认" : "每次都确认";
  return [
    `AI 只读: ${readonlyLabel}`,
    `执行确认: ${confirmLabel}`,
    `最大行数: ${cfg.max_rows}`,
    `查询超时: ${cfg.query_timeout}s`,
    `审计日志: ${cfg.audit_enabled ? "开" : "关"}`,
  ].join("\n");
}

// ── 辅助: 查找数据库配置（忽略大小写和首尾空格） ────

export function findConfig(configs: ConnConfig[], name: string): ConnConfig | undefined {
  const target = name.trim().toLowerCase();
  return configs.find((c) => c.name.toLowerCase() === target);
}

// ── 一键连接串解析（Spec §11.1 P0）──────────────
// 遍历 registry 各方言 parseUrl，首个非 null 胜出（各方言兼收 JDBC + 原生 URI 双形态，Spec §7）

export interface ParsedConnectionString {
  dialectId: DbTypeId;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  dbIndex?: number;
  /** URI 查询参数（MongoDB: authSource/replicaSet/tls...） */
  options?: Record<string, string>;
}

export function parseConnectionString(input: string): ParsedConnectionString | null {
  const url = input.trim();
  if (!url) return null;
  for (const d of registry.values()) {
    const p = d.parseUrl(url);
    if (!p) continue;
    // 仅保留有值字段（undefined 键会让 deepEqual 语义变脏，也避免下游覆盖默认值）
    const out: ParsedConnectionString = { dialectId: d.id, host: p.host, port: p.port };
    if (p.username !== undefined) out.username = p.username;
    if (p.password !== undefined) out.password = p.password;
    if (p.database !== undefined) out.database = p.database;
    if (p.dbIndex !== undefined) out.dbIndex = p.dbIndex;
    if (p.options !== undefined) out.options = p.options;
    return out;
  }
  return null;
}

// ── 使用/测试记录（v1.1 UX 共识 Q1：连接列表摘要的数据源）───

/** 回写最近使用时间（查询/列表/表结构成功后调用；找不到连接时静默跳过） */
export function recordLastUsed(configName: string): void {
  const all = loadConfigs();
  const c = all.find((x) => x.name === configName);
  if (!c) return;
  c.lastUsedAt = new Date().toISOString();
  saveConfigs(all);
}

/** 回写最近一次测试连接结果（测试连接/编辑后自动测试/向导建连成功时调用） */
export function recordTestResult(configName: string, r: TestConnectionResult): void {
  const all = loadConfigs();
  const c = all.find((x) => x.name === configName);
  if (!c) return;
  c.lastTest = { ok: r.success, latency: r.latency, version: r.version, at: new Date().toISOString() };
  saveConfigs(all);
}

/** 相对时间文案：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return iso.slice(0, 10);
}

/** 环境标签片段：[prod·强制只读] / [dev]；无标签返回空串 */
export function envTagLabel(c: Pick<ConnConfig, "envTag" | "forceReadonly">): string {
  if (!c.envTag) return "";
  return `[${c.envTag}${c.forceReadonly ? "·强制只读" : ""}]`;
}

/** 连接摘要行（选择列表/查看列表共用）：名称 [类型] ⭐默认 [prod·强制只读] · 上次使用 … · 测试 … */
export function connSummaryLine(c: ConnConfig): string {
  const parts = [`${c.name} [${shortTypeLabel(c.type)}]`];
  if (c.isDefault) parts.push("⭐默认");
  const tag = envTagLabel(c);
  if (tag) parts.push(tag);
  if (c.lastUsedAt) {
    const rel = formatRelativeTime(c.lastUsedAt);
    if (rel) parts.push(`上次使用 ${rel}`);
  }
  if (c.lastTest) {
    parts.push(`测试 ${c.lastTest.ok ? "✓" : "✗"}${c.lastTest.latency ?? ""}`);
  }
  const desc = c.description ? ` - ${c.description}` : "";
  return parts.join(" · ") + desc;
}

// ── 默认连接（Spec §11.1 P0：database 参数可选，缺省走 isDefault 标记的连接）───

export function getDefaultConfig(configs: ConnConfig[]): ConnConfig | undefined {
  return configs.find((c) => c.isDefault);
}

export function setDefaultConfig(configs: ConnConfig[], id: string): ConnConfig[] {
  return configs.map((c) => ({ ...c, isDefault: c.id === id }));
}

// ── 查询结果导出（Spec §11.1 P0：长结果落盘不糊上下文）───

import { toCsv } from "./core/export.js";

export interface QueryExport {
  csvPath: string;
  jsonPath: string;
}

/** 查询结果落盘 /tmp（CSV + JSON），返回路径；失败抛错由调用方容错 */
export function writeQueryExport(
  columns: string[],
  rows: unknown[][],
  baseName: string,
): QueryExport {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(tmpdir(), `${baseName}-${stamp}`);
  const csvPath = `${base}.csv`;
  const jsonPath = `${base}.json`;
  writeFileSync(csvPath, toCsv(columns, rows), "utf-8");
  writeFileSync(jsonPath, JSON.stringify({ columns, rows }, null, 2), "utf-8");
  return { csvPath, jsonPath };
}

// ── 运行时兜底（carry-over：替代已删除的 toConnConfig）───
// ConnConfig.host/port/database 为可选（非关系型家族不用）；关系型 doConnect
// 要求必填，此处在调用点补齐，保证 undefined 永不流入方言层。

export function toRuntimeConfig(c: ConnConfig, defaultPort: number): ConnConfig {
  return {
    ...c,
    host: c.host || "localhost",
    port: c.port || defaultPort,
    username: c.username ?? "",
    password: c.password ?? "",
  };
}

// 供 UI 层展示类型短标签（原 index.ts 内 5 处重复映射的收敛点之一）
export function shortTypeLabel(type: DbTypeId): string {
  return ({ postgresql: "PG", mysql: "MySQL", oracle: "Oracle", mongodb: "MongoDB" } as Record<string, string>)[type] ?? type;
}

export function fullTypeLabel(type: DbTypeId): string {
  return ({ postgresql: "PostgreSQL", mysql: "MySQL", oracle: "Oracle", mongodb: "MongoDB" } as Record<string, string>)[type] ?? type;
}
