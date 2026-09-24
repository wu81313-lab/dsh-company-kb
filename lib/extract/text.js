// 纯文本类文件读取（md/txt/csv/json/log…）：带编码探测。
// 中文企业资料里 GB18030 编码的 txt/csv 很常见，直接用 utf8 读会整篇乱码。

import { readFileSync } from 'node:fs';

function decode(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  // 先严格按 UTF-8 解码；失败说明不是 UTF-8，再试 GB18030。
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text, encoding: 'utf-8' };
  } catch {
    for (const candidate of ['gb18030', 'big5']) {
      try {
        const text = new TextDecoder(candidate, { fatal: true }).decode(buffer);
        return { text, encoding: candidate };
      } catch {
        // 继续尝试下一个编码
      }
    }
    return { text: buffer.toString('utf8'), encoding: 'utf-8-lossy' };
  }
}

function clean(text) {
  return text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{4,}/gu, '\n\n\n');
}

export function extractTextFile(path) {
  const buffer = readFileSync(path);
  const { text, encoding } = decode(buffer.subarray(0, 64 * 1024 * 1024));
  const cleaned = clean(text);
  const warnings = [];
  if (encoding === 'utf-8-lossy') warnings.push('编码无法确定，已按 UTF-8 强解，可能有个别乱码');
  return { rawText: cleaned, meta: { encoding, bytes: buffer.byteLength, warnings } };
}
