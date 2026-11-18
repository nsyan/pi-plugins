# @nsyan/ssh 升级回归手册

**用途**：每次发版前，用**真实安装的插件 + 真实服务器**把下面清单跑一遍，逐条勾选。
不是单测的替代——单测管纯函数与边界，这份管「装上之后在真机上到底能不能用」。

- 关联文档：设计 `../specs/2026-11-18-ssh-plugin-design.md`；缺陷记录 `2026-11-18-ssh-e2e-test-report.md`
- 最近一次全量执行：2026-11-18（0.1.3），结论见报告 §10
- 历史真机：`root@10.2.9.58`（Ubuntu 20.04.6，dash，有 setsid/bash/nc/curl/wget，sudo 免密，9001 有 nginx）

---

## 0. 准备

### 0.1 环境要求

| 项 | 要求 | 为什么 |
|---|---|---|
| 远端 | 一台 **Linux + dash**（Debian/Ubuntu 默认） | bash 下测不出 `set -m` 假成功、看门狗组杀失效这类问题 |
| 远端 | 有 `setsid`、`bash`、`nc`、`curl`、`wget`、`tar`、`sha256sum` | 看门狗降级分支、`waitFor` 三种条件、部署校验 |
| 远端 | 一个**非 22 端口**的监听服务（如 nginx 9001） | 测隧道与 `waitFor port` |
| 远端 | 能 `sudo -n true` 免密（或备好密码） | 测 `ssh_sudo` |
| 本机 | openssh 三件套齐全（`ssh`/`scp`/`sftp`） | 测 openssh 传输；缺了 `ssh_doctor` 应报出来 |
| 本机 | 一把能登远端的**密钥** | **全程用密钥，不要用密码**。密码只应在测「掩码输入」时由人自己敲 |

> **凭据纪律**：测试者不应把密码写进任何命令、脚本或对话。需要密码的分支，由人在掩码框里输入；或用免密 sudo / 密钥绕开。

### 0.2 装真插件（不要用本地路径，避免测的不是发布物）

```bash
# 1) 确认镜像已回源（否则可能装到占位包 0.0.0-stage）
curl -s "https://registry.npmmirror.com/@nsyan%2Fssh?t=$(date +%s)" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['dist-tags'])"

# 2) 安装/升级
pi update npm:@nsyan/ssh        # 或 pi install npm:@nsyan/ssh

# 3) 验证装的是真包（这一步能拦掉 90% 的「装了但没资源」）
ls ~/.pi/agent/npm/node_modules/@nsyan/ssh
#    必须看到 index.ts、src/、skills/；只有 package.json + README.md = 装到占位空壳了
grep '"version"' ~/.pi/agent/npm/node_modules/@nsyan/ssh/package.json
```

### 0.3 验证插件真的加载了

重启 pi 或 `/reload`，然后：

- [ ] 工具列表里能看到 13 个：`ssh_hosts` `ssh_exec` `ssh_sudo` `ssh_ls` `ssh_read` `ssh_put` `ssh_get` `ssh_deploy` `ssh_rollback` `ssh_tunnel` `ssh_doctor` `ssh_scan_sources` `ssh_host_save`
- [ ] `ssh_doctor` 输出包含：node 版本、`ssh2 可用`、openssh 三件套路径、`known_hosts 目录可写`、`审计目录可写`、钥匙串说明
- [ ] **没有**「Failed to load extension」日志

> 这一步失败时不要往下测。历史上最常见的原因是装了占位包 `0.0.0-stage`（插件页显示「已安装」但「已解析资源」为空）。

---

## 1. 主机管理与面板（0.1.2 大改动，重点）

面板是 `ctx.ui.select` 驱动的多级菜单，TUI 与 pi web 同一份代码。**每项都要走到底，不只点开第一层。**

### 1.1 顶层面板

`/ssh`（无参数）→ 应打开菜单，标题形如 `SSH 管理（N 台，活动 xxx）`

