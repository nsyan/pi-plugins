// core/policy.ts
import type { Verdict } from "../dialects/dialect.js";

export type ConfirmMode = "never" | "write" | "always";

export function decide(verdict: Verdict, _readonly: boolean, confirm: ConfirmMode): "run" | "confirm" | "deny" {
  if (!verdict.ok) return "deny";
  if (confirm === "always") return "confirm";
  if (confirm === "write" && verdict.isWrite) return "confirm";
  return "run";
}

/** 生效只读 = 全局只读 ∨ 连接级强制只读（v1.1 UX 共识 Q3；isAllowed/ExecOpts 均用此值） */
export function effectiveReadonly(aiReadonly: boolean, config: { forceReadonly?: boolean }): boolean {
  return aiReadonly || config.forceReadonly === true;
}

/**
 * 写操作是否缺失执行理由（v1.1 UX 共识 Q1/Q3：与确认策略解耦，isWrite 即要求）。
 * 命中时工具层应拒绝执行并引导 AI 补充 reason（动机+影响范围）。
 */
export function writeRequiresReason(verdict: Verdict, reason?: string): boolean {
  return verdict.ok === true && verdict.isWrite === true && !(typeof reason === "string" && reason.trim() !== "");
}
