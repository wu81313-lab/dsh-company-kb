// 同步引擎：手动触发（面板 / 明确要求 / CLI）才跑；没有任何定时器。
//
// 一次同步 = 扫描 diff → 只处理变化的文件 → 抽取 → 写入索引 → 汇总。
// 每处理完一个文件就提交一次事务（store 内部按文件单事务），所以中途取消、
// 断电、DSH 重启都不会留下半写的块，下次同步自然续做。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chunkBlocks, textToBlocks } from './chunk.js';
import { extractLocal, kindOf } from './extract/index.js';
import { extractDocxImages } from './extract/media.js';

const OCR_BATCH = 40;

function globToRegExp(pattern) {
  const source = String(pattern).replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*\//gu, '\u0000')
    .replace(/\*\*/gu, '\u0001')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '.')
    .replace(/\u0000/gu, '(?:.*/)?')
    .replace(/\u0001/gu, '.*');
  return new RegExp(`^${source}$`, 'u');
}

export function createMatchers(settings) {
  const include = settings.include.map(globToRegExp);
  const excludeGlobs = settings.excludeGlobs.map(globToRegExp);
  const excludeDirs = new Set(settings.excludeDirs.map(item => item.toLowerCase()));
  const isIncluded = rel => include.some(re => re.test(rel));
  const isExcluded = (rel, name) => excludeGlobs.some(re => re.test(rel) || re.test(name));
  const isExcludedDir = name => excludeDirs.has(name.toLowerCase());
  return { isIncluded, isExcluded, isExcludedDir };
}

