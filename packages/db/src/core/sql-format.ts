// core/sql-format.ts —— 确认框「展示用」SQL 美化 + 高亮语言映射。
//
// 设计红线：本模块只决定「弹窗里看到什么」，绝不参与执行。
// 实际执行永远走原始 params.sql（见 index.ts query_database），
// 因此这里即使美化得再激进也不会改变语义；反过来也要求尽量保留
// 字符串字面量、注释与标识符原貌，避免「看到的 SQL ≠ 执行的 SQL」。
import type { DbTypeId } from "./types.js";

/** 弹窗代码块高亮语言；undefined = 无对应语法，走 pi 的代码块配色 */
export type DisplayLang = "sql" | "json" | undefined;

/** 方言 → 高亮语言：关系型/大数据/图用 sql，文档/搜索用 json，Redis 命令无同类语法 */
export function displayLangFor(type: DbTypeId): DisplayLang {
  switch (type) {
    case "postgresql":
    case "mysql":
    case "oracle":
    case "dm":
    case "hive":
    case "spark":
    case "neo4j":
      return "sql";
    case "elasticsearch":
    case "mongodb":
      return "json";
    case "redis":
      return undefined;
  }
}

interface Tok {
  k: "w" | "s" | "n" | "p" | "c"; // word / string / number / punctuation / comment
  t: string;
  sp: boolean; // 原串中该 token 前是否有空白（用于保留 `COUNT(*)` 与 `IN (` 的差异）
}

const MULTI_OP = ["->>", "->", "::", "<=", ">=", "<>", "!=", "||", ":=", "|>"];
const JOIN_PREFIX = new Set(["LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "NATURAL"]);

// 触发换行的「子句关键字」（含多词形式，合并后匹配）
const CLAUSE = new Set([
  "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET",
  "FETCH", "RETURNING", "WINDOW", "QUALIFY",
  "INSERT INTO", "VALUES", "SET", "UPDATE", "DELETE FROM", "WITH",
  "UNION", "UNION ALL", "EXCEPT", "INTERSECT",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN", "FULL JOIN",
  "CROSS JOIN", "NATURAL JOIN", "MERGE", "MATCH", "UNWIND", "RETURN", "REMOVE",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "CALL", "EXPLAIN",
]);
// 这些子句里的逗号按列/赋值拆行（更接近主流 SQL 格式化器）
const COMMA_CLAUSES = new Set(["SELECT", "SET", "VALUES", "RETURNING", "GROUP BY", "ORDER BY"]);
const COND = new Set(["AND", "OR", "ON", "WHEN"]);
// 不换行但统一大写的常见保留字/属性词（保持与子句关键字一致的观感）
const KEYWORD = new Set([
  "AS", "ASC", "DESC", "DISTINCT", "ALL", "IN", "NOT", "NULL", "IS", "LIKE", "ILIKE",
  "BETWEEN", "EXISTS", "CASE", "THEN", "ELSE", "END", "TRUE", "FALSE", "DEFAULT", "USING",
  "RECURSIVE", "OVER", "PARTITION", "UNBOUNDED", "PRECEDING", "FOLLOWING", "CURRENT", "ROW",
  "ROWS", "RANGE", "CAST", "INTERVAL", "PRIMARY", "FOREIGN", "KEY", "REFERENCES", "UNIQUE",
  "INDEX", "CONSTRAINT", "CHECK", "CASCADE", "RESTRICT", "IF", "REPLACE", "IGNORE",
  "DUPLICATE", "INTO", "TOP", "NULLS", "FIRST", "LAST", "OPTION", "LOCK", "FOR",
]);

const INDENT = "  ";
// 括号组内容超过这个「显示宽度」就当成块状列表拆行：
// 覆盖 CREATE TABLE(...) 长列定义、IN(...) 长列表等子句关键字覆盖不到的列表。
// 约等于 pi web 弹窗代码区（~560px / 等宽 ~7.5px）的可见列数。
const BLOCK_WIDTH = 64;
const WIDE = /[\u1100-\u115f\u2329\u232a\u2e80-\u4dcf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u20000-\u3fffd]/u;

/** 终端显示宽度：CJK/全角按 2 列（与 pi-tui/可见宽度一致，避免中文注释撑爆行宽判断） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  const n = sql.length;
  let i = 0;
  let sp = false;
  const rest = (from: number) => sql.slice(from);

  while (i < n) {
    const ch = sql[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { sp = true; i++; continue; }

    // 行注释 -- ...
    if (ch === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      toks.push({ k: "c", t: sql.slice(i, j).trimEnd(), sp });
      i = j; sp = true; continue;
    }
    // 块注释 /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      toks.push({ k: "c", t: sql.slice(i, j), sp });
      i = j; sp = true; continue;
    }
    // 字符串 / 引号标识符（'' 与反斜杠转义都按原样保留）
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      toks.push({ k: "s", t: sql.slice(i, j), sp });
      i = j; sp = false; continue;
    }
    // 数字
    const num = /^(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(rest(i));
    if (num) { toks.push({ k: "n", t: num[0], sp }); i += num[0].length; sp = false; continue; }
    // 单词 / 标识符（保留原始大小写，仅子句关键字后续统一大写）
    const word = /^[A-Za-z_@#$][A-Za-z0-9_@#$]*/.exec(rest(i));
    if (word) { toks.push({ k: "w", t: word[0], sp }); i += word[0].length; sp = false; continue; }
    // 多字符运算符
    const op = MULTI_OP.find((o) => rest(i).startsWith(o));
    if (op) { toks.push({ k: "p", t: op, sp }); i += op.length; sp = false; continue; }
    // 单字符标点
    toks.push({ k: "p", t: ch, sp });
    i++; sp = false;
  }
  return toks;
}

