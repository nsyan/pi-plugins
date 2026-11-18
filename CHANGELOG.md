# 更新记录

本仓库遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [db 1.3.8] - 2026-11-19

### Fixed（packages/db）—— 真机测试抓到的 P0

- **`EXPLAIN ANALYZE <DML>` 在 `confirm_before_exec=never` 下会被直接执行**：`EXPLAIN` 属于读白名单首关键字，`isHighRiskStatement` 于是走了「读语句副作用」分支，而该分支没有 `EXPLAIN ANALYZE` 规则 → `highRisk=false` → never 策略直执行。**`EXPLAIN ANALYZE DELETE/UPDATE` 会真正执行删除与更新**。只读模式（`isAllowed` 内的 `isWriteStatement`）拦得住，所以纯单测没暴露；必须断言「可写 + never」这条路径才能复现。现已把 `EXPLAIN` 单列进高风险判定
- **测试**：`sql-write-detection.test.ts` 新增「EXPLAIN ANALYZE：可写模式下也不得直执行」三组用例（含 `EXPLAIN (ANALYZE, BUFFERS)` 变体、`EXPLAIN <SELECT>` 不误伤、普通 DML 豁免未被误扩大），测试 235 → 238

## [db 1.3.7] - 2026-11-19

### Security（packages/db）—— 只读模式真的拦得住写

- **读写判定从「写黑名单」改为「读白名单」**（`src/core/sql-text.ts`）：此前只认 15 个写关键字，实测 `COPY … FROM` / `COPY … TO PROGRAM` / `GRANT` / `REVOKE` / `SET`（含解除只读）/ `RESET` / `VACUUM` / `ANALYZE` / `DO $$…$$` / `SELECT … INTO OUTFILE` / `EXPLAIN ANALYZE <DML>` / `ATTACH DATABASE` / `COMMENT ON` / `USE` / `BEGIN` 等**全部被判成读**——`ai_readonly=true` 时直接执行、`confirm_before_exec=write` 时连确认框都不弹。现在只有 `SELECT`/`WITH…SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN <SELECT>`/`VALUES`/`TABLE`/`HELP` 算读，白名单之外一律按写（与 MongoDB、Neo4j 家族早已采用的白名单姿态对齐）
- **读语句的副作用单独收口**：`SELECT … INTO OUTFILE`/`INTO <表>`、`FOR UPDATE`/`FOR SHARE`/`LOCK IN SHARE MODE`、`EXPLAIN ANALYZE <DML>`，以及 `nextval()/setval()/pg_read_file()/lo_import()/dblink_exec()/pg_terminate_backend()` 这类带服务端副作用的函数一律按写
- **高风险写不吃「不确认」豁免**：新增 `Verdict.highRisk`，DDL / 授权 / 会话设置 / 写文件 / 副作用函数在 `confirm_before_exec=never` 下**仍会弹确认框**（普通 DML 仍按 `never` 直执行）。MongoDB 侧只有 `insert/update/delete/findAndModify/bulkWrite` 算普通写，索引/用户/权限/重命名/未知命令均按高风险；Neo4j 侧 `CREATE/DROP/MERGE/DETACH/FOREACH/TERMINATE/LOAD CSV` 按高风险
- **拒绝理由带判定依据**：只读拦截不再是裸的「非查询语句」，而是「（写语句 GRANT）」/「（EXPLAIN ANALYZE 会真正执行被分析的语句）」/「（查询语句带有写副作用…）」
- **文档口径与实现对齐**：「DROP TABLE 始终禁止」改为「DROP TABLE/DATABASE/SCHEMA 恒拒；其余 DDL/授权/会话设置属高风险写，`never` 策略也确认」（系统提示、工具 description、USAGE.md 三处同步）

### Fixed（packages/db）

