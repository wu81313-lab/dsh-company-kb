// xlsx 抽取：sharedStrings + 各 sheet 的单元格值；表名作为标题块。

import { readZip, decodeXml } from './zip.js';

/** 渲染器复用：共享字符串表与工作表顺序。 */
export function sharedStrings(zip) {
  if (!zip.has('xl/sharedStrings.xml')) return [];
  const xml = zip.readText('xl/sharedStrings.xml') ?? '';
  const out = [];
  for (const si of xml.split(/<si\b[^>]*>/u).slice(1)) {
    const text = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');
    out.push(text);
  }
  return out;
}

export function sheetOrder(zip) {
  const workbook = zip.readText('xl/workbook.xml') ?? '';
  const rels = zip.readText('xl/_rels/workbook.xml.rels') ?? '';
  const relMap = new Map();
  for (const match of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/gu)) {
    relMap.set(match[1], match[2].replace(/^\/?xl\//u, '').replace(/^\//u, ''));
  }
  const sheets = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/gu)) {
    const tag = match[0];
    const name = decodeXml(/name="([^"]*)"/u.exec(tag)?.[1] ?? '');
    const relId = /r:id="([^"]+)"/u.exec(tag)?.[1];
    let target = relId === undefined ? undefined : relMap.get(relId);
    if (target === undefined) continue;
    sheets.push({ name, path: target.startsWith('xl/') ? target : `xl/${target}` });
  }
  return sheets;
}

function cellValue(cellXml, strings) {
  const type = /t="([^"]*)"/u.exec(cellXml)?.[1] ?? 'n';
  if (type === 'inlineStr') {
    return [...cellXml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');
  }
  const raw = /<v>([\s\S]*?)<\/v>/u.exec(cellXml)?.[1];
  if (raw === undefined) return '';
  if (type === 's') {
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < strings.length ? strings[index] : '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return decodeXml(raw);
}

export function extractXlsx(buffer) {
  const zip = readZip(buffer);
  const strings = sharedStrings(zip);
  const sheets = sheetOrder(zip);
  const blocks = [];
  const warnings = [];
  let rows = 0;

  const fallbackSheets = zip.names().filter(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  const targets = sheets.length > 0 ? sheets : fallbackSheets.map(path => ({ name: path.replace(/^xl\/worksheets\//u, '').replace(/\.xml$/u, ''), path }));

  for (const sheet of targets) {
    if (!zip.has(sheet.path)) continue;
    const xml = zip.readText(sheet.path) ?? '';
    blocks.push({ kind: 'heading', level: 2, text: `工作表：${sheet.name}` });
    for (const rowXml of xml.split(/<row\b[^>]*>/u).slice(1)) {
      const values = [];
      for (const cellXml of rowXml.split(/<c\b[^>]*>/u).slice(1)) {
        const value = cellValue(cellXml, strings).replace(/\s+/gu, ' ').trim();
        if (value.length > 0) values.push(value);
      }
      if (values.length === 0) continue;
      rows += 1;
      blocks.push({ kind: 'para', text: values.join(' | ') });
    }
  }

  if (rows === 0) warnings.push('xlsx 未解析出任何单元格文本');
  return { blocks, meta: { sheets: targets.length, rows, warnings } };
}
