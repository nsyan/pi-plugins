// core/policy.ts —— 命令危险度分级。纯函数，只看命令文本。
// decide 只用于 ssh_exec / ssh_sudo。上传覆盖和隧道确认不走这里。

export type Danger = "read" | "write" | "destructive";
export type Decision = "run" | "confirm" | "deny";
export type ConfirmLevel = "destructive" | "write" | "always";

export interface Verdict {
  danger: Danger;
  /** 给人看的「这条命令会做什么」 */
  summary: string;
}

export interface Policy {
  readonly: boolean;
  confirm: ConfirmLevel;
}

export interface PolicyHost {
  id: string;
  tags?: string[];
}

/** 非生产主机的会话级 write 授权。生产主机不得授予，调用方也不应传入。 */
export interface SessionGrant {
  hostId: string;
  untilMs: number;
}

interface Rule {
  danger: Exclude<Danger, "read">;
  summary: string;
  test: (command: string) => boolean;
}

const DESTRUCTIVE: Rule[] = [
  { danger: "destructive", summary: "fork 炸弹", test: (c) => /:\(\)\{/.test(c.replace(/\s/g, "")) },
  {
    danger: "destructive",
    summary: "把解码后的内容交给 shell 执行",
    test: (c) => /\bbase64\b[\s\S]*(?:-d\b|--decode\b)[\s\S]*\|\s*(?:sh|bash|zsh|dash)\b/.test(c),
  },
  {
    danger: "destructive",
    summary: "清理 Docker 资源",
    test: (c) => /\bdocker\s+(?:system|image|container|volume|builder)\s+prune\b/.test(c),
  },
  {
    danger: "destructive",
    summary: "删除容器或镜像",
    test: (c) => /\bdocker\s+(?:rm|rmi)\b/.test(c),
  },
  {
    danger: "destructive",
    summary: "删除文件或目录",
    test: (c) => /\brm\b/.test(c) && !/^\s*rm\s+--(?:help|version)\s*$/.test(c),
  },
  {
    danger: "destructive",
    summary: "find 删除匹配文件",
    test: (c) => /\bfind\b/.test(c) && (/\s-delete\b/.test(c) || /\s-exec\s+rm\b/.test(c)),
  },
  {
    danger: "destructive",
    summary: "停止、禁用或屏蔽服务",
    test: (c) => /\bsystemctl\s+(?:stop|disable|mask)\b/.test(c),
  },
  { danger: "destructive", summary: "格式化磁盘", test: (c) => /\bmkfs(?:\.\w+)?\b/.test(c) },
  { danger: "destructive", summary: "dd 写入设备或文件", test: (c) => /\bdd\b[\s\S]*\bof=/.test(c) },
  {
    danger: "destructive",
    summary: "覆盖 /etc 或 /boot 下的文件",
    test: (c) => fileRedirectTarget(c, "/etc", "/boot") !== null,
  },
  { danger: "destructive", summary: "丢弃未提交的本地修改", test: (c) => /\bgit\s+reset\b[\s\S]*--hard\b/.test(c) },
  {
    danger: "destructive",
    summary: "删除未跟踪文件",
    test: (c) => /\bgit\s+clean\b/.test(c) && /\s-[A-Za-z]*[fd]/.test(c),
  },
  {
    danger: "destructive",
    summary: "强制杀死进程",
    test: (c) => /\bkill\b[\s\S]*\s-(?:9|KILL|SIGKILL)\b/.test(c),
  },
  {
    danger: "destructive",
    summary: "关闭或重启机器",
    test: (c) => /(?:^|[\s;&|`(])(?:reboot|shutdown|halt|poweroff)\b/.test(c),
  },
  { danger: "destructive", summary: "删除用户或用户组", test: (c) => /\b(?:userdel|groupdel)\b/.test(c) },
  {
    danger: "destructive",
    summary: "清空防火墙规则",
    test: (c) => /\b(?:iptables|ip6tables)\b/.test(c) && /(?:\s-F\b|--flush\b)/.test(c),
  },
  {
    danger: "destructive",
    summary: "递归放开全部权限",
    test: (c) => /\bchmod\b/.test(c) && /\s-R\b/.test(c) && /\b0*777\b/.test(c),
  },
];

const WRITE: Rule[] = [
  { danger: "write", summary: "原地修改文件", test: (c) => /\bsed\b/.test(c) && /(?:\s-i\b|--in-place\b)/.test(c) },
  {
    danger: "write",
    summary: "重启或设置服务开机启动",
    test: (c) => /\bsystemctl\s+(?:restart|reload|enable)\b/.test(c),
  },
  {
    danger: "write",
    summary: "变更 compose 项目",
    test: (c) => /\bdocker(?:\s+|-)compose\b[\s\S]*\b(?:up|down)\b/.test(c),
  },
  {
    danger: "write",
    summary: "启动、停止或重启容器",
    test: (c) => /\bdocker\s+(?:run|stop|restart)\b/.test(c),
  },
  {
    danger: "write",
    summary: "安装或卸载软件包",
    test: (c) =>
      /\b(?:apt-get|apt|yum|dnf|apk|pacman|zypper|brew|npm|pnpm|yarn|pip3|pip)\b/.test(c) &&
      /\b(?:install|remove|uninstall|purge|erase|add|del)\b/.test(c),
  },
  {
    danger: "write",
    summary: "移动、复制或修改文件",
    test: (c) => /\b(?:mv|cp|install|chmod|chown|tee|truncate)\b/.test(c),
  },
  { danger: "write", summary: "把输出写入文件", test: (c) => fileRedirectTarget(c) !== null },
  { danger: "write", summary: "执行动态拼接的命令，无法静态确认", test: (c) => /\beval\b/.test(c) },
];

/** 文件重定向的目标。`2>&1` 和 `>/dev/null` 不算写文件。指定 prefixes 时只返回命中的目标。 */
function fileRedirectTarget(command: string, ...prefixes: string[]): string | null {
  // 前一个字符是 `-` 或 `=` 时是 `->` / `=>`，不是重定向。`>=` 由 `(?!=)` 排掉。
  const re = /(^|[^>])>{1,2}(?!=)\s*([^\s;&|]+)/g;
  for (const match of command.matchAll(re)) {
    const prev = match[1];
    const target = match[2];
    if (prev === "-" || prev === "=") continue;
    if (target.startsWith("&") || target === "/dev/null") continue;
    if (prefixes.length === 0 || prefixes.some((p) => target === p || target.startsWith(p + "/"))) return target;
  }
  return null;
}

export function classify(command: string): Verdict {
  const commandText = command.trim();
  for (const rule of [...DESTRUCTIVE, ...WRITE]) {
    if (rule.test(commandText)) return { danger: rule.danger, summary: rule.summary };
  }
  return { danger: "read", summary: "只读命令" };
}

export function isProdHost(host: PolicyHost): boolean {
  return host.tags?.includes("prod") === true;
}

function grantCovers(grant: SessionGrant | null | undefined, host: PolicyHost, nowMs: number): boolean {
  return !!grant && grant.hostId === host.id && grant.untilMs > nowMs && !isProdHost(host);
}

export function decide(
  verdict: Verdict,
  policy: Policy,
  host: PolicyHost,
  grant?: SessionGrant | null,
  nowMs: number = Date.now(),
): Decision {
  if (verdict.danger === "read") return policy.confirm === "always" ? "confirm" : "run";
  if (policy.readonly) return "deny";
  if (verdict.danger === "destructive") return "confirm";
  if (isProdHost(host)) return "confirm";
  if (grantCovers(grant, host, nowMs)) return "run";
  if (policy.confirm === "destructive") return "run";
  return "confirm";
}
