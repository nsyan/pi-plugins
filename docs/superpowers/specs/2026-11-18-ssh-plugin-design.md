# ssh 插件（SSH/SFTP/FTP 远程运维与部署）— 设计文档

日期：2026-11-18
状态：草案，已按 2026-11-18 评审修订（见文末修订记录）
范围：`pi-plugins/packages/ssh`（新包）

---

## 0. 决策记录（评审已拍板）

1. **只选 A**：只新增 `ssh_*` 工具，**不接管** pi 内置 `read/write/edit/bash`。
   模型必须显式调用 `ssh_*`，「这条命令跑在哪一侧」永远一眼看清。
2. **危险操作必须用户确认、可审计、可回滚**。
3. **取各家所长**：ssh2 的纯 JS 跨平台 + SFTP（@patimweb）、进程组看门狗与 sudo 掩码对话框（@sdillen）、
   输出预算与流式回传（pi-ssh-remote）、`~/.ssh/config` 的 ProxyJump/agent/MFA 继承（@99percentpeople 的 auto 思路）、
   policy/审计/确认弹窗/系统提示注入（本仓库 db 插件）。
4. **FTP 也要**（FTP + FTPS explicit/implicit），与 SSH 走同一个传输抽象。
5. **自动建连 + 管理面板**，对齐 db 插件：`/ssh` 菜单 + `ssh_scan_sources`/`ssh_host_save` 两步 AI 扫描建连。
6. **密码永不进模型上下文**：工具 schema 里没有 password 字段；密码只经掩码弹窗进入 keychain/0600 文件。

## 1. 背景与目标

现状：pi 生态 9 个 SSH 插件没有一个把「部署」当一等公民，且普遍缺审计、缺确认、缺回滚。
真实部署会话（hsybp → 10.2.9.58，933 条记录）的量化证据：

| 指标 | 数值 | 暴露的缺口 |
|---|---|---|
| `ssh_exec` | 63 次 | 每次新连接，无复用（约 9.5s 纯握手开销） |
| `ssh_upload` | 13 次 | 无进度、无校验、静默覆盖 |
| `ssh_download` | 0 次 | 看日志只能 `cat`，输出截断无法落盘 |
| `rm`/`docker rm -f` | 4 次 | 无确认、无审计 |
| `sed -i` | 4 次 | 改远端文件无备份 |
| `nohup ... &` + 手动 `sleep` 轮询 | 5 + 9 次 | 无结构化等待、无进程生命周期管理 |
| JDK8 装错需重装 JDK21 | 1 次 | 无回滚 |

目标：

1. **一套工具覆盖远程运维全流程**：连、看、改、传、部署、回滚、转发。
2. **危险操作默认拦截**：确认弹窗说清「这条命令会做什么」，用户点头才执行。
3. **全程可审计**：每次远端动作追加 JSONL。
4. **可回滚**：文件覆盖前备份；部署以 release 目录 + 软链切换为单位，失败自动回退。
5. **管理面板 + 自动建连**：`/ssh` 交互式管理；AI 扫描 `~/.ssh/config` 与项目部署文件建连，逐个确认后写盘。
6. **核心零 pi 依赖**：`src/core` 与 `src/transports` 不 import 任何 pi 模块，为将来输出 MCP server 铺路（与 db 包同一约定）。

明确的非目标（本期不做）：

- 接管内置工具（B 模式）—— 明确排除，不留开关。
- rsync 协议实现（需要时用 `ssh_exec` 调远端 rsync，或本机 rsync over openssh 传输）。
- ssh-agent 协议实现（openssh 传输免费继承；ssh2 传输明确报「不支持 agent，请用密钥文件或切 openssh」）。
- MCP server 壳（只在包结构上预留零依赖边界）。
- 交互式全屏 TTY 会话（`top`/`vi` 这类）；sudo 走掩码弹窗 + `sudo -S`，不走 TTY。
- SFTP 断点续传（FTP 的 REST 本期要做；SFTP 续传放二期）。
- 目录逐文件上传。多文件先在本地打包成一个压缩包，再 `ssh_put` 或 `ssh_deploy`。工具 description 写死这条。

## 2. 包结构与依赖边界

```
packages/ssh/
├── index.ts                     # 只做注册工具/命令/事件与提示注入，不写菜单逻辑
├── package.json                 # name: @nsyan/ssh；pi.extensions + pi.skills
├── src/
│   ├── core/                    # ★ 零 pi 依赖
│   │   ├── types.ts             # HostProfile / ExecResult / Error 子类
│   │   ├── config.ts            # ~/.pi/agent/ssh-hosts.json（0600 原子写 + mtime 缓存）
│   │   ├── secrets.ts           # 凭据存取：keychain 优先，0600 文件兜底
│   │   ├── policy.ts            # 命令危险度分级（纯函数）
│   │   ├── audit.ts             # JSONL 追加
│   │   ├── known-hosts.ts       # 解析/校验 ~/.ssh/known_hosts（含哈希条目）
│   │   ├── keys.ts              # ed25519 生成 + OpenSSH 私钥格式
│   │   ├── pool.ts              # 连接池（按 host 复用，TTL + 上限）
│   │   ├── output.ts            # 截断预算 + 落临时文件
│   │   └── deploy/
│   │       ├── plan.ts          # 部署剧本：步骤生成（纯函数，可 dryRun）
│   │       ├── guard.ts         # 路径越界校验
│   │       └── release.ts       # release 目录/软链/保留数
│   ├── transports/              # ★ 零 pi 依赖
│   │   ├── transport.ts         # interface Transport
│   │   ├── ssh2.ts              # ssh2 + sftp 子系统
│   │   ├── openssh.ts           # spawn("ssh"/"scp")，继承 ~/.ssh/config
│   │   └── ftp.ts               # basic-ftp：FTP / FTPS
│   ├── scan/
│   │   └── ssh-config.ts        # 只解析 ~/.ssh/config；项目文件不在插件里解析
│   ├── tools/                   # 薄壳，每个一个文件
│   └── ui/
│       ├── masked-input.ts      # 密码掩码输入（TUI 组件；RPC 下降级）
│       ├── confirm-exec.ts      # 危险命令确认弹窗（Markdown，TUI/web 双渲染）
│       └── panel.ts             # /ssh 管理菜单
├── skills/
│   ├── remote-ops/SKILL.md
│   └── deploy/SKILL.md
└── test/                        # node:test + tsx，对齐 db 包
```

