// HTTP 接口单测：把注册到的 handler 挂到真实 http server 上，用 fetch 打通全链路。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKbCore } from '../lib/core.js';
import { registerWebApi } from '../lib/web.js';
import { makeZip, TINY_PNG } from './helpers/zip-writer.mjs';

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

test('GET /preview 渲染 Office 文档为 HTML，并带沙箱 CSP', async () => {
  const context = await setup();
  try {
    // 现造一个带标题与图片的 docx，同步进索引后再走接口
    const docx = makeZip({
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'word/document.xml': '<?xml version="1.0"?><w:document><w:body>'
        + '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>预览标题</w:t></w:r></w:p>'
        + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格甲</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        + '<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>'
        + '</w:body></w:document>',
      'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships>'
        + '<Relationship Id="rId5" Type="image" Target="media/logo.png"/></Relationships>',
      'word/media/logo.png': TINY_PNG,
    });
    writeFileSync(join(context.root, '预览样例.docx'), docx);
    await context.core.sync('now');

    const rel = encodeURIComponent('预览样例.docx');
    const response = await fetch(`${context.base}/preview?rel=${rel}`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/html/u);
    assert.match(String(response.headers.get('content-security-policy')), /default-src 'none'/u);
    const html = await response.text();
    assert.match(html, /预览标题/u);
    assert.match(html, /单元格甲/u);
    assert.match(html, /<img class="pic"/u);

    // 预览里的图片：从 zip 条目直出
    const image = await fetch(`${context.base}/media?rel=${rel}&name=${encodeURIComponent('word/media/logo.png')}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal((await image.arrayBuffer()).byteLength, TINY_PNG.length);

    // 压缩包里没有的条目、索引里没有的文件、不支持预览的类型
    assert.equal((await fetch(`${context.base}/media?rel=${rel}&name=word/media/none.png`)).status, 404);
    assert.equal((await fetch(`${context.base}/preview?rel=${encodeURIComponent('不存在.docx')}`)).status, 404);
    assert.equal((await fetch(`${context.base}/preview?rel=${encodeURIComponent('公司简介.txt')}`)).status, 415);
  } finally {
    await context.cleanup();
  }
});

test('GET /preview 拒绝索引之外的文件（与 /raw 同一套校验）', async () => {
  const context = await setup();
  try {
    writeFileSync(join(context.root, '还没同步.docx'), makeZip({ 'word/document.xml': '<w:document/>' }));
    const response = await fetch(`${context.base}/preview?rel=${encodeURIComponent('还没同步.docx')}`);
    assert.equal(response.status, 404, '没进索引的文件不允许预览');
  } finally {
    await context.cleanup();
  }
});

test('GET /search 支持按类型与时间筛选', async () => {
  const context = await setup();
  try {
    const all = await (await fetch(`${context.base}/search?q=${encodeURIComponent('追溯')}`)).json();
    assert.ok(all.hits.length > 0);
    const onlyPng = await (await fetch(`${context.base}/search?q=${encodeURIComponent('追溯')}&ext=png`)).json();
    assert.ok(onlyPng.hits.every(hit => String(hit.rel).endsWith('.png')), '类型筛选应只返回该类型');
    const onlyTxt = await (await fetch(`${context.base}/search?q=${encodeURIComponent('追溯')}&ext=.txt`)).json();
    assert.ok(onlyTxt.hits.every(hit => String(hit.rel).endsWith('.txt')), 'ext 带点也认');
    const recent = await (await fetch(`${context.base}/search?q=${encodeURIComponent('追溯')}&days=1`)).json();
    assert.ok(recent.hits.length > 0, '刚写入的文件算最近 1 天');
    const none = await (await fetch(`${context.base}/search?q=${encodeURIComponent('追溯')}&ext=.pdf`)).json();
    assert.equal(none.hits.length, 0, '库里没有的类型应返回空');
  } finally {
    await context.cleanup();
  }
});

test('POST /resync 只重抽指定文件，空列表报 400', async () => {
  const context = await setup();
  try {
    const response = await fetch(`${context.base}/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rels: ['公司简介.txt'] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).started, true);

    const empty = await fetch(`${context.base}/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rels: [] }),
    });
    assert.equal(empty.status, 400);

    for (let i = 0; i < 50; i += 1) {
      const logs = await (await fetch(`${context.base}/log?limit=1`)).json();
      if (String(logs.entries[0].message).includes('retry')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const logs = await (await fetch(`${context.base}/log?limit=1`)).json();
    assert.match(String(logs.entries[0].message), /同步\(retry\)/u);
  } finally {
    await context.cleanup();
  }
});