/** 遍历根目录，返回 { files, errors }。只读，绝不写入。 */
export function walkFiles(roots, settings) {
  const { isExcluded, isExcludedDir } = createMatchers(settings);
  const files = [];
  const errors = [];
  for (const root of roots) {
    const absolute = resolve(root);
    let rootStat;
    try {
      rootStat = statSync(absolute);
    } catch (error) {
      errors.push({ root: absolute, error: error.message });
      continue;
    }
    if (!rootStat.isDirectory()) {
      errors.push({ root: absolute, error: '不是目录' });
      continue;
    }
    const queue = [{ dir: absolute, rel: '' }];
    while (queue.length > 0) {
      const current = queue.shift();
      let entries;
      try {
        entries = readdirSync(current.dir, { withFileTypes: true });
      } catch (error) {
        errors.push({ root: absolute, dir: current.dir, error: error.message });
        continue;
      }
      for (const entry of entries) {
        const rel = current.rel.length === 0 ? entry.name : `${current.rel}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (isExcludedDir(entry.name) || isExcluded(rel, entry.name)) continue;
          queue.push({ dir: join(current.dir, entry.name), rel });
          continue;
        }
        if (!entry.isFile()) continue;
        if (isExcluded(rel, entry.name)) continue;
        const absolutePath = join(current.dir, entry.name);
        let info;
        try {
          info = statSync(absolutePath);
        } catch {
          continue;
        }
        files.push({
          path: absolutePath,
          rel,
          root: absolute,
          dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
          name: entry.name,
          ext: entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '',
          size: info.size,
          mtime: Math.floor(info.mtimeMs),
          tooLarge: info.size > settings.maxFileBytes,
        });
      }
    }
  }
  files.sort((left, right) => left.rel.localeCompare(right.rel, 'zh'));
  return { files, errors };
}

function sha1Of(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function metadataChunk(file, reason) {
  const sizeKb = Math.max(1, Math.round(file.size / 1024));
  const text = [
    `文件：${file.rel}`,
    `名称：${file.name}`,
    `类型：${file.ext || '未知'}`,
    `大小：${sizeKb} KB`,
    `说明：${reason ?? '该文件未抽取正文，可用其它工具按上面给出的完整路径打开。'}`,
  ].join('\n');
  return { ord: 0, heading: file.dir, page: undefined, text };
}

export function createSyncEngine({ settings, store, ocr, logger = console, onProgress = () => {} }) {
  const state = {
    running: false,
    mode: 'now',
    phase: 'idle',
    total: 0,
    done: 0,
    current: '',
    startedAt: 0,
    finishedAt: 0,
    summary: null,
    error: null,
  };
  let cancelRequested = false;
  let activeRun = null;

  const emit = () => onProgress({ ...state });
  const snapshot = () => ({ ...state });

  async function run(mode = 'now') {
    if (activeRun !== null) return activeRun;
    activeRun = (async () => {
      cancelRequested = false;
      Object.assign(state, {
        running: true,
        mode,
        phase: 'scan',
        total: 0,
        done: 0,
        current: '',
        startedAt: Date.now(),
        finishedAt: 0,
        summary: null,
        error: null,
      });
      emit();

      const current = settings.get();
      const summary = {
        mode,
        roots: current.roots.length,
        scanned: 0,
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
        ocrFiles: 0,
        ocrPages: 0,
        wordFiles: 0,
        chars: 0,
        errors: [],
        durationMs: 0,
      };
      // 逐文件明细：同步记录里要能看出"这次到底同步了哪些内容"，而不只是数字
      const detail = { added: [], updated: [], removed: [], failed: [] };
      const noteChanged = (rel, isNew, note) => {
        const item = note === undefined ? { rel } : { rel, note };
        if (isNew) {
          summary.added += 1;
          detail.added.push(item);
        } else {
          summary.updated += 1;
          detail.updated.push(item);
        }
      };
      const noteFailed = (rel, message) => {
        summary.failed += 1;
        summary.errors.push(`${rel}: ${message}`);
        detail.failed.push({ rel, error: String(message).slice(0, 300) });
      };
      const startedAt = Date.now();
      const pendingMedia = [];

      try {
        if (current.roots.length === 0) throw new Error('尚未配置索引根目录（settings.roots 为空）');
        if (mode === 'rebuild') {
          store.clearAll();
          store.logSync('info', '手动全量重建：已清空索引');
        }

        const existing = new Map(store.listDocuments().map(row => [String(row.path), row]));
        const { files, errors } = walkFiles(current.roots, current);
        summary.scanned = files.length;
        for (const item of errors) summary.errors.push(`${item.root ?? ''} ${item.error}`.trim());

        const changed = [];
        const seen = new Set();
        for (const file of files) {
          seen.add(file.path);
          const previous = existing.get(file.path);
          if (previous === undefined) {
            changed.push({ file, reason: 'added' });
            continue;
          }
          if (Number(previous.size) !== file.size || Number(previous.mtime) !== file.mtime) {
            changed.push({ file, reason: 'changed', previous });
            continue;
          }
          summary.unchanged += 1;
        }
        const removed = [...existing.keys()].filter(path => !seen.has(path));

        state.total = changed.length + removed.length;
        state.phase = 'extract';
        emit();

        const trigram = current.trigram !== false;
        const matchers = createMatchers(current);
        const ocrJobs = [];
        const wordJobs = [];
        const docxMediaJobs = [];

        const upsertMetadata = (file, { kind, status, textSource, error, reason, previous }) => {
          const chunk = metadataChunk(file, reason);
          store.upsertDocument({
            path: file.path,
            rel: file.rel,
            dir: file.dir,
            name: file.name,
            ext: file.ext,
            size: file.size,
            mtime: file.mtime,
            sha1: null,
            kind,
            textSource,
            chars: chunk.text.length,
            status,
            error,
            tries: previous === undefined ? 0 : Number(previous.tries ?? 0),
          }, [chunk], { trigram });
          summary.chars += chunk.text.length;
          return chunk;
        };

        for (const item of changed) {
          if (cancelRequested) break;
          const { file, reason, previous } = item;
          state.current = file.rel;
          emit();
          try {
            const kind = kindOf(file.ext);
            const useContent = matchers.isIncluded(file.rel);
            // 体积上限只用来挡住"本地解析会吃内存"的格式；PDF/图片走 OCR，
            // 由 maxOcrPagesPerFile 控制成本，不受 maxFileBytes 限制。
            const ocrKind = kind === 'pdf' || kind === 'image';
            if ((file.tooLarge && !ocrKind) || kind === 'binary' || !useContent) {
              upsertMetadata(file, {
                kind,
                status: 'metadata',
                textSource: 'metadata',
                error: file.tooLarge ? `超过 maxFileBytes（${current.maxFileBytes} 字节）` : undefined,
                reason: kind === 'binary'
                  ? '该文件为二进制/图纸等不可抽取格式，仅登记元数据；可用其它工具按上面的完整路径直接打开。'
                  : undefined,
                previous,
              });
              summary.skipped += 1;
              noteChanged(file.rel, reason === 'added', file.tooLarge ? '仅登记：超过体积上限' : '仅登记元数据');
            } else if (kind === 'legacy-doc' || kind === 'legacy-xls') {
              if (current.legacyDoc === 'skip') {
                upsertMetadata(file, {
                  kind, status: 'needs_conversion', textSource: 'metadata',
                  error: '旧版 Office 格式，当前设置为 legacyDoc=skip（仅按文件名检索）', previous,
                });
                summary.skipped += 1;
              } else {
                wordJobs.push({ id: file.path, kind: 'doc', path: file.path, file, previous });
              }
            } else {
              const extracted = extractLocal({ kind, path: file.path });
              if (extracted.needs === 'ocr') {
                ocrJobs.push({
                  id: file.path,
                  kind: kind === 'pdf' ? 'pdf' : 'image',
                  path: file.path,
                  maxPages: current.maxOcrPagesPerFile,
                  width: current.ocrWidth,
                  file,
                  previous,
                });
              } else {
                const chunks = chunkBlocks(extracted.blocks, {
                  chunkChars: current.chunkChars,
                  chunkOverlap: current.chunkOverlap,
                });
                if (chunks.length === 0 && kind === 'docx') {
                  // 整篇都是图片的 docx：把内嵌图片落盘后交给 OCR，别让它变成"无正文"
                  try {
                    const media = extractDocxImages(file.path);
                    if (media.files.length > 0) {
                      pendingMedia.push(media);
                      docxMediaJobs.push({ file, previous, media });
                    } else {
                      media.cleanup();
                      upsertMetadata(file, {
                        kind, status: 'needs_ocr', textSource: 'none',
                        error: '未解析出文本，且文档内没有可识别的图片', previous,
                      });
                      summary.skipped += 1;
                    }
                  } catch (error) {
                    upsertMetadata(file, {
                      kind, status: 'needs_ocr', textSource: 'none',
                      error: `未解析出文本；内嵌图片提取失败：${error.message}`, previous,
                    });
                    summary.skipped += 1;
                  }
                } else if (chunks.length === 0) {
                  upsertMetadata(file, {
                    kind, status: 'needs_ocr', textSource: 'none',
                    error: '未解析出文本，可能是纯图片文档', previous,
                  });
                  summary.skipped += 1;
                } else {
                  store.upsertDocument({
                    path: file.path, rel: file.rel, dir: file.dir, name: file.name, ext: file.ext,
                    size: file.size, mtime: file.mtime, sha1: sha1Of(file.path), kind,
                    textSource: 'native', chars: extracted.text.length,
                    pages: extracted.meta?.pageCount,
                    status: 'indexed',
                    error: Array.isArray(extracted.meta?.warnings) && extracted.meta.warnings.length > 0
                      ? extracted.meta.warnings.join('；')
                      : undefined,
                    tries: 0,
                  }, chunks, { trigram });
                  noteChanged(file.rel, reason === 'added');
                  summary.chars += extracted.text.length;
                }
              }
            }
          } catch (error) {
            noteFailed(file.rel, error.message);
            try {
              upsertMetadata(file, {
                kind: kindOf(file.ext), status: 'error', textSource: 'none',
                error: error.message, previous,
              });
            } catch { /* 连元数据都写不进去时忽略，继续下一个文件 */ }
          }
          state.done += 1;
          emit();
          await new Promise(resolveTick => setImmediate(resolveTick));
        }

        // —— OCR 批处理（PDF / 图片，一批一个助手进程）
        for (let index = 0; index < ocrJobs.length; index += OCR_BATCH) {
          if (cancelRequested) break;
          const batch = ocrJobs.slice(index, index + OCR_BATCH);
          state.current = `OCR ${index + batch.length}/${ocrJobs.length}`;
          emit();
          let results;
          try {
            results = await ocr.recognize(batch.map(job => ({
              id: job.id, kind: job.kind, path: job.path, maxPages: job.maxPages, width: job.width,
            })));
          } catch (error) {
            for (const job of batch) {
              noteFailed(job.file.rel, error.message);
              upsertMetadata(job.file, {
                kind: kindOf(job.file.ext), status: 'needs_ocr', textSource: 'none',
                error: error.message, previous: job.previous,
              });
              state.done += 1;
            }
            emit();
            continue;
          }
          for (const job of batch) {
            const result = results.get(job.id) ?? { ok: false, error: 'OCR 未返回结果', text: '', pages: [] };
            const pages = Array.isArray(result.pages) ? result.pages : [];
            const text = pages.length > 0
              ? pages.filter(page => page.text.length > 0).map(page => `【第${page.n}页】\n${page.text}`).join('\n\n')
              : result.text;
            try {
              if (!result.ok || text.trim().length === 0) {
                noteFailed(job.file.rel, result.error ?? 'OCR 未识别出文本');
                upsertMetadata(job.file, {
                  kind: kindOf(job.file.ext), status: 'needs_ocr', textSource: 'ocr',
                  error: result.error ?? 'OCR 未识别出文本', previous: job.previous,
                });
              } else {
                const chunks = chunkBlocks(textToBlocks(text), {
                  chunkChars: current.chunkChars,
                  chunkOverlap: current.chunkOverlap,
                });
                store.upsertDocument({
                  path: job.file.path, rel: job.file.rel, dir: job.file.dir, name: job.file.name,
                  ext: job.file.ext, size: job.file.size, mtime: job.file.mtime,
                  sha1: sha1Of(job.file.path), kind: kindOf(job.file.ext), textSource: 'ocr',
                  chars: text.length, pages: pages.length > 0 ? pages.length : undefined,
                  status: 'indexed', tries: 0,
                }, chunks, { trigram });
                summary.ocrFiles += 1;
                summary.ocrPages += pages.length;
                summary.chars += text.length;
                noteChanged(job.file.rel, job.previous === undefined);
              }
            } catch (error) {
              noteFailed(job.file.rel, error.message);
            }
            state.done += 1;
            emit();
          }
        }

        // —— 纯图片 docx：内嵌图片 OCR（图片已在主循环里落盘到临时目录）
        if (docxMediaJobs.length > 0 && !cancelRequested) {
          const jobs = [];
          for (const item of docxMediaJobs) {
            item.media.files.forEach((mediaFile, index) => {
              jobs.push({ id: `${item.file.path}::${index}`, kind: 'image', path: mediaFile.path });
            });
          }
          state.current = `图片型文档 OCR ${docxMediaJobs.length}/${docxMediaJobs.length}`;
          emit();
          const results = new Map();
          for (let index = 0; index < jobs.length; index += OCR_BATCH) {
            const batch = jobs.slice(index, index + OCR_BATCH);
            try {
              const partial = await ocr.recognize(batch);
              for (const [id, value] of partial) results.set(id, value);
            } catch (error) {
              summary.errors.push(`图片型文档 OCR 失败：${error.message}`);
            }
          }
          for (const item of docxMediaJobs) {
            const parts = [];
            item.media.files.forEach((mediaFile, index) => {
              const result = results.get(`${item.file.path}::${index}`);
              if (result !== undefined && result.ok === true && result.text.trim().length > 0) {
                parts.push(`【图片${index + 1}】\n${result.text.trim()}`);
              }
            });
            try {
              if (parts.length === 0) {
                upsertMetadata(item.file, {
                  kind: 'docx', status: 'needs_ocr', textSource: 'none',
                  error: '正文为空且内嵌图片未识别出文字', previous: item.previous,
                });
                summary.skipped += 1;
              } else {
                const text = parts.join('\n\n');
                const chunks = chunkBlocks(textToBlocks(text), {
                  chunkChars: current.chunkChars,
                  chunkOverlap: current.chunkOverlap,
                });
                store.upsertDocument({
                  path: item.file.path, rel: item.file.rel, dir: item.file.dir, name: item.file.name,
                  ext: item.file.ext, size: item.file.size, mtime: item.file.mtime,
                  sha1: sha1Of(item.file.path), kind: 'docx', textSource: 'ocr',
                  chars: text.length, pages: item.media.files.length, status: 'indexed', tries: 0,
                }, chunks, { trigram });
                summary.ocrFiles += 1;
                summary.ocrPages += item.media.files.length;
                summary.chars += text.length;
                noteChanged(item.file.rel, item.previous === undefined);
              }
            } catch (error) {
              noteFailed(item.file.rel, error.message);
            }
          }
        }

        // —— 旧版 .doc/.xls：一份文件一批。
        // 为什么不用一个大批次：Word COM 偶发卡死（实测有过 8 分钟无响应），
        // 单文件隔离 + 超时能保证"一份卡住只丢那一份"，其余照常入索引。
        if (wordJobs.length > 0 && !cancelRequested) {
          for (const [position, job] of wordJobs.entries()) {
            if (cancelRequested) break;
            state.current = `Word 提取 ${position + 1}/${wordJobs.length}：${job.file.name}`;
            emit();
            let result;
            try {
              const results = await ocr.readLegacyDocs([{ id: job.id, kind: 'doc', path: job.path }], { timeout: 75 * 1000 });
              result = results.get(job.id) ?? { ok: false, error: 'Word 未返回结果', text: '' };
            } catch (error) {
              result = { ok: false, error: `Word 提取失败或超时：${error.message}`, text: '' };
            }
            try {
              if (!result.ok || result.text.trim().length === 0) {
                noteFailed(job.file.rel, result.error ?? '未取到文本');
                upsertMetadata(job.file, {
                  kind: kindOf(job.file.ext), status: 'needs_conversion', textSource: 'word',
                  error: result.error ?? '未取到文本', previous: job.previous,
                });
              } else {
                const text = result.text;
                const chunks = chunkBlocks(textToBlocks(text), {
                  chunkChars: current.chunkChars,
                  chunkOverlap: current.chunkOverlap,
                });
                store.upsertDocument({
                  path: job.file.path, rel: job.file.rel, dir: job.file.dir, name: job.file.name,
                  ext: job.file.ext, size: job.file.size, mtime: job.file.mtime,
                  sha1: sha1Of(job.file.path), kind: kindOf(job.file.ext), textSource: 'word',
                  chars: text.length, status: 'indexed', tries: 0,
                }, chunks, { trigram });
                summary.wordFiles += 1;
                summary.chars += text.length;
                noteChanged(job.file.rel, job.previous === undefined);
              }
            } catch (error) {
              noteFailed(job.file.rel, error.message);
            }
            state.done += 1;
            emit();
          }
        }

        // —— 删除：文件已不在磁盘上
        for (const path of removed) {
          if (cancelRequested) break;
          store.deleteDocument(path);
          summary.removed += 1;
          detail.removed.push(String(existing.get(path)?.rel ?? path));
          state.done += 1;
          state.current = path;
          emit();
        }

        state.phase = cancelRequested ? 'cancelled' : 'done';
      } catch (error) {
        state.phase = 'error';
        state.error = error.message;
        summary.errors.push(error.message);
        logger.warn?.(`dsh-company-kb: 同步失败：${error.message}`);
      } finally {
        for (const media of pendingMedia) media.cleanup();
        summary.durationMs = Date.now() - startedAt;
        store.setMeta('lastSyncAt', String(Date.now()));
        store.setMeta('lastSyncSummary', JSON.stringify({
          mode: summary.mode,
          added: summary.added,
          updated: summary.updated,
          removed: summary.removed,
          skipped: summary.skipped,
          failed: summary.failed,
          chars: summary.chars,
          durationMs: summary.durationMs,
          phase: state.phase,
        }));
        store.logSync(
          state.phase === 'error' ? 'error' : 'info',
          `同步(${mode}) 扫描 ${summary.scanned}，新增 ${summary.added}，更新 ${summary.updated}，删除 ${summary.removed}，跳过 ${summary.skipped}，失败 ${summary.failed}，耗时 ${summary.durationMs}ms`
            + (summary.errors.length > 0 ? `；错误：${summary.errors.slice(0, 5).join(' | ')}` : ''),
          detail.added.length + detail.updated.length + detail.removed.length + detail.failed.length > 0
            ? detail
            : null,
        );
        state.running = false;
        state.finishedAt = Date.now();
        state.current = '';
        state.summary = summary;
        emit();
        activeRun = null;
      }
      return summary;
    })();
    return activeRun;
  }

  function cancel() {
    if (!state.running) return false;
    cancelRequested = true;
    state.current = '正在中止…';
    emit();
    return true;
  }

  return {
    run,
    cancel,
    snapshot,
    isRunning: () => state.running,
    /** 仅统计"索引之后有多少文件变了"，不抽取、不写库。 */
    stalenessCheck(current) {
      const { files, errors } = walkFiles(current.roots, current);
      const known = new Set(store.listDocuments().map(row => String(row.path)));
      const existing = new Map(store.listDocuments().map(row => [String(row.path), row]));
      let changed = 0;
      let added = 0;
      for (const file of files) {
        const previous = existing.get(file.path);
        if (previous === undefined) { added += 1; continue; }
        if (Number(previous.size) !== file.size || Number(previous.mtime) !== file.mtime) changed += 1;
      }
      const removed = [...known].filter(path => !files.some(file => file.path === path)).length;
      return {
        changed,
        added,
        removed,
        roots: current.roots.length,
        unreachable: errors.length > 0,
        errors: errors.map(item => item.error),
      };
    },
  };
}
