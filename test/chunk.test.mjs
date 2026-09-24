// 分块单测：标题面包屑、页码标记、重叠、超长段落、短尾块合并。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBlocks, blocksToText, detectHeadingLevel, textToBlocks } from '../lib/chunk.js';

test('标题构成面包屑', () => {
  const chunks = chunkBlocks([
    { kind: 'heading', level: 1, text: '一、系统概述' },
    { kind: 'para', text: 'A'.repeat(60) },
    { kind: 'heading', level: 2, text: '1.1 架构' },
    { kind: 'para', text: 'B'.repeat(60) },
  ], { chunkChars: 200, chunkOverlap: 0 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, '一、系统概述');
  assert.equal(chunks[1].heading, '一、系统概述 / 1.1 架构');
});

test('页码标记写进块', () => {
  const chunks = chunkBlocks([
    { kind: 'page', n: 3 },
    { kind: 'para', text: '这是第三页的内容' },
  ], { chunkChars: 900, chunkOverlap: 0 });
  assert.equal(chunks[0].page, 3);
});

test('超长段落按句子切分且不超过 3 倍块长', () => {
  const long = Array.from({ length: 400 }, (_, index) => `第${index}句话内容说明。`).join('');
  const chunks = chunkBlocks([{ kind: 'para', text: long }], { chunkChars: 200, chunkOverlap: 0 });
  assert.ok(chunks.length > 3, `应切成多块，实际 ${chunks.length}`);
  for (const chunk of chunks) assert.ok(chunk.text.length < 900, `块过长：${chunk.text.length}`);
});

test('重叠保留上下文', () => {
  const chunks = chunkBlocks([
    { kind: 'para', text: 'X'.repeat(320) },
    { kind: 'para', text: 'Y'.repeat(320) },
    { kind: 'para', text: 'Z'.repeat(320) },
  ], { chunkChars: 320, chunkOverlap: 60 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[1].text.startsWith('X'), `第二块应带上重叠的尾巴，实际开头：${chunks[1].text.slice(0, 20)}`);
});

test('只有标题的文档也要产出块', () => {
  const chunks = chunkBlocks([
    { kind: 'heading', level: 1, text: '# 通用技术方案模板' },
    { kind: 'heading', level: 2, text: '第一章 概述' },
    { kind: 'heading', level: 2, text: '第二章 系统架构' },
  ], { chunkChars: 900, chunkOverlap: 0 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('系统架构'));
});

test('空内容与纯标题的处理', () => {
  const chunks = chunkBlocks([{ kind: 'para', text: '   ' }, { kind: 'heading', level: 1, text: '标题' }], {});
  assert.equal(chunks.length, 1, '只有标题时也要产出一个块');
  assert.ok(chunks[0].text.includes('标题'));
  assert.equal(chunkBlocks([{ kind: 'para', text: '   ' }], {}).length, 0);
});

test('标题识别：Markdown 与中文序号', () => {
  assert.equal(detectHeadingLevel('# 一级标题'), 1);
  assert.equal(detectHeadingLevel('一、总体要求'), 2);
  assert.equal(detectHeadingLevel('（三）具体实施'), 2);
  assert.equal(detectHeadingLevel('2.1.3 接口定义'), 2);
  assert.equal(detectHeadingLevel('这是一段普通的正文，描述了系统的功能与实现方式。'), 0);
});

test('blocksToText 保留结构', () => {
  const blocks = textToBlocks('# 标题\n正文一\n正文二');
  const text = blocksToText(blocks);
  assert.ok(text.includes('# 标题'));
  assert.ok(text.includes('正文二'));
});
