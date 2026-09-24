// 文档预览总入口：按扩展名分派到 docx / xlsx / pptx 渲染器，并套上 HTML 外壳。
//
// 设计取舍：全部在本地解析、零第三方依赖、不启动 Office 进程、不写临时文件。
// 渲染结果放在 iframe 里（沙箱化），所以这里的 CSS 只服务"看文档"这一件事：
// 跟随深浅色、表格可滚动、打印不裁切。

import { renderDocxHtml } from './docx.js';
import { renderXlsxHtml } from './xlsx.js';
import { renderPptxHtml } from './pptx.js';

export const PREVIEW_EXTS = new Set(['.docx', '.xlsx', '.xlsm', '.pptx']);

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:18px 20px 40px;background:#fff;color:#1c1c1e;
  font:14px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;word-break:break-word}
h1,h2,h3,h4,h5,h6{margin:1.4em 0 .5em;line-height:1.4;font-weight:600}
h2{font-size:19px}h3{font-size:16.5px}h4{font-size:15px}h5,h6{font-size:14px}
p{margin:.45em 0}
ul,ol{margin:.5em 0 .5em 1.4em;padding:0}
li{margin:.2em 0}
a{color:#0a6cff;text-decoration:none}
a:hover{text-decoration:underline}
strong{font-weight:600}
img.pic{display:block;margin:.6em 0;border-radius:6px}
figure{margin:.8em 0}
figure img{max-width:100%;border-radius:8px;border:1px solid rgba(0,0,0,.08)}
table.tbl{border-collapse:collapse;margin:.9em 0;font-size:13px;width:auto;max-width:100%}
table.tbl th,table.tbl td{border:1px solid #d8d8dc;padding:5px 9px;vertical-align:top}
table.tbl th{background:#f5f5f7;font-weight:600;text-align:left}
table.tbl td p,table.tbl th p{margin:0}
td.merged{background:#fafafa}
.t{display:inline-block;width:1.6em}
.pagebreak{border:none;border-top:1px dashed #c8c8cc;margin:1.6em 0}
.notes{margin-top:2.4em;padding-top:1em;border-top:1px solid #e6e6ea}
.notes h3{font-size:13px;color:#8a8a8e;margin:0 0 .4em}
.note{font-size:12.5px;color:#8a8a8e;margin:.35em 0}
.note-tag{display:inline-block;margin-right:.5em;padding:0 6px;border-radius:5px;background:#f0f0f3;font-size:11px}

.sheet{margin:0 0 2.2em}
.sheet h2{position:sticky;top:0;z-index:2;margin:0 0 .5em;padding:6px 0;background:#fff;font-size:15px}
.grid-wrap{overflow:auto;max-height:70vh;border:1px solid #e0e0e4;border-radius:8px}
table.grid{border-collapse:separate;border-spacing:0;font-size:13px;font-variant-numeric:tabular-nums}
table.grid th,table.grid td{border-right:1px solid #eaeaea;border-bottom:1px solid #eaeaea;padding:4px 8px;white-space:pre-wrap;vertical-align:top}
table.grid thead th{position:sticky;top:0;background:#f5f5f7;font-weight:500;color:#6a6a6e;text-align:center;min-width:34px}
table.grid th.rn{position:sticky;left:0;background:#f5f5f7;color:#8a8a8e;font-weight:400;text-align:right;min-width:44px}
table.grid td.empty{background:#fcfcfd}

.slide{border:1px solid #e4e4e8;border-radius:12px;padding:14px 16px 16px;margin:0 0 14px}
.slide header{display:flex;align-items:baseline;gap:10px;margin-bottom:.4em}
.slide .no{flex:none;display:inline-flex;align-items:center;justify-content:center;
  min-width:22px;height:22px;padding:0 6px;border-radius:6px;background:#f0f0f3;font-size:12px;color:#6a6a6e}
.slide h2{margin:0;font-size:16px}
.slide ul{margin:.3em 0 .3em 1.2em}

mark.kb-hit{background:#ffe58a;color:inherit;border-radius:3px;padding:0 1px;box-shadow:0 0 0 1px rgba(0,0,0,.06)}
mark.kb-hit:target{background:#ffc53d;outline:2px solid #ffa940}

@media (prefers-color-scheme:dark){
  body{background:#161618;color:#e8e8ea}
  a{color:#6ea8ff}
  table.tbl th,table.tbl td{border-color:#3a3a3e}
  table.tbl th{background:#232327}
  table.grid-wrap,table.grid th,table.grid td{border-color:#33333a}
  .grid-wrap{border-color:#33333a}
  table.grid thead th,table.grid th.rn{background:#232327;color:#9a9a9f}
  table.grid td.empty{background:#1a1a1c}
  .notes{border-color:#33333a}
  .slide{border-color:#33333a}
  .slide .no{background:#232327;color:#9a9a9f}
  mark.kb-hit{background:#7a5c14;color:#fff3bf}
  mark.kb-hit:target{background:#a9770f;outline-color:#e8b339}
}
@media print{
  body{padding:0}
  .grid-wrap{max-height:none;overflow:visible}
  .slide{break-inside:avoid}
}
`;

const escapeHtml = text => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const HIGHLIGHT_MAX = 300;

/** 从查询串里抽出要高亮的词：整串（无分隔符时）+ 按标点/空白切出的片段，长词优先，只保留 2 字以上。 */
export function highlightTerms(query) {
  const raw = String(query ?? '').trim();
  if (raw.length === 0) return [];
  const separator = /[\s,，、;；:：/|\\()（）[\]【】"'“”]+/u;
  const terms = new Set();
  if (raw.length >= 2 && !separator.test(raw)) terms.add(raw);
  for (const part of raw.split(separator)) {
    const trimmed = part.trim();
    if (trimmed.length >= 2) terms.add(trimmed);
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 12);
}

/**
 * 生成高亮函数。**只接受"已经转义过的纯文本"**：调用方必须在拼 HTML 标签之前调用，
 * 这样就不存在"正则命中标签内部、把结构改坏"的可能。
 */
export function createHighlighter(query) {
  const terms = highlightTerms(query).map(term => escapeHtml(term));
  if (terms.length === 0) return { highlight: text => text, terms: [] };
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'gu');
  let count = 0;
  const highlight = text => {
    if (count >= HIGHLIGHT_MAX || typeof text !== 'string' || text.length === 0) return text;
    return text.replace(pattern, match => {
      if (count >= HIGHLIGHT_MAX) return match;
      const id = count === 0 ? ' id="kb-hit-0"' : '';
      count += 1;
      return `<mark class="kb-hit"${id}>${match}</mark>`;
    });
  };
  return { highlight, terms };
}

/**
 * 渲染一个文档为完整 HTML 页面。
 * @param {object} options
 * @param {Buffer} options.buffer 文件内容
 * @param {string} options.ext 扩展名（小写，含点）
 * @param {string} options.rel 相对路径（用于拼图片 URL）
 * @param {string} options.mediaBase 图片接口前缀，例如 /company-kb-api/media
 * @param {string} [options.query] 检索词：命中处会加 <mark id="kb-hit-0">，便于直接滚过去
 */
export function renderDocumentHtml({ buffer, ext, rel, mediaBase, query }) {
  const mediaUrl = name => `${mediaBase}?rel=${encodeURIComponent(rel)}&name=${encodeURIComponent(name)}`;
  const { highlight, terms } = createHighlighter(query ?? '');
  let result;
  if (ext === '.docx') result = renderDocxHtml(buffer, mediaUrl, { highlight });
  else if (ext === '.xlsx' || ext === '.xlsm') result = renderXlsxHtml(buffer, { highlight });
  else if (ext === '.pptx') result = renderPptxHtml(buffer, mediaUrl, { highlight });
  else throw new Error(`暂不支持预览 ${ext} 文件`);

  const summary = ext === '.docx'
    ? `段落 ${result.stats.paragraphs} · 表格 ${result.stats.tables}`
    : (ext === '.pptx' ? `幻灯片 ${result.stats.slides}` : `工作表 ${result.stats.sheets} · 非空行 ${result.stats.rows}`);

  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(rel)}</title><style>${STYLE}</style></head><body>`
    + result.html
    + `<p class="note">由插件解析 ${escapeHtml(ext)} 生成（${summary}）——版式为阅读还原，不是像素级排版；需要原样查看请用「用本机程序打开」。</p>`
    + '</body></html>';
  return { html, stats: result.stats };
}
