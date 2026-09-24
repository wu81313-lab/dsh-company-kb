// 中文 bigram 支持。
//
// 背景：Intl.Segmenter 会把"袋线瓶线"/"人药追溯"这类公司内部复合词切成单字
// （袋|线|瓶|线），单字被丢弃后查询就只剩"标准""报价"这种到处都是的词，直接
// 检索失败。解决办法是索引时额外写入相邻二字组合（袋线/线瓶/瓶线），查询时同样
// 生成二字组合——这样 2 字查询走的是正常 FTS 词元（有 BM25 排序），而不是全表扫描。

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;

export function cjkBigrams(text) {
  const out = [];
  for (const match of String(text ?? '').normalize('NFKC').matchAll(CJK_RUN)) {
    const run = match[0];
    for (let index = 0; index + 1 < run.length; index += 1) out.push(run.slice(index, index + 2));
  }
  return out;
}
