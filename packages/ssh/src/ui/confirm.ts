// src/ui/confirm.ts —— 远端动作确认弹窗（展示层）。
//
// 修两个真实问题（用户截图反馈）：
// 1. 理由不显示：ssh_exec 的 reason 只进了审计，从未进过确认框正文；
// 2. 命令挤成一行：confirm 正文按纯文本渲染，单个换行被折叠成空格，
//    `set -e\nTS=...` 这类多行脚本糊成一坨，人没法核对。
//
// 能力边界（与 packages/db/src/ui/sql-confirm.ts 同一套结论，已核对 pi 源码）：
// - ctx.ui.confirm 底层是 SelectList，纯文本、单换行会折叠；
// - ctx.ui.custom 可挂任意 TUI 组件，pi-tui 的 Markdown 代码块会走 highlightCode；
// - RPC（pi-web）下 custom() 不可用，但 pi-web 0.9.x 的确认弹窗正文用 react-markdown
//   渲染、代码围栏走 Prism（已注册 bash），所以**发同一份 Markdown 就能在 pi web 里高亮**；
// - RPC 的 confirm 请求只有 title/message/timeout，弹窗尺寸由 pi-web 写死，插件改不了。
//
// 相对 db 那份（0.1.2 补齐）：deploy/rollback 的剧本 + notes 比一条 SQL 长得多，
// 挤在编辑器槽里会把转录区顶走，所以这里自己做了**视口滚动**（db 那份没有），
// 键位改走宿主注入的 KeybindingsManager，用户改过键位也生效（硬编码 enter/escape 在改键后失效）。
import type { Danger } from "../core/policy.js";

/** 宿主 KeybindingsManager 的键位名（"tui.select.confirm" 等）；pi-tui 不导出这个联合类型 */
type KeybindingName = Parameters<import("@earendil-works/pi-tui").KeybindingsManager["matches"]>[1];
type KeyId = Parameters<typeof import("@earendil-works/pi-tui").matchesKey>[1];

export interface RemoteConfirmInfo {
  /** 标题后缀，如「删除文件或目录」「上传并覆盖」 */
  action: string;
  /** 主机名 */
  host: string;
  /** 策略分级 */
  danger?: Danger;
  /** 执行理由（ssh_exec / ssh_sudo / ssh_deploy / ssh_rollback 的 reason） */
  reason?: string;
  /** 影响摘要，给人看的一句话 */
  summary?: string;
  /** 要执行的命令或多行剧本；有值就放进代码块 */
  command?: string;
  /** 命令的语言标记（bash 等）；缺省 bash */
  lang?: string;
  /** 额外的事实条目，如「切换 /srv/app/current」「重启：systemctl restart app」 */
  notes?: string[];
  /** 追加在正文末尾的提示（如「健康检查失败会自动回退上一版」） */
  warning?: string;
}

const DANGER_LABEL: Record<Danger, string> = {
  read: "只读",
  write: "写入",
  destructive: "破坏性",
};

