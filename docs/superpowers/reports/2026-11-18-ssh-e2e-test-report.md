# @nsyan/ssh 真机全量功能测试报告

日期：2026-11-18
被测代码：`packages/ssh`（工作区当前未提交改动，即 M1–M8 全量实现）
对照文档：`docs/superpowers/specs/2026-11-18-ssh-plugin-design.md`
真机：`root@10.2.9.58`（Ubuntu 20.04，kernel 5.4，`/bin/sh` → dash，sshd 22，sudo 免密，9001 端口有 nginx）
本地：macOS + Node 22.19，openssh 三件套齐全，`ftp-srv` 4.6.3 起本地 FTP

## 0. 测试方式

| 层 | 内容 | 结果 |
|---|---|---|
| 单元测试 | `npx tsx --test "test/**/*.test.ts"` | **112 pass / 0 fail** |
| 类型检查 | `npx tsc -p tsconfig.typecheck.json` | **0 error** |
| 真机 E2E | 直接驱动 `createRuntime()` / `Ssh2Pool` / `transports/*` / `core/*`，不打桩，连 10.2.9.58 实跑 | 见下 |
| FTP 集成 | 本地 `ftp-srv` 起 21xx 端口，测登录/列表/上传/覆盖/下载/续传/能力降级 | 见下 |

E2E 脚本：`/tmp/pi-ssh-e2e/harness*.ts`、`v1..v26.ts`（可复跑）。
远端工作区：`/tmp/pi-ssh-e2e`（测试后已清理）。

---

## 1. 结论

**核心链路（连接、鉴权、策略、审计、传输、连接池、隧道）真机可用；但 5 个 P0 级缺陷会让「默认路径」直接不可用或崩溃**，其中 3 个属于「设计写了、代码没做到」，2 个属于「实现有 bug」。

设计文档 §16 的修订记录声称这些都已修好，实测**并未全部落地**。

---

## 2. P0 — 阻塞级（必须修，否则功能等于没有）

### P0-1 `ssh_deploy` 的默认 `kind: "tar"` 100% 失败：把 tar 输出末尾空行当成越界成员

`src/core/deploy.ts:rejectArchiveMembers()` 对 `tar -tzf` 输出直接 `split(/\n/)`，`tar` 输出必以 `\n` 结尾，因此数组最后一项是 `""`。函数把 `""` 判为逃逸成员（`value === ""` 直接 `return true`），于是**任何一个合法的 tar 包都会被整包拒绝**。

真机复现：

```
$ tar -tzf t1.tar.gz          →  "ok.txt\napp/\napp/i.html\n"
$ "ok.txt\napp/\napp/i.html\n".split(/\n/)  →  ["ok.txt","app/","app/i.html",""]
$ rejectArchiveMembers(...)   →  [""]          ← 只有空串
$ runtime.deploy(...)         →  BoundsError: 压缩包成员越界：
```

- 远端残留 `releases/t1` + `releases/t1.part`，`current` 不动（没有二次破坏，但发布失败）。
- `kind: "file"` 正常，所以是「默认剧本不可用，绕道才能用」。
- 附带：错误信息 `压缩包成员越界：` 后面是空的，人看不出到底哪个成员越界。

**修复**：过滤空串与 `.`；或改成 `split(/\n/).filter(Boolean)`。

### P0-2 `ssh_put` 传目录 → 未捕获 rejection → **进程直接崩溃**

设计明确「不接受目录，先打包」，但代码没有校验。`sha256File(dir)` 里 `handle.readableWebStream()` 对目录抛 `EISDIR`，该 rejection 不在 `for await` 的 try 范围内，逃逸成 unhandled rejection，**Node 进程直接退出**。

真机复现（`npx tsx` 实测）：

```
C ssh_put 传目录…
unhandledRejection: EISDIR
（进程退出，pi 扩展随之崩溃）
```

对 pi 这种长驻宿主，一次误调用就把整个会话打掉。

**修复**：`put()` 入口 `statSync().isDirectory()` 直接抛可读错误；`sha256File` 的 stream 错误纳入 try。

### P0-3 FTP 密码完全不可用：把 `file:...#name` 引用当成密码发出去

`transports/ftp.ts:open()` 读的是 `profile.auth.secretRef`，而 `runtime.resolveProfile/withPassword()` 解析出来的明文放在 `profile.auth.password`。两处对不上：

| profile 形态 | 服务端实际收到的密码 | 结果 |
|---|---|---|
| `secretRef: "file:/…/ssh-secrets.json#ftp-local"`（**生产真实形态**） | `"file:/…/ssh-secrets.json#ftp-local"` | 530 bad credentials |
| `password: "p"`（内存） | `"guest"`（undefined 落空） | 530 bad credentials |
| `secretRef: "p"`（裸串，只有测试会这么写） | `"p"` | 成功 |

