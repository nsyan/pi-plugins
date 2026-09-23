# 更新记录

本仓库遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.4] - 2026-09-23

### Added（packages/db）

- **确认弹窗 SQL 格式化 + 语法高亮 + 标签排版**：写操作确认框此前把 AI 生成的单行 SQL 原样贴出（如 `UPDATE users SET a=1,b=2 WHERE c=3`），而且 pi web 的 Markdown 会把单换行折叠成空格，长语句几乎不可读。现新增 `src/core/sql-format.ts` + `src/ui/sql-confirm.ts`（展示层纯函数，含单测）：
  - **格式化**（`formatSql`）：按子句换行（SELECT/FROM/WHERE/SET/VALUES/JOIN/…）、逗号拆列、`AND`/`OR`/`ON` 缩进、子查询收尾括号单独成行、多语句留空行，关键字统一大写；**长括号组**（`CREATE TABLE(...)` 列定义、长 `IN(...)` 列表）按显示宽度自动拆成块状列表（CJK 按 2 列计宽），短括号组（`count(*)`、`IN (1,2,3)`）保持内联；字符串字面量、注释与标识符原样保留
  - **语法高亮**：方言映射到高亮语言（关系型/大数据/图 → `sql`，MongoDB/Elasticsearch → `json`，Redis 无同类语法走代码块配色）
  - **标签排版**：确认框正文改为 Markdown——`> **📝 执行理由**：…`（引用块）+ `- **📋 影响摘要**：\`…\``、`- **🗄️ 数据库**：\`…\``（列表 + 行内代码）+ 带方言标记的 SQL 代码块；颜色靠主题对 引用/加粗/行内代码/代码块 的默认着色（Markdown 无法任意指定颜色，pi-web 的 rehype-sanitize 会剥内联样式）
  - **双端同源渲染**：TUI 走 `ctx.ui.custom` 自定义弹窗（pi-tui `Markdown` → `highlightCode`，Enter 执行 / Esc 取消）；**RPC/pi web 走同一份 Markdown**——已核对 pi-web 0.9.x 前端：确认弹窗正文用 react-markdown 渲染，代码围栏走 Prism（`react-syntax-highlighter`，已注册 `sql`/`json`），所以 **pi web 里同样高亮**，并自带语言标签、行号、复制按钮与正文原生滚动。`ctx.ui.confirm` 本身是 SelectList（纯文本、无法高亮），故 TUI 必须走 custom；UI 异常时回退 confirm（仍发同一份 Markdown），确认环节绝不被静默跳过
  - **围栏安全**：SQL 内含反引号时自动加长围栏（≥ 内容最长反引号串 + 1），避免撑破代码块
  - **红线**：美化只作用于「看到什么」，实际执行始终是原始 `params.sql`（美化失败时原样回退）
  - 已知边界：RPC 的 `confirm` 请求只有 `title`/`message`/`timeout`，**弹窗尺寸由 pi-web 写死**（560×760），插件层改不了；内容过长靠正文滚动。另：全局安装的旧版 pi-web 0.8.9 的确认弹窗不走 Markdown，不会高亮（建议固定 0.9.x）
  - 新增 `@earendil-works/pi-tui` peer 依赖（TUI 组件来源）；测试 160 → 187
- 版本号 1.3.4

## [1.3.3] - 2026-09-14

### Changed（packages/db）

- **发布元数据优化（可检索性/可发现性）**：description 精简至 npm 255 字符上限内——此前 348 字符被 npm 截断，尾部英文数据库清单（PostgreSQL/MySQL/…/Spark）整段丢失，npm 搜索与 pi.dev 目录站内搜索都命不中；现在十种数据库清单、pi coding agent、扫描建连等核心检索词完整保留在截断线内
- **keywords 补全检索词**：新增 pi / pi-coding-agent / agent / ai-agent / jdbc——pi.dev 目录的站内搜索串由包名+描述+作者+关键词拼接而成，npm 搜索同权重计入
- **发布包附 LICENSE**：packages/db 增加 LICENSE 并加入 files，发布 tarball 此前无许可证文本（仅 license: MIT 字段）
- **补 engines.node >= 18**：与仓库根一致，不兼容环境安装时 npm 能提前告警
- 版本号 1.3.3

## [1.3.2] - 2026-09-14

### Fixed（packages/db）

