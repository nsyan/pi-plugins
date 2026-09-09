# db 插件方言化重构 + DM/Redis/Elasticsearch 支持 — 设计文档

日期：2026-09-09
状态：已通过（2026-09-09 联合评审：设计 review + 计划 review 两轮；同日结合现有代码复审修订，见文末修订记录）
范围：`pi-extensions/packages/db`（重命名为 `db` 的原 db-plugin）

---

## 1. 背景与目标

当前插件硬编码支持 PostgreSQL / MySQL / Oracle 三种数据库，数据库类型相关的逻辑
（类型联合、label 映射、JDBC 解析、connect/execute/listTables/describeTable 的 switch）
散落在 `index.ts`（约 800 行）和 `src/db.ts`（约 500 行）的 8+ 处。

本次重构的目标：

1. **修复已知安全 Bug**（DROP TABLE 绕过、只读模式 CTE/注释绕过）
2. **建立方言（Dialect）适配层**，按数据模型分四类：关系型 SQL / 非关系型 KV / 全文搜索 / 大数据 SQL 引擎
3. **新增五种数据库支持**：达梦（DM8）、Redis、Elasticsearch、Hive、Spark（Thrift Server）
4. **核心逻辑零 agent 依赖**：为将来输出 MCP server（覆盖 Claude Code / Codex / Cursor）铺路

明确的非目标（本期不做）：

- MCP server 壳（二期，仅在包结构上预留）
- 连接池 / 连接复用（现有"每次新建连接"模式保留，池化另立任务）
- MongoDB 等其他数据库（文档型 NoSQL 归属届时再定）
- Spark Connect（DataFrame 语义，gRPC 远程会话）——Spark 仅支持 Thrift Server 接入
- pi 之外的运行时适配

## 2. 包结构与依赖边界

### 2.0 核心类型清单（B 阶段第一个动手的文件，定义不清后面全是返工）

```ts
// core/types.ts
type DbTypeId = "postgresql" | "mysql" | "oracle" | "dm"
  | "redis" | "elasticsearch" | "hive" | "spark";
type DbFamily = "relational" | "kv" | "search" | "bigdata";

interface ConnConfig {
  id: string; name: string; type: DbTypeId;
  description?: string; host?: string; port?: number;
  username?: string; password?: string;
  /** 家族语义：关系型=库名 / DM=schema / Redis=不用（用 dbIndex）/
      ES=默认 index / Hive-Spark=database 名 */
  database?: string;
  dbIndex?: number;                 // Redis 库号
  apiKey?: string;                  // ES 预留（二期）
  options?: Record<string, string>; // Hive/Spark 会话变量等（旧文件 extraParams 读取时并入此字段）
  isDefault?: boolean;              // 默认连接标记（§11.1，G 阶段接线）
  createdAt: string;
}

interface ParsedTarget {
  host: string; port: number;
  username?: string; password?: string;
  database?: string; dbIndex?: number; ssl?: boolean;
}

interface DbConnection { type: DbTypeId; client: unknown; close(): Promise<void>; }
interface ExecOpts { readonly: boolean; maxRows: number; timeoutSec: number; }

// scan/candidates.ts
type CandidateStatus = "ready" | "incomplete" | "encrypted" | "exists";
interface Candidate {
  status: CandidateStatus;
  dialectId: DbTypeId;              // 由方言 fingerprints 匹配得出
  partial: Partial<ConnConfig>;     // 已抽到的字段
  missing: string[];                // 待补字段名（incomplete 时）
  source: { file: string; profile?: string; confidence: number };
}
```

**配置类型裁决**：`ConnConfig` 同时承担存储态与运行态——现有 `index.ts` 的 `DbConfig`
与 `db.ts` 的 `ConnConfig` 双类型废止，`toConnConfig()` 随之删除，配置数组即 `ConnConfig[]`。
旧配置文件字段兼容：历史字段 `extraParams`（现有 `DbConfig` 有、代码未使用）读取时并入 `options`。