- **写审计改为生产连接 fail-closed**：`appendAuditLog` 现在返回是否真的落盘；`envTag=prod` 与强制只读连接的写操作**先写审计再执行**，写盘失败则拒绝执行（此前审计失败静默降级，「可追溯」只是配置项）。普通连接仍按 `audit_enabled` 开关，失败不阻断主流程
- **`/db` 菜单的「执行查询」补上审计**：此前菜单路径改数据完全无记录，现在与工具路径共用同一份审计入口
- **配置落盘改原子写**：`saveConfigs` 走 tmp → chmod 0600 → rename，内容未变则跳过（此前直接 `writeFileSync`，写一半崩溃就留下截断 JSON）；新增 `loadConfigsStrict()`，文件损坏时**抛错而非返回空数组**——否则用户随手保存一次就把全部连接（含明文密码）覆盖掉。所有写盘入口（新增/复制/编辑/删除/设默认/扫描建连）已切到严格读
- **导出文件改 0600**：查询结果落盘 `/tmp` 的 CSV/JSON 此前是默认 0644（内容可能含身份证号、手机号），与 `db-configs.json` 同等级别处理
- **`recordLastUsed` 节流 60 秒**：此前每次查询成功都全量重写含明文密码的 JSON，高频查询下是纯写放大且无锁并发有丢更新风险
- **关系型驱动补连接超时**：pg 加 `connectionTimeoutMillis`/`query_timeout`，mysql 加 `connectTimeout`，DM 加 `connectTimeout`（此前 `doConnect(config, _timeoutMs)` 把超时参数整个丢掉，内网防火墙丢包时会挂到 TCP 默认超时，用户只看到「正在执行查询…」）
- **ES 信封不再丢条件**：`_count` 此前忽略信封里的 `query`（恒返回全量文档数），`_mget` 的 `docs` 恒为空（永远返回空结果）；信封顶层的 `index`/`size` 现在是通用字段，送给端点前摘掉

### Changed（packages/db）

- **删除死代码**：`Dialect.fingerprints`（urlPatterns + configKeys）在扫描改 AI 驱动后已零消费者，10 个方言还在维护它，已整体移除；`BigDataDialect.sessionPrefix` 声明后从未被读取，一并删除
- **测试**：新增 `sql-write-detection.test.ts`（白名单姿态 / 高风险标记 / dollar-quoted 块 / 四家族只读拦截，20 例）、`policy-hardening.test.ts`（highRisk 通道 / auditRequired / 审计 fail-closed，12 例）、`config-atomic.test.ts`（原子写 / 损坏检测 / 导出权限，5 例），测试 189 → 226
- **e2e 脚本**：新增 `scripts/e2e-live.mts`（用本机真实连接跑测试连接/列表/结构/查询/只读拦截）、`scripts/e2e-tools.mts`（mock 宿主装载扩展，验证工具层拦截、理由校验、审计顺序）、`scripts/e2e-write.mts`（临时 schema 内跑完整 DDL+DML 并清理，确认收紧后合法写仍能执行）

## [ssh 0.1.4] - 2026-11-18

### Fixed（packages/ssh）—— `/ssh` 面板代码审查发现的 8 个缺陷

面板 0.1.2/0.1.3 的 33 项单测全绿，但**没有一条覆盖「实测失败 / 同名冲突 / 复制后改名」这些组合路径**。用脚本把写盘路径逐条实跑后发现问题：

**P0（丢数据 / 让主机连不上）**

- **编辑时输错密码 → 旧密码被永久销毁**：`finishDraft` 在实测**之前**就把新密码写进 `ssh-secrets.json` 的正式键，实测失败后 `deleteSecret(finalName)` 删掉的正是那个键——而配置里原有的 `secretRef` 指向同一键，主机直接失去凭据（实测：`OLDPW` → `undefined`，配置仍是 `file:...#web`）。`updateCredentialInteractive` 同病。现改为**先写 `<name>.pending-<随机>` 临时键 → 实测通过才转正 → 失败只删临时键**，旧密码全程不动
- **「从现有复制」静默覆盖同名主机**：`delete next.hosts[name]; next.hosts[name] = copy` 等于无确认覆盖（实测把 `db` 复制成 `web`，原 `web` 的地址与 id 全被换掉，活动主机指针还指着它）。现走 `resolveName`，与新增/编辑一致（覆盖 / 自动改名 / 跳过）
- **复制出的主机共用同一个 `secretRef`**：复制只换 `name`/`id`，凭据引用原样带过去，两台机器指向同一个 `#web`。接着编辑副本改名并「沿用已保存的密码」时，`deleteSecret(oldName)` 把来源主机的密码删了（实测：`web` 密码变 `undefined`，副本拿到了密码）；`/ssh rm web` 同样会连带删掉副本的凭据。现新增 `secretRefKey`/`otherReferences`/`migrateSecret`：复制时把密码复制成新键，改名迁移前先查还有谁在用旧键，**有别人用就只复制不删**

**P1（功能不对 / 会崩）**

