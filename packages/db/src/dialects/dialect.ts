// dialects/dialect.ts
import type { ConnConfig, ParsedTarget, DbConnection, ExecOpts, DbTypeId, DbFamily,
  QueryResult, ListTablesResult, DescribeTableResult, TestConnectionResult } from "../core/types.js";

export interface Fingerprints { urlPatterns: RegExp[]; configKeys: string[]; }
export interface Verdict { ok: boolean; reason?: string; isWrite?: boolean; summary?: string; }

export interface Dialect {
  id: DbTypeId;
  label: string;
  family: DbFamily;
  defaultPort: number;
  fingerprints: Fingerprints;
  parseUrl(url: string): ParsedTarget | null;
  withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs?: number): Promise<T>;
  testConnection(config: ConnConfig): Promise<TestConnectionResult>;
  isAllowed(sql: string, readonly: boolean): Verdict;
  executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult>;
  listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult>;
  describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult>;
  displayUrl(config: ConnConfig): string;
  versionQuery(conn: DbConnection): Promise<string>;
}

export const registry = new Map<DbTypeId, Dialect>();
export function register(d: Dialect): void { registry.set(d.id, d); }

// SQL LIKE（%/_）转正则，listTables(pattern) 内存过滤共用（Spec §11.1 P0）
export function likeMatch(name: string, pattern: string): boolean {
  const re = new RegExp("^" + pattern.split("").map((ch) =>
    ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$", "i");
  return re.test(name);
}

export function filterTables<T extends { name: string; schema?: string }>(tables: T[], pattern?: string): T[] {
  if (!pattern) return tables;
  return tables.filter((t) => likeMatch(t.name, pattern) || (t.schema ? likeMatch(t.schema, pattern) : false));
}
