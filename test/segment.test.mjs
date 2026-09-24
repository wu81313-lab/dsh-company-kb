// 分词 / 查询构造单测：中文二字组合、FTS 注入防护、停用词。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchPlan, cjkBigrams, escapeTerm, segmentForIndex, tokenize, normalizeOcrText } from '../lib/segment.js';

test('分词能切出中文词', () => {
  const tokens = tokenize('产线追溯系统上线运行');
  assert.ok(tokens.includes('追溯'), `期望含"追溯"，实际：${tokens.join('/')}`);
});

test('二字组合补上被切碎的复合词', () => {
  const bigrams = cjkBigrams('袋线瓶线');
  assert.ok(bigrams.includes('袋线'));
  assert.ok(bigrams.includes('瓶线'));
  const seg = segmentForIndex('袋线瓶线标准报价');
  assert.ok(seg.includes('袋线'), `索引文本应含二字组合：${seg}`);
  assert.ok(seg.includes('瓶线'));
});

test('查询计划：复合词进 FTS，不再全表 LIKE', () => {
  const plan = buildSearchPlan('袋线瓶线标准报价 技术方案书');
  assert.ok(plan.terms.includes('袋线'));
  assert.ok(plan.fts.includes('"袋线"'));
  assert.deepEqual(plan.like, [], '二字组合已经是正常词元，不该再走 LIKE');
  assert.deepEqual(plan.tri, [], '这段查询里没有 3 字以上的词元');
});

test('三字以上的词元走 trigram 子串路', () => {
  const plan = buildSearchPlan('GS1 标准体系与 tracecode 字段');
  assert.ok(plan.tri.includes('GS1'), `实际：${plan.tri.join('/')}`);
  assert.ok(plan.tri.includes('tracecode'));
});

test('单字查询才退化 LIKE', () => {
  const plan = buildSearchPlan('码');
  assert.deepEqual(plan.tri, []);
  assert.ok(plan.like.includes('码'));
});

test('引号短语被单独抽出', () => {
  const plan = buildSearchPlan('找一下 "单元识别代码" 的定义');
  assert.ok(plan.phrases.includes('单元识别代码'));
  assert.ok(plan.fts.includes('"单元识别代码"'));
});

test('FTS 语法注入被转义', () => {
  for (const evil of ['" OR *', 'NEAR/3 追溯', '系统 AND (码 OR *)', 'a"b', '追溯*', '^系统$']) {
    const plan = buildSearchPlan(evil);
    // 生成的 MATCH 表达式只允许 "词" 与 OR 组合
    assert.match(plan.fts, /^(?:"[^"]*(?:""[^"]*)*"(?: OR )?)*$/u, `非法表达式：${plan.fts}`);
    assert.ok(!/[()*^]/.test(plan.fts), `不应出现通配或括号：${plan.fts}`);
  }
});

test('escapeTerm 转义内部引号', () => {
  assert.equal(escapeTerm('a"b'), '"a""b"');
});

test('OCR 文本归一去掉汉字之间的空格', () => {
  assert.equal(normalizeOcrText('产 线 追 溯 系统 GS1 标准'), '产线追溯系统 GS1 标准');
});

test('归一化处理全角字符', () => {
  assert.equal(segmentForIndex('ＧＳ１'), segmentForIndex('GS1'));
});
