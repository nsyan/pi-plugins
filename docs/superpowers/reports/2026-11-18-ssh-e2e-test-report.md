# @nsyan/ssh 真机全量功能测试报告

日期：2026-11-18
被测代码：`packages/ssh`（M1–M8 全量实现 + P0/P1 修复）
对照文档：`docs/superpowers/specs/2026-11-18-ssh-plugin-design.md`
真机：`root@10.2.9.58`（Ubuntu 20.04，kernel 5.4，`/bin/sh` → dash，sshd 22，sudo 免密，9001 端口有 nginx）
本地：macOS + Node 22.19，openssh 三件套齐全，`ftp-srv` 4.6.3 起本地 FTP

> **2026-11-18 修复后复测：5 个 P0 + 13 个 P1 全部修复并真机验证通过（27/27），单测 113 → 128。**
> 修复明细与复测结果见文末 §8。

## 0. 测试方式

| 层 | 内容 | 结果 |
|---|---|---|
| 单元测试 | `npx tsx --test "test/**/*.test.ts"` | **128 pass / 0 fail** |
| 类型检查 | `npx tsc -p tsconfig.typecheck.json` | **0 error** |
| 真机 E2E（首轮） | 直接驱动 `createRuntime()` / `Ssh2Pool` / `transports/*` / `core/*`，不打桩，连 10.2.9.58 实跑 | 发现 5 P0 + 13 P1 |
| 真机 E2E（复测） | 同一批用例 + 逐条 P0/P1 回归 | **27/27 通过** |
| FTP 集成 | 本地 `ftp-srv` 起 21xx 端口，测登录/列表/上传/覆盖/下载/续传/能力降级 | 通过 |

E2E 脚本：`/tmp/pi-ssh-e2e/harness*.ts`、`v1..v26.ts`、`retest.ts`（可复跑）。
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

---

## 8. 修复与复测（2026-11-18 第二轮）

### 8.1 修复清单

**P0**

| # | 问题 | 修复 | 复测 |
|---|---|---|---|
| P0-1 | `tar -tzf` 末尾空行被当成越界成员，任何合法 tar 包都整包拒绝 | `rejectArchiveMembers` 先 `map(trim)` 再 `filter(v => v !== "")`，空行不参与判定；越界成员仍逐个点名 | ✅ 真 tar 包全流程部署成功，子目录文件解包完整，`.part` 清理干净 |
| P0-2 | `ssh_put` 传目录 → `EISDIR` 逃成 unhandledRejection，进程崩溃 | `sha256File` 先 `stat().isDirectory()` 拒绝并提示「先打包」；同时把 `readableWebStream()` 换成 `createReadStream` 异步迭代，错误落回 await | ✅ 抛 `Error: ...是目录...先打成压缩包`，进程存活、后续调用正常 |
| P0-3 | FTP 把 `file:...#name` 引用当密码发出去，生产路径必然 530 | `ftp.open()` 改用 `profile.auth.password`，只对裸串 `secretRef` 兼容；runtime 侧 4 处 `withPassword` 全部换成 `resolveProfile`（含 keychain） | ✅ 用真实 `file:` 引用登录成功，服务端收到明文 `p`；上传/列表/下载全通 |
| P0-4 | openssh 复用 ControlMaster 后返回 143 + 空输出（4/5 概率） | `execOpenSsh`/`copyOpenSsh` 的 stdin 从 `ignore` 改为 `pipe` 且不 `end()`，watchdog 的 `exec 3<&0` 才拿得到长连接 | ✅ 连续 5 次全部正确输出；大输出（3000 行）完整 |
| P0-5 | `deploy`/`rollback` 只走 ssh2，openssh 静默降级、FTP 报 `ECONNREFUSED` | 新增 `runnerFor(host)`：openssh → `opensshRunner` + `scpPutVerified`；ssh2 → `poolRunner` + `pool.put`；FTP → `UnsupportedError` | ✅ openssh 的 file/tar 两种剧本都成功；FTP 明确报「只能传文件，不能部署或回滚」 |

**P1**