```
packages/db/
├── index.ts              # pi 扩展入口：工具注册、/db 命令、系统提示注入（仅此层依赖 pi）
├── src/
│   ├── core/             # ★ 零 pi 依赖，纯逻辑
│   │   ├── types.ts      # ConnConfig / QueryResult / TableInfo / ColumnInfo 等公共类型
│   │   ├── policy.ts     # 只读/确认/硬限制的统一策略入口（策略层）
│   │   ├── sql-text.ts   # 注释剥离、语句拆分、SQL 模式匹配（关系型共用工具函数）
│   │   └── whitelist.ts  # 命令白名单匹配工具（KV/搜索共用）
│   ├── dialects/
│   │   ├── dialect.ts            # Dialect 基础接口 + registry
│   │   ├── relational-dialect.ts # 关系型基类（语句拆分、readonly 正则、行列格式化）
│   │   ├── kv-dialect.ts         # KV 基类（命令解析、命令白名单、key 探测）
│   │   ├── search-dialect.ts     # 搜索基类（DSL 解析、端点白名单、mapping 转换）
│   │   ├── bigdata-dialect.ts    # 大数据基类（HiveServer2 连接、长查询、流式拉取）
│   │   ├── postgresql.ts / mysql.ts / oracle.ts   # 现有三库迁入
│   │   ├── dm.ts                                 # 新增
│   │   ├── redis.ts                              # 新增
│   │   ├── elasticsearch.ts                      # 新增
│   │   └── hive.ts / spark.ts                    # 新增
│   ├── config.ts         # 连接配置与插件配置读写（含旧文件名兼容）
│   └── ui/               # /db 菜单、编辑器流程（依赖 pi 的 ctx.ui，从 index.ts 拆出）
└── package.json
```

依赖规则：`core/` 与 `dialects/` 除 `import type` 类型引用外，**不得 import 任何 pi
运行时模块**；`index.ts` 与 `ui/` 是仅有的 pi 依赖点。这条规则用 code review +
grep 验收保证（验收命令排除 `import type` 行），二期抽 MCP 壳时零改动即可复用。

MCP 预留位置：`packages/db-mcp/`（二期新建目录，直接依赖 `db` 包导出的 core/dialects）。
为此 `packages/db/package.json` 增加 `exports` 字段暴露 `./core`、`./dialects`，
B 阶段即落实（成本几乎为零，避免二期再改包结构）。

## 3. 方言接口设计

```ts
interface Dialect {
  // 元信息
  id: DbTypeId;                          // 8 种取值，见 §5 各方言规格
  label: string;                         // "PostgreSQL" | "DM" | ...
  family: "relational" | "kv" | "search" | "bigdata";
  defaultPort: number;

  // 连接。生命周期归属：公开入口一律传 config，连接的建立/复用/关闭由方言内部
  // 经 withConnection() 统一管理；未来加连接池只改 withConnection 内部，调用方零改动
  parseUrl(url: string): ParsedTarget | null;   // 各家族 URL 形态见 §5；JDBC 与原生 URI 双形态兼收（§7）
  // 注：公开接口只暴露 withConnection（连接建立/复用/关闭全托管）；裸 connect 不公开，
  // 避免调用方漏关连接；testConnection 内部同样走 withConnection
  withConnection<T>(config: ConnConfig, fn: (conn: DbConnection) => Promise<T>, timeoutMs?: number): Promise<T>;
  testConnection(config: ConnConfig): Promise<TestConnectionResult>;

  // 执行（策略已由 policy 层裁决，这里只负责执行）
  isAllowed(sql: string, readonly: boolean): { ok: boolean; reason?: string; isWrite?: boolean; summary?: string };
  executeOn(config: ConnConfig, sql: string, opts: ExecOpts): Promise<QueryResult>;

  // 元数据
  listTables(config: ConnConfig, pattern?: string): Promise<ListTablesResult>;
  describeTable(config: ConnConfig, target: string): Promise<DescribeTableResult>;

  // 展示
  displayUrl(config: ConnConfig): string;   // 重建展示用 URL（不含密码）
  versionQuery(conn: DbConnection): Promise<string>;  // 用于 testConnection 的版本查询
}
```

- **registry**：`dialects/*.ts` 各导出一个 dialect 对象并自注册（文件末尾调 `register()`），
  `dialects/index.ts` 只做 re-export 聚合。新增数据库 = 加一个方言文件 + index.ts 加一行
  re-export（UI/策略/工具层零改动；自注册保证“加文件即生效”，index.ts 的聚合行遗漏时
  单测 registry 规模断言会失败，见 §9）
- **label 映射收敛**：现在代码里重复 5 处的 `{ postgresql: "PG", ... }` 全部改由
  `dialect.label` / `family` 提供。
