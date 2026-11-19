---
name: deploy
description: 用 ssh_deploy / ssh_rollback 按主机上的 deploy 布局发布与回滚（releases 目录 + 软链切换 + 健康检查失败自动回退）。当用户要求把构建产物部署到远端、发布或切换新版本、回滚到上一版、恢复某个远端文件时使用。
---

# 部署

- 能走 `ssh_deploy` 的发布不要用 `ssh_exec` 拼 `rm`、`docker rm` 或手抄一遍解包切软链——那条路没有健康检查，也没有回退。
- 先 `dryRun: true` 看剧本，确认目标目录和命令无误再真正部署。
- 布局（root / releases / current / restart / health）只从主机配置读，调用时传不进去；要改布局用 `/ssh edit`。
- 健康检查失败、重启失败都会自动切回上一版：结果里 `rolledBack` 为真、`current` 指向旧版本即已回退。此时不要自动重试同一个包，先看健康检查输出定位原因。
- 回滚用 `ssh_rollback`：`release` 切回上一版（同样跑健康检查），`file` 只恢复单个文件。FTP/FTPS 主机没有部署与回滚能力，只能传文件。
