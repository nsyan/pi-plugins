# 更新记录

本仓库遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.1] - 2026-09-11

### Fixed（packages/db）

- **类型标签补全**：`shortTypeLabel` / `fullTypeLabel` 补齐 dm/redis/elasticsearch/hive/spark——此前这五种静默 fallback 成原始小写 id，污染 AI 系统提示与 `db_connections` 输出（如 Redis 显示为 `名称[redis] - redis`）。键类型改用 `Record<DbTypeId, ...>`，新增方言漏补标签将在类型检查阶段报错，不再静默降级
- **AI 系统提示家族语义补全**：`familyHint` 补齐 redis（SCAN 提示）/elasticsearch（仅读端点）/hive/spark，并将**达梦（dm）归入关系型**
- **package.json**：删除重复声明的 `neo4j-driver` 依赖
- **Elasticsearch 聚合结果不可见**：`hitsToRows` 只取 `hits`，聚合桶被丢弃；且插件注入的顶层 `size=maxRows` 会覆盖 body 里的 `size`，使 `size:0` 纯聚合查询退化成普通搜索返回文档。现：body 显式带数字 `size` 时不再注入顶层 size；无命中但有 `aggregations` 时展开为行（列 `aggregation/key/doc_count/value`，桶内子聚合折叠为 `value` 列 JSON，metric 取值）
- **ES `_count` 行数误导**：“返回 N 行”里的 N 原来是计数值本身（如「返回 88 行」却只给一行），现改为 1 行（计数值在单元格里）
- **结果截断无提示、不导出（ES + 关系型五方言）**：ES 与 PG/MySQL/DM/Oracle 都没设 `truncated`（仅 bigdata 方言有），而工具层导出/提示条件是 `rows.length > 50`，恰好等于 maxRows 时永远不触发——超限查询少给数据却无任何提示。现：关系型基类按「有列结果集 且 rowCount > rows.length」标 `truncated`（写操作不误标）；ES 按「total > 取回行数」标注；工具层与 `/db` 菜单改为在**截断或超 50 行**时落盘导出并提示“服务端仍有更多数据未取回”
- **25 项既有类型错误清零**（`pnpm typecheck` 首跑 25 → 0），全部为类型层修复、**运行时行为不变**。其中有实际意义的两处：
  - `core/scan/validate.ts`：`bag` 由 `Partial<CandidateInput>` 改为 `Partial<ConnConfig>`，避免端口范围校验退化为字符串比较
  - `dialects/oracle.ts`：`listTables` 显式标注 `TableInfo[]`，修复泛型回退丢失 `type`/`description` 字段的问题
- 其余类型修复：`index.ts` 工具返回补 `details: undefined`（与「不提供该字段」运行时等价，刻意不用 `{}`）；mysql/dm/hive/spark/redis/es/neo4j 方言补最小类型断言（上游类型定义缺失，均附注释）；新增 `types/upstream-shims.d.ts` 为无类型的 `oracledb` 声明最小契约

### Added

- **类型检查落地**：`pnpm --filter @nsyan/db typecheck`（新增 devDeps `typescript` / `@types/node` / `@earendil-works/pi-coding-agent` + `tsconfig.typecheck.json`）。刻意使用非默认配置名——`tsx --test` 会读取默认 `tsconfig.json`，导致测试解析被破坏。`--frozen-lockfile` 已可跑通，具备接入 CI 的条件（workflow 尚未添加）
- **回归测试**：类型标签遍历断言（新增方言漏补即失败）+ Redis SCAN 调用形态断言。测试总数 128 → 133

## [1.3.0] - 2026-09-11

### Changed（packages/db）—— 扫描建连重构为会话 AI 驱动

**Breaking**：正则提取层整体废弃（v1.2 及以前的 Spring 键映射/baomidou 解析/占位符 `.env` 回退/docker 镜像识别/通用 URL 正则删除），文件发现与配置提取全部交给会话模型：

