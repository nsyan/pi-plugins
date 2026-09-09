// core/policy.ts
import type { Verdict } from "../dialects/dialect.js";

export type ConfirmMode = "never" | "write" | "always";

export function decide(verdict: Verdict, _readonly: boolean, confirm: ConfirmMode): "run" | "confirm" | "deny" {
  if (!verdict.ok) return "deny";
  if (confirm === "always") return "confirm";
  if (confirm === "write" && verdict.isWrite) return "confirm";
  return "run";
}
