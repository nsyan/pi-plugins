// scan/spring.ts —— Spring 专属：datasource / data.redis / elasticsearch / data.mongodb 键映射 + profile 分组
import type { DbTypeId } from "../types.js";

export type SpringGroup = "datasource" | "redis" | "es" | "mongo" | "neo4j";

export interface RawDbConfig {
  group: SpringGroup;
  dialectId?: DbTypeId;   // 有 URL 时由 candidates 层经 registry 判定
  url?: string;
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  database?: string;
  dbIndex?: string;
  profile: string;
  file: string;
  weight: number;         // scoring 来源权重
}

export function profileOf(filename: string): string {
  const m = /application-([A-Za-z0-9_-]+)\.(?:yml|yaml|properties)$/i.exec(filename);
  return m ? m[1] : "default";
}

type Field = "url" | "username" | "password" | "host" | "port" | "database" | "dbIndex";

const SPRING_KEYS: Array<[string, Field]> = [
  ["spring.datasource.url", "url"],
  ["spring.datasource.jdbc-url", "url"],
  ["spring.datasource.username", "username"],
  ["spring.datasource.password", "password"],
  ["spring.data.redis.host", "host"],
  ["spring.data.redis.port", "port"],
  ["spring.data.redis.password", "password"],
  ["spring.data.redis.database", "dbIndex"],
  ["spring.redis.host", "host"],           // Spring Boot 2.x 旧前缀
  ["spring.redis.port", "port"],
  ["spring.redis.password", "password"],
  ["spring.redis.database", "dbIndex"],
  ["spring.elasticsearch.uris", "url"],
  ["spring.elasticsearch.url", "url"],
  ["spring.elasticsearch.username", "username"],
  ["spring.elasticsearch.password", "password"],
  ["spring.data.elasticsearch.uris", "url"],
  ["spring.data.elasticsearch.username", "username"],
  ["spring.data.elasticsearch.password", "password"],
  ["spring.data.mongodb.uri", "url"],       // Spring Boot 2.x+（含 3.x）
  ["spring.mongodb.uri", "url"],            // Spring Boot 1.x 旧前缀
  ["spring.neo4j.uri", "url"],              // Spring Boot 3.x
  ["spring.data.neo4j.uri", "url"],         // Spring Boot 2.x 旧前缀
  ["spring.neo4j.authentication.username", "username"],
  ["spring.neo4j.authentication.password", "password"],
  ["spring.data.neo4j.username", "username"],
  ["spring.data.neo4j.password", "password"],
];

function groupOf(key: string): SpringGroup {
  if (key.includes("redis")) return "redis";
  if (key.includes("elasticsearch")) return "es";
  if (key.includes("mongodb")) return "mongo"; // 独立分组：避免与 datasource 的 url 字段互相覆盖
  if (key.includes("neo4j")) return "neo4j";
  return "datasource";
}

/** 扁平化 dotted 键 → 按组聚合成 RawDbConfig[] */
export function springKeysToRaw(dotted: Record<string, string>, file: string, weight: number): RawDbConfig[] {
  const groups = new Map<SpringGroup, RawDbConfig>();
  for (const [key, field] of SPRING_KEYS) {
    const v = dotted[key];
    if (v === undefined || v === "") continue;
    const g = groupOf(key);
    const raw = groups.get(g) ?? { group: g, profile: profileOf(basename(file)), file, weight };
    (raw as Record<string, unknown>)[field] = v;
    groups.set(g, raw);
  }
  // baomidou dynamic-datasource（多数据源）：spring.datasource.dynamic.datasource.<name>.<field>
  // 每个 <name> 独立成候选（与 Spec 单组 datasource 键互不覆盖）
  const dynamic = new Map<string, RawDbConfig>();
  const DYNAMIC_PREFIX = "spring.datasource.dynamic.datasource.";
  for (const [key, value] of Object.entries(dotted)) {
    if (!key.startsWith(DYNAMIC_PREFIX) || value === "") continue;
    const rest = key.slice(DYNAMIC_PREFIX.length); // "<name>.<field>"
    const dot = rest.indexOf(".");
    if (dot <= 0) continue;
    const name = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    if (field !== "url" && field !== "jdbc-url" && field !== "username" && field !== "password") continue;
    const raw = dynamic.get(name) ?? { group: "datasource" as const, profile: profileOf(basename(file)), file, weight };
    (raw as Record<string, unknown>)[field === "jdbc-url" ? "url" : field] = value;
    dynamic.set(name, raw);
  }
  return [...groups.values(), ...dynamic.values()];
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