- **isAllowed 下沉**：只读检查从 `index.ts`/`query()` 的两处重复检查收敛到 dialect 的
  `isAllowed()`，策略层（policy.ts）负责在确认框之前统一调用。关系型走 SQL 正则、
  KV 走命令白名单、搜索走端点白名单——工具入口不感知差异。

## 4. 四类家族的共享机制

### 4.1 RelationalDialect（postgresql / mysql / oracle / dm）

共享（在基类实现，方言只提供差异点）：

- **注释剥离**：去掉 `--` 行注释与 `/* */` 块注释（字符串字面量内的不动）
- **语句拆分**：支持 `''` 双写转义、反引号/双引号字符串、注释内分号跳过
- **逐语句安全检查**：对拆分后的**每一条**语句分别执行 DROP 硬限制与写操作检测
  （修复现有"只检查整段 SQL 开头"的绕过漏洞）
- **写操作识别增强**：在现有关键字正则基础上增加：
  - CTE-DML：`WITH ... INSERT|UPDATE|DELETE|MERGE`
  - `SELECT ... FOR UPDATE`（锁定写意图）
  - 剥离注释后再匹配（防 `/* c */ DELETE` 绕过）
  - 已知保守误报：不剥离字符串字面量，CTE 内字面量含 DML 关键字（如 `SELECT 'DELETE FROM x'`）
    会误判为写操作——方向偏安全，单测固化该用例
- **结果格式化**：列名 + 行数据统一为 `unknown[][]`（数字/日期/Buffer 保持原类型，
  展示层统一转字符串），工具输出表格文本，UI 预览一致

方言差异点：驱动连接参数、服务端超时设置（PG `statement_timeout` / MySQL
`max_execution_time` / Oracle & DM 客户端超时兜底）、元数据 SQL（数据字典视图）、
版本查询语句。

### 4.2 KvDialect（redis）

- **sql 参数语义 = 命令行**：按空白 + 引号切分为命令数组，如 `HGETALL user:1` →
  `["HGETALL", "user:1"]`，经 `client.sendCommand()` 执行
- **只读 = 读命令白名单**（黑名单天然有绕过风险，不采用）：
  `GET MGET HGETALL HGET HMGET HKEYS HVALS HLEN LRANGE LLEN LINDEX SMEMBERS SCARD
  SISMEMBER ZRANGE ZSCORE ZCARD SCAN TYPE TTL PTTL EXISTS STRLEN GETRANGE
  INFO DBSIZE RANDOMKEY OBJECT MEMORY`（MEMORY USAGE/OBJECT ENCODING 服务 key 探测；
  `KEYS` 已从白名单移除——生产库一律用 SCAN，见 §12）
- **硬限制**：`FLUSHALL` / `FLUSHDB` 永久禁止；顺带禁 `CONFIG SHUTDOWN SLAVEOF
  REPLICAOF DEBUG` 等管理/危险命令（与只读开关无关）；`CONFIG` 一刀切含只读子命令
  `CONFIG GET`，有意从紧
- **多语句**：Redis 无分号语句概念，`sql` 整体视为一条命令；包含多个词则解析为多参命令

### 4.3 SearchDialect（elasticsearch）

- **sql 参数语义 = Query DSL JSON**：整体解析为 JSON 后调对应读端点：
  `{"query": {...}}` → `client.search({index, body})`；`{"count": ...}` → count；
  纯字符串 → `query_string` 简化形式
- **index 归属**：不做 DSL 信封包装，直接复用 `ConnConfig.database` 存该连接的默认 index
  （见 §2.0 集中类型清单对 `database` 的家族语义定义）
- **只读 = 端点白名单**：放行 `_search / _count / _mget / _analyze / _source`；
  写端点（`_doc`/`_update`/`_delete`/`_mapping`/`_settings`/`_bulk`）在只读下拒绝
- **硬限制**：`DELETE <index>`（删除索引）永久禁止
- **元数据**：`listTables` = `_cat/indices`（名称/文档数/大小/健康）；`describeTable` =
  `_mapping` + `_settings` → 字段名/类型/可搜索性列表，套用列格式输出

### 4.4 BigDataDialect（hive / spark）

大数据 SQL 引擎家族。交互上仍是“发 SQL 文本、拿表格结果”，但协议与运行特征不同，
独立成基类的价值在于共享 HiveServer2 协议栈和长查询语义：

