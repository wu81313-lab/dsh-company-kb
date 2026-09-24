// 按扩展名分派抽取：能本地解析的直接解析，需要外部能力的返回 needs 标记。
//
// needs 的三种取值：
//   'ocr'   → pdf / 图片，交给 Windows 内置 OCR（lib/ocr.js）
//   'word'  → 旧版 .doc，交给 Word COM（仅当 legacyDoc === 'word-com'）
//   null    → 已在本地解析完成
// 只登记元数据的二进制文件返回 kind='binary'。

import { readFileSync } from 'node:fs';
import { extractDocx } from './docx.js';
import { extractXlsx } from './xlsx.js';
import { extractPptx } from './pptx.js';
import { extractTextFile } from './text.js';
import { blocksToText, textToBlocks } from '../chunk.js';

export const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.log', '.yml', '.yaml', '.xml', '.ini', '.conf']);
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']);
export const BINARY_EXTS = new Set(['.dwg', '.dxf', '.apk', '.zip', '.rar', '.7z', '.exe', '.dll', '.msi', '.mp4', '.mp3', '.wav', '.sldprt', '.sldasm', '.slddrw', '.step', '.stp', '.igs']);

export function kindOf(ext) {
  const lower = String(ext ?? '').toLowerCase();
  if (lower === '.docx' || lower === '.docm') return 'docx';
  if (lower === '.xlsx' || lower === '.xlsm') return 'xlsx';
  if (lower === '.pptx') return 'pptx';
  if (lower === '.doc') return 'legacy-doc';
  if (lower === '.xls') return 'legacy-xls';
  if (lower === '.pdf') return 'pdf';
  if (IMAGE_EXTS.has(lower)) return 'image';
  if (TEXT_EXTS.has(lower)) return 'text';
  if (BINARY_EXTS.has(lower)) return 'binary';
  return 'binary';
}

/**
 * 本地可解析的部分。返回 { blocks, text, meta, needs }。
 * needs 非空时 blocks/text 为空，调用方去走 OCR / Word COM。
 */
export function extractLocal({ kind, path }) {
  if (kind === 'docx') {
    const result = extractDocx(readFileSync(path));
    return { blocks: result.blocks, text: blocksToText(result.blocks), meta: result.meta, needs: null };
  }
  if (kind === 'xlsx') {
    const result = extractXlsx(readFileSync(path));
    return { blocks: result.blocks, text: blocksToText(result.blocks), meta: result.meta, needs: null };
  }
  if (kind === 'pptx') {
    const result = extractPptx(readFileSync(path));
    return { blocks: result.blocks, text: blocksToText(result.blocks), meta: result.meta, needs: null };
  }
  if (kind === 'text') {
    const result = extractTextFile(path);
    const blocks = textToBlocks(result.rawText);
    return { blocks, text: result.rawText, meta: result.meta, needs: null };
  }
  if (kind === 'pdf') return { blocks: [], text: '', meta: {}, needs: 'ocr' };
  if (kind === 'image') return { blocks: [], text: '', meta: {}, needs: 'ocr' };
  if (kind === 'legacy-doc') return { blocks: [], text: '', meta: {}, needs: 'word' };
  if (kind === 'legacy-xls') return { blocks: [], text: '', meta: {}, needs: 'word' };
  return { blocks: [], text: '', meta: {}, needs: null };
}
