// docx → 带排版的 HTML（面板内预览用）。
//
// 为什么不用"转 PDF"：那要起一个 Word/WPS 进程（实测 2.5 秒/文件）、写临时文件、
// 还得为偶发卡死做超时隔离，而且本机没装 Office 就完全不可用。docx 本身就是
// ZIP + XML，我们已经能读，直接按结构渲染成 HTML 更快、更稳、还离线。
//
// 还原的内容：标题层级、正文对齐/缩进、加粗/斜体/下划线/删除线/上下标/字号/颜色、
// 项目符号与编号列表、表格（含跨列、表头行）、内嵌图片（按原尺寸）、超链接、
// 分页符、文本框里的段落。
// 明确不还原的：字体度量与分页（不做像素级排版）、艺术字/SmartArt/公式/图表、
// 浮动图片的精确锚点。遇到不认识的元素一律降级成普通文字，不会丢内容。

import { readZip, decodeXml } from '../extract/zip.js';
import { indexOfElementStart, elementRange, headingLevelOf } from '../extract/docx.js';

const escapeHtml = text => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const TWIPS_TO_PX = 1 / 15;   // 1 twip = 1/1440 inch，96dpi 下 1px = 15 twips
const EMU_TO_PX = 1 / 9525;   // 1px = 9525 EMU

function attr(xml, name) {
  const match = new RegExp(`${name}="([^"]*)"`, 'u').exec(xml);
  return match === null ? undefined : match[1];
}

/** 取元素内容（含自身），找不到返回空串。自闭合元素只返回标签本身。 */
function elementAt(xml, name, at) {
  const range = elementRange(xml, name, at);
  return xml.slice(range.start, range.end);
}

/** 段落级属性：对齐、缩进、样式、列表、分页。 */
function paragraphProps(xml) {
  const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/u.exec(xml)?.[1] ?? '';
  const jc = attr(/<w:jc\b[^>]*>/u.exec(pPr)?.[0] ?? '', 'w:val');
  const ind = /<w:ind\b[^>]*>/u.exec(pPr)?.[0] ?? '';
  const left = attr(ind, 'w:left') ?? attr(ind, 'w:start');
  const firstLine = attr(ind, 'w:firstLine');
  const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/u.exec(pPr)?.[1];
  // 注意：值在 w:val 里，不是同名属性 —— <w:numId w:val="1"/>
  const numIdTag = numPr === undefined ? undefined : /<w:numId\b[^>]*>/u.exec(numPr)?.[0];
  const ilvlTag = numPr === undefined ? undefined : /<w:ilvl\b[^>]*>/u.exec(numPr)?.[0];
  const style = attr(/<w:pStyle\b[^>]*>/u.exec(pPr)?.[0] ?? '', 'w:val');
  return {
    align: jc === 'both' ? 'justify' : (jc ?? ''),
    indentLeft: left === undefined ? 0 : Math.round(Number(left) * TWIPS_TO_PX),
    indentFirst: firstLine === undefined ? 0 : Math.round(Number(firstLine) * TWIPS_TO_PX),
    numId: numIdTag === undefined ? undefined : attr(numIdTag, 'w:val'),
    ilvl: ilvlTag === undefined ? 0 : Number(attr(ilvlTag, 'w:val') ?? 0),
    style,
  };
}