- [ ] 菜单项齐全：主机列表 / 切换活动 / 新增主机 / 扫描建连 / 测试全部 / 策略设置 / 审计日志 / 本机体检 / ← 返回
- [ ] `← 返回` 能退出，不卡在循环里
- [ ] 直接 Esc / 取消也能退出（不应抛异常）

### 1.2 单台主机二级菜单

主机列表 → 选一台 →

- [ ] 菜单项齐全：测试连接 / 查看详情 / 设为(取消)活动 / 标记(移除) prod / 更新凭据 / 编辑连接信息 / 编辑部署布局 / 执行命令 / 会话写授权 / 该主机的审计 / 删除主机 / ← 返回
- [ ] 「查看详情」列出传输方式、认证方式（密码只说有没有保存，**不回显明文**）、部署布局、prod 标记
- [ ] 「设为活动主机」后标题出现「（活动）」，`/ssh ls` 里也标 `●活动`
- [ ] 标记 prod 后再进来，菜单变成「移除 prod 标签」，详情里显示生产主机提示
- [ ] 删除主机有二次确认；确认后从列表消失，且若是活动主机，活动指针一并清掉

### 1.3 新增主机（覆盖四种传输 + 三种认证）

- [ ] `auto` / `ssh2` / `openssh` / `ftp` / `ftps` 都能选到；选 ftps 会问隐式 TLS 与是否跳过证书校验
- [ ] 认证可选：密钥 / 密码（**掩码输入，字符不显示明文**）/ ssh-agent
- [ ] 「从现有复制」能复制一台已有主机的配置作为起点
- [ ] **先测后写**：填一个坏端口（如 59999）→ 报错且**不落盘**（`/ssh ls` 里没有这条）
- [ ] 首次连接未知指纹 → 先把 `SHA256:...` 摆出来让人核对；**拒绝 = 不保存**
- [ ] 保存后 `~/.pi/agent/ssh-hosts.json` 权限是 `0600`
- [ ] 密码登录的主机：`~/.pi/agent/ssh-secrets.json` 里能看到对应条目，权限 `0600`，**工具参数与对话里都看不到明文**

### 1.4 编辑与改名

- [ ] 「编辑连接信息」改地址后，`id` / `createdAt` / `deploy` / `defaults` / `tags` **不被抹掉**
- [ ] 改名后：旧键消失、新键存在、活动指针跟着迁移
- [ ] 换认证方式（密钥 → 密码）后，另一路的引用被清掉，不留孤儿 `secretRef`
- [ ] 改名时密码条目只落在**最终名字**下，旧名字下不残留

### 1.5 更新凭据

- [ ] 只更新密码时，地址/端口/传输/标签都不变
- [ ] 更新失败（如指纹被拒）时，已写入的密码被回滚，不残留

### 1.6 部署布局可视化编辑

- [ ] 能编辑 root / releasesDir / currentLink / sharedDir / restartCmd / healthCmd / keepReleases
- [ ] root 留空 = **清除部署布局**，之后 `ssh_deploy` 应拒绝并指路 `ssh_exec` + `ssh_put`
- [ ] 详情里「未配置部署布局」提示正确

### 1.7 策略设置

- [ ] 只读模式 开/关 生效（关→开之后 `mkdir` 应被拒，见 §4.3）
- [ ] 确认级别 `destructive` / `write` / `always` 三档都能设
- [ ] 「恢复默认」能回到初始值
- [ ] 写回的是 `~/.pi/agent/ssh-hosts.json` 的 `policy` 字段

### 1.8 审计日志

- [ ] 不带参数 → 先选范围（全部 / 单台）
- [ ] 单台过滤只出该主机的记录
- [ ] 长命令截断显示，不撑爆界面
- [ ] 退出码、时间、工具名都在

### 1.9 子命令与面板行为一致（防分叉）

逐个跑，行为应与面板里同名动作**完全一致**：