依赖：运行时 `ssh2`、`basic-ftp`；`typebox` 为 peer（对齐 db 包）。
无构建步骤：`"test": "tsx --test \"test/**/*.test.ts\""`，TS 由 pi/tsx 直接加载。

### 2.0 依赖方向（硬约束，lint 级）

```
index.ts → tools → core、transports、ui
ui → core
tools 不得互相 import（共享逻辑下沉 core）
core、transports、scan 不得 import @earendil-works/* 与 ./ui
```

## 3. 核心类型

```ts
// core/types.ts
type TransportKind = "ssh2" | "openssh" | "ftp" | "ftps";
type AuthKind = "key" | "password" | "agent";   // agent 仅 openssh 传输可用

interface HostProfile {
  id: string;
  name: string;                    // 模型与用户都用这个名字引用
  transport: TransportKind;
  host: string;
  port?: number;                   // 缺省：ssh 22 / ftp 21 / ftps implicit 990
  user: string;
  auth: { kind: AuthKind; secretRef?: string; privateKeyPath?: string; passphraseRef?: string };
  strictHostKey?: boolean;         // 缺省 true；false 仅限一次性实验机
  secure?: "explicit" | "implicit"; // 仅 ftps
  tags?: string[];                 // 含 "prod" 时危险命令确认升级为必填 reason
  defaults?: { cwd?: string; timeoutSec?: number };
  deploy?: DeployLayout;           // 见 §8
  createdAt: string;
  lastUsedAt?: string;
}

interface DeployLayout {
  root: string;                    // 例 /srv/app；越界守卫的边界
  releasesDir?: string;            // 缺省 releases
  currentLink?: string;            // 缺省 current
  sharedDir?: string;              // 缺省 shared。跨版本文件（env、上传目录）放这里，剧本不覆盖、切软链不碰
  restartCmd?: string;
  healthCmd?: string;              // 退出码 0 视为健康
  keepReleases?: number;           // 缺省 5
}

interface TransferResult {
  bytes: number;
  sha256: string;                  // 本地在传输流上计算，不传完再读一遍盘
  verified: "both" | "local-only"; // ssh 双端一致为 both；ftp 无法远端哈希，为 local-only
  backupPath?: string;             // 覆盖前备份位置（可回滚凭据）
}

interface ExecResult {
  stdout: string; stderr: string;
  exitCode: number | null;
  truncated: boolean;              // 超出预算，全文在 spillPath
  spillPath?: string;
  durationMs: number;
}


```

## 4. 传输层

```ts
// transports/transport.ts
interface Transport {
  readonly kind: TransportKind;
  readonly capabilities: { exec: boolean; sudo: boolean };  // ftp/ftps 两者皆 false
  exec(cmd: string, opts: ExecOpts): Promise<ExecResult>;
  put(local: string, remote: string, opts?: TransferOpts): Promise<TransferResult>;
  get(remote: string, local: string, opts?: TransferOpts): Promise<TransferResult>;
  list(dir: string): Promise<RemoteEntry[]>;
  rename(from: string, to: string): Promise<void>;   // 部署切软链、.part 转正都靠它
  remove(path: string): Promise<void>;
  close(): void;
}
interface ExecOpts {
  cwd?: string; timeoutSec?: number; signal?: AbortSignal;
  onData?: (chunk: string) => void;     // 流式；调用方决定是否转 onUpdate
  stdin?: string;                        // sudo -S 喂密码用，内容不入审计明文
}
```

### 4.1 ssh2 传输
- 认证顺序 `[publickey, password]` 自控，`authHandler` 逐个 offer，最后被接受的即真实认证方式（回报给 `ssh_hosts test`）。
- 主机密钥校验 fail-closed 四态：`match | unknown | changed | revoked`。
  `unknown` 不自动接受——抛 `HostKeyUnknownError` 携带指纹。
  **`acceptNewHostKey` 只存在于 `ssh_hosts test`、`/ssh add`、`ssh_host_save`**，`ssh_exec` 等执行工具没有这个参数；
  执行中遇到未知指纹就停，指引去 `ssh_hosts test` 核对。`changed`/`revoked` 直接硬失败，提示 `ssh-keygen -R`。
- 读写 OpenSSH 自己的 `~/.ssh/known_hosts`（端口非 22 用 `[host]:port`），与系统 ssh 互通。
- SFTP：`fastPut`/`fastGet` 带 `step` 进度回调。本地 sha256 在传输流上计算，不传完再读盘。
  上传先写 `<target>.part`，远端 `sha256sum` 一致才 `rename` 转正；不一致保留 .part，原文件不动。
  覆盖前把原文件 `rename` 到备份目录（§6.4），这是元数据操作，不会把内容再复制一份。
- keepalive：`keepaliveInterval` 30 秒。空闲后的半开 TCP（NAT 掐断）靠这个发现，而不是只看 socket 可读。
- exec 走进程组看门狗（§6.2）。
- 一条 TCP 上多路 channel，同一主机同时最多 6 个（exec 与 SFTP 都算）。长命令占 1 个 channel，不堵住后续调用。

