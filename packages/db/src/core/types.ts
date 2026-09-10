// core/types.ts
export type DbTypeId = "postgresql" | "mysql" | "oracle" | "dm"
  | "redis" | "elasticsearch" | "mongodb" | "hive" | "spark";
export type DbFamily = "relational" | "kv" | "search" | "document" | "bigdata";

export interface ConnConfig {
  id: string; name: string; type: DbTypeId;
  description?: string; host?: string; port?: number;
  username?: string; password?: string;
  /** 家族语义：关系型=库名 / DM=schema / Redis=不用（用 dbIndex）/
      ES=默认 index / Hive-Spark=database 名 */
  database?: string;
  dbIndex?: number;                 // Redis 库号
  apiKey?: string;                  // ES 预留（二期）
  options?: Record<string, string>; // Hive/Spark 会话变量等（旧文件 extraParams 读取时并入此字段）
  // MongoDB: authSource/replicaSet/tls/authMechanism 等（options.srv=true 标记 SRV 连接）
  isDefault?: boolean;              // 默认连接标记（§11.1，G 阶段接线）
  /** 环境标签（v1.1 UX 共识 Q3）：dev/test/prod；prod 建议配 forceReadonly */
  envTag?: "dev" | "test" | "prod";
  /** 连接级强制只读：无视全局 ai_readonly，该连接永远只接受查询 */
  forceReadonly?: boolean;
  /** 最近一次成功使用时间（ISO）；工具/菜单查询成功后回写 */
  lastUsedAt?: string;
  /** 最近一次测试连接结果（菜单/向导/编辑后自动测试时回写） */
  lastTest?: { ok: boolean; latency?: string; version?: string; at: string };
  createdAt: string;
}

export interface ParsedTarget {
  host: string; port: number;
  username?: string; password?: string;
  database?: string; dbIndex?: number; ssl?: boolean;
  /** URI 查询参数（MongoDB: authSource/replicaSet/tls...），由 parseUrl 解出、建连时回填 */
  options?: Record<string, string>;
}

export interface DbConnection { type: DbTypeId; client: unknown; close(): Promise<void>; }
export interface ExecOpts { readonly: boolean; maxRows: number; timeoutSec: number; }

// scan/candidates.ts
export type CandidateStatus = "ready" | "incomplete" | "encrypted" | "exists";
export interface Candidate {
  status: CandidateStatus;
  dialectId: DbTypeId;              // 由方言 fingerprints 匹配得出
  partial: Partial<ConnConfig>;     // 已抽到的字段
  missing: string[];                // 待补字段名（incomplete 时）
  source: { file: string; profile?: string; confidence: number };
}

// ── 以下从 src/db.ts 原样搬入（字段不变） ──────────

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
  description: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  comment: string;
}

export interface QueryResult {
  success: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  duration?: string;
  error?: string;
  /** 结果是否因达到 maxRows 而截断（Task 8 加法字段，Task 11 导出显示可复用） */
  truncated?: boolean;
}

export interface ListTablesResult {
  success: boolean;
  tables?: TableInfo[];
  count?: number;
  error?: string;
}

export interface DescribeTableResult {
  success: boolean;
  columns?: ColumnInfo[];
  count?: number;
  error?: string;
}

export interface TestConnectionResult {
  success: boolean;
  version?: string;
  latency?: string;
  error?: string;
  warning?: string;   // ES 未知大版本等非致命版本警告（Task 7，Spec §12）
}