```
/ssh ls          /ssh add        /ssh edit <主机>   /ssh rm <主机>
/ssh test [主机]  /ssh testall    /ssh use <主机>    /ssh exec <命令>
/ssh grant <主机> <分钟>          /ssh log [主机|条数]
/ssh config      /ssh scan       /ssh doctor
```

- [ ] 每个子命令都能直达对应动作，不另弹一套不一样的流程
- [ ] `/ssh 未知子命令` 输出用法提示，不崩

### 1.10 面板在 pi web（RPC）下的降级

- [ ] `ctx.ui.custom` 不可用时，确认框回退到 `confirm`，**内容仍带理由与命令**（见 §3）
- [ ] 掩码输入不可用时，先 `confirm` 告知「此通道不能掩码，建议改用密钥」，用户拒绝就停

---

## 2. 执行与输出

用一台已保存的主机（下文记作 `H`）。

- [ ] `uname -n` / `whoami` 正常返回
- [ ] `cwd` 参数生效（`pwd` 返回指定目录）
- [ ] stderr 与 stdout 都回传，且能区分
- [ ] 非零退出码原样透传（`exit 42` → 退出码 42，输出保留）
- [ ] dash 语法（`if [ -n "$0" ]; then ...`）能跑
- [ ] `seq 1 3000` → 标记截断，给出落盘路径；**打开该文件核对是完整 3000 行**
- [ ] `seq 1 100` 不截断
- [ ] **中文输出不出替换符**：`printf '中文日志：部署成功 ✅\n'` → 原样返回，无 `\uFFFD`
- [ ] **大段中文不切字**：造一个 600KB 单行中文文件，`ssh_read` 读出后应**全部是完整汉字**（历史上这里出过 U+FFFD）

`waitFor` 三条件：

- [ ] `port`：对已有监听端口 → 就绪后继续
- [ ] `port`：对无人监听端口 → 超时返回非 0
- [ ] `http`：对 200 的 URL → 继续
- [ ] `file`：文件存在 → 继续；不存在 → 超时非 0

---

## 3. 确认框（0.1.3 修复，重点）

**这一节必须人眼检查渲染效果**，不能只看「有没有弹框」。