### 4.2 openssh 传输
- `spawn("ssh", ["-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", "ControlPath=~/.pi/agent/ssh-cm/%C",
  "-o", "ControlPersist=5m", "-o", "ServerAliveInterval=30", ...])`。**零协议代码**，因此 `~/.ssh/config` 的 Host 别名、
  `IdentityFile`、`ProxyJump`、ssh-agent、证书全部继承。`BatchMode=yes` 会拒绝密码和键盘交互：
  需要密码或 MFA 的主机不要选 openssh，改用 ssh2，并在结果里明确失败。
  `ControlPath` 必须给出，否则 `ControlMaster=auto` 不会复用连接。ProxyJump 后面的主机因此不用每次 scp 都重新握手。
- 文件传输用 `scp`（同样继承 ssh config 与 ControlMaster）；原子性与校验在远端补：先 scp 到 `.part`，
  再 ssh 远端校验 + `mv`。远端哈希按 `sha256sum` → `shasum -a 256` → `openssl dgst -sha256` 依次探测，
  三个都没有才失败。ssh2 传输同样走这个顺序。
- `ssh_ls` / `ssh_read` 不走 `scp`，也不解析 `ls` 文本。列表与按行读取用 `sftp -b -` 批处理
  （`ls -l` 的 SFTP 协议输出、`get` 到临时文件再按行切），同一条 ControlMaster 连接，不另开握手。
- 选择条件见 §4.4。本机没有 `ssh` 二进制时该传输不可用，`ssh_doctor` 如实报告。

### 4.3 ftp / ftps 传输
- `basic-ftp`。`exec` 直接抛 `UnsupportedError`——**能力声明，不假装支持**；
  工具层据此拒绝 `ssh_exec` 并在 description 中说明该主机仅文件传输。
- `secure: "explicit"`（AUTH TLS，21）与 `"implicit"`（990）都支持。
- 目录列表走 `MLSD`（库已封装），不自行解析 `LIST`。
- 强制 `UTF8`；服务端拒绝时降级并在结果里标注编码。
- basic-ftp 5 只有被动模式。`active: true` 直接报错，不给出一个无法实现的切换开关。被动模式失败时说明网络原因，不自动重试。
- `.part` + `rename` 原子写、覆盖前备份，与 SSH 相同。
- **不做远端 sha256**。FTP 没有 exec，跑不了 `sha256sum`；回拉全文比对会让流量翻倍。
  完整性只核对「上传字节数 = 本地文件大小」，`TransferResult.verified = "local-only"`，审计里写明。
  需要双端哈希的制品走 SSH/SFTP，不走 FTP。
- 断点续传：`uploadFrom` 的 `localStart`/`remoteStart`（REST），大文件中断后可续。
- 控制连接串行排队。FTP 不能套用 SSH 的多路 channel。

### 4.4 传输选择（`auto`，保守）
1. 用户显式指定 `transport` → 照做，存进 profile。
2. `auto`（缺省）**每次连接时重查** `~/.ssh/config`，不把结果存进 profile。
   该主机存在 `ProxyJump` / `ProxyCommand` / `PKCS11Provider` / `SecurityKeyProvider` → openssh（ssh2 做不到这些）；否则 ssh2。
   用户事后改了 ssh config，下一次连接就生效。`ssh_hosts` 的 `action: "test"` 在结果里回报这次实际选中的传输。
3. `ftp://` `ftps://` 前缀的扫描候选 → ftp/ftps，这个是协议而不是优化，存进 profile。

## 5. 凭据

- 工具参数 schema **没有** password/passphrase 字段，模型物理上无法传递密码。
- `secretRef` 形如 `keychain:pi-ssh/<host>` 或 `file:ssh-secrets.json#<host>`。
- `src/core/secrets.ts`：读取已有项时，macOS 用 `security find-generic-password -w`，Linux 用 `secret-tool lookup`。
  写入不走 `security -w`：本机 `security` 不能从 stdin 收密码，把密码放进 argv 会留在进程表里。
  新密码一律落 `~/.pi/agent/ssh-secrets.json`（0600，原子写）。Linux 的 `secret-tool store` 可以走 stdin。
  都不可用时同样落这个文件，`ssh_doctor` 明确提示降级事实。
- 掩码输入：`src/ui/masked-input.ts` 基于 `ctx.ui.custom()` 的自绘组件（约 40 行，渲染时 value 替换为 `*`）。
  **RPC（pi-web）下 `custom()` 不可用**，退化为 `ctx.ui.input` 并先 `confirm` 告知「此通道不掩码，建议改用密钥」；
  用户坚持才继续。
- sudo 密码单独通道：掩码弹窗取得后只活在扩展进程内存，TTL 4 分钟，按 host 隔离，不落盘、不进审计明文、不进 details。

## 6. 安全三件套

### 6.1 危险度分级（`core/policy.ts`，纯函数）

```ts
type Danger = "read" | "write" | "destructive";
interface Verdict { danger: Danger; summary: string }   // summary 是给人看的「这条命令会做什么」

function classify(command: string): Verdict
function decide(verdict: Verdict, policy: Policy, host: HostProfile): "run" | "confirm" | "deny"
// decide 只用于 ssh_exec 与 ssh_sudo。
// ssh_put 的覆盖确认、ssh_tunnel 的非 loopback 确认由各自工具按 §9 处理，不塞进 classify。
```

判定规则（按序，先命中先返回）：

