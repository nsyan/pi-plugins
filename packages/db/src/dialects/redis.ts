// dialects/redis.ts —— Redis 方言（KvDialect + ioredis）
import Redis from "ioredis";
import type { ConnConfig, DbConnection, ParsedTarget,
  ListTablesResult, DescribeTableResult, TableInfo } from "../core/types.js";
import { KvDialect } from "./kv-dialect.js";
import { register, filterTables, type Fingerprints } from "./dialect.js";

// ── URL 解析：redis(s)://[:password@]host:port[/db] ───
const REDIS_RE = /^(rediss?):\/\/(?:[^/@]*@)?([^:/?#@]+)(?::(\d+))?(?:\/(\d+))?$/;

function parseRedisUrl(url: string): ParsedTarget | null {
  const clean = url.split("?")[0];
  const m = clean.match(REDIS_RE);
  if (!m) return null;
  const ssl = m[1] === "rediss";
  // 密码段（:password@ 或 user:password@）只取 @ 前冒号后部分
  let password: string | undefined;
  const atIdx = clean.indexOf("@");
  if (atIdx >= 0) {
    const auth = clean.slice(clean.indexOf("://") + 3, atIdx);
    const colonIdx = auth.indexOf(":");
    password = colonIdx >= 0 ? auth.slice(colonIdx + 1) : undefined;
    if (password === "") password = undefined;
  }
  const host = m[2];
  const port = m[3] ? parseInt(m[3], 10) : 6379;
  const dbIndex = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
  if (!host) return null;
  return { host, port, password, dbIndex, ssl };
}

class RedisDialect extends KvDialect {
  id = "redis" as const;
  label = "Redis";
  family = "kv" as const;
  defaultPort = 6379;
  fingerprints: Fingerprints = {
    urlPatterns: [/^rediss?:\/\//],
    configKeys: ["spring.data.redis.host", "spring.redis.host", "redisson.address"],
  };

  parseUrl(url: string): ParsedTarget | null {
    return parseRedisUrl(url);
  }

  displayUrl(config: ConnConfig): string {
    const scheme = "redis";
    const port = config.port ?? 6379;
    const db = config.dbIndex ?? 0;
    return `${scheme}://${config.host}:${port}/${db}`;
  }

  protected async doConnect(config: ConnConfig, timeoutMs: number): Promise<DbConnection> {
    const client = new Redis({
      host: config.host ?? "localhost",
      port: config.port ?? 6379,
      password: config.password || undefined,
      db: config.dbIndex ?? 0,
      lazyConnect: true,
      connectTimeout: timeoutMs,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    if (config.dbIndex !== undefined && config.dbIndex !== 0) {
      await client.select(config.dbIndex);
    }
    return {
      type: "redis",
      client,
      async close() { client.disconnect(); },
    };
  }

  protected async doSendCommand(client: unknown, args: string[]): Promise<unknown> {
    const redis = client as Redis;
    return redis.sendCommand(new Redis.Command(args[0], args.slice(1)));
  }

  async versionQuery(conn: DbConnection): Promise<string> {
    const redis = conn.client as Redis;
    const info = await redis.info("server");
    const m = /^redis_version:(.+)$/m.exec(info ?? "");
    return m ? m[1].trim() : "unknown";
  }

  // Redis 无表概念 → keyspace 概览：DBSIZE + SCAN 采样≤200 统计各类型 key 数量
  async listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult> {
    try {
      const tables: TableInfo[] = await this.withConnection(config, async (conn) => {
        const redis = conn.client as Redis;
        const total = await redis.dbsize();
        const typeCounts = new Map<string, number>();
        let sampled = 0;
        let cursor = "0";
        // LIKE（%/_）→ SCAN 通配（*/?），全局替换（String.replace 单次替换是 bug）
        const matchArgs = pattern ? ["MATCH", pattern.split("").map((ch) => ch === "%" ? "*" : ch === "_" ? "?" : ch).join("")] : [];
        do {
          const [next, keys] = await redis.scan(cursor, "COUNT", 100, ...matchArgs);
          cursor = next;
          for (const key of keys) {
            if (sampled >= 200) break;
            const t = await redis.type(key);
            typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
            sampled++;
          }
        } while (cursor !== "0" && sampled < 200);
        const rows: TableInfo[] = [...typeCounts.entries()].map(([type, n]) => ({
          schema: "",
          name: type,
          type: "KEYSPACE",
          description: `采样 ${sampled} 个 key 中该类型约 ${n} 个（共 ${total} 个 key，Redis 无表，用 SCAN 浏览 key）`,
        }));
        return rows;
      });
      return { success: true, tables, count: tables.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // describeTable(key) → TYPE + 长度 + TTL + MEMORY USAGE（≥4.0 失败跳过）+ OBJECT ENCODING + 值预览
  async describeTable(config: ConnConfig, key: string): Promise<DescribeTableResult> {
    if (!key.trim()) {
      return { success: false, error: "key 不能为空" };
    }
    try {
      const columns = await this.withConnection(config, async (conn) => {
        const redis = conn.client as Redis;
        const exists = await redis.exists(key);
        if (!exists) throw new Error(`key 不存在: ${key}`);
        const type = await redis.type(key);
        const ttl = await redis.ttl(key);
        // 长度命令按类型分发
        const lengthCmd: Record<string, string[]> = {
          string: ["STRLEN", key],
          list: ["LLEN", key],
          set: ["SCARD", key],
          hash: ["HLEN", key],
          zset: ["ZCARD", key],
        };
        let length = "";
        if (lengthCmd[type]) {
          try {
            length = String(await redis.sendCommand(new Redis.Command(lengthCmd[type][0], [key])));
          } catch { /* ignore */ }
        }
        // MEMORY USAGE 需 ≥4.0，低版本失败时降级跳过
        let memory = "";
        try {
          memory = String(await redis.sendCommand(new Redis.Command("MEMORY", ["USAGE", key])));
        } catch { /* ignore */ }
        // OBJECT ENCODING 服务 key 探测
        let encoding = "";
        try {
          encoding = String(await redis.sendCommand(new Redis.Command("OBJECT", ["ENCODING", key])));
        } catch { /* ignore */ }
        // 值预览（截断）
        let preview = "";
        try {
          if (type === "string") {
            preview = String(await redis.get(key) ?? "").slice(0, 200);
          } else if (type === "hash") {
            preview = JSON.stringify(await redis.hgetall(key)).slice(0, 200);
          } else if (type === "list") {
            preview = JSON.stringify(await redis.lrange(key, 0, 9)).slice(0, 200);
          } else if (type === "set") {
            preview = JSON.stringify(await redis.smembers(key)).slice(0, 200);
          } else if (type === "zset") {
            preview = JSON.stringify(await redis.zrange(key, 0, 9, "WITHSCORES")).slice(0, 200);
          }
        } catch { /* ignore */ }
        return [
          { name: "key", type: "string", nullable: false, default: null, primaryKey: true, comment: "" },
          { name: "type", type: "string", nullable: false, default: type, primaryKey: false, comment: "" },
          { name: "length", type: "integer", nullable: true, default: length || null, primaryKey: false, comment: "按类型取 STRLEN/LLEN/SCARD/HLEN/ZCARD" },
          { name: "ttl", type: "integer", nullable: false, default: String(ttl), primaryKey: false, comment: "-1=持久 -2=不存在（此处已确认存在）" },
          { name: "memory_usage", type: "integer", nullable: true, default: memory || null, primaryKey: false, comment: "需 Redis ≥4.0，低版本为空" },
          { name: "encoding", type: "string", nullable: true, default: encoding || null, primaryKey: false, comment: "OBJECT ENCODING" },
          { name: "preview", type: "string", nullable: true, default: preview || null, primaryKey: false, comment: "值预览（截断 200 字符）" },
        ];
      });
      return { success: true, columns, count: columns.length };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const redisDialect = new RedisDialect();
register(redisDialect);