/** 单个 run 的字符格式。 */
function runHtml(runXml, ctx) {
  const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/u.exec(runXml)?.[1] ?? '';
  const flag = (tag) => {
    const found = new RegExp(`<w:${tag}\\b[^>]*/?>`, 'u').exec(rPr);
    if (found === null) return false;
    const value = attr(found[0], 'w:val');
    return value === undefined || value === '1' || value === 'true' || value === 'on';
  };

  let text = '';
  const parts = runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/gu);
  for (const part of parts) {
    // 先解码 XML 实体再转义 HTML，否则 &amp; 会被转义成 &amp;amp;
    if (part[1] !== undefined) text += decodeXml(part[1]);
    else if (part[0].startsWith('<w:tab')) text += '\u0009';
    else text += '\n';
  }
  if (text.length === 0) return '';

  // 高亮必须在拼标签之前做：输入是"已转义的纯文本"，不会碰到标签
  let html = ctx.highlight(escapeHtml(text))
    .replaceAll('\u0009', '<span class="t"></span>')
    .replaceAll('\n', '<br>');
  if (flag('b')) html = `<strong>${html}</strong>`;
  if (flag('i')) html = `<em>${html}</em>`;
  if (flag('strike') || flag('dstrike')) html = `<s>${html}</s>`;
  if (flag('u')) html = `<u>${html}</u>`;

  const styles = [];
  const size = attr(/<w:sz\b[^>]*>/u.exec(rPr)?.[0] ?? '', 'w:val');
  if (size !== undefined) styles.push(`font-size:${(Number(size) / 2).toFixed(1)}pt`);
  const color = attr(/<w:color\b[^>]*>/u.exec(rPr)?.[0] ?? '', 'w:val');
  if (color !== undefined && /^[0-9a-fA-F]{6}$/u.test(color) && color.toLowerCase() !== 'auto') styles.push(`color:#${color}`);
  const highlight = attr(/<w:highlight\b[^>]*>/u.exec(rPr)?.[0] ?? '', 'w:val');
  if (highlight !== undefined && highlight !== 'none') styles.push('background:#fff3a3');
  const vert = attr(/<w:vertAlign\b[^>]*>/u.exec(rPr)?.[0] ?? '', 'w:val');
  if (vert === 'superscript') html = `<sup>${html}</sup>`;
  if (vert === 'subscript') html = `<sub>${html}</sub>`;
  if (styles.length > 0) html = `<span style="${styles.join(';')}">${html}</span>`;
  return html;
}

/** 段落里的图片：<w:drawing> 里 a:blip@r:embed，或老式 <w:pict> 的 v:imagedata@r:id。 */
function imagesIn(xml, ctx) {
  const out = [];
  const pattern = /<a:blip\b[^>]*r:embed="([^"]+)"|<v:imagedata\b[^>]*r:id="([^"]+)"/gu;
  for (const match of xml.matchAll(pattern)) {
    const relId = match[1] ?? match[2];
    const target = ctx.rels.get(relId);
    if (target === undefined) continue;
    const extent = /<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/u.exec(xml);
    const width = extent === null ? undefined : Math.round(Number(extent[1]) * EMU_TO_PX);
    // 超宽图按 100% 宽度显示，避免撑破面板
    const style = width === undefined || width > 760 ? 'max-width:100%;height:auto' : `width:${width}px;max-width:100%;height:auto`;
    out.push(`<img class="pic" src="${escapeHtml(ctx.mediaUrl(target))}" style="${style}" alt="">`);
  }
  return out.join('');
}

/** 一段内容（段落 / 表格单元格里的段落）→ HTML。 */
function paragraphHtml(xml, ctx) {
  const props = paragraphProps(xml);
  const inner = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const nextRun = indexOfElementStart(xml, 'w:r', cursor);
    const nextLink = indexOfElementStart(xml, 'w:hyperlink', cursor);
    const candidates = [nextRun, nextLink].filter(value => value >= 0);
    if (candidates.length === 0) break;
    const at = Math.min(...candidates);

    if (at === nextLink && (nextRun === -1 || nextLink < nextRun)) {
      const slice = elementAt(xml, 'w:hyperlink', at);
      const relId = attr(/<w:hyperlink\b[^>]*>/u.exec(slice)?.[0] ?? '', 'r:id');
      const href = relId === undefined ? undefined : ctx.rels.get(relId);
      const label = [...slice.matchAll(/<w:r\b[\s\S]*?<\/w:r>/gu)].map(run => runHtml(run[0], ctx)).join('');
      inner.push(label.length === 0 ? ''
        : (href === undefined ? label : `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`));
      cursor = at + slice.length;
      continue;
    }

    const slice = elementAt(xml, 'w:r', at);
    inner.push(runHtml(slice, ctx));
    cursor = at + slice.length;
  }

  const images = imagesIn(xml, ctx);
  let body = inner.join('') + images;
  if (body.trim().length === 0) return '';

  const level = headingLevelOf(xml, body.replace(/<[^>]+>/gu, ''));
  const styles = [];
  if (props.align === 'center') styles.push('text-align:center');
  else if (props.align === 'right') styles.push('text-align:right');
  else if (props.align === 'justify') styles.push('text-align:justify');
  const padding = props.indentLeft + Math.max(0, props.indentFirst);
  if (padding > 0) styles.push(`padding-left:${padding}px`);
  const styleAttr = styles.length > 0 ? ` style="${styles.join(';')}"` : '';

  if (level > 0) return `<h${Math.min(6, level + 1)}${styleAttr}>${body}</h${Math.min(6, level + 1)}>`;
  return `<p${styleAttr}>${body}</p>`;
}