设计 §5 规定「新密码一律落 `~/.pi/agent/ssh-secrets.json`（0600）」，也就是**生产路径必然是第一种，也就是必然登录失败**。`/ssh add`、`ssh_host_save` 建 FTP 主机都走这条路。

**修复**：`ftp.open()` 用 `profile.auth.password ?? resolve(secretRef)`，且必须与 ssh2 走同一个 `resolveProfile()`。

### P0-4 openssh 传输在 ControlMaster 生效后返回 `143` + 空输出（复现率 4/5）

`execOpenSsh()` 以 `stdio: ["ignore", "pipe", "pipe"]` 启动 `ssh`，而 `wrapWithWatchdog()` 的脚本第一句是 `exec 3<&0`——fd 0 是 `/dev/null`，fd 3 立刻 EOF，watcher 立即 `kill -TERM -$pid`，命令被自杀。

实测（同一 master，同一命令，仅改 stdin）：

```
stdin=ignore（当前实现）： #1 3001 行 OK | #2..#5 exit=143 行=1
stdin=pipe（保持不关）：   #1..#5 全部 3001 行 OK
```

表现到工具层：

```
$ rtOssh.exec({command:"uname -n"})   → exit=143, stdout=""
$ rtOssh.exec({command:"seq 1 3000"}) → exit=143, stdout=""
$ rtOssh.exec({command:"sleep 1; echo slow"}) → exit=143, stdout=""
```

这是**随机成功、大概率静默返回空输出且退出码 143**，比直接报错更危险（模型会把 143 当命令失败，反复重试或改写命令）。首次调用（master 还没起来）通常成功，之后全挂——正是「用一会儿就坏」的形态。

**修复**：`execOpenSsh` 用 `stdio: ["pipe", ...]` 且不要 `end()` stdin；或 watchdog 在 fd 0 不可读时改用 `exec 3<>/dev/null` 的显式长连接。

### P0-5 `ssh_deploy` / `ssh_rollback` 只走 ssh2，静默忽略主机的 transport

`runtime.deploy()` / `rollback()` 里全部是 `await connect(host)` + `pool.put/exec`，`pool` 是 `Ssh2Pool`，没有 `transport === "openssh" | "ftp"` 分支。

| 主机 transport | 实测行为 | 期望（设计 §4.2/§4.3） |
|---|---|---|
| openssh | **静默用 ssh2 直连**（同密钥恰好能通，看起来成功） | 走 openssh / scp |
| ftp | `connect ECONNREFUSED 127.0.0.1:2121` 之类底层错误 | `UnsupportedError`：FTP 不能部署 |

openssh 那台「部署成功」是假象：ProxyJump / agent / 证书主机根本连不上（ssh2 做不到），会退化成 `ECONNREFUSED` 或超时；FTP 主机则给出完全误导的 socket 错误。

**修复**：`deploy`/`rollback` 抽 `RemoteRunner`（`exec`/`put` 两个动作），openssh 走 `execOpenSsh`/`putOpenSsh`，ftp 直接 `UnsupportedError`。

---

## 3. P1 — 高危（语义错误 / 数据错位 / 安全承诺没做到）

