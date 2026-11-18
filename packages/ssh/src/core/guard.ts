// core/guard.ts —— 看门狗脚本。通道 stdin 挂在 fd 3，命令自己的 stdin 是 /dev/null。

const SHELL_SINGLE_QUOTE = /'/g;

export function shellQuote(value: string): string {
  return `'${value.replace(SHELL_SINGLE_QUOTE, `'"'"'`)}'`;
}

/**
 * 包一层进程组看门狗。
 * 先把通道复制到 fd 3，再把 fd 0 指到 /dev/null，然后才把命令放进后台。
 * 命令继承 /dev/null，watcher 独占 fd 3。通道关闭就是 fd 3 的 EOF。
 */
function jobControl(command: string, afterPid: string[]): string[] {
  return [
    "if ! set -m 2>/dev/null; then",
    "  echo 'pi-ssh: 远端 shell 不支持 set -m，超时只会关掉通道' >&2",
    "  exec 3<&0",
    "  exec 0</dev/null",
    `  ${command}`,
    "  exit $?",
    "fi",
    "exec 3<&0",
    "exec 0</dev/null",
    `( ${command} ) &`,
    "pid=$!",
    "set +m",
    ...afterPid,
  ];
}

function watcher(): string[] {
  return [
    "(",
    "  while read -r _ <&3; do :; done",
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
 */
export function wrapSudo(command: string): string {
  const feed = [
    `sudo -S -p '' -- ${command} <<PI_SSH_PW_END`,
    "$PI_SSH_PW",
    "PI_SSH_PW_END",
  ];
  return [
    "IFS= read -r PI_SSH_PW || exit 1",
    "if ! set -m 2>/dev/null; then",
    "  echo 'pi-ssh: 远端 shell 不支持 set -m，超时只会关掉通道' >&2",
    "  exec 3<&0",
    "  exec 0</dev/null",
    ...feed,
    "  exit $?",
    "fi",
    "exec 3<&0",
    "exec 0</dev/null",
    "(",
    ...feed,
    ") &",
    "pid=$!",
    "set +m",
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
