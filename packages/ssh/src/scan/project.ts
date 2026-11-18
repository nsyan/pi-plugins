// scan/project.ts —— 只返回可能含部署目标的路径，不解析内容。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NAMES = new Set([".env", ".env.local", ".env.production", "Jenkinsfile", "ecosystem.config.js", "inventory", "hosts"]);

export function projectDeployFiles(root: string, depth = 3): string[] {
  const found: string[] = [];
  function walk(dir: string, level: number) {
    if (level > depth || found.length >= 50) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (name === "deploy") found.push(path);
        walk(path, level + 1);
      } else if (NAMES.has(name) || name.startsWith(".env")) {
        found.push(path);
      }
    }
  }
  walk(root, 0);
  return found;
}
