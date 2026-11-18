// scan/ssh-config.ts —— 只解析 OpenSSH 的 Host 块。不猜项目文件。

export interface SshConfigHost {
  name: string;
  aliases: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  /** 这些指令 ssh2 做不到，auto 传输要改走系统 ssh。 */
  needsOpenSsh: boolean;
}

const OPENSSH_ONLY = new Set(["proxyjump", "proxycommand", "pkcs11provider", "securitykeyprovider"]);

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\/g, "\\");
  }
  return value;
}

function tokens(line: string): string[] {
  const values: string[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|\S+/g;
  for (const match of line.matchAll(pattern)) values.push(unquote(match[0]));
  return values;
}

function usable(pattern: string): boolean {
  return pattern !== "*" && !/[*?]/.test(pattern);
}

/** 一个 Host 块有多个具体别名时拆成多条。通配和否定匹配不产出候选。 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const words = tokens(line);
    const keyword = words[0]?.toLowerCase();
    if (!keyword) continue;

    if (keyword === "host") {
      const aliases = words.slice(1).filter(usable);
      current = undefined;
      if (aliases.length === 0) continue;
      current = { name: aliases[0], aliases, needsOpenSsh: false };
      hosts.push(current);
      continue;
    }
    if (!current) continue;

    const value = words.slice(1).join(" ");
    if (keyword === "hostname") current.hostName = value;
    else if (keyword === "user") current.user = value;
    else if (keyword === "port") current.port = Number(value);
    else if (keyword === "identityfile" && !current.identityFile) current.identityFile = value;
    else if (keyword === "proxyjump") current.proxyJump = value;
    if (OPENSSH_ONLY.has(keyword)) current.needsOpenSsh = true;
  }

  return hosts;
}
