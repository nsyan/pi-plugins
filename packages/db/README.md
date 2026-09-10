<div align="center">

# db

**AI 接入数据库插件 —— 方言化架构，原生 Node.js 实现**

支持关系型 / KV / 搜索 / 文档 / 大数据五大家族，共 9 种数据库的查询、表结构浏览与项目配置扫描建连。

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)

</div>

## ✨ 特性

- **方言化架构**：`core/` + `dialects/` 零 pi 运行时依赖，为 MCP server 复用铺路
- **9 种数据库**：PostgreSQL · MySQL · Oracle · 达梦 DM8 · Redis · Elasticsearch · MongoDB · Hive · Spark（Thrift Server）
- **五大家族**：关系型 / KV / 搜索 / 文档 / 大数据，各有一套共享基类
- **安全强化**：
  - 多语句**逐条**检查，`SELECT 1; DROP TABLE x` 无法绕过
  - 注释剥离后再匹配，`/* c */ DELETE` 无法绕过
  - CTE-DML / `FOR UPDATE` 识别为写操作
  - Redis 命令白名单（只读模式放行读命令，`FLUSHALL/CONFIG/SHUTDOWN` 恒拒）
  - ES 端点白名单（只读模式放行读端点，`DELETE index` 恒拒）
  - MongoDB JSON 命令信封白名单（读命令白名单，`drop*`/`create*`/管理命令/服务端 JS `$where/$function/$accumulator` 恒拒，aggregate 含 `$out/$merge` 按写分类）
- **代码扫描建连** `/db scan`：从 Spring 配置 / docker-compose / .env 自动抽取连接候选
- **P0 体验**：一键连接串（自动识别家族）、默认连接（`database` 参数可选）、`list_tables` pattern 过滤、超 50 行结果自动导出 CSV/JSON

## 📦 安装

**npm 安装（推荐，任意机器可用）：**

```bash
pi install npm:@nsyan/db
```

**本地源码安装（本仓库开发者）：**

```bash
# 在本仓库根目录执行
pi install ./packages/db
```

> 依赖 `pg` / `mysql2` / `oracledb` / `dmdb` / `ioredis` / `@elastic/elasticsearch` / `es7` / `mongodb` / `hive-driver` / `typebox`，`pi install` 自动安装。

## 🚀 快速开始

```bash
/db add          # 新增连接（一键粘贴连接串，或按家族逐步填写）
/db ls           # 列出所有连接
/db scan         # 扫描项目源码自动建连
/db config       # 查看/修改全局设置
```

AI 侧接入后，直接用 `query_database` / `list_tables` / `describe_table` / `scan_project_configs` / `db_connections` 五个工具即可。

## 🗂️ 连接管理

- **状态摘要列表**：连接选择器展示 `名称 [类型] ⭐默认 [prod·强制只读] · 上次使用 2 天前 · 测试 ✓45ms`，打开/编辑/删除/切默认共用
- **⚡ 切换默认**：一级菜单直达（选中即切），无需进入连接动作菜单
- **🧪 测试连接**：连接动作菜单内独立入口；**编辑保存后自动回测**，结果回显
- **📋 从现有复制**：新增连接第三条路径，复制类型/账号/环境标签等全部设置，仅需改名
- **环境标签 + 强制只读**：连接可标 `dev/test/prod`；`prod` 建连时主动建议开启**强制只读**——开启后该连接无视全局只读开关，永远只接受查询（AI 侧写入会被拒并提示原因）
- **db_connections 工具**：AI 可自查连接清单与环境标签，说“在生产库查一下”时先识别哪条是 prod
- 最近使用时间与测试结果自动回写，无需手工维护

## 🗄️ 支持的数据库

