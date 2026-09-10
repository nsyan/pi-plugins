<div align="center">

# pi-plugins

**Pi 插件集 —— 可复用的 AI 扩展，即装即用**

基于 [pi](https://github.com/earendilofficial/pi) 的插件集合，含数据库接入等实用扩展。

</div>

## 📦 包含的插件

| 包 | 描述 |
|------|------|
| [db](./packages/db) | AI 接入数据库 —— 方言化架构，支持 PostgreSQL/MySQL/Oracle/达梦/Redis/Elasticsearch/MongoDB/Hive/Spark 九种数据库，提供查询/表结构/扫描建连工具 |

## 🚀 安装

使用 pi 命令直接安装某个插件：

```bash
pi install ./packages/db
```

## 📁 目录结构

```
pi-plugins/
├── packages/
│   └── db/        # 数据库接入插件
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

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本 **1.1.0**（2026-09-10）：db 插件新增 MongoDB 支持（document 家族）+ 连接管理体验升级（状态摘要/切换默认/从现有复制/环境标签+强制只读/db_connections 工具）。

## 📄 许可

[MIT](./LICENSE)