| # | 问题 | 复现 | 影响 |
|---|---|---|---|
| P1-1 | `ssh_rollback release` 会把 `.part` 残留当成 release 切上去 | `releases/{r1, zz.part}`，current→r1；rollback 后 current→`releases/zz.part`（不是目录） | 站点直接 404；应只认目录 |
| P1-2 | `ssh_rollback release` 不做健康检查 | 代码只有 `ln -sfn` + `restartCmd` | 设计 §8「切软链+重启+健康检查，三步一次确认」缺一步，回滚到坏版本无人发现 |
| P1-3 | 文件回滚找不到部署根内的备份 | 备份在 `<root>/.pi-ssh-backup/<rel>.<ts>`，`rollback({file})` 只找 `<path>.bak.*` → `PolicyDeniedError: 没有可用备份` | §6.4 承诺的「文件级回滚」在部署根内**永远失效**；两处路径规则必须统一 |
| P1-4 | 部署中途失败（重启命令失败）不回退，`current` 停在新版本 | `restartCmd: "exit 7"` → 抛错，`current → releases/bad1`（新版本、未健康检查） | 确认框里写了「健康检查失败会自动回退」，但重启失败这条路径没有回退，与承诺不符 |
| P1-5 | 已连接后再 `ssh_hosts test`，指纹为空 | 首次 `testHost` 返回 `SHA256:Gi3H0…`；先 `exec` 一次再 `testHost` → `fingerprint: ""`、`keyType: ""` | `/ssh test` 在用过之后就不再显示指纹，用户无法核对 |
| P1-6 | `ExecResult.spillPath` 从不回填；ssh2 传输层 2000 行判定用的是「已累积」而非「本块」 | `seq 1 3000` → `truncated:true`，文本里有路径，但 `spillPath: undefined`；`pool.exec` 返回 `spillPath: undefined` | 设计 §3/§7.2 要求「超出部分全文落临时文件，结果里给路径」。目前靠 runtime 的 `tail()` 兜底落盘，字段丢失 |
| P1-7 | openssh 的 `ssh_get` 不做双端校验，返回空值 | `rtOssh.get(...)` → `{bytes: 0, sha256: ""}` | 设计修订明确「`ssh_get` 补上远端哈希比对」，未落地；下载损坏无感知 |
| P1-8 | openssh 的 `ssh_exec` 无流式输出 | `onData` 回调次数 **0**（ssh2 路径 4 次） | §7.2 的「实时可见」在 openssh 上完全失效，长命令全程静默 |
| P1-9 | openssh 输出超 2000 行不截断、不落盘 | `seq 1 3000` → 返回 1860 行，无「已截断」提示，`spillPath: undefined` | 50KB/2000 行预算在 openssh 上不存在，大输出直接灌进模型上下文 |
| P1-10 | 生产主机 destructive 审计写 **两条** | `rm -f` 一次 → 审计 2 行（动作前一条无 exitCode，动作后一条有） | `/ssh log` 双计；设计 §6.3 是「一条动作一条记录」。动作前写是对的，动作后应更新或跳过 |
| P1-11 | `ssh_put`/`ssh_get` 审计缺 `bytes`/`sha256`/`backupPath` | 实测审计行只有 `host/tool/danger/summary/command/confirmed/ts` | §6.3 明确要求记录两端路径、字节数、sha256、backupPath；现在无法从审计追溯「到底传了什么」 |
| P1-12 | 看门狗在 dash 远端**没有真正杀进程组** | `sh -c 'set -m; ( sleep 77 ) & p=$!; kill -TERM -$p'` → `kill: No such process`，进程 ALIVE；`setsid sleep 333 &` 后必然残留 | dash 的 `set -m` 只打警告、不启 job control，`if ! set -m` 判定为成功 → 走 job-control 分支 → 组杀失效。普通命令靠会话结束兜底（实测能清），`setsid`/`nohup` 派生的子进程**必然残留**。§6.2 承诺的 TERM→KILL 不成立 |
| P1-13 | `set -m` 不可用时的警告从不输出 | 正常命令 stderr 为空，无 `pi-ssh: 远端 shell 不支持 set -m` | 设计要求的「在结果里明确警告」没做到，用户不知道清理是降级模式 |

---

## 4. P2 — 设计偏差 / 体验问题