- **新增 FTP/FTPS 主机从不问密码**：`askAuth` 对 ftp/ftps 直接 `return { authKind: "password" }`，不带密码字段，`readSecret` 一次都没调用——存下来的主机没有任何凭据，`testProfile` 却报成功。现 ftp/ftps 也走掩码输入（编辑时可选「沿用已保存的密码」），没密码就不保存
- **编辑时清空端口无法回到默认 22**：`port: port ?? current.port` 把空输入回落成旧值，2222 永远改不回 22。现 `port` 区分「没动过（undefined）」与「清空了（null）」，`buildProfile` 用 `"port" in input` 判断
- **审计文件末尾被截断 → 面板抛未捕获异常**：`readAudit` 逐行 `JSON.parse`，进程被杀/磁盘满留下的半行会抛 `SyntaxError`，`/ssh log` 与面板「审计日志」直接崩且无提示。现 `showAudit` 捕获并给出可操作提示（文件路径 + 可能原因 + 处理建议）
- **单主机 + 无活动主机时 `/ssh exec` 空跑**：`name ?? file.activeHost ?? pickHost(...)` 会弹出选择框，而旧版靠 `runtime.allowActive` 直接打唯一那台（实测：弹框 = true，执行次数 = 0）。现补上「只有一台时直接用它」，与旧行为一致
- **编辑时无法取消 prod 标签**（安全相关）：`withProdTag(..., false)` 算出 `undefined`，但 `buildProfile` 的 `tags: input.tags ?? existing?.tags` 把 `undefined` 当「没传」回落成旧值——用户以为取消了生产标记，实际破坏性操作仍走强制 reason + 禁止写授权。现 `buildProfile` 用 `"tags" in input` 判断

**其他**

- **`parseHostSpec` 放过畸形输入**：`host:abc` → 整串当主机名、`a@b@c` → user=`a@b`、`host:` → 主机名带冒号，全部静默接受。现非数字端口、用户名含 `@`、未闭合方括号一律返回 `null`；裸 IPv6（`::1`）仍正常接受
- **策略菜单每轮刷一条 notify**：进出 4 轮产生 5 条消息（pi web 下是 5 个 toast），当前值已在 `select` 选项里。现只在保存后提示一次
- **`buildHostList` 的映射存 `profile.name` 而不是 hosts 键名**：手改 JSON 或旧版迁移后键名与 `name` 不一致时，选中后查不到 `hosts[...]`，操作静默 no-op。现按 hosts 键名索引
- **`runHostPanel` 用 `endsWith("活动主机")` 同时命中两个选项**：靠 `setActiveInteractive` 内部再判当前状态兜住，改为显式分支

### Changed（packages/ssh）

- **测试**：`test/panel.test.ts` 32 → 47 项，新增 15 条回归——实测失败不销毁旧密码（编辑 / 更新凭据两路）、成功时临时键转正且无残留、复制到同名先问（跳过 / 自动改名两路）、复制不共用凭据、副本改名不带走来源密码、删除不删别台在用的凭据、FTP 必问密码（成功 / 拒绝两路）、端口清空回默认、坏审计行不崩、单主机 exec 不弹框、取消 prod 标签、键名与 name 不一致时正确索引；测试 194 → 209
- 版本号 0.1.3 → 0.1.4

## [ssh 0.1.3] - 2026-11-18

### Fixed（packages/ssh）—— 第二轮真机全功能回归发现的 4 个 bug

同一台真机（Ubuntu 20.04 + dash + root + setsid，`10.2.9.58`）按设计文档 §8/§9 逐项跑 13 个工具与两条传输，覆盖部署/回滚/看门狗/策略/审计/隧道。完整记录见 `docs/superpowers/reports/2026-11-18-ssh-e2e-test-report.md` §10。