| # | 修复 | 复测 |
|---|---|---|
| P1-1 | 回滚候选过滤 `.part`，显式传 `.part` 也拒绝 | ✅ 有 `.part` 残留时正确回到 `r1`；`to: "zzz.part"` 被拒 |
| P1-2 | `ssh_rollback` 补健康检查，确认框写明；失败报错并保留 `current` | ✅ `healthCmd: "false"` 时抛「健康检查未通过」 |
| P1-3 | 文件回滚同时找 `<path>.bak.*` 与 `<root>/.pi-ssh-backup/<rel>.*`，失败时列出找过的位置 | ✅ 两个位置都能恢复；无备份时报错含「找过」 |
| P1-4 | 重启失败走与健康检查同一条 `fallback`；回退时的重启用 `tryRun`，不再掩盖「已回退」 | ✅ `restartCmd: "exit 7"` 时 `rolledBack: true`，`current` 回到 `good1` |
| P1-5 | 池新增 `fingerprintOf()`，连接复用时从池里取回指纹 | ✅ 已连接后 `testHost` 指纹非空且与首次一致 |
| P1-6 | 传输层预算改为「加上本块之后」判定；runtime 回填 `spillPath` | ✅ `seq 1 3000` 的 `spillPath` 存在且全文完整；传输层 2500 行也落盘 |
| P1-7 | 新增 `getOpenSsh`：scp 后双端 sha256 比对 | ✅ 返回真实 bytes/sha256，与本地文件一致 |
| P1-8 | `execOpenSsh` 支持 `onData` 并接到 runtime | ✅ 4 次 `onData` 分片到达 |
| P1-9 | openssh 输出经 `tail()` 统一截断并落盘 | ✅ `seq 1 5000` 标记截断并给出可用路径 |
| P1-10 | 生产主机 destructive 只在动作前写一条；动作后的那条跳过 | ✅ 一次动作一条审计 |
| P1-11 | `put`/`get` 审计补 `bytes`/`sha256`/`backupPath` | ✅ 三个字段都有值，覆盖时 `backupPath` 存在 |
| P1-12 | 看门狗改判 `$-` 而非 `set -m` 退出码；无 job control 时用 `setsid` 建独立进程组 | ✅ dash 远端 `sleep 301 & sleep 302` 超时后无残留；abort 同样 |
| P1-13 | 既无 job control 也无 `setsid` 时写 stderr 警告并置 `PI_SSH_NO_GROUP`，watcher 跳过组杀 | ✅ 正常命令无噪音；降级分支可判定 |

**额外修复（复测中发现）**

- `wrapSudo` 的 heredoc 原先嵌在 `sh -c '...'` 引号内，`$PI_SSH_PW` 到不了内层 shell（未 export）。改为 heredoc 挂在最外层调用（子 shell 或 `setsid`）上，密码正确送达且不被二次展开。
- openssh 传输对老服务器会打 4 行 post-quantum 警告到 stderr，混进结果让「退出码 0」看起来像失败。新增 `stripSshNoise` 过滤，真实 stderr 保留。

### 8.2 复测结果

```
########## P0 回归 ##########        5/5  PASS
########## P1 回归 ##########       15/15 PASS
########## 原有功能未回归 ##########  3/3  PASS
===== 复测汇总：27/27 通过 =====
```

单测：**128 pass / 0 fail**（原 113 + 新增 15）
类型检查：**0 error**

新增用例覆盖：`rejectArchiveMembers` 尾空行、`sha256File` 拒目录、看门狗 `$-` 分支与 setsid、sudo heredoc 位置、`stripSshNoise`、备份位置两套规则。

### 8.3 仍存在的偏差（P2，未修）

首轮报告 §4 的 P2 系列（`/ssh scan` 与 `/ssh config` 子命令缺失、`ssh_host_save` 无 transport 参数、`capabilities`/`verified` 字段未实现、`waitFor` 无本地回退、`ftp-srv` 未进 devDependencies 等）本轮未动，属功能补全而非缺陷，建议后续单独排期。

---

## 9. 发布与安装核验（2026-11-18 收尾）

代码与文档已同步，但**发布链路踩了一次坑**，记录在此避免复发：

