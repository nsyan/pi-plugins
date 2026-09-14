<div align="center">

# pi-plugins

**Pi 插件集 —— 可复用的 AI 扩展，即装即用**

基于 [pi](https://github.com/earendilofficial/pi) 的插件集合，含数据库接入等实用扩展。

</div>

## 📦 包含的插件

| 包 | 描述 |
|------|------|
| [db](./packages/db) | AI 接入数据库 —— 方言化架构，支持 PostgreSQL/MySQL/Oracle/达梦/Redis/Elasticsearch/MongoDB/Neo4j/Hive/Spark 十种数据库，提供查询/表结构/扫描建连工具 |

## 🚀 安装

使用 pi 命令从 npm 安装（推荐）：

```bash
pi install npm:@nsyan/db     # db —— AI 数据库接入
```

仓库开发者走本地路径：

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

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本 **1.3.3**（2026-09-14）：发布元数据优化——description 压入 npm 255 字符上限、补全检索关键词、发布包附 LICENSE 与 engines 声明。

## 📄 许可

[MIT](./LICENSE)
