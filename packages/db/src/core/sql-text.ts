// src/core/sql-text.ts
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let q: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (q) {
      out += ch;
      if (ch === q) {
        if (sql[i + 1] === q) { out += sql[i + 1]; i += 2; continue; } // '' 转义
        q = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; out += ch; i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

export function splitStatements(sql: string): string[] {
  // 注：先 stripComments 再切分——注释文本不进入语句，注释内分号自然消失；
  // 这里只处理字符串字面量（含 '' 双写转义）内的分号
  const clean = stripComments(sql);
  const stmts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const nx = clean[i + 1];
    if (q) {
      cur += ch;
      if (ch === q) {
        if (nx === q) { cur += nx; i++; continue; }
        q = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; cur += ch; continue; }
    if (ch === ";") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|LOAD|MERGE|EXEC|EXECUTE|CALL|MSCK|CACHE|REFRESH)\b/i;
const WITH_DML_RE = /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE|MERGE)\b/i;
const FOR_UPDATE_RE = /\bFOR\s+UPDATE\b/i;
const DROP_TABLE_RE = /^\s*DROP\s+(TABLE|DATABASE)\b/i;

export function isWriteStatement(stmt: string): boolean {
  const clean = stripComments(stmt);
  return WRITE_RE.test(clean) || WITH_DML_RE.test(clean) || FOR_UPDATE_RE.test(clean);
}

export function isDropStatement(stmt: string): boolean {
  return DROP_TABLE_RE.test(stripComments(stmt));
}
