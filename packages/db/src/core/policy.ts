// core/policy.ts
import type { Verdict } from "../dialects/dialect.js";

export type ConfirmMode = "never" | "write" | "always";

/**
 * 策略裁决。
 * @param verdict 方言给出的判定
 * @param readonly 生效只读（全局 ∨ 连接级强制只读）
 * @param confirm 确认策略
 * @param highRisk 高风险写（DDL / 授权 / 会话设置 / 写文件 / 副作用函数）。
 *   这类语句一旦 confirm_before_exec=never 就等于无门槛执行，所以**不受 never 豁免**：
 *   never 只对普通 DML 生效（按影响行数截断、可回滚），DDL 与授权类仍要过一眼。
 */
export function decide(verdict: Verdict, _readonly: boolean, confirm: ConfirmMode, highRisk = false): "run" | "confirm" | "deny" {
  if (!verdict.ok) return "deny";
  if (confirm === "always") return "confirm";
  if (confirm === "never") return highRisk ? "confirm" : "run";
  if (confirm === "write" && verdict.isWrite) return "confirm";
  return "run";
}

/** 生效只读 = 全局只读 ∨ 连接级强制只读（v1.1 UX 共识 Q3；isAllowed/ExecOpts 均用此值） */
export function effectiveReadonly(aiReadonly: boolean, config: { forceReadonly?: boolean }): boolean {
  return aiReadonly || config.forceReadonly === true;
}

/**
 * 该连接的写操作是否必须**先写审计再执行**（fail-closed）。
 * 生产库（envTag=prod）与强制只读连接的写操作一旦无法追溯，就不该执行。
 */
export function auditRequired(config: { envTag?: string; forceReadonly?: boolean }): boolean {
  return config.envTag === "prod" || config.forceReadonly === true;
}

/**
 * 写操作是否缺失执行理由（v1.1 UX 共识 Q1/Q3：与确认策略解耦，isWrite 即要求）。
 * 命中时工具层应拒绝执行并引导 AI 补充 reason（动机+影响范围）。
 */
export function writeRequiresReason(verdict: Verdict, reason?: string): boolean {
  return verdict.ok === true && verdict.isWrite === true && !(typeof reason === "string" && reason.trim() !== "");
}