| 级别 | 命中 | 例子 |
|---|---|---|
| destructive | `rm -r/-f`、`docker rm/rmi/system prune`、`systemctl stop/disable/mask`、`mkfs`、`dd of=`、写重定向到 `/etc` `/boot`、`git reset --hard`、`git clean -fd`、`kill -9`、`reboot/shutdown/halt`、`userdel/groupdel`、`iptables -F`、`chmod -R 777`、`:(){:\|:&};:` | `docker rm -f hsybp-sjzt-web` |
| write | `sed -i`、`mv`/`cp` 到已存在目标、`install`、`chmod`/`chown`、`tee`、`truncate`、`systemctl restart/reload/enable`、`docker run/stop/restart`、`docker compose up/down`、包管理器 `install/remove`、输出重定向 `>` | `sed -i 's/NACOS_ADDR/...' env.sh` |
| read | 其余 | `systemctl status`、`ls`、`cat`、`df`、`docker ps` |

**已知局限（写进工具 description，不假装完美）**：分类基于正则，可被混淆绕过（变量拼接、base64）。
它是「提醒用户确认」的网，不是安全边界。真正的边界是：生产主机（tag 含 `prod`）上 `write` 及以上**一律确认**，
且 `destructive` 必须填写 reason（动机 + 影响范围），空 reason 工具层直接拒绝并引导补充。

`classify` 只看命令文本，不看远端状态。「目标文件是否已存在」由 `ssh_put` 先 stat，不写进 `classify`。

`decide` 结果：
- 全局只读模式 → `write` 及以上 `deny`；
- `confirm` 级别为 `destructive`（缺省）→ 仅 destructive 弹窗；`write` → write 及以上弹窗；`always` → 全部弹窗；
- 生产主机：`write` 及以上一律 `confirm`，不受级别调低影响（级别只能加严不能放松）；
- **会话授权**：用户可对某台**非生产**主机授权「N 分钟内 write 不再逐条确认」。授权本身要确认一次，只活在内存，
  `session_shutdown` 清掉，不落盘。`destructive` 不在授权范围内，每次都问。
  **tag 含 `prod` 的主机拒绝授予**，与上一条「只能加严不能放松」一致，不存在例外。
  用来避免一次部署里几十个 `mkdir` / `sed -i` 把人点确认的时间盖过握手省下的时间。

### 6.2 进程生命周期：看门狗
看门狗独占 fd 3，命令不读这条通道，避免和 sudo 抢 stdin。远端脚本：

```sh
if ! set -m 2>/dev/null; then
  echo 'pi-ssh: 远端 shell 不支持 set -m，超时只会关掉通道' >&2
  exec 3<&0
  exec 0</dev/null
  <cmd>
  exit $?
fi
exec 3<&0
exec 0</dev/null
( <cmd> ) &
pid=$!
set +m
(
  while read -r _ <&3; do :; done        # 通道关闭即 EOF
  kill -TERM -$pid 2>/dev/null; sleep 2; kill -KILL -$pid 2>/dev/null
) >/dev/null 2>&1 &
watcher=$!
wait $pid
status=$?
kill $watcher 2>/dev/null
wait $watcher 2>/dev/null
exit $status
```

先复制通道到 fd 3，再把 fd 0 指到 `/dev/null`，最后才把命令放进后台。后台命令继承的是 `/dev/null`，
只有后台 watcher 读 fd 3。watcher 如果放在前台，shell 会等通道 EOF，通道又等 shell 退出，两边互等。
通道关闭（超时、用户中止、会话结束）→ TERM 进程组 → 2 秒后 KILL。

`ssh_sudo` 不把密码放进 argv。客户端先在通道上写一行密码并保持通道不关；远端在把 fd 0 重定向之前
先 `read` 这一行，用管道喂给 `sudo -S -p ''`，然后才进入上面的看门狗循环。密码不进审计明文。

`timeoutSec` 缺省 120，上限 3600；部署类命令由剧本显式给足。
远端 `sh` 不支持 `set -m` 时，回退为「超时只关通道」，并在结果里明确警告。

### 6.3 审计（`core/audit.ts`）
追加到 `~/.pi/agent/ssh-audit.jsonl`（0600）：

```json
{"ts":"...","host":"prod-web-01","tool":"ssh_exec","danger":"destructive",
 "summary":"删除容器 hsybp-sjzt-web","command":"docker rm -f hsybp-sjzt-web",
 "confirmed":true,"reason":"重建 nginx 双端口","exitCode":0,"durationMs":1200}
```

- 命令文本保留（审计的意义就在于此），但 **stdin 内容（sudo 密码）替换为 `<redacted>`**。
- `ssh_put`/`ssh_get` 记录两端路径、字节数、sha256、backupPath。
- 审计失败**不阻断** read 与 write。
- **生产主机上的 destructive 反过来 fail-closed**：审计追加失败就拒绝执行，返回 `AuditUnavailableError`。
  「可审计」这条目标在最危险的场景下不允许失效。
- `ssh_doctor` 与面板在审计文件不可写时显示警告。

### 6.4 回滚
- **文件级**：`put` 覆盖已存在文件前，把原文件 `rename` 到备份目录，`TransferResult.backupPath` 返回给模型。
  `rename` 只改目录项，不复制内容；旧内容与新内容同时占盘是不可避免的，预检按这个算空间。
  备份目录与原文件跨文件系统时 `rename` 返回 EXDEV，降级为复制，并在结果里注明「这次备份是复制，多占一份空间」。
  备份位置：路径在 `deploy.root` 内时收到 `<root>/.pi-ssh-backup/<相对路径>.<ts>`，不留在 web 根目录；
  不在 `deploy.root` 内时放在同目录 `<name>.bak.<ts>`。
  回滚走下面统一的 `ssh_rollback`。
- **发布级**：切回上一个 release 并重启、复检健康。
- **清理分开**。`keepReleases` 只删旧的 release 目录。`.bak` 按路径保留最近 3 份，不占用 `keepReleases` 名额，
  也不允许清理逻辑越出备份目录。

