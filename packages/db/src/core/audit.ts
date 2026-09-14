// core/audit.ts —— 写操作审计日志（v1.1 UX 共识 Q4 + 轮转共识：按本地日期一天一个 .jsonl，SQL 存完整原文不截断）
// 注：本模块只做文件 IO，不依赖任何 pi 运行时模块；审计失败静默降级，绝不阻断查询主流程

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DbTypeId } from "./types.js";

/** 审计目录：~/.pi/agent/db-audit/，按天一个 <YYYY-MM-DD>.jsonl */
export const AUDIT_DIR = join(homedir(), ".pi", "agent", "db-audit");

export interface AuditEntry {
  /** ISO 时间 */
  time: string;
  /** 执行时的项目路径（会话 cwd = ctx.cwd），跨项目区分用 */
  project: string;
  /** 连接名 */
  connection: string;
  /** 数据库类型 */
  type: DbTypeId;
  /** verdict.summary（如 "UPDATE orders（共 1 条语句）"） */
  summary: string;
  /** AI 提供的执行理由（全文） */
  reason: string;
  /** 完整 SQL（共识：不截断） */
  sql: string;
  /** 执行时的生效只读标记（写成功恒为 false，保留字段以备语义扩展） */
  readonly: boolean;
}

/** 本地日期 → YYYY-MM-DD（审计文件按本地天轮转） */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 审计文件路径：<dir>/<YYYY-MM-DD>.jsonl（按 time 的本地日期取天） */
export function auditFilePath(time: Date, dir: string = AUDIT_DIR): string {
  return join(dir, `${localDateStr(time)}.jsonl`);
}

// 目录 mkdir / 文件 chmod 仅进程生命周期内首次执行（后续每次追加只剩 1 次 appendFileSync syscall）
const ensuredDirs = new Set<string>();
const chmoddedFiles = new Set<string>();

/**
 * 追加一条审计记录到按天轮转的 JSONL 文件（一行一条）。
 * 同步写入保证返回结果前已落盘（单次开销亚毫秒级）；失败静默降级不阻断主流程。
 * @param entry 审计条目
 * @param dir 审计目录，默认 AUDIT_DIR（测试可注入临时目录）
 */
export function appendAuditLog(entry: AuditEntry, dir: string = AUDIT_DIR): void {
  try {
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      ensuredDirs.add(dir);
    }
    const file = auditFilePath(new Date(entry.time), dir);
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
    if (!chmoddedFiles.has(file)) {
      try { chmodSync(file, 0o600); } catch { /* 平台不支持等场景容错 */ }
      chmoddedFiles.add(file);
    }
  } catch { /* 审计失败不影响主流程 */ }
}