| # | 问题 | 说明 |
|---|---|---|
| P2-1 | `/ssh` 缺 `scan` 与 `config` 子命令 | 设计 §10.1 列了 10 个子命令，实现只有 `ls/use/test/rm/grant/log/add/edit/exec`（`grant` 反而是设计里没有的）。`/ssh config` 无法改只读开关/确认级别 |
| P2-2 | `ssh_host_save` 没有 `transport`/`secure`/`insecure` 参数 | 扫描建连无法保存 FTP/FTPS 主机；`saveHostCandidate` 支持 `transport` 但工具层不暴露 |
| P2-3 | `ssh_scan_sources` 不产出 `ftp://`/`ftps://` 候选 | 设计 §4.4 要求「ftp:// ftps:// 前缀的扫描候选 → ftp/ftps」 |
| P2-4 | `ssh_hosts` 工具把 `acceptNewHostKey` 当裸开关 | 设计 §4.1：「不是能直接打开的开关，先不带它试一次，把指纹摆给用户确认」。工具层直接透传，模型可以跳过指纹确认直接写 `known_hosts`（`/ssh test`、`ssh_host_save` 才有确认流程） |
| P2-5 | `Transport.capabilities` 未实现 | 设计 §4 的 `{ exec, sudo }` 能力声明；目前靠 `host.transport === "ftp"` 硬编码判断 |
| P2-6 | `TransferResult.verified` 未实现 | 设计 §3 的 `"both" \| "local-only"` 字段不存在；FTP 把 `"local-only"` 塞进 `sha256` 字段，语义混用 |
| P2-7 | 密码认证失败抛原始 `Error` | `All configured authentication methods failed`，不是 `AuthFailedError`；设计 §11 要求「试过哪些方法、服务器拒绝了哪个」 |
| P2-8 | `waitFor` 无本地回退 | 三个分支都硬编码 `bash -c`；远端没有 bash 时直接失败，设计 §7.3 要求「整段退回本地间隔探测并注明」 |
| P2-9 | `ssh_put` 远端目录不存在时错误不可操作 | ssh2 只给 `"No such file"`；openssh 给 scp 原文。没有「目标目录不存在，先 `mkdir -p` 或改用 `ssh_deploy`」的指引 |
| P2-10 | `ssh_tunnel` 每次都确认、且没有 `bind` 参数 | 设计 §9 标注为「否」；§6.1 说「bind 非 loopback 时确认」，但工具没有 bind 参数，永远只绑 127.0.0.1 |
| P2-11 | 文件回滚失败文案不含查找路径 | `没有可用备份，或恢复 X 失败` —— 不说找了哪些位置（见 P1-3，用户根本猜不到备份在 `.pi-ssh-backup`） |
| P2-12 | 测试缺 FTP 集成与 sshd 集成 | 设计 §12 要求 `ftp-srv` 作 devDependency 起本地服务测 `.part`/MLSD/FTPS，以及 docker sshd 测看门狗；`package.json` 里没有 `ftp-srv`，`test/` 里也没有对应用例（112 个测试全是纯函数 + 一个进程内假 ssh 服务） |
| P2-13 | `ssh_ls` 对 FTP 可用（比设计修订版更好） | 修订记录说「ssh_read/ssh_ls 对 FTP 明确说明不支持」，实际 `list` 走 MLSD 可用。**这是正向偏差，不算缺陷**，但文档与实现不一致 |

---

## 5. 真机验证通过的功能点（可用，无需改动）

**连接与鉴权**
- 密钥登录；`ssh_hosts test` 指纹与 `ssh-keygen -E sha256 -lF` **完全一致**
- TOFU：未知密钥先抛 `HostKeyUnknownError` 且**不写** `known_hosts`；确认后才写，第二次直接 match
- 主机密钥变化 → `HostKeyChangedError` 硬失败
- `strictHostKey: false` 跳过校验但仍返回指纹
- `agent` 无 `SSH_AUTH_SOCK` → `AuthFailedError` 明确报错
- 多主机不传 `host` → 拒绝并列出全部名称；一台时允许省略

**策略与审计**
- `classify` 分级正确：`ls`/`cat`→read，`sed -i`/`>`/`mkdir`→write，`rm -rf`/`docker rm`→destructive
- 默认级别只确认 destructive；`confirm: "write"` 连写操作一起确认；`always` 连只读也确认
- 只读模式拒绝 write/destructive，放行 read
- 生产主机（`tags: ["prod"]`）destructive 缺 `reason` → `PolicyDeniedError`；有 reason 仍弹窗；**会话授权对生产主机拒绝授予**、对非生产生效、destructive 不在授权范围
- 用户拒绝 → `ConfirmRejectedError`，文案含「不要换一种写法重试」，且**命令确实没执行**
- 生产主机 `ssh_put` 新文件也确认
- 审计：JSONL、0600、`stdin` → `<redacted>`、1MB 滚动、**生产主机 destructive 在动作之前 fail-closed**（审计不可写时命令没执行）

**执行与看门狗**
- 输出超 50KB/2000 行截断，全文落盘且文本给出路径
- ssh2 流式 `onData` 分片到达
- 超时 / abort 后远端 `sleep` **无残留**（普通命令）
- `waitFor` 的 port / http / file 三种条件均正确，未就绪返回非 0

**传输**
- `ssh_ls` 结构化列表；`ssh_read` offset/limit、无尾换行、空文件、offset 越界、600KB 单行按 512KB 截断且**未切断多字节字符**
- `ssh_put` 新文件：`.part` → 双端 sha256 → rename 转正，无 `.part` 残留
- `ssh_put` 覆盖：确认 + 备份 + **同路径只留 3 份**
- `ssh_get`：双端 sha256 校验
- `ssh_sudo`：密码不进命令文本、审计脱敏、退出码 0

**隧道**
- local 转发：本机 127.0.0.1 → 远端 9001，实测 HTTP 200
- remote 转发：远端 → 本机 HTTP 服务，实测拿到响应
- listen 端口占用失败后**名额归还**，后续调用正常