- **确认框不显示执行理由**：`runtime.ts` 的 `ask(ui, title, message)` **签名里没有 reason 参数**——`ssh_exec`/`ssh_sudo`/`ssh_deploy`/`ssh_rollback` 拿到 `params.reason` 后只往审计里写，确认框正文只有标题和命令。用户被要求确认一个动作，却看不到「为什么执行」。现 `ask()` 改为收结构化 `RemoteConfirmInfo`，9 个调用点全部透传 `reason`；回退路径 `plainMessage()` 也保证理由排在最前
- **确认框把多行命令挤成一行**：`ask()` 把命令当**纯文本**塞进 `ctx.ui.confirm`，而宿主确认框是 SelectList，单个换行会被折叠成空格——`set -e\nTS=...\nrm -rf ...` 糊成一坨，人没法核对多行脚本。现新增 `src/ui/confirm.ts`（展示层纯函数 + 弹窗）：TUI 走 `ctx.ui.custom` + pi-tui `Markdown` → `highlightCode`（Enter 执行 / Esc 取消），RPC/pi-web 走**同一份 Markdown**（react-markdown + Prism 同样高亮）；结构为 引用块(理由) + 列表(分级/主机/影响/传输/超时) + 代码块(命令，带 `bash` 语言标记、换行完整保留) + 引用块(警告)；围栏按内容最长反引号串自动加长防撑破
- **中文输出被切成替换符（U+FFFD）**：SFTP/exec 的 data 块边界与字符边界无关，逐块 `chunk.toString("utf8")` 会把一个 3 字节汉字切成两半、两块各解出一个替换符。实测 `ssh_read` 读 600KB 中文返回 174762 字符且含大量 U+FFFD（根因**不是** `clipUtf8`，它本身正确）。现 `ssh2` 的 read/exec/stdout/stderr 与 `openssh` 的 exec/scp/sftp 全部改用 `StringDecoder` 续接，`close` 时 `end()` 冲掉残留半字符；修复后同一文件读出 174762 个完整汉字、零替换符
- **只读模式漏放写命令**：`classify()` 没识别 `mkdir`/`touch`/`ln`/`git checkout -- .`，**只读模式下 `mkdir -p /tmp/x1` 直接执行成功**，等于「只读」承诺失效。现补 4 条规则；`git checkout` 区分切分支（读）与覆盖工作区文件（`-- .`、`-- file` 为写）

### Added（packages/ssh）

- **openssh 传输的 `test` 报出真实指纹**：此前恒返回空串（代码注释写的是「指纹不经我们手」），用户在用 openssh 时无法对照 `ssh-keygen -lf`。现新增 `scanHostKeyFingerprint()` 用 `ssh-keyscan` 取密钥原文，再算与 ssh2 同一个 SHA256；**按 ed25519 → ecdsa → rsa 排序**——同机多把密钥时 `ssh-keyscan` 的输出顺序不保证，不排序会让两条传输报出不同指纹，用户会误以为密钥变了。实测两条传输现在报出完全一致的 `SHA256:Gi3H0…`

### Changed（packages/ssh）

- `package.json` 补 `@earendil-works/pi-tui` peer/dev 依赖（TUI 自定义弹窗的组件来源，与 db 插件一致）
- **测试**：新增 `test/confirm.test.ts`（10 项：理由前置、多行理由合并、命令换行保留、围栏加长、反引号转义、标题拼接）与 `test/utf8.test.ts`（5 项：钉住「朴素逐块 toString 确实会坏」这个前提 + `StringDecoder` 在 1/2/3/5/7/11/13 字节切块下均无损 + 600KB 中文）；`test/policy.test.ts` 补 6 条漏判回归；`test/openssh.test.ts` 补密钥类型偏好；测试 149 → 182
- 版本号 0.1.2 → 0.1.3

### Docs（回归基线）

- **新增 `docs/superpowers/reports/ssh-regression-checklist.md`**：升级回归手册——每次发版前用**真实安装的插件 + 真实服务器**逐条勾选。含环境要求（必须是 dash 远端，bash 测不出 `set -m` 假成功）、凭据纪律（全程用密钥，不把密码写进命令/对话）、装真包并验证「不是占位空壳」的步骤，以及 10 个章节的可勾选清单：主机管理与面板（10 小节）、执行与输出、**确认框渲染（人眼检查）**、策略与审计、传输（ssh2/openssh/FTP）、部署与回滚、看门狗、隧道、扫描建连、收尾
- **测试报告补 §11**：明确交代 `0.1.2` 面板的验证边界——33 项单测覆盖逻辑与路由（含 4 条写盘边界回归），但**交互与渲染没有真机记录**（假 `ctx.ui` 测不出菜单分支错位、pi web 降级、掩码退化、多级菜单死循环、长标题撑破）。这是已知验证缺口，已列入手册 §1 而不是假装覆盖过

### 已知限制（本轮未修，已写进报告）

