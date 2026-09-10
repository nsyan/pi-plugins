import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registry } from "./src/dialects/index.js";
import { decide, effectiveReadonly, writeRequiresReason } from "./src/core/policy.js";
import { appendAuditLog } from "./src/core/audit.js";
import { scanProject } from "./src/core/scan/candidates.js";
import type { Candidate, ConnConfig, DbTypeId } from "./src/core/types.js";
import {
  loadConfigs, saveConfigs, loadPluginConfig, savePluginConfig, getConfigSummary,
  findConfig, toRuntimeConfig, shortTypeLabel, fullTypeLabel,
  parseConnectionString, getDefaultConfig, setDefaultConfig, writeQueryExport,
  recordLastUsed, recordTestResult, connSummaryLine, envTagLabel, formatRelativeTime,
} from "./src/config.js";
import type { PluginConfig } from "./src/config.js";

// ── URL 解析：遍历 registry 各方言 parseUrl，首个非 null 胜出 ────
// 关系型 JDBC + 原生 URI 双形态由各方言 parseUrl 兼收（Spec §7）

function parseDbUrl(url: string): { dialectId: DbTypeId; host: string; port: number; username?: string; password?: string; database?: string; dbIndex?: number; options?: Record<string, string> } | null {
  for (const d of registry.values()) {
    const p = d.parseUrl(url);
    if (p) return { dialectId: d.id, ...p };
  }
  return null;
}

function getDbNames(configs: ConnConfig[]): string {
  return configs
    .map((c) => {
      const desc = c.description ? `(${c.description})` : "";
      const typeLabel = shortTypeLabel(c.type);
      return `${c.name}[${typeLabel}]${desc}`;
    })
    .join(", ");
}

function buildDisplayList(configs: ConnConfig[]): { list: string[]; map: Map<string, ConnConfig> } {
  const map = new Map<string, ConnConfig>();
  const list: string[] = [];
  for (const c of configs) {
    const display = connSummaryLine(c);
    list.push(display);
    map.set(display, c);
  }
  return { list, map };
}

// ── 构建「可用数据库」提示（注入系统提示，让 AI 知道有哪些连接） ────
// 效率项（Spec §6）：每连接只注一行 `名称[家族] + 一行语义`，细节压进系统提示

// 各家族一行语义（KV/搜索/大数据行由后续任务的 dialect.label 接管，此处三库先行）
function familyHint(c: ConnConfig): string {
  switch (c.type) {
    case "postgresql":
    case "mysql":
    case "oracle":
      return "关系型，sql 参数填 SQL";
    case "mongodb":
      return "MongoDB 文档库，sql 参数填 JSON 命令信封（如 {\"find\":\"users\",\"filter\":{}}；读命令 find/count/distinct/aggregate）";
    default:
      return `${fullTypeLabel(c.type)}，sql 参数填查询或命令`;
  }
}

// 系统提示触发词文案（Spec §8.5：AI 侧入口；建连写盘前必须经用户确认）
const SCAN_TRIGGER_HINT = [
  "[项目扫描建连]",
  "当用户说“连一下这个项目的数据库”“帮我把这项目的库配上”等时，调用 scan_project_configs 工具扫描项目连接候选（返回掩码结果，不写盘）。",
  "建连写盘前必须经用户在终端确认（/db scan），密码类字段只在终端 TUI 补录，不进模型上下文。",
].join("\n");

function buildDbListHint(configs: ConnConfig[], cfg: PluginConfig): string {
  const policy = cfg.ai_readonly
    ? "当前 AI 只读模式：是。query_database 只能执行查询语句，禁止 INSERT、UPDATE、DELETE 等写操作。"
    : "当前 AI 只读模式：否。query_database 允许执行查询和写操作，不要因为工具名称或通用描述而将其限制为 SELECT。";
  const confirmation =
    cfg.confirm_before_exec === "never"
      ? "当前执行确认：不确认。符合条件的 SQL 不会弹出确认框。"
      : cfg.confirm_before_exec === "write"
        ? "当前执行确认：写操作确认。写操作执行前会弹出确认框。"
        : "当前执行确认：每次都确认。每条 SQL 执行前都会弹出确认框。";
  const safety = "DROP TABLE 始终禁止通过 query_database 执行，与 AI 只读模式设置无关。";

  if (configs.length === 0) {
    return [
      "[数据库工具执行策略]",
      policy,
      confirmation,
      safety,
      "[可用数据库]",
      "暂无数据库连接。请告知用户先通过 /db add 添加数据库连接，或用 /db scan 扫描项目配置建连，再执行查询。",
      SCAN_TRIGGER_HINT,
    ].join("\n");
  }
  const lines = configs.map((c) => {
    const desc = c.description ? ` - ${c.description}` : "";
    const tag = envTagLabel(c);
    return `- ${c.name}[${shortTypeLabel(c.type)}]${tag ? " " + tag : ""} - ${fullTypeLabel(c.type)}，${familyHint(c)}${desc}`;
  });
  return [
    "[数据库工具执行策略]",
    policy,
    confirmation,
    safety,
    "标注 [prod·强制只读] 的连接无论全局只读设置如何均只允许查询。",
    "[可用数据库]",
    ...lines,
    "query_database / list_tables / describe_table 的 database 参数必须使用上述名称（不含中括号内容，名称区分大小写）。",
    SCAN_TRIGGER_HINT,
  ].join("\n");
}

// scan 候选状态图标（Spec §8.5：✅ 可直接建 / ✏️ 待补字段 / 🔒 加密密码 / ⏭️ 已存在）
const SCAN_GLYPH: Record<Candidate["status"], string> = {
  ready: "✅", incomplete: "✏️", encrypted: "🔒", exists: "⏭️",
};

// 密码掩码（输出层红线）：真实密码不进模型上下文；jasypt ENC( 密文保留（非明文，可用信号）
function maskCandidate(c: Candidate): Candidate {
  const p = { ...c.partial };
  if (typeof p.password === "string" && p.password && !p.password.startsWith("ENC(")) p.password = "***";
  return { ...c, partial: p };
}

function candidateLine(c: Candidate): string {
  const p = c.partial;
  const miss = c.missing.length ? `，缺: ${c.missing.join("/")}` : "";
  return `${SCAN_GLYPH[c.status]} [${c.status}] ${p.name} (${c.dialectId}) ${p.host ?? ""}:${p.port ?? ""}${p.database ? "/" + p.database : ""}${miss} <- ${c.source.file}（置信度 ${c.source.confidence}）`;
}

