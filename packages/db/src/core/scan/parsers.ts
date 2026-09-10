// scan/parsers.ts —— 按文件类型解析：.env / .properties / yml+yaml（Spring 结构优先）/ docker-compose.yml / 通用 URL 正则

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    const m = /^([^=:!]+)[=:](.*)$/.exec(t);
    if (!m) continue;
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/**
 * 极简 YAML 子集解析：嵌套 map + 标量（够 Spring 配置用）。
 * 不支持多行标量/锚点/复杂流式结构——遇到即跳过该行。
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  interface YamlLine { indent: number; key: string; value: string | null; }
  const lines: YamlLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (raw.trim().startsWith("- ")) continue; // 列表项：Spring 配置子树用不到，交给 compose 解析器
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();
    const colon = content.indexOf(":");
    if (colon < 0) continue; // 多行标量等不支持，跳过
    const key = content.slice(0, colon).trim().replace(/^["']|["']$/g, "");
    let value: string | null = content.slice(colon + 1).trim();
    if (value === "" || value === "|" || value === ">") value = null;
    else value = value.replace(/^["']|["']$/g, "");
    lines.push({ indent, key, value });
  }
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];
  for (const ln of lines) {
    while (stack.length > 1 && ln.indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (ln.value !== null) {
      parent[ln.key] = ln.value;
    } else {
      const child: Record<string, unknown> = {};
      parent[ln.key] = child;
      stack.push({ indent: ln.indent, obj: child });
    }
  }
  return root;
}

// ── docker-compose.yml ────────────────────────────

export interface ComposeService {
  name: string;
  image?: string;
  env: Record<string, string>;
  ports: string[];
}

export function parseCompose(text: string): ComposeService[] {
  const services: ComposeService[] = [];
  let cur: ComposeService | null = null;
  let block: { kind: "environment" | "ports"; indent: number } | null = null;
  let servicesIndent = -1;

  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (t.startsWith("- ")) {
      if (!cur || !block || indent <= block.indent) continue;
      const item = t.slice(2).trim().replace(/^["']|["']$/g, "");
      if (block.kind === "ports") {
        cur.ports.push(item);
      } else {
        const eq = item.indexOf("=");
        if (eq > 0) cur.env[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
      }
      continue;
    }

    if (block && indent <= block.indent) block = null;

    const colon = t.indexOf(":");
    if (colon < 0) continue;
    const key = t.slice(0, colon).trim().replace(/^["']|["']$/g, "");
    const value = t.slice(colon + 1).trim();

    if (key === "services" && value === "") {
      servicesIndent = indent;
      cur = null;
      block = null;
      continue;
    }
    // service 名行：services 的直接子级（缩进 = servicesIndent + 2）且无内联值
    if (servicesIndent >= 0 && indent === servicesIndent + 2 && value === "") {
      cur = { name: key, image: undefined, env: {}, ports: [] };
      services.push(cur);
      block = null;
      continue;
    }
    if (cur) {
      if (key === "image" && value) {
        cur.image = value.replace(/^["']|["']$/g, "");
      } else if (key === "environment") {
        if (value === "") block = { kind: "environment", indent };
        else {
          const eq = value.indexOf("=");
          if (eq > 0) cur.env[value.slice(0, eq).trim()] = value.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        }
      } else if (key === "ports") {
        block = value === "" ? { kind: "ports", indent } : null;
      } else if (block?.kind === "environment" && indent > block.indent && value !== "") {
        cur.env[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  }
  return services;
}

// ── 通用 URL 正则（全文件扫描兜底）──────────────────

const URL_RE = /(?:jdbc:(?:postgresql|mysql|oracle|dm|hive2)|rediss?|mongodb\+srv|mongodb|postgresql|mysql):\/\/[^\s"'<>`]+|https?:\/\/[^\s"'<>`]*:9200[^\s"'<>`]*/g;

export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    out.add(m[0].replace(/[),.;\]]+$/, ""));
  }
  return [...out];
}
