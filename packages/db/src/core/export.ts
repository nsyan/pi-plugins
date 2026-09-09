// core/export.ts —— 查询结果导出纯函数（CSV/JSON 落盘由调用方执行；本模块零依赖可测）

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 行数据 → CSV 文本（首行表头；含逗号/引号/换行的值按 RFC 4180 转义） */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\n");
}
