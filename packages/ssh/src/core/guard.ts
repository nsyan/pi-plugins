// core/guard.ts —— 看门狗脚本。通道 stdin 挂在 fd 3，命令自己的 stdin 是 /dev/null。

const SHELL_SINGLE_QUOTE = /'/g;

export function shellQuote(value: string): string {
  return `'${value.replace(SHELL_SINGLE_QUOTE, `'"'"'`)}'`;
}

/**
 * 把命令放进自己的进程组，返回脚本行。
 *
 * 不能靠 `set -m` 的退出码判断：dash 下 `set -m` 在没有 tty 时返回 0，
 * 但 job control 并没开启（`$-` 里没有 `m`），进程组也建不起来，
 * 于是 `kill -TERM -$pid` 变成 `kill: No such process`，超时清理形同虚设。
 * 必须看 `$-` 里到底有没有 `m`。
 *
 * - 有 job control（bash）：`( cmd ) &` 天然建新进程组，`kill -$pgid` 有效。
 * - 没有 job control（dash/sh）：用 `setsid` 单独开会话并成为组长，`kill -$pgid` 同样有效。
 *   没有 setsid 时退回「超时只关通道」，并把降级事实写到 stderr。
 */
function spawnInOwnGroup(command: string): string[] {
  return [
    "case \"$-\" in",
    "  *m*)",
    `    ( ${command} ) &`,
    "    pid=$!",
    "    ;;",
    "  *)",
    "    if command -v setsid >/dev/null 2>&1; then",
    `      setsid sh -c ${shellQuote(command)} &`,
    "      pid=$!",
    "    else",
    "      echo 'pi-ssh: 远端 shell 没有 job control 也没有 setsid，超时只能关掉通道，进程组不会被杀' >&2",
    `      ( ${command} ) &`,
    "      pid=$!",
    "      PI_SSH_NO_GROUP=1",
    "    fi",
    "    ;;",
    "esac",
  ];
}

/**
 * 包一层进程组看门狗。
 * 先把通道复制到 fd 3，再把 fd 0 指到 /dev/null，然后才把命令放进后台。
 * 命令继承 /dev/null，watcher 独占 fd 3。通道关闭就是 fd 3 的 EOF。
 */
function jobControl(command: string, afterPid: string[]): string[] {
  return [
    "exec 3<&0",
    "exec 0</dev/null",
    ...spawnInOwnGroup(command),
    ...afterPid,
  ];
}

function watcher(): string[] {
  return [
    "(",
    "  while read -r _ <&3; do :; done",
    "  [ -n \"$PI_SSH_NO_GROUP\" ] && exit 0",
    "  kill -TERM -$pid 2>/dev/null",
    "  sleep 2",
    "  kill -KILL -$pid 2>/dev/null",
    ") >/dev/null 2>&1 &",
    "watcher=$!",
    "wait $pid",
    "status=$?",
    "kill $watcher 2>/dev/null",
    "wait $watcher 2>/dev/null",
  ];
}

/**
 * sudo 先从通道读走一行密码。
 * 密码只通过不带引号的 heredoc 进 sudo 的 stdin，不进 printf 的参数，远端 ps 看不到。
 * heredoc 必须挂在最外层那个调用（子 shell 或 setsid）上：
 * 放进 `sh -c '...'` 的引号里，`$PI_SSH_PW` 就到不了内层 shell（没 export）。
 */
export function wrapSudo(command: string): string {
  const inner = `sudo -S -p '' -- ${command}`;
  const feed = ["$PI_SSH_PW", "PI_SSH_PW_END"];
  return [
    "IFS= read -r PI_SSH_PW || exit 1",
    "exec 3<&0",
    "exec 0</dev/null",
    "case \"$-\" in",
    "  *m*)",
    `    ( ${inner} ) <<PI_SSH_PW_END &`,
    ...feed,
    "    pid=$!",
    "    ;;",
    "  *)",
    "    if command -v setsid >/dev/null 2>&1; then",
    `      setsid sh -c ${shellQuote(inner)} <<PI_SSH_PW_END &`,
    ...feed,
    "      pid=$!",
    "    else",
    "      echo 'pi-ssh: 远端 shell 没有 job control 也没有 setsid，超时只能关掉通道，进程组不会被杀' >&2",
    `      ( ${inner} ) <<PI_SSH_PW_END &`,
    ...feed,
    "      pid=$!",
    "      PI_SSH_NO_GROUP=1",
    "    fi",
    "    ;;",
    "esac",
    ...watcher(),
    "unset PI_SSH_PW",
    "exit $status",
  ].join("\n");
}

export function wrapWithWatchdog(command: string): string {
  return [...jobControl(command, watcher()), "exit $status"].join("\n");
}

/** 在 deploy.root 内才允许。归一化后拒绝 `..` 逃逸和根目录本身以外的前缀巧合。 */
export function withinRoot(root: string, target: string): boolean {
  const base = normalizePosix(root);
  const path = normalizePosix(target);
  if (base === "/" || path === base) return false;
  return path.startsWith(`${base}/`);
}

export function normalizePosix(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}
