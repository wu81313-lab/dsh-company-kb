// 手动同步语义单测（沙箱 fixture，不动真实知识库）：
//   a) 新增文件后直接检索必须搜不到 —— 证明没有任何自动同步
//   b) 手动同步后必须能搜到
//   c) 删除文件后同步，必须不再命中
// 另测：二进制只登记元数据、根目录不可达时给出错误而不是崩溃。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettings } from '../lib/settings.js';
import { openStore } from '../lib/store.js';
import { createSyncEngine } from '../lib/scan.js';
import { buildSearchPlan } from '../lib/segment.js';
import { makeZip } from './helpers/zip-writer.mjs';

function stubOcr() {
  const capabilities = { ocr: false, pdf: false, word: false, ocrLangs: [], note: 'stub' };
  return {
    capabilities,
    probe: async () => capabilities,
    recognize: async () => new Map(),
    readLegacyDocs: async () => new Map(),
  };
}

function setup({ ocr = stubOcr() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-company-kb-sync-'));
  const root = join(dir, '资料');
  mkdirSync(join(root, '方案模板'), { recursive: true });
  writeFileSync(join(root, '公司简介.txt'), '示例科技有限公司成立于 2006 年，主营产品追溯系统。', 'utf8');
  writeFileSync(join(root, '方案模板', '通用模板.md'), '# 通用技术方案模板\n第一章 概述\n第二章 系统架构', 'utf8');
  writeFileSync(join(root, '图块综合.dwg'), Buffer.from([0x41, 0x43, 0x31, 0x30, 0x00, 0x01]), 'binary');

  const settings = createSettings({
    settingsPath: join(dir, 'settings.json'),
    config: { roots: [root], stalenessHint: true },
  });
  const store = openStore({ databasePath: join(dir, 'index.sqlite'), logger: { warn: () => {} } });
  store.migrate();
  const engine = createSyncEngine({ settings, store, ocr, logger: { warn: () => {} } });
  return {
    dir,
    root,
    settings,
    store,
    engine,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('首次同步建立索引，二进制只登记元数据', async () => {
  const context = setup();
  try {
    const summary = await context.engine.run('now');
    assert.equal(summary.scanned, 3);
    assert.equal(summary.failed, 0);
    assert.equal(context.store.stats().docs, 3);
    const dwg = context.store.getDocument(join(context.root, '图块综合.dwg'));
    assert.equal(String(dwg.status), 'metadata');
    const md = context.store.getDocument(join(context.root, '方案模板', '通用模板.md'));
    assert.equal(String(md.status), 'indexed');
    assert.ok(Number(md.chars) > 20);
  } finally {
    context.cleanup();
  }
});

test('手动同步语义：不点同步搜不到，点同步才搜得到，删除后同步消失', async () => {
  const context = setup();
  try {
    await context.engine.run('now');

    // 1) 新增一个含唯一串的文件，但不触发同步
    const added = join(context.root, '新资料.txt');
    writeFileSync(added, '这是一份新加入的资料，唯一标记 ZKTEST-UNIQUE-9527。', 'utf8');

    const before = context.store.search(buildSearchPlan('ZKTEST'));
    assert.equal(before.hits.length, 0, '未同步时不应搜到新文件（证明没有自动同步）');

    const staleness = context.engine.stalenessCheck(context.settings.get());
    assert.ok(staleness.added >= 1, `体检应报告新增文件，实际：${JSON.stringify(staleness)}`);

    // 2) 手动同步后应能搜到
    const summary = await context.engine.run('now');
    assert.equal(summary.added, 1);
    const after = context.store.search(buildSearchPlan('ZKTEST'));
    assert.equal(after.hits.length, 1, '同步后应能搜到新文件');

    // 3) 删除后同步，必须不再命中
    unlinkSync(added);
    const removed = await context.engine.run('now');
    assert.equal(removed.removed, 1);
    assert.equal(context.store.search(buildSearchPlan('ZKTEST')).hits.length, 0);
  } finally {
    context.cleanup();
  }
});

test('未变更的文件在第二次同步时被跳过', async () => {
  const context = setup();
  try {
    await context.engine.run('now');
    const second = await context.engine.run('now');
    assert.equal(second.unchanged, 3);
    assert.equal(second.added + second.updated, 0);
  } finally {
    context.cleanup();
  }
});

test('根目录不存在时报错但不崩溃', async () => {
  const context = setup();
  try {
    await context.engine.run('now');
    context.settings.update({ roots: [join(context.dir, '不存在的目录')] });
    const summary = await context.engine.run('now');
    assert.equal(summary.scanned, 0);
    assert.equal(summary.removed, 3, '根目录不可达时旧记录会被视为已删除');
    assert.ok(summary.errors.length > 0);
  } finally {
    context.cleanup();
  }
});

test('全量重建会清空后重抽', async () => {
  const context = setup();
  try {
    await context.engine.run('now');
    const summary = await context.engine.run('rebuild');
    assert.equal(summary.failed, 0);
    assert.equal(context.store.stats().docs, 3);
    assert.equal(context.store.search(buildSearchPlan('示例')).hits.length > 0, true);
  } finally {
    context.cleanup();
  }
});

test('同步记录带逐文件明细：新增/更新/删除都能看到具体文件名', async () => {
  const context = setup();
  try {
    const latest = () => context.store.recentLogs(1)[0];

    // 1) 首次同步：3 个文件都是新增，其中 dwg 只登记元数据
    await context.engine.run('now');
    const first = latest();
    assert.ok(first.details !== null, '同步记录应带明细');
    assert.deepEqual(
      first.details.added.map(item => item.rel).sort(),
      ['公司简介.txt', '图块综合.dwg', '方案模板/通用模板.md'].sort(),
    );
    const dwgEntry = first.details.added.find(item => item.rel === '图块综合.dwg');
    assert.match(String(dwgEntry.note), /仅登记/u);
    assert.equal(first.details.updated.length, 0);
    assert.equal(first.details.removed.length, 0);

    // 2) 改一个文件 → 明细里应出现在"更新"
    writeFileSync(join(context.root, '公司简介.txt'), '示例科技有限公司，产品追溯系统，本次内容有变化。', 'utf8');
    await context.engine.run('now');
    const second = latest();
    assert.deepEqual(second.details.updated.map(item => item.rel), ['公司简介.txt']);
    assert.equal(second.details.added.length, 0);

    // 3) 删一个文件 → 明细里应出现在"删除"
    unlinkSync(join(context.root, '方案模板', '通用模板.md'));
    await context.engine.run('now');
    const third = latest();
    assert.deepEqual(third.details.removed, ['方案模板/通用模板.md']);

    // 4) 旧记录（没有明细的那些）读出来必须是 null，而不是崩
    assert.equal(context.store.recentLogs(50).every(entry => 'details' in entry), true);
  } finally {
    context.cleanup();
  }
});

test('重抽指定文件：只动那几个文件，不碰其它（失败重试用）', async () => {
  const context = setup();
  try {
    await context.engine.run('now');
    // 三个文件都没变，指定只重抽其中一个
    const summary = await context.engine.run('now', { only: ['公司简介.txt'] });
    assert.equal(summary.mode, 'retry');
    assert.equal(summary.updated, 1);
    assert.equal(summary.added, 0);
    assert.equal(summary.unchanged, 2, '没指定的文件按未变化处理');
    assert.equal(summary.removed, 0, '重抽绝不能把别的文件当成删除');
    assert.equal(context.store.stats().docs, 3, '索引里的文件数不应变化');

    const log = context.store.recentLogs(1)[0];
    assert.match(log.message, /同步\(retry\)/u);
    assert.deepEqual(log.details.updated.map(item => item.rel), ['公司简介.txt']);
  } finally {
    context.cleanup();
  }
});

test('内嵌图片 OCR：有正文的文档也会把图里的字纳入检索，且命中缓存不重复识别', async () => {
  const recognized = [];
  const capabilities = { ocr: true, pdf: true, word: false, ocrLangs: ['zh-Hans-CN'], note: 'stub' };
  const ocr = {
    capabilities,
    probe: async () => capabilities,
    recognize: async jobs => {
      recognized.push(...jobs.map(job => job.path));
      return new Map(jobs.map(job => [job.id, { ok: true, text: '架构图上的唯一标记 PICONLY-7788' }]));
    },
    readLegacyDocs: async () => new Map(),
  };
  const context = setup({ ocr });
  try {
    // 有正文 + 一张 30KB 的截图（小于阈值的小图会被当 logo 跳过）
    const docx = makeZip({
      'word/document.xml': '<?xml version="1.0"?><w:document><w:body>'
        + '<w:p><w:r><w:t>本段是正文，讲的是系统部署方式。</w:t></w:r></w:p></w:body></w:document>',
      'word/media/screenshot.png': Buffer.alloc(30 * 1024, 7),
    });
    writeFileSync(join(context.root, '带截图的方案.docx'), docx);

    const summary = await context.engine.run('now');
    assert.equal(summary.embeddedImages, 1, '应把一张内嵌图片纳入索引');
    assert.equal(recognized.length, 1, '应调用一次图片 OCR');

    // 正文与图片文字都能搜到
    assert.ok(context.store.search(buildSearchPlan('系统部署方式')).hits.length > 0);
    const imageHit = context.store.search(buildSearchPlan('PICONLY-7788'));
    assert.equal(imageHit.hits.length, 1, '图片里的字必须能搜到');
    assert.match(imageHit.hits[0].snippet, /【图片1】/u, '应标明这段文字来自图片');
    assert.equal(context.store.imageOcrStats().images, 1, 'OCR 结果应写入缓存');

    // 第二次同步：文件没变不会重抽；改一下 mtime 强制重抽，也要命中缓存不再 OCR
    const recognizedBefore = recognized.length;
    const target = join(context.root, '带截图的方案.docx');
    writeFileSync(target, docx);
    await context.engine.run('now');
    assert.equal(recognized.length, recognizedBefore, '同一张图不应重复 OCR（应命中 sha1 缓存）');
    assert.equal(context.store.search(buildSearchPlan('PICONLY-7788')).hits.length, 1);
  } finally {
    context.cleanup();
  }
});

test('内嵌图片 OCR：开关从关到开时，老文件会被自动补做（不必整库重建）', async () => {
  const capabilities = { ocr: true, pdf: true, word: false, ocrLangs: ['zh-Hans-CN'], note: 'stub' };
  let calls = 0;
  const ocr = {
    capabilities,
    probe: async () => capabilities,
    recognize: async jobs => {
      calls += jobs.length;
      return new Map(jobs.map(job => [job.id, { ok: true, text: '补做后才有的标记 BACKFILL-4242' }]));
    },
    readLegacyDocs: async () => new Map(),
  };
  const context = setup({ ocr });
  try {
    // 先在"关掉开关"的状态下建索引：图片文字不该进库
    context.settings.update({ ocrEmbeddedImages: false });
    const docx = makeZip({
      'word/document.xml': '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
      'word/media/shot.png': Buffer.alloc(30 * 1024, 9),
    });
    writeFileSync(join(context.root, '开关测试.docx'), docx);
    await context.engine.run('now');
    assert.equal(calls, 0, '关着开关时不该抽图');
    assert.equal(context.store.search(buildSearchPlan('BACKFILL-4242')).hits.length, 0);

    // 打开开关，只跑普通同步（不是重建），该文件应被自动补做一次
    context.settings.update({ ocrEmbeddedImages: true });
    const summary = await context.engine.run('now');
    assert.equal(calls, 1, '打开开关后应补做一次内嵌图片 OCR');
    assert.equal(summary.embeddedImages, 1);
    assert.equal(context.store.search(buildSearchPlan('BACKFILL-4242')).hits.length, 1);

    // 再同步一次：已标记过，不该重复抽图
    const again = await context.engine.run('now');
    assert.equal(calls, 1, '补做过的文件不该反复重抽');
    assert.equal(again.embeddedImages, 0, '第二次同步没有新图片要做');
  } finally {
    context.cleanup();
  }
});

test('内嵌图片 OCR：小于阈值的图按 logo 跳过，关掉开关则完全不抽图', async () => {
  const capabilities = { ocr: true, pdf: true, word: false, ocrLangs: ['zh-Hans-CN'], note: 'stub' };
  let calls = 0;
  const ocr = {
    capabilities,
    probe: async () => capabilities,
    recognize: async jobs => {
      calls += jobs.length;
      return new Map(jobs.map(job => [job.id, { ok: true, text: '不该出现' }]));
    },
    readLegacyDocs: async () => new Map(),
  };
  const context = setup({ ocr });
  try {
    const docx = makeZip({
      'word/document.xml': '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
      'word/media/logo.png': Buffer.alloc(2 * 1024, 3),   // 2KB，阈值以下
    });
    writeFileSync(join(context.root, '带小logo.docx'), docx);
    const summary = await context.engine.run('now');
    assert.equal(summary.embeddedImages, 0);
    assert.equal(calls, 0, '小图不该送去 OCR');

    context.settings.update({ ocrEmbeddedImages: false });
    await context.engine.run('now');
    assert.equal(calls, 0, '关掉开关后完全不该抽图');
  } finally {
    context.cleanup();
  }
});
