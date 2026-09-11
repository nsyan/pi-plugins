// scan/candidates.ts —— scanProject 组装：walker → parsers → spring/placeholders → scoring → Candidate[]
// 状态机：ready（可直接测连）/ incomplete（缺字段）/ encrypted（jasypt ENC，只标注不建）/ exists（同名已存在）
// 红线：绝不静默建连（写盘由 index.ts 向导确认后执行）；密码掩码在输出层（index.ts）做，
//       本模块的 partial 保留真实值仅供 TUI 补录。
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { registry } from "../../dialects/index.js";
import { loadConfigs } from "../../config.js";
import type { Candidate, ConnConfig, DbTypeId, ParsedTarget } from "../types.js";
import { resolveRoot, walk } from "./walker.js";
import { parseCompose, parseEnv, parseProperties, parseSimpleYaml, extractUrls } from "./parsers.js";
import { springKeysToRaw, profileOf, type RawDbConfig } from "./spring.js";
import { resolvePlaceholder } from "./placeholders.js";
import { isExcluded, sourceWeight } from "./scoring.js";

// ── 内部表示 ──────────────────────────────────────

interface FieldBag {
  host?: string; port?: number;
  username?: string; password?: string;
  database?: string; dbIndex?: number;
  ssl?: boolean;
  options?: Record<string, string>;
  url?: string;
}

interface RawCand {
  dialectId: DbTypeId;
  bag: FieldBag;
  file: string;
  profile: string;
  confidence: number;
}

// 各家族建连必需字段（missing 的判定依据；空串同样视为缺失）
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

// ── 工具函数 ──────────────────────────────────────

