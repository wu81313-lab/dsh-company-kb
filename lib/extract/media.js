// docx 内嵌图片落盘：用于"整篇都是截图/架构图"的 docx。
//
// 这类文件正文里一个字都没有（例如《追溯系统整体架构》《标准化系统对接接口文档》），
// 只有图片。把 word/media 下的图片写到临时目录后交给 OCR，就能把它们也纳入检索。
// 临时文件在本次同步结束前删除；知识库目录始终只读。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readZip } from './zip.js';

const IMAGE_ENTRY = /^word\/media\/[^/]+\.(png|jpe?g|bmp|tiff?|gif|emf|wmf)$/iu;
const OCRABLE = /\.(png|jpe?g|bmp|tiff?)$/iu;

/**
 * 抽取 docx 里的可 OCR 图片到临时目录。
 * 返回 { dir, files: [{ entry, path }], skipped }；调用方负责 cleanup()。
 */
export function extractDocxImages(path, { maxCount = 12, maxBytes = 8 * 1024 * 1024 } = {}) {
  const zip = readZip(readFileSync(path));
  const names = zip.names().filter(name => IMAGE_ENTRY.test(name) && OCRABLE.test(name));
  const dir = mkdtempSync(join(tmpdir(), 'dsh-company-kb-media-'));
  const files = [];
  let skipped = 0;
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      if (files.length >= maxCount) {
        skipped += 1;
        continue;
      }
      const entry = zip.entries.get(name);
      if (entry !== undefined && entry.uncompressedSize > maxBytes) {
        skipped += 1;
        continue;
      }
      const data = zip.read(name);
      if (data === undefined) continue;
      const target = join(dir, `${files.length}${name.slice(name.lastIndexOf('.'))}`);
      writeFileSync(target, data);
      files.push({ entry: name, path: target });
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  function cleanup() {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无关紧要 */ }
  }

  return { dir, files, skipped, cleanup };
}