/** Markdown 单换行会折叠，多行文本先并成一行，避免结构被破坏 */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 转义会破坏行内代码的反引号 */
function escInline(s: string): string {
  return s.replace(/`/g, "\\`");
}

/** 围栏长度 = 内容里最长反引号串 + 1（至少 3），避免脚本内含 ``` 时撑破代码块 */
function fenceFor(body: string): string {
  const runs = body.match(/`+/g) ?? [];
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 构造确认弹窗的 Markdown 正文。TUI 与 pi web 共用同一份文案。
 * 结构：引用块(理由) + 列表(分级/主机/影响/事实) + 代码块(命令) + 提示。
 */
export function buildRemoteConfirmMarkdown(info: RemoteConfirmInfo): string {
  const lines: string[] = [];

  const reason = info.reason ? oneLine(info.reason) : "";
  if (reason) {
    lines.push(`> **📝 执行理由**：${escInline(reason)}`);
    lines.push("");
  }

  const meta: string[] = [];
  if (info.danger) meta.push(`- **⚠️ 分级**：\`${DANGER_LABEL[info.danger]}\``);
  meta.push(`- **🖥️ 主机**：\`${escInline(oneLine(info.host))}\``);
  const summary = info.summary ? oneLine(info.summary) : "";
  if (summary) meta.push(`- **📋 影响**：${escInline(summary)}`);
  for (const note of info.notes ?? []) {
    const line = oneLine(note);
    if (line) meta.push(`- ${escInline(line)}`);
  }
  lines.push(...meta);

  const command = (info.command ?? "").replace(/\s+$/, "");
  if (command) {
    const fence = fenceFor(command);
    lines.push("");
    lines.push(`${fence}${info.lang ?? "bash"}`);
    lines.push(command);
    lines.push(fence);
  }

  if (info.warning) {
    lines.push("");
    lines.push(`> ⚠️ ${escInline(oneLine(info.warning))}`);
  }

  return lines.join("\n");
}

/** 弹窗标题：主机 + 动作，避免多个确认框长得一样 */
export function confirmTitle(info: RemoteConfirmInfo): string {
  return `${info.host}：${info.action}`;
}

// ── 视口滚动（纯函数，给单测） ────────────────────────────────────

export interface ViewSlice {
  /** 当前可见的行 */
  lines: string[];
  /** 规范化后的起始行（调用方应写回） */
  offset: number;
  /** 内容总行数 */
  total: number;
  /** 上下各还有多少行没显示 */
  above: number;
  below: number;
}

/** 把内容裁成 height 行的窗口。offset 会被夹到合法区间，内容不足时整段显示。 */
export function sliceViewport(lines: string[], offset: number, height: number): ViewSlice {
  const total = lines.length;
  // NaN / 0 / 负数都当「至少一行」：Math.max(1, NaN) 仍是 NaN，会让 slice 返回空屏。
  const rows = Number.isFinite(height) && height > 0 ? Math.max(1, Math.floor(height)) : 1;
  const maxOffset = Math.max(0, total - rows);
  const start = Math.max(0, Math.min(maxOffset, Number.isFinite(offset) ? Math.trunc(offset) : 0));
  return {
    lines: lines.slice(start, start + rows),
    offset: start,
    total,
    above: start,
    below: Math.max(0, total - start - rows),
  };
}

/** 弹窗正文可用的行数：终端行数扣掉边框/标题/页脚。算不出来时按 24 行终端兜底。 */
export function viewportHeight(terminalRows: number | undefined): number {
  const rows = Number.isFinite(terminalRows) && terminalRows && terminalRows > 0 ? terminalRows : 24;
  return Math.max(4, Math.floor(rows) - 8);
}

/** TUI 自定义弹窗：标题 + Markdown 正文（引用/列表/高亮代码块）+ 滚动 + 操作提示 */
async function showTuiConfirm(ctx: any, title: string, markdown: string): Promise<boolean> {
  const [{ DynamicBorder, getMarkdownTheme }, { Container, Markdown, matchesKey, Text, truncateToWidth }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);

  const result = await ctx.ui.custom((tui: any, theme: any, keybindings: any, done: (v: boolean) => void) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
    // 与 pi web 同一份 Markdown：代码块 → highlightCode(code, lang) → 语法高亮
    const body = new Markdown(markdown, 1, 1, getMarkdownTheme());

    container.addChild(border);
    container.addChild(titleText);
    container.addChild(body);
    container.addChild(border);

    let offset = 0;
    let rendered: string[] = [];
    let lastWidth = -1;

    // 宿主注入的 KeybindingsManager 优先：用户改过键位后硬编码的 enter/escape 会失效。
    const isKey = (data: string, name: string, fallback: KeyId): boolean => {
      if (keybindings && typeof keybindings.matches === "function") {
        try {
          return keybindings.matches(data, name as KeybindingName);
        } catch {
          // 未知键位名 → 退回默认键
        }
      }
      return matchesKey(data, fallback);
    };
    const pageSize = () => Math.max(1, viewportHeight(tui?.terminal?.rows) - 2);

    return {
      render(width: number) {
        // Markdown 组件自己缓存解析结果，这里每帧重算只为了按窗口裁剪。
        if (width !== lastWidth) {
          lastWidth = width;
          rendered = body.render(width);
        }
        const view = sliceViewport(rendered, offset, viewportHeight(tui?.terminal?.rows));
        offset = view.offset;
        const hint = view.total > view.lines.length
          ? `↑↓ 滚动 (${view.offset + 1}-${view.offset + view.lines.length}/${view.total})  ·  PgUp/PgDn 翻页  ·  Enter 执行  ·  Esc 取消`
          : "Enter 执行  ·  Esc 取消";
        const lines = [
          ...border.render(width),
          ...titleText.render(width),
          ...view.lines,
          ...new Text(theme.fg("dim", hint), 1, 1).render(width),
          ...border.render(width),
        ];
        return lines.map((line) => truncateToWidth(line, width));
      },
      invalidate() {
        lastWidth = -1;
        container.invalidate();
      },
      handleInput(data: string) {
        if (isKey(data, "tui.select.confirm", "enter")) { done(true); return; }
        if (isKey(data, "tui.select.cancel", "escape")) { done(false); return; }
        let moved = 0;
        if (isKey(data, "tui.select.up", "up") || data === "k") moved = -1;
        else if (isKey(data, "tui.select.down", "down") || data === "j") moved = 1;
        else if (isKey(data, "tui.select.pageUp", "pageUp")) moved = -pageSize();
        else if (isKey(data, "tui.select.pageDown", "pageDown")) moved = pageSize();
        else if (matchesKey(data, "home") || data === "g") moved = -rendered.length;
        else if (matchesKey(data, "end") || data === "G") moved = rendered.length;
        if (moved === 0) return;
        // 先按当前窗口夹一次，避免越界后要按两下才动。
        offset = sliceViewport(rendered, offset + moved, viewportHeight(tui?.terminal?.rows)).offset;
        tui?.requestRender?.();
      },
    };
  }, { blocked: { kind: "permission", message: title } });

  return result === true;
}

/**
 * 统一的远端动作确认入口。返回 true 表示用户确认执行。
 * 任何 UI 异常都回退到 ctx.ui.confirm（同一份 Markdown）——确认环节绝不因渲染故障被静默跳过。
 */
export async function confirmRemoteAction(ctx: any, info: RemoteConfirmInfo): Promise<boolean> {
  const markdown = buildRemoteConfirmMarkdown(info);
  const title = confirmTitle(info);
  if (ctx?.mode === "tui" && typeof ctx?.ui?.custom === "function") {
    try {
      return await showTuiConfirm(ctx, title, markdown);
    } catch {
      // 自定义组件不可用/异常 → 落到下方 confirm
    }
  }
  const ok = await ctx.ui.confirm(title, markdown);
  return ok === true;
}
