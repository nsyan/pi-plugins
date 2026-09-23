// core/index.ts —— core 聚合 re-export（package.json exports "./core" 的入口）
export type { DbTypeId, DbFamily, ConnConfig, ParsedTarget, DbConnection, ExecOpts,
  CandidateStatus, Candidate, CandidateInput, TableInfo, ColumnInfo, QueryResult, ListTablesResult,
  DescribeTableResult, TestConnectionResult } from "./types.js";
export { stripComments, splitStatements, isWriteStatement, isDropStatement } from "./sql-text.js";
export { formatSql, formatSqlForDisplay, displayLangFor } from "./sql-format.js";
export type { DisplayLang } from "./sql-format.js";
export { decide } from "./policy.js";
export type { ConfirmMode } from "./policy.js";