| 检查项 | 结果 |
|---|---|
| npm 官方 registry `dist-tags.latest` | `0.1.1`（首个含 P0/P1 修复的版本；`0.1.0` 无这些修复） |
| `0.1.1` tarball shasum | `e1c654e65edd2454ec92b05672cd8b2c4163507a`（26 文件 / 148.1 kB） |
| 发布包内容与仓库 `src/`、`index.ts` | `diff -rq` 完全一致，5 个 P0 修复均在包内（`rejectArchiveMembers` 滤空行、`sha256File` 拒目录、`ftp.open` 用 `auth.password`、openssh `stdio: pipe`、`runnerFor`） |
| 与 `0.1.0` 对比 | `0.1.0` 无任何 P0 修复（`stdio: ["ignore"]`、无 `runnerFor`、无目录校验），**0.1.0 是坏版本，不要装** |
| 修复批次归属 | 第一轮 P0/P1 修复**全部包含在 0.1.1**；后续 `0.1.2`（管理面板）与 `0.1.3`（第二轮真机回归的 4 个 bug，见 §10）各自独立成版 |
| `registry.npmmirror.com` | `latest` 一度仍指向占位包 `0.0.0-stage`；需 `curl -X PUT .../syncs` 触发回源，之后 `latest = 0.1.1` |

**踩坑现象**：`~/.npmrc` 指向 npmmirror，`pi install npm:@nsyan/ssh` 按 `^0.0.0-stage` 解析到占位包，装出的是只有 `package.json` + `README.md` 的空壳（`"stub": true`，无 `index.ts`）。表现为插件页「已安装 0.0.0-stage」、**已解析资源为空**、13 个 `ssh_*` 工具全部不注册——而 pi 只在启动日志里静默记一条加载失败，界面上看起来是装好的。

**判断装对没有**：`ls ~/.pi/agent/npm/node_modules/@nsyan/ssh` 必须有 `index.ts` 与 `src/`；`~/.pi/agent/npm/package.json` 里应是 `"@nsyan/ssh": "^0.1.x"`。

**修复步骤**：

```bash
curl -X PUT https://registry.npmmirror.com/-/package/@nsyan/ssh/syncs   # 让镜像回源
pi update npm:@nsyan/ssh                                               # 0.0.0-stage -> 0.1.1
```

或绕开镜像：`npm install @nsyan/ssh@latest --registry=https://registry.npmjs.org`。

> 教训：**发版后先验镜像**。占位包占着 `latest` 时，镜像用户拿到的不是旧版而是空壳，比「版本落后」危险得多。`0.0.0-stage` 这类暂存包应在正式版发布后 `npm deprecate` 或直接 `unpublish`。

---

## 10. 第二轮真机全功能回归（2026-11-18，对照设计文档逐项跑）

第一轮是「找 P0/P1 并修」；这一轮是**按设计文档 §8/§9 把 13 个工具、两条传输、全部策略分支真机跑一遍**，确认修复真的落地、并找残余问题。

- 真机：`root@10.2.9.58`（Ubuntu 20.04.6，kernel 5.4，`/bin/sh` → dash，有 `setsid`/`bash`/`nc`/`curl`/`wget`/`sha256sum`，sudo 免密，9001 有 nginx）
- 凭据：**全程用密钥**（`~/.ssh/id_ed25519_pi_szzf-58`），未使用也未索取密码
- 环境：`/tmp/pi-ssh-e2e-20261118`（测后已清理，无残留进程与目录）
- 单测：149 → **182**；`tsc` **0 error**

### 10.1 本轮新发现的 4 个 bug（已修）

| # | 问题 | 真机复现 | 影响 |
|---|---|---|---|
| N-1 | 确认框**不显示执行理由** | `ask()` 签名无 `reason` 参数；`ssh_exec` 的 reason 只进审计 | 用户被要求确认，却看不到「为什么执行」 |
| N-2 | 确认框把**多行命令挤成一行** | 截图反馈：`set -e TS=... BASE=... rm -rf ...` 全糊在一起 | 纯文本 SelectList 折叠单换行，多行脚本无法核对 |
| N-3 | **中文输出变替换符** | `ssh_read` 读 600KB 中文 → 174762 字符且含大量 U+FFFD | 日志/配置里的中文读出乱码；根因是逐块 `chunk.toString("utf8")` 切断多字节字符，**不是** `clipUtf8` |
| N-4 | **只读模式漏放写命令** | readonly 下 `mkdir -p /tmp/x1` **执行成功**（`/tmp/x1` 真的被创建） | `mkdir`/`touch`/`ln`/`git checkout -- .` 未被 `classify()` 识别为写，「只读」承诺失效 |

