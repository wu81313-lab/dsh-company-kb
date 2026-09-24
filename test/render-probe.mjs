// 诊断脚本：把真实语料里的 Office 文件渲染成 HTML，检查还原效果。
//
//   node test/render-probe.mjs                 # 从索引里各挑几个 docx/xlsx/pptx
//   node test/render-probe.mjs <文件路径>...    # 只跑指定文件
//   node test/render-probe.mjs --save          # 同时把 HTML 写到 %TEMP%\kb-render\ 便于肉眼看
//
// 只看统计与告警：未转义的脚本、空白渲染、段落数异常等。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { renderDocumentHtml, PREVIEW_EXTS } from '../lib/render/index.js';

const DB = process.env.DSH_LOCAL_KB_DB ?? join(process.env.USERPROFILE ?? '', '.dsh', 'company-kb', 'index.sqlite');
const args = process.argv.slice(2);
const save = args.includes('--save');
const explicit = args.filter(item => !item.startsWith('--'));

async function pickFromIndex() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = [];
  for (const ext of ['.docx', '.xlsx', '.pptx']) {
    const items = db.prepare('SELECT path, rel, ext FROM docs WHERE ext = ? AND status = ? ORDER BY chars DESC LIMIT 2').all(ext, 'indexed');
    rows.push(...items);
  }
  db.close();
  return rows;
}

const targets = explicit.length > 0
  ? explicit.map(path => ({ path, rel: basename(path), ext: path.slice(path.lastIndexOf('.')) }))
  : await pickFromIndex();

const outDir = join(tmpdir(), 'kb-render');
if (save) mkdirSync(outDir, { recursive: true });

for (const item of targets) {
  const ext = String(item.ext ?? '').toLowerCase();
  if (!PREVIEW_EXTS.has(ext)) {
    console.log(`[skip] ${item.rel}（不支持预览 ${ext}）`);
    continue;
  }
  const started = Date.now();
  try {
    const buffer = readFileSync(item.path);
    const { html, stats } = renderDocumentHtml({ buffer, ext, rel: item.rel, mediaBase: '/company-kb-api/media' });
    const warnings = [];
    if (/<script/iu.test(html)) warnings.push('HTML 里出现 <script>（应为纯文本，需检查转义）');
    const detail = ext === '.docx'
      ? `段落 ${String(stats.paragraphs).padStart(5)}，表格 ${String(stats.tables).padStart(3)}`
      : (ext === '.pptx' ? `幻灯片 ${String(stats.slides).padStart(4)}` : `工作表 ${String(stats.sheets).padStart(2)}，非空行 ${String(stats.rows).padStart(5)}`);
    if (ext === '.docx' && stats.paragraphs === 0) warnings.push('没有渲染出任何段落');
    if (ext === '.xlsx' && stats.rows === 0) warnings.push('没有渲染出任何单元格');
    if (ext === '.pptx' && stats.slides === 0) warnings.push('没有渲染出任何幻灯片');
    console.log(`[ok] ${ext.padEnd(6)} ${String(Math.round(buffer.length / 1024)).padStart(6)}KB -> `
      + `HTML ${String(Math.round(html.length / 1024)).padStart(5)}KB，${detail}，图片 ${String((html.match(/<img\b/gu) ?? []).length).padStart(3)}，`
      + `${String(Date.now() - started).padStart(5)}ms  ${item.rel}`);
    for (const warning of warnings) console.log(`      ⚠ ${warning}`);
    if (save) {
      const name = basename(item.path).replace(/[^\w.\u4e00-\u9fa5-]/gu, '_');
      const file = join(outDir, `${name}.html`);
      writeFileSync(file, html, 'utf8');
      console.log(`      已写出 ${file}`);
    }
  } catch (error) {
    console.log(`[err] ${item.rel} :: ${error.message}`);
  }
}