## 7. 连接池与输出预算（性能）

### 7.1 连接池（`core/pool.ts`）
- 键：`profileId`。复用的是一条已认证的 TCP 连接，上面开多个 channel。
  **不得按 `host:port` 合并**：同一台机器的两个 profile（deploy 账号与运维账号）是两条连接，认证身份不能串。
- 同一主机同时最多 6 个 channel（exec 与 SFTP 都算）。长命令占 1 个，查日志、上传可以并行，不必等它结束。
- pi 会并行执行同一轮的多个 tool call，池必须能接住，不能假设调用串行。
- FTP 没有 channel，控制连接排队，不套用上面的 6 路。
- 空闲 TTL 5 分钟；`session_shutdown` 全部关闭。
- keepalive 见 §4.1 / §4.2。连接在命令还没写到通道之前被踢掉（sshd 的 `ClientAliveInterval` 更短、NAT 掐断、socket error）时，丢掉这条连接并重连一次，然后重新做主机密钥校验。
  命令已经发出、退出码还没回来时不重连：`rm`、切软链重跑一次就是执行两次。重连失败才把错误返回模型。
- 预期收益：部署会话那种 63 次调用，握手开销从 ~63 次降到 1~2 次，且一次长命令不会堵住这台主机。

### 7.2 输出
- 预算 50KB / 2000 行（取 pi 导出的 `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`），命令输出用 `truncateTail`。
- 超出部分全文落临时文件，结果末尾告知路径，模型可用 `read` 续看。
- 流式：`onData` → 工具 `onUpdate`，TUI/RPC 下实时可见；`ctx.hasUI === false`（print/json）时只累积最终结果。
  **合并窗口**：`onUpdate` 按 100ms 或凑满 8KB 发一次，取先到的。日志命令每秒几百个 chunk 时不逐个推，避免刷爆 TUI/RPC。
- 进度：`put`/`get` 的 step 回调每 ~5% 一次 `onUpdate`，避免大文件「看起来卡死」。

### 7.3 等待原语（消灭手动 sleep 轮询）
`ssh_exec` 支持可选 `waitFor`：

```ts
waitFor?: { port?: number; http?: string; file?: string; timeoutSec: number; intervalSec?: number }
```

`waitFor` 不在本地轮询。命令启动后紧跟远端一条循环，一次往返，审计只记一条。探测按条件选，依次降级：

| 条件 | 顺序 |
|---|---|
| `port` | `bash /dev/tcp` → `nc -z`。端口不需要 HTTP 客户端 |
| `http` | `curl` → `wget`。`/dev/tcp` 只能看端口通不通，看不了状态码 |
| `file` | `test -e`，随远端 `sh` 就有 |

远端没有 bash 时整段退回本地间隔探测，并在结果里注明。
满足即返回；超时则返回已收集输出并标明未就绪。对应会话里 9 次 `sleep` + 手写端口探测循环。

## 8. 部署

**`ssh_deploy` 不是黑盒**，它是「生成剧本 → 展示 → 确认 → 逐步执行」。
本期只支持两种制品，其他部署方式继续走 `ssh_put` + `ssh_exec`（仍受 §6 约束）：

| `kind` | 行为 | 例子 |
|---|---|---|
| `tar`（缺省） | 上传压缩包，解进 `releases/<ts>/`，再切软链 | 前端 dist、带目录的发布包 |
| `file` | 上传单个文件到 `releases/<ts>/<文件名>`，再切软链 | 一个 fat jar |

不支持：把文件丢到固定目录、`docker rm` 再 `docker run`、改 env 后原地重启。这些没有「上一版目录」可切。

```
0 预检   tar 需要 df 剩余 > 包大小 ×3：.part、解压结果、上一版会同时在盘上；
         file 是 rename，仍按 ×2。解压成功后立刻删 .part，再切软链。
         deploy.root 可写；
         restartCmd 存在则 sudo -n -l 验证免密
1 上传   put 到 <root>/<releasesDir>/<ts>.part，SSH 做双端 sha256
2 展开   tar：解进 releases/<ts>/，file：rename 成 releases/<ts>/<文件名>。都不碰 current，也不碰 shared/。
         tar 成员先过 guard（见下），含 `..` 或绝对路径的包直接拒绝、不碰盘
3 切换   ln -sfn <ts> current        ← 唯一的原子切换点
4 重启   <restartCmd>（如配置）
5 健康   远端循环跑 <healthCmd>，预算内退出码 0 即通过
6 失败   自动 ln -sfn <prev> current + 重启 + 再健康检查；仍失败则停下并报告两个 release 的状态
7 清理   超过 keepReleases 的旧版本删除。删除范围写进同一次部署确认，不另开一次确认。不动 .pi-ssh-backup
8 审计   每步耗时、sha256、结果写入 JSONL
```

- 确认弹窗必须写明：**健康检查失败会自动回退到上一 release，这一步不再次确认**。这是决策 2 的例外，只针对刚刚切上去的这一版。
- `dryRun: true` 只输出剧本不执行。
- 每步结果实时 `onUpdate`，任一步失败即停止（第 6 步的回退除外）。
- **越界守卫**（`core/deploy/guard.ts`）：两类路径都要过。
  1. 剧本自己生成的远端路径必须落在 `deploy.root` 内（`path.posix.normalize` 后校验前缀，拒绝 `..` 逃逸）。
  2. **压缩包成员**。解包前先 `tar -tzf` 列出成员，任一成员是绝对路径、含 `..` 段、或归一化后逃出 `releases/<ts>/`，
     整包拒绝，不执行解包。不能只靠 `tar -C`，GNU tar 默认允许成员里的 `..` 写出目标目录。
  守卫失败 = 拒绝执行，不降级为警告。