- **`scan_project_configs` 重构**：不再返回掩码候选，改为返回项目文件树（语言无关，Java/Py/Go/TS/Rust 均覆盖）；会话 AI 自行判断哪些文件含连接配置并用自带读文件工具阅读、提取候选
- **新增 `db_scan_save` 工具**：AI 提交提取的候选，工具逐个弹确认框（确认 → 补录缺字段 → 测试连接通过才写盘；同名三选一），扫描建连全程会话内闭环，无需终端
- **`/db scan` 参数**：支持自然语言类型筛选——「/db scan 配置pg」「只看 redis 和 neo4j」由会话模型理解并过滤（无参数 = 全类型）；终端 `/db scan` 命令改为引导提示（提取已迁移会话）
- **防幻觉校验**（`validate.ts` 纯函数）：dialectId 必须在注册表内；带 url 的候选必须能被方言 parseUrl 解析（claim 与 url 矛盾整条拒绝，解析成功后以 URL 为准）；host 必填、port 1~65535；同名候选标 exists
- **修复（随重构消失）**：baomidou dynamic-datasource URL 含 `${POSTGRES-IP:10.2.12.50}` 占位符时旧正则路由失败导致 PG/DM 整库漏扫的 Bug（AI 提取不受占位符影响，根因消除）
- **隐私行为变化（用户知情接受）**：配置文件原文（含密码）随 AI 阅读进入会话上下文；v1.2 及以前"密码不进模型上下文"的承诺不再适用于扫描场景
- 确定性设施保留：walker 目录遍历（排除 node_modules/target 等）、方言 parseUrl（粘贴连接串与防幻觉校验共用）、各家族 REQUIRED 必填字段表
- 测试：新增候选校验/防幻觉/文件树单测（128 条全绿）；旧正则提取测试随代码删除
- **配置中心支持（Route A，零代码）**：scan_project_configs 指令引导 AI 两跳提取——发现 bootstrap.yml 指向 Nacos/Apollo/Spring Cloud Config 时，用其地址凭据调 Open API（Nacos：login 拿 accessToken → cs/configs 拉 dataId 原文）拉取远端配置后再提取候选，校验/确认流程照常

## [1.2.1] - 2026-09-11

### Fixed（packages/db）

- ES方言: 修复 parseUrl 不支持带凭据 URL（`http://user:pass@host:port`，密码 URL 编码自动解码），userinfo 解出后归一化到 username/password——此前这类 URL 会被扫描校验层当幻觉拒绝

### Changed（packages/db）

- 发布元数据: description 改中英双语，补 database access/query/schema browsing/scan 等英文检索词
- 发布元数据: keywords 新增 达梦/sql/llm（覆盖中文检索与高频词）
- 发布元数据: package.json 补 repository 字段指向 GitHub 仓库，pi.dev gallery 详情页可展示 repo 链接
- 发布配置: 版本号 1.2.1，重发触发 pi.dev 目录重索引（issue #6991 实测重发后约 2.5h 收录）

## [1.2.0] - 2026-09-11

### Added（packages/db）

**Neo4j 支持（graph 家族，第十种数据库、第六家族）**：

- `query_database` 的 `sql` 参数接受 Cypher 原文，支持分号分隔多语句（逐条执行取最后一条结果，对齐关系型方言）
- 驱动 `neo4j-driver@^5.28`（纯 JS 零原生编译）；按官方兼容矩阵声明 server **4.4 ~ 2025.x**，已验证 **4.4.29 community** 真连冒烟
- 连接串支持 `bolt://`/`neo4j://` 及 `+s`/`+ssc` TLS 变体；建连统一 Bolt 直连——单机社区版无路由服务，`neo4j://` 路由 scheme 会报 No routing servers available；URL 路径段 = 图数据库名（缺省 `neo4j`）
- 图结构语义：`list_tables` 返回 node label（NODE LABEL）+ 关系类型（RELATIONSHIP，`rel:` 前缀）；`describe_table` 目标填 label 名或 `rel:类型`，返回实体计数 + `SHOW INDEXES/CONSTRAINTS` + 采样 ≤100 推断属性键（对齐 Mongo Q5 共识；只依赖核心过程，不依赖 APOC）
- 安全（Cypher 读写分类器）：CREATE/MERGE/DELETE/DETACH/SET/REMOVE/DROP/FOREACH/LOAD CSV 任意深度出现即按写（读外壳夹写拦得住）；字符串字面量/注释/反引号标识符内写词不误判；`CALL dbms.*` 管理过程**恒拒**；未知 CALL 过程（含 apoc.*）保守按写；SHOW 类目白名单
- 体验：Node/Relationship/Path 结果拍平为展示原语；无返回记录的写语句回显变更计数；limit 客户端截断对齐关系型方言
- 扫描建连：Spring `spring.neo4j.uri`（Boot 3）/ `spring.data.neo4j.uri`（Boot 2）+ authentication 账号密码键、`.env` `NEO4J_URI`/`NEO4J_URL`/`BOLT_URL`、docker-compose `neo4j` 镜像、通用 URL 正则补 bolt/neo4j scheme
- 反引号引用 Cypher 标识符（数字名 label 如 `0` 可安全查询）

