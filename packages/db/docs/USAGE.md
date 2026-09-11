# db 使用手册

主 README 是能力速览；本页承接全部使用细节。遇到本文未覆盖的行为，以 `src/` 代码与测试为准。

## 🔗 连接管理

### 新增连接（/db add）

首问三选一：

1. **⚡ 粘贴连接串（一键）**——自动识别家族：

   ```
   postgresql://user:pass@host:5432/db     → PostgreSQL
   jdbc:mysql://host:3306/db               → MySQL
   jdbc:oracle:thin:@//host:1521/svc       → Oracle（也支持 SID 形式）
   jdbc:dm://host:5236/schema              → 达梦
   redis://:pass@host:6379/0               → Redis（含 rediss:// TLS）
   mongodb://user:pass@host:27017/db       → MongoDB（含 +srv Atlas 形态）
   bolt://user:pass@host:7687/db           → Neo4j（也认 neo4j://、bolt+s(ssc)://、neo4j+s(ssc)://）
   http://host:9200                        → Elasticsearch
   jdbc:hive2://host:10000/db              → Hive / Spark
   ```

2. **📝 逐步填写**——按家族分支：Redis 无账号要求、需库号（dbIndex）；MongoDB 账号可空（本地无认证常见）；ES/其余 URL + 账号 + 密码。

3. **📋 从现有复制**——复制现有连接的全部设置（类型/账号/options/环境标签），仅需改名，可选立即编辑。

所有路径在测试连接通过后，会追问「环境标签」（dev/test/prod，可跳过）；选 prod 时主动建议开启**强制只读**。

### 编辑与测试

- `/db edit` 编辑器支持修改名称/URL/账号/密码/环境标签/强制只读/说明
- **保存后自动回测**连接，结果即时回显并记录
- 连接动作菜单含独立「🧪 测试连接」，结果（版本/延迟）写入连接摘要

### 状态摘要与默认连接

- 所有连接选择器展示：`名称 [类型] ⭐默认 [prod·强制只读] · 上次使用 2 天前 · 测试 ✓45ms`
- 最近使用时间与测试结果自动回写，无需手工维护
- 一级菜单「⚡ 切换默认」选中即切；AI 调用工具时 `database` 参数可省略，缺省走默认连接

### 环境标签与强制只读

- 连接可标 `dev / test / prod`，列表与 AI 系统提示均可见
- `强制只读` 的连接**无视全局只读开关**，永远只接受查询；AI 侧写入会被拒并提示原因
- 典型用法：全局允许写（开发库随便改），生产库连接强制只读

## 🔎 扫描建连（/db scan）

从项目源码自动抽取连接信息（Spring `application*.yml/properties`、`docker-compose.yml`、`.env`、通用 URL 正则）：

```bash
/db scan            # 扫描当前工作目录
/db scan ./backend  # 扫描指定子目录（越界拒绝）
```

- 结果状态：✅ 可直接建 / ✏️ 待补字段 / 🔒 jasypt 加密（只标注不建）/ ⏭️ 同名已存在
- **绝不静默建连、绝不静默覆盖**：逐个确认后才写入；占位符 `${KEY:default}` 取 default，`${KEY}` 依次查同目录 `.env` → 进程环境变量
- AI 侧说「连一下这个项目的数据库」会调用 `scan_project_configs` 展示**掩码后**候选，建连仍需终端确认

## 🧾 各家族 sql 形态详解

### Redis（KV）

`sql` 填空格分隔的命令，整体视为一条：

```
GET mykey
SCAN 0 MATCH user:* COUNT 100      # 生产库一律 SCAN，禁 KEYS
HGETALL myhash
```

只读白名单：GET/HGETALL/LRANGE/ZRANGE/SCAN/INFO 等；`FLUSHALL/FLUSHDB/CONFIG/SHUTDOWN` 恒拒。`describe_table` 对 key 返回类型/长度/TTL/内存/编码/值预览。

### Elasticsearch（搜索）

`sql` 填 JSON DSL（端点信封）：

```json
{"query": {"match_all": {}}}
{"count": {"query": {"match": {"status": "paid"}}}}
```

顶层 key 决定端点：`query/count/mget` → 读；`bulk/delete/update` → 写；未知 key 保守按写。`DELETE <index>` 字符串恒拒。

### MongoDB（文档）

`sql` 填 JSON 命令信封（`db.runCommand` 文档形态，单命令一次执行）：