- 没有 `deploy` 布局的主机调用 `ssh_deploy` 直接拒绝，并提示用 `ssh_exec` + `ssh_put` 手工执行。
- 回滚参数统一成一个 schema，不再有两套写法：

```ts
ssh_rollback {
  host: string
  target: { kind: "release"; to?: "previous" | string }   // 缺省 previous。切软链 + 重启 + 健康检查，三步一次确认
         | { kind: "file"; path: string }                   // 把该路径最近一次备份移回原位
}
```

## 9. 工具清单

| 工具 | 副作用 | 确认 | 审计 | 说明 |
|---|---|---|---|---|
| `ssh_hosts` | 无 | 否 | 否 | `action: list\|test\|use`。test 可带 `acceptNewHostKey`。回报认证方式、指纹、延迟、传输类型、能力（能否 exec） |
| `ssh_exec` | 写 | 按 §6.1 | 是 | `command, cwd?, timeoutSec?, host?, waitFor?`。无 TTY：description 写明 sudo 用 `ssh_sudo`、`top`/`vi` 不支持。没有 `acceptNewHostKey` |
| `ssh_sudo` | 写 | 是 | 是（密码脱敏） | 掩码弹窗取密码 → `sudo -S -p ''`；生产主机 reason 必填 |
| `ssh_ls` | 读 | 否 | 否 | 结构化目录列表（SFTP stat / MLSD），不解析 `ls` 文本 |
| `ssh_read` | 读 | 否 | 否 | 远端文件按 offset/limit 取行，流式，不整文件进内存 |
| `ssh_put` | 写 | 生产主机按 §6.1 一律确认；非生产仅覆盖已存在文件时确认 | 是 | `.part`+rename、sha256（FTP 为例外，见 §4.3）、覆盖前备份、进度。不接受目录 |
| `ssh_get` | 读 | 否 | 是 | 下载到本地（补会话里 0 次下载的缺口：日志、配置备份） |
| `ssh_deploy` | 高危 | 必须（展示完整剧本） | 是 | §8 |
| `ssh_rollback` | 高危 | 必须 | 是 | `target.kind: file\|release`，schema 见 §8 |
| `ssh_tunnel` | 中 | 否 | 是 | local/remote 转发；bind 非 loopback 时确认；会话结束自动关闭 |
| `ssh_doctor` | 读 | 否 | 否 | Node 版本、ssh2、本机 ssh 有无、known_hosts 可写、keychain 可用性、审计可写 |
| `ssh_scan_sources` | 读 | 否 | 否 | 扫描建连第 1 步，见 §10 |
| `ssh_host_save` | 写 | 逐个确认 | 是 | 扫描建连第 2 步 |

**面向远端的工具**都接受 `host` 参数：`ssh_exec`、`ssh_sudo`、`ssh_ls`、`ssh_read`、`ssh_put`、`ssh_get`、`ssh_deploy`、`ssh_rollback`、`ssh_tunnel`。
`ssh_hosts`、`ssh_doctor`、`ssh_scan_sources`、`ssh_host_save` 没有 `host` 参数。
**已配置主机 ≤1 台时可以缺省**，用活动主机；
**≥2 台时缺省直接拒绝**并列出名称，不靠「上次留下的活动主机」。

**不在每轮系统提示里列主机。** SSH 不是每次对话都用，`before_agent_start` 不注入主机清单。
需要主机名时调用 `ssh_hosts`（`action: "list"`）。工具只保留一行 `promptSnippet`。

以下是不注入时原本打算放进提示的内容，仅作 `ssh_hosts list` 的输出格式：

```
[SSH 工具执行策略]
当前确认级别：destructive。生产主机的写操作一律确认，destructive 必须给 reason。
审计：开启（~/.pi/agent/ssh-audit.jsonl）。
[可用主机]
- prod-web-01[ssh2·prod] deploy@10.0.0.21:2222 部署根 /srv/app
- legacy-nas[ftps] ftp@10.0.0.9 仅文件传输（无 ssh_exec）
活动主机：prod-web-01。已配置 2 台，调用必须显式传 host。
```

超过 20 台时，`ssh_hosts list` 不再逐行列出：只给活动主机、总数，以及「其余用 `ssh_hosts list` 查看」。这里仍然不注入系统提示。

## 10. 管理面板与自动建连

### 10.1 `/ssh` 命令（无参数弹菜单，子命令直达）

```
/ssh                菜单：测试连接 / 切换活动主机 / 新增 / 编辑 / 删除 /
                         密钥管理 / 扫描建连 / 策略 / 审计日志
/ssh add            新增：粘贴 user@host:port 一键 / 逐步填写 / 从现有复制
/ssh edit <name>    编辑
/ssh rm <name>      删除（确认）
/ssh ls             列表
/ssh use <name>     切换活动主机
/ssh test <name>    实测
/ssh scan           引导语：告诉用户在对话里说「把这项目的服务器加进来」
/ssh config         策略：只读开关 / 确认级别 / 审计开关
/ssh log [n]        最近 n 条审计（缺省 20）
/ssh exec <命令>    在活动主机执行。这是唯一的远程执行入口，避免 /ssh ls 分不清是列主机还是远端 ls
```

子命令名保留：`add` `edit` `rm` `ls` `use` `test` `scan` `config` `log` `exec`。
不存在「`/ssh` 后面整段当远程命令」。

新增主机的认证步骤：选「密钥」则给路径或现场 `ssh_keygen`；选「密码」则掩码弹窗（§5）。
保存前**必须实测连接**。SSH 首次连接弹主机密钥指纹确认（TOFU），拒绝指纹 = 不保存。
**FTP/FTPS 没有主机密钥**，弹窗只确认地址、端口、用户与传输类型，不显示指纹。