- **命令内部自己 `setsid` 派生的进程会逃出看门狗进程组**：普通超时、`nohup`、`&` 派生都能清掉，但 `setsid sh -c '…' &` 建了新会话，`kill -TERM -$pid` 打不到它。彻底解决需要 cgroup 或 `pkill -P` 递归，代价与收益待权衡

## [ssh 0.1.2] - 2026-11-18

### Added（packages/ssh）—— `/ssh` 管理面板（对齐 db 插件）

此前 `/ssh` 无参数只发一条 `ctx.ui.notify`，在 pi web 里就是右上角一个瞬时 toast，没有任何可点的东西，用户只能背子命令（截图反馈）。db 插件用的是 `ctx.ui.select`，TUI 与 pi web 都会渲染成可选的对话框。现补齐同形态的面板：

- **新增 `src/ui/panel.ts`**（不 import 任何 pi 模块，只用 `ctx.ui` 的 select/confirm/input/notify，TUI 与 RPC 走同一份代码）
  - **两级菜单**：`SSH 管理（N 台，活动 xxx）` → 主机列表 / 切换活动 / 新增 / 扫描建连引导 / 测试全部 / 策略设置 / 审计日志 / 本机体检；选中主机进二级菜单：测试、详情、设为或取消活动、加/去 prod 标签、更新凭据、编辑连接信息、编辑部署布局、执行命令、会话写授权、该主机审计、删除
  - **子命令与面板同一套流程**：`handleSshCommand` 统一路由，`/ssh add|edit|rm|use|test|log|config|doctor|grant|exec` 全部复用面板函数，不再出现「命令能改、面板不能改」的分叉
  - **新增子命令**：`/ssh config`（只读模式 / 确认级别 / 恢复默认，写回 `policy` 并与 `runtime.policyOf` 同缺省）、`/ssh doctor`、`/ssh testall`、`/ssh scan`（引导语）、`/ssh log [主机|条数]`
  - **新增主机支持传输选择**：auto / ssh2 / openssh / ftp / ftps（含隐式 TLS 与跳过证书校验），新增「从现有复制」——此前 FTP/FTPS 只能手改 JSON
  - **认证可选**：密钥 / 密码（掩码输入，不进口语记录）/ ssh-agent；换认证方式时清掉另一路的引用，不留孤儿
  - **写盘纪律与工具侧一致**：先实测连接再写盘，未知指纹先摆出来核对（拒绝 = 不保存）；密码先落 0600 文件，失败或改名时对齐/回滚凭据引用，不残留孤儿密码；改名时旧键与活动主机指针一并迁移
  - **编辑不抹配置**：`buildProfile` 以 `existing` 为底，改地址不会丢掉 `id`/`createdAt`/`deploy`/`defaults`/`tags`
  - **部署布局可视化编辑**：root / releasesDir / currentLink / sharedDir / restartCmd / healthCmd / keepReleases；留空 root = 清除布局
  - **审计按主机过滤**：不带参数先选范围（全部 / 单台），长命令截断到 80 字符
- **纯函数与路由单测**：新增 `test/panel.test.ts`（32 项）——`parseHostSpec`（含 IPv6 `[::1]:22` 与端口越界）、`withProdTag`、`hostSummaryLine`/`buildHostList`（活动主机置顶）、`authSummary`（密码只说有没有保存）、`hostDetailLines`、`policyLines`/`effectivePolicy`、`auditLines`（过滤/截断/退出码）、`buildProfile`（编辑保留字段、换认证清引用）、`describeTestResult`，以及用假 `ctx.ui` 跑通 `/ssh` 无参开面板、`ls`/`config`/`rm`/`use`/`grant`/未知子命令的路由与写盘；另有 4 条写盘边界回归——同名冲突改名时密码只落最终名字、编辑改名时密码条目与活动指针一起迁移、传输方式按名字解析（不被「（当前）」后缀带偏）、实测失败不写盘且回滚已写入的密码；测试 149 → 181
- **文档**：`packages/ssh/README.md` 的 `/ssh` 章节改为面板两级菜单树 + 子命令表，「已知限制」删掉已实现的 `scan`/`config` 与手改 JSON 两条

### Fixed / Added（packages/ssh）—— 确认弹窗对齐 db 那份并补上滚动

`src/ui/confirm.ts` 此前只在工作区，未随包发布；已发布的 0.1.1 里没有 `src/ui/`，所以线上看到的仍是纯文本 `confirm`。本版补齐并反向借鉴 db 的 `confirmSqlExecution`：