- **共享 HiveServer2 Thrift 连接**：Hive 与 Spark Thrift Server 同协议，连接建立、
  会话变量（`SET hive.exec...` / `SET spark...`）、会话关闭都在基类实现
- **长查询处理**：大数据查询常见分钟级耗时，服务端普遍无 per-query timeout，
  基类统一采用客户端 `withTimeout` 兜底；超时后尝试取消 operation 释放服务端资源
- **结果流式拉取**：Thrift 协议按 batch fetch，基类逐批拉取、达到 maxRows 即停并标注截断，
  避免大结果集全量拉回
- **只读检查**：复用关系型的 sql-text.ts 机制（注释剥离 + 逐语句正则），
  写操作识别适配 HiveQL/SparkSQL 的 `INSERT INTO/OVERWRITE`、`CREATE TABLE AS`、
  `LOAD DATA`、`MSCK`、`ALTER` 等关键字
- **硬限制**：`DROP TABLE/DATABASE` 永久禁止，与只读开关无关

## 5. 新增方言规格

### 5.1 DM（达梦）→ `dialects/dm.ts`

| 项 | 设计 |
|----|------|
| 驱动 | `dmdb`（达梦官方 Node 驱动，npm 已核实存在），API 仿 `oracledb` |
| URL | `jdbc:dm://host:port/schema`，默认端口 5236 |
| 继承 | RelationalDialect；仅提供 DM 的连接参数、超时策略与数据字典 SQL，执行引擎复用基类 |
| listTables | `ALL_TABLES` + `ALL_TAB_COMMENTS`，系统用户过滤：`SYS/SYSDBA/SYSSSO/CTISYS` |
| describeTable | `ALL_TAB_COLUMNS` + `ALL_COL_COMMENTS` + `ALL_CONSTRAINTS`(P)，同 Oracle 模式 |
| 超时 | 优先探活服务端参数，不可用时兜底客户端 `withTimeout` |
| 版本 | `SELECT * FROM V$VERSION` |

**风险与前置 Spike**：`dmdb` 为闭源二进制，官方主要保障 Linux/Windows，macOS/ARM
可用性未知。实施顺序上先做连接 spike（安装 → connect → 一条查询），失败则该方言
降级为"仅 Linux 环境可用"并在 README 注明。

### 5.2 Redis → `dialects/redis.ts`

| 项 | 设计 |
|----|------|
| 驱动 | `ioredis`（官方维护、成熟） |
| URL | `redis://[:password@]host:port[/db]` 与 `rediss://`（TLS），db 号映射到 SELECT |
| 继承 | KvDialect |
| listTables | 无表概念 → 返回 keyspace 概览：`DBSIZE` + `SCAN` 采样统计各类型 key 数量，附提示文案"Redis 无表，用 SCAN 浏览 key" |
| describeTable | 传 key 名 → `TYPE` + 对应长度（STRLEN/LLEN/SCARD/HLEN/ZCARD）+ `TTL` + `MEMORY USAGE` + `OBJECT ENCODING` + 值预览（截断） |
| max_rows | 作用于 `SCAN`/`LRANGE` 等集合返回的截断 |
| 认证 | URL 内密码或独立密码字段（现有表单流程） |

### 5.3 Elasticsearch → `dialects/elasticsearch.ts`

| 项 | 设计 |
|----|------|
| 驱动 | `@elastic/elasticsearch` v8 + v7（npm 别名 `es7` 并存，见 §12 分发规则） |
| URL | `http(s)://host:port`，认证走账号/密码字段（API Key 二期） |
| 继承 | SearchDialect |
| listTables | `client.cat.indices()` → 名称/健康/文档数/大小 |
| describeTable | `_mapping` + `_settings` → 字段/类型/可搜索性 + 分片副本设置 |
| max_rows | search hits 截断 |

### 5.4 Hive → `dialects/hive.ts`

| 项 | 设计 |
|----|------|
| 驱动 | `hive-driver`（npm 社区维护的 HiveServer2 客户端，Thrift 协议） |
| URL | `jdbc:hive2://host:port/database`，默认端口 10000 |
| 继承 | BigDataDialect |
| listTables | `SHOW TABLES`，description 可选（`SHOW TABLE EXTENDED`） |
| describeTable | `DESCRIBE [FORMATTED] table` → 列名/类型/注释 |
| 超时 | 服务端无 per-query timeout，客户端 `withTimeout` 兜底 + 取消 operation |
| 只读 | 写操作关键字：`INSERT INTO/OVERWRITE`、`CREATE TABLE AS`、`LOAD DATA`、`MSCK`、`ALTER` 等 |
| 兼容 | Hive 2.x 与 4.x Thrift 协议存在差异，实施前做版本兼容性 spike |