## [规划中]

来源：MCP 生态调研中识别但暂不实现的高价值项——

- 系统 keychain 凭据存储（macOS Keychain / Windows 凭据管理器 / libsecret）
- SSH 隧道建连（DBHub 已支持）
- 自定义参数化 SQL 工具（DBHub custom tools：配置文件中定义可复用查询，LLM 按名调用）
- 连接量大时的搜索过滤选择器
- 审计日志保留期自动清理配置（当前按天分文件，手动 `find -mtime +N -delete` 即可）
- 全表扫描拦截类护栏（MongoDB 官方 MCP `indexCheck` 思路；对 OLTP 小库误伤率高，需白名单化后再评估）

## [1.1.1] - 2026-09-11

### Fixed（packages/db）

- **MySQL**：事务控制等语句（`START TRANSACTION`/`BEGIN`/`COMMIT`/`ROLLBACK`）在 mysql2 prepared 协议下报 `ER_UNSUPPORTED_PS`，现自动降级 `query()` 执行（插件从不绑定参数，语义等价）
- **扫描建连**：识别 baomidou dynamic-datasource 布局（`spring.datasource.dynamic.datasource.<name>.url/username/password`），每个具名数据源独立成候选
- **扫描建连**：walker 不再被大仓库普通文件挤爆——配置类文件（yml/yaml/properties/.env）单独收集、遍历始终走完整棵树（此前 2000 文件配额被 src 源码灌满后，后遍历目录里的配置文件永远收不到）
- **达梦**：`parseUrl` 支持 `jdbc:dm://host:port?schema=x`（无路径段）形态，库名回退取 `schema=` 参数；无路径也无 schema 时 database 可选
- **达梦**：`listTables`/`describeTable` 列名全部加表前缀，修复 DM 报 `[-2112] 有歧义的列名`；`describeTable` 支持限 schema，缺省用连接 schema 限定 OWNER，消除同名表跨 schema 列重复
- **达梦**：`doConnect` 传 `loginEncrypt: false`，修复 Node≥17（OpenSSL 3）登录报 `digital envelope routines::unsupported`（服务端强制加密时请以 `NODE_OPTIONS=--openssl-legacy-provider` 启动宿主，错误信息已带指引）
- **Redis**：`sendCommand` 返回的 Buffer 统一递归解码为 UTF-8（此前 INFO/SCAN/GET/TYPE 按字节逐行渲染）；读白名单补充 `PING`/`TIME`/`ECHO`/`LOLWUT`/`LASTSAVE`（不再误判为写）
- **Elasticsearch**：写端点早期明确拒绝（原先可写模式放行到用户确认后才报"仅执行读查询"）；aggs-only 等纯检索体（`aggs`/`size`/`sort` 等无 `query` 键）按读分类，不再误判为写
- **MongoDB**：`count`/`insert` 等单文档响应剥掉协议噪声字段 `ok:1`，少一列无信息量输出
- **Elasticsearch**：兼容 ES 7.0~7.13——v8/v9 客户端的产品校验（`X-elastic-product` 头，7.14+ 才有）会拒绝低版本实例并抛 "unknown product"，现探测失败自动回退 v7 客户端；v7 响应 `{body,...}` 包裹形状统一解包（此前 v7 分支即使连上也只会返回空结果）

## [1.1.0] - 2026-09-10

### Added（packages/db）

**MongoDB 支持（document 家族，第九种数据库）**：

