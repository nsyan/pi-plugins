<div align="center">

# @nsyan/db

**让 AI 安全地读写数据库 —— 十种数据库，一套工具**

查询 · 表结构 · 扫描建连 · 只读管控 · 写审计

[![npm version](https://img.shields.io/npm/v/@nsyan/db?color=cb3837&logo=npm)](https://www.npmjs.com/package/@nsyan/db)
[![npm downloads](https://img.shields.io/npm/dm/@nsyan/db?color=blue)](https://www.npmjs.com/package/@nsyan/db)
[![Node.js](https://img.shields.io/node/v/@nsyan/db?color=339933&logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

[安装](#-安装) · [快速开始](#-快速开始) · [工具清单](#-工具清单) · [支持的数据库](#-支持的数据库) · [安全模型](#-安全模型) · [故障排查](#-故障排查)

</div>

---

[pi](https://github.com/earendilofficial/pi) 的数据库接入扩展。AI 通过 6 个工具查询、浏览结构、扫描建连；用户通过 `/db` 菜单管理连接。方言化架构，原生 Node.js 驱动，零构建产物。

```text
你：查一下订单表最近 10 条，只要金额大于 100 的
AI：describe_table { table: "orders" }        └─ 先看列名类型
    query_database { sql: "SELECT ... LIMIT 10" }  └─ 读语句，直接执行 ──► 返回结果

你：把 status=2 的历史订单归档
AI：query_database { sql: "UPDATE ...", reason: "将 status=2 的历史订单归档，预计影响 1.2 万行" }
    └─ 写语句：reason 必填 → 确认框（理由 + 影响摘要 + 高亮 SQL）──► 执行并落审计
```

## ✨ 特性

- **10 种数据库 · 6 家族**：PostgreSQL · MySQL · Oracle · 达梦 · Redis · Elasticsearch · MongoDB · Neo4j · Hive · Spark，各自原生驱动、统一工具面
- **读白名单判定**：只有 `SELECT` / `WITH…SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN <SELECT>` / `VALUES` / `TABLE` 算读，白名单之外一律按写——不再靠「写关键字黑名单」猜
- **写操作双重门槛**：`reason`（动机 + 影响范围）缺失直接拒绝；确认框展示理由、影响摘要与按方言高亮的 SQL
- **扫描建连**：工具返回项目文件树，会话 AI 自行定位并阅读配置文件（任意语言/格式），提取候选后弹框确认；含防幻觉校验与来源可信度评级
- **可追溯**：写操作按天落审计（含完整 SQL 与理由）；生产连接与强制只读连接**先写审计再执行**，写盘失败则拒绝执行
- **零构建**：TypeScript 由 pi / tsx 直接加载，`src/core`、`src/dialects` 不 import 任何 pi 运行时模块

## 📦 安装

```bash
# 从 npm 安装（推荐）
pi install npm:@nsyan/db

# 本仓库开发者
pi install ./packages/db
```

装好后 `/db` 命令与 6 个数据库工具即可用。安装异常见 [故障排查](#-故障排查)。

## 🚀 快速开始

**1. 建连**（三选一）

```bash
/db add     # 粘贴连接串一键建连，或逐步填写，或从现有复制
```

```text
你：连一下这个项目的数据库
AI：scan_project_configs → 读项目配置文件提取候选 → db_scan_save 逐条确认建连
```

**2. 直接用**

```text
这个库有哪些表                     → list_tables
orders 表结构是什么                → describe_table
查一下订单表最近 10 条             → query_database
把 status=2 的历史订单归档          → query_database（写，需 reason + 确认）
```

**3. 连接多了之后**

AI 调工具时 `database` 参数省略即走默认连接；系统提示里会注入可用连接清单，多库场景下 AI 会显式指定。

```bash
/db ls      # 列出全部连接（含类型 / 环境标签 / 上次使用 / 测试结果）
```

## 🧰 工具清单

| 工具 | 作用 | 关键约束 |
|------|------|---------|
| `query_database` | 执行语句，返回结果 | 写操作必须带 `reason`；受只读模式、确认级别、连接级强制只读三重管控 |
| `list_tables` | 列出表（schema / 表名 / 类型 / 注释） | 支持 `pattern` 过滤（`user%` / `order_*`），表多时必用 |
| `describe_table` | 列定义、类型、默认值、主键 | 可带 schema，如 `public.users` |
| `scan_project_configs` | 返回项目文件树，供 AI 自行定位配置文件 | `path` 限定在会话工作目录子树内，按 **realpath** 判定越界 |
| `db_scan_save` | 提交候选，逐条确认后建连 | url 必须能被方言解析（防幻觉）；同名三选一 |
| `db_connections` | 列出已配置连接（不含密码） | 用于确认可用连接、识别生产库 |

## ⌨️ `/db` 命令

```bash
/db            # 无参数 = 打开管理菜单
/db ls         # 列出全部连接
/db add        # 新增连接（连接串 / 逐步填写 / 从现有复制）
/db edit       # 编辑连接（保存后自动回测）
/db rm         # 删除连接（确认）
/db scan       # 引导语：扫描建连由会话 AI 驱动
/db config     # 插件设置（只读模式 / 确认级别 / 行数 / 超时 / 审计）
```

<details>
<summary><b>管理菜单结构</b>（<code>/db</code> 无参数）</summary>

```text
数据库管理
├─ 📋 打开连接 → 选连接 → 执行查询 / 列出表 / 查看详情 / 测试连接 / 设为默认 / 编辑 / 删除
├─ ⚡ 切换默认（两层直达，选完即切）
├─ ✏️ 编辑连接
├─ ➕ 新增连接（连接串 / 逐步填写 / 从现有复制）
├─ 🔎 扫描建连（引导语，实际由会话 AI 走 scan_project_configs → db_scan_save）
├─ 🗑️ 删除连接
└─ ⚙️ 设置
```

连接选择器统一展示：`名称 [类型] ⭐默认 [prod·强制只读] · 上次使用 2 天前 · 测试 ✓45ms`。

</details>

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
| 关系型 · 大数据 | SQL | `SELECT * FROM users LIMIT 10` |
| KV · Redis | 空格分隔命令 | `GET key` / `SCAN 0 MATCH user:*` |
| 搜索 · ES | JSON DSL | `{"query": {"match_all": {}}}` |
| 文档 · MongoDB | JSON 命令信封 | `{"find": "users", "filter": {}}` |
| 图 · Neo4j | Cypher | `MATCH (n:Person) RETURN n LIMIT 10` |

各家族完整示例、聚合与分页行为 → [docs/USAGE.md](./docs/USAGE.md#-各家族-sql-形态详解)。

## 🔎 扫描建连

v1.3.0 起重构为**会话 AI 驱动**：终端不做正则提取，文件发现与配置提取全部交给会话模型。

```text
scan_project_configs   → 返回项目文件树（语言无关：Java/Py/Go/TS/Rust…）
   ↓ 会话 AI 自行判断哪些文件含连接配置，用自带读文件工具阅读
db_scan_save           → 提交候选，逐条弹框（确认 → 补录缺字段 → 测试连接通过才写盘）
```

**防幻觉校验**：`dialectId` 必须在注册表内；带 `url` 的候选必须能被该方言 `parseUrl` 解析，claim 与 url 矛盾则整条拒绝（解析成功后以 URL 为准）。

**来源可信度评级**：`db_scan_save` 按候选的 `source` 给评级，并展示理由——

| 评级 | 含义 |
|------|------|
| 🟢 | source 含**远端检索证据**（URL / `dataId=` / 显式「远端」） |
| 🟡 | 本地文件带环境标识，或仅自述配置中心产品名 |
| 🔴 | 无环境标识，或本批次跨多个环境（附环境冲突清单） |

> **能连通 ≠ 属于当前环境**。同仓库常并存 dev/test/devops/prod 多套配置，签入的配置中心副本还会漂移——测试连接只证明库存在、凭据有效，不证明它属于当前环境。评级不改变候选状态、也不拒绝候选，只是把环境判断交回给你。
>
> 配置指向 Nacos / Apollo / Spring Cloud Config 时以**远端为准**（仓库里的副本常已过期）；Spring 项目先定位生效 profile（Maven `@xxx@` 占位符真值在 `pom.xml` 的 `<profile><properties>` 里）。细节 → [docs/USAGE.md](./docs/USAGE.md#-扫描建连会话-ai-驱动v130-重构)。

## ⚙️ 设置

`/db config` 修改，每轮注入系统提示：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| AI 只读模式 | 开 | 关闭后允许写；判定为读白名单 |
| 执行确认 | 写操作确认 | `never` / `write` / `always` |
| 最大行数 | 100 | 达到上限时标注截断并导出全文 |
| 查询超时 | 30s | 关系型驱动均设连接超时，内网丢包不会挂死 |
| 审计日志 | 关 | 生产连接与强制只读连接**恒写**，不受此开关影响 |

## 📁 本地文件

| 文件 | 内容 | 权限 |
|------|------|------|
| `~/.pi/agent/db-configs.json` | 连接配置（含密码） | 0600，原子写（tmp → chmod → rename） |
| `~/.pi/agent/db-config.json` | 插件设置 | 0600，原子写 |
| `~/.pi/agent/db-audit/<YYYY-MM-DD>.jsonl` | 写审计，按天一个文件，SQL 存完整原文 | 0600 |
| `<tmpdir>/db-query-<连接>-<时间>.csv` / `.json` | 查询结果导出（>50 行或截断时） | 0600 |

- 配置文件损坏时**写盘路径抛错**，而不是当成空列表——避免保存一次丢光全部连接
- 内容未变则跳过写入；`recordLastUsed` 节流 60 秒，避免高频查询下的写放大
- 导出文件可能含身份证号、手机号等敏感字段，因此与配置文件同级处理

## 🛡️ 安全模型

| 机制 | 行为 |
|------|------|
| AI 只读模式 | **默认开**；判定为**读白名单**：只有 `SELECT` / `WITH…SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN <SELECT>` / `VALUES` / `TABLE` 算读，白名单之外一律按写 |
| 读语句副作用 | `SELECT … INTO OUTFILE` / `INTO <表>`、`FOR UPDATE` / `LOCK IN SHARE MODE`、`EXPLAIN ANALYZE <DML>`、`nextval()` / `setval()` / `pg_read_file()` / `dblink_exec()` 等一律按写 |
| 写确认 | 弹框展示：理由 + 影响摘要 + 数据库 + SQL（自动格式化 + 按方言语法高亮） |
| 写执行理由 | AI 必须附 `reason`（动机 + 影响范围），缺失直接拒绝 |
| 高风险写 | DDL / 授权 / 会话设置 / 写文件 / 副作用函数即使确认策略设为「不确认」**也会弹框**；`EXPLAIN ANALYZE` 单列其中 |
| 连接级强制只读 | 标记的连接（如生产库）无视全局开关，永远只读 |
| 硬限制 | `DROP TABLE/DATABASE/SCHEMA` 恒拒；Redis `FLUSHALL`/`CONFIG`/`SHUTDOWN` 恒拒；ES `DELETE <index>` 与写端点恒拒；Mongo 管理 DDL 与服务端 JS 恒拒；Neo4j `CALL dbms.*` 恒拒 |
| 审计日志 | 默认关；`/db config` 开启后写操作按天落盘。**生产连接（`envTag=prod`）与强制只读连接恒写，且写盘失败则拒绝执行** |
| 凭据 | 配置文件 `0600` 原子写；损坏时抛错而非静默清空；导出结果同 `0600` |
| 扫描越界 | `path` 相对会话工作目录（`ctx.cwd`）解析，按**真实路径（realpath）**判定：`..` 上跳、绝对路径、仓库内指向子树外的软链（如 `dbconf -> /etc`）一律拒绝；`ctx.cwd` 缺失时 fail-closed，绝不回落到宿主进程目录 |

## 🐛 故障排查

<details>
<summary><b>扩展完全没加载，<code>/db</code> 和所有工具都不见了</b></summary>

最可能的原因是 Hive / Spark 依赖链缺 `ws`。链路：`hive-driver → thrift → isomorphic-ws`，其中 `isomorphic-ws` 把 `ws` 声明为 **peerDependencies**；npm 扁平安装时 `ws` 可能只嵌套在 `thrift/node_modules` 而未提升到安装根，`require('ws')` 直接 `Cannot find module 'ws'`。

因为 `index.ts` 顶层静态 import 全部方言，一条链炸掉整个扩展——而 pi 只静默记一行 `Failed to load extension`，插件页仍显示「已加载」，极具迷惑性。

`@nsyan/db@1.3.5+` 已在 `dependencies` 显式声明 `ws` 并加回归测试。若仍遇到：

```bash
ls ~/.pi/agent/npm/node_modules/ws          # 应当存在
pi update npm:@nsyan/db                     # 升级到 1.3.5+
```

</details>

<details>
<summary><b>只读模式拦住了本该放行的语句</b></summary>

这是**设计如此**。v1.3.7 起判定改为读白名单：只有 `SELECT` / `WITH…SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN <SELECT>` / `VALUES` / `TABLE` / `HELP` 算读，其余一律按写。所以 `COPY`、`GRANT`、`SET`、`VACUUM`、`DO $$…$$`、`USE`、`BEGIN` 都会被拦。

需要执行就显式关掉只读（`/db config`），并承担相应确认。

</details>

<details>
<summary><b><code>EXPLAIN ANALYZE</code> 为什么也要确认</b></summary>

因为 `EXPLAIN ANALYZE DELETE/UPDATE` **会真正执行**被分析的语句。它属于高风险写，即使确认策略设为「不确认」也会弹框（v1.3.8 修复：此前在 `never` 策略下会被直接执行）。

`EXPLAIN <SELECT>` 不受影响，仍按读处理。

</details>

<details>
<summary><b>连接内网库时一直卡在「正在执行查询…」</b></summary>

v1.3.7 起 pg / mysql / 达梦驱动都设了连接超时，不会再挂到 TCP 默认超时。若仍然挂住，先用 `/db edit` 里的「🧪 测试连接」定位是网络不通、端口被防火墙丢包，还是认证失败。

</details>

<details>
<summary><b>配置文件损坏后所有连接都不见了</b></summary>

不会自动清空。`loadConfigsStrict()` 在 JSON 解析失败时**抛错**而不是返回空数组，写盘路径也会拒绝覆盖——防止「读成空 → 随手保存一次 → 明文密码全丢」。

恢复方式：手工修 `~/.pi/agent/db-configs.json` 的 JSON 语法（通常只是末尾被截断），或从备份/版本控制取回。

</details>

<details>
<summary><b>扫描建连报 <code>scan path out of scope</code></b></summary>

报错里会附「允许根目录」。扫描根是**会话工作目录**（`ctx.cwd`），按 realpath 判定，所以：

- 绝对路径、`..` 上跳一律拒绝
- 仓库内指向子树外的软链（如 `dbconf -> /etc`）同样拒绝——字面路径合法 ≠ 真实位置合法
- `ctx.cwd` 缺失时 fail-closed，不会回落到 pi 进程的启动目录

想扫更深的目录，把它作为 `path` 再扫一次。

</details>

## 🔧 开发

```bash
pnpm install
pnpm --filter @nsyan/db test         # tsx --test + node:test，238 项
pnpm --filter @nsyan/db typecheck    # tsc，0 error
```

无构建产物：TypeScript 由 pi / tsx 直接加载。新增方言请保持 `src/core`、`src/dialects` 零 pi 运行时依赖，并补齐类型标签（`Record<DbTypeId, …>` 会在编译期拦住漏补）。

真机验证脚本：

```bash
npx tsx scripts/e2e-live.mts    # 真实连接：测试连接 / 列表 / 结构 / 查询 / 只读拦截
npx tsx scripts/e2e-tools.mts   # mock 宿主装载扩展：工具层拦截 / 理由校验 / 审计顺序
npx tsx scripts/e2e-write.mts   # 临时 schema 内跑完整 DDL+DML 并清理
```

### 文档

| 文档 | 内容 |
|------|------|
| [docs/USAGE.md](./docs/USAGE.md) | 连接管理、扫描建连、各家族 sql 详解、写操作与审计、结果导出 |
| [CHANGELOG](../../CHANGELOG.md) | 版本变更记录 |

## 🤝 贡献

欢迎 issue 与 PR。提交前请确保 `pnpm --filter @nsyan/db test` 与 `typecheck` 全绿；涉及策略判定的改动请同时补回归用例（历史上多条 P0 都出在「可写 + never 策略」这类组合路径上）。

## 📄 许可

[MIT](../../LICENSE)