### 5.5 Spark → `dialects/spark.ts`

| 项 | 设计 |
|----|------|
| 接入 | Spark Thrift Server（HiveServer2 协议），DataFrame/Spark Connect 明确不支持 |
| 驱动 | 复用 `hive-driver`（同一协议栈，与 Hive 共享 BigDataDialect 基类） |
| URL | `jdbc:hive2://host:port/database`（Spark Thrift Server 默认端口 10000/10015，可配） |
| 继承 | BigDataDialect |
| 差异点 | 会话变量前缀（`SET spark....`）、`SHOW TABLES` 范围、`DESCRIBE` 输出列的细微差异在方言内适配 |
| 只读 | 与 Hive 同套关键字机制，额外覆盖 SparkSQL 的 `CACHE TABLE`、`REFRESH TABLE` |

## 6. 统一策略层（policy.ts）

工具入口（query_database）的执行流程收敛为：

```
1. dialect = registry.get(config.type)
2. verdict = dialect.isAllowed(sql, cfg.ai_readonly)   // verdict 含 ok / reason / isWrite / summary
   └─ 拒绝 → 返回原因文本（含如何调整设置的指引）
3. 需要确认？（always / write+verdict.isWrite）
   └─ 确认框 verdict.summary 置顶，原始 SQL 附后（视 UI 能力折叠）；无 UI 环境直接取消
4. dialect.executeOn(config, sql, opts)   // 连接生命周期在方言内部经 withConnection 管理
5. 统一结果格式化输出
```

- “写操作”判定由方言在 `isAllowed()` 的返回值中给出（`isWrite` 字段与拒绝原因一起返回），
  确认策略不再依赖 SQL 关键字判断散落在入口处。
- 硬限制清单（每方言的“永久禁止”项）由方言声明，policy 层统一执行，与只读开关无关。

**效率项（本轮落实）**：

- **提示注入预算**：`before_agent_start` 不再全量堆连接详情，每连接只注一行
  `名称[家族] + 一行语义`（如 `jnycc[KV] - Redis，sql 参数填命令`）；工具 description
  保持静态通用文案（“执行查询或命令”），细节全压进系统提示
- **配置磁盘 IO**：`loadConfigs`/`loadPluginConfig`（现有每轮读两次盘）改为
  内存缓存 + 文件 mtime 失效

## 7. 配置兼容

- 连接配置文件 `~/.pi/agent/db-configs.json`：新增 `type` 取值
  `"dm" | "redis" | "elasticsearch" | "hive" | "spark"`；新增可选字段
  `dbIndex?`（Redis 库号）、`apiKey?`（ES 预留二期）、`options?`（Hive/Spark 会话变量）
- `parseUrl()` 返回统一结构 `ParsedTarget = { host, port, username?, password?, database?, dbIndex?, ssl? }`；
  各家族 URL 主形态：关系型/大数据走 JDBC（`jdbc:xxx://`），Redis 走 `redis(s)://`，ES 走 `http(s)://`；
  同时各方言 `parseUrl` 必须兼收原生 URI（`postgresql://u:p@h/db`、`mysql://…`），与下方一键连接串共用同一解析入口
- 插件设置文件沿用现有 `db-config.json`（含旧名 `db-plugin-config.json` 兼容读取）
- 新增连接表单按家族分支（P0 体验项）：关系型/大数据走“URL+账号+密码”三问；
  Redis 加库号、无账号要求；ES 加账号/密码、API Key 预留二期——分支不对就根本加不上连接
- 一键连接串（P0 体验项）：支持粘贴 `postgresql://u:p@h/db`、`redis://:p@h:6379/0`、
  `http://h:9200`、`jdbc:hive2://h:10000/db` 一次解析建连，替代三问

## 8. 错误处理

- 所有方言保持现有约定：失败返回 `{ success: false, error }`，不抛异常穿透到工具层
- 驱动特有错误（如 dmdb 平台不支持、ES 版本不兼容）在 connect 阶段即失败并给出
  可操作的错误文案（例如提示检查驱动平台支持）
