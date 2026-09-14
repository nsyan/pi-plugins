<div align="center">

# db

**AI 接入数据库插件 —— 方言化架构，原生 Node.js 实现**

[![npm](https://img.shields.io/npm/v/@nsyan/db?color=blue)](https://www.npmjs.com/package/@nsyan/db)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

</div>

为 [pi](https://github.com/earendilofficial/pi) 提供 10 种数据库的查询、表结构浏览、扫描建连与安全管控：AI 通过 5 个工具读写数据库，用户通过 `/db` 菜单管理连接。

## ✨ 特性

- **10 种数据库 · 6 家族**：PostgreSQL · MySQL · Oracle · 达梦 · Redis · Elasticsearch · MongoDB · Neo4j · Hive · Spark
- **AI 工具**：查询 / 表结构 / 连接清单 / 扫描建连，读多写少场景的 token 友好输出
- **扫描建连**：AI 驱动——工具返回项目文件树，会话 AI 自行定位并阅读配置文件（任意语言/格式），提取候选后弹框确认建连；防幻觉校验（url 必须能被方言解析）+ 来源可信度评级（远端证据 / 环境标识 / 跨环境冲突）提示“能连通 ≠ 属于当前环境”
- **安全模型**：只读模式、写确认 + 执行理由、连接级强制只读、家族白名单、管理命令恒拒
- **审计**（可选）：写操作按天落盘，含理由与完整 SQL
- **零构建**：TypeScript 由 pi/tsx 直接加载，core/dialects 零 pi 运行时依赖

## 📦 安装

```bash
pi install npm:@nsyan/db     # npm 安装（推荐）
pi install ./packages/db     # 本仓库开发者
```

## 🚀 快速开始

1. `/db add` 粘贴连接串一键建连（支持 `postgresql://` · `jdbc:*` · `redis://` · `mongodb+srv://` · `bolt://`/`neo4j://` · `http://host:9200`）
2. 直接让 AI 查询：*「查一下订单表最近 10 条」*
3. 扫描建连：在会话说「连一下这个项目的数据库」或「/db scan 配置pg」——AI 读取项目配置文件（任意语言）提取连接，会话内弹框确认后建连；被拒候选按原因修正重提

## 🗄️ 支持的数据库

| 数据库 | 家族 | 支持版本 |
|--------|------|---------|
| PostgreSQL | 关系型 | 9.6 ~ 17 |
| MySQL | 关系型 | 5.7 / 8.0 / 8.4 |
| Oracle | 关系型 | ≥12.1（Thin 零依赖） |
| 达梦 DM | 关系型 | DM8 全系；DM9 未验证 |
| Redis | KV | 2.8 ~ 8.x |
| Elasticsearch | 搜索 | 7.x / 8.x+（自动探测大版本） |
| MongoDB | 文档 | 已验证 6.0 / 7.0 / 8.0；4.2+ 可用 |
| Neo4j | 图 | 官方兼容矩阵 4.4 ~ 2025.x；已验证 4.4.29 community |
| Hive | 大数据 | 2.x / 3.x；4.x 未实测 |
| Spark（Thrift Server） | 大数据 | 2.x ~ 4.x |

> 版本采用**端点抽测**：只实测「最老支持版 + 最新版」，中间版本声明兼容。

## 🧾 sql 参数形态

`query_database` 的 `sql` 参数按家族填对应形态：

| 家族 | 形态 | 示例 |
|------|------|------|
| KV · Redis | 空格分隔命令 | `GET key` / `SCAN 0 MATCH user:*` |
| 搜索 · ES | JSON DSL | `{"query": {"match_all": {}}}` |
| 文档 · MongoDB | JSON 命令信封 | `{"find": "users", "filter": {}}` |
| 图 · Neo4j | Cypher | `MATCH (n:Person) RETURN n LIMIT 10` |

关系型直接填 SQL。各家族示例与实现要点 → [docs/USAGE.md](./docs/USAGE.md)。

## 🔐 安全模型

| 机制 | 行为 |
|------|------|
| AI 只读模式 | **默认开**；关闭后允许写 |
| 写确认 | 写操作弹框展示：理由 + 命令摘要 + SQL |
| 写执行理由 | AI 必须附 `reason`（动机+影响范围），缺失直接拒绝 |
| 连接级强制只读 | 标记的连接（如生产库）无视全局开关，永远只读 |
| 家族白名单 | Redis/ES/Mongo 只读白名单；`DROP`、管理 DDL、服务端 JS、`CALL dbms.*` 恒拒 |
| 审计日志 | 默认关；`/db config` 开启后写操作按天落盘（完整 SQL，0600） |
| 凭据 | 配置文件 `0600`；扫描场景密码经确认框补录（v1.3 起随 AI 阅读进会话，用户知情接受） |
| 扫描越界 | `path` 相对会话工作目录（`ctx.cwd`）解析，按**真实路径（realpath）**判定：`..` 上跳、绝对路径、仓库内指向子树外的软链（如 `dbconf -> /etc`）一律拒绝；`ctx.cwd` 缺失时 fail-closed，绝不回落到宿主进程目录 |

## ⚙️ 设置

`/db config` 修改，每轮注入系统提示：

| 设置项 | 默认值 |
|--------|--------|
| AI 只读模式 | 是 |
| 执行确认 | 写操作确认 |
| 最大行数 | 100 |
| 查询超时 | 30s |
| 审计日志 | 关 |

## 📚 详细文档

连接管理（三种建连路径 / 环境标签 / 自动回测）、扫描建连、各家族 sql 详解、审计配置 → **[docs/USAGE.md](./docs/USAGE.md)**
更新记录 → [CHANGELOG](../../CHANGELOG.md)

## 📁 开发

```bash
pnpm install && cd packages/db && pnpm test   # tsx + node:test，无构建产物
```

## 📄 许可

[MIT](./LICENSE)