/** 宽松的 SQL 美化：按子句换行、逗号拆列、AND/OR 缩进、长括号组拆块；不改变 token 内容 */
export function formatSql(sql: string): string {
  const toks = tokenize(sql);
  if (toks.length === 0) return sql.trim();

  // 预计算括号配对，用于判断某个 (...) 是否足够长、该拆成块状列表
  const matchIdx = new Map<number, number>();
  {
    const stack: number[] = [];
    for (let idx = 0; idx < toks.length; idx++) {
      const t = toks[idx];
      if (t.k !== "p") continue;
      if (t.t === "(") stack.push(idx);
      else if (t.t === ")") {
        const open = stack.pop();
        if (open !== undefined) matchIdx.set(open, idx);
      }
    }
  }
  const innerWidth = (open: number): number => {
    const close = matchIdx.get(open);
    if (close === undefined) return 0;
    let w = 0;
    for (let k = open + 1; k < close; k++) w += displayWidth(toks[k].t) + 1;
    return w;
  };

  let out = "";
  let pending = false; // 下一个 token 前补一个空格
  let depth = 0;       // 括号深度
  let breakCommas = false;
  let prevWord = ""; // 上一个单词（大写），用于识别 `FOR UPDATE` / `ON DUPLICATE KEY UPDATE` 等非语句头场景
  // 每层括号：block = 长列表按块拆行；clause = 内含子句（子查询），收尾 ) 单独成行
  const parenStack: { block: boolean; clause: boolean }[] = [];

  const atLineStart = () => out === "" || out.endsWith("\n");
  const newline = (indent: number) => {
    out = out.replace(/[ \t]+$/, "");
    if (!out.endsWith("\n")) out += "\n";
    out += INDENT.repeat(Math.max(0, indent));
    pending = false;
  };
  const write = (s: string, noSpace = false) => {
    if (!atLineStart() && pending && !noSpace) out += " ";
    out += s;
    pending = false;
  };

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];

    if (tok.k === "c") {
      write(tok.t);
      if (tok.t.startsWith("--")) newline(depth); else pending = true;
      prevWord = "";
      continue;
    }

    if (tok.k === "s" || tok.k === "n") { write(tok.t); pending = true; prevWord = ""; continue; }

    if (tok.k === "p") {
      prevWord = "";
      const t = tok.t;
      if (t === ",") {
        write(",", true);
        const inBlock = parenStack.length > 0 && parenStack[parenStack.length - 1].block;
        if (breakCommas && depth === 0) newline(1);
        else if (inBlock) newline(depth);
        else pending = true;
      } else if (t === "(") {
        const block = innerWidth(i) > BLOCK_WIDTH;
        parenStack.push({ block, clause: false });
        write("(", !tok.sp);
        depth++;
        if (block) newline(depth); // 长列表：首项另起一行
      } else if (t === ")") {
        const top = parenStack.pop();
        if (top?.clause === true || top?.block === true) newline(depth - 1); // 子查询/块列表收尾对齐
        write(")", true);
        depth = Math.max(0, depth - 1);
        pending = true;
      } else if (t === ".") {
        write(".", true);
      } else if (t === ";") {
        write(";", true);
        out = out.replace(/[ \t]+$/, "") + "\n\n";
        pending = false;
        breakCommas = false;
      } else if (t === "*" && (out.endsWith("(") || out.endsWith(",") || atLineStart())) {
        write("*", true); // COUNT(*) / SELECT * 的星号
        pending = true;
      } else {
        write(t); // 二元运算符两侧留空格
        pending = true;
      }
      continue;
    }

    // word：先尝试合并多词子句
    const upper = tok.t.toUpperCase();
    const nextW = toks[i + 1]?.k === "w" ? toks[i + 1].t.toUpperCase() : "";
    let kw = upper;
    if ((upper === "GROUP" || upper === "ORDER" || upper === "PARTITION") && nextW === "BY") { kw = upper + " BY"; i++; }
    else if (upper === "UNION" && nextW === "ALL") { kw = "UNION ALL"; i++; }
    else if (upper === "INSERT" && nextW === "INTO") { kw = "INSERT INTO"; i++; }
    else if (upper === "DELETE" && nextW === "FROM") { kw = "DELETE FROM"; i++; }
    else if (JOIN_PREFIX.has(upper) && nextW === "JOIN") { kw = upper + " JOIN"; i++; }

    // 这些 UPDATE/VALUES 不是语句头/子句头，不能换行——否则确认框会
    // 把一条 INSERT 的尾部渲染成看似两条语句，误导安全判断。
    const nextTok = toks[i + 1];
    const nextIsFnParen = nextTok?.k === "p" && nextTok.t === "(" && nextTok.sp === false;
    const inlineUpdate = kw === "UPDATE" && (prevWord === "FOR" || prevWord === "DO" || prevWord === "KEY" || prevWord === "DUPLICATE");
    const inlineValuesFn = kw === "VALUES" && nextIsFnParen; // MySQL VALUES(col) 函数

    if (CLAUSE.has(kw) && !inlineUpdate && !inlineValuesFn) {
      if (parenStack.length > 0) parenStack[parenStack.length - 1].clause = true;
      newline(depth);
      breakCommas = COMMA_CLAUSES.has(kw);
      write(kw);
      pending = true;
    } else if (COND.has(kw)) {
      newline(depth + 1);
      write(kw);
      pending = true;
    } else if (KEYWORD.has(upper) || inlineUpdate || inlineValuesFn) {
      write(upper);
      pending = true;
    } else {
      write(tok.t); // 非关键字保留原始大小写
      pending = true;
    }
    prevWord = kw.slice(kw.lastIndexOf(" ") + 1);
  }

  return out
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 展示用 SQL：关系型/大数据/图走 SQL 美化；MongoDB / Elasticsearch 的 JSON 信封走 2 空格缩进。
 * 解析/美化失败时原样返回（弹窗宁可不好看，也不能显示错）。
 */
export function formatSqlForDisplay(sql: string, type: DbTypeId): string {
  const raw = sql.trim();
  if (!raw) return raw;
  if (type === "mongodb" || type === "elasticsearch") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  try {
    const formatted = formatSql(raw).trim();
    return formatted || raw;
  } catch {
    return raw;
  }
}