### 10.2 扫描建连（两步，对齐 db 插件）

**第 1 步 `ssh_scan_sources`**（模型调用）：
- `~/.ssh/config` **由工具解析**（Host/HostName/User/Port/IdentityFile/ProxyJump），候选标 🟢。格式固定，不交给模型猜。
- 项目侧**只返回可能含部署目标的文件路径**（`.env*`、`deploy/`、ansible inventory、`Jenkinsfile`、`ecosystem.config.js`），
  不解析内容。模型用自己的读文件工具提取，提交时标 🟡。插件不再做一套会烂尾的项目文件语法。

**第 2 步 `ssh_host_save`**（模型提交候选数组）：逐个
1. `ctx.ui.confirm` 展示「名称、user@host:port、传输、来源、可信度」；
2. 缺字段（user、auth）在弹窗里补；密码走掩码输入；
3. 同名三选一：覆盖 / 改名 / 跳过；
4. 实测连接 + 指纹确认；
5. 通过才写盘。任一环节取消 = skipped，不落半成品。

**绝不静默建连**（与 db 插件同一硬原则）。

### 10.3 系统提示里的触发词
告诉模型：用户说「连一下这台服务器」「把我 ~/.ssh/config 里的主机加进来」「扫一下项目的部署配置」时，
走 `ssh_scan_sources` → 读文件提取 → `ssh_host_save`。

## 11. 错误模型

`src/core/types.ts` 的 Error 子类，工具层统一翻译成「人话 + 下一步」：

| 错误 | 返回给模型的指引 |
|---|---|
| `HostKeyUnknownError` | 指纹是什么。请用户核对后调用 `ssh_hosts`（`action: "test"`，或建连流程）并带 `acceptNewHostKey: true`，不要在 `ssh_exec` 上重试 |
| `HostKeyChangedError` | 硬失败。可能被中间人，或服务器重装；确认后 `ssh-keygen -R` |
| `AuthFailedError` | 试过哪些方法、服务器拒绝了哪个 |
| `UnsupportedError` | 该主机传输类型不支持此操作（ftp 上 exec） |
| `PolicyDeniedError` | 被只读模式/策略拒绝，如何调整（`/ssh config`） |
| `ConfirmRejectedError` | 用户在弹窗里拒绝了，停止，不要换种写法重试 |
| `BoundsError` | 路径越出 deploy.root，给出规范化后的路径 |
| `TransferMismatchError` | sha256 不一致，.part 保留在哪、原文件未动 |
| `AuditUnavailableError` | 生产主机的 destructive 因审计不可写被拒绝，修权限后重试 |

`ConfirmRejectedError` 的「不要换种写法重试」写进该错误文本与 skill，防止模型把被拒的 `rm -rf` 改写成 `find -delete` 再来一次。

## 12. 测试

`tsx --test`，对齐 db 包。分层：

1. **纯函数（主体，秒级）**：`policy.classify` 的命中/非命中用例（含混淆绕过用例，断言其**不会**被误判为 read）、
   `guard` 路径逃逸、`known-hosts` 解析（含 `|1|salt|hash` 与证书条目）、`plan` 剧本生成与失败回退序列、
   `~/.ssh/config` 解析、审计脱敏、配置原子写与 mtime 缓存。
2. **传输集成（可跳过）**：
   - ssh：`docker run linuxserver/openssh-server` 起真 sshd，无 docker 则 `t.skip()`。
     覆盖密码/密钥登录、SFTP 上传下载、sha256 不一致注入、覆盖备份、
     **看门狗**（起 `sleep 300` 后 abort，断言远端进程组消失）。
   - ftp：`ftp-srv`（纯 JS，devDependency）起本地服务，覆盖 `.part` 原子性、MLSD 列表、FTPS（自签证书）。
3. **UI 不进单测**：确认弹窗与菜单只测「文案构建函数」的纯输出（照 db 包 `sql-format` 的测法）。

## 13. Skills

- `remote-ops`：只读排查优先（`ssh_ls`/`ssh_read`/`ssh_exec` 只读命令）；多主机必须显式 `host`；
  命中主机名对不上就停下来问；被 `ConfirmRejectedError` 拒绝后禁止改写重试。
- `deploy`：部署前先报剧本（`dryRun`）再执行；只动 `deploy.root`；重启类操作先确认回滚点存在；
  生产主机上能走 `ssh_deploy` 的发布不要用 `ssh_exec` 临时拼 `docker rm -f`、`rm -rf`。

## 14. 里程碑

| 阶段 | 交付 | 验收 | 估算 |
|---|---|---|---|
| **M1 骨架** | 包结构、config（0600 原子写）、secrets、policy+单测、audit、known-hosts、错误类型 | `pnpm test` 全绿；policy 用例覆盖 §6.1 全表 | 2 天 |
| **M2 传输** | ssh2 传输 + 多路 channel 池 + keepalive + SFTP put/get（.part/sha256/备份/进度）+ 看门狗 | docker sshd 集成测试通过；并发 6 路不串线 | 3 天 |
| **M3 工具与面板** | `ssh_hosts/exec/ls/read/put/get/doctor`、`/ssh` 菜单、系统提示注入、危险命令确认弹窗 | 用本机起的 sshd 手测一遍部署会话里的前 6 步 | 2.5 天 |
| **M4 安全交互** | `ssh_sudo` 掩码弹窗、waitFor、审计脱敏、回滚（文件级） | sudo 密码不出现在会话文件里（人工核查） | 1.5 天 |
| **M5 部署** | `core/deploy` 剧本 + `ssh_deploy`/`ssh_rollback` + 越界守卫 + dryRun | 集成测试：健康检查失败 → 自动回退到前一 release | 2.5 天 |
| **M6 扫描建连** | `ssh_scan_sources`（只解析 `~/.ssh/config`，项目侧只回路径）+ `ssh_host_save` + 指纹确认 | fixture ssh config 跑通 | 1 天 |
| **M7 FTP** | ftp/ftps 传输、能力降级（拒绝 exec）、续传 | ftp-srv 集成测试 | 1.5 天 |
| **M8 openssh 传输 + 隧道** | auto 选择、ControlMaster、scp 传输、`ssh_tunnel`、skills、README、CHANGELOG | ProxyJump 的 fixture 配置能走通，第二次 scp 复用主连接 | 2 天 |

