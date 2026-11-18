// src/core/sql-text.ts —— SQL 语句切分与读写判定（关系型 / 大数据家族共用）
//
// 判定姿态（v1.3.8 收紧）：**读白名单**，不是写黑名单。
//   旧实现只认 INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/REPLACE/LOAD/MERGE/
//   EXEC/CALL/MSCK/CACHE/REFRESH 十几个词，实测漏掉一整个批次：
//     COPY ... FROM / COPY ... TO PROGRAM、GRANT、REVOKE、SET（含解除只读）、
//     VACUUM、ANALYZE、DO $$ ... $$、SELECT ... INTO OUTFILE、EXPLAIN ANALYZE DELETE、
//     ATTACH DATABASE、COMMENT ON、以及 nextval()/pg_read_file()/lo_import() 这类
//     带服务端副作用的函数。
//   这些语句在 ai_readonly=true 时会被**直接执行**，在 confirm_before_exec=write 时
//   **连确认框都不弹**。文档家族（Mongo「未知命令保守按写」）与图家族（Neo4j
//   「未知语句，按写」）早就是白名单姿态，只有关系型还在用黑名单——现在三家族一致。

/** `$$` 或 `$tag$` 起始标记（PG dollar-quoted 块）；不是则 null */
function dollarTagAt(text: string, i: number): string | null {
  if (text[i] !== "$") return null;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
  return m ? m[0] : null;
}

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
    // dollar-quoted 块整体保留（函数体里的 ; 与 -- 都不是语句边界/注释）
    if (ch === "$") {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) { out += sql.slice(i); break; }
        out += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
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
  // 这里只处理字符串字面量与 dollar-quoted 块内的分号
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
    if (ch === "$") {
      const tag = dollarTagAt(clean, i);
      if (tag) {
        const end = clean.indexOf(tag, i + tag.length);
        if (end < 0) { cur += clean.slice(i); i = clean.length; continue; }
        cur += clean.slice(i, end + tag.length);
        i = end + tag.length - 1;
        continue;
      }
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

/**
 * 剥离字符串字面量与反引号标识符内容，保留长度（用空格填充）。
 * 用途：判读/写副作用时只看代码本身，不让 `SELECT 'FOR UPDATE' AS note`、
 * `WHERE note = 'x INTO y'` 这类字面量内容把读语句误判成写。
 * 注：**不能**用返回值做执行，仅用于判定（原语句照原样下发）。
 * 引用符转义：'' 双写（SQL 标准）、\' 反斜杠（MySQL 默认）。
 */
export function blankLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      out += q;
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\" && i + 1 < text.length) { out += "  "; i += 2; continue; } // \' 转义
        if (c === q) {
          if (text[i + 1] === q) { out += "  "; i += 2; continue; } // '' 双写
          out += q;
          i++;
          break;
        }
        out += " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 读语句首关键字白名单。不在表内的一律按写（保守方向）。 */
const READ_STARTERS: ReadonlySet<string> = new Set([
  "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "HELP",
]);

/** 写关键字（仅用于生成可读的判定依据，不参与"是否写"的决定） */
const WRITE_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT", "REINDEX", "CLUSTER",
  "GRANT", "REVOKE", "SET", "RESET", "USE", "ATTACH", "DETACH", "LOAD", "IMPORT",
  "EXPORT", "COPY", "DO", "CALL", "EXEC", "EXECUTE", "VACUUM", "ANALYZE", "OPTIMIZE",
  "MSCK", "CACHE", "UNCACHE", "REFRESH", "BEGIN", "START", "COMMIT", "ROLLBACK",
  "SAVEPOINT", "RELEASE", "PREPARE", "DEALLOCATE",
]);

/** CTE 里夹带 DML（WITH ... DELETE/UPDATE/INSERT/MERGE） */
const WITH_DML_RE = /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE|MERGE)\b/i;

