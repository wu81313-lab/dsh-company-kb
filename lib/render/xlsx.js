// xlsx → 真正的表格网格（面板内预览用）。
//
// 比"转 PDF"更合适：表格本来就该能滚动、能选中文字、能一眼看清行列号。
// 渲染内容：多工作表（每个表一节）、行号列标、合并单元格、列宽、数字格式
// （日期/百分比/千分位/小数位）、公式结果值、内联字符串、布尔值。
// 明确不做：图表、条件格式、数据透视、冻结窗格、图片浮动锚点（图片会丢，
// 需要看图请用「用本机程序打开」）。

import { readZip, decodeXml } from '../extract/zip.js';
import { sharedStrings, sheetOrder } from '../extract/xlsx.js';

const MAX_ROWS = 5000;        // 单个工作表最多渲染这么多行
const MAX_COLS = 256;
const MAX_HTML = 4 * 1024 * 1024;

const escapeHtml = text => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

/** Excel 内置的日期/时间格式编号。 */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function readStyles(zip) {
  const xml = zip.readText('xl/styles.xml') ?? '';
  const custom = new Map();
  for (const match of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/gu)) {
    custom.set(Number(match[1]), decodeXml(match[2]));
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(xml)?.[1] ?? '';
  const xfs = [...block.matchAll(/<xf\b[^>]*>/gu)].map(match => Number(/numFmtId="(\d+)"/u.exec(match[0])?.[1] ?? 0));
  return { xfs, custom };
}