合计约 16 人天（M2 增 0.5、M6 减 0.5，相抵）。**M3 结束即可替代 `@patimweb/pi-ssh` 的日常使用**（约 7.5 天）。

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| 正则分类被混淆绕过 | §6.1 已声明局限；生产主机 write 一律确认兜底；skill 禁止被拒后改写重试 |
| 连接池复用到半开连接 | keepalive 30 秒；只在命令写出之前重连一次 |
| `chmod 0600` 在 Windows 无效 | `ssh_doctor` 如实报告（照 @patimweb 的做法），不假装 |
| 看门狗脚本与远端 shell 方言 | 要求远端 `sh` 支持 `set -m`；探测失败时回退为「超时只关通道」并在结果里明确警告 |
| basic-ftp 的 FTPS 证书校验 | 默认校验；允许 `insecure: true` 但需确认弹窗 |
| 掩码输入在 RPC 模式不可用 | §5 的降级路径：告知风险 + 建议密钥 |
| 审计日志增长 | 当前文件超过 1MB 滚动为带时间戳的归档，只保留最近 7 份；当前文件不删 |
| 模型把 `ssh_exec` 当 `ssh_deploy` 用、绕过剧本 | description 与 skill 引导；但即使绕过，确认 + 审计 + 文件备份仍然生效 |
| 会话授权放宽了 write 确认 | 授权要单独确认一次、有时限、不落盘；destructive 每次仍问；**生产主机不可授予** |
| FTP 传大文件没有远端哈希 | 结果与审计标明 `local-only`；要强校验的制品走 SFTP |

## 16. 修订记录

2026-11-18 评审修订：

- 看门狗改听 fd 3，命令 stdin 分开；sudo 密码先读一行再进入看门狗，不再和看门狗抢 stdin。
- FTP 不做远端 sha256，只核对字节数并标明 `local-only`。
- 文件备份与 `keepReleases` 拆开：备份进 `.pi-ssh-backup/`，每路径留 3 份。`rename` 已是元数据操作，不再引入硬链接。
- `/ssh exec` 与管理子命令分开，去掉「`/ssh <命令>`」。
- 多主机（≥2）缺省 `host` 直接拒绝；生产机 `ssh_put` 按 §6.1 确认；`acceptNewHostKey` 只在测试/建连。
- 扫描只解析 `~/.ssh/config`，项目文件只回路径。
- `ssh_deploy` 只保留 `tar` 与 `file` 两种剧本；`shared/` 不碰；确认弹窗写明失败会自动回退。
- 性能：一条连接最多 6 个 channel、keepalive、openssh ControlMaster、`waitFor` 远端循环、会话级 write 授权、系统提示超过 20 台折叠。
- 非目标补上 SFTP 续传与目录逐文件上传。

2026-11-18 二次评审收口：

- §6.1 明文写上：生产主机（tag 含 `prod`）拒绝会话级 write 授权。
- §8 步骤 2 与 `guard.ts` 增加压缩包成员检查：绝对路径、`..` 段、归一化后逃出 `releases/<ts>/` 的包整包拒绝。

同日继续收口：

- `decide` 明文限定为 `ssh_exec` 与 `ssh_sudo`。
- `ssh_rollback` 收成一个 schema：`target.kind` 为 `file` 或 `release`。
- openssh 传输的 `ssh_ls` / `ssh_read` 走 `sftp -b -`，复用 ControlMaster，不解析 `ls` 文本。
- `auto` 每次连接时重查 `~/.ssh/config`，不把选择存进 profile。
- 生产主机的 destructive 在审计不可写时 fail-closed，新增 `AuditUnavailableError`。
- FTP/FTPS 建连不弹指纹，只确认地址与凭据。
- 「接受 `host` 参数」收窄到面向远端的工具。
- 备份跨文件系统时 `rename` 的 EXDEV 降级为复制并注明。
- tar 预检改为包大小 ×3，解压后先删 `.part` 再切软链；远端哈希按三个命令依次降级。

同日补三处性能约束：

- §7.1：连接池禁止按 `host:port` 合并不同 profile；只在命令写出之前重连一次。
- §7.2：`onData` 到 `onUpdate` 按 100ms 或 8KB 合并。
- §7.3：`waitFor` 的 `port` 走 `/dev/tcp` → `nc`，`http` 走 `curl` → `wget`，`file` 走 `test -e`。

同日把单连接并发上限从 4 改为 6。上限仍然留着，避免一轮并行工具把 sshd 的会话数打满。

同日按评审收口：

- 看门狗先改 stdin，再把命令放进后台；watcher 必须在后台，否则和通道 EOF 互等。
- openssh 明确不继承密码和 MFA，`ControlMaster` 补上 `ControlPath`。
- 主机密钥指纹用密钥原文的 SHA256，能和 `ssh-keygen -lf` 对照。
- `ssh_deploy` / `ssh_rollback` 只读主机上的 `deploy` 布局。`restartCmd` 必须出现在确认文案里。
- 新密码不进 `security -w`。macOS 写入钥匙串做不到不暴露进程参数，改落 0600 文件。
- `prod` 标签在 `/ssh add` 与 `/ssh edit` 里由用户确认，扫描不推断。
