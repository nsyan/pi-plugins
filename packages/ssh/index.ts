import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readAudit, defaultAuditPath } from "./src/core/audit.js";
import { loadHosts, saveHosts, defaultConfigPath } from "./src/core/config.js";
import { doctorLines } from "./src/core/doctor.js";
import { parseSshConfig } from "./src/scan/ssh-config.js";
import { projectDeployFiles } from "./src/scan/project.js";
import { saveHostCandidate } from "./src/scan/save.js";
import { defaultSecretsPath, putSecret } from "./src/core/secrets.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeHosts } from "./src/prompt.js";
import { createRuntime } from "./src/runtime.js";

const runtime = createRuntime();

function text(value: string, details: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: value }], details, isError };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return text(message, { error: message }, true);
}

async function readSecret(
  ctx: { ui: { confirm: (title: string, message: string) => Promise<boolean>; input: (title: string, placeholder?: string) => Promise<string | undefined>; onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => () => void; setStatus?: (key: string, value: string | undefined) => void } },
  title: string,
  prompt: string,
): Promise<string | undefined> {
  if (!ctx.ui.onTerminalInput || !ctx.ui.setStatus) {
    const accepted = await ctx.ui.confirm(title, "当前界面不能掩码。密码会明文输入，并且只进本次调用，不写入命令。继续？");
    if (!accepted) return undefined;
    return ctx.ui.input(prompt, title);
  }
  const setStatus = ctx.ui.setStatus.bind(ctx.ui);
  setStatus("ssh-secret", prompt);
  return new Promise((resolve) => {
    let value = "";
    const off = ctx.ui.onTerminalInput!((data) => {
      if (data === "\r" || data === "\n") {
        off();
        setStatus("ssh-secret", undefined);
        resolve(value);
        return { consume: true };
      }
      if (data === "\u0003" || data === "\u001b") {
        off();
        setStatus("ssh-secret", undefined);
        resolve(undefined);
        return { consume: true };
      }
      if (data === "\u007f" || data === "\b") value = value.slice(0, -1);
      else value += data;
      setStatus("ssh-secret", "*".repeat(value.length) || prompt);
      return { consume: true };
    });
  });
}

