// core/whitelist.ts —— 命令白名单匹配工具（KV/搜索共用）
export function matchCommand(cmd: string, list: string[]): boolean {
  return list.includes(cmd.trim().toUpperCase());
}
