<div align="center">

# db

**AI 接入数据库插件 —— 方言化架构，原生 Node.js 实现，无需 Python**

支持关系型 / KV / 搜索 / 大数据四大家族，共 8 种数据库的查询、表结构浏览与项目配置扫描建连。

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)

</div>

## ✨ 特性

- **方言化架构**：`core/` + `dialects/` 零 pi 运行时依赖，为 MCP server 复用铺路
- **8 种数据库**：PostgreSQL · MySQL · Oracle · 达梦 DM8 · Redis · Elasticsearch · Hive · Spark（Thrift Server）
- **四大家族**：关系型 / KV / 搜索 / 大数据，各有一套共享基类
- **安全强化**：
  - 多语句**逐条**检查，`SELECT 1; DROP TABLE x` 无法绕过
  - 注释剥离后再匹配，`/* c */ DELETE` 无法绕过
  - CTE-DML / `FOR UPDATE` 识别为写操作
  - Redis 命令白名单（只读模式放行读命令，`FLUSHALL/CONFIG/SHUTDOWN` 恒拒）
  - ES 端点白名单（只读模式放行读端点，`DELETE index` 恒拒）
- **代码扫描建连** `/db scan`：从 Spring 配置 / docker-compose / .env 自动抽取连接候选
- **P0 体验**：一键连接串（自动识别家族）、默认连接（`database` 参数可选）、`list_tables` pattern 过滤、超 50 行结果自动导出 CSV/JSON

## 📦 安装

```bash
pi install ./packages/db
```

> 依赖 `pg` / `mysql2` / `oracledb` / `dmdb` / `ioredis` / `@elastic/elasticsearch` / `es7` / `hive-driver` / `typebox`，`pi install` 自动安装。

## 🚀 快速开始

```bash
/db add          # 新增连接（一键粘贴连接串，或按家族逐步填写）
/db ls           # 列出所有连接
/db scan         # 扫描项目源码自动建连
/db config       # 查看/修改全局设置
```

AI 侧接入后，直接用 `query_database` / `list_tables` / `describe_table` / `scan_project_configs` 四个工具即可。

## 🗄️ 支持的数据库

| 数据库 | 家族 | 驱动 | 支持版本 | 备注 |
|--------|------|------|---------|------|
| PostgreSQL | 关系型 | `pg` | 9.6 ~ 17 全系 | `statement_timeout` 全版本可用 |
| MySQL | 关系型 | `mysql2` v3 | 5.7 / 8.0 / 8.4 | `max_execution_time` 需 ≥5.7.8，低版本自动忽略（客户端超时仍生效） |
| Oracle | 关系型 | `oracledb`（Thin，零依赖） | ≥12.1 | Thin 模式硬性要求 DB ≥12.1，11g 及以下不支持（会给出版本原因指引）；Thick 模式列入后续迭代 |
| 达梦 DM | 关系型 | `dmdb` | DM8 全系；DM9 未验证 | 纯 JS 依赖，macOS/Linux/Windows 可用 |
| Redis | KV | `ioredis` | 2.8 ~ 8.x | `SCAN` 需 ≥2.8；`MEMORY USAGE` 需 ≥4.0，低版本自动跳过；生产库一律 SCAN，禁 `KEYS` |
| Elasticsearch | 搜索 | `@elastic/elasticsearch` v8 + v7（npm 别名 `es7`） | 7.x / 8.x / 更新大版本 | 连接时探测大版本分发对应客户端；未知大版本用最新客户端尝试并给出版本警告 |
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
http://host:9200                        → Elasticsearch
jdbc:hive2://host:10000/db              → Hive / Spark
```

逐步填写按家族分支：Redis 无账号要求、需库号（dbIndex）；ES 账号/密码；其余 URL + 账号 + 密码。

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
- **硬限制**：DROP TABLE/DATABASE（关系型/大数据）、`FLUSHALL/FLUSHDB/CONFIG/SHUTDOWN`（Redis）、`DELETE <index>`（ES）
- **只读白名单**：Redis 读命令白名单、ES 读端点白名单
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

## 📄 许可

[MIT](./LICENSE)
