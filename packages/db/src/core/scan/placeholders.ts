// scan/placeholders.ts —— Spring 占位符 ${KEY:default} 解析：default → 同目录 .env → 进程 env → 标「待补」
const PH_RE = /^\$\{([^:}]+)(?::((?:.|\n)*))?\}$/;

export interface PlaceholderResult {
  resolved: boolean;
  value?: string;
}

export function resolvePlaceholder(value: string, localEnv?: Record<string, string>): PlaceholderResult {
  const m = PH_RE.exec(value.trim());
  if (!m) return { resolved: true, value };
  const key = m[1];
  const hasDefault = m[2] !== undefined;

  // 有非空 default → 直接用
  if (hasDefault && m[2] !== "") return { resolved: true, value: m[2] };

  // 无 default 或 default 为空串：查同目录 .env → 进程 env
  const fromEnv = localEnv?.[key] ?? process.env[key];
  if (fromEnv !== undefined && fromEnv !== "") return { resolved: true, value: fromEnv };

  // 缺省：标待补（空串 default 同样视为待补，如 ${REDIS_PASSWORD:}）
  return { resolved: false };
}