/** SELECT 自带的写副作用：方言差异全部在这里收口 */
const SELECT_SIDE_EFFECTS: readonly RegExp[] = [
  /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,                       // MySQL 落盘
  /\bINTO\s+(?!OUTFILE\b|DUMPFILE\b|@)[A-Za-z_"`[]/i,       // PG SELECT ... INTO <表>
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i,                      // 行锁（写事务意图）
  /\bFOR\s+SHARE\b/i,
  /\bLOCK\s+IN\s+SHARE\s+MODE\b/i,
  // 带服务端副作用的函数：读语句外壳下的写/文件读取
  /\b(?:nextval|setval|lo_import|lo_export|lo_unlink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_write_file|pg_logical_emit_message|dblink_exec|dblink_connect)\s*\(/i,
];

/** EXPLAIN ANALYZE 会真的执行被分析的语句 */
const EXPLAIN_ANALYZE_DML_RE = /\bANALYZE\b[\s\S]*\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|COPY|CALL|EXECUTE)\b/i;

/** DDL 硬限制：删掉数据载体（表/库/schema）恒拒，与只读开关无关 */
const DROP_TABLE_RE = /^\s*DROP\s+(TABLE|DATABASE|SCHEMA)\b/i;

function firstKeyword(clean: string): string {
  return /^\s*([A-Za-z_]+)/.exec(clean)?.[1]?.toUpperCase() ?? "";
}

/**
 * 单条语句是否为写（或无法证明是读）。
 * 姿态：白名单之外一律 true——宁可多弹一次确认框，也不让写语句静默通过。
 */
export function isWriteStatement(stmt: string): boolean {
  const clean = stripComments(stmt);
  if (!clean.trim()) return false;
  // CTE-DML 优先：`WITH x AS (...) DELETE FROM t` 首关键字是 WITH，但它是写
  // 注：字面量剥离只用于这一步与副作用判定——WITH 子句里的真实 DML 关键词仍在代码区
  if (WITH_DML_RE.test(blankLiterals(clean))) return true;

  const kw = firstKeyword(clean);
  if (!READ_STARTERS.has(kw)) return true; // 白名单之外 → 按写

  if (kw === "EXPLAIN") return EXPLAIN_ANALYZE_DML_RE.test(blankLiterals(clean));
  if (kw === "SELECT" || kw === "WITH" || kw === "VALUES" || kw === "TABLE") {
    // 副作用判定必须剥掉字面量：`SELECT 'FOR UPDATE'`、`WHERE note = 'x INTO y'`
    // 都是纯读，不能因为值里出现写关键字就弹确认框
    const code = blankLiterals(clean);
    return SELECT_SIDE_EFFECTS.some((re) => re.test(code));
  }
  return false; // SHOW / DESCRIBE / DESC / HELP
}

export function isDropStatement(stmt: string): boolean {
  return DROP_TABLE_RE.test(stripComments(stmt));
}

/**
 * 高风险写：DDL / 授权 / 会话与配置 / 写文件 / 服务端副作用函数。
 * 这类语句不可回滚或影响面不可预估，`confirm_before_exec=never` 不豁免它们。
 */
const HIGH_RISK_STARTERS: ReadonlySet<string> = new Set([
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT", "REINDEX", "CLUSTER",
  "GRANT", "REVOKE", "SET", "RESET", "ATTACH", "DETACH", "COPY", "LOAD", "IMPORT",
  "EXPORT", "DO", "VACUUM", "ANALYZE", "OPTIMIZE", "MSCK", "CALL", "EXEC", "EXECUTE",
  "PREPARE", "DEALLOCATE",
]);

/** 单条语句是否为高风险写（只在 isWriteStatement 为 true 时有意义） */
export function isHighRiskStatement(stmt: string): boolean {
  const clean = stripComments(stmt);
  if (!clean.trim()) return false;
  const code = blankLiterals(clean);
  if (WITH_DML_RE.test(code)) return true; // CTE 里夹 DML 一律按高风险
  const kw = firstKeyword(clean);
  if (HIGH_RISK_STARTERS.has(kw)) return true;
  // EXPLAIN ANALYZE <DML> 会**真的执行**被分析的语句——它虽然首关键字在 READ_STARTERS 里，
  // 但绝不能落到下面的「读语句副作用」分支（那里没有这条规则，会得出 highRisk=false，
  // 在 confirm_before_exec=never 下直接执行删除/更新）。这是 v1.3.8 真机测试抓到的漏洞。
  if (kw === "EXPLAIN") return EXPLAIN_ANALYZE_DML_RE.test(code);
  // 读外壳下的写副作用（INTO OUTFILE / 副作用函数）同样按高风险。
  // 注：只在读类首关键字上判——否则 `INSERT INTO t ...` 会被 INTO 误命中成「SELECT INTO 建表」
  if (READ_STARTERS.has(kw)) return SELECT_SIDE_EFFECTS.some((re) => re.test(code));
  return false;
}

/** 供展示层说明「为什么判成写」：首关键字在白名单外时给出该词 */
export function writeReasonOf(stmt: string): string | undefined {
  const clean = stripComments(stmt);
  if (WITH_DML_RE.test(clean)) return "CTE 内包含 DML";
  const kw = firstKeyword(clean);
  if (!kw || READ_STARTERS.has(kw)) {
    if (kw === "EXPLAIN" && EXPLAIN_ANALYZE_DML_RE.test(clean)) return "EXPLAIN ANALYZE 会真正执行被分析的语句";
    if (SELECT_SIDE_EFFECTS.some((re) => re.test(clean))) return "查询语句带有写副作用（INTO OUTFILE / 行锁 / 副作用函数）";
    return undefined;
  }
  return WRITE_KEYWORDS.has(kw) ? `写语句 ${kw}` : `未在白名单内的语句 ${kw}（保守按写）`;
}