- **视口滚动**（db 那份没有）：`deploy`/`rollback` 的剧本 + notes 常超一屏，挤在编辑器槽里会把转录区顶走。新增 `sliceViewport`/`viewportHeight` 纯函数（offset 夹取、上下剩余行数），↑↓/PgUp/PgDn/Home/End 与 `j/k/g/G` 均可滚，页脚显示 `(起-止/总)`；内容不足一屏时不显示滚动提示
- **键位走宿主注入的 KeybindingsManager**：此前硬编码 `matchesKey(data, "enter"/"escape")`，用户改过键位后确认框就按不动。现在 `tui.select.confirm|cancel|up|down|pageUp|pageDown` 优先，未知键位名退回默认键
- **每行裁到宽度**：`truncateToWidth` 兜底，长命令不再让终端折行把弹窗撑坏
- **`blocked` 状态**：`ctx.ui.custom(..., { blocked: { kind: "permission", message: title } })`，支持 program status 的终端会显示 pi 正卡在「等你授权」
- **回归测试**：`test/confirm.test.ts` 13 → 22 项，新增视口滚动（不足一屏/越界夹取/上下计数/非法高度）、`viewportHeight` 兜底、真实 TUI 组件（Enter/Esc、标题与正文、PgDn 后起始行前进、短内容无滚动提示、每行不超宽）、RPC 回退与 custom 抛错回退；测试 181 → 194

### Changed（packages/ssh）

- `/ssh` 无参数从「列主机」改为「打开面板」（列主机仍由 `/ssh ls` 提供）；`testWithTofu` 从 `index.ts` 移入面板模块，`index.ts` 只保留运行时注入
- 版本号 0.1.1 → 0.1.2

## [ssh 0.1.1] - 2026-11-18

### Fixed（packages/ssh）—— 真机 E2E 测试暴露的 5 个 P0 + 13 个 P1

真机（Ubuntu 20.04 + dash + OpenSSH 22 + 本地 `ftp-srv`）直接驱动 `createRuntime()`/`Ssh2Pool`/`transports/*` 全量跑测，发现「默认路径」直接不可用或崩溃的缺陷。完整复现与复测见 `docs/superpowers/reports/2026-11-18-ssh-e2e-test-report.md`。

**P0（阻塞级）**

- **`ssh_deploy` 默认 `kind: "tar"` 100% 失败**：`rejectArchiveMembers` 对 `tar -tzf` 输出直接 split，末尾空串被当越界成员，**任何合法 tar 包都被整包拒绝**（错误信息还是空的 `压缩包成员越界：`）。现先 `map(trim)` 再 `filter(v => v !== "")`，空行不参与判定，越界成员仍逐个点名
- **`ssh_put` 传目录 → 进程崩溃**：`sha256File` 里 `readableWebStream()` 对目录抛的 `EISDIR` 逃成 unhandledRejection，在长驻宿主里直接把进程打掉。现 `stat().isDirectory()` 先拒绝并提示「先打包」，流读取改用 `createReadStream` 异步迭代，错误落回 `await`
- **FTP 密码完全不可用**：`ftp.open()` 读的是 `auth.secretRef`（`file:...#name` 引用），而 `resolveProfile` 把明文放在 `auth.password`，服务端收到的是引用字符串 → 必然 530。生产路径（新密码一律落 0600 文件）就是这一种。现 `open()` 用 `auth.password`（仅对裸串 `secretRef` 兼容），runtime 四处 `withPassword` 全部换成 `resolveProfile`
- **openssh 在 ControlMaster 生效后返回 143 + 空输出（复现率 4/5）**：`execOpenSsh` 用 `stdio: ["ignore", ...]`，而看门狗第一句是 `exec 3<&0`，fd 0 是 `/dev/null` 致 fd 3 立刻 EOF，watcher 立即 `kill -TERM -$pid` 把命令自杀。现 stdin 改 `pipe` 且不 `end()`（`copyOpenSsh` 同）
- **`ssh_deploy`/`ssh_rollback` 只走 ssh2**：openssh 主机被静默改走 ssh2 直连（ProxyJump/agent/证书主机根本连不上，看起来却「成功」），FTP 主机报无关的 `ECONNREFUSED`。现新增 `runnerFor(host)` 按 transport 分流：openssh → `opensshRunner` + `scpPutVerified`，ssh2 → `poolRunner` + `pool.put`，FTP → `UnsupportedError`