- 超时统一为"连接超时"与"执行超时"两段，客户端兜底超时始终生效

## 8.5 代码扫描建连（`/db scan`，G 阶段）

从项目源码自动抽取连接信息建连，解决手动录入成本与用户名/密码分散问题。

### 两种入口（命令 + 触发词，双通道）

| 入口 | 形态 | 适用场景 |
|------|------|---------|
| **`/db scan [path]`** | 显式命令，path 缺省为当前工作目录且必须位于工作目录子树内；可重复执行 | 用户明确想建连时，精确、可控 |
| **触发词（AI 侧）** | 用户自然语言如“连一下这个项目的数据库”“帮我把这项目的库配上”；由系统提示里的动作文案引导，AI 调用 `scan_project_configs(path?)` 工具 | 用户不知道命令时，AI 按意图兜底 |

两种入口共用同一套核心：命令入口直接跑 TUI 向导；触发词入口由 AI 工具执行扫描、
把候选展示给用户，**建连写盘前必须经用户确认**——密码类字段只在 TUI 通道补录，
不进模型上下文。

### 核心模块 `src/core/scan/`（零 pi 依赖）

```
scan/
├── walker.ts      # 目录漫步：默认忽略 node_modules / .git / target / dist / venv / logs / docs；支持 path 参数
├── parsers.ts     # 按文件类型解析：.env / .properties / yml+yaml（Spring 结构优先）/ docker-compose.yml / 通用 URL 正则
├── spring.ts      # Spring 专属：datasource / data.redis / elasticsearch 键映射 + profile（dev/test/prod）分组
├── placeholders.ts# Spring 占位符 `${KEY:default}` 解析：default → 同目录 .env → 进程 env → 标“待补”
├── scoring.ts     # 置信度：docker-compose/.env/application.yml 高权重；*test* / *example* / *.md / logs 降权或排除
└── candidates.ts  # 统一输出 Candidate[]，状态机：`ready（可直接测连）/ incomplete（缺字段）/ encrypted（jasypt ENC）/ exists（同名已存在）`
```

### 方言指纹（registry 的天然规则库）

每个 Dialect 在注册时声明 `fingerprints: { urlPatterns: RegExp[]; configKeys: string[] }`：
- 关系型：`jdbc:(postgresql|mysql|oracle|dm|hive2)://` + `spring.datasource.*` / druid `jdbcUrl`
- Redis：`redis(s)://` + `spring.data.redis.*` / redisson `address`
- 搜索：`http(s)://host:9200` + `spring.elasticsearch.*` / `spring.data.elasticsearch.*`
新增数据库时指纹随 dialect 文件一起加，不散落。

### 交互流程（Q&A 向导）

```
/db scan [path]
  1. 扫描 → 按 profile/来源分组展示候选：✅ 可直接建 / ✏️ 待补字段 / 🔒 加密密码 / ⏭️ 已存在
  2. 逐个确认：命名（默认 `<项目名>-<profile>-<类型>`）→ 缺字段追问（仅 TUI）→ 同名问覆盖/改名/跳过
  3. 逐个 testConnection → 成功保存，失败给可操作建议
```

硬性原则：**绝不静默建连**（每次写盘前确认）；**绝不静默覆盖**（同名三选一）；
**jasypt `ENC(...)` 只标注不建**（提示人工替换）；扫描结果的密码字段掩码展示；
**path 越界拒绝**：`scan_project_configs(path?)` 的 path 强制约束在当前工作目录子树内，
越界（`/etc`、`~/.ssh`、上跳 `..` 等）直接拒绝——与“密码不进上下文”同级别的红线。

### MVP 范围

Spring yml/properties + docker-compose + 通用 URL 正则，覆盖 8 种方言；
Django / Rails / k8s manifests / IDEA dataSources 后续迭代。
验收：拿一个真实 Spring 项目从零扫出连接并可用。

## 9. 测试策略

- **sql-text.ts 单元测试**（纯函数，重点覆盖）：`''` 转义、注释内分号、
  CTE-DML、`FOR UPDATE`、多语句逐条检查、`SELECT 1; DROP TABLE x` 必须被拦截