- [ ] 触发一条需要确认的命令（如 `rm -f /tmp/probe`）
- [ ] 弹框**显示执行理由**（若工具调用带了 `reason`）——历史上这里曾经完全不显示
- [ ] **多行命令按行显示**，不是挤成一行（历史缺陷：`set -e TS=... rm -rf ...` 糊在一起）
- [ ] 命令在**代码块**里，有语言标记与高亮（TUI 走 pi-tui Markdown；pi web 走 react-markdown + Prism）
- [ ] 列表区显示：分级（破坏性/写入）、主机、影响摘要、传输方式、超时
- [ ] 部署/回滚的弹框额外显示：切换点、重启命令、将删除的旧版本、**「健康检查失败会自动回退」**的警告
- [ ] 命令里含 ` ``` ` 时，代码块不被撑破（围栏自动加长）
- [ ] `ssh_put` 覆盖、`ssh_tunnel`、`ssh_sudo`、`ssh_deploy`、`ssh_rollback`（release 与 file 两种）**各自**都检查一遍
- [ ] **点取消** → 抛「用户拒绝了这次操作，停止，不要换一种写法重试」，且**命令确实没执行**（用探针文件核对）

---

## 4. 策略与审计

### 4.1 分级

逐条核对分级结果（写进弹框的「分级」或审计的 `danger`）：

- [ ] `read`：`ls` `cat` `grep` `git status` `git log` `git checkout main`（切分支）
- [ ] `write`：`cp` `mv` `chmod` `chown` `tee` `truncate` `sed -i` `echo x > f` `systemctl restart`
- [ ] `write`（0.1.3 补的，历史上漏判）：`mkdir` `touch` `ln` `git checkout -- .`
- [ ] `destructive`：`rm` `dd of=` `kill -9` `mkfs` `docker rm` `reboot` `find -delete`

### 4.2 确认级别

- [ ] 默认 `destructive`：只确认破坏性
- [ ] `write`：写操作也确认
- [ ] `always`：只读也确认

### 4.3 只读模式（0.1.3 修复，重点）

打开只读模式后：

- [ ] `ls /tmp` **放行**
- [ ] `mkdir -p /tmp/x1` **被拒**（历史缺陷：这里曾被放行并真的创建了目录）
- [ ] `touch /tmp/t1` / `ln -s /tmp/t1 /tmp/l1` / `git checkout -- .` **都被拒**
- [ ] `rm -rf` / `sudo` / `put` / `deploy` / `rollback` **都被拒**
- [ ] 用 `ls` 核对远端，确认**这些命令真的没执行**

### 4.4 生产主机（`tags` 含 `prod`）

- [ ] destructive 缺 `reason` → 拒，报错说明「必须填写 reason」
- [ ] destructive 带 `reason` → 仍弹框；**审计里能查到该 reason**
- [ ] `ssh_put` 覆盖新文件也要确认
- [ ] **拒绝授予会话级写授权**
- [ ] 审计目录不可写时 fail-closed（命令不执行）

### 4.5 审计

- [ ] 文件 `~/.pi/agent/ssh-audit.jsonl`，权限 `0600`
- [ ] 一次 destructive 动作只产生 **1 条**记录（历史缺陷：写过 2 条）
- [ ] `put`/`get` 记录含 `bytes`、`sha256`、`backupPath`
- [ ] `stdin` 字段永远是 `<redacted>`
- [ ] 超 1MB 滚动，保留最近 7 份归档

---

## 5. 传输

### 5.1 `ls` / `read`

- [ ] `ls` 结构化（类型/大小/名字）
- [ ] `read` 的 `offset` / `limit` 生效；越界返回空
- [ ] 空文件返回空串
- [ ] 无尾换行的文件不丢最后一行
- [ ] 不存在的路径报错（记录报错文案是否可操作）

### 5.2 `put` / `get`

- [ ] 小文件上传，sha256 与本地一致，远端**无 `.part` 残留**
- [ ] 3MB 二进制上传，sha256 一致
- [ ] **传目录** → 报「是目录…先打成压缩包」，**进程不崩**（历史 P0：这里曾把整个进程打掉）
- [ ] 覆盖已有文件 → 确认 + 备份 + **同路径只留 3 份**
- [ ] `get` 小文件与 3MB 二进制，sha256 与远端一致
- [ ] `get` 不存在的文件 → 明确报错

### 5.3 openssh 传输（另建一台同机 `transport: openssh`）

- [ ] `test` 报出指纹，且**与 ssh2 报的完全一致**（历史上这里恒为空）
- [ ] 连续 exec **5 次**全部正常输出，**无 143、无空输出**（历史 P0：ControlMaster 生效后 4/5 概率坏）
- [ ] 大输出截断并落盘
- [ ] 中文输出无替换符
- [ ] `ls` / `read` / `put` / `get` 全部可用
- [ ] 会话结束无孤儿 `ssh` 进程（`ps -ef | grep ControlMaster`）

### 5.4 FTP/FTPS

- [ ] 登录成功（**注意**：历史上这里把 `file:...#name` 引用当密码发出去，必然 530）
- [ ] `ls` 可用（走 MLSD）
- [ ] 上传/下载字节数核对；`.part` 续传
- [ ] `exec` / `read` → 明确 `UnsupportedError`（不假装支持）
- [ ] `deploy` / `rollback` → `UnsupportedError`，**不是** `ECONNREFUSED`
- [ ] `active: true` → 明确报「只有被动模式」

---

## 6. 部署与回滚

准备：在主机配置里写好 `deploy` 布局（root 指向临时目录，`healthCmd` 检查 `current/index.html`）。