另补一个设计边界：openssh 传输的 `test` 原本恒返回空指纹。现用 `ssh-keyscan` 取密钥并按 ed25519 优先排序，**与 ssh2 报出的指纹完全一致**（`SHA256:Gi3H0…`，与 `ssh-keygen -F` 对照通过）。不排序会取到同机的 ECDSA 密钥，导致两条传输报不同指纹。

### 10.2 逐项通过清单

**执行与输出**
- 只读命令 / `cwd` 生效 / stderr 分离 / 非零退出码（42）原样透传 / dash 语法
- `seq 1 3000` → 截断 + 落盘，落盘文件 **3000 行完整无缺失**（`comm` 校验）
- `waitFor` 三条件：port 就绪/未就绪（退出码 1）、http、file 存在/不存在

**传输**
- `ls` 结构化；`read` offset/limit/越界；空文件；无尾换行
- 600KB 单行 CJK → 修复后**零替换符**
- `put` 小文件/3MB 二进制 sha256 双端一致、无 `.part` 残留
- `put` **传目录** → 「是目录…先打成压缩包」，**进程存活**
- 覆盖 4 次 → 备份只留最新 3 份
- `get` 小文件/3MB sha256 与远端一致；不存在的文件报错

**部署与回滚**
- `dryRun` 不碰远端（releases 为空、无 `current`）
- tar 部署成功：子目录完整、`.part` 清理、`shared/` 未被写（P0-1 确认）
- 健康检查失败 → **自动回退**，`rolledBack: true`，`current` 回到部署前版本
- release 回滚跳过 `.part` 残留；显式指定 `.part` 被拒；`../evil` 被拒
- **文件回滚从 `.pi-ssh-backup` 成功恢复**；无备份时报错**列出找过的两个位置**
- openssh 传输下 tar 与 file 两种剧本都成功（P0-5 确认）
- FTP 主机的 `deploy`/`rollback`/`exec`/`read` 全部 `UnsupportedError`，不再是误导性的 `ECONNREFUSED`

**策略与审计**
- 生产主机：缺 `reason` 拒、**拒绝授予会话级写授权**、destructive 一次动作只写 **1 条**审计（P1-10 确认）
- 只读模式：read 放行；write/destructive/sudo/put/deploy/rollback 全部拒绝
- 用户拒绝确认 → `ConfirmRejectedError`，且**命令确实没执行**（探针文件 `STILL_THERE`）
- `put` 审计含 `bytes`/`sha256`/`backupPath`（P1-11 确认）
- `test` 已连接后指纹非空、延迟 20ms（P1-5 确认）

**看门狗**
- dash 远端超时 → `sleep 300/301` **无残留**
- 命令内部 `setsid` 派生 → **有残留**（见 10.3）

**隧道**
- local：本机 54588 → 远端 9001，HTTP 200 / 2063 bytes
- remote：远端 18081 → 本机 18080，HTTP 200 / 16591 bytes

**openssh 传输**
- `test` 指纹与 ssh2 一致（修复后）
- ControlMaster 复用后连续 5 次 exec **全部正常**，无 143 / 空输出（P0-4 确认）
- 大输出截断落盘；中文输出无替换符

**扫描建连**
- `ssh_scan_sources` 扫出 `.env` 与 `deploy/`
- 同名 `skip` 生效；坏端口「先测后写」**未落盘**

### 10.3 仍存在的缺陷（本轮未修）

**命令内部自己 `setsid` 派生的进程会逃出看门狗进程组**：

```
$ setsid sh -c 'sleep 302; echo LEAKED2 > /tmp/marker' & echo spawned; sleep 300
（超时后）
$ ps -ef | grep "sleep 302"
root 13351  1  sh -c sleep 302; ...
root 13353  13351  sleep 302      ← 仍然活着
```

