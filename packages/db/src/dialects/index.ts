// src/dialects/index.ts —— 聚合各方言（新增方言时加一行 re-export；
// 方言文件自带 register() 副作用，遗漏聚合行时 registry 规模断言失败）
export { registry, register } from "./dialect.js";
export type { Dialect, Verdict, Fingerprints } from "./dialect.js";
export { postgresqlDialect } from "./postgresql.js";
export { mysqlDialect } from "./mysql.js";
export { oracleDialect } from "./oracle.js";
export { dmDialect } from "./dm.js";
export { redisDialect } from "./redis.js";
export { esDialect } from "./elasticsearch.js";
export { mongoDialect } from "./mongodb.js";
export { neo4jDialect } from "./neo4j.js";
export { hiveDialect } from "./hive.js";
export { sparkDialect } from "./spark.js";