**P1（高危）**

- **回滚**：候选过滤 `.part` 残留（显式传入也拒绝，此前会把 `releases/zz.part` 当 release 切上去导致站点 404）；`ssh_rollback` 补健康检查并在确认框写明；文件回滚同时查找 `<root>/.pi-ssh-backup/<rel>.<ts>` 与同目录 `<path>.bak.*`，失败时列出找过的位置
- **部署**：重启命令失败也走与健康检查同一条 `fallback`（此前 `current` 停在新版本、未健康检查），回退时的重启用 `tryRun`，不掩盖「已回退」这个事实
- **可观测性**：连接池新增 `fingerprintOf()`，已连接后再 `ssh_hosts test` 不再返回空指纹；传输层预算改按「加上本块之后」判定、runtime 回填 `spillPath`（此前 2000 行上限实际失效、`spillPath` 恒 `undefined`）；生产主机 destructive 一次动作只写一条审计；`put`/`get` 审计补 `bytes`/`sha256`/`backupPath`
- **openssh 补齐**：新增 `getOpenSsh`（scp 后双端 sha256 比对，此前返回 `{bytes:0, sha256:""}`）、`onData` 流式回传（此前回调次数 0）、输出经 `tail()` 统一截断落盘
- **看门狗**：改判 `$-` 而非 `set -m` 退出码（dash 下 `set -m` 假成功致组杀失效、`setsid` 派生的子进程必然残留），无 job control 时用 `setsid` 建独立进程组，两者都没有时写 stderr 警告并置 `PI_SSH_NO_GROUP`
- **sudo**：`wrapSudo` 的 heredoc 原先嵌在 `sh -c '...'` 引号内，`$PI_SSH_PW` 到不了内层 shell（未 export），改挂最外层调用（子 shell 或 `setsid`）
- **openssh 噪音**：新增 `stripSshNoise` 过滤老服务器的 4 行 post-quantum 警告，避免「退出码 0 看起来像失败」
- **测试**：新增看门狗 `$-` 分支、`setsid`、sudo heredoc 位置、噪音过滤、`sha256File` 拒目录、`rejectArchiveMembers` 尾空行、备份位置两套规则七组用例，测试 113 → 128


### Added（packages/ssh）

- **openssh 传输补齐（列目录/读文件/上传/ControlMaster）**：此前 openssh 只跑命令，现在与 ssh2 对齐
  - `listOpenSsh`/`readOpenSsh`：走 `sftp -b` 批处理，`parseSftpLongNames` 解析长格式（名称/大小/是否目录）
  - `putOpenSsh`：`scp` 上传，sha256 校验、可带远端备份；跨文件系统 `mv` 报 EXDEV 时降级为复制
  - `ensureControlMaster`/`closeControlMasters`：复用同一条连接，避免每次握手；会话关闭时统一释放
  - 修复 stdin 必须保持 pipe：`exec 3<&0` 的看门狗靠这条通道判断客户端是否放弃，`stdio: "ignore"` 会让 fd 3 立刻 EOF、命令被自己的 watcher 秒杀（exit 143 + 空输出）
- **首次连接 TOFU 指纹确认**：未知主机密钥先失败并摆出指纹，人确认后才写 known_hosts；`confirmUnknownKey`/`testWithTofu`/`testProfileWithTofu` 统一这一路径，拒绝指纹 = 不保存
- **`ssh_doctor` 改为按 PATH 探测**：新增 `which()`，不再写死 `/usr/bin`（Homebrew/`/usr/local/bin`/NixOS 都不在那里，写死会把可用的 ssh 报成不可用）；openssh 三件套 `ssh`/`scp`/`sftp` 逐个报告缺失项

### Changed（packages/ssh）

- **文档**：`packages/ssh/README.md` 由 11 行占位补全为完整文档（特性/安装与镜像占位包排查/工具清单/`/ssh` 命令/凭据文件表/安全模型/部署与回滚剧本/已知限制）；根 README 与设计文档 §16 同步口径
- **健康检查改为远端循环**：新增 `healthLoopCommand`，把 `healthCmd` 包成 `while` 循环一次往返（默认 60s 预算），最后一轮输出留在 stdout 供失败报告；预算至少一轮
- **传输池重构**：`runtime` 抽出 `RemoteRunner` 接口与 `poolRunner`/`opensshRunner` 两个实现，`remoteLines`/`checked` 统一入口；新增 `pruneBackups` 统一清理旧备份
- **测试**：新增 `openssh.test.ts`（sftp 长格式解析），`rejectArchiveMembers` 补空行用例（`tar -tzf` 输出尾空串曾被当成成员，导致合法包全被判越界），测试 100 → 113

