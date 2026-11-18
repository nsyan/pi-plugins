<div align="center">

# pi-plugins

**Pi 插件集 —— 可复用的 AI 扩展，即装即用**

基于 [pi](https://github.com/earendilofficial/pi) 的插件集合，含数据库接入等实用扩展。

</div>

## 📦 包含的插件

| 包 | 版本 | 描述 | 文档 |
|------|------|------|------|
| [db](./packages/db) | [![npm](https://img.shields.io/npm/v/@nsyan/db?color=cb3837)](https://www.npmjs.com/package/@nsyan/db) | AI 接入数据库 —— 方言化架构，支持 PostgreSQL/MySQL/Oracle/达梦/Redis/Elasticsearch/MongoDB/Neo4j/Hive/Spark 十种数据库，提供查询/表结构/扫描建连工具 | [README](./packages/db/README.md) · [使用手册](./packages/db/docs/USAGE.md) · [CHANGELOG](./CHANGELOG.md) |
| [ssh](./packages/ssh) | [![npm](https://img.shields.io/npm/v/@nsyan/ssh?color=cb3837)](https://www.npmjs.com/package/@nsyan/ssh) | AI 远程运维 —— SSH/SFTP/FTP：13 个 ssh_* 工具 + `/ssh` 管理面板，危险命令分级确认、JSONL 审计、known_hosts 校验、release+软链部署与自动回滚 | [README](./packages/ssh/README.md) · [设计文档](./docs/superpowers/specs/2026-11-18-ssh-plugin-design.md) · [回归手册](./docs/superpowers/reports/ssh-regression-checklist.md) · [CHANGELOG](./CHANGELOG.md) |

两个包的 README 结构一致：安装 → 快速开始 → 工具清单 → 命令 → 安全模型 → 故障排查 → 开发。

> 装到 `0.0.0-stage` 是镜像上的占位空壳（无 `index.ts`，工具不注册）：`curl -X PUT https://registry.npmmirror.com/-/package/@nsyan/ssh/syncs` 后 `pi update npm:@nsyan/ssh`。详见 [packages/ssh/README.md](./packages/ssh/README.md#-故障排查)。

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
│   ├── db/            # 数据库接入插件
│   │   ├── src/{core,dialects,ui}/
│   │   ├── docs/USAGE.md
│   │   └── test/
│   └── ssh/           # 远程运维插件
│       ├── src/{core,transports,ui,scan}/
│       ├── skills/{remote-ops,deploy}/
│       └── test/
├── docs/superpowers/  # 设计文档 / 测试报告 / 回归手册
├── pnpm-workspace.yaml
├── package.json
├── CHANGELOG.md
└── README.md
```

## 🔧 开发

```bash
pnpm install                              # 安装 workspace 依赖
pnpm test                                 # 运行全部包的测试

# 单包
pnpm --filter @nsyan/db  test             # 238 项
pnpm --filter @nsyan/ssh test             # 209 项
pnpm --filter @nsyan/db  typecheck
pnpm --filter @nsyan/ssh typecheck
```

> `pnpm` workspace 管理；单测用 `tsx --test` + `node:test`，无构建产物（TypeScript 由 pi/tsx 直接加载）。
> 两个包的 README 都有独立的「开发」与「故障排查」章节，含真机回归要求。

## 🤝 贡献

欢迎提交插件或改进建议。新增插件放在 `packages/` 下，遵循现有包结构与零 pi 运行时依赖的 core/dialects 分层约定。

## 📜 更新记录

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本：db **1.3.8**（2026-11-19，读写判定改为白名单，只读模式真正拦住 `COPY`/`GRANT`/`SET`/`VACUUM`/`DO`/`EXPLAIN ANALYZE` 等此前漏判的写语句；生产连接写审计改为先落盘再执行；配置改原子写且损坏不再静默当成空列表）、ssh **0.1.5**（2026-11-18，修复部署失败后残留半成品 release 目录——此前越界包被拒或解包失败会在远端留下空 `releases/<ts>`，会被回滚当成有效候选）。

## 📄 许可

[MIT](./LICENSE)
