// docx 抽取：按文档顺序扫描 word/document.xml 的段落与表格，并附带页眉页脚/脚注。
//
// 标题识别注意：WPS 生成的文档里 <w:pStyle w:val="00000a"/> 是内部数字 ID，不是
// "Heading1"。所以这里同时用 w:outlineLvl、w:val 里的 Heading/标题字样，以及正文
// 文本模式（"一、"、"（一）"、"1.1"）三种线索。

import { readZip, decodeXml } from './zip.js';

const HEADING_TEXT = /^\s*(第[一二三四五六七八九十百]+[章节部分篇]|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\)|\d+(?:\.\d+){0,3}[、.．\s])/u;

// 元素名后必须跟边界字符，否则 "<w:p" 会命中 "<w:pPr / <w:pStyle / <w:pict"。
// 这个坑曾让一份 6 千多个 <w:t> 的接口文档整篇被当成一个段落而抽不出文本。
const ELEMENT_BOUNDARY = new Set(['>', ' ', '/', '\t', '\n', '\r']);

function indexOfElementStart(xml, name, from) {
  const token = `<${name}`;
  let at = xml.indexOf(token, from);
  while (at !== -1) {
    if (ELEMENT_BOUNDARY.has(xml[at + token.length])) return at;
    at = xml.indexOf(token, at + token.length);
  }
  return -1;
}

/** 用配对计数找出同名元素的结束位置（表格可能嵌套）。 */
function findElementEnd(xml, name, from) {
  const endToken = `</${name}>`;
  let depth = 0;
  let cursor = from;
  while (cursor < xml.length) {
    const open = indexOfElementStart(xml, name, cursor);
    const close = xml.indexOf(endToken, cursor);
    if (close === -1) return -1;
    if (open !== -1 && open < close) {
      depth += 1;
      cursor = open + name.length + 1;
      continue;
    }
    depth -= 1;
    cursor = close + endToken.length;
    if (depth <= 0) return close;
  }
  return -1;
}

function paragraphText(xml) {
  let out = '';
  const parts = xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g);
  for (const part of parts) {
    if (part[1] !== undefined) out += decodeXml(part[1]);
    else if (part[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out.replace(/\s+$/u, '');
}

function paragraphLevel(xml) {
  const style = /<w:pStyle[^>]*w:val="([^"]*)"/u.exec(xml)?.[1] ?? '';
  const outline = /<w:outlineLvl[^>]*w:val="(\d+)"/u.exec(xml)?.[1];
  if (outline !== undefined) return Math.min(6, Number(outline) + 1);
  const heading = /(?:Heading|heading|标题)\s*([1-6])/u.exec(style);
  if (heading !== null) return Number(heading[1]);
  return 0;
}

function tableRows(xml) {
  const rows = [];
  for (const rowXml of xml.split(/<w:tr\b[^>]*>/u).slice(1)) {
    const cells = [];
    for (const cellXml of rowXml.split(/<w:tc\b[^>]*>/u).slice(1)) {
      const cellText = [...cellXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map(match => decodeXml(match[1]))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
      cells.push(cellText);
    }
    const line = cells.join(' | ').trim();
    if (line.replace(/[|\s]/gu, '').length > 0) rows.push(line);
  }
  return rows;
}

function parseBody(xml, blocks) {
  let index = 0;
  while (index < xml.length) {
    const nextTable = indexOfElementStart(xml, 'w:tbl', index);
    const nextPara = indexOfElementStart(xml, 'w:p', index);
    const candidates = [nextTable, nextPara].filter(value => value >= 0);
    if (candidates.length === 0) break;
    const at = Math.min(...candidates);

    if (at === nextTable && (nextPara === -1 || nextTable < nextPara)) {
      const end = findElementEnd(xml, 'w:tbl', at);
      const slice = xml.slice(at, end === -1 ? xml.length : end);
      for (const row of tableRows(slice)) blocks.push({ kind: 'para', text: row });
      index = end === -1 ? xml.length : end + 8;
      continue;
    }

    // 段落可能嵌套（文本框内的 <w:p> 藏在 run 里），所以要配平 <w:p ...> 与 </w:p>
    let cursor = at;
    let depth = 0;
    let end = -1;
    while (cursor < xml.length) {
      const open = indexOfElementStart(xml, 'w:p', cursor);
      const close = xml.indexOf('</w:p>', cursor);
      if (close === -1) break;
      if (open !== -1 && open < close) {
        depth += 1;
        cursor = open + 4;
        continue;
      }
      depth -= 1;
      cursor = close + 6;
      if (depth <= 0) {
        end = close;
        break;
      }
    }
    const slice = xml.slice(at, end === -1 ? xml.length : end);
    const text = paragraphText(slice).trim();
    if (text.length > 0) {
      const level = paragraphLevel(slice);
      const finalLevel = level > 0 ? level : (HEADING_TEXT.test(text) && text.length <= 80 ? 2 : 0);
      blocks.push(finalLevel > 0
        ? { kind: 'heading', level: finalLevel, text }
        : { kind: 'para', text });
    }
    index = end === -1 ? xml.length : end + 6;
  }
}

export function extractDocx(buffer) {
  const zip = readZip(buffer);
  const blocks = [];
  const warnings = [];

  const document = zip.readText('word/document.xml');
  if (document === undefined) throw new Error('docx 缺少 word/document.xml');
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/u.exec(document)?.[1] ?? document;
  parseBody(body, blocks);

  for (const name of zip.names()) {
    if (!/^word\/(header|footer)\d*\.xml$/u.test(name)) continue;
    const xml = zip.readText(name);
    if (xml === undefined) continue;
    for (const match of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)) {
      const text = paragraphText(match[0]).trim();
      if (text.length > 0) blocks.push({ kind: 'para', text });
    }
  }

  for (const name of ['word/footnotes.xml', 'word/endnotes.xml']) {
    if (!zip.has(name)) continue;
    const xml = zip.readText(name) ?? '';
    for (const match of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gu)) {
      const text = paragraphText(match[0]).trim();
      if (text.length > 0) blocks.push({ kind: 'para', text });
    }
  }

  if (blocks.length === 0) warnings.push('docx 未解析出任何文本（可能是纯图片文档）');
  return {
    blocks,
    meta: {
      paragraphs: blocks.length,
      tables: blocks.filter(block => block.text.includes(' | ')).length,
      entries: zip.entries.size,
      warnings,
    },
  };
}