## [ssh 0.1.0] - 2026-11-18

### Added（packages/ssh）

- **新包 `@nsyan/ssh`**：pi 的远程运维扩展，SSH/SFTP/FTP 一套工具覆盖「连、看、改、传、部署、回滚、转发」。设计见 `docs/superpowers/specs/2026-11-18-ssh-plugin-design.md`
  - **13 个工具**：`ssh_hosts`（主机清单）/`ssh_exec`/`ssh_sudo`/`ssh_ls`/`ssh_read`/`ssh_put`/`ssh_get`/`ssh_deploy`/`ssh_rollback`/`ssh_tunnel`/`ssh_doctor`/`ssh_scan_sources`/`ssh_host_save`，管理命令 `/ssh`
  - **危险命令分级确认**：policy 按 §6.1 全表分类，危险动作走确认弹窗（用户拒绝后不重试）
  - **审计**：远端动作追加 JSONL（`~/.pi/agent/ssh-audit.jsonl`），单文件超 1MB 滚动、保留最近 7 份，stdin 永不落明文
  - **凭据不入模型上下文**：工具 schema 无 password 字段；密码只经掩码弹窗进 0600 文件或钥匙串（钥匙串只读，macOS 不用 `security -w` 传新密码）
  - **部署一等公民**：只认主机配置里的 `deploy` 布局，重启命令与健康检查不可调用时临时传入；tar/目录上传到 `releases/<ts>/` 后切软链，健康检查失败自动切回上一版，`ssh_rollback` 手动回退
  - **known_hosts 校验 + `ssh_doctor` 体检**：Node 版本、ssh2、本机 ssh、known_hosts 可写、钥匙串可用性、审计可写
  - **自动建连**：`ssh_scan_sources` 扫 `~/.ssh/config` 与项目部署文件出候选，`ssh_host_save` 逐个确认后写盘
  - **双传输**：ssh2（纯 JS 跨平台，含 SFTP）与 openssh（继承 ProxyJump/agent/MFA）；FTP/FTPS 走同一传输抽象
  - **零 pi 运行时依赖的 core 层**：`src/core` 与 `src/transports` 不 import 任何 pi 模块，为将来输出 MCP server 铺路
  - **发布配置**：`files` 白名单含 `index.ts`/`src/`/`skills/`/`README.md`/`LICENSE`，附 LICENSE 与 `engines.node >= 18`，keywords 补 `scp`/`remote`/`devops`/`rollback`
  - 测试 100 项全绿，`tsc` 类型检查零错误
- 版本号 0.1.0（首个公开版，API 未冻结）

## [1.3.5] - 2026-10-21

### Fixed（packages/db）

- **修复 hive/spark 依赖链缺 `ws` 导致整个扩展加载失败**：依赖链 `hive-driver → thrift → isomorphic-ws`，其中 isomorphic-ws 把 `ws` 声明为 **peerDependencies**（自身无实体依赖）。npm 扁平安装时 thrift 自带的 `ws@5` 可能只嵌套在 `thrift/node_modules` 而未提升到安装根，此时被提升到根的 isomorphic-ws `require('ws')` 直接 `Cannot find module 'ws'`——而 `index.ts` 顶层静态 import 全部方言（含 Hive/Spark），一条链炸掉整个扩展（6 工具 + `/db` 全部注册不上，且 pi 静默记 "Failed to load extension"、插件页仍显示"已加载"，极具迷惑性）。本地 pnpm 因严格布局 + auto-install-peers 把 peer 自动补齐，开发期完全无感。修复：
  - `package.json` dependencies **显式声明 `ws@^8.22.0`**（npm 对顶层包的直接依赖保证提升到安装根；isomorphic-ws 的 peer 规范为 `*`，可解析任意版本）
  - 新增 `test/hive-driver-load.test.ts` 回归：在任一包管理器下 `import("ws")` 与 `import("hive-driver")` 必须可解析，移除 ws 依赖时测试先红；测试 187 → 189
- 版本号 1.3.5

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