- **sql-text / whitelist / policy 单元测试**（B 阶段验收门槛）：`''` 转义、注释内分号、
  CTE-DML、`FOR UPDATE`、多语句逐条检查、`SELECT 1; DROP TABLE x` 必须被拦截；
  Redis 读白名单命中与拒绝、FLUSHALL 恒拒；ES 端点白名单、DELETE index 恒拒
- **方言集成测试**（可选，标记为需要真实服务）：PG/MySQL/Oracle/DM/Redis/ES/Hive/Spark
  各跑一轮 connect → listTables → describeTable → 只读拦截 → 写确认；CI 中默认跳过
- **回归**：现有 `/db` 菜单全流程手工回归（新增/编辑/删除/设置/AI 工具）
- **registry 规模断言**：单测断言 `registry.size` 等于已实现方言数（B 阶段 3，全部完成后 8）；
  index.ts 聚合行遗漏时该断言失败，防止“加了文件没生效”

## 10. 实施里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| A | 修安全 Bug（逐语句 DROP/写检查、注释剥离、CTE/FOR UPDATE） | 新增单测全绿 |
| B | 方言化重构（目录调整 + Dialect 接口 + 现有三库迁入），核心零 pi 依赖 | 现有功能回归通过；grep 验证 core/dialects 无 pi **运行时** import——验收命令（排除 `import type` 行）结果为空：`grep -rn "from ['\"]@earendil\|require(.*pi" src/core src/dialects \| grep -v "import type"` |
| C | DM 支持（前置：dmdb 连接 spike） | 真实 DM 连接可查表/查数据 |
| D | Redis 支持 | 只读白名单生效，FLUSHALL 恒拒 |
| E | Elasticsearch 支持 | 只读端点白名单生效，删索引恒拒 |
| F | 大数据家族 + Hive/Spark 支持（前置：hive-driver 对 Hive 4.x 兼容性 spike） | 真实 Hive/Spark 连接可查表/查数据，长查询超时可取消 |
| G | 体验 P0：家族分支新增表单、一键连接串、默认连接、list_tables pattern、**代码扫描建连 `/db scan`** | 见 §11.1 / §8.5 |
| H | 发布准备（npm 发布指引、README 更新、pi-package keyword 确认） | pi.dev/packages 可搜到 |

## 11. 使用体验

### 11.1 P0（本轮落实，随 G 阶段验收）

- **默认连接**：`database` 参数改为可选，缺省走标记为默认的连接（`/db` 菜单设默认）；
  AI 调参成功率提升最明显的一处，工具未传参时不再报错
- **查询结果导出**：CSV/JSON 落文件，长结果不再糊进上下文
- **代码扫描建连 `/db scan`**：详见 §8.5（含 `scan_project_configs` AI 工具 + Spring 占位符/jasypt 三条规则 + MVP 范围）
- **`list_tables` 加 `pattern?` 可选参数**：向后兼容（缺省全量），表上千时 AI 不再被全量表名淹没

### 11.2 P1/P2（后续迭代，不进本轮计划）

- P1 历史 SQL + 重跑（`/db history`）
- P1 连接健康巡检（`/db health`）
- P2 密码引用环境变量（`${ENV}`）+ 连接串密码掩码显示

## 12. 版本兼容矩阵（本轮必须覆盖）

