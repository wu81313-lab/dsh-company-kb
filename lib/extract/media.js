// Office 文档内嵌图片落盘：交给 OCR，让"图里的字"也能被检索到。
//
// 两个场景：
//  1) 整篇没有正文的文档（纯截图/架构图）—— 图片是唯一内容来源；
//  2) 有正文但图很多的方案书 / 投标文件 —— 架构图标签、界面截图、表格截图里的字
//     本来完全搜不到（实测本地语料 35 个文件里共 1617 张图）。
// 图片写到临时目录，本次同步结束前删除；知识库目录始终只读。

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from './zip.js';

/** 各 Office 格式的图片目录。 */
const MEDIA_DIRS = {
  '.docx': /^word\/media\/[^/]+$/iu,
  '.docm': /^word\/media\/[^/]+$/iu,
  '.pptx': /^ppt\/media\/[^/]+$/iu,
  '.xlsx': /^xl\/media\/[^/]+$/iu,
  '.xlsm': /^xl\/media\/[^/]+$/iu,
};

/** OCR 引擎能直接吃的格式（emf/wmf 等矢量图先跳过）。 */
const OCRABLE = /\.(png|jpe?g|bmp|tiff?)$/iu;

/**
 * 抽取内嵌图片到临时目录。
 * @param {string} path 文档路径
 * @param {string} ext 扩展名（小写含点）
 * @param {object} options
 * @param {number} options.maxCount 单文件最多取多少张（默认 40）
 * @param {number} options.minBytes 小于这个字节数的图跳过（默认 20KB，挡掉 logo/图标）
 * @param {number} options.maxBytes 单张超过这个字节数跳过（默认 12MB）
 * @returns {{ dir: string, files: Array<{entry:string,path:string,sha1:string,bytes:number}>,
 *            skippedSmall:number, skippedLarge:number, skippedCount:number, cleanup:()=>void }}
 */
export function extractEmbeddedImages(path, ext, { maxCount = 40, minBytes = 20 * 1024, maxBytes = 12 * 1024 * 1024 } = {}) {
  const pattern = MEDIA_DIRS[String(ext ?? '').toLowerCase()];
  const dir = mkdtempSync(join(tmpdir(), 'dsh-company-kb-media-'));
  const files = [];
  let skippedSmall = 0;
  let skippedLarge = 0;
  let skippedCount = 0;

  function cleanup() {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无关紧要 */ }
  }

  if (pattern === undefined) return { dir, files, skippedSmall, skippedLarge, skippedCount, cleanup };

  try {
    const zip = readZip(readFileSync(path));
    mkdirSync(dir, { recursive: true });
    for (const name of zip.names().filter(item => pattern.test(item) && OCRABLE.test(item))) {
      const entry = zip.entries.get(name);
      const size = entry === undefined ? 0 : entry.uncompressedSize;
      if (size < minBytes) {
        skippedSmall += 1;
        continue;
      }
      if (size > maxBytes) {
        skippedLarge += 1;
        continue;
      }
      if (files.length >= maxCount) {
        skippedCount += 1;
        continue;
      }
      const data = zip.read(name);
      if (data === undefined) continue;
      const sha1 = createHash('sha1').update(data).digest('hex');
      const target = join(dir, `${files.length}${name.slice(name.lastIndexOf('.'))}`);
      writeFileSync(target, data);
      files.push({ entry: name, path: target, sha1, bytes: data.length });
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return { dir, files, skippedSmall, skippedLarge, skippedCount, cleanup };
}

/** 兼容旧名字：只取图片、不设体积门槛（纯图片文档用）。 */
export function extractDocxImages(path, { maxCount = 12, maxBytes = 8 * 1024 * 1024 } = {}) {
  return extractEmbeddedImages(path, '.docx', { maxCount, minBytes: 0, maxBytes });
}
