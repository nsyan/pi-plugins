// scan/scoring.ts —— 置信度：docker-compose/.env/application.yml 高权重；*test*/*example*/*.md/logs 降权或排除
// 注：排除/降权只看相对扫描根的路径——固件本身在 test/ 下不受影响。

const SOURCE_WEIGHT: Array<[RegExp, number]> = [
  [/application[^/]*\.ya?ml$/i, 0.9],
  [/docker-compose[^/]*\.ya?ml$/i, 0.85],
  [/^docker-compose[^/]*\.ya?ml$/i, 0.85],
  [/\.env(\.[^/]*)?$/i, 0.8],
  [/application[^/]*\.properties$/i, 0.7],
  [/\.properties$/i, 0.6],
];

const FALLBACK_WEIGHT = 0.5; // 通用 URL 正则扫出的候选

/** 命中测试/示例/文档/日志路径的文件整体排除，不产候选。 */
export function isExcluded(relPath: string): boolean {
  return /(^|\/)(test|tests|spec|specs|example|examples|docs?)(\/|$)/i.test(relPath)
    || /\.md$/i.test(relPath)
    || /\.(log|bak)$/i.test(relPath);
}

export function sourceWeight(relPath: string): number {
  for (const [re, w] of SOURCE_WEIGHT) if (re.test(relPath)) return w;
  return FALLBACK_WEIGHT;
}
