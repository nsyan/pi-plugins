# 更新记录

本仓库遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [规划中]

来源：MCP 生态调研中识别但暂不实现的高价值项——

- 系统 keychain 凭据存储（macOS Keychain / Windows 凭据管理器 / libsecret）
- SSH 隧道建连（DBHub 已支持）
- 自定义参数化 SQL 工具（DBHub custom tools：配置文件中定义可复用查询，LLM 按名调用）
- 连接量大时的搜索过滤选择器
- 审计日志保留期自动清理配置（当前按天分文件，手动 `find -mtime +N -delete` 即可）
- 全表扫描拦截类护栏（MongoDB 官方 MCP `indexCheck` 思路；对 OLTP 小库误伤率高，需白名单化后再评估）

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
