// src/ui/sql-confirm.ts —— SQL 执行确认弹窗（展示层）。
//
// 目标：把「弹窗里那段密不透风的 SQL」变成可读的格式化 + 语法高亮 + 有层次的排版。
//
// 能力边界（已核对 pi / pi-web 源码）：
// - ctx.ui.confirm 底层是 SelectList，标题/正文按纯文本渲染，无法高亮；
// - ctx.ui.custom 可挂任意 TUI 组件，且 pi-tui 的 Markdown 代码块会调用
//   theme.highlightCode（cli-highlight），这就是 TUI 的 SQL 语法高亮入口；
// - RPC（pi-web）下 custom() 返回 undefined，但 pi-web 0.9.x 的确认弹窗正文
//   用 react-markdown 渲染，代码围栏走 Prism（已注册 sql/json），因此**发 Markdown
//   就能在 pi web 里高亮**（还会自带语言标签/行号/复制按钮 + 正文原生滚动）。
//   注意：Markdown 会把单个换行折叠成空格，所以标签之间必须用空行/列表分隔。
// - RPC 的 confirm 请求只有 title/message/timeout，弹窗尺寸由 pi-web 写死
//   （560×760），插件层改不了。
import type { DbTypeId } from "../core/types.js";
import { displayLangFor, formatSqlForDisplay } from "../core/sql-format.js";

export interface SqlConfirmInfo {
  /** 写操作执行理由（菜单「执行查询」路径没有 reason） */
  reason?: string;
  /** 策略层摘要，如「CREATE IF（共 1 条语句）」 */
  summary?: string;
  database?: string;
  sql: string;
  type: DbTypeId;
}

/** 压缩换行/多余空白：Markdown 单换行会折叠，多行理由先并成一行避免结构被破坏 */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 转义会破坏行内代码/引用的反引号（其余 Markdown 符号在中文语境下误伤概率低，不激进转义） */
function escInline(s: string): string {
  return s.replace(/`/g, "\\`");
}

/** 围栏长度 = SQL 里最长反引号串 + 1（至少 3），避免语句内含 ``` 时把围栏撑破 */
function fenceFor(sql: string): string {
  const runs = sql.match(/`+/g) ?? [];
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 构造确认弹窗的 Markdown 正文（TUI 与 pi web 共用同一份文案）。
 * 结构：引用块(执行理由) + 列表(影响摘要/数据库) + 代码块(SQL，带方言语言标记)。
 * 颜色由主题对 引用/加粗/行内代码/代码块 的默认着色决定（Markdown 无法任意指定颜色）。
 */
export function buildSqlConfirmMarkdown(info: SqlConfirmInfo): string {
  const sql = formatSqlForDisplay(info.sql, info.type);
  const lang = displayLangFor(info.type) ?? "";
  const fence = fenceFor(sql);
  const lines: string[] = [];

  const reason = info.reason ? oneLine(info.reason) : "";
  if (reason) {
    lines.push(`> **📝 执行理由**：${escInline(reason)}`);
    lines.push("");
  }

  const meta: string[] = [];
  const summary = info.summary ? oneLine(info.summary) : "";
  const database = info.database ? oneLine(info.database) : "";
  if (summary) meta.push(`- **📋 影响摘要**：\`${escInline(summary)}\``);
  if (database) meta.push(`- **🗄️ 数据库**：\`${escInline(database)}\``);
  if (meta.length > 0) {
    lines.push(...meta);
    lines.push("");
  }

  lines.push(`${fence}${lang}`);
  lines.push(sql);
  lines.push(fence);
  return lines.join("\n");
}

/** TUI 自定义弹窗：标题 + Markdown 正文（引用/列表/高亮 SQL 代码块）+ 操作提示 */
async function showTuiConfirm(ctx: any, markdown: string): Promise<boolean> {
  const [{ DynamicBorder, getMarkdownTheme }, { Container, Markdown, matchesKey, Text }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);

  const result = await ctx.ui.custom((_tui: any, theme: any, _kb: any, done: (v: boolean) => void) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("SQL 执行确认")), 1, 0));
    // 与 pi web 同一份 Markdown：Markdown 代码块 → highlightCode(code, lang) → 语法高亮
    container.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
    container.addChild(new Text(theme.fg("dim", "Enter 执行  ·  Esc 取消"), 1, 1));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter")) { done(true); return; }
        if (matchesKey(data, "escape")) { done(false); return; }
      },
    };
  });

  return result === true;
}

/**
 * 统一的 SQL 执行确认入口。返回 true 表示用户确认执行。
 * 任何 UI 异常都回退到 ctx.ui.confirm（同一份 Markdown）——确认环节绝不因渲染故障被静默跳过。
 */
export async function confirmSqlExecution(ctx: any, info: SqlConfirmInfo): Promise<boolean> {
  const markdown = buildSqlConfirmMarkdown(info);
  if (ctx?.mode === "tui" && typeof ctx?.ui?.custom === "function") {
    try {
      return await showTuiConfirm(ctx, markdown);
    } catch {
      // 自定义组件不可用/异常 → 落到下方 confirm
    }
  }
  const ok = await ctx.ui.confirm("SQL 执行确认", markdown);
  return ok === true;
}