```json
{"find": "users", "filter": {"age": {"$gt": 18}}, "sort": {"created_at": -1}}
{"count": "users"}
{"aggregate": "orders", "pipeline": [{"$group": {"_id": "$status", "n": {"$sum": 1}}}]}
{"insert": "users", "documents": [{"name": "x"}]}
```

实现要点：

- **limit 注入**：未写 limit 的读命令自动补 `maxRows`（aggregate 自动追加 `$limit` 阶段），超限标 `truncated`
- **结果拍平**：返回文档拍平为列——顶层字段并集，封顶 50 列，嵌套转 JSON 字符串；`_id` 取 hex
- **list_tables** → `listCollections`；**describe_table** → `collStats` + 索引 + `$jsonSchema` validator（缺失时采样 ≤100 文档推断字段，非权威 schema）
- **硬限制**：`drop*`/`create*` 等管理 DDL、服务端 JS（`$where`/`$function`/`$accumulator`）恒拒；aggregate 含 `$out`/`$merge` 按写分类；未知命令保守按写
- 连接串：`mongodb://` 与 `mongodb+srv://`（SRV 默认 TLS）；`authSource` 缺省 `admin`，`replicaSet`/`authMechanism` 等经 options 贯通

### Neo4j（图）

`sql` 填 Cypher 原文，支持分号分隔多语句（逐条执行，返回最后一条结果）：

```cypher
MATCH (n:Person) RETURN n LIMIT 10
MATCH (n:Person)-[r:KNOWS]->(m) WHERE n.age > 18 RETURN n, r, m
CALL db.labels() YIELD label RETURN label
SHOW INDEXES
```

实现要点：

- **图结构即表**：`list_tables` 返回 node label（NODE LABEL）与关系类型（RELATIONSHIP，`rel:` 前缀）；`describe_table` 目标填 label 名或 `rel:类型`
- **describe_table**：实体计数 + `SHOW INDEXES/CONSTRAINTS`（过滤目标）+ 采样 ≤100 推断属性键与类型分布（非权威 schema）；唯一约束属性标主键；只依赖核心过程，**不依赖 APOC**
- **读写管控**：CREATE/MERGE/DELETE/DETACH/SET/REMOVE/DROP/FOREACH/LOAD CSV 任意深度出现即按写（`MATCH (n) DETACH DELETE n` 这类读外壳夹写拦得住）；字符串字面量与注释内的写词不误判；`CALL dbms.*` 管理过程**恒拒**；未知 CALL 过程（含 apoc.*）保守按写
- **结果拍平**：Node 渲染为 `:Label {属性}`，Relationship 为 `-(TYPE)-> {属性}`，Path 为 `<path:n>`；无返回记录的写语句回显变更计数（创建节点 n，设置属性 m）
- **limit 封顶**：客户端截断对齐关系型方言（不做 Cypher LIMIT 注入，任意语句尾部加 LIMIT 不总合法）
- **连接串**：`bolt://`/`neo4j://`/`bolt+s://`/`neo4j+s://` 等；建连统一走 Bolt 直连（`bolt://`/`bolt+s://`）——单机社区版无路由服务，`neo4j://` 路由 scheme 会报 No routing servers available；URL 路径段 = 图数据库名（缺省 `neo4j`）
- **扫描建连**：Spring `spring.neo4j.uri`（Boot 3）/ `spring.data.neo4j.uri`（Boot 2）+ authentication 账号密码键、`.env` `NEO4J_URI`/`NEO4J_URL`/`BOLT_URL`、docker-compose `neo4j` 镜像（`NEO4J_AUTH`/`NEO4J_PASSWORD`）、通用 URL 正则

## ✍️ 写操作：理由与审计

- AI 发起写操作必须附 `reason` 参数（动机 + 影响范围，如 *"将 status=2 的历史订单归档，预计影响 1.2 万行"*）
- 确认框**首行展示理由**，执行结果末尾回显；缺失时拒绝并引导补充（与确认策略无关）
- 开启审计（`/db config → 审计日志`）后，写成功追加 `~/.pi/agent/db-audit/<YYYY-MM-DD>.jsonl`：
  - 一天一个文件；字段含时间/项目路径/连接/摘要/理由/**完整 SQL 不截断**
  - 文件 `0600`；审计失败静默降级，不阻断主流程
  - 清理示例：`find ~/.pi/agent/db-audit -name "*.jsonl" -mtime +90 -delete`

## 💾 查询结果导出

结果超过 50 行时自动导出 `/tmp`（CSV + JSON 双格式），只回文件路径；达到 `max_rows` 截断时有明确标注。