| 数据库 | 本轮支持版本 | 驱动 | 已知边界与兜底 |
|--------|-------------|------|----------------|
| PostgreSQL | 9.6 ~ 17 全系 | `pg` | 全系兼容，无已知上限；`statement_timeout` 全版本可用 |
| MySQL | **5.7 / 8.0 / 8.4** | `mysql2` v3 | `mysql_native_password` 与 8.0 默认 `caching_sha2_password` 均原生支持；`max_execution_time` 需 ≥5.7.8，低于此版本 SET 失败时忽略（客户端超时仍生效） |
| Oracle | **≥12.1** | `oracledb`（Thin 模式，零依赖） | Thin 模式硬性要求 DB ≥12.1；**11g 及以下本轮不支持**——`testConnection` 失败时如疑似老版本，给出明确文案（“Thin 模式要求 Oracle ≥12.1，老版本需 Thick 模式，暂未支持”）；Thick 模式（`initOracleClient()` + 用户自装 Instant Client，可连 ≥11.2.0.4）列入后续迭代，见 §14 |
| 达梦 | **DM8 全系**；DM9 待验证 | `dmdb` | 官方文档称“DM 8.0 及以上版本”；DM9 兼容性纳入 C 阶段 spike（有真实 DM9 环境才验证，否则 README 声明仅测过 DM8） |
| Redis | 2.8 ~ 8.x 全系 | `ioredis` | `SCAN` 需 ≥2.8；`MEMORY USAGE` 需 ≥4.0，低版本失败时降级跳过该字段（describeTable 逐命令容错）；生产库禁 `KEYS`，一律 SCAN |
| Elasticsearch | **7.x / 8.x** | `@elastic/elasticsearch` v8 + v7（npm 别名 `es7` 并存） | 官方只保证同大版本兼容；`testConnection` 先 `GET /` 探测大版本号再分发到对应客户端（7.x→v7 包，8.x→v8 包）；未知/更高大版本时用最新客户端尝试并给出版本警告（`TestConnectionResult.warning?: string`，不硬拒） |
| Hive | 目标 2.x；**4.x 待 spike** | `hive-driver` | HS2 Thrift 协议 2→4 有差异，靠 `client_protocol` 同步 API 版本；F 阶段前置 spike，失败则声明仅支持 2/3 |
| Spark | 2.x ~ 4.x（Thrift Server） | 复用 `hive-driver` | 同 Hive 协议栈，spike 一并覆盖；Spark Connect（DataFrame/gRPC）明确不支持 |

约束条款：`testConnection` 必须同时返回服务端版本号（现有行为保留）；各方言支持的
版本范围写入 README；集成测试按**端点抽测**——每个支持项只测“最老支持版 + 最新版”
两个端点（如 MySQL 5.7 + 8.4、ES 7 + 8），中间版本声明兼容不实测。

## 13. 未来扩展路径（非本期范围）

- **Oracle Thick 模式**：`oracledb.initOracleClient()` + 用户自装 Instant Client Basic 包
  （约 100~200MB，按平台区分），可支持 Oracle ≥11.2.0.4（含 11g）。实现为连接配置
  开关 `options.oracleClient = "thick"` + 建连失败时的三步安装引导；有真实 11g 需求时再做
- **Spark Connect**（DataFrame 语义，gRPC 远程会话）：与“发 SQL 文本、拿表格结果”的
  工具契约不匹配，若将来有真实需求再评估第五种交互形态，不提前建抽象
- **Flink / Trino / ClickHouse 等**：Trino/ClickHouse 本质仍是 SQL over HTTP/Thrift，
  预计可归入关系型家族；Flink SQL 若需异步作业提交再评估
- 分类标准是协议与查询语义（SQL/KV/DSL），而非引擎定位或数据规模

## 15. 风险清单

| 风险 | 应对 |
|------|------|
| dmdb 无 macOS/ARM 二进制 | C 阶段前置 spike；失败则文档声明平台限制 |
| ES 7.x 需双客户端分发（v7+v8 包并存） | E 阶段实现分发逻辑；未知更高大版本用最新客户端尝试 + `warning` 字段提示 |
| Oracle 11g 及以下连不上（Thin 硬性要求 ≥12.1） | 本轮仅做失败文案指引（点明版本原因 + Thick 未支持）；Thick 见 §14 |
| Redis SCAN 采样统计在大库上慢 | COUNT 限幅 + max_rows 截断，文案注明“采样统计” |
| hive-driver 对 Hive 4+ 协议兼容性未知 | F 阶段前置 spike；失败则声明仅支持 Hive 2/3，或改用 HTTP/Thrift 直连方案 |
| 动态系统提示变长 | 方言 hint 按需精简；KV/搜索连接附带一行语义说明 |

---

## 修订记录

- 2026-09-09 结合现有代码（index.ts 808 行 / src/db.ts 504 行）复审修订：
  1. §2.0 增补配置类型裁决（`DbConfig`/`toConnConfig` 废止、`extraParams`→`options` 兼容迁移、`database` 改可选、`isDefault` 提前进入类型清单）；
  2. §3/§7 统一 URL 形态：`parseUrl` 兼收 JDBC 与原生 URI（消除与一键连接串的形态矛盾）；
  3. §4.1 声明 WITH-DML 保守误报并固化单测；§4.2 声明 `CONFIG` 一刀切含 `CONFIG GET`；
  4. §12/§15 `versionWarning` 统一命名为 `TestConnectionResult.warning`；
  5. §3 label 映射“3 处”更正为 5 处（与实际代码一致）；章节号 14→13（原跳号）。