**部署**
- `dryRun` 只出剧本、不碰远端
- `kind: "file"` 全流程：上传 → `releases/<id>/<file>` → 切软链 → 重启 → 健康检查
- 健康检查失败 → **自动切回上一版且不再确认**
- 清理旧版本：`keepReleases` 生效、保留回滚点、不动 `.pi-ssh-backup`
- 无 `deploy` 布局 → 拒绝并指路 `ssh_exec` + `ssh_put`
- 非法 `releaseId`（`../evil`）→ 拒绝
- `df` 读不到剩余空间 → 取消部署
- 压缩包成员含 `..` → 整包拒绝（守卫逻辑本身对，只是空串误伤，见 P0-1）
- `rollback release` 基本路径：切回上一版 + 重启

**连接池**
- 同一 profile 复用一条 TCP（首次 ~1s，复用 ~30ms）
- 7 路并发：第 7 路排队（上限 6），全部成功
- 空闲 TTL、`session_shutdown` 关闭、keepalive 30s 均已接线

**openssh 传输**
- `test`/`exec`/`ls`/`read`/`put`/`get` 首次调用可用
- ControlMaster 复用生效（首次 952ms → 复用 117~134ms），会话结束 `-O exit` 收掉 master，无孤儿进程
- 密码认证、`ssh_sudo` 明确拒绝并指路

**扫描建连**
- `parseSshConfig`：多别名拆分、去引号、端口、`ProxyJump`/`PKCS11Provider` → `needsOpenSsh`、通配与否定模式不产出候选
- 项目文件扫描：`.env*`/`Jenkinsfile`/`deploy/`，跳过 `node_modules`
- `saveHostCandidate`：skip / rename / overwrite，覆盖保留 id
- **先测后写**：坏端口不落盘、无半成品；好候选写入后 0600

**配置与凭据**
- 主机配置 0600 原子写、mtime 缓存、外部改动可读
- `secrets`：0600 原子写；**文件损坏时拒绝覆盖**（不会盖掉其他主机密码）
- `doctor`：node/ssh2/openssh 三件套/known_hosts/审计目录/钥匙串，逐项如实报告

**FTP**（在绕过 P0-3 后验证）
- 登录、MLSD 列表、上传（字节数核对）、覆盖备份（带时间戳）、下载、REST 续传（半截 `.part` 续上后完整）
- `exec` → `UnsupportedError`「只能传文件」；`read` → `UnsupportedError`
- `active: true` → `UnsupportedError`（basic-ftp 5 无主动模式，不假装支持）

---

## 6. 建议修复顺序

1. **P0-1**（一行 filter，tar 部署复活）
2. **P0-2**（目录校验，防进程崩溃）
3. **P0-3**（FTP 密码链路，FTP 才有意义）
4. **P0-4**（openssh stdin，openssh 传输才可用）
5. **P0-5**（deploy/rollback 走 RemoteRunner，openssh/FTP 主机不被误连）
6. **P1-3 + P1-1 + P1-2 + P1-4**（回滚与失败路径的正确性，这四条都直接决定「出事时能不能救回来」）
7. **P1-5 + P1-6 + P1-10 + P1-11**（可观测性：指纹、spillPath、审计字段）
8. **P1-7 + P1-8 + P1-9**（openssh 补齐 get 校验/流式/预算）
9. **P1-12 + P1-13**（看门狗：dash 下改用 `setsid` + 显式 pgid，或先探测 `set -m` 真实可用性再决定分支，并把降级警告写进 stderr）
10. **P2 系列**（补 `/ssh scan`、`/ssh config`、`transport` 参数、`capabilities`/`verified`、`ftp-srv` 测试依赖）

---

## 7. 附：与设计文档的口径差异（文档需同步）

设计 §16 的多条「已修复」声明与实测不符，建议在文档里改正，避免下次评审继续以为已修：

- 「§6.2 看门狗：先 `exec 3<&0` … 本机 `sh` 实跑验证」→ 真机 dash 下组杀无效（P1-12）
- 「§4.2 openssh 的 `ssh_ls`/`ssh_read` 走 `sftp -b -`」→ 属实；但同段未提 `execOpenSsh` 的 stdin 缺陷（P0-4）
- 「§4.1 三条上传路径对齐」→ FTP 路径的密码解析没对齐（P0-3）
- 「§8 清理旧版本用 `plan.releasesDir`」→ 属实；但 tar 分支本身跑不到清理（P0-1）
- 「§6.3 生产主机的 destructive 改成动作之前写审计」→ 属实，但同时保留了动作后那条，变成两条（P1-10）
- 「§8 步骤 5 健康检查改成远端循环」→ 属实；但 `ssh_rollback` 完全没接健康检查（P1-2）
