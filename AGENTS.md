# 仓库约定（AGENTS.md）

本文件是给 AI agent 与会话模型的硬约束。与代码注释冲突时以本文件为准。

---

## 版本号与发布（强制）

适用于 `packages/db` 与 `packages/ssh`。

### 1. 版本号只能 +0.0.1

- 每次升级只允许 **patch +1**：`1.3.8 → 1.3.9`、`0.1.4 → 0.1.5`。
- **禁止**跳号、回退、跨段（不得 `1.3.8 → 1.4.0` / `2.0.0` / `1.3.10` 一次加 2）。
- 例外只有一种：`0.x` 系列同样按 patch +1（`0.1.5 → 0.1.6`），不因「未到 1.0」改用 minor。

### 2. 不得自行决定版本号

- **必须等用户明确指示**才改 `package.json` 的 `version`。
- 「改完了」「优化一下」「顺手修了 bug」**都不构成升级授权**。
- 用户说「升版本」「发版」时，按 §1 在当前版本上 +0.0.1。
- 未经指示改了版本号 = 违规，必须回退。

### 3. 发布同样需要明确指示

- `npm publish` 只能由用户授权后执行。
- 发布前必须：`npx tsc -p tsconfig.typecheck.json` 通过 + 全量单测通过。
- 发布命令必须显式指定官方 registry（本机全局 registry 是镜像站，会 ENEEDAUTH）：

  ```bash
  npm publish --registry=https://registry.npmjs.org
  ```

### 4. 版本号改动必须同步的位置

改 `version` 时，以下位置要一起改，缺一个都算没改完：

| 位置 | 内容 |
|---|---|
| `packages/<pkg>/package.json` | `"version"` |
| `CHANGELOG.md` | 新增 `## [<pkg> <ver>] - YYYY-MM-DD` 章节 |
| 根 `README.md` | 「当前版本：db **x.y.z** … ssh **x.y.z**」 |
| 源码/测试注释里的版本标记 | 如 `v1.3.8` 这类引用 |

---

## 验证要求（强制）

- 改动策略层（`src/core/policy.ts`、`src/core/sql-text.ts`、方言 `isAllowed`）时，测试矩阵**必须覆盖真实配置组合**，不能只测最严格那一档。
  - db 的确认策略是 `never / write / always` × 只读开关 × 连接级强制只读。
  - 历史事故：`EXPLAIN ANALYZE DELETE` 在「可写 + never」下直执行，而所有测试都跑在只读模式，纯单测完全没暴露。
- 声称「已验证」必须给出可复现的命令与输出，不接受「应该没问题」。

---

## 代码边界

- `packages/*/src/core`、`src/dialects`（db）/ `src/transports`（ssh）**不得 import 任何 pi 运行时模块**，为将来输出 MCP server 保留零依赖边界。
- `index.ts` 只做注册与 UI 编排，执行逻辑放 `src/runtime.ts`（ssh 已如此，db 待收敛）。
