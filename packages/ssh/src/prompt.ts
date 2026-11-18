// prompt.ts —— 注入系统提示的主机摘要。超过 20 台只保留活动主机。
import type { HostFile } from "./core/types.js";

export function describeHosts(file: HostFile): string {
  const hosts = Object.values(file.hosts);
  if (hosts.length === 0) return "[SSH 主机]\n还没有主机。用 /ssh add 添加。";
  const visible = hosts.length > 20 ? hosts.filter((item) => item.name === file.activeHost) : hosts;
  const lines = visible.map((item) => {
    const prod = item.tags?.includes("prod") ? " [prod]" : "";
    return `- ${item.name}${prod} ${item.user}@${item.host}`;
  });
  const extra = hosts.length > 20 ? `\n共 ${hosts.length} 台，其余用 ssh_hosts 的 list 查看。` : "";
  const rule = hosts.length >= 2 ? "已配置多台，调用必须传 host。" : "只有一台，host 可以省略。";
  return `[SSH 主机]\n${lines.join("\n")}${extra}\n${rule}`;
}