/** 判断某个样式索引对应的数字格式：日期 / 百分比 / 小数位与千分位。 */
function numberFormat(styleIndex, styles) {
  const id = styles.xfs[styleIndex] ?? 0;
  const code = styles.custom.get(id);
  if (code === undefined) {
    if (BUILTIN_DATE.has(id)) return { kind: 'date', decimals: 0, time: id >= 18 && id <= 22 || id >= 45 && id <= 47 };
    if (id === 9 || id === 10) return { kind: 'percent', decimals: id === 10 ? 2 : 0 };
    if (id === 3 || id === 4) return { kind: 'number', decimals: 0, group: true };
    return { kind: 'general' };
  }
  // 去掉引号里的字面量与 [颜色] 之类的段，再判断
  const plain = code.replace(/"[^"]*"/gu, '').replace(/\[[^\]]*\]/gu, '').toLowerCase();
  const hasDatePart = /[ymdhs]/u.test(plain) && !/[#0]/u.test(plain.replace(/[ymdhs]/gu, ''));
  if (hasDatePart) return { kind: 'date', decimals: 0, time: /[hs]/u.test(plain) };
  if (plain.includes('%')) {
    const dot = /\.(0+)/u.exec(plain);
    return { kind: 'percent', decimals: dot === null ? 0 : dot[1].length };
  }
  const dot = /\.(0+)/u.exec(plain);
  return { kind: 'number', decimals: dot === null ? 0 : dot[1].length, group: plain.includes(',') };
}

/** Excel 序列号 → 日期。25569 = 1970-01-01 的序列值。 */
function serialToDate(serial, withTime) {
  const ms = Math.round((Number(serial) - 25569) * 86400000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const pad = value => String(value).padStart(2, '0');
  const day = `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  if (!withTime) return day;
  return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatValue(raw, type, format) {
  // 空单元格必须保持空：Number('') === 0，会被日期格式渲染成 1899/12/30
  if (raw === '') return '';
  if (type === 's' || type === 'inlineStr' || type === 'str') return raw;
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (format.kind === 'date') return serialToDate(value, format.time);
  if (format.kind === 'percent') return `${(value * 100).toFixed(format.decimals)}%`;
  if (format.kind === 'number') {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: format.decimals,
      maximumFractionDigits: format.decimals,
      useGrouping: format.group === true,
    });
  }
  return raw;
}

const columnLetters = index => {
  let text = '';
  let value = index;
  do {
    text = String.fromCharCode(65 + (value % 26)) + text;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return text;
};

const columnIndex = letters => {
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
};

function parseSheet(xml, strings, styles) {
  const rows = new Map();
  let maxCol = 0;
  let rowCursor = 0;

  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    const attrs = rowMatch[1] ?? '';
    const declared = /r="(\d+)"/u.exec(attrs)?.[1];
    rowCursor = declared === undefined ? rowCursor + 1 : Number(declared);
    const body = rowMatch[2] ?? '';
    const cells = new Map();
    let colCursor = 0;
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const cellAttrs = cellMatch[1] ?? '';
      const content = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/u.exec(cellAttrs)?.[1];
      const index = ref === undefined ? colCursor : columnIndex(ref);
      colCursor = index + 1;
      const type = /t="([^"]*)"/u.exec(cellAttrs)?.[1] ?? 'n';
      const styleIndex = Number(/s="(\d+)"/u.exec(cellAttrs)?.[1] ?? 0);

      let raw = '';
      if (type === 'inlineStr') {
        raw = [...content.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map(match => decodeXml(match[1])).join('');
      } else {
        const value = /<v>([\s\S]*?)<\/v>/u.exec(content)?.[1];
        if (value !== undefined) {
          raw = type === 's' ? (strings[Number(value)] ?? '') : decodeXml(value);
        }
      }
      const text = type === 's' || type === 'inlineStr' ? raw : formatValue(raw, type, numberFormat(styleIndex, styles));
      cells.set(index, text);
      if (index > maxCol) maxCol = index;
    }
    if (cells.size > 0) rows.set(rowCursor, cells);
  }

  const merges = [];
  for (const match of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/gu)) merges.push(match[1] + ':' + match[2]);

  const widths = new Map();
  for (const match of xml.matchAll(/<col\b[^>]*>/gu)) {
    const min = Number(/min="(\d+)"/u.exec(match[0])?.[1] ?? 0);
    const max = Number(/max="(\d+)"/u.exec(match[0])?.[1] ?? 0);
    const width = Number(/width="([\d.]+)"/u.exec(match[0])?.[1] ?? 0);
    for (let index = min; index <= Math.min(max, MAX_COLS); index += 1) widths.set(index - 1, width);
  }
  return { rows, maxCol, merges, widths };
}

function sheetHtml(sheet, parsed) {
  const { rows, maxCol } = parsed;
  const rowIndexes = [...rows.keys()].sort((a, b) => a - b).slice(0, MAX_ROWS);
  const colCount = Math.min(maxCol + 1, MAX_COLS);

  // 合并单元格：锚点写 span，被覆盖的格子标记跳过
  const spans = new Map();
  const covered = new Set();
  for (const ref of parsed.merges) {
    const [from, to] = ref.split(':');
    const fromCol = columnIndex(from.replace(/\d+/u, ''));
    const fromRow = Number(from.replace(/[A-Z]+/u, ''));
    const toCol = columnIndex(to.replace(/\d+/u, ''));
    const toRow = Number(to.replace(/[A-Z]+/u, ''));
    if (toCol - fromCol + 1 > 1) spans.set(`${fromRow}:${fromCol}`, { colspan: toCol - fromCol + 1 });
    if (toRow - fromRow + 1 > 1) spans.set(`${fromRow}:${fromCol}`, { ...(spans.get(`${fromRow}:${fromCol}`) ?? {}), rowspan: toRow - fromRow + 1 });
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let col = fromCol; col <= toCol; col += 1) {
        if (row === fromRow && col === fromCol) continue;
        covered.add(`${row}:${col}`);
      }
    }
  }

  const head = [`<tr><th class="rn"></th>${Array.from({ length: colCount }, (_v, index) => `<th class="cn">${columnLetters(index)}</th>`).join('')}</tr>`];
  const body = [];
  for (const rowIndex of rowIndexes) {
    const cells = rows.get(rowIndex) ?? new Map();
    const parts = [`<th class="rn">${rowIndex}</th>`];
    for (let col = 0; col < colCount; col += 1) {
      if (covered.has(`${rowIndex}:${col}`)) continue;
      const span = spans.get(`${rowIndex}:${col}`);
      const value = cells.get(col) ?? '';
      const width = parsed.widths.get(col);
      const attrs = [
        span?.colspan ? ` colspan="${span.colspan}"` : '',
        span?.rowspan ? ` rowspan="${span.rowspan}"` : '',
        width === undefined ? '' : ` style="min-width:${Math.max(28, Math.round(width * 7.2))}px"`,
        value === '' ? ' class="empty"' : '',
      ].join('');
      parts.push(`<td${attrs}>${escapeHtml(value)}</td>`);
    }
    body.push(`<tr>${parts.join('')}</tr>`);
  }

  const truncated = rows.size > MAX_ROWS ? `<p class="note">本表共 ${rows.size} 行，这里只渲染前 ${MAX_ROWS} 行。</p>` : '';
  return `<section class="sheet"><h2>${escapeHtml(sheet.name)}</h2>`
    + `<div class="grid-wrap"><table class="grid"><thead>${head.join('')}</thead><tbody>${body.join('')}</tbody></table></div>`
    + truncated + '</section>';
}

export function renderXlsxHtml(buffer) {
  const zip = readZip(buffer);
  const strings = sharedStrings(zip);
  const styles = readStyles(zip);
  const sheets = sheetOrder(zip);
  const fallback = zip.names().filter(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  const targets = sheets.length > 0
    ? sheets
    : fallback.map(path => ({ name: path.replace(/^xl\/worksheets\//u, '').replace(/\.xml$/u, ''), path }));

  const parts = [];
  let html = '';
  let usedRows = 0;
  for (const sheet of targets) {
    if (!zip.has(sheet.path)) continue;
    const xml = zip.readText(sheet.path) ?? '';
    const parsed = parseSheet(xml, strings, styles);
    usedRows += parsed.rows.size;
    const section = sheetHtml(sheet, parsed);
    if (html.length + section.length > MAX_HTML) {
      parts.push('<p class="note">内容过大，其余工作表未渲染（可用「用本机程序打开」查看原文件）。</p>');
      break;
    }
    html += section;
  }

  return { html, stats: { sheets: targets.length, rows: usedRows, bytes: buffer.length } };
}