- [ ] `dryRun: true` → 只返回剧本，远端**完全没变**（releases 仍为空、无 `current`）
- [ ] `kind: "tar"` 真实部署 → 成功；子目录完整；`.part` 清理；`shared/` **未被写**
- [ ] `kind: "file"` 真实部署 → 成功
- [ ] 连续发两版 → `current` 指向新版，旧版仍在 `releases/`
- [ ] 健康检查失败 → **自动回退**，`rolledBack: true`，`current` 回到部署前那一版
- [ ] 重启命令失败 → 同样回退（历史 P1：这条路径曾不回退）
- [ ] `keepReleases` 生效，旧版本被清理，`.pi-ssh-backup` **不被删**
- [ ] 压缩包含 `..` 或绝对路径 → 整包拒绝（守卫）
- [ ] 合法 tar 包**不被误拒**（历史 P0：尾空行曾让所有合法包被拒）
- [ ] `df` 读不到剩余空间 → 取消部署
- [ ] 没有 `deploy` 布局 → 拒绝并指路

回滚：

- [ ] release 回滚缺省 → 上一版，**跳过 `.part` 残留**
- [ ] 显式指定 `.part` → 拒绝
- [ ] 显式指定 `../evil` → 拒绝
- [ ] release 回滚**跑健康检查**（历史 P1：曾完全没接）
- [ ] 文件回滚：部署根内的文件能从 `.pi-ssh-backup` 恢复（历史 P1：曾永远失败）
- [ ] 文件回滚：同目录 `.bak.*` 也能恢复
- [ ] 找不到备份时，报错**列出找过的两个位置**

---

## 7. 看门狗与进程清理

- [ ] 超时命令（`sleep 300`）→ 远端**无残留**（`ps -ef | grep sleep`）
- [ ] 命令内部用 `&` 派生 → 无残留
- [ ] 命令内部用 `nohup` 派生 → 无残留
- [ ] abort（Ctrl-C / signal）后同样无残留
- [ ] **已知缺陷**：命令内部自己 `setsid` 派生 → **会残留**（`setsid sh -c 'sleep 302; ...' &`）。当前设计如此，记录为已知限制，不要当回归失败
- [ ] 远端无 job control 也无 `setsid` 时，stderr 有降级警告，且置 `PI_SSH_NO_GROUP`

---

## 8. 隧道

- [ ] local：本机 `127.0.0.1:<port>` → 远端服务，`curl` 拿到 200
- [ ] remote：远端 `<port>` → 本机服务，在远端 `curl` 拿到 200
- [ ] 只绑 `127.0.0.1`（`netstat` 核对，不对外网卡）
- [ ] listen 端口被占用 → 报错，且**名额归还**，后续调用正常
- [ ] 会话结束隧道自动关闭

---

## 9. 扫描建连

- [ ] `ssh_scan_sources` 能解析 `~/.ssh/config` 的具体 Host（通配/否定模式不产出候选）
- [ ] 能列出项目里的部署相关文件（`.env*`、`deploy/`、`Jenkinsfile` 等）
- [ ] `ssh_host_save` 同名时三种策略（覆盖/改名/跳过）都生效
- [ ] 坏端口候选**先测后写，不落盘**
- [ ] 覆盖时保留原 `id`
- [ ] 好候选写入后 `0600`，密码进 0600 文件

---

## 10. 收尾

- [ ] 远端临时目录清理干净（`/tmp/pi-ssh-e2e-*`）
- [ ] 无残留进程
- [ ] 本机临时文件清理
- [ ] 测试用的临时主机（如 `*-oss`、`fake-ftp`）从 `ssh-hosts.json` 删除
- [ ] 把本次结果补进 `2026-11-18-ssh-e2e-test-report.md`（新开一节，写清版本号与日期）

---

## 附：单测与类型检查（本地，秒级）

```bash
cd packages/ssh
npx tsx --test "test/**/*.test.ts"      # 当前 182 项
npx tsc -p tsconfig.typecheck.json      # 0 error
```

单测覆盖的是纯函数与进程内假服务（假 sshd、假 ctx.ui），**不能替代本手册的真机验证**——历史上 5 个 P0 全部是真机才暴露的（dash 的 `set -m`、ControlMaster 复用、FTP 530、tar 尾空行、目录上传崩进程）。
