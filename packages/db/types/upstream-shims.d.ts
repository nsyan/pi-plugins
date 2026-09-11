// 上游类型缺失的补丁声明（仅用于类型检查，运行时不会加载任何 .d.ts）。
//
// oracledb 未随包提供类型声明，导致 `import oracledb from "oracledb"` 报 TS7016。
// 这里按 @types 的经典写法（namespace + export =）声明本方言用到的最小契约，
// 使「默认导入的值访问（oracledb.getConnection）」与「类型访问（oracledb.Connection）」同时成立。
//
// 踩坑记录：
// 1) 写成 `declare module "oracledb" { ... }` 带具体导出时，默认导入与命名导出不匹配；
// 2) 写成不带 body 的 `declare module "oracledb";`，在此 TS 版本会被当作「空命名空间」，
//    反而使 `oracledb.Connection` 报 TS2694（has no exported member）。
declare module "oracledb" {
  namespace oracledb {
    interface Connection {
      execute(
        sql: string,
        binds?: unknown[] | Record<string, unknown>,
        options?: Record<string, unknown>,
      ): Promise<{ metaData?: Array<{ name: string }>; rows?: unknown[][]; rowsAffected?: number }>;
      close(): Promise<void>;
    }
    function getConnection(attrs: Record<string, unknown>): Promise<Connection>;
  }
  export = oracledb;
}