普通超时、`nohup`、`&` 派生都能清掉，但 `setsid` 建了**新会话**，`kill -TERM -$pid` 打不到。这是 P1-12 的残余场景。

修法有两条，都不便宜：① `pkill -P` 递归杀子进程（仍有竞态，且 `setsid` 后父子关系已断）；② 用 cgroup v2 把命令关进独立 cgroup（Linux 限定，且需要写权限）。**建议先按现状记入文档**，等真有长任务场景再评估。

### 10.4 结论

第一轮的 5 P0 + 13 P1 全部确认修复；本轮又找出 4 个新 bug（确认框信息缺失 2 个、编码 1 个、策略漏判 1 个），已全部修完并加回归测试。策略层这次的漏判值得单独记一笔：**`classify()` 的「写」规则是白名单式的**，漏一个命令就等于只读模式放行一条写路径，新增命令识别时务必同步补单测。

---

## 11. 面板（0.1.2 大改动）的回归覆盖说明

§10 那轮真机回归主要跑的是**工具层**（13 个 `ssh_*`）。`0.1.2` 引入的 `/ssh` 管理面板是另一条路径（`src/ui/panel.ts`，约 1000 行），它的验证层次与前几轮不同，这里明确交代边界，避免下次升级时误判「已覆盖」。

### 11.1 面板覆盖了什么

- **单测**：`test/panel.test.ts`（33 项）覆盖纯函数与路由——`parseHostSpec`（含 IPv6 与端口越界）、`withProdTag`、`hostSummaryLine`/`buildHostList`（活动主机置顶）、`authSummary`（密码只说有没有保存）、`hostDetailLines`、`policyLines`/`effectivePolicy`、`auditLines`（过滤/截断/退出码）、`buildProfile`（编辑保留字段、换认证清引用）、`describeTestResult`，以及用**假 `ctx.ui`** 跑通 `/ssh` 无参开面板、`ls`/`config`/`rm`/`use`/`grant`/未知子命令的路由与写盘；另有 4 条写盘边界回归（改名时密码只落最终名字、改名时密码条目与活动指针一起迁移、传输方式按名字解析、实测失败不写盘且回滚密码）
- **真机**：`0.1.3` 那轮用 `runtime.*` 直驱跑了工具层，**面板本身没有在真机 TUI 里逐项点过**

### 11.2 为什么面板不能只靠单测

面板的真实风险在**渲染与交互**，而假 `ctx.ui` 测不出来：

| 风险 | 单测能否发现 | 说明 |
|---|---|---|
| 菜单项与实际分支不一致 | 部分 | 假 `ctx.ui` 只回放预设选择，点错分支不会暴露 |
| `select` 在 pi web（RPC）下不可用/降级 | 否 | RPC 没有 TUI 的 `custom`，行为不同 |
| 掩码输入在 RPC 下退化成明文 | 否 | 需要真实通道才能观察 |
| 多级菜单的返回/取消死循环 | 否 | 需要真实交互 |
| 长标题/长主机名把菜单撑破 | 否 | 渲染层问题 |
| 写盘后活动指针/密码条目残留 | 是 | 这 4 条已单测覆盖 |

### 11.3 面板的真机回归清单

已单独整理成 **`ssh-regression-checklist.md` §1**（10 个小节：顶层面板、单台二级菜单、新增主机、编辑与改名、更新凭据、部署布局、策略设置、审计日志、子命令一致性、pi web 降级）。

**下次发版前必须人眼过一遍 §1**，特别是：
- §1.3 的「坏端口不落盘」与「未知指纹先核对」
- §1.4 的「编辑不抹 `deploy`/`tags`」与「改名迁移活动指针」
- §1.9 的子命令与面板**行为一致**（这是 0.1.2 的核心设计目标：不分叉）
- §1.10 的 pi web 降级

### 11.4 结论

`0.1.2` 面板的**逻辑正确性**有单测兜底（33 项 + 4 条写盘边界），**交互与渲染**目前只有代码审查，没有真机记录。这是一处已知的验证缺口，已写进回归手册而不是假装覆盖过。
