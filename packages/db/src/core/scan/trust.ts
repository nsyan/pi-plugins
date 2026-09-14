// scan/trust.ts —— 候选「来源可信度」评估（确定性规则，纯函数，可单测）
// 动机：db_scan_save 唯一的客观闸门是 testConnection，而「能连通」只证明库存在、凭据有效，
//   不证明它属于当前环境。同仓库常并存 dev/test/devops/prod/dm 多套配置，签入的配置中心
//   副本又会随时间漂移，模型很容易提取到废弃库名或别的环境地址——而且照样能测通。
//   本模块不判断配置对不对（无确定解），只把「来源能证明什么」分级、在确认框里显式展示，
//   把环境判断交回用户，而不是让它静默通过。
//
// 边界（必须明说）：评级输入是**模型自述的 `source` 文本**，不是独立取证——写什么就信什么。
//   它抬高的是「误连环境」的被发现概率（用户在确认框多看一眼），不构成安全保证；
//   真正的闸门只有 testConnection 与用户确认。
//   因此 🟢 要求 source 里有**远端检索证据**（URL / dataId / 显式「远端」）；仅出现产品名
//   （nacos/apollo/…）不升级——仓库里签入的同名副本会命中，而那恰恰是会漂移的东西。

export type TrustLevel = "high" | "medium" | "low";

export interface SourceTrust {
  level: TrustLevel;
  /** 从 source 识别出的环境标识（local/dev/test/devops/prod…），识别不出为 null */
  env: string | null;
  /** 展示给用户的中文理由：只陈述来源能证明什么，不含结论 */
  reasons: string[];
}

/** 远端检索证据：只有真的去远端拉过才会写进 source 的标记（URL / Nacos OpenAPI / dataId= / 显式「远端」） */
const REMOTE_EVIDENCE = /https?:\/\/|dataid\s*=|cs\/configs|(?:远端|远程|remote)/i;

/** 配置中心产品名：仓库里签入的副本文件名同样命中，不能单独证明「取自远端」 */
const CONFIG_CENTER_NAME = /\bnacos\b|\bapollo\b|\bconsul\b|config[-_ ]?center|config[-_ ]?server|spring-cloud-config/i;

/** 环境标识白名单：按分隔符整段比对，避免 "dev" 命中 "devops" */
const ENV_TOKENS = new Set([
  "local", "devops", "dev", "sit", "test", "uat", "stage", "staging", "pre", "gray", "prod", "release", "dm",
]);

const PROD_TOKENS = new Set(["prod", "release"]);

/** 从 source 文本取环境段（按 . _ - / \ # 空格 = 切分后整段匹配；切 `=` 使 `group=devops` 也能识别） */
export function envOf(source: string): string | null {
  for (const tok of source.toLowerCase().split(/[._\-/\\#\s=]+/)) {
    if (ENV_TOKENS.has(tok)) return tok;
  }
  return null;
}

/**
 * 批量评估来源可信度（跨候选的环境冲突必须看整批，故入口是数组）。
 * @param sources 与候选一一对应的 source 文本（空串表示未提供）
 */
export function assessSourceTrust(sources: readonly string[]): SourceTrust[] {
  const envs = sources.map(envOf);
  const distinct = [...new Set(envs.filter((e): e is string => e !== null))];

  return sources.map((source, i) => {
    const reasons: string[] = [];
    const env = envs[i];
    let level: TrustLevel;

    if (REMOTE_EVIDENCE.test(source)) {
      level = "high";
      reasons.push("来源含远端检索证据（URL / dataId / 显式「远端」）：远端配置是运行时真值");
    } else if (CONFIG_CENTER_NAME.test(source)) {
      level = "medium";
      reasons.push("来源自述为配置中心但未写远端证据（URL / dataId）：请确认它取自远端接口，而不是仓库里签入的副本——签入的副本常已过期");
    } else if (env === null) {
      level = "low";
      reasons.push("来源无环境标识：同仓库常并存多套环境配置，且签入的配置中心副本可能已过期，无法判断它是否属于当前环境");
    } else {
      level = "medium";
      reasons.push(`来源为本地文件、环境标识「${env}」：请确认它就是当前生效 profile（Maven 的 @xxx@ 占位符真值在 pom.xml 的 <profile><properties> 里）`);
    }

    // 一批里出现多个环境，说明至少有一部分候选不属于当前环境，必须让用户定夺
    if (distinct.length > 1 && env !== null) {
      level = "low";
      reasons.unshift(`本批次候选来自多个环境（${distinct.join("、")}）：请确认当前生效的是哪一个，只取生效环境的库`);
    }

    if (env !== null && PROD_TOKENS.has(env)) {
      reasons.push("疑似生产环境：保存后建议用 /db 编辑该连接、把环境标签设为 prod（会启用强制只读）");
    }
    return { level, env, reasons };
  });
}

export const TRUST_GLYPH: Record<TrustLevel, string> = { high: "🟢", medium: "🟡", low: "🔴" };
export const TRUST_LABEL: Record<TrustLevel, string> = { high: "来源可信", medium: "来源待核", low: "来源存疑" };
