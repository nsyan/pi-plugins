// scan/tree.ts —— 项目文件树收集（AI 扫描时代的"发现层"）
// 设计（v1.3.0 共识）：文件发现与内容提取全部交给会话模型——本模块只做确定性的事情：
//   走完整棵目录树、排除无关目录、产出相对路径清单。语言无关（Java/Py/TS/Go/Rust...）。
// 注：不再做任何"这是不是配置文件"的猜测（原文件名模式匹配已废弃）——
//     模型看到完整树后自行判断哪些文件值得读（用其自带 read 工具），长尾格式天然覆盖。

import { resolveRoot, walk } from "./walker.js";

export interface TreeResult {
  root: string;            // 绝对路径
  total: number;           // 收集到的文件总数
  truncated: boolean;      // 是否超出 MAX_TREE_LINES 被截断
  depthCapped: boolean;    // 是否有目录未展开（超 MAX_DEPTH 或目录预算；如实上报，避免静默漏扫）
  lines: string[];         // 相对路径清单（已排序：浅层优先）
}

const MAX_TREE_LINES = 3000;

/** 收集项目文件树（相对路径排序清单）；越界由 resolveRoot 拒绝。
 * anchor 传会话工作目录（`ctx.cwd`），勿传 `process.cwd()`，原因见 walker.resolveRoot。
 * 输出确定：walk 对目录项排序，本函数再按「浅层优先 + 字典序」排序，同一项目每次结果一致 */
export function collectTree(rootInput: string, anchor: string): TreeResult {
  const root = resolveRoot(rootInput, anchor);
  const { files, depthCapped } = walk(root);
  const rels = files
    .map((f) => f.slice(root.length + 1).split("\\").join("/"))
    .sort((a, b) => {
      const da = a.split("/").length, db = b.split("/").length;
      return da !== db ? da - db : a.localeCompare(b);
    });
  return {
    root,
    total: rels.length,
    truncated: rels.length > MAX_TREE_LINES,
    depthCapped,
    lines: rels.slice(0, MAX_TREE_LINES),
  };
}
