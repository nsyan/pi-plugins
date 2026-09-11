// scan/validate.ts —— AI 提交候选的校验层（防幻觉 + 归一化，纯函数可单测）
// 设计（v1.3.0 共识）：候选由会话模型从配置文件提取后经 db_scan_save 提交。
//   模型可能编造 host/类型，这里用确定性规则过滤：
//   ① dialectId 必须在 registry ② 带 url 时方言 parseUrl 必须能解析（claim 与 url 矛盾即拒）
//   ③ 无 url 时 host 必填、port 范围校验 ④ REQUIRED 表判定缺字段 ⑤ 同名查重

import { basename } from "node:path";
import { registry } from "../../dialects/index.js";
import type { Candidate, CandidateInput, CandidateStatus, ConnConfig, DbTypeId } from "../types.js";

/** 各类型建连必需字段（空串同样视为缺失）——家族语义，非正则，保留 */
const REQUIRED: Record<DbTypeId, string[]> = {
  postgresql: ["host", "port", "database", "username", "password"],
  mysql: ["host", "port", "database", "username", "password"],
  oracle: ["host", "port", "database", "username", "password"],
  dm: ["host", "port", "database", "username", "password"],
  hive: ["host", "port", "database", "username"],
  spark: ["host", "port", "database", "username"],
  redis: ["host", "port", "password"],
  elasticsearch: ["host", "port"],
  neo4j: ["host", "port", "username", "password"], // 工作库可选（缺省 neo4j；社区版默认开认证）
  mongodb: ["host", "port"], // 账号/工作库可选（本地无认证常见）
};

function nonEmpty(v: unknown): v is string | number {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

export interface ValidateResult {
  candidates: Candidate[];
  rejected: string[];   // 被拒候选及原因（回传给模型可自查重提）
}

/** 校验 + 归一化一批模型提交的候选 */
export function validateCandidates(raw: unknown, existingNames: Set<string>): ValidateResult {
  const list = Array.isArray(raw) ? raw : [raw];
  const candidates: Candidate[] = [];
  const rejected: string[] = [];
  const seenNames = new Set(existingNames);

  for (const [i, item] of list.entries()) {
    if (item === null || typeof item !== "object") {
      rejected.push(`#${i + 1}: 非对象，已丢弃`);
      continue;
    }
    const c = item as Record<string, unknown> & Partial<CandidateInput>;

    // ① 类型必须被注册表认领
    const dialect = registry.get(c.dialectId as DbTypeId);
    if (!dialect) {
      rejected.push(`#${i + 1}: 未知数据库类型 ${JSON.stringify(c.dialectId)}，支持: ${[...registry.keys()].join("/")}`);
      continue;
    }

    // ② 带 url 时：方言 parseUrl 必须能解析（防幻觉——claim 与 url 矛盾整条拒）
    //    解析成功时以解析结果为准（host/port/database/username/password 由 URL 补全）
    // 归一化后 port/dbIndex 恒为 number（下行 parseInt 收敛）。此处用 Partial<ConnConfig> 而非
    // Partial<CandidateInput>——后者的 port 是 number|string，会让下方端口范围校验退化为字符串比较。
    let bag: Partial<ConnConfig> = {
      host: typeof c.host === "string" ? c.host.trim() : undefined,
      port: typeof c.port === "number" ? c.port : parseInt(String(c.port ?? ""), 10) || undefined,
      username: nonEmpty(c.username) ? String(c.username) : undefined,
      password: nonEmpty(c.password) ? String(c.password) : undefined,
      database: nonEmpty(c.database) ? String(c.database) : undefined,
      dbIndex: typeof c.dbIndex === "number" ? c.dbIndex : parseInt(String(c.dbIndex ?? ""), 10) || undefined,
    };
    if (nonEmpty(c.url)) {
      const parsed = dialect.parseUrl(String(c.url).trim());
      if (!parsed) {
        rejected.push(`#${i + 1}: url 无法被 ${dialect.id} 方言解析（疑似编造），已拒绝: ${String(c.url).slice(0, 80)}`);
        continue;
      }
      bag = {
        ...bag,
        host: parsed.host,
        port: parsed.port,
        username: bag.username ?? parsed.username,
        password: bag.password ?? parsed.password,
        database: bag.database ?? parsed.database,
        dbIndex: bag.dbIndex ?? parsed.dbIndex,
      };
    }

    // ③ 无 url 时 host 必填；port 范围校验
    if (!nonEmpty(bag.host)) {
      rejected.push(`#${i + 1}: ${dialect.id} 候选缺 host（无 url 时 host 必填）`);
      continue;
    }
    if (bag.port !== undefined && (!Number.isInteger(bag.port) || bag.port < 1 || bag.port > 65535)) {
      rejected.push(`#${i + 1}: ${dialect.id} 候选 port 非法: ${bag.port}`);
      continue;
    }

    // ④ 缺字段判定
    const missing = (REQUIRED[dialect.id] ?? []).filter((f) => !nonEmpty(bag[f as keyof ConnConfig]));

    // ⑤ 命名：显式 name > 默认；同名（含与本批前序候选撞名）→ exists 状态
    let name = nonEmpty(c.name) ? String(c.name).trim()
      : `${dialect.id}-${bag.host}${bag.database ? "-" + bag.database : ""}`;
    let status: CandidateStatus = missing.length > 0 ? "incomplete" : "ready";
    if (seenNames.has(name)) status = "exists";
    seenNames.add(name);

    candidates.push({
      status,
      dialectId: dialect.id,
      partial: { name, ...bag } as Partial<import("../types.js").ConnConfig>,
      missing,
      source: nonEmpty(c.source) ? String(c.source) : "AI 提取",
      warnings: Array.isArray(c.warnings) ? c.warnings.map(String).slice(0, 3) : undefined,
    });
  }
  return { candidates, rejected };
}

/** 供展示层使用的默认项目名（db_scan_save 的 name 兜底） */
export function defaultProjectName(root: string): string {
  return basename(root);
}
