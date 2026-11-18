# 远端操作

连上主机后再排查。已配置两台及以上时，每个 ssh_* 调用都要带 host。

- 先用 ssh_ls、ssh_read 和只读的 ssh_exec。
- 用户拒绝后不要改写命令再试。
- 需要 root 用 ssh_sudo，不要把密码写进命令。