| 数据库 | 家族 | 驱动 | 支持版本 | 备注 |
|--------|------|------|---------|------|
| PostgreSQL | 关系型 | `pg` | 9.6 ~ 17 全系 | `statement_timeout` 全版本可用 |
| MySQL | 关系型 | `mysql2` v3 | 5.7 / 8.0 / 8.4 | `max_execution_time` 需 ≥5.7.8，低版本自动忽略（客户端超时仍生效） |
| Oracle | 关系型 | `oracledb`（Thin，零依赖） | ≥12.1 | Thin 模式硬性要求 DB ≥12.1，11g 及以下不支持（会给出版本原因指引）；Thick 模式列入后续迭代 |
| 达梦 DM | 关系型 | `dmdb` | DM8 全系；DM9 未验证 | 纯 JS 依赖，macOS/Linux/Windows 可用 |
| Redis | KV | `ioredis` | 2.8 ~ 8.x | `SCAN` 需 ≥2.8；`MEMORY USAGE` 需 ≥4.0，低版本自动跳过；生产库一律 SCAN，禁 `KEYS` |
| Elasticsearch | 搜索 | `@elastic/elasticsearch` v8 + v7（npm 别名 `es7`） | 7.x / 8.x / 更新大版本 | 连接时探测大版本分发对应客户端；未知大版本用最新客户端尝试并给出版本警告 |
| MongoDB | 文档 | `mongodb`（官方驱动，纯 JS） | **已验证主流区 6.0 / 7.0 / 8.0**；4.2~5.x 可用未验证（4.x 已 EOL） | `query_database` 的 sql 参数填 JSON 命令信封；`mongodb://` 与 Atlas `mongodb+srv://` 双形态；`describe_table` 优先读 `$jsonSchema` validator，缺失时采样 ≤100 文档推断字段（非权威）；无 limit 自动补 maxRows |
| Hive | 大数据 | `hive-driver` | 目标 2.x；4.x 未实测 | HS2 Thrift 协议；无 4.x 环境前声明仅支持 2/3 |
| Spark（Thrift Server） | 大数据 | `hive-driver`（复用） | 2.x ~ 4.x | 与 Hive 同协议栈；Spark Connect（DataFrame/gRPC）不支持 |

> 版本兼容采用**端点抽测**：每个支持项只实测「最老支持版 + 最新版」两个端点，中间版本声明兼容不实测。

## ⚙️ 新增连接

`/db add` 首问选择「粘贴连接串（一键）」或「逐步填写」。连接串自动识别家族：

```
postgresql://user:pass@host:5432/db     → PostgreSQL
jdbc:mysql://host:3306/db               → MySQL
jdbc:oracle:thin:@//host:1521/svc       → Oracle（也支持 SID 形式）
jdbc:dm://host:5236/schema              → 达梦
redis://:pass@host:6379/0               → Redis（含 rediss:// TLS）
mongodb://user:pass@host:27017/db       → MongoDB（含 +srv Atlas 形态，authSource/replicaSet 进 options）
http://host:9200                        → Elasticsearch
jdbc:hive2://host:10000/db              → Hive / Spark
```

逐步填写按家族分支：Redis 无账号要求、需库号（dbIndex）；MongoDB 账号可空（本地无认证常见）；ES/其余 URL + 账号 + 密码。

## 🍃 MongoDB 命令信封

MongoDB 走 `query_database`，`sql` 参数填 JSON 命令信封（`db.runCommand` 文档形态，单命令一次执行）：

```json
{"find": "users", "filter": {"age": {"$gt": 18}}, "sort": {"created_at": -1}}
{"count": "users"}
{"aggregate": "orders", "pipeline": [{"$group": {"_id": "$status", "n": {"$sum": 1}}}]}
{"insert": "users", "documents": [{"name": "x"}]}
```

- 未写 limit 的读命令自动补 `maxRows`，结果超限自动标 `truncated`
- 返回文档拍平为列（顶层字段并集，封顶 50 列，嵌套转 JSON 字符串）
- `list_tables` → `listCollections`；`describe_table` → `collStats` + 索引 + validator/采样字段推断
- 硬限制：`drop*`/`create*` 等管理 DDL 与服务端 JS（`$where`/`$function`/`$accumulator`）恒拒；aggregate 含 `$out`/`$merge` 按写操作处理

