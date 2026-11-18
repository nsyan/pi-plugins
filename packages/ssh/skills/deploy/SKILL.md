# 部署

能走 ssh_deploy 的发布不要用 ssh_exec 拼 rm 或 docker rm。

- 先 dryRun 看剧本，再真正部署。
- 只使用主机配置里的 deploy 布局。不要在调用时临时传 root、restartCmd 或 healthCmd。
- 生产主机必须带 reason。
- 健康检查失败会自动切回上一版。
