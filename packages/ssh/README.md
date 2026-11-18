# @nsyan/ssh

pi 的远程运维扩展：SSH/SFTP/FTP。设计见 `docs/superpowers/specs/2026-11-18-ssh-plugin-design.md`。

工具已经注册：`ssh_hosts`、`ssh_exec`、`ssh_sudo`、`ssh_ls`、`ssh_read`、`ssh_put`、`ssh_get`、`ssh_deploy`、`ssh_rollback`、`ssh_tunnel`、`ssh_doctor`、`ssh_scan_sources`、`ssh_host_save`。管理命令是 `/ssh`。

部署只读主机配置里的 `deploy` 布局。重启命令和健康检查不能在调用时临时传入。密码不进工具参数；macOS 上新密码写入 `~/.pi/agent/ssh-secrets.json`，不传给 `security -w`。

```bash
pnpm --filter @nsyan/ssh test
```
