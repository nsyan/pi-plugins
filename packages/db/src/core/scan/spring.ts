// scan/spring.ts —— Spring 专属：datasource / data.redis / elasticsearch 键映射 + profile 分组
import type { DbTypeId } from "../types.js";

export type SpringGroup = "datasource" | "redis" | "es";

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
];

function groupOf(key: string): SpringGroup {
  if (key.includes("redis")) return "redis";
  if (key.includes("elasticsearch")) return "es";
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
  return [...groups.values()];
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
