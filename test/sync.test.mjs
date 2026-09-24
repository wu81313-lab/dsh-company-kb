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

function stubOcr() {
  const capabilities = { ocr: false, pdf: false, word: false, ocrLangs: [], note: 'stub' };
  return {
    capabilities,
    probe: async () => capabilities,
    recognize: async () => new Map(),
    readLegacyDocs: async () => new Map(),
  };
}

function setup() {
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
  const engine = createSyncEngine({ settings, store, ocr: stubOcr(), logger: { warn: () => {} } });
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
