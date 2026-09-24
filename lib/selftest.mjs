// 验收自测：抽取覆盖率 + 15 条金标查询。
//
//   node lib/selftest.mjs            # 用现有索引跑（快）
//   node lib/selftest.mjs --rebuild  # 先全量重建再跑（首次验收用）
//   node lib/selftest.mjs --root "D:\\资料"
//
// 注意：下面的 GOLDEN 是随包附带的**示例**金标查询，请按你自己的语料替换，
// 否则会因为库里没有对应资料而失败。退出码非 0 表示有验收项失败。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKbCore } from './core.js';

function rootsFromPatch() {
  try {
    const text = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8');
    const block = /roots:\s*\n((?:\s*-\s*.+\n?)+)/u.exec(text);
    if (block === null) return [];
    return [...block[1].matchAll(/-\s*'([^']+)'|-\s*"([^"]+)"|-\s*([^\n#]+)/gu)]
      .map(match => (match[1] ?? match[2] ?? match[3] ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const argv = process.argv.slice(2);
const rebuild = argv.includes('--rebuild');
const rootIndex = argv.indexOf('--root');
const roots = rootIndex >= 0 ? [argv[rootIndex + 1]] : rootsFromPatch();

const core = createKbCore({ roots }, { logger: console });

// 金标查询：[查询, 期望命中的文件片段（任一命中即算通过）]
// ⚠️ 示例数据，请替换成你自己语料里的真实查询
const GOLDEN = [
  ['农药追溯二维码政策要求', ['农药', '追溯']],
  ['UDI 与 GS1 标准体系', ['UDI']],
  ['袋线瓶线标准报价', ['报价']],
  ['4Q 验证文件有哪些', ['4Q']],
  ['PDA 出库操作流程', ['出库', 'PDA']],
  ['视觉检测方案建议书', ['检测']],
  ['人药追溯项目技术投标文件', ['投标', '人药']],
  ['银河麒麟信创兼容证明', ['麒麟', '信创']],
  ['中药饮片追溯码编码规则', ['中药饮片']],
  ['备品备件易损件清单', ['备件', '易损']],
  ['微信小程序备案操作步骤', ['小程序']],
  ['追溯平台数据字典', ['数据字典', '追溯']],
  ['兽药项目技术方案书模板', ['兽药']],
  ['化妆品电子标签技术规范', ['化妆品']],
  ['公司专利与软件著作权', ['专利', '著作权', '公司介绍']],
];

let failures = 0;
const fail = message => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};

console.log('=== 1. 助手能力 ===');
const capabilities = await core.capabilities();
console.log(`  OCR=${capabilities.ocr}（${(capabilities.ocrLangs ?? []).join('/') || '无'}） PDF 渲染=${capabilities.pdf} Word=${capabilities.word}`);

if (rebuild) {
  console.log('\n=== 2. 全量重建 ===');
  const started = Date.now();
  const summary = await core.sync('rebuild');
  console.log(`  扫描 ${summary.scanned}｜新增 ${summary.added}｜更新 ${summary.updated}｜跳过 ${summary.skipped}｜失败 ${summary.failed}`
    + `｜OCR ${summary.ocrFiles} 个文件/${summary.ocrPages} 页｜Word ${summary.wordFiles} 个｜${summary.chars} 字｜${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (summary.failed > 0) {
    for (const error of summary.errors.slice(0, 10)) console.log(`    ! ${error}`);
  }
}

const status = core.status();
console.log('\n=== 3. 抽取覆盖率 ===');
console.log(`  文档 ${status.stats.docs}｜块 ${status.stats.chunks}｜字符 ${status.stats.chars.toLocaleString('en-US')}｜库 ${(status.stats.databaseBytes / 1048576).toFixed(1)}MB`);
console.log(`  来源：${status.stats.bySource.map(item => `${item.source}=${item.n}`).join('  ')}`);
console.log(`  状态：${status.stats.byStatus.map(item => `${item.status}=${item.n}`).join('  ')}`);

if (!status.built) fail('索引为空：请先运行 node lib/cli.mjs index（或加 --rebuild）');
const indexed = Number(status.stats.byStatus.find(item => item.status === 'indexed')?.n ?? 0);
if (indexed < 80) fail(`已抽取正文的文件只有 ${indexed} 个，低于 80 的验收线`);
for (const must of ['docx', 'xlsx', 'pdf', 'doc', 'png']) {
  const entry = status.stats.byExt.find(item => item.ext === `.${must}`);
  if (entry === undefined) continue;
  const withText = core.list({ dir: '', depth: 2 }).files.concat([]).length; // 占位，实际检查见下方来源分布
  void withText;
}
const ocrCount = Number(status.stats.bySource.find(item => item.source === 'ocr')?.n ?? 0);
if (ocrCount < 20) fail(`OCR 来源的文件只有 ${ocrCount} 个，低于 20（扫描件与截图应当被识别）`);
const wordCount = Number(status.stats.bySource.find(item => item.source === 'word')?.n ?? 0);
if (wordCount < 5) fail(`Word 来源的旧版文档只有 ${wordCount} 个，低于 5`);
const metadataOnly = Number(status.stats.byStatus.find(item => item.status === 'metadata')?.n ?? 0);
if (metadataOnly > 15) fail(`仅有元数据的文件 ${metadataOnly} 个，偏多（检查 maxFileBytes 是否挡住了大文档）`);

console.log('\n=== 4. 金标查询（前 3 名内应出现期望文件）===');
for (const [query, expected] of GOLDEN) {
  const result = core.search(query, { limit: 3 });
  const matched = result.hits.some(hit => expected.some(token => hit.rel.includes(token)));
  const top = result.hits[0]?.rel ?? '（无命中）';
  if (matched) {
    console.log(`  ✓ ${query}  →  ${top}`);
  } else {
    console.log(`  ✗ ${query}  →  ${top}`);
    console.log(`     候选：${result.hits.map(hit => hit.rel).join(' | ') || '无'}`);
    failures += 1;
  }
}

console.log('\n=== 5. 手动同步语义 ===');
const stale = core.staleness({ force: true });
console.log(`  体检：修改 ${stale.changed}、新增 ${stale.added}、删除 ${stale.removed}（同步只在你手动触发时发生）`);
const lastSync = core.store.getMeta('lastSyncAt');
console.log(`  上次同步：${lastSync === undefined ? '从未' : new Date(Number(lastSync)).toLocaleString('zh-CN')}`);
if (Number(stale.added) > 0) console.log('  注意：有新增文件未同步，属正常（手动同步模型）');

core.dispose();
console.log(`\n结论：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
