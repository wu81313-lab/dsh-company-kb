// HTTP 接口单测：把注册到的 handler 挂到真实 http server 上，用 fetch 打通全链路。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKbCore } from '../lib/core.js';
import { registerWebApi } from '../lib/web.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-company-kb-http-'));
  const root = join(dir, '资料');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '公司简介.txt'), '示例科技有限公司，产品追溯系统与视觉检测。', 'utf8');
  // 1x1 PNG，用于 /raw 图片直出测试
  writeFileSync(join(root, '截图.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  ));

  const core = createKbCore({
    roots: [root],
    databasePath: join(dir, 'index.sqlite'),
    settingsPath: join(dir, 'settings.json'),
  }, { logger: { warn: () => {}, info: () => {} } });
  await core.sync('now');

  // 打开系统程序在测试里必须被替换掉，否则会真的弹出资源管理器
  const opened = [];
  const revealed = [];

  let handler = null;
  const fakeWebServer = { register: route => { handler = route.handler; return () => {}; } };
  registerWebApi(fakeWebServer, core, {
    webPath: '/company-kb-api',
    logger: { warn: () => {} },
    openPath: async target => { opened.push(target); },
    revealPath: async target => { revealed.push(target); },
  });

  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/company-kb-api`;

  return {
    base,
    core,
    root,
    opened,
    revealed,
    cleanup: async () => {
      await new Promise(resolve => server.close(resolve));
      core.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('GET /status 返回索引概况', async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.base}/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.built, true);
    assert.equal(body.stats.docs, 2);
    assert.ok(body.settings.roots.length === 1);
  } finally {
    await context.cleanup();
  }
});

test('GET /search 与 /doc 能查到并读回原文', async () => {
  const context = await setup();
  try {
    const search = await (await fetch(`${context.base}/search?q=${encodeURIComponent('示例')}`)).json();
    assert.ok(search.hits.length > 0);
    const rel = search.hits[0].rel;
    const doc = await (await fetch(`${context.base}/doc?rel=${encodeURIComponent(rel)}&limit=200`)).json();
    assert.equal(doc.found, true);
    assert.ok(doc.text.includes('示例'));
  } finally {
    await context.cleanup();
  }
});

test('GET /tree 列出目录', async () => {
  const context = await setup();
  try {
    const tree = await (await fetch(`${context.base}/tree?dir=&depth=2`)).json();
    assert.ok(Array.isArray(tree.files));
    assert.equal(tree.files.length, 2);
    assert.ok(Array.isArray(tree.dirs));
  } finally {
    await context.cleanup();
  }
});

test('GET /log 返回同步记录', async () => {
  const context = await setup();
  try {
    const log = await (await fetch(`${context.base}/log?limit=10`)).json();
    assert.ok(Array.isArray(log.entries));
    assert.ok(log.entries.length >= 1, '同步过就应当有记录');
    assert.match(String(log.entries[0].message), /同步/u);
    assert.equal(typeof log.entries[0].ts, 'number');
  } finally {
    await context.cleanup();
  }
});

test('会话开关读写', async () => {
  const context = await setup();
  try {
    const initial = await (await fetch(`${context.base}/session?id=s-1`)).json();
    assert.equal(initial.enabled, false);
    const toggled = await (await fetch(`${context.base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 's-1', enabled: true }),
    })).json();
    assert.equal(toggled.enabled, true);
    const after = await (await fetch(`${context.base}/session?id=s-1`)).json();
    assert.equal(after.enabled, true);
  } finally {
    await context.cleanup();
  }
});

test('设置可读可写（热生效）', async () => {
  const context = await setup();
  try {
    const before = await (await fetch(`${context.base}/settings`)).json();
    assert.equal(before.settings.autoSync, 'off');
    const updated = await (await fetch(`${context.base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { autoSync: 'watch', triggers: ['知识库', '查档案'] } }),
    })).json();
    assert.equal(updated.settings.autoSync, 'watch');
    assert.deepEqual(updated.settings.triggers, ['知识库', '查档案']);
    const after = await (await fetch(`${context.base}/settings`)).json();
    assert.equal(after.settings.autoSync, 'watch', '设置应已落盘');
  } finally {
    await context.cleanup();
  }
});

test('未知路径 404、非法方法 405、坏请求 400', async () => {
  const context = await setup();
  try {
    assert.equal((await fetch(`${context.base}/nope`)).status, 404);
    assert.equal((await fetch(`${context.base}/status`, { method: 'DELETE' })).status, 405);
    const bad = await fetch(`${context.base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{不是 JSON',
    });
    assert.equal(bad.status, 400);
  } finally {
    await context.cleanup();
  }
});

test('非回环 Host 一律 403（挡 DNS rebinding）', async () => {
  const context = await setup();
  try {
    const port = Number(new URL(context.base).port);
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/company-kb-api/status',
        method: 'GET',
        headers: { host: 'evil.example.com' },
      }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    await context.cleanup();
  }
});

test('POST /open 与 /reveal 交给系统程序（测试里用桩替换）', async () => {
  const context = await setup();
  try {
    const open = await (await fetch(`${context.base}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: '公司简介.txt' }),
    })).json();
    assert.equal(open.opened, true);
    assert.equal(context.opened.length, 1);
    assert.ok(context.opened[0].endsWith('公司简介.txt'));

    const reveal = await (await fetch(`${context.base}/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: '公司简介.txt' }),
    })).json();
    assert.equal(reveal.revealed, true);
    assert.equal(context.revealed.length, 1);

    const missing = await fetch(`${context.base}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: '不存在的文件.txt' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await context.cleanup();
  }
});

test('GET /raw 直出原文件，且拒绝根目录之外的文件', async () => {
  const context = await setup();
  try {
    const text = await fetch(`${context.base}/raw?rel=${encodeURIComponent('公司简介.txt')}`);
    assert.equal(text.status, 200);
    assert.match(String(text.headers.get('content-type')), /text\/plain/u);
    assert.match(await text.text(), /示例/u);

    const image = await fetch(`${context.base}/raw?rel=${encodeURIComponent('截图.png')}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(String(image.headers.get('content-disposition')), /^inline/u);

    // 伪装成索引里的文件、但路径在根目录之外：必须 403
    writeFileSync(join(context.core.databasePath, '..', '外部文件.txt'), 'outside', 'utf8');
    const outside = join(context.core.databasePath, '..', '外部文件.txt');
    context.core.store.upsertDocument({
      path: outside, rel: '外部文件.txt', dir: '', name: '外部文件.txt', ext: '.txt',
      size: 7, mtime: Date.now(), sha1: null, kind: 'text', textSource: 'native',
      chars: 7, status: 'indexed',
    }, [{ ord: 0, heading: '', page: undefined, text: 'outside' }], { trigram: true });
    const denied = await fetch(`${context.base}/raw?rel=${encodeURIComponent('外部文件.txt')}`);
    assert.equal(denied.status, 403);
    const deniedOpen = await fetch(`${context.base}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: '外部文件.txt' }),
    });
    assert.equal(deniedOpen.status, 403);
    assert.equal(context.opened.length, 0, '被拒绝的文件不得交给系统程序');
  } finally {
    await context.cleanup();
  }
});
