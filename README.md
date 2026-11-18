<div align="center">

# pi-plugins

**Pi 插件集 —— 可复用的 AI 扩展，即装即用**

基于 [pi](https://github.com/earendilofficial/pi) 的插件集合，含数据库接入等实用扩展。

</div>

## 📦 包含的插件

| 包 | 描述 |
|------|------|
| [db](./packages/db) | AI 接入数据库 —— 方言化架构，支持 PostgreSQL/MySQL/Oracle/达梦/Redis/Elasticsearch/MongoDB/Neo4j/Hive/Spark 十种数据库，提供查询/表结构/扫描建连工具 |
| [ssh](./packages/ssh) | AI 远程运维 —— SSH/SFTP/FTP：13 个 ssh_* 工具 + `/ssh` 管理面板，危险命令分级确认、JSONL 审计、known_hosts 校验、release+软链部署与自动回滚 |

> 装到 `0.0.0-stage` 是镜像上的占位空壳（无 `index.ts`，工具不注册）：`curl -X PUT https://registry.npmmirror.com/-/package/@nsyan/ssh/syncs` 后 `pi update npm:@nsyan/ssh`。详见 [packages/ssh/README.md](./packages/ssh/README.md#-安装)。

## 🚀 安装

使用 pi 命令从 npm 安装（推荐）：

```bash
pi install npm:@nsyan/db     # db —— AI 数据库接入
pi install npm:@nsyan/ssh    # ssh —— AI 远程运维（SSH/SFTP/FTP）
```

仓库开发者走本地路径：

```bash
pi install ./packages/db
pi install ./packages/ssh
```

## 📁 目录结构

```
pi-plugins/
├── packages/
│   ├── db/        # 数据库接入插件
│   └── ssh/       # 远程运维插件
├── pnpm-workspace.yaml
├── package.json
├── .gitignore
└── README.md
```

## 🔧 开发

```bash
pnpm install          # 安装 workspace 依赖
pnpm test             # 运行全部包的测试
```

> `pnpm` workspace 管理；单测用 `tsx --test` + `node:test`，无构建产物（TypeScript 由 pi/tsx 直接加载）。

## 🤝 贡献

欢迎提交插件或改进建议。新增插件放在 `packages/` 下，遵循现有包结构与零 pi 运行时依赖的 core/dialects 分层约定。

## 📜 更新记录

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本：db **1.3.7**（2026-11-19，读写判定改为白名单，只读模式真正拦住 `COPY`/`GRANT`/`SET`/`VACUUM`/`DO`/`EXPLAIN ANALYZE` 等此前漏判的写语句；生产连接写审计改为先落盘再执行；配置改原子写且损坏不再静默当成空列表）、ssh **0.1.4**（2026-11-18，`/ssh` 面板代码审查修掉 8 个缺陷：编辑输错密码不再销毁旧密码、复制不再静默覆盖同名主机、复制出的主机不共用凭据引用、FTP 必问密码、端口可清空回默认、坏审计行不再崩面板、单主机 `exec` 不空跑、编辑可取消 prod 标签）。

## 📄 许可

[MIT](./LICENSE)