- **扫描越界红线可用仓库内软链绕过**：`resolveRoot` 曾只比对「扫描根的 realpath 与其子项」，扫描根本身是软链时自我授权——`dbconf -> /etc` 配合 `path="dbconf"` 会把子树外目录整棵树列给模型（实测返回 `secret-application.yml`、`deep/.env`）。现加第二道闸：`anchor` 与目标都取 realpath 再比对真实子树（字面路径合法 ≠ 真实位置合法），项目本身位于软链路径下（如 macOS `/tmp → /private/tmp`）仍正常放行
- **文件树随文件系统而变（同一项目不同结果）**：`walk` 曾用全局 realpath 去重目录，真目录与软链别名按 readdir 顺序互相吞掉（APFS 插入序 / ext4 哈希序不同），回归用例因此是顺序相关的假通过。现改为「祖先链 realpath 断环 + 目录项排序」：别名与真目录两条路径都保留，同一目录重复扫描输出一致
- **`depthCapped` 误报**：置位发生在 realpath/断环检查之前，超深处的软链别名（或空目录）也会报「文件树可能不完整」；现移到检查之后，并同时覆盖目录访问预算（新增 `MAX_DIRS`）
- **`ctx.cwd` 缺失时静默回落 `process.cwd()`（fail-open）**：等于把红线重新钉在宿主进程目录上，正是本版修掉的错锚点。`scan_project_configs` 现 fail-closed 并说明原因；审计的 `project` 字段回落值改为 `(会话目录未知)`，不再记录错误项目
- **扫描建连在 pi-web/RPC 下锚错目录（红线失效，双向）**：`resolveRoot` 用 `process.cwd()` 当信任锚，而扩展与 pi 同进程——pi-web 下宿主 cwd 是 `@agegr/pi-web` 包目录、TUI 下是 pi 启动目录，都与会话 cwd（存在 session header，`/resume` 后可变）不同源。后果三态：传绝对路径 → 项目路径全被判越界（`scan path out of scope`）；传 `path="."` → **静默扫描宿主 cwd（pi-web 包目录）并把它的文件树当项目返回给模型**；宿主 cwd 恰为用户目录时 → 反而放行不相干的目录树。现 `resolveRoot(input, anchor)` / `collectTree(rootInput, anchor)` 显式接收锚点，`scan_project_configs` 取 `ctx.cwd`（此前连 `ctx` 形参都没接）
- **越界报错不可诊断**：`scan path out of scope: X` 不含允许根目录，调用方（模型）无法自我纠正；现补 `（允许根目录: Y）`
- **`..` 前缀假阳性误杀**：`rel.startsWith("..")` 会把会话目录内合法的 `..foo/`、`..hidden` 判为越界；改为 `rel === ".." || rel.startsWith(".." + sep)`
- **写操作审计记错项目**：`project` 字段取 `process.cwd()`，与扫描同一个错误锚点，跨项目区分失真；改用 `ctx.cwd`

### Added（packages/db）

- **候选「来源可信度」评级**（新增 `src/core/scan/trust.ts`，确定性规则 + 单测）：`db_scan_save` 原先唯一的客观闸门是 `testConnection`，而「能连通」只证明库存在、凭据有效，**不证明它属于当前环境**——同仓库并存 dev/test/devops/prod/dm 多套配置 + 签入的配置中心副本会漂移，模型很容易提取到废弃库名或别的环境地址，而且照样能测通。现按 `source` 评级并在确认框/候选清单/工具返回里显式展示：🟢 source 含**远端检索证据**（URL / `dataId=` / 显式「远端」）/ 🟡 本地文件带环境标识（附「请核对生效 profile，Maven `@xxx@` 占位符真值在 `pom.xml` 的 `<profile><properties>` 里」）或**仅自述配置中心产品名**（仓库里签入的副本会命中产品名，恰恰是会漂移的那个，不再升级为可信）/ 🔴 无环境标识或本批次跨多个环境（含环境冲突清单）；检出 prod/release 时附「保存后建议标记 prod 启用强制只读」。评级不改变 `status`、不拒绝候选——把环境判断交回用户。**边界已在模块注释与文档中明说**：输入是模型自述的 `source` 文本而非独立取证，它只提高「误连环境」的被发现概率，闸门仍是 `testConnection` + 用户确认

### Changed（packages/db）

- **walk() 三处静默行为改为「不猜、如实上报」**：① 不再跳过 `.` 开头的目录——`.config/db.yml` 这类配置此前永远扫不到，改为靠 `IGNORED_DIRS` 排噪（并把 `docs` 从忽略表移出：本模块不对「目录名是否与配置有关」做猜测，漏扫代价大于多扫）；② 软链不再静默忽略：目标 realpath 在 root 子树内则按真实类型跟随（子树外的忽略——扫描不能成为越界的第二个入口），断环用「祖先链 realpath」（别名与真目录两条路径都保留；全局去重会按 readdir 顺序吞掉一个），目录项排序保证输出确定，软链文件名与目标名任一像配置即归入配置段；③ `MAX_DEPTH` 8 → 16（实测本类工程可达 14 层：`.../service/mapper/impl`），超限通过新增的 `TreeResult.depthCapped` 如实上报（工具输出附“可把更深的子目录作为 path 再扫”，层数取同一个常量、不再硬编码；该标志同时覆盖目录预算 `MAX_DIRS`），不再静默漏扫

- **扫描流程约束从返回文本搬到系统提示**：原先「配置指向配置中心（nacos/apollo）时必须拉远端、远端优先」只写在 `scan_project_configs` 的**成功返回文本**里——工具一失败（catch 只回一行 `扫描失败: …`）整条指引就消失，`description`/`promptSnippet` 也从未提及。现改由 `promptGuidelines` 承载：①先定位生效 profile（Maven `@xxx@` 占位符真值在 `pom.xml` 的 `<profile><properties>`）②配置中心以远端为准（仓库里签入的副本常已过期）③`source` 写清「生效 profile + 来源文件/dataId」④来源可疑先问用户，不直接提交
- `docs/USAGE.md`：补充「能连通 ≠ 属于当前环境」提示、生效 profile / 配置中心优先级（本地与远端冲突时以远端为准）、来源可信度新规则，以及越界按**真实路径**判定（仓库内指向子树外的软链同样拒绝）；`README.md` 安全模型表补「扫描越界」行
- `db_scan_save` 结果行回传 trust 理由（此前只回 🟢/🟡/🔴 而 promptGuidelines 又要求模型「如实转述理由」，模型看不到就无从转述）；`SCAN_TRIGGER_HINT` 的「当前工作目录」统一为「会话工作目录（ctx.cwd）」
- `test/scan-ai.test.ts`：新增锚点 ≠ `process.cwd()`（pi-web 场景）、`..` 前缀回归、软链扫描根逃逸、readdir 顺序无关、软链文件名按目标名识别、不存在路径诊断用例；软链用例改为断言真目录与别名都在清单内（去掉顺序相关的假通过）。测试 155 → 160

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
