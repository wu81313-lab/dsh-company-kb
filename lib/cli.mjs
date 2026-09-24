// 命令行：不启动 DSH 也能建库、检索、看状态。首次建库与批量自测推荐用它。
//
//   node lib/cli.mjs status
//   node lib/cli.mjs probe
//   node lib/cli.mjs index [--rebuild] [--root <目录>]...     手动同步（默认增量）
//   node lib/cli.mjs search "农药追溯 二维码" [--limit 8] [--dir 农药追溯政策]
//   node lib/cli.mjs read "<相对路径或文件名>" [--offset 0] [--limit 4000]
//   node lib/cli.mjs list [目录] [--depth 2] [--filter 报价]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKbCore } from './core.js';

/** 没有 --root 时，从插件自带的 cordis.patch.yml 里读默认根目录。 */
function rootsFromPatch() {
  try {
    const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
    const text = readFileSync(patchPath, 'utf8');
    const block = /roots:\s*\n((?:\s*-\s*.+\n?)+)/u.exec(text);
    if (block === null) return [];
    return [...block[1].matchAll(/-\s*'([^']+)'|-\s*"([^"]+)"|-\s*([^\n#]+)/gu)]
      .map(match => (match[1] ?? match[2] ?? match[3] ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, true);
      } else {
        const existing = flags.get(key);
        if (existing === undefined) flags.set(key, next);
        else if (Array.isArray(existing)) existing.push(next);
        else flags.set(key, [existing, next]);
        index += 1;
      }
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift() ?? 'status';

const config = {
  databasePath: process.env.DSH_LOCAL_KB_DB,
  settingsPath: process.env.DSH_LOCAL_KB_SETTINGS,
};
const rootFlag = flags.get('root');
const defaultRoots = rootsFromPatch();
if (typeof rootFlag === 'string') config.roots = [rootFlag];
else if (Array.isArray(rootFlag)) config.roots = rootFlag;
else if (defaultRoots.length > 0) config.roots = defaultRoots;

const core = createKbCore(config, { logger: console });
const kb = core;

function formatBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function printHits(result) {
  console.log(`命中 ${result.hits.length} 条（候选 ${result.candidates} 条；查询词：${[...result.plan.phrases, ...result.plan.terms].join(' / ') || '无'}）`);
  for (const [index, hit] of result.hits.entries()) {
    const page = hit.page === undefined ? '' : ` 第${hit.page}页`;
    const source = hit.textSource === 'native' ? '' : ` [${hit.textSource}]`;
    console.log(`\n${index + 1}. ${hit.rel}${page}${source}`);
    if (hit.heading) console.log(`   标题：${hit.heading}`);
    console.log(`   ${hit.snippet.replace(/\s+/gu, ' ').slice(0, 360)}`);
  }
  if (result.stale && (result.stale.changed > 0 || result.stale.added > 0 || result.stale.removed > 0)) {
    console.log(`\n⚠️ 索引之后检测到变化：修改 ${result.stale.changed}、新增 ${result.stale.added}、删除 ${result.stale.removed}（需手动同步）`);
  }
}

switch (command) {
  case 'probe': {
    const capabilities = await kb.capabilities();
    console.log(JSON.stringify(capabilities, null, 2));
    break;
  }
  case 'status': {
    await kb.capabilities();
    const status = kb.status();
    const lastSync = status.lastSyncAt === null ? '从未同步' : new Date(status.lastSyncAt).toLocaleString('zh-CN');
    console.log(`索引库：${status.databasePath}`);
    console.log(`是否已建库：${status.built ? '是' : '否（尚未手动同步）'}`);
    console.log(`面板接口：${status.webApi?.state ?? 'unknown'}${status.webApi?.path ? `（${status.webApi.path}）` : ''}${status.webApi?.error ? ` :: ${status.webApi.error}` : ''}（CLI 场景下未注册属正常）`);
    console.log(`上次同步：${lastSync}`);
    if (status.lastSummary) console.log(`上次摘要：${JSON.stringify(status.lastSummary)}`);
    console.log(`文档 ${status.stats.docs} 个 / 块 ${status.stats.chunks} 个 / 字符 ${status.stats.chars.toLocaleString('en-US')} / 库体积 ${formatBytes(status.stats.databaseBytes)}`);
    console.log(`按状态：${status.stats.byStatus.map(item => `${item.status}=${item.n}`).join('  ')}`);
    console.log(`按来源：${status.stats.bySource.map(item => `${item.source}=${item.n}`).join('  ')}`);
    console.log(`按类型：${status.stats.byExt.map(item => `${item.ext || '(无)'}=${item.n}`).join('  ')}`);
    console.log(`OCR 助手：${JSON.stringify(status.capabilities)}`);
    console.log(`根目录：${status.roots.map(item => `${item.path}${item.ok ? '' : '（不可访问）'}`).join('；')}`);
    if (status.stale) console.log(`体检：修改 ${status.stale.changed}、新增 ${status.stale.added}、删除 ${status.stale.removed}`);
    if (status.stats.failures.length > 0) {
      console.log('\n未能抽取正文的文件：');
      for (const failure of status.stats.failures.slice(0, 20)) {
        console.log(`  - [${failure.status}] ${failure.rel}${failure.error ? ` :: ${failure.error}` : ''}`);
      }
    }
    break;
  }
  case 'index': {
    const mode = flags.get('rebuild') === true ? 'rebuild' : 'now';
    const started = Date.now();
    const summary = await kb.sync(mode);
    console.log(`同步完成（${mode}），耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(JSON.stringify({
      scanned: summary.scanned,
      added: summary.added,
      updated: summary.updated,
      removed: summary.removed,
      skipped: summary.skipped,
      failed: summary.failed,
      ocrFiles: summary.ocrFiles,
      ocrPages: summary.ocrPages,
      wordFiles: summary.wordFiles,
      chars: summary.chars,
    }, null, 2));
    if (summary.errors.length > 0) {
      console.log('\n问题清单：');
      for (const error of summary.errors.slice(0, 40)) console.log(`  - ${error}`);
    }
    const stats = kb.status().stats;
    console.log(`\n库内：文档 ${stats.docs}，块 ${stats.chunks}，字符 ${stats.chars}`);
    break;
  }
  case 'search': {
    const query = positional.join(' ').trim();
    if (query.length === 0) throw new Error('用法：node lib/cli.mjs search "关键词"');
    const limit = Number(flags.get('limit') ?? 8);
    const dir = typeof flags.get('dir') === 'string' ? flags.get('dir') : undefined;
    printHits(kb.search(query, { limit, dir }));
    break;
  }
  case 'read': {
    const doc = positional.join(' ').trim();
    if (doc.length === 0) throw new Error('用法：node lib/cli.mjs read "<相对路径或文件名>"');
    const result = kb.read({
      doc,
      offset: Number(flags.get('offset') ?? 0),
      limit: Number(flags.get('limit') ?? 4000),
    });
    if (result.found !== true) {
      console.log(result.message);
      break;
    }
    console.log(`${result.rel}（${result.status} / ${result.textSource} / 共 ${result.chars} 字${result.pages ? ` / ${result.pages} 页` : ''}）`);
    if (result.message) console.log(result.message);
    console.log('');
    console.log(result.text ?? '');
    break;
  }
  case 'list': {
    const result = kb.list({
      dir: positional.join(' ').trim(),
      depth: Number(flags.get('depth') ?? 1),
      filter: typeof flags.get('filter') === 'string' ? flags.get('filter') : '',
    });
    console.log(`目录：/${result.dir}`);
    for (const item of result.dirs) console.log(`  [目录] ${item.dir}（${item.files} 文件 / ${item.chars} 字）`);
    for (const file of result.files) {
      console.log(`  [文件] ${file.rel}  ${formatBytes(file.size)}  ${file.status}${file.chars ? `  ${file.chars}字` : ''}${file.error ? `  :: ${file.error}` : ''}`);
    }
    break;
  }
  default:
    console.log('可用命令：status | probe | index [--rebuild] [--root 目录] | search "关键词" | read "文件" | list [目录]');
}

kb.dispose();
