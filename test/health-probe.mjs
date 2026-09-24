// 体检脚本：量一下索引现状，为优化建议提供依据（只读，不改任何东西）。
//   node test/health-probe.mjs
//
// 输出：
//   1. 文档/分块构成、字数分布、单文件块数
//   2. PDF 里有多少其实带文字层（本可以直读，不必 OCR）
//   3. 分块大小分布（过碎 / 过大）
//   4. 未抽取正文的文件按原因归类
//   5. 分块安全阀与「文档内嵌图片」的覆盖率

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readZip } from '../lib/extract/zip.js';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const DB = process.env.DSH_LOCAL_KB_DB ?? join(process.env.USERPROFILE ?? '', '.dsh', 'company-kb', 'index.sqlite');
const db = new DatabaseSync(DB, { readOnly: true });

const docs = db.prepare('SELECT path, rel, ext, kind, text_source, chars, pages, status FROM docs').all();
console.log(`=== 索引构成（共 ${docs.length} 个文件）===`);
const bySource = new Map();
for (const doc of docs) bySource.set(String(doc.text_source), (bySource.get(String(doc.text_source)) ?? 0) + 1);
for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`  来源 ${source.padEnd(10)} ${count}`);

const byExt = new Map();
for (const doc of docs) byExt.set(String(doc.ext), (byExt.get(String(doc.ext)) ?? 0) + 1);
console.log('  扩展名:', [...byExt].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${ext}×${n}`).join(' '));

const failed = docs.filter(doc => !['indexed'].includes(String(doc.status)));
console.log(`\n=== 未抽取正文 ${failed.length} 个 ===`);
const byStatus = new Map();
for (const doc of failed) byStatus.set(String(doc.status), (byStatus.get(String(doc.status)) ?? 0) + 1);
for (const [status, count] of byStatus) console.log(`  ${status}: ${count}`);

console.log('\n=== 分块情况 ===');
const chunkStats = db.prepare(`
  SELECT COUNT(*) AS chunks, AVG(LENGTH(text)) AS avgChars, MIN(LENGTH(text)) AS minChars, MAX(LENGTH(text)) AS maxChars
  FROM chunks`).get();
console.log(`  分块 ${chunkStats.chunks}，平均 ${Math.round(chunkStats.avgChars)} 字，最小 ${chunkStats.minChars}，最大 ${chunkStats.maxChars}`);

const perDoc = db.prepare('SELECT d.rel AS rel, COUNT(c.id) AS n, SUM(LENGTH(c.text)) AS chars FROM chunks c JOIN docs d ON d.id = c.doc_id GROUP BY c.doc_id ORDER BY n DESC').all();
console.log(`  单文件最多块数: ${perDoc[0]?.n}（${perDoc[0]?.rel}）`);
const single = perDoc.filter(row => row.n === 1).length;
console.log(`  只有 1 块的文件: ${single}`);

const tiny = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE LENGTH(text) < 120').get().n;
const huge = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE LENGTH(text) > 1200').get().n;
console.log(`  过碎（<120 字）: ${tiny}，过大（>1200 字）: ${huge}`);

// PDF 文字层检测：解压前若干条流，看有没有 BT/ET 文本块与字体资源
function hasTextLayer(path) {
  let buffer;
  try { buffer = readFileSync(path); } catch { return null; }
  const head = buffer.subarray(0, Math.min(buffer.length, 4 * 1024 * 1024));
  if (!head.includes(Buffer.from('/Font'))) return false;
  const raw = buffer.toString('latin1');
  let streams = 0;
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    if (streams >= 40) break;
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;
    streams += 1;
    let slice = buffer.subarray(start, end);
    try {
      slice = inflateSync(slice);
    } catch { /* 未压缩的流直接用原文 */ }
    const text = slice.toString('latin1');
    // 出现 Tj/TJ 且里面有可读字符，就认为有文字层
    if (/\bT[Jj]\b/.test(text) && /\([^)]{3,}\)/.test(text)) return true;
  }
  return false;
}

const pdfs = docs.filter(doc => String(doc.ext) === '.pdf');
console.log(`\n=== PDF 文字层检测（${pdfs.length} 个）===`);
let withLayer = 0;
let withoutLayer = 0;
const layerSamples = [];
for (const pdf of pdfs) {
  const result = hasTextLayer(String(pdf.path));
  if (result === true) {
    withLayer += 1;
    if (layerSamples.length < 6) layerSamples.push(String(pdf.rel));
  } else if (result === false) withoutLayer += 1;
}
console.log(`  有文字层（本可直接抽取，现在却走了 OCR）: ${withLayer}`);
console.log(`  没有文字层（必须 OCR）: ${withoutLayer}`);
if (layerSamples.length > 0) {
  console.log('  样例:');
  for (const rel of layerSamples) console.log(`    ${rel}`);
}
console.log('=== 分块安全阀 ===');
for (const limit of [1200, 1800, 2700, 5000]) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE LENGTH(text) > ?').get(limit);
  console.log(`  > ${limit} 字的块: ${row.n}`);
}
const biggest = db.prepare('SELECT d.rel AS rel, c.ord AS ord, LENGTH(c.text) AS chars, SUBSTR(c.text, 1, 60) AS head FROM chunks c JOIN docs d ON d.id = c.doc_id ORDER BY LENGTH(c.text) DESC LIMIT 3').all();
for (const row of biggest) console.log(`  最大块 ${row.chars} 字（${row.rel} #${row.ord}）开头: ${String(row.head).replace(/\s+/g, ' ')}`);

console.log('\n=== 文档内嵌图片（里面的文字默认不进索引）===');
const officeDocs = db.prepare("SELECT path, rel, ext, text_source FROM docs WHERE ext IN ('.docx','.pptx','.xlsx','.docm','.xlsm')").all();
let withImages = 0;
const rows = [];
for (const doc of officeDocs) {
  let buffer;
  try { buffer = readFileSync(String(doc.path)); } catch { continue; }
  let zip;
  try { zip = readZip(buffer); } catch { continue; }
  const media = zip.names().filter(name => /(^word\/media\/|^ppt\/media\/|^xl\/media\/)/u.test(name) && /\.(png|jpe?g|bmp|tiff?|emf|wmf)$/iu.test(name));
  if (media.length === 0) continue;
  withImages += 1;
  rows.push({ rel: String(doc.rel), ext: String(doc.ext), count: media.length, source: String(doc.text_source) });
}
rows.sort((a, b) => b.count - a.count);
console.log(`  含图片的 Office 文件: ${withImages} / ${officeDocs.length}`);
for (const row of rows.slice(0, 9)) {
  console.log(`    ${String(row.count).padStart(4)} 张  ${row.ext.padEnd(7)} 来源=${row.source.padEnd(7)} ${row.rel}`);
}
const native = rows.filter(row => row.source === 'native');
console.log(`  其中"文本来源 native（图片没做 OCR）"的: ${native.length} 个文件，共 ${native.reduce((sum, row) => sum + row.count, 0)} 张图`);

console.log('\n=== 内嵌图片 OCR 工作量（阈值 20KB/张，单文件上限 40 张）===');
{
  let picked = 0;
  let filesWithPicked = 0;
  let tooSmall = 0;
  let overCap = 0;
  for (const doc of officeDocs) {
    let zip;
    try { zip = readZip(readFileSync(String(doc.path))); } catch { continue; }
    let count = 0;
    for (const name of zip.names()) {
      if (!/(^word\/media\/|^ppt\/media\/|^xl\/media\/)/u.test(name) || !/\.(png|jpe?g|bmp|tiff?)$/iu.test(name)) continue;
      const entry = zip.entries.get(name);
      const size = entry === undefined ? 0 : entry.uncompressedSize;
      if (size < 20 * 1024) { tooSmall += 1; continue; }
      if (count >= 40) { overCap += 1; continue; }
      count += 1;
    }
    picked += count;
    if (count > 0) filesWithPicked += 1;
  }
  console.log(`  会送去 OCR：${picked} 张（${filesWithPicked} 个文件）；过小跳过 ${tooSmall} 张；超出单文件上限 ${overCap} 张`);
  console.log(`  首轮约 ${(picked * 0.55 / 60).toFixed(1)} 分钟（0.55s/张为实测均值）；之后重建命中 sha1 缓存，不重复 OCR`);
}
db.close();
