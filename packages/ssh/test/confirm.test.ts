import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  buildRemoteConfirmMarkdown,
  confirmRemoteAction,
  confirmTitle,
  sliceViewport,
  viewportHeight,
  type RemoteConfirmInfo,
} from "../src/ui/confirm.js";

const base: RemoteConfirmInfo = {
  host: "szzf-58",
  action: "删除文件或目录",
};

describe("buildRemoteConfirmMarkdown", () => {
  it("理由以引用块出现在最前面", () => {
    const md = buildRemoteConfirmMarkdown({ ...base, reason: "清理测试残留目录" });
    assert.match(md, /^> \*\*📝 执行理由\*\*：清理测试残留目录/);
  });

  it("理由的多行被并成一行（Markdown 单换行会折叠）", () => {
    const md = buildRemoteConfirmMarkdown({ ...base, reason: "第一行\n\n第二行" });
    const first = md.split("\n")[0];
    assert.match(first, /第一行 第二行/);
    assert.equal(first.includes("\n"), false);
  });

  it("没有理由时不出现理由行", () => {
    const md = buildRemoteConfirmMarkdown(base);
    assert.equal(md.includes("执行理由"), false);
  });

  it("命令放进代码块并保留换行", () => {
    const command = "set -e\nTS=1\nmkdir -p /tmp/x";
    const md = buildRemoteConfirmMarkdown({ ...base, command });
    assert.match(md, /```bash\nset -e\nTS=1\nmkdir -p \/tmp\/x\n```/);
  });

  it("多行脚本不再被压成一行（此前挤在一起的核心问题）", () => {
    const md = buildRemoteConfirmMarkdown({ ...base, command: "a=1\nb=2\nc=3" });
    const body = md.split("```bash\n")[1].split("\n```")[0];
    assert.deepEqual(body.split("\n"), ["a=1", "b=2", "c=3"]);
  });

  it("命令含反引号时围栏自动加长", () => {
    const command = "echo ```x```";
    const md = buildRemoteConfirmMarkdown({ ...base, command });
    // 内容里最长反引号串是 3，围栏应为 4
    assert.match(md, /````bash\n/);
  });

  it("分级与主机写进列表", () => {
    const md = buildRemoteConfirmMarkdown({ ...base, danger: "destructive" });
    assert.match(md, /- \*\*⚠️ 分级\*\*：`破坏性`/);
    assert.match(md, /- \*\*🖥️ 主机\*\*：`szzf-58`/);
  });

  it("warning 用引用块收尾", () => {
    const md = buildRemoteConfirmMarkdown({ ...base, warning: "健康检查失败会自动回退" });
    assert.match(md, /> ⚠️ 健康检查失败会自动回退$/);
  });

  it("行内代码里的反引号被转义，不撑破结构", () => {
    const md = buildRemoteConfirmMarkdown({ ...base, summary: "路径 a`b" });
    assert.match(md, /a\\`b/);
  });
});

describe("confirmTitle", () => {
  it("主机 + 动作", () => {
    assert.equal(confirmTitle(base), "szzf-58：删除文件或目录");
  });
});

// ── 视口滚动（deploy/rollback 的剧本比一条 SQL 长得多） ─────────────

describe("sliceViewport", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `L${index}`);

  it("内容不足一屏时整段显示", () => {
    const view = sliceViewport(["a", "b"], 0, 10);
    assert.deepEqual(view.lines, ["a", "b"]);
    assert.equal(view.above, 0);
    assert.equal(view.below, 0);
    assert.equal(view.total, 2);
  });

  it("offset 越界被夹到合法区间", () => {
    assert.equal(sliceViewport(lines, -5, 10).offset, 0);
    assert.equal(sliceViewport(lines, 999, 10).offset, 20);
    assert.deepEqual(sliceViewport(lines, 999, 10).lines, lines.slice(20));
  });

  it("上下剩余行数如实上报（用于「↑↓ 滚动」提示）", () => {
    const view = sliceViewport(lines, 5, 10);
    assert.deepEqual(view.lines, lines.slice(5, 15));
    assert.equal(view.above, 5);
    assert.equal(view.below, 15);
  });

  it("高度非法时至少留一行", () => {
    assert.equal(sliceViewport(lines, 0, 0).lines.length, 1);
    assert.equal(sliceViewport(lines, 0, Number.NaN).lines.length, 1);
  });
});

describe("viewportHeight", () => {
  it("按终端行数扣掉边框/标题/页脚，算不出来时按 24 行兜底", () => {
    assert.equal(viewportHeight(40), 32);
    assert.equal(viewportHeight(undefined), 16);
    assert.equal(viewportHeight(6), 4);
  });
});

// ── TUI 自定义组件（含滚动与键位） ─────────────────────────────────

const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/** 断言前剥掉 ANSI（渲染结果带主题色，长度/正则会失真） */
function plain(lines: string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

// Markdown 组件通过 getMarkdownTheme() 读全局主题，渲染前必须初始化，否则抛
// "Theme not initialized"。真实宿主在启动时已经 initTheme 过。
before(async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
});

/** 模拟宿主：capture 组件、记录 done、提供 requestRender 计数与终端行数 */
function fakeTui(rows = 40) {
  const state: { comp?: any; resolved?: boolean; renders: number } = { renders: 0 };
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: any) => {
        const tui = { terminal: { rows }, requestRender: () => { state.renders += 1; } };
        const keybindings = { matches: (data: string, name: string) => {
          const map: Record<string, string[]> = {
            "tui.select.confirm": ["\r", "\n"],
            "tui.select.cancel": ["\x1b", "\x03"],
            "tui.select.up": ["\x1b[A"],
            "tui.select.down": ["\x1b[B"],
            "tui.select.pageUp": ["\x1b[5~"],
            "tui.select.pageDown": ["\x1b[6~"],
          };
          return (map[name] ?? []).includes(data);
        } };
        state.comp = factory(tui, fakeTheme, keybindings, (v: boolean) => { state.resolved = v; });
        return undefined;
      },
    },
  };
  return { ctx, state };
}

describe("confirmRemoteAction（TUI）", () => {
  const info: RemoteConfirmInfo = {
    host: "szzf-58",
    action: "部署 20261118",
    danger: "destructive",
    reason: "发版",
    command: "ln -sfn releases/1 current\nsystemctl restart app",
  };

  it("走 custom 组件，Enter 确认 / Esc 取消", async () => {
    const first = fakeTui();
    assert.equal(await confirmRemoteAction(first.ctx, info), false);
    assert.ok(first.state.comp, "未构造 TUI 组件");
    first.state.comp.handleInput("\r");
    assert.equal(first.state.resolved, true);

    const second = fakeTui();
    await confirmRemoteAction(second.ctx, info);
    second.state.comp.handleInput("\x1b");
    assert.equal(second.state.resolved, false);
  });

  it("标题是「主机：动作」，正文含理由、分级与代码块", async () => {
    const { ctx, state } = fakeTui();
    await confirmRemoteAction(ctx, info);
    const screen = plain(state.comp.render(80));
    assert.match(screen, /szzf-58：部署 20261118/);
    assert.match(screen, /执行理由/);
    assert.match(screen, /破坏性/);
    assert.match(screen, /systemctl restart app/);
  });

  it("长剧本可滚动：PgDn 后首行变化，且提示带位置", async () => {
    const long: RemoteConfirmInfo = {
      ...info,
      command: Array.from({ length: 120 }, (_, i) => `echo step-${i}`).join("\n"),
      notes: Array.from({ length: 20 }, (_, i) => `事实 ${i}`),
    };
    const { ctx, state } = fakeTui(24);
    await confirmRemoteAction(ctx, long);
    const before = plain(state.comp.render(80));
    assert.match(before, /↑↓ 滚动 \(1-/);
    const renders = state.renders;
    state.comp.handleInput("\x1b[6~"); // PgDn
    assert.ok(state.renders > renders, "滚动后未请求重绘");
    const after = plain(state.comp.render(80));
    assert.notEqual(after, before);
    // PgDn 之后起始行必须前进（不写死具体行数：窗口高度随终端行数变化）
    const start = (text: string) => Number(/↑↓ 滚动 \((\d+)-/.exec(text)?.[1]);
    assert.ok(start(after) > start(before), `未前进：${start(before)} → ${start(after)}`);
  });

  it("短内容不显示滚动提示", async () => {
    const { ctx, state } = fakeTui(40);
    await confirmRemoteAction(ctx, { host: "h", action: "a", command: "echo 1" });
    const screen = plain(state.comp.render(80));
    assert.equal(screen.includes("↑↓ 滚动"), false);
    assert.match(screen, /Enter 执行/);
  });

  it("每行都裁到宽度内（终端换行会把弹窗撑坏）", async () => {
    const { ctx, state } = fakeTui(40);
    await confirmRemoteAction(ctx, { ...info, command: `echo ${"x".repeat(400)}` });
    for (const line of state.comp.render(60)) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, "").length;
      assert.ok(visible <= 60, `超宽行：${visible}`);
    }
  });
});

describe("confirmRemoteAction（RPC / pi web）", () => {
  it("不走 custom，confirm 收到同一份 Markdown", async () => {
    let message = "";
    const ctx = {
      mode: "rpc",
      ui: { confirm: async (_t: string, m: string) => { message = m; return true; } },
    };
    const ok = await confirmRemoteAction(ctx, { host: "h", action: "删除文件或目录", danger: "destructive", command: "rm -rf /tmp/x" });
    assert.equal(ok, true);
    assert.match(message, /- \*\*⚠️ 分级\*\*：`破坏性`/);
    assert.match(message, /```bash\nrm -rf \/tmp\/x\n```/);
  });

  it("custom 抛错时回退 confirm（确认环节不被跳过）", async () => {
    let confirmed = false;
    const ctx = {
      mode: "tui",
      ui: {
        custom: async () => { throw new Error("boom"); },
        confirm: async () => { confirmed = true; return false; },
      },
    };
    assert.equal(await confirmRemoteAction(ctx, { host: "h", action: "a", command: "rm x" }), false);
    assert.equal(confirmed, true);
  });
});
