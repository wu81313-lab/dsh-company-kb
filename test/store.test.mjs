// 索引库与检索单测：中文词级召回、二字组合召回、子串召回、读取、目录、统计、删除。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.js';
import { buildSearchPlan } from '../lib/segment.js';
import { chunkBlocks } from '../lib/chunk.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-company-kb-test-'));
  const store = openStore({ databasePath: join(dir, 'index.sqlite'), logger: { warn: () => {} } });
  store.migrate();
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function addDoc(store, rel, text) {
  const chunks = chunkBlocks([{ kind: 'heading', level: 1, text: rel }, { kind: 'para', text }], { chunkChars: 400, chunkOverlap: 0 });
  // Windows 路径统一成反斜杠，避免测试里两种写法对不上
  const path = `D:\\kb\\${rel.replaceAll('/', '\\')}`;
  return store.upsertDocument({
    path,
    rel,
    dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    name: rel.slice(rel.lastIndexOf('/') + 1),
    ext: '.txt',
    size: text.length,
    mtime: Date.now(),
    sha1: 'x',
    kind: 'text',
    textSource: 'native',
    chars: text.length,
    status: 'indexed',
  }, chunks, { trigram: true });
}

test('中文词级召回（unicode61 直索会漏，分词后能中）', () => {
  const { store, cleanup } = makeStore();
  try {
    addDoc(store, '农药追溯政策/公告.txt', '产线追溯系统上线运行，采用GS1标准编码，农药标签二维码码制采用QR码。');
    const hit = store.search(buildSearchPlan('追溯'));
    assert.ok(hit.hits.length > 0, '分词索引后应能命中"追溯"');
    const strict = store.search(buildSearchPlan('农药标签二维码'));
    assert.ok(strict.hits.length > 0);
  } finally {
    cleanup();
  }
});

test('二字组合召回（复合词被分词器切碎也能中）', () => {
  const { store, cleanup } = makeStore();
  try {
    addDoc(store, '标准报价/袋线瓶线标准报价（260918）.xlsx', '袋线瓶线标准报价 单位 元 数量');
    const result = store.search(buildSearchPlan('袋线瓶线标准报价'));
    assert.ok(result.hits.length > 0, '应命中报价文件');
    assert.ok(result.hits[0].rel.includes('袋线瓶线'), `首选应是报价文件，实际：${result.hits[0]?.rel}`);
  } finally {
    cleanup();
  }
});

test('子串召回（trigram 路径）', () => {
  const { store, cleanup } = makeStore();
  try {
    addDoc(store, '追溯后台/接口文档.txt', '标准化系统对接接口文档，包含 tracecode 与 CERTIFICATECODE 字段说明。');
    const result = store.search(buildSearchPlan('对接接口'));
    assert.ok(result.hits.length > 0);
  } finally {
    cleanup();
  }
});

test('每个命中带 charStart（等于前面各块长度之和）', () => {
  const { store, cleanup } = makeStore();
  try {
    // 造一份真正长的文档（约 1.3 万字），必然切出多块
    const long = Array.from({ length: 300 }, (_, index) => `第${index}段：追溯系统功能与接口说明，包含产线赋码、采集关联与上传校验等内容。`).join('');
    addDoc(store, '长文档/说明书.txt', long);
    const result = store.search(buildSearchPlan('追溯'), { limit: 10, maxPerDoc: 5 });
    assert.ok(result.hits.length >= 2, `应有多块命中，实际 ${result.hits.length}`);

    // 复算期望偏移：与 addDoc 相同的分块参数，累加各块正文长度
    const expected = [];
    let acc = 0;
    for (const chunk of chunkBlocks([
      { kind: 'heading', level: 1, text: '长文档/说明书.txt' },
      { kind: 'para', text: long },
    ], { chunkChars: 400, chunkOverlap: 0 })) {
      expected.push(acc);
      acc += chunk.text.length;
    }

    const actual = result.hits.map(hit => hit.charStart);
    // 命中是"得分最高的若干块"，不一定是前几块，所以逐个校验它们都落在期望偏移集合里
    for (const value of actual) {
      assert.ok(expected.includes(value), `charStart ${value} 不在期望偏移集合内：${expected.join(',')}`);
    }
    assert.equal(actual.length, new Set(actual).size, '不同块的 charStart 不应重复');
    assert.ok(actual.some(value => value > 0), '应至少有一个不在开头的块');
  } finally {
    cleanup();
  }
});