// ── 导出扩展 ──────────────────────────────────────

// scan 向导核心（由 registerCommand 内的 scanWizard 调用；需要 ctx.ui）

export default function (pi: ExtensionAPI) {
  // ── 代码扫描建连向导（/db scan，Spec §8.5）──────
  // 硬性原则：绝不静默建连（每次写盘前确认）；绝不静默覆盖（同名三选一）；
  // jasypt ENC 只标注不建；密码类字段只在此 TUI 通道补录。
  const scanWizard = async (ctx: any, scanPath: string) => {
    let candidates: Candidate[];
    try {
      candidates = await scanProject(scanPath);
    } catch (err) {
      ctx.ui.notify(`扫描失败: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    if (candidates.length === 0) {
      ctx.ui.notify(`在 ${scanPath} 未扫出数据库连接候选`, "info");
      return;
    }

    // 1. 分组展示
    ctx.ui.notify(
      `扫描到 ${candidates.length} 个连接候选:\n${candidates.map(candidateLine).join("\n")}\n\n接下来逐个确认，不会静默建连。`,
      "info",
    );

    // 2. 逐个确认
    for (const cand of candidates) {
      if (cand.status === "encrypted") {
        ctx.ui.notify(
          `🔒 ${cand.partial.name}: 检测到 jasypt 加密密码（${cand.source.file}），不自动建连。请人工解密后用 /db add 手动添加。`,
          "info",
        );
        continue;
      }
      const ok = await ctx.ui.confirm("扫描建连", `添加 ${cand.partial.name} (${cand.dialectId})？\n来源: ${cand.source.file}`);
      if (!ok) continue;

      let name = cand.partial.name!;
      if (loadConfigs().some((x) => x.name === name)) {
        const how = await ctx.ui.select(`同名配置已存在: ${name}`, ["覆盖", "改名", "跳过"]);
        if (!how || how === "跳过") continue;
        if (how === "改名") {
          name = (await ctx.ui.input("新名称", name))?.trim() || name;
          // 改名后仍需查重：新名若也撞车，退回三选一（绝不静默覆盖）
          while (loadConfigs().some((x) => x.name === name)) {
            const again = await ctx.ui.select(`新名称 ${name} 也已存在`, ["覆盖", "再改一次", "跳过"]);
            if (!again || again === "跳过") { name = ""; break; }
            if (again === "再改一次") {
              name = (await ctx.ui.input("新名称", name))?.trim() || name;
              continue;
            }
            break; // 覆盖
          }
          if (name === "") continue;
        }
      }

      // 缺字段追问（仅 TUI；密码在此补录，不进模型上下文）
      const bag: Partial<ConnConfig> = { ...cand.partial, name };
      for (const f of cand.missing) {
        const v = (await ctx.ui.input(`补充 ${f}（${name}）`, ""))?.trim();
        if (v !== undefined && v !== "") {
          (bag as Record<string, unknown>)[f] = f === "port" || f === "dbIndex" ? parseInt(v, 10) : v;
        }
      }

      const dialect = registry.get(cand.dialectId);
      if (!dialect) continue;
      const conn: ConnConfig = { id: randomUUID(), createdAt: new Date().toISOString(), type: cand.dialectId, ...bag } as ConnConfig;

      // 3. 逐个 testConnection → 成功保存，失败给可操作建议
      ctx.ui.notify(`正在测试 ${dialect.label} 连接...`, "info");
      const result = await dialect.testConnection(toRuntimeConfig(conn, dialect.defaultPort));
      if (!result.success) {
        ctx.ui.notify(`连接失败: ${result.error}\n未保存。请检查网络/账号后重跑 /db scan，或用 /db add 手动添加。`, "error");
        continue;
      }
      ctx.ui.notify(`连接成功 (${result.version}${result.warning ? "，警告: " + result.warning : ""}, ${result.latency})`, "success");
      const all = loadConfigs();
      const idx = all.findIndex((x) => x.name === name);
      if (idx >= 0) all[idx] = conn; else all.push(conn);
      saveConfigs(all);
      recordTestResult(name, result);
      ctx.ui.notify(`配置已保存: ${name}`, "success");
    }
  };

  // ── 添加数据库连接（P0：一键连接串 / 家族分支逐步表单，Spec §7/§11.1）───
  const addDbConfig = async (ctx: any) => {
    const name = (await ctx.ui.input("连接名称", ""))?.trim();
    if (!name) { ctx.ui.notify("连接名称不能为空", "error"); return; }

    // 首问：一键连接串 / 逐步填写 / 从现有复制（v1.1 UX 共识 Q2）
    const mode = await ctx.ui.select("添加方式", [
      "⚡ 粘贴连接串（一键）",
      "📝 逐步填写",
      "📋 从现有复制",
    ]);
    if (!mode) return;

    if (mode === "📋 从现有复制") {
      const source = await selectDbConfig(ctx, loadConfigs(), "选择要复制的连接");
      if (!source) return;
      let newName = (await ctx.ui.input("新连接名称", `${source.name}-copy`))?.trim();
      while (newName && loadConfigs().some((c) => c.name === newName)) {
        newName = (await ctx.ui.input(`名称已存在: ${newName}，请换一个`, `${newName}-2`))?.trim();
      }
      if (!newName) { ctx.ui.notify("已取消复制", "info"); return; }
      const copy: ConnConfig = {
        ...source,
        id: randomUUID(),
        name: newName,
        isDefault: false,
        lastUsedAt: undefined,
        lastTest: undefined,
        createdAt: new Date().toISOString(),
      };
      const all = loadConfigs();
      all.push(copy);
      saveConfigs(all);
      ctx.ui.notify(`已复制为 ${newName}（类型/账号/环境标签等设置一并带上）`, "success");
      if (await ctx.ui.confirm("从现有复制", "立即编辑副本（主机/端口/库/标签等）？")) {
        await editDbConfig(ctx, copy);
      }
      return;
    }

    let parsed: ReturnType<typeof parseDbUrl>;
    let username = "";
    let password = "";
    let dbIndex: number | undefined;

    if (mode === "⚡ 粘贴连接串（一键）") {
      const url = (await ctx.ui.input("连接串", "postgresql://user:pass@host:5432/db 或 jdbc:mysql://... 或 redis://:pass@host:6379/0 或 mongodb://user:pass@host:27017/db"))?.trim();
      if (!url) { ctx.ui.notify("连接串不能为空", "error"); return; }
      const pcs = parseConnectionString(url);
      if (!pcs) {
        ctx.ui.notify("连接串无法识别。支持: postgresql/mysql/oracle/dm/hive JDBC、redis(s)://、mongodb(srv)://、http(s)://host:9200", "error");
        return;
      }
      parsed = { dialectId: pcs.dialectId, host: pcs.host, port: pcs.port, database: pcs.database, options: pcs.options };
      username = pcs.username ?? "";
      password = pcs.password ?? "";
      dbIndex = pcs.dbIndex;
    } else {
      const url = (await ctx.ui.input("连接 URL", "jdbc:postgresql://host:port/database 或 mongodb://host:27017/db"))?.trim();
      if (!url) { ctx.ui.notify("连接 URL 不能为空", "error"); return; }
      const pcs = parseConnectionString(url);
      if (!pcs) {
        ctx.ui.notify("URL 格式无法识别。支持格式:\n" +
          "  PostgreSQL/MySQL/DM/Hive: jdbc:<dialect>://host:port/db\n" +
          "  Oracle:     jdbc:oracle:thin:@//host:port/service 或 @host:port:SID\n" +
          "  Redis:      redis://[:password@]host:port[/db]\n" +
          "  MongoDB:    mongodb://user:pass@host:27017/db 或 mongodb+srv://...\n" +
          "  ES:         http://host:9200", "error");
        return;
      }
      parsed = { dialectId: pcs.dialectId, host: pcs.host, port: pcs.port, database: pcs.database, options: pcs.options };
      dbIndex = pcs.dbIndex;

      // 家族分支字段：Redis 无账号要求、需库号；MongoDB 账号可空；ES/其余 账号+密码
      if (parsed.dialectId === "redis") {
        password = (await ctx.ui.input("密码（可空）", ""))?.trim() ?? "";
        const idxInput = (await ctx.ui.input("库号 dbIndex（0-15，缺省 0）", String(dbIndex ?? 0)))?.trim();
        dbIndex = idxInput !== undefined && idxInput !== "" ? parseInt(idxInput, 10) : dbIndex;
      } else if (parsed.dialectId === "mongodb") {
        username = (await ctx.ui.input("账号（可空，本地无认证留空）", ""))?.trim() ?? "";
        password = (await ctx.ui.input("密码（可空）", ""))?.trim() ?? "";
      } else {
        username = (await ctx.ui.input("账号", "root"))?.trim() || "root";
        password = (await ctx.ui.input("密码", ""))?.trim() ?? "";
      }
    }

    const dialect = registry.get(parsed.dialectId)!;
    const description = (await ctx.ui.input("用途说明（可选）", ""))?.trim() || undefined;

    // 测试连接
    ctx.ui.notify(`正在测试 ${dialect.label} 连接...`, "info");
    const result = await dialect.testConnection(toRuntimeConfig({
      id: "", name, type: parsed.dialectId,
      host: parsed.host, port: parsed.port,
      username, password, database: parsed.database,
      dbIndex,
      createdAt: "",
    }, dialect.defaultPort));
    if (!result.success) {
      ctx.ui.notify(`连接失败: ${result.error}`, "error");
      return;
    }
    ctx.ui.notify(`连接成功 (${result.version}, ${result.latency})`, "success");

    // 环境标签（v1.1 UX 共识 Q3）：测试通过后再问，失败不浪费输入；prod 主动建议强制只读
    let envTag: ConnConfig["envTag"];
    let forceReadonly: boolean | undefined;
    const envChoice = await ctx.ui.select("环境标签（可跳过）", ["跳过", "dev", "test", "prod"]);
    if (envChoice && envChoice !== "跳过") {
      envTag = envChoice as ConnConfig["envTag"];
      if (envTag === "prod") {
        forceReadonly = await ctx.ui.confirm(
          "生产库安全建议",
          "将此连接设为强制只读？\n开启后该连接无视全局只读开关，永远只接受查询（生产库建议开启）。",
        );
      }
    }

    const configs = loadConfigs();
    if (configs.some((c) => c.name === name)) {
      ctx.ui.notify(`已存在同名配置: ${name}`, "error");
      return;
    }

    const config: ConnConfig = {
      id: randomUUID(),
      name,
      type: parsed.dialectId,
      description,
      host: parsed.host,
      port: parsed.port,
      username,
      password,
      database: parsed.database,
      dbIndex,
      options: parsed.options,
      envTag,
      forceReadonly,
      isDefault: configs.length === 0, // 首个连接自动设为默认（与提示文案一致）
      createdAt: new Date().toISOString(),
    };

    configs.push(config);
    saveConfigs(configs);
    recordTestResult(name, result);
    ctx.ui.notify(`配置已保存: ${name}${envTag ? ` [${envTag}${forceReadonly ? "·强制只读" : ""}]` : ""}${configs.length === 1 ? "（首个连接已设为默认）" : ""}`, "success");
  };

  // ── 编辑数据库连接 ──────────────────────────────
  const editDbConfig = async (ctx: any, original: ConnConfig) => {
    const currentUrl = registry.get(original.type)!.displayUrl(original);
    const prefill = [
      `名称: ${original.name}`,
      `URL: ${currentUrl}`,
      `账号: ${original.username}`,
      `密码: ${original.password || ""}`,
      `环境标签: ${original.envTag ?? ""}`,
      `强制只读: ${original.forceReadonly ? "是" : "否"}`,
      `说明: ${original.description || ""}`,
    ].join("\n");

    const result = await ctx.ui.editor("编辑数据库连接（修改后保存，留空则保持原值）", prefill);
    if (!result) return;

    // 解析编辑结果
    const lines = result.split("\n");

    function getValue(key: string): string | undefined {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(key + ":")) {
          return trimmed.slice(key.length + 1).trim();
        }
      }
      return undefined;
    }

    const name = getValue("名称") || original.name;
    const url = getValue("URL") || currentUrl;

    const parsed = parseDbUrl(url);
    if (!parsed) {
      ctx.ui.notify("JDBC URL 格式无法识别。", "error");
      return;
    }

    const username = getValue("账号") || original.username || "";
    const password = getValue("密码") ?? original.password ?? "";
    const descRaw = getValue("说明");
    const description = descRaw === "" ? undefined : (descRaw || original.description);

    // 环境标签/强制只读（行缺省=保持原值；标签仅接受 dev/test/prod，其余/清空=去除标签）
    const envRaw = getValue("环境标签")?.trim().toLowerCase();
    const envTag = envRaw === undefined || envRaw === ""
      ? (envRaw === "" ? undefined : original.envTag)
      : (["dev", "test", "prod"].includes(envRaw) ? envRaw as ConnConfig["envTag"] : original.envTag);
    const roRaw = getValue("强制只读")?.trim();
    const forceReadonly = roRaw === undefined ? original.forceReadonly : roRaw === "是";

    const updated: ConnConfig = {
      ...original,
      name,
      type: parsed.dialectId,
      host: parsed.host,
      port: parsed.port,
      username,
      password,
      database: parsed.database,
      options: parsed.options ?? original.options, // displayUrl 不带查询参数，保留原 options（authSource 等）
      envTag,
      forceReadonly,
      description,
    };

    const all = loadConfigs();
    if (updated.name !== original.name && all.some((c) => c.id !== original.id && c.name === updated.name)) {
      ctx.ui.notify(`已存在同名配置: ${updated.name}`, "error");
      return;
    }

    const idx = all.findIndex((c) => c.id === original.id);
    if (idx < 0) {
      ctx.ui.notify("找不到原配置", "error");
      return;
    }
    all[idx] = updated;
    saveConfigs(all);
    ctx.ui.notify(`已更新: ${updated.name}`, "success");

    // 编辑后自动回测（v1.1 UX 共识 Q1）：结果回写 lastTest，不阻塞保存
    const testDialect = registry.get(updated.type)!;
    ctx.ui.notify(`正在测试 ${testDialect.label} 连接...`, "info");
    const test = await testDialect.testConnection(toRuntimeConfig(updated, testDialect.defaultPort));
    recordTestResult(updated.name, test);
    ctx.ui.notify(
      test.success
        ? `✓ 连接正常 (${test.version ?? "?"}, ${test.latency ?? "?"})`
        : `⚠ 已保存，但连接测试失败: ${test.error}`,
      test.success ? "success" : "error",
    );
  };

  // ── 选择数据库公共操作 ────────────────────────────

  const selectDbConfig = async (ctx: any, configs: ConnConfig[], title: string): Promise<ConnConfig | undefined> => {
    if (configs.length === 0) {
      ctx.ui.notify("尚无数据库连接", "info");
      return undefined;
    }
    const { list, map } = buildDisplayList(configs);
    const choice = await ctx.ui.select(title, list);
    return choice ? map.get(choice) : undefined;
  };

  const showDbList = (ctx: any, configs: ConnConfig[]) => {
    if (configs.length === 0) {
      ctx.ui.notify("尚无数据库连接", "info");
      return;
    }
    const lines = configs.map((c) => `  ${connSummaryLine(c)}`);
    ctx.ui.notify(`数据库连接 (${configs.length}):\n${lines.join("\n")}`, "info");
  };

  const deleteDbConfig = async (ctx: any, configs: ConnConfig[]) => {
    const target = await selectDbConfig(ctx, configs, "选择要删除的连接");
    if (!target) return;
    const ok = await ctx.ui.confirm("确认删除", `确定删除数据库连接 ${target.name}？`);
    if (!ok) return;
    const all = loadConfigs();
    saveConfigs(all.filter((c) => c.id !== target.id));
    ctx.ui.notify(`已删除: ${target.name}`, "success");
  };

  // ── 选择数据库后操作菜单（循环，执行后留在当前界面）───
  // 菜单执行路径改走 registry + policy（deny 展示 reason；确认策略与工具一致——有意的行为变更）
  const showDbActions = async (ctx: any, config: ConnConfig) => {
    while (true) {
    const actions = [
      "📝 执行查询",
      "📋 列出表",
      "🔍 查看详情",
      "🧪 测试连接",
      config.isDefault ? "⭐ 取消默认" : "⭐ 设为默认",
      "✏️ 编辑",
      "🗑️ 删除",
      "← 返回",
    ];
    const choice = await ctx.ui.select(`选择操作 - ${config.name}${config.isDefault ? "（默认）" : ""}`, actions);
    if (!choice || choice === "← 返回") return;

    if (choice.startsWith("⭐")) {
      const all = loadConfigs();
      saveConfigs(setDefaultConfig(all, config.isDefault ? "" : config.id));
      ctx.ui.notify(config.isDefault ? `已取消默认: ${config.name}` : `已设为默认: ${config.name}`, "success");
      return;
    } else if (choice === "📝 执行查询") {
      const sql = (await ctx.ui.input("输入 SQL 语句", ""))?.trim();
      if (!sql) return;
      const cfg = loadPluginConfig();
      const dialect = registry.get(config.type)!;
      const effRo = effectiveReadonly(cfg.ai_readonly, config); // 连接级强制只读生效（v1.2 Q3）
      const verdict = dialect.isAllowed(sql, effRo);
      const action = decide(verdict, effRo, cfg.confirm_before_exec);
      if (action === "deny") {
        ctx.ui.notify(`不允许执行: ${verdict.reason}`, "error");
        continue;
      }
      if (action === "confirm") {
        const ok = await ctx.ui.confirm(
          "SQL 执行确认",
          `${verdict.summary ?? ""}\n\nSQL:\n${sql}`
        );
        if (!ok) continue;
      }
      ctx.ui.notify("正在执行查询...", "info");
      const result = await dialect.executeOn(toRuntimeConfig(config, dialect.defaultPort), sql, {
        readonly: effRo, maxRows: cfg.max_rows, timeoutSec: cfg.query_timeout,
      });
      if (result.success) {
        recordLastUsed(config.name);
        const lines = [`查询完成 (${result.duration})`, `返回 ${result.rowCount} 行`];
        if (result.columns && result.columns.length > 0) {
          lines.push("列: " + result.columns.join(", "));
        }
        if (result.rows && result.rows.length > 0) {
          const preview = result.rows.slice(0, 10).map((r) => JSON.stringify(r)).join("\n");
          lines.push("数据预览:\n" + preview);
          if (result.rows.length > 10) {
            lines.push(`... 还有 ${result.rows.length - 10} 行`);
          }
          if (result.rows.length > 50) {
            try {
              const exp = writeQueryExport(result.columns ?? [], result.rows, `db-menu-${config.name.replace(/[^\w.-]/g, "_")}`);
              lines.push(`完整结果已导出: ${exp.csvPath} | ${exp.jsonPath}`);
            } catch { /* 导出失败不影响主结果 */ }
          }
        }
        if (result.truncated) {
          lines.push("（结果已达 maxRows 上限截断）");
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        ctx.ui.notify(`查询失败: ${result.error}`, "error");
      }
    } else if (choice === "🧪 测试连接") {
      const dialect = registry.get(config.type)!;
      ctx.ui.notify(`正在测试 ${dialect.label} 连接...`, "info");
      const result = await dialect.testConnection(toRuntimeConfig(config, dialect.defaultPort));
      recordTestResult(config.name, result);
      ctx.ui.notify(
        result.success
          ? `✓ 连接正常 (${result.version ?? "?"}, ${result.latency ?? "?"})`
          : `✗ 连接失败: ${result.error}`,
        result.success ? "success" : "error",
      );
      continue;
    } else if (choice === "📋 列出表") {
      const dialect = registry.get(config.type)!;
      const result = await dialect.listTables(toRuntimeConfig(config, dialect.defaultPort));
      if (result.success && result.tables) {
        const lines = result.tables.map((t) => {
          const schema = t.schema ? `${t.schema}.` : "";
          const desc = t.description ? ` - ${t.description}` : "";
          return `${schema}${t.name} (${t.type})${desc}`;
        });
        ctx.ui.notify(`共 ${result.count} 张表:\n` + lines.join("\n"), "info");
      } else {
        ctx.ui.notify(`获取表列表失败: ${result.error}`, "error");
      }
    } else if (choice === "🔍 查看详情") {
      const dialect = registry.get(config.type)!;
      const url = dialect.displayUrl(config);
      const parts = [
        `【名称】 ${config.name}`,
        `【类型】 ${dialect.label}`,
        `【JDBC URL】 ${url}`,
        `【账号】 ${config.username}`,
      ];
      if (config.description) parts.push(`【说明】 ${config.description}`);
      parts.push(`【创建时间】 ${config.createdAt}`);
      ctx.ui.notify(parts.join("\n"), "info");
    } else if (choice === "✏️ 编辑") {
      await editDbConfig(ctx, config);
    } else if (choice === "🗑️ 删除") {
      const ok = await ctx.ui.confirm("确认删除", `确定删除数据库连接 ${config.name}？`);
      if (!ok) continue;
      const all = loadConfigs();
      saveConfigs(all.filter((c) => c.id !== config.id));
      ctx.ui.notify(`已删除: ${config.name}`, "success");
      return;
    }
    }
  };

  // ── 插件全局配置菜单 ────────────────────────────
  const showPluginConfigMenu = async (ctx: any) => {
    const cfg = loadPluginConfig();
    ctx.ui.notify(`当前设置:\n${getConfigSummary(cfg)}`, "info");
    await editPluginConfig(ctx, cfg);
  };

  const editPluginConfig = async (ctx: any, cfg: PluginConfig) => {
    const fields = [
      {
        key: "ai_readonly" as const,
        label: "AI 只读模式",
        current: cfg.ai_readonly ? "是" : "否",
        options: ["是", "否"],
      },
      {
        key: "confirm_before_exec" as const,
        label: "执行确认",
        current:
          cfg.confirm_before_exec === "never" ? "不确认" :
          cfg.confirm_before_exec === "write" ? "写操作确认" : "每次都确认",
        options: ["不确认", "写操作确认", "每次都确认"],
        valueMap: { "不确认": "never" as const, "写操作确认": "write" as const, "每次都确认": "always" as const },
      },
      {
        key: "max_rows" as const,
        label: "最大行数",
        current: String(cfg.max_rows),
      },
      {
        key: "query_timeout" as const,
        label: "查询超时(s)",
        current: String(cfg.query_timeout),
      },
      {
        key: "audit_enabled" as const,
        label: "审计日志",
        current: cfg.audit_enabled ? "是" : "否",
        options: ["是", "否"],
      },
    ];

    // 选择要修改的字段
    const fieldLabels = fields.map((f) => `${f.label}（当前: ${f.current}）`);
    fieldLabels.push("✅ 完成修改");

    const newCfg = { ...cfg };

    while (true) {
      const pick = await ctx.ui.select("选择要修改的设置项", fieldLabels);
      if (!pick || pick === "✅ 完成修改") break;

      const idx = fieldLabels.indexOf(pick);
      if (idx < 0) break;
      const field = fields[idx];

      if (field.options) {
        // 枚举型 -> 选择
        const val = await ctx.ui.select(`选择 ${field.label}`, field.options);
        if (!val) continue;
        if (field.valueMap) {
          (newCfg as any)[field.key] = field.valueMap[val];
        } else {
          (newCfg as any)[field.key] = val === "是";
        }
      } else {
        // 数字型 -> 输入
        const input = await ctx.ui.input(`${field.label}（当前: ${field.current}）`, field.current);
        if (!input) continue;
        const num = parseInt(input, 10);
        if (isNaN(num) || num <= 0) {
          ctx.ui.notify("请输入正整数", "error");
          continue;
        }
        (newCfg as any)[field.key] = num;
      }

      // 更新 fieldLabels 中的当前值
      const updatedFields = fields.map((f) => {
        const val = (newCfg as any)[f.key];
        const display =
          f.key === "ai_readonly" || f.key === "audit_enabled" ? (val ? "是" : "否") :
          f.key === "confirm_before_exec" ?
            (val === "never" ? "不确认" : val === "write" ? "写操作确认" : "每次都确认") :
            String(val);
        return `${f.label}（当前: ${display}）`;
      });
      updatedFields.push("✅ 完成修改");
      fieldLabels.length = 0;
      fieldLabels.push(...updatedFields);
    }

    savePluginConfig(newCfg);
    ctx.ui.notify(`设置已保存\n${getConfigSummary(newCfg)}`, "success");
  };

  // ── 系统提示注入：每轮告知 AI 可用数据库列表 ──────
  // 解决 AI 不知道有哪些数据库连接、database 参数只能靠猜的问题。

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + buildDbListHint(loadConfigs(), loadPluginConfig()),
    };
  });

  // ── 注册 3 个工具（给 LLM 调用） ──────────────────

  // 解析工具 database 参数：缺省走默认连接（Spec §11.1）；无默认则报错指引
  function resolveTargetDb(name: string | undefined): { config?: ConnConfig; error?: string } {
    const configs = loadConfigs();
    let config: ConnConfig | undefined;
    if (name === undefined || name === "") {
      config = getDefaultConfig(configs);
      if (!config) {
        return { error: `未指定 database 且无默认连接。可用数据库: ${configs.map((c) => c.name).join(", ") || "无"}。可在 /db 菜单「设为默认」，或在调用时显式传 database 参数。` };
      }
      return { config };
    }
    config = findConfig(configs, name);
    if (!config) {
      return { error: `数据库 "${name}" 未找到。可用数据库: ${configs.map((c) => c.name).join(", ") || "无"}。database 参数应使用系统提示「可用数据库」列表中的名称。` };
    }
    return { config };
  }

  // 工具 1: query_database
  pi.registerTool({
    name: "query_database",
    label: "数据库查询",
    description: "执行 SQL 语句，支持关系型（PostgreSQL/MySQL/Oracle/达梦）/ Redis / Elasticsearch / MongoDB / Hive / Spark 九种数据库，返回执行结果。支持读和写，写操作受确认策略约束且必须附 reason 执行理由（动机+影响范围），用户确认框将展示该理由；是否允许写以及是否需确认，以系统提示中的当前数据库工具执行策略为准。DROP TABLE 始终禁止。MongoDB 的 sql 参数填 JSON 命令信封（db.runCommand 形态，如 {\"find\":\"users\",\"filter\":{}}）。",
    promptSnippet: "执行 SQL 语句。先根据系统提示中的当前数据库工具执行策略判断是否允许写操作；写操作必须在 reason 参数说明动机与影响范围（如\"将status=2的历史订单归档，预计影响1.2万行\"），否则会被拒绝。database 参数取系统提示「可用数据库」列表中的名称（缺省走默认连接）。使用 list_tables 查看表结构后再编写 SQL。",
    parameters: Type.Object({
      database: Type.Optional(Type.String({ description: "数据库连接名称（取系统提示「可用数据库」列表中的名称；缺省走默认连接）" })),
      sql: Type.String({ description: "SQL 语句；MongoDB 填 JSON 命令信封，Redis 填命令，ES 填 DSL" }),
      reason: Type.Optional(Type.String({ description: "执行理由，写操作必填：动机+影响范围（如\"将status=2的历史订单归档，预计影响1.2万行\"）。读操作无需填写" })),
    }),
    async execute(_toolCallId: string, params: { database?: string; sql: string; reason?: string }, _signal: any, _onUpdate?: any, ctx?: any) {
      const cfg = loadPluginConfig();

      const target = resolveTargetDb(params.database);
      if (target.error || !target.config) {
        return {
          content: [{ type: "text" as const, text: target.error ?? "未找到数据库配置" }],
        };
      }
      const config = target.config;

      // 生效只读 = 全局只读 ∨ 连接级强制只读（v1.1 UX 共识 Q3）
      const effectiveReadOnly = effectiveReadonly(cfg.ai_readonly, config);

      // verdict 流程（策略层统一裁决，含 DROP 硬限制与只读检查）：
      // verdict = dialect.isAllowed(sql, readonly) → decide → deny/confirm/run
      const dialect = registry.get(config.type);
      if (!dialect) {
        return {
          content: [{ type: "text" as const, text: `数据库类型 "${config.type}" 暂不支持。` }],
        };
      }
      const verdict = dialect.isAllowed(params.sql, effectiveReadOnly);
      const action = decide(verdict, effectiveReadOnly, cfg.confirm_before_exec);
      if (action === "deny") {
        const note = !cfg.ai_readonly && config.forceReadonly === true
          ? `（连接 ${config.name} 已设置强制只读）`
          : "";
        return {
          content: [{ type: "text" as const, text: (verdict.reason ?? "该操作不被允许。如需修改，请执行 /db config 更改配置。") + note }],
        };
      }
      // 写操作强制附执行理由（v1.1 UX 共识 Q1/Q3：与确认策略解耦；缺 reason 拒绝并引导 AI 补充）
      if (writeRequiresReason(verdict, params.reason)) {
        return {
          content: [{ type: "text" as const, text: "写操作必须附执行理由：请在 reason 参数中说明动机与影响范围（如\"将status=2的历史订单归档，预计影响1.2万行\"），补充后重试。" }],
        };
      }
      if (action === "confirm") {
        if (!ctx?.hasUI) {
          return {
            content: [{ type: "text" as const, text: "当前环境无法弹出确认对话框，已取消 SQL 执行。请在有界面的环境中操作。" }],
          };
        }
        const ok = await ctx.ui.confirm(
          "SQL 执行确认",
          `理由: ${params.reason}\n\n${verdict.summary ?? ""}\n\n数据库: ${config.name}\n\nSQL:\n${params.sql}`,
        );
        if (!ok) {
          return {
            content: [{ type: "text" as const, text: "用户取消了 SQL 执行。" }],
          };
        }
        // 用户确认，继续执行
      }

      const result = await dialect.executeOn(
        toRuntimeConfig(config, dialect.defaultPort),
        params.sql,
        { readonly: effectiveReadOnly, maxRows: cfg.max_rows, timeoutSec: cfg.query_timeout },
      );

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `查询失败: ${result.error}` }],
        };
      }

      recordLastUsed(config.name);
      // 写操作审计（v1.1 UX 共识 Q4 + 可配置修订：默认关闭，cfg.audit_enabled 开启才落盘；失败不阻断主流程）
      if (verdict.isWrite && cfg.audit_enabled) {
        appendAuditLog({
          time: new Date().toISOString(),
          project: process.cwd(),
          connection: config.name,
          type: config.type,
          summary: verdict.summary ?? "",
          reason: (params.reason ?? "").trim(),
          sql: params.sql,
          readonly: effectiveReadOnly,
        });
      }
      let text = `查询完成 (${result.duration})，返回 ${result.rowCount} 行\n`;
      if (result.columns && result.columns.length > 0) {
        text += `列: ${result.columns.join(", ")}\n\n`;
      }
      if (result.rows && result.rows.length > 0) {
        // 格式化为表格文本
        const header = result.columns?.join(" | ") || "";
        const separator = result.columns?.map(() => "---").join(" | ") || "";
        const rows = result.rows.slice(0, 50).map((r) => r.join(" | "));
        text += [header, separator, ...rows].join("\n");
        if (result.rows.length > 50) {
          // P0 导出：长结果落盘 /tmp（CSV+JSON），只回路径不贴全量
          text += `\n... 还有 ${result.rows.length - 50} 行`;
          try {
            const exp = writeQueryExport(result.columns ?? [], result.rows, `db-query-${config.name.replace(/[^\w.-]/g, "_")}`);
            text += `\n完整结果已导出: ${exp.csvPath} | ${exp.jsonPath}`;
          } catch { /* 导出失败不影响主结果 */ }
        }
        if (result.truncated) {
          text += `\n（结果已达 maxRows 上限截断）`;
        }
      } else {
        text += "无数据返回。";
      }
      // 写操作理由随结果回显（v1.1 UX 共识 Q2：说了什么→做了什么闭环）
      if (verdict.isWrite) {
        text += `\n执行理由: ${params.reason}`;
      }

      return { content: [{ type: "text" as const, text }] };
    },
  });

  // 工具 2: list_tables
  pi.registerTool({
    name: "list_tables",
    label: "列出数据库表",
    description: "列出指定数据库中的所有表，包含 schema、表名、类型。支持 pattern 过滤。",
    promptSnippet: "列出数据库中的表（表上千时用 pattern 过滤，如 user%），了解表结构后再查询。database 参数取系统提示「可用数据库」列表中的名称（缺省走默认连接）。",
    parameters: Type.Object({
      database: Type.Optional(Type.String({ description: "数据库连接名称（取系统提示「可用数据库」列表中的名称；缺省走默认连接）" })),
      pattern: Type.Optional(Type.String({ description: "表名过滤模式，如 user% / order_*；缺省全量" })),
    }),
    async execute(_toolCallId: string, params: { database?: string; pattern?: string }, _signal: any) {
      const target = resolveTargetDb(params.database);
      if (target.error || !target.config) {
        return {
          content: [{ type: "text" as const, text: target.error ?? "未找到数据库配置" }],
        };
      }
      const config = target.config;

      const dialect = registry.get(config.type);
      if (!dialect) {
        return {
          content: [{ type: "text" as const, text: `数据库类型 "${config.type}" 暂不支持。` }],
        };
      }
      const result = await dialect.listTables(toRuntimeConfig(config, dialect.defaultPort), params.pattern);

      if (!result.success || !result.tables) {
        return {
          content: [{ type: "text" as const, text: `获取表列表失败: ${result.error}` }],
        };
      }
      recordLastUsed(config.name);

      const lines = result.tables.map((t) => {
        const schema = t.schema ? `${t.schema}.` : "";
        const desc = t.description ? ` - ${t.description}` : "";
        return `${schema}${t.name} (${t.type})${desc}`;
      });

      return {
        content: [{ type: "text" as const, text: `数据库 "${config.name}"${params.pattern ? `（pattern: ${params.pattern}）` : ""} 共 ${result.count} 张表:\n${lines.join("\n")}` }],
      };
    },
  });

  // 工具 3: describe_table
  pi.registerTool({
    name: "describe_table",
    label: "查看表结构",
    description: "查看指定表的列定义、类型、默认值、主键等。",
    promptSnippet: "查看表结构，了解列名和类型后编写精确的 SQL。database 参数取系统提示「可用数据库」列表中的名称（缺省走默认连接）。",
    parameters: Type.Object({
      database: Type.Optional(Type.String({ description: "数据库连接名称（取系统提示「可用数据库」列表中的名称；缺省走默认连接）" })),
      table: Type.String({ description: "表名（可带 schema，如 public.users）" }),
    }),
    async execute(_toolCallId: string, params: { database?: string; table: string }, _signal: any) {
      const target = resolveTargetDb(params.database);
      if (target.error || !target.config) {
        return {
          content: [{ type: "text" as const, text: target.error ?? "未找到数据库配置" }],
        };
      }
      const config = target.config;

      const dialect = registry.get(config.type);
      if (!dialect) {
        return {
          content: [{ type: "text" as const, text: `数据库类型 "${config.type}" 暂不支持。` }],
        };
      }
      const result = await dialect.describeTable(toRuntimeConfig(config, dialect.defaultPort), params.table);

      if (!result.success || !result.columns) {
        return {
          content: [{ type: "text" as const, text: `获取表结构失败: ${result.error}` }],
        };
      }
      recordLastUsed(config.name);

      const lines = [`表: ${params.table}`, `共 ${result.count} 列\n`];
      // 表头
      lines.push("列名 | 类型 | 可空 | 默认值 | 主键 | 说明");
      lines.push("--- | --- | --- | --- | --- | ---");
      for (const col of result.columns) {
        lines.push(
          `${col.name} | ${col.type} | ${col.nullable ? "YES" : "NO"} | ${col.default ?? ""} | ${col.primaryKey ? "✓" : ""} | ${col.comment || ""}`
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  });

  // 工具 4: scan_project_configs（Spec §8.5 AI 侧入口；只返回掩码候选，不写盘）
  pi.registerTool({
    name: "scan_project_configs",
    label: "扫描项目数据库配置",
    description: "扫描项目源码（Spring 配置 / docker-compose / .env 等）抽取数据库连接候选。只返回掩码后的候选列表，绝不写盘；建连请让用户在终端执行 /db scan 完成。",
    promptSnippet: "当用户说“连一下这个项目的数据库”“帮我把这项目的库配上”等时调用。返回掩码候选与状态（可直接建/待补/加密/已存在）；把结果展示给用户后，引导其在终端用 /db scan 完成建连。path 必须在当前工作目录子树内。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "扫描根目录，缺省为当前工作目录；强制限定在当前工作目录子树内，越界拒绝" })),
    }),
    async execute(_toolCallId: string, params: { path?: string }, _signal: any) {
      try {
        const candidates = (await scanProject(params.path ?? ".")).map(maskCandidate);
        if (candidates.length === 0) {
          return {
            content: [{ type: "text" as const, text: `在 ${params.path ?? "当前目录"} 未扫出数据库连接候选。可建议用户用 /db add 手动添加。` }],
          };
        }
        const text = [
          `扫描到 ${candidates.length} 个连接候选（密码已掩码，不写盘）：`,
          ...candidates.map(candidateLine),
          "",
          "建连写盘需用户确认：请引导用户在终端执行 /db scan 完成逐个确认与密码补录。",
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `扫描失败: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });

  // 工具 5: db_connections（v1.1 UX 共识 Q5：AI 自查连接清单与环境标签，识别生产库）
  pi.registerTool({
    name: "db_connections",
    label: "列出数据库连接",
    description: "列出所有已配置的数据库连接（名称/类型/环境标签/默认标记/最近测试结果/连接地址，不含密码）。用于确认可用连接、识别生产库。增删改连接需用户在终端执行 /db。",
    promptSnippet: "当用户提到某个环境（如“生产库”）或不确定该用哪个连接时，先调用本工具确认连接清单再查询；database 参数应使用返回列表中的名称。",
    parameters: Type.Object({}),
    async execute() {
      const configs = loadConfigs();
      if (configs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "尚无数据库连接。请引导用户在终端执行 /db add 或 /db scan 建连。" }],
        };
      }
      const lines = configs.map((c) => {
        const marks = [c.isDefault ? "⭐默认" : "", envTagLabel(c)].filter(Boolean).join(" ");
        const test = c.lastTest
          ? `测试 ${formatRelativeTime(c.lastTest.at)} ${c.lastTest.ok ? "✓" : "✗"}${c.lastTest.latency ? " " + c.lastTest.latency : ""}${c.lastTest.version ? " · " + c.lastTest.version : ""}`
          : "未测试";
        const used = c.lastUsedAt ? `上次使用 ${formatRelativeTime(c.lastUsedAt)}` : "";
        const url = registry.get(c.type)?.displayUrl(c) ?? "";
        return `- ${c.name} [${shortTypeLabel(c.type)}]${marks ? " " + marks : ""} - ${fullTypeLabel(c.type)}${c.database ? " · 库: " + c.database : ""} · ${url} · ${test}${used ? " · " + used : ""}${c.description ? " · " + c.description : ""}`;
      });
      return {
        content: [{ type: "text" as const, text: `共 ${configs.length} 个连接：\n${lines.join("\n")}\n\n标注 [prod·强制只读] 的连接永远只读（即使全局允许写操作）。` }],
      };
    },
  });

  // ── 注册 /db 命令（给用户管理连接） ──────────────
  pi.registerCommand("db", {
    description: "AI 接入数据库",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().toLowerCase();
      const configs = loadConfigs();

      if (!sub) {
        // 导航菜单：查看 / 编辑 / 新增 / 删除 / 设置
        const navActions = [
          "📋 打开连接",
          "⚡ 切换默认",
          "✏️ 编辑连接",
          "➕ 新增连接",
          "🔎 扫描建连",
          "🗑️ 删除连接",
          "⚙️ 设置",
        ];
        const navChoice = await ctx.ui.select("数据库管理", navActions);
        if (!navChoice) return;

        if (navChoice === "⚙️ 设置") {
          await showPluginConfigMenu(ctx);
        } else if (navChoice === "📋 打开连接") {
          const config = await selectDbConfig(ctx, configs, "选择连接");
          if (config) await showDbActions(ctx, config);
        } else if (navChoice === "⚡ 切换默认") {
          // v1.1 UX 共识 Q1：两层直达，替代“打开→动作→设为默认”三层路径
          const configsNow = loadConfigs();
          if (configsNow.length === 0) {
            ctx.ui.notify("尚无数据库连接", "info");
          } else {
            const target = await selectDbConfig(ctx, configsNow, "设为默认连接（⭐ 为当前默认）");
            if (target) {
              if (target.isDefault) {
                ctx.ui.notify(`已是默认连接: ${target.name}`, "info");
              } else {
                saveConfigs(setDefaultConfig(configsNow, target.id));
                ctx.ui.notify(`默认连接已切换: ${target.name}`, "success");
              }
            }
          }
        } else if (navChoice === "✏️ 编辑连接") {
          const config = await selectDbConfig(ctx, configs, "选择要编辑的连接");
          if (config) await editDbConfig(ctx, config);
        } else if (navChoice === "➕ 新增连接") {
          await addDbConfig(ctx);
        } else if (navChoice === "🔎 扫描建连") {
          await scanWizard(ctx, ".");
        } else if (navChoice === "🗑️ 删除连接") {
          await deleteDbConfig(ctx, configs);
        }
      } else if (sub === "config" || sub === "c") {
        await showPluginConfigMenu(ctx);
      } else if (sub === "add" || sub === "new" || sub === "a") {
        await addDbConfig(ctx);
      } else if (sub === "edit" || sub === "e") {
        const config = await selectDbConfig(ctx, configs, "选择要编辑的连接");
        if (config) await editDbConfig(ctx, config);
      } else if (sub === "rm" || sub === "remove" || sub === "del" || sub === "delete" || sub === "d") {
        await deleteDbConfig(ctx, configs);
      } else if (sub === "scan" || sub.startsWith("scan ")) {
        // /db scan [path]：path 缺省为当前工作目录，越界由 scanProject 拒绝
        const scanPath = args.trim().slice(4).trim() || ".";
        await scanWizard(ctx, scanPath);
      } else if (sub === "ls" || sub === "list") {
        showDbList(ctx, configs);
      } else {
        ctx.ui.notify(
          "用法: /db [add|edit|rm|ls|scan|config]\n" +
          "  add    新增数据库连接\n" +
          "  edit   编辑连接\n" +
          "  rm     删除连接\n" +
          "  ls     列出所有连接\n" +
          "  scan   扫描项目配置建连（可带路径，缺省当前目录）\n" +
          "  config 查看/修改插件设置\n" +
          "  默认    打开管理菜单（查看/编辑/新增/扫描/删除/设置）",
          "info"
        );
      }
    },
  });
}