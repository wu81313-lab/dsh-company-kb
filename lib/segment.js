// 中文分词与 FTS5 查询构造。
//
// 为什么必须分词：SQLite FTS5 的 unicode61 分词器不切中文。实测把
// "产线追溯系统上线运行" 原样写入后，MATCH '追溯' 命中 0 条；只有把文本预分词成
// "产线 追溯 系统 上线 运行" 再写入，MATCH 才能命中并按 BM25 排序。
// 因此索引列写分词结果，原文另存一列给 trigram 做子串匹配。

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
// 只用于"自动召回式"的宽泛查询；本插件的查询由用户明确发起，所以只保留极少数噪音词。
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '对', '为', '以', '把', '被', '从', '到',
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'are', 'for', 'in', 'on', 'with', 'this', 'that', 'it', 'as', 'be', 'by', 'from',
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const MAX_QUERY_TERMS = 20;

export { cjkBigrams } from './bigram.js';
import { cjkBigrams } from './bigram.js';

/** Unicode 归一化：把全角/兼容字符折叠成规范形式，便于与索引一致。 */
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').replace(/\u0000/g, '');
}

/** 中文词元切分（含 ASCII 词）。保留单字 CJK 词元：短查询靠它们命中。 */
export function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const part of SEGMENTER.segment(normalize(text))) {
    if (!part.isWordLike) continue;
    const word = part.segment.trim();
    if (word.length === 0 || word.length > 64) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** 写入 FTS 的索引文本：空格分隔的词元序列 + 中文二字组合。 */
export function segmentForIndex(text) {
  const tokens = tokenize(text);
  const seen = new Set(tokens.map(token => token.toLowerCase()));
  const bigrams = [];
  for (const bigram of cjkBigrams(text)) {
    const key = bigram.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bigrams.push(bigram);
    if (bigrams.length >= 4000) break;
  }
  return [...tokens, ...bigrams].join(' ');
}

/** 查询词元：去掉停用词；当存在多字词时丢掉单字 CJK；再补上二字组合。 */
export function queryTerms(text) {
  const words = tokenize(text).filter(word => !STOP_WORDS.has(word.toLowerCase()));
  const hasLong = words.some(word => word.length >= 2);
  const kept = hasLong ? words.filter(word => word.length >= 2 || !CJK.test(word)) : words;
  const out = [...kept];
  const seen = new Set(out.map(word => word.toLowerCase()));
  const room = Math.max(0, MAX_QUERY_TERMS - out.length);
  if (room > 0) {
    for (const bigram of cjkBigrams(text)) {
      const key = bigram.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(bigram);
      if (out.length >= MAX_QUERY_TERMS) break;
    }
  }
  return out.slice(0, MAX_QUERY_TERMS);
}

/** 把任意用户输入变成 FTS5 短语词元，杜绝 MATCH 语法注入（引号/星号/OR/NEAR 等）。 */
export function escapeTerm(term) {
  return `"${String(term).replaceAll('"', '""')}"`;
}

/** 抽取被引号包裹的短语（中英文引号都认）。 */
export function extractPhrases(text) {
  const out = [];
  for (const match of normalize(text).matchAll(/["“”'‘’]([^"“”'‘’]{2,60})["“”'‘’]/gu)) {
    const phrase = match[1].trim();
    if (phrase.length > 0) out.push(phrase);
  }
  return out;
}

/**
 * 构造检索计划：
 *  - fts  : A 路（词级 BM25）的 MATCH 表达式，含分词词元与中文二字组合
 *  - tri  : B 路中长度 >= 3 的词（trigram 子串匹配）
 *  - like : 只有 1 个字的查询才退化为 LIKE（二字组合已作为正常词元进入 FTS，
 *           不需要再全表扫描）
 */
export function buildSearchPlan(text) {
  const phrases = extractPhrases(text);
  const terms = queryTerms(text);
  for (const phrase of phrases) for (const word of tokenize(phrase)) if (!terms.includes(word)) terms.push(word);
  const bounded = terms.slice(0, MAX_QUERY_TERMS);
  const clauses = [...phrases.map(escapeTerm), ...bounded.map(escapeTerm)];
  return {
    phrases,
    terms: bounded,
    fts: clauses.length === 0 ? '' : clauses.join(' OR '),
    tri: bounded.filter(term => term.length >= 3),
    like: bounded.filter(term => term.length === 1),
  };
}

/** OCR 结果归一：OCR 常在汉字之间插空格，检索前必须去掉。 */
export function normalizeOcrText(text) {
  return normalize(text)
    .replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff])[ \t]+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