test('同一文件最多返回 maxPerDoc 块', () => {
  const { store, cleanup } = makeStore();
  try {
    const long = Array.from({ length: 60 }, () => '追溯系统功能说明。').join('');
    addDoc(store, '长文档.txt', long);
    const result = store.search(buildSearchPlan('追溯'), { limit: 10, maxPerDoc: 2 });
    assert.ok(result.hits.length <= 2, `应受 maxPerDoc 限制，实际 ${result.hits.length}`);
  } finally {
    cleanup();
  }
});

test('恶意查询串不会抛错', () => {
  const { store, cleanup } = makeStore();
  try {
    addDoc(store, 'a.txt', '追溯 系统 说明');
    for (const evil of ['" OR *', 'NEAR/3 追溯', '系统 AND (码 OR *)', '***', '"', '追溯*']) {
      const plan = buildSearchPlan(evil);
      assert.doesNotThrow(() => store.search(plan), `查询串导致异常：${evil}`);
    }
  } finally {
    cleanup();
  }
});

test('读取、目录、统计与删除', () => {
  const { store, cleanup } = makeStore();
  try {
    addDoc(store, '方案模板/通用模板.txt', '第一章 概述。第二章 系统架构。');
    addDoc(store, '公司介绍/简介.txt', '示例科技有限公司成立于 2006 年。');
    const doc = store.getDocument('方案模板/通用模板.txt');
    assert.ok(doc !== undefined);
    const read = store.readDocumentText(Number(doc.id), 0, 100);
    assert.ok(read.text.includes('第一章'));
    assert.ok(read.total > 0);
    const tree = store.listDir({ dir: '', depth: 1 });
    assert.equal(tree.files.length, 0, '根目录下没有直接文件');
    assert.equal(tree.dirs.length, 2, 'depth=1 也必须列出直接子目录（回归：曾经返回空）');
    assert.deepEqual(tree.dirs.map(item => item.dir).sort(), ['公司介绍', '方案模板']);
    const deeper = store.listDir({ dir: '', depth: 2 });
    assert.equal(deeper.dirs.length, 2);
    const inside = store.listDir({ dir: '方案模板', depth: 1 });
    assert.equal(inside.files.length, 1, '进入子目录后应看到其中的文件');
    assert.equal(inside.files[0].name, '通用模板.txt');
    assert.equal(inside.dirs.length, 0);
    const filtered = store.listDir({ dir: '', depth: 1, filter: '简介' });
    assert.equal(filtered.files.length, 0, '过滤只作用于文件，不影响目录列表');
    const insideFiltered = store.listDir({ dir: '公司介绍', depth: 1, filter: '简介' });
    assert.equal(insideFiltered.files.length, 1);
    const stats = store.stats();
    assert.equal(stats.docs, 2);
    assert.ok(stats.chunks >= 2);
    assert.equal(store.deleteDocument('D:\\kb\\公司介绍\\简介.txt'), true);
    assert.equal(store.stats().docs, 1);
    const afterDelete = store.search(buildSearchPlan('示例'));
    assert.equal(afterDelete.hits.length, 0, '删除后不应再命中');
  } finally {
    cleanup();
  }
});

test('会话开关与日志', () => {
  const { store, cleanup } = makeStore();
  try {
    assert.equal(store.sessionGet('s1'), undefined);
    store.sessionSet('s1', true);
    assert.equal(store.sessionGet('s1'), true);
    store.sessionSet('s1', false);
    assert.equal(store.sessionGet('s1'), false);
    store.logSync('info', '测试日志');
    assert.equal(store.recentLogs(5)[0].message, '测试日志');
  } finally {
    cleanup();
  }
});