function flattenYaml(node: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flattenYaml(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof node === "string" || typeof node === "number") {
    out[prefix] = String(node);
  }
  return out;
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function stripQuery(url: string): string {
  return url.split(/[?#]/)[0];
}

/** 遍历 registry 各方言 parseUrl，首个非 null 胜出（与 index.ts parseDbUrl 同一模式）。 */
function parseUrlViaRegistry(url: string): ({ dialectId: DbTypeId } & ParsedTarget) | null {
  for (const d of registry.values()) {
    const p = d.parseUrl(url);
    if (p) return { dialectId: d.id, ...p };
  }
  return null;
}

function dialectFromImage(image: string): DbTypeId | null {
  const i = image.toLowerCase();
  if (/postgres/.test(i)) return "postgresql";
  if (/(^|\/)(mysql|mariadb)/.test(i)) return "mysql";
  if (/(^|\/)mongo/.test(i)) return "mongodb"; // mongo / mongodb 镜像（mongo-express 误报可忍变）
  if (/redis/.test(i)) return "redis";
  if (/neo4j/.test(i)) return "neo4j";
  if (/elasticsearch/.test(i)) return "elasticsearch";
  if (/dm8|dameng/.test(i)) return "dm";
  if (/hive/.test(i)) return "hive";
  return null;
}

/** 同目录 .env 缓存（${KEY} 无 default 时的第二优先级） */
function loadDirEnv(file: string, cache: Map<string, Record<string, string> | undefined>): Record<string, string> | undefined {
  const dir = dirname(file);
  if (cache.has(dir)) return cache.get(dir);
  let env: Record<string, string> | undefined;
  try {
    env = parseEnv(readFileSync(join(dir, ".env"), "utf-8"));
  } catch { env = undefined; }
  cache.set(dir, env);
  return env;
}

// ── 主流程 ────────────────────────────────────────

export async function scanProject(
  rootInput: string,
  opts?: { existingNames?: string[] },
): Promise<Candidate[]> {
  const root = resolveRoot(rootInput); // 越界直接抛（红线）
  const files = walk(root);
  const raws: RawCand[] = [];
  const dirEnvCache = new Map<string, Record<string, string> | undefined>();

  const pushUrl = (url: string, file: string, profile: string, confidence: number, keyFields?: Partial<RawDbConfig>): void => {
    // 先用完整 URL 路由（MongoDB 的 authSource/replicaSet 等在 query 里，不能剥）；
    // 失败再回退剥离 query 的旧路径（兼容 JDBC 带查询参数时各 parseUrl 的锚点匹配）
    const parsed = parseUrlViaRegistry(url) ?? parseUrlViaRegistry(stripQuery(url));
    if (!parsed) return;
    raws.push({
      dialectId: parsed.dialectId,
      // URL 内嵌账号密码与 spring 键字段合并：显式键（spring.datasource.username/password）优先
      bag: {
        url,
        host: parsed.host,
        port: parsed.port,
        username: keyFields?.username ?? parsed.username,
        password: keyFields?.password ?? parsed.password,
        database: parsed.database,
        dbIndex: parsed.dbIndex,
        ssl: parsed.ssl,
        options: parsed.options,
      },
      file, profile, confidence,
    });
  };

  const pushRaw = (raw: RawDbConfig): void => {
    if (raw.url) {
      pushUrl(raw.url, raw.file, raw.profile, raw.weight, raw);
      return;
    }
    // 无 URL 的键式候选：redis/es 可凭 host 判定；关系型无 URL 无法建连，跳过
    let dialectId: DbTypeId | null = null;
    if (raw.group === "redis" && raw.host) dialectId = "redis";
    else if (raw.group === "es" && raw.host) dialectId = "elasticsearch";
    if (!dialectId) return;
    raws.push({
      dialectId,
      bag: { host: raw.host, port: toInt(raw.port), username: raw.username, password: raw.password, dbIndex: toInt(raw.dbIndex) },
      file: raw.file, profile: raw.profile, confidence: raw.weight,
    });
  };

  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    if (isExcluded(rel)) continue;
    const ext = extname(file).toLowerCase();
    const base = basename(file).toLowerCase();
    let text: string;
    try { text = readFileSync(file, "utf-8"); } catch { continue; }
    if (text.length > 512 * 1024) continue; // 大文件跳过

    const weight = sourceWeight(rel);
    const profile = profileOf(base);

    if (base === ".env" || base.startsWith(".env.")) {
      const env = parseEnv(text);
      for (const [k, v] of Object.entries(env)) {
        if (/(^|_)(DATABASE_URL|DATASOURCE_URL|REDIS_URL|ELASTICSEARCH_URL|MONGODB_URI|MONGO_URL|NEO4J_URI|NEO4J_URL|BOLT_URL|DB_URL|JDBC_URL)$|_URL$/i.test(k)) {
          pushUrl(v, file, profile, weight);
        }
      }
      continue;
    }

    if (ext === ".yml" || ext === ".yaml") {
      if (base.startsWith("docker-compose") || base.startsWith("compose")) {
        for (const svc of parseCompose(text)) {
          const dialectId = svc.image ? dialectFromImage(svc.image) : null;
          if (!dialectId) continue;
          const bag: FieldBag = {
            host: svc.name, // compose 网络内服务名即主机名
            port: hostPortOf(svc.ports),
            username: svc.env["POSTGRES_USER"] ?? svc.env["MYSQL_USER"] ?? svc.env["ES_USERNAME"] ?? svc.env["MONGO_INITDB_ROOT_USERNAME"] ?? svc.env["NEO4J_AUTH"]?.split("/")[0],
            password: svc.env["POSTGRES_PASSWORD"] ?? svc.env["MYSQL_ROOT_PASSWORD"] ?? svc.env["MYSQL_PASSWORD"] ?? svc.env["REDIS_PASSWORD"] ?? svc.env["ELASTIC_PASSWORD"] ?? svc.env["MONGO_INITDB_ROOT_PASSWORD"] ?? svc.env["NEO4J_PASSWORD"],
            database: svc.env["POSTGRES_DB"] ?? svc.env["MYSQL_DATABASE"] ?? svc.env["MONGO_INITDB_DATABASE"],
          };
          raws.push({ dialectId, bag, file, profile, confidence: weight });
          // compose 里也可能带完整 Spring URL
          for (const [k, v] of Object.entries(svc.env)) {
            if (/URL$/.test(k)) pushUrl(v, file, profile, weight);
          }
        }
      } else {
        const dotted = flattenYaml(parseSimpleYaml(text));
        for (const raw of springKeysToRaw(dotted, file, weight)) pushRaw(raw);
      }
    } else if (ext === ".properties") {
      const dotted = parseProperties(text);
      for (const raw of springKeysToRaw(dotted, file, weight)) pushRaw(raw);
    }

    // 通用 URL 正则全文件扫（兜底，低权重）
    for (const url of extractUrls(text)) pushUrl(url, file, profile, 0.5);
  }

  // ── 占位符解析 + 状态机 ──────────────────────────
  const projectName = basename(root);
  const existingNames = new Set(opts?.existingNames ?? loadConfigs().map((c) => c.name));

  const resolved: RawCand[] = [];
  const seen = new Map<string, number>(); // dedupe key → index in resolved
  for (const raw of raws) {
    const env = loadDirEnv(raw.file, dirEnvCache);
    const bag: FieldBag = {};
    for (const [k, v] of Object.entries(raw.bag)) {
      if (v === undefined) continue;
      if (typeof v !== "string") { (bag as Record<string, unknown>)[k] = v; continue; }
      const r = resolvePlaceholder(v, env);
      if (r.resolved) (bag as Record<string, unknown>)[k] = r.value;
      // 未解析的占位符：字段从 bag 消失 → 落入 missing
    }

    // 去重：同一实例（dialect|host|port|database）只保留一条；
    // 后到的低置信度候选（如同文件通用 URL 兆底）把自身字段补入已有候选（凭据增强），不新增
    const key = `${raw.dialectId}|${bag.host ?? ""}|${bag.port ?? ""}|${bag.database ?? ""}`;
    const prevIdx = seen.get(key);
    if (prevIdx !== undefined) {
      const prev = resolved[prevIdx];
      if (raw.confidence > prev.confidence) {
        prev.confidence = raw.confidence;
        prev.profile = raw.profile;
      }
      for (const [k, v] of Object.entries(bag)) {
        if ((prev.bag as Record<string, unknown>)[k] === undefined && v !== undefined) {
          (prev.bag as Record<string, unknown>)[k] = v;
        }
      }
      continue;
    }
    seen.set(key, resolved.length);
    resolved.push({ ...raw, bag });
  }

  // 确定性输出：置信度降序 → 默认名升序（同名多 profile 时 default 在前，消费方 find 可预期）
  const nameOf = (r: RawCand): string => `${projectName}-${r.profile}-${r.dialectId}`;
  resolved.sort((a, b) => b.confidence - a.confidence || nameOf(a).localeCompare(nameOf(b)));

  const candidates: Candidate[] = resolved.map((raw) => {
    const defaultName = `${projectName}-${raw.profile}-${raw.dialectId}`;
    const missing: string[] = [];
    for (const f of REQUIRED[raw.dialectId]) {
      const v = (raw.bag as Record<string, unknown>)[f];
      if (v === undefined || v === "") missing.push(f);
    }
    let status: Candidate["status"];
    const pwd = raw.bag.password;
    if (typeof pwd === "string" && pwd.startsWith("ENC(")) {
      status = "encrypted";
    } else if (existingNames.has(defaultName)) {
      status = "exists";
    } else if (missing.length === 0) {
      status = "ready";
    } else {
      status = "incomplete";
    }
    const partial: Partial<ConnConfig> = {
      name: defaultName,
      type: raw.dialectId,
      ...raw.bag,
    };
    return {
      status,
      dialectId: raw.dialectId,
      partial,
      missing,
      source: { file: raw.file, profile: raw.profile, confidence: raw.confidence },
    };
  });

  return candidates;
}

/** compose 端口映射取主机侧端口："5432:5432" → 5432；"127.0.0.1:5432:5432" → 5432 */
function hostPortOf(ports: string[]): number | undefined {
  for (const p of ports) {
    const parts = p.split(":");
    const n = parseInt(parts[parts.length - 2] ?? parts[0], 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
