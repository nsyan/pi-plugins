# 部署

能走 `ssh_deploy` 的发布不要用 `ssh_exec` 拼 `rm` 或 `docker rm`。

- 先 `dryRun: true` 看剧本，确认无误再真正部署。
- 只使用主机配置里的 `deploy` 布局。不要在调用时临时传 `root`、`restartCmd` 或 `healthCmd`——运行时不接受这些参数，改配置要用 `/ssh edit`。
- 生产主机（`tags` 含 `prod`）必须带 `reason`（动机 + 影响范围）。
- `kind` 缺省是 `tar`，传单文件用 `kind: "file"`。本地是目录时先打成包，`ssh_put` 不接受目录。
- 健康检查是远端循环（60s 预算），**失败会自动切回上一版**，确认框里已写明；重启失败走同一条回退路径，不会留下 `current` 指向未验证的新版本。
- 发布后确认结果里的 `current` 指向与 `rolledBack` 标志。若已回退，不要自动重试同一个包——先看健康检查的输出。
- 回滚用 `ssh_rollback`：`target.kind: "release"` 切回上一版（也会跑健康检查），`target.kind: "file"` 恢复单个文件（会依次查找部署根内 `.pi-ssh-backup/` 与同目录 `.bak.*`）。
- FTP/FTPS 主机不能部署或回滚，只能传文件。