## 🔎 代码扫描建连 `/db scan`

从项目源码自动抽取连接信息（Spring `application*.yml/properties`、`docker-compose.yml`、`.env`、通用 URL 正则）：

```bash
/db scan            # 扫描当前工作目录
/db scan ./backend  # 扫描指定子目录（越界拒绝）
```

扫描结果按状态分组：✅ 可直接建 / ✏️ 待补字段 / 🔒 jasypt 加密（只标注不建）/ ⏭️ 同名已存在。逐个确认后才写入配置——**绝不静默建连、绝不静默覆盖**。占位符 `${KEY:default}` 取 default，`${KEY}` 依次查同目录 `.env` → 进程环境变量，缺省在终端追问。

AI 侧说「连一下这个项目的数据库」等，会调用 `scan_project_configs` 展示**掩码后**的候选（不写盘），建连仍需你在终端确认，密码不进模型上下文。

## ⭐ 默认连接

`/db` → 打开连接 → `⭐ 设为默认`。AI 调用工具时 `database` 参数可省略，缺省走默认连接；未设默认时给出指引。

## 💾 查询结果导出

查询结果超过 50 行时，完整结果自动导出到 `/tmp`（CSV + JSON 双格式），只返回文件路径。结果达到 `max_rows` 上限截断时有明确标注。

## 🔐 安全控制

- **执行策略同步**：系统提示动态注入当前 AI 只读模式与执行确认设置
- **逐语句检查**：多语句 SQL 逐条检查，注释剥离后再匹配
- **硬限制**：DROP TABLE/DATABASE（关系型/大数据）、`FLUSHALL/FLUSHDB/CONFIG/SHUTDOWN`（Redis）、`DELETE <index>`（ES）、`drop*`/`create*`/管理命令/服务端 JS（MongoDB）
- **只读白名单**：Redis 读命令白名单、ES 读端点白名单、MongoDB 读命令白名单（JS 执行恒拒）
- **连接级强制只读**：标了 `forceReadonly` 的连接（如生产库）无视全局开关，永远只读
- **写操作执行理由**：AI 发起写操作必须附 `reason`（动机+影响范围），确认框首行展示、随结果回显；缺失时直接拒绝并引导补充，与确认策略无关
- **本地审计（默认关闭）**：`/db config → 审计日志` 开启后，写成功追加 `~/.pi/agent/db-audit/<YYYY-MM-DD>.jsonl`（按天分文件，含项目路径/连接/理由/**完整 SQL 不截断**，0600）；审计失败不阻断主流程。清理示例：`find ~/.pi/agent/db-audit -name "*.jsonl" -mtime +90 -delete`。理由强校验不受此开关影响
- **凭据降险**：连接配置含明文密码，保存时自动 `chmod 0600`（仅当前用户可读写）；系统钥匙串（keychain）列入远期规划
- **确认策略**：不确认 / 写操作确认 / 每次确认；无 UI 环境自动取消
- **手工查询一致**：`/db` 菜单手工执行与 AI 工具使用相同的策略裁决

## ⚙️ 设置

通过 `/db config` 修改，每轮注入系统提示：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| AI 只读模式 | 是 | 开启时 AI 只能执行查询；关闭时允许写操作 |
| 执行确认 | 写操作确认 | 不确认 / 写操作确认 / 每次都确认 |
| 最大行数 | 100 | 查询返回的最大行数 |
| 查询超时 | 30s | 单条语句超时（服务端设置失败时客户端兜底） |

## 📁 开发

```bash
pnpm install
cd packages/db
NODE_ENV=development pnpm test   # 运行全部单测（tsx + node:test）
```

## 📜 更新记录

见仓库根目录 [CHANGELOG.md](../../CHANGELOG.md)。当前版本 **1.1.0**（2026-09-10）：新增 MongoDB 支持（document 家族）；连接管理体验升级（状态摘要/切换默认/从现有复制/环境标签+强制只读/db_connections 工具）。

## 📄 许可

[MIT](./LICENSE)