function tableHtml(xml, ctx) {
  const rows = [];
  let cursor = 0;
  let first = true;
  while (cursor < xml.length) {
    const at = indexOfElementStart(xml, 'w:tr', cursor);
    if (at === -1) break;
    const rowXml = elementAt(xml, 'w:tr', at);
    const cells = [];
    let cellCursor = 0;
    while (cellCursor < rowXml.length) {
      const cellAt = indexOfElementStart(rowXml, 'w:tc', cellCursor);
      if (cellAt === -1) break;
      const cellXml = elementAt(rowXml, 'w:tc', cellAt);
      const span = Number(attr(/<w:gridSpan\b[^>]*>/u.exec(cellXml)?.[0] ?? '', 'w:val') ?? 1);
      const isContinuation = /<w:vMerge\b(?![^>]*w:val="restart")[^>]*\/>/u.test(cellXml);
      const width = attr(/<w:tcW\b[^>]*>/u.exec(cellXml)?.[0] ?? '', 'w:w');
      const content = paragraphsHtml(cellXml, ctx) || '&nbsp;';
      const tag = first ? 'th' : 'td';
      const widthStyle = width === undefined ? '' : ` style="width:${Math.round(Number(width) * TWIPS_TO_PX)}px"`;
      cells.push(isContinuation
        ? `<${tag}${widthStyle} class="merged"></${tag}>`
        : `<${tag}${widthStyle}${span > 1 ? ` colspan="${span}"` : ''}>${content}</${tag}>`);
      cellCursor = cellAt + cellXml.length;
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join('')}</tr>`);
    cursor = at + rowXml.length;
    first = false;
  }
  return rows.length === 0 ? '' : `<table class="tbl">${rows.join('')}</table>`;
}

/** 把容器（body / 单元格 / 文本框）里的段落与表格按顺序渲染出来。 */
function paragraphsHtml(xml, ctx) {
  const out = [];
  let cursor = 0;
  let listType = '';
  let listItems = [];
  const flushList = () => {
    if (listItems.length === 0) return;
    out.push(`<${listType}>${listItems.join('')}</${listType}>`);
    listItems = [];
    listType = '';
  };

  while (cursor < xml.length) {
    const nextTable = indexOfElementStart(xml, 'w:tbl', cursor);
    const nextPara = indexOfElementStart(xml, 'w:p', cursor);
    const candidates = [nextTable, nextPara].filter(value => value >= 0);
    if (candidates.length === 0) break;
    const at = Math.min(...candidates);

    if (at === nextTable && (nextPara === -1 || nextTable < nextPara)) {
      flushList();
      const slice = elementAt(xml, 'w:tbl', at);
      out.push(tableHtml(slice, ctx));
      cursor = at + slice.length;
      continue;
    }

    const slice = elementAt(xml, 'w:p', at);
    const props = paragraphProps(slice);
    const html = paragraphHtml(slice, ctx);
    cursor = at + slice.length;
    if (html.length === 0) continue;

    if (props.numId !== undefined) {
      const kind = ctx.listKind(props.numId) === 'bullet' || props.numId === '0' ? 'ul' : 'ol';
      if (listType !== kind) {
        flushList();
        listType = kind;
      }
      listItems.push(`<li>${html}</li>`);
      continue;
    }
    flushList();
    out.push(html);
  }
  flushList();
  return out.join('');
}

/** word/_rels/document.xml.rels → rId → 目标（图片就是 media/xxx） */
function readRels(zip, part) {
  const rels = new Map();
  // 关系文件名是「部件全名 + .rels」：word/_rels/document.xml.rels
  const xml = zip.readText(`word/_rels/${part}.xml.rels`);
  if (xml === undefined) return rels;
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/gu)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    const mode = attr(match[0], 'TargetMode');
    if (id === undefined || target === undefined || mode === 'External') {
      if (id !== undefined && target !== undefined) rels.set(id, target);
      continue;
    }
    // 目标相对 word/ 目录，统一成 zip 里的条目名
    const clean = target.replace(/^\.\//u, '');
    rels.set(id, clean.startsWith('media/') || clean.startsWith('word/') ? (clean.startsWith('word/') ? clean : `word/${clean}`) : `word/${clean}`);
  }
  return rels;
}

/** numbering.xml → numId → 项目符号/编号 */
function readNumbering(zip) {
  const kinds = new Map();
  const xml = zip.readText('word/numbering.xml');
  if (xml === undefined) return kinds;

  const abstractKinds = new Map();
  let cursor = 0;
  while (cursor < xml.length) {
    const at = indexOfElementStart(xml, 'w:abstractNum', cursor);
    if (at === -1) break;
    const slice = elementAt(xml, 'w:abstractNum', at);
    const id = attr(/<w:abstractNum\b[^>]*>/u.exec(slice)?.[0] ?? '', 'w:abstractNumId');
    const lvl0 = /<w:lvl\b[^>]*w:ilvl="0"[\s\S]*?<\/w:lvl>/u.exec(slice)?.[0] ?? slice;
    const fmt = attr(/<w:numFmt\b[^>]*>/u.exec(lvl0)?.[0] ?? '', 'w:val');
    if (id !== undefined) abstractKinds.set(id, fmt === 'bullet' ? 'bullet' : 'number');
    cursor = at + slice.length;
  }

  cursor = 0;
  while (cursor < xml.length) {
    const at = indexOfElementStart(xml, 'w:num', cursor);
    if (at === -1) break;
    const slice = elementAt(xml, 'w:num', at);
    const numId = attr(/<w:num\b[^>]*>/u.exec(slice)?.[0] ?? '', 'w:numId');
    const abstractId = attr(/<w:abstractNumId\b[^>]*>/u.exec(slice)?.[0] ?? '', 'w:val');
    if (numId !== undefined && abstractId !== undefined) kinds.set(numId, abstractKinds.get(abstractId) ?? 'number');
    cursor = at + slice.length;
  }
  return kinds;
}

/**
 * 渲染 word/document.xml 的正文。
 * @param {Buffer} buffer docx 文件内容
 * @param {(entryName: string) => string} mediaUrl 把 zip 条目名变成可访问的 URL
 */
export function renderDocxHtml(buffer, mediaUrl, { highlight = text => text } = {}) {
  const zip = readZip(buffer);
  const document = zip.readText('word/document.xml');
  if (document === undefined) throw new Error('docx 缺少 word/document.xml');

  const rels = readRels(zip, 'document');
  const numbering = readNumbering(zip);
  const ctx = {
    rels,
    mediaUrl,
    highlight,
    listKind: numId => numbering.get(String(numId)) ?? 'number',
  };

  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/u.exec(document)?.[1] ?? document;
  let html = paragraphsHtml(body, ctx);

  // 页眉页脚按"附注"放在最后：正文里没有它们，但内容不该丢
  const notes = [];
  for (const name of zip.names().filter(item => /^word\/(header|footer)\d*\.xml$/u.test(item)).sort()) {
    const xml = zip.readText(name);
    if (xml === undefined) continue;
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map(match => decodeXml(match[1])).join(' ').trim();
    if (text.length > 0) notes.push(`<p class="note"><span class="note-tag">${name.includes('header') ? '页眉' : '页脚'}</span>${escapeHtml(text)}</p>`);
  }
  if (notes.length > 0) html += `<div class="notes"><h3>页眉 / 页脚</h3>${notes.join('')}</div>`;

  const paragraphs = (html.match(/<(p|h[1-6]|li)\b/gu) ?? []).length;
  const tables = (html.match(/<table\b/gu) ?? []).length;
  return { html, stats: { paragraphs, tables, bytes: buffer.length } };
}
