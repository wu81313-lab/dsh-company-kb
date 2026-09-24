// OCR / Word COM 桥：Node 侧只负责写任务文件、拉起 PowerShell 5.1、读结果文件。
// 传参一律走文件（不用管道），批量执行，单文件失败不影响整批。

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOcrText } from './segment.js';

const HELPER = fileURLToPath(new URL('./ocr-helper.ps1', import.meta.url));
const POWERSHELL = process.env.DSH_LOCAL_KB_POWERSHELL
  ?? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

export function createOcrBridge({ logger = console, timeoutMs = 10 * 60 * 1000 } = {}) {
  let capabilities = null;

  const run = (jobs, { timeout = timeoutMs } = {}) => new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-company-kb-'));
    const jobPath = join(dir, 'job.json');
    const outPath = join(dir, 'out.json');
    const cleanup = () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无关紧要 */ }
    };
    try {
      writeFileSync(jobPath, JSON.stringify({ jobs }), 'utf8');
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Job', jobPath, '-Out', outPath],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        let parsed = null;
        try {
          parsed = JSON.parse(readFileSync(outPath, 'utf8'));
        } catch {
          parsed = null;
        }
        cleanup();
        if (parsed === null) {
          const detail = error?.message ?? 'no output';
          const tail = String(stderr ?? '').split('\n').filter(Boolean).slice(-3).join(' / ');
          reject(new Error(`OCR 助手未返回结果（${detail}${tail ? `；${tail}` : ''}）`));
          return;
        }
        if (parsed.capabilities !== undefined) capabilities = parsed.capabilities;
        resolve({
          capabilities: parsed.capabilities ?? capabilities,
          results: asArray(parsed.results),
          fatal: parsed.fatal,
        });
      },
    );
  });

  /** 探测能力（OCR 语言、PDF 渲染、Word COM），进程内缓存。 */
  async function probe() {
    if (capabilities !== null) return capabilities;
    try {
      const { capabilities: caps } = await run([], { timeout: 60 * 1000 });
      capabilities = caps ?? { ocr: false, pdf: false, word: false, ocrLangs: [], note: '探测失败' };
    } catch (error) {
      logger.warn?.(`dsh-company-kb: OCR 能力探测失败：${error.message}`);
      capabilities = { ocr: false, pdf: false, word: false, ocrLangs: [], note: error.message };
    }
    return capabilities;
  }

  function jobsToMap(results) {
    const map = new Map();
    for (const item of results) map.set(String(item.id), item);
    return map;
  }

  /**
   * 执行一批 OCR 任务。返回 Map<jobId, {ok, text, pages, error, meta}>。
   * OCR 文本会做中文去空格归一。
   */
  async function recognize(jobs) {
    const map = new Map();
    if (jobs.length === 0) return map;
    const { results } = await run(jobs);
    for (const [id, item] of jobsToMap(results)) {
      map.set(id, {
        ok: item.ok === true,
        error: item.error || undefined,
        text: normalizeOcrText(item.text ?? ''),
        pages: asArray(item.pages).map(page => ({ n: Number(page.n), text: normalizeOcrText(page.text ?? '') })),
        meta: item.meta ?? {},
      });
    }
    for (const job of jobs) {
      if (!map.has(String(job.id))) map.set(String(job.id), { ok: false, error: '助手未返回该任务', text: '', pages: [], meta: {} });
    }
    return map;
  }

  /**
   * 执行旧版 .doc/.xls（Word COM）。
   * 调用方按"一份文件一批"来用：Word 偶发卡死时，超时只影响那一份文件。
   */
  async function readLegacyDocs(jobs, { timeout = 120 * 1000 } = {}) {
    const map = new Map();
    if (jobs.length === 0) return map;
    const { results } = await run(jobs, { timeout });
    for (const [id, item] of jobsToMap(results)) {
      map.set(id, {
        ok: item.ok === true,
        error: item.error || undefined,
        text: String(item.text ?? '').replace(/\r/gu, '\n'),
        meta: item.meta ?? {},
      });
    }
    for (const job of jobs) {
      if (!map.has(String(job.id))) map.set(String(job.id), { ok: false, error: '助手未返回该任务', text: '', meta: {} });
    }
    return map;
  }

  return {
    probe,
    recognize,
    readLegacyDocs,
    get capabilities() { return capabilities; },
  };
}