- `query_database` 的 `sql` 参数接受 JSON 命令信封（`db.runCommand` 文档形态），如 `{"find":"users","filter":{}}`
- 驱动 `mongodb@^6`（纯 JS 零原生编译）；已验证主流区 **6.0 / 7.0 / 8.0**，server 4.2~5.x 可用未验证
- 连接串支持 `mongodb://` 与 Atlas `mongodb+srv://`（默认 TLS）；`authSource`/`replicaSet`/`authMechanism`/`tls` 等经 `options` 贯通，`authSource` 缺省 `admin`
- 安全：读命令白名单（find/count/distinct/aggregate 等）；`insert/update/delete/findAndModify` 走写确认；`drop*`/`create*` 等管理 DDL 与服务端 JS（`$where`/`$function`/`$accumulator`）**恒拒**；aggregate 含 `$out`/`$merge` 按写分类；未知命令保守按写
- 体验：读命令无 limit 自动补 `maxRows`（aggregate 自动追加 `$limit` 阶段）；结果拍平为列（顶层字段并集，封顶 50 列，嵌套转 JSON 字符串）；`list_tables` → `listCollections`；`describe_table` → `collStats` + 索引 + `$jsonSchema` validator，缺失时采样 ≤100 文档推断字段
- 代码扫描建连：Spring `spring.data.mongodb.uri`（独立分组）、`.env` `MONGODB_URI`、docker-compose `mongo` 镜像 + `MONGO_INITDB_*` 环境变量、通用 URL 正则

**连接管理体验升级**（调研 DBHub / MongoDB 官方 MCP / Postgres MCP Pro 后设计）：

- **状态摘要列表**：连接选择器升级为 `名称 [类型] ⭐默认 [prod·强制只读] · 上次使用 2 天前 · 测试 ✓45ms`；最近使用时间与测试结果自动回写
- **⚡ 切换默认**：一级菜单直达，选中即切（原三层路径变两层）
- **🧪 测试连接**：连接动作菜单独立入口；**编辑保存后自动回测**；扫描/向导建连结果同步回写
- **📋 从现有复制**：新增第三条建连路径，复制全部设置（含 options/环境标签），仅需改名，可选立即编辑
- **环境标签 + 连接级强制只读**：连接可标 `dev/test/prod`；`forceReadonly` 连接无视全局只读开关永远只读，AI 侧写入被拒并提示原因；prod 标签建连时主动建议开启
- **`db_connections` 工具**：第五个工具，AI 可自查连接清单/类型/环境标签/测试状态（不含密码），识别生产库后再查询
- **凭据降险**：连接配置保存时自动 `chmod 0600`（仅当前用户可读写）
- **文档重构**：主 README 重构为着陆页（特性/安装/快速开始/安全模型表），使用细节拆分至 `docs/USAGE.md`（npm 包内含）
- **写操作执行理由与审计**：AI 发起写操作必须附 `reason`（动机+影响范围），确认框首行展示并随结果回显；写成功可追加本地审计 `~/.pi/agent/db-audit/<YYYY-MM-DD>.jsonl`（按本地日期一天一个文件，含项目路径/连接/理由/完整 SQL 不截断，0600；**默认关闭**，`/db config → 审计日志` 开启），审计失败不阻断主流程

### Fixed（packages/db）

- 扫描建连：`pushUrl` 先以完整 URL 路由、失败再回退剥离 query——修复 MongoDB 连接串中 `authSource`/`replicaSet` 等参数在扫描场景下被整体剥掉的问题（JDBC 带查询参数行为不变）
- MongoDB 查询：结果数**恰好等于** `maxRows` 时也标 `truncated`（对齐 bigdata 方言语义；此前 find 被 limit 注入封顶后该标记永不生效）
- MongoDB 查询：信封 `limit: 0`（Mongo 语义为"不限"）与负数 limit 视为未提供，收敛到 `maxRows`（此前被错误收敛为 1 行）
- MongoDB 查询：Binary/UUID 等 BSON 值序列化优先 `toJSON()`（此前 UUID 字段显示为 `[object Object]`）
- MongoDB 连接：IPv6 字面量主机（`[::1]:27017`）不再被重复追加端口

## [1.0.0] - 初始版本

- **八种数据库**（关系型 / KV / 搜索 / 大数据四大家族）：PostgreSQL · MySQL · Oracle · 达梦 DM8 · Redis · Elasticsearch · Hive · Spark（Thrift Server）
- 方言化架构（`core/` + `dialects/` 零 pi 运行时依赖）
- 查询 / 表结构 / 扫描建连 / 一键连接串 / 默认连接 / 结果导出 / 安全策略（只读 + 确认 + 白名单 + 硬限制）