export default function sshExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    void runtime.closeTunnels();
  });

  pi.registerTool({
    name: "ssh_hosts",
    label: "SSH 主机",
    description: "列出已配置主机，或测试某一台的连接。",
    promptSnippet: "查看或测试 SSH 主机。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("test")]),
      name: Type.Optional(Type.String({ description: "test 时的主机名" })),
      acceptNewHostKey: Type.Optional(Type.Boolean({ description: "首次连接时记录主机密钥" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const file = loadHosts();
        if (params.action === "list") return text(describeHosts(file), { count: Object.keys(file.hosts).length });
        const result = await runtime.testHost({ host: params.name, acceptNewHostKey: params.acceptNewHostKey });
        return text(`${params.name ?? "活动主机"} ${result.transport} ${result.auth} ${result.fingerprint} ${result.latencyMs}ms`, result);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_ls",
    label: "SSH 列目录",
    description: "用 SFTP 列出远端目录，返回类型、大小和文件名。",
    promptSnippet: "列出远端目录。",
    parameters: Type.Object({
      path: Type.String({ description: "远端目录" }),
      host: Type.Optional(Type.String({ description: "主机名" })),
    }),
    async execute(_toolCallId, params) {
      try {
        return text(await runtime.list(params), { path: params.path });
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_read",
    label: "SSH 读文件",
    description: "读取远端文本文件的一段。offset 从 1 开始，默认 200 行。单次最多 200 行或 512KB，按 UTF-8 字符边界截断。",
    promptSnippet: "按行读取远端文件。",
    parameters: Type.Object({
      path: Type.String({ description: "远端文件" }),
      host: Type.Optional(Type.String({ description: "主机名" })),
      offset: Type.Optional(Type.Number({ description: "起始行，从 1 开始" })),
      limit: Type.Optional(Type.Number({ description: "行数" })),
    }),
    async execute(_toolCallId, params) {
      try {
        return text(await runtime.read(params), { path: params.path });
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_exec",
    label: "SSH 执行",
    description: "在已配置的主机上执行一条非交互命令。没有 TTY，sudo 和 top 不能用。破坏性命令会先请用户确认。",
    promptSnippet: "在远端主机执行命令。两台及以上主机必须传 host。",
    promptGuidelines: [
      "用 ssh_exec 跑远端命令，不要用本机 bash 里的 ssh。",
      "已配置多台主机时，ssh_exec 必须传 host。",
      "用户拒绝后不要改写命令再试。",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "远端命令" }),
      host: Type.Optional(Type.String({ description: "主机名。只有一台时可以省略" })),
      cwd: Type.Optional(Type.String({ description: "远端工作目录" })),
      timeoutSec: Type.Optional(Type.Number({ description: "超时秒数" })),
      reason: Type.Optional(Type.String({ description: "生产主机破坏性操作必填：动机和影响范围" })),
      waitFor: Type.Optional(Type.Object({
        port: Type.Optional(Type.Number()),
        http: Type.Optional(Type.String()),
        file: Type.Optional(Type.String()),
        timeoutSec: Type.Number(),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        let lastAt = 0;
        let pending = "";
        let lastBytes = 0;
        const flush = (force = false) => {
          const now = Date.now();
          if (!force && now - lastAt < 100 && Buffer.byteLength(pending) < 8192) return;
          if (!pending) return;
          lastAt = now;
          const textChunk = pending;
          pending = "";
          onUpdate?.({ content: [{ type: "text", text: textChunk }], details: { bytes: lastBytes } });
        };
        const result = await runtime.exec({
          host: params.host,
          command: params.command,
          cwd: params.cwd,
          timeoutSec: params.timeoutSec,
          reason: params.reason,
          waitFor: params.waitFor,
          signal,
          onData: (chunk) => {
            pending += chunk;
            lastBytes += chunk.length;
            flush();
          },
          ui: ctx.ui,
        });
        flush(true);
        const status = result.exitCode === null ? "超时或中止" : `退出码 ${result.exitCode}`;
        return text(`${status}\n${result.text}`, { exitCode: result.exitCode, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_put",
    label: "SSH 上传",
    description: "用 SFTP 上传一个文件。先写 .part，校验 sha256 后转正。覆盖已有文件前会备份并请用户确认。不接受目录。",
    promptSnippet: "上传本地文件到远端。目录要先在本地打包。",
    promptGuidelines: ["目录不要逐个 ssh_put。先打成一个包再传。"],
    parameters: Type.Object({
      localPath: Type.String({ description: "本地文件" }),
      remotePath: Type.String({ description: "远端文件路径" }),
      host: Type.Optional(Type.String({ description: "主机名" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      try {
        let lastAt = 0;
        let lastBytes = 0;
        const result = await runtime.put({
          ...params,
          ui: ctx.ui,
          onProgress: (sent, total) => {
            const now = Date.now();
            if (now - lastAt < 100 && sent - lastBytes < 8192 && sent < total) return;
            lastAt = now;
            lastBytes = sent;
            onUpdate?.({ content: [{ type: "text", text: `已传 ${sent}/${total}` }], details: { sent, total } });
          },
        });
        return text(`已上传 ${result.bytes} 字节，sha256 ${result.sha256}${result.backupPath ? `，原文件备份在 ${result.backupPath}` : ""}`, result);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_get",
    label: "SSH 下载",
    description: "用 SFTP 把远端文件下载到本地。",
    promptSnippet: "下载远端文件到本地。",
    parameters: Type.Object({
      remotePath: Type.String({ description: "远端文件" }),
      localPath: Type.String({ description: "本地保存路径" }),
      host: Type.Optional(Type.String({ description: "主机名" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await runtime.get(params);
        return text(`已下载 ${result.bytes} 字节，sha256 ${result.sha256}`, result);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_sudo",
    label: "SSH sudo",
    description: "在远端用 sudo 执行命令。密码由用户在本地输入，不作为工具参数，也不写入命令文本。",
    promptSnippet: "需要 root 时用 ssh_sudo，不要把密码写进命令。",
    promptGuidelines: ["不要在 ssh_exec 里拼接 sudo 密码。改用 ssh_sudo。"],
    parameters: Type.Object({
      command: Type.String({ description: "交给 sudo 的命令" }),
      host: Type.Optional(Type.String({ description: "主机名" })),
      reason: Type.Optional(Type.String({ description: "生产主机的破坏性命令必填" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await runtime.sudo({
          ...params,
          ui: {
            confirm: (title, message) => ctx.ui.confirm(title, message),
            secret: async (title, prompt) => readSecret(ctx, title, prompt),
          },
        });
        return text(`退出码 ${result.exitCode}\n${result.text}`, { exitCode: result.exitCode });
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_tunnel",
    label: "SSH 端口转发",
    description: "把远端才能访问的地址转到本机 127.0.0.1。listenPort 由调用方指定，0 表示让系统选空闲端口。只监听本机回环，不对外网卡开放。",
    promptSnippet: "把远端服务转到本机回环端口。",
    parameters: Type.Object({
      listenPort: Type.Number({ description: "本机端口。0 表示自动选择" }),
      destHost: Type.String({ description: "从远端看到的目标主机" }),
      destPort: Type.Number({ description: "目标端口" }),
      direction: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
      host: Type.Optional(Type.String({ description: "跳板主机名" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const opened = await runtime.tunnel({ ...params, ui: ctx.ui });
        return text(`127.0.0.1:${opened.port} -> ${params.destHost}:${params.destPort}`, { port: opened.port });
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_deploy",
    label: "SSH 部署",
    description: "按主机配置里的 deploy 布局发布。缺省是 tar。重启命令和健康检查只读配置，不接受调用时临时传入。",
    promptSnippet: "按主机上的 deploy 布局发布。",
    parameters: Type.Object({
      localPath: Type.String({ description: "本地制品" }),
      host: Type.Optional(Type.String({ description: "主机名" })),
      kind: Type.Optional(Type.Union([Type.Literal("tar"), Type.Literal("file")])),
      releaseId: Type.Optional(Type.String({ description: "发布号，缺省用时间" })),
      dryRun: Type.Optional(Type.Boolean({ description: "只返回剧本，不上传不切换" })),
      reason: Type.Optional(Type.String({ description: "生产主机必填" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await runtime.deploy({ ...params, ui: ctx.ui });
        if (result.dryRun) return text(`只生成剧本，未执行。目标 ${result.current}`, result);
        return text(result.rolledBack ? `健康检查失败，已切回 ${result.current}` : `已切换到 ${result.current}`, result);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_rollback",
    label: "SSH 回滚",
    description: "按主机上的 deploy 布局回滚，或恢复一个带 .bak 的文件。",
    promptSnippet: "回滚远端 release 或文件。",
    parameters: Type.Object({
      host: Type.Optional(Type.String({ description: "主机名" })),
      target: Type.Object({
        kind: Type.Union([Type.Literal("file"), Type.Literal("release")]),
        path: Type.Optional(Type.String({ description: "kind 为 file 时的远端文件" })),
        to: Type.Optional(Type.String({ description: "kind 为 release 时的发布号，缺省上一版" })),
      }),
      reason: Type.Optional(Type.String({ description: "生产主机必填" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.target.kind === "file" && !params.target.path) return failure(new Error("文件回滚需要 target.path"));
        const result = await runtime.rollback({
          host: params.host,
          file: params.target.kind === "file" ? params.target.path : undefined,
          to: params.target.kind === "release" ? params.target.to : undefined,
          reason: params.reason,
          ui: ctx.ui,
        });
        return text(`已回滚到 ${result.current}`, result);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "ssh_doctor",
    label: "SSH 体检",
    description: "检查本机 ssh2、系统 ssh、known_hosts 和审计目录，不连接远端。",
    promptSnippet: "检查本机 SSH 插件环境。",
    parameters: Type.Object({}),
    async execute() {
      return text(doctorLines().join("\n"), {});
    },
  });

  pi.registerTool({
    name: "ssh_scan_sources",
    label: "扫描 SSH 来源",
    description: "解析本机 ~/.ssh/config 的具体 Host，并列出当前目录里可能含部署目标的文件。不写入配置。",
    promptSnippet: "扫描已有 SSH 配置和项目里的部署文件。",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "项目目录，缺省当前目录" })),
    }),
    async execute(_toolCallId, params) {
      let configText = "";
      try {
        configText = readFileSync(join(homedir(), ".ssh", "config"), "utf8");
      } catch {
        configText = "";
      }
      const hosts = parseSshConfig(configText);
      const files = projectDeployFiles(params.cwd ?? process.cwd());
      const hostLines = hosts.map((item) => `${item.name} ${item.user ?? ""}@${item.hostName ?? item.name}`);
      return text([...hostLines, ...files.map((file) => `file ${file}`)].join("\n") || "没有具体 Host", { hosts, files });
    },
  });

  pi.registerTool({
    name: "ssh_host_save",
    label: "保存 SSH 主机",
    description: "先实测连接，再把主机写入配置。没有私钥时密码进 0600 文件，不进参数。同名时覆盖、改名或跳过。",
    promptSnippet: "实测通过后再保存一台 SSH 主机。",
    parameters: Type.Object({
      name: Type.String(),
      host: Type.String(),
      user: Type.String(),
      port: Type.Optional(Type.Number()),
      privateKeyPath: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String({ description: "含 prod 时按生产主机处理" }))),
      choice: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("rename"), Type.Literal("skip")])),
      acceptNewHostKey: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const accepted = await ctx.ui.confirm("保存主机", `${params.user}@${params.host}`);
      if (!accepted) return text("已跳过", { saved: false });
      const current = loadHosts();
      const choice = params.choice ?? (current.hosts[params.name] ? undefined : "rename");
      if (!choice) return text("同名主机已存在。choice 需要是 overwrite、rename 或 skip。", { saved: false });
      let secretRef: string | undefined;
      if (!params.privateKeyPath) {
        const password = await readSecret(ctx, "登录密码", "密码不进入对话记录");
        if (!password) return text("没有密码，未保存", { saved: false });
        secretRef = `pending:${password}`;
      }
      const saved = saveHostCandidate(current, { ...params, secretRef }, choice);
      if (!saved.saved) return text("同名主机已跳过", { saved: false });
      if (secretRef?.startsWith("pending:")) {
        putSecret(defaultSecretsPath(), saved.name, secretRef.slice("pending:".length));
        saved.file.hosts[saved.name].auth.secretRef = `file:${defaultSecretsPath()}#${saved.name}`;
      }
      saveHosts(defaultConfigPath(), saved.file);
      try {
        const tested = await runtime.testHost({ host: saved.name, acceptNewHostKey: params.acceptNewHostKey === true });
        return text(`已保存 ${saved.name}，${tested.auth} ${tested.fingerprint} ${tested.latencyMs}ms`, { saved: true, ...tested });
      } catch (error) {
        const next = loadHosts();
        delete next.hosts[saved.name];
        saveHosts(defaultConfigPath(), next);
        return failure(error);
      }
    },
  });

  pi.registerCommand("ssh", {
    description: "查看、测试或切换 SSH 主机",
    async handler(args, ctx) {
      const [sub, name] = args.trim().split(/\s+/, 2);
      const file = loadHosts();
      if (!sub || sub === "ls") {
        ctx.ui.notify(describeHosts(file), "info");
        return;
      }
      if (sub === "use") {
        if (!file.hosts[name]) {
          ctx.ui.notify(`没有名为 ${name} 的主机`, "error");
          return;
        }
        saveHosts(defaultConfigPath(), { ...file, activeHost: name });
        ctx.ui.notify(`活动主机已切换为 ${name}`, "info");
        return;
      }
      if (sub === "test") {
        try {
          const result = await runtime.testHost({ host: name });
          ctx.ui.notify(`${name || "活动主机"} ${result.auth} ${result.fingerprint} ${result.latencyMs}ms`, result.ok ? "info" : "error");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (sub === "rm") {
        if (!file.hosts[name]) {
          ctx.ui.notify(`没有名为 ${name} 的主机`, "error");
          return;
        }
        const accepted = await ctx.ui.confirm("删除主机", name);
        if (!accepted) return;
        const next = { ...file, hosts: { ...file.hosts } };
        delete next.hosts[name];
        if (next.activeHost === name) next.activeHost = undefined;
        saveHosts(defaultConfigPath(), next);
        ctx.ui.notify(`已删除 ${name}`, "info");
        return;
      }
      if (sub === "grant") {
        const minutes = Number(args.trim().split(/\s+/)[2] ?? 10);
        const accepted = await ctx.ui.confirm("写授权", `${name} 在 ${minutes} 分钟内不再逐条确认写操作`);
        if (!accepted) return;
        try {
          runtime.grantWrite(name, Number.isFinite(minutes) ? minutes : 10);
          ctx.ui.notify(`${name} 的写操作在 ${minutes} 分钟内不再逐条确认。破坏性操作仍要确认。`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (sub === "log") {
        const rows = readAudit(defaultAuditPath()).slice(-20);
        ctx.ui.notify(rows.map((row) => `${row.ts} ${row.tool} ${row.command}`).join("\n") || "没有审计", "info");
        return;
      }
      if (sub === "add" || sub === "edit") {
        const current = name ? file.hosts[name] : undefined;
        if (sub === "edit" && !current) {
          ctx.ui.notify(`没有名为 ${name} 的主机`, "error");
          return;
        }
        const hostName = sub === "add" ? await ctx.ui.input("主机名", "") : name;
        const address = await ctx.ui.input("地址", current?.host ?? "");
        const user = await ctx.ui.input("用户", current?.user ?? "");
        const keyPath = await ctx.ui.input("私钥路径，密码登录留空", current?.auth.privateKeyPath ?? "");
        const prod = await ctx.ui.confirm("生产主机", "这台机器的标签要包含 prod 吗？生产主机的写操作一律确认。");
        if (!hostName || !address || !user) return;
        let secretRef = current?.auth.secretRef;
        if (!keyPath) {
          const password = await readSecret(ctx, "登录密码", "密码不进入对话记录");
          if (!password && !secretRef) return;
          if (password) {
            putSecret(defaultSecretsPath(), hostName, password);
            secretRef = `file:${defaultSecretsPath()}#${hostName}`;
          }
        }
        const saved = saveHostCandidate(loadHosts(), {
          name: hostName,
          host: address,
          user,
          privateKeyPath: keyPath || undefined,
          secretRef,
          tags: prod ? ["prod"] : current?.tags?.filter((tag) => tag !== "prod"),
        }, sub === "edit" ? "overwrite" : "rename");
        if (saved.saved) saveHosts(defaultConfigPath(), saved.file);
        if (!saved.saved) {
          ctx.ui.notify("未保存", "warning");
          return;
        }
        try {
          const tested = await runtime.testHost({ host: saved.name, acceptNewHostKey: true });
          ctx.ui.notify(`已保存 ${saved.name}，${tested.fingerprint}`, "info");
        } catch (error) {
          const next = loadHosts();
          delete next.hosts[saved.name];
          saveHosts(defaultConfigPath(), next);
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (sub === "exec") {
        const command = args.trim().slice("exec".length).trim();
        if (!command) {
          ctx.ui.notify("用法：/ssh exec <命令>", "error");
          return;
        }
        try {
          const result = await runtime.exec({ command, allowActive: true, ui: ctx.ui });
          ctx.ui.notify(`退出码 ${result.exitCode}\n${result.text}`, result.exitCode === 0 ? "info" : "error");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      ctx.ui.notify("用法：/ssh ls | add | edit <主机> | test <主机> | use <主机> | rm <主机> | exec <命令> | grant <主机> <分钟> | log", "info");
    },
  });
}

export { classify, decide } from "./src/core/policy.js";
export type { Danger, Verdict, Policy, SessionGrant, Decision } from "./src/core/policy.js";
