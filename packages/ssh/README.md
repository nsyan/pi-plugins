<div align="center">

# @nsyan/ssh

**让 AI 安全地操作远程服务器 —— SSH / SFTP / FTP 一把梭**

连、看、改、传、部署、回滚、转发，13 个工具 + `/ssh` 管理面板

[![npm version](https://img.shields.io/npm/v/@nsyan/ssh?color=cb3837&logo=npm)](https://www.npmjs.com/package/@nsyan/ssh)
[![npm downloads](https://img.shields.io/npm/dm/@nsyan/ssh?color=blue)](https://www.npmjs.com/package/@nsyan/ssh)
[![Node.js](https://img.shields.io/node/v/@nsyan/ssh?color=339933&logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

[安装](#-安装) · [快速开始](#-快速开始) · [工具清单](#-工具清单) · [安全模型](#-安全模型) · [故障排查](#-故障排查)

</div>

---

[pi](https://github.com/earendilofficial/pi) 的远程运维扩展。把 SSH 会话变成 AI 可调用的结构化工具：**密码永不进工具参数**，危险命令先确认，远端动作落审计，部署失败自动回滚。

```text
你：看下 web-01 上 nginx 最近的错误日志
AI：ssh_exec { host: "web-01", command: "tail -n 200 /var/log/nginx/error.log" }
    └─ 只读命令，直接执行 ──────────────────────────► 返回日志
你：把这个 dist.tar.gz 发上去并发布
AI：ssh_deploy { host: "web-01", localPath: "./dist.tar.gz", reason: "..." }
    └─ 上传 → 校验 → 切软链 → 重启 → 健康检查 ──► 失败则自动回退上一版
```

## ✨ 特性

- **双传输**：`ssh2`（纯 JS 跨平台，含 SFTP）与 `openssh`（继承 `~/.ssh/config` 的 ProxyJump / agent / 证书 / MFA）；`auto` 每次连接重查 config，遇到 ProxyJump、PKCS11 自动切 openssh
- **FTP / FTPS**：与 SSH 共用同一套文件传输工具；`exec` / `read` 明确报 `UnsupportedError`，而不是假装支持
- **安全三件套**：危险命令分级确认（read / write / destructive）、JSONL 审计（1MB 滚动，保留 7 份）、known_hosts 校验（未知指纹先摆给人核对）
- **部署是一等公民**：`releases/<ts>` + `current` 软链剧本，重启或健康检查失败**自动切回上一版**；`ssh_rollback` 手动回退 release 或单个文件
- **进程看门狗**：命令跑在自己的进程组，通道断开 / 超时 → `TERM` → 2s 后 `KILL`；dash 远端用 `setsid` 建组
- **零运行时耦合**：`src/core` 与 `src/transports` 不 import 任何 pi 模块，可单独复用

## 📦 安装

```bash
# 从 npm 安装（推荐）
pi install npm:@nsyan/ssh

# 本仓库开发者
pi install ./packages/ssh
```

装好后 `/ssh` 面板与 13 个 `ssh_*` 工具即可用。安装异常见 [故障排查](#-故障排查)。

## 🚀 快速开始

**1. 添加主机**（两种方式，都会先实测连接、**通过才写盘**）

```bash
/ssh add        # 交互式：一键 user@host:port，或逐步填写，或从现有主机复制
```

或直接让 AI 扫：

```text
你：扫一下我有哪些 SSH 主机
AI：ssh_scan_sources → 解析 ~/.ssh/config 与项目部署文件 → ssh_host_save 逐台确认保存
```

**2. 开始用**

```text
看下 /var/log/nginx 下最近的错误          → ssh_exec
把本地的 app 日志拉回来                    → ssh_get
在 /etc/nginx 里把 worker_connections 调大  → ssh_read + ssh_put
把这个包发到 web-01 并发布                 → ssh_deploy
刚才那版有问题，回滚                       → ssh_rollback
本机为什么连不上                           → ssh_doctor
```

**3. 主机多了之后**

已配置 ≥2 台主机时，所有面向远端的调用**必须显式传 `host`**；只有一台时可省略（命令侧 `/ssh exec` 除外，它打活动主机）。

```text
/ssh use web-01     # 设为活动主机，之后 /ssh exec 默认打它
```

## 🧰 工具清单

| 工具 | 作用 | 关键约束 |
|------|------|---------|
| `ssh_hosts` | 列主机 / 测连接（返回传输方式、认证方式、指纹、延迟） | `test` 可带 `acceptNewHostKey` |
| `ssh_exec` | 执行一条非交互命令 | 无 TTY；破坏性命令先确认；可带 `waitFor`（port / http / file） |
| `ssh_sudo` | 用 sudo 执行 | 密码本地掩码输入，不进命令文本、不进审计 |
| `ssh_ls` / `ssh_read` | 列目录 / 按行读文件 | 走 SFTP；`read` 默认 200 行，单次 ≤200 行或 512KB，按 UTF-8 边界截断 |
| `ssh_put` / `ssh_get` | 上传 / 下载 | 先写 `.part` → 双端 sha256 → 转正；覆盖前备份并确认；**不接受目录** |
| `ssh_deploy` | 按主机 `deploy` 布局发布 | 只认配置里的重启命令与健康检查；支持 `dryRun`、`tar` / `file` 两种剧本 |
| `ssh_rollback` | 回滚 release 或恢复文件 | release 回滚也跑健康检查；`.part` 残留不会被当成 release |
| `ssh_tunnel` | 端口转发（local / remote） | 仅 ssh2；只绑 `127.0.0.1`；每次调用都确认 |
| `ssh_doctor` | 本机体检，不连远端 | node / ssh2 / ssh+scp+sftp / known_hosts / 审计目录 / 钥匙串 |
| `ssh_scan_sources` / `ssh_host_save` | 扫描候选 / 确认后保存 | 保存前先实测，失败不落半成品，已写密码一并回滚 |

## ⌨️ `/ssh` 命令

```bash
/ssh                              # 无参数 = 打开管理面板（TUI 与 pi web 同一份）
/ssh ls                           # 列主机（notify，不开面板）
/ssh add | edit [主机]            # 交互式：一键 user@host:port / 逐步填写 / 从现有复制
/ssh test [主机] | /ssh testall   # 实测；testall 一次测完（未知指纹只报出，不逐个弹）
/ssh use <主机>                   # 设 / 取消活动主机
/ssh rm [主机]                    # 删除（确认，密码条目一并清）
/ssh exec <命令>                  # 打活动主机，走同一套确认 / 审计
/ssh grant <主机> <分钟>          # 会话级写授权（生产主机拒绝授予）
/ssh log [主机|条数]              # 审计（不带参数先选范围）
/ssh config                       # 策略：只读 / 确认级别 / 恢复默认
/ssh doctor                       # 本机体检
/ssh scan                         # 引导语：扫描建连交给会话 AI
```

<details>
<summary><b>管理面板结构</b>（<code>/ssh</code> 无参数，<code>ctx.ui.select</code> 在 TUI 与 pi web 都渲染成可点对话框）</summary>

```text
SSH 管理（N 台，活动 xxx）
├─ 🖥️ 主机列表 / 单台管理 → 选主机 → 测试 / 详情 / 设为或取消活动 / prod 标签 /
│     更新凭据 / 编辑连接信息 / 编辑部署布局 / 执行命令 / 会话写授权 / 该主机审计 / 删除
├─ ⚡ 切换活动主机
├─ ➕ 新增主机（一键 user@host:port / 逐步填写 / 从现有复制）
├─ 🔎 扫描建连（引导语，实际由会话 AI 走 ssh_scan_sources → ssh_host_save）
├─ 🧪 测试全部连接
├─ ⚙️ 策略设置（只读 / 确认级别 / 恢复默认）
├─ 📜 审计日志（全部或按主机）
└─ 🩺 本机体检
```

子命令与面板走同一套流程（`src/ui/panel.ts`），不会出现「命令能改、面板不能改」的分叉。

面板的几条硬规则（都是踩过坑后加的）：

- **新密码先写临时键**：实测通过才转正到 `<主机名>`，失败只删临时键——输错密码不会把原来能用的密码一起销毁
- **「从现有复制」不静默覆盖**：名字冲突照样问「覆盖 / 自动改名 / 跳过」；凭据复制成独立条目，副本改名或删除不会带走来源主机的密码
- **删除主机只删自己独占的凭据**：还有别的主机引用同一 `secretRef` 时保留条目
- **端口留空 = 回到默认 22**；`prod` 标签可以取消
- **审计文件损坏不崩面板**：末尾被截断时给出路径与处理建议，而不是抛异常

</details>

## 🔐 凭据与本地文件

| 文件 | 内容 | 权限 |
|------|------|------|
| `~/.pi/agent/ssh-hosts.json` | 主机配置（transport / 端口 / 认证引用 / `deploy` 布局 / `tags` / policy） | 0600，原子写，按 mtime 缓存 |
| `~/.pi/agent/ssh-secrets.json` | 密码明文（`file:...#<主机名>` 引用） | 0600，原子写；**JSON 损坏时报错而不覆盖** |
| `~/.pi/agent/ssh-audit.jsonl` | 审计，`stdin` 恒为 `<redacted>` | 0600，超 1MB 滚动，保留 7 份归档 |
| `~/.ssh/known_hosts` | 主机密钥，与系统 ssh 互通 | 端口非 22 用 `[host]:port` |
| `~/.pi/agent/ssh-cm/` | openssh ControlMaster socket | 会话结束 `ssh -O exit` 收掉 |

- 工具 schema 里**没有** password / passphrase 字段，模型物理上无法传密码
- `secretRef` 形如 `file:.../ssh-secrets.json#web-01` 或 `keychain:pi-ssh/web-01`
- macOS 钥匙串只用于**读**已有项：`security -w` 会把密码留在进程表，所以新密码一律落 0600 文件
- 指纹格式为密钥原文 sha256（`SHA256:...`），可直接与 `ssh-keygen -lf` 对照

## 🛡️ 安全模型

| 机制 | 行为 |
|------|------|
| 只读模式 | 拒绝 write / destructive，放行 read |
| 确认级别 | 默认只确认 destructive；可设为 `write` 或 `always` |
| 生产主机 | `tags` 含 `prod`：destructive 必须带 `reason`；`ssh_put` 覆盖也要确认；**会话授权拒绝授予**；审计不可写时 fail-closed（命令不执行） |
| 用户拒绝 | 抛错并明确写「不要换一种写法重试」，命令确实没执行 |
| 未知主机密钥 | 先失败并摆出指纹，人确认后才写 `known_hosts`；`changed` / `revoked` 直接硬失败 |
| 进程清理 | 看门狗独占 fd 3，通道 EOF 即组杀；无 job control 也无 `setsid` 时降级并在 stderr 说明 |
| 输出预算 | 超 50KB 或 2000 行 → 全文落 `/tmp/pi-ssh-<ts>.log`，结果里给路径 |

## 📦 部署与回滚

`deploy` 布局写在主机配置里（`root` / `releasesDir` / `currentLink` / `sharedDir` / `restartCmd` / `healthCmd` / `keepReleases`），用 `/ssh edit` 修改：

```text
<root>/releases/<ts>/…        # 每次发布一个新目录
<root>/current -> releases/…  # 软链切换，原子生效
<root>/.pi-ssh-backup/…       # 覆盖文件与回滚用的备份，每路径留 3 份
```

**剧本**：预检（`df` 解析不出数字就取消）→ 上传到 `releases/<ts>.part` → 校验 → 转正 → 切软链 → 重启 → 健康检查（远端循环，60s 预算）→ 清理旧版本（`keepReleases`，默认 5）。

**重启失败或健康检查失败都走同一条回退路径**，回退后 `current` 指回上一版；确认框里写明这一点。

**回滚**：`target.kind = "release"` 切回上一版（跳过 `.part`，跑健康检查）或指定 `to`；`target.kind = "file"` 从两个备份位置（部署根内 `.pi-ssh-backup/` 与同目录 `.bak.*`）恢复，失败时列出找过的位置。

## 🩺 体检

`ssh_doctor` 只查本机、不连远端：node 版本、`ssh2` 能否加载、`ssh` / `scp` / `sftp` 三件套（按 `PATH` 探测，不写死 `/usr/bin`）、`~/.ssh` 可写、审计目录可写、钥匙串能力。

```bash
/ssh doctor     # 或让 AI 调 ssh_doctor
```

## ⚠️ 已知限制

- `/ssh scan` 只是引导语：扫描建连由会话 AI 驱动（`ssh_scan_sources` → 读文件提取 → `ssh_host_save`），终端命令不做正则提取
- `ssh_host_save`（工具侧）不暴露 `transport` / `secure`；面板与 `/ssh add|edit` 可选 transport（含 ftp / ftps 与隐式 TLS）、FTPS 跳过证书校验。`ssh_scan_sources` 不产出 `ftp://` 候选
- `ssh_hosts test` 报的认证方式是**配置里写的 kind**，不是协商结果（ssh2 不暴露协商结果）
- `ssh_hosts` 的 `acceptNewHostKey` 仍是可直接打开的开关，模型理论上能跳过指纹确认；`/ssh test`、`/ssh add`、`ssh_host_save` 走的是「先摆指纹再确认」
- `waitFor` 三个分支都依赖远端 `bash`，没有本地回退
- `ssh_tunnel` 仅支持 ssh2，没有 `bind` 参数（恒为回环），且每次调用都确认
- FTP / FTPS：只有被动模式（`basic-ftp` 5 无主动模式）；**不做远端 sha256**，完整性只核对字节数；不能 `exec`、不能部署 / 回滚
- openssh 传输 `BatchMode=yes`，需要密码或 MFA 的主机请改用 ssh2
- **命令内部自己 `setsid` 派生的进程会逃出看门狗进程组**：普通超时、`nohup`、`&` 派生都能清掉，但 `setsid sh -c '…' &` 建了新会话，`kill -TERM -$pid` 打不到它（真机实测会残留）。需要这类清理时请在命令里自带 `timeout`

## 🐛 故障排查

<details>
<summary><b>装到了 <code>0.0.0-stage</code>，所有工具都没注册</b></summary>

`0.0.0-stage` 是 npm 暂存发布留下的空壳（只有 `package.json` + `README.md`，无 `index.ts`）。典型症状：插件页显示「已安装 0.0.0-stage」、**没有已解析资源**、所有 `ssh_*` 工具都不注册。

原因是 `~/.npmrc` 指向 `registry.npmmirror.com`，而镜像的 `latest` 一度仍指向占位包（官方 registry 早已是 0.1.x）：

```bash
# 让镜像立刻回源同步（然后重装 / 更新）
curl -X PUT https://registry.npmmirror.com/-/package/@nsyan/ssh/syncs
pi update npm:@nsyan/ssh

# 或直接指定官方源
npm install @nsyan/ssh@latest --registry=https://registry.npmjs.org
```

判断装对没有：`ls ~/.pi/agent/npm/node_modules/@nsyan/ssh` 里应该有 `index.ts` 和 `src/`。

</details>

<details>
<summary><b>首次连接报未知主机密钥</b></summary>

这是预期行为，不是 bug。输出里会给出 `SHA256:...` 指纹，用 `ssh-keygen -lf ~/.ssh/id_ed25519.pub` 核对一致后再确认，指纹才会写入 `known_hosts`。指纹 `changed` / `revoked` 会直接硬失败——先查清原因，不要删 `known_hosts` 绕过。

</details>

<details>
<summary><b>远端进程超时后仍在跑</b></summary>

看门狗杀的是自己的进程组。如果命令内部用 `setsid` 建了新会话（如 `setsid sh -c '…' &`），它会逃出组杀。这类长任务请在命令里自带 `timeout`，见[已知限制](#-已知限制)。

</details>

<details>
<summary><b>需要密码或 MFA 的主机连不上</b></summary>

openssh 传输跑在 `BatchMode=yes` 下，无法交互式输入。这类主机请用 `/ssh edit` 把 transport 改成 `ssh2` 并保存密码，或配置密钥。

</details>

## 🔧 开发

```bash
pnpm install
pnpm --filter @nsyan/ssh test        # tsx --test + node:test，209 项
pnpm --filter @nsyan/ssh typecheck   # tsc，0 error
```

无构建产物：TypeScript 由 pi / tsx 直接加载。新增传输请保持 `src/core`、`src/transports` 零 pi 依赖。

### 发版前的真机回归

单测管纯函数与边界，**管不了真机上才能暴露的问题**（历史上 5 个 P0 全部是真机才发现的：dash 的 `set -m` 假成功、ControlMaster 复用后返回 143、FTP 把引用当密码、`tar -tzf` 尾空行、传目录崩进程）。

发版前请按 **[升级回归手册](../../docs/superpowers/reports/ssh-regression-checklist.md)** 用**真实安装的插件 + 真实服务器**逐条勾选。两个重点：

- 远端必须是 **dash**（Debian / Ubuntu 默认），bash 下测不出看门狗组杀失效
- **全程用密钥**，不要把密码写进命令、脚本或对话；需要密码的分支由人在掩码框里输

面板（`/ssh`）的交互与渲染目前只有单测兼底、**无真机记录**，手册 §1 的 10 个小节需人眼过一遍（尤其子命令与面板行为是否一致）。

### 文档

| 文档 | 内容 |
|------|------|
| [设计文档](../../docs/superpowers/specs/2026-11-18-ssh-plugin-design.md) | 架构、传输抽象、安全模型的设计取舍 |
| [真机测试报告](../../docs/superpowers/reports/2026-11-18-ssh-e2e-test-report.md) | Ubuntu 20.04 + dash 上逐项验证结果 |
| [回归手册](../../docs/superpowers/reports/ssh-regression-checklist.md) | 146 条发版勾选项 |
| [CHANGELOG](../../CHANGELOG.md) | 版本变更记录 |

## 🤝 贡献

欢迎 issue 与 PR。提交前请确保 `pnpm --filter @nsyan/ssh test` 与 `typecheck` 全绿；涉及远端行为的改动请附上真机验证环境（发行版 + shell）。

## 📄 许可

[MIT](../../LICENSE)
