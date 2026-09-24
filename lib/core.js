// 插件内核：把设置、索引库、OCR 桥、同步引擎拼成一组与传输无关的操作，
// 供工具层（tools.js）、Web 层（web.js）和命令行（cli.mjs）共用。

import { existsSync, statSync, watch } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createSettings } from './settings.js';
import { openStore } from './store.js';
import { createOcrBridge } from './ocr.js';
import { createSyncEngine } from './scan.js';
import { buildSearchPlan, normalize } from './segment.js';

export function createKbCore(config = {}, { logger = console } = {}) {
  const settings = createSettings({ settingsPath: config.settingsPath, config });
  const databasePath = config.databasePath ?? resolve(process.env.DSH_HOME ?? '.', 'local-kb/index.sqlite');
  const store = openStore({ databasePath, logger });
  store.migrate();
  const ocr = createOcrBridge({ logger });
  const engine = createSyncEngine({ settings, store, ocr, logger });

  let staleCache = { at: 0, value: null };
  let triggerCache = { at: 0, names: new Set(), dirs: new Set() };
  let watcher = null;
  let watchTimer = null;
  // 运行时自检状态（面板接口是否注册成功等）：index.js 写入，kb_status / 面板读出
  const runtime = { webApi: { state: 'unknown' } };

  async function capabilities() {
    return ocr.probe();
  }

  function currentSettings() {
    return settings.get();
  }

  function updateSettings(patch) {
    const next = settings.update(patch);
    triggerCache = { at: 0, names: new Set(), dirs: new Set() };
    staleCache = { at: 0, value: null };
    applyWatchMode();
    return next;
  }

  function lastSyncSummary() {
    const raw = store.getMeta('lastSyncSummary');
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 廉价体检：只比对 stat，不抽取、不写库。结果按 settings.reconcileStaleMs 缓存。 */
  function staleness({ force = false } = {}) {
    const current = settings.get();
    if (current.stalenessHint !== true) return null;
    const now = Date.now();
    if (!force && staleCache.value !== null && now - staleCache.at < current.reconcileStaleMs) return staleCache.value;
    try {
      const value = engine.stalenessCheck(current);
      staleCache = { at: now, value };
      return value;
    } catch (error) {
      const value = { changed: 0, added: 0, removed: 0, roots: current.roots.length, unreachable: true, errors: [error.message] };
      staleCache = { at: now, value };
      return value;
    }
  }

  function invalidateStaleness() {
    staleCache = { at: 0, value: null };
  }

  function status() {
    const current = settings.get();
    const stats = store.stats();
    const lastAt = store.getMeta('lastSyncAt');
    const stale = staleness();
    // 第一次调用时顺手探测一次 OCR/Word 能力（结果进程内缓存），
    // 避免状态里长期显示"未探测"。
    if (ocr.capabilities === null) void ocr.probe().catch(() => { /* 探测失败时能力保持未知 */ });
    const roots = current.roots.map(root => {
      let ok = true;
      let error;
      try {
        // 只判断根目录是否还在，不做任何写入
        ok = existsSync(root) && statSync(root).isDirectory();
      } catch (caught) {
        ok = false;
        error = caught.message;
      }
      return { path: root, ok, error };
    });
    return {
      built: stats.docs > 0,
      lastSyncAt: lastAt === undefined ? null : Number(lastAt),
      lastSummary: lastSyncSummary(),
      sync: engine.snapshot(),
      stats,
      stale,
      roots,
      settings: {
        autoSync: current.autoSync,
        explicitOnly: current.explicitOnly,
        stalenessHint: current.stalenessHint,
        pathTriggers: current.pathTriggers,
        trigram: current.trigram,
        legacyDoc: current.legacyDoc,
        maxFileBytes: current.maxFileBytes,
        roots: current.roots,
      },
      capabilities: ocr.capabilities,
      webApi: { ...runtime.webApi },
      databasePath,
      settingsPath: settings.path ?? null,
    };
  }

  /** ext 允许传数组或 "docx,xlsx" 这样的串，统一成小写含点的数组。 */
  function normalizeExt(ext) {
    if (ext === undefined || ext === null || ext === '') return undefined;
    const list = (Array.isArray(ext) ? ext : String(ext).split(/[,\s]+/u))
      .map(item => String(item).trim().toLowerCase())
      .filter(Boolean)
      .map(item => (item.startsWith('.') ? item : `.${item}`));
    return list.length > 0 ? list : undefined;
  }

  function search(query, { limit, dir, ext, maxPerDoc, days } = {}) {
    const current = settings.get();
    const plan = buildSearchPlan(query);
    if (plan.terms.length === 0 && plan.phrases.length === 0) {
      return { hits: [], candidates: 0, plan: { terms: [], phrases: [] }, stale: staleness() };
    }
    const result = store.search(plan, {
      limit: Math.max(1, Math.min(Number(limit) || current.topK, 30)),
      maxPerDoc: Math.max(1, Math.min(Number(maxPerDoc) || current.maxChunksPerDoc, 10)),
      dir,
      ext: normalizeExt(ext),
      days,
    });
    return { ...result, plan: { terms: plan.terms, phrases: plan.phrases }, stale: staleness() };
  }

  function read({ doc, offset = 0, limit = 12000 } = {}) {
    const row = store.getDocument(doc);
    if (row === undefined) {
      return { found: false, message: `索引里没有找到「${doc}」。可以先 kb_list 浏览目录，或用 kb_search 检索。` };
    }
    const status = String(row.status);
    if (status === 'metadata' || status === 'needs_conversion' || status === 'needs_ocr') {
      return {
        found: true,
        rel: String(row.rel),
        path: String(row.path),
        ext: String(row.ext),
        status,
        textSource: String(row.text_source),
        chars: Number(row.chars),
        text: '',
        message: `该文件没有抽取正文（状态：${status}${row.error ? `；原因：${row.error}` : ''}）。完整路径：${row.path}`
          + '（图片/PDF 可用视觉工具直接打开；其它格式可用对应软件打开）',
      };
    }
    const result = store.readDocumentText(Number(row.id), offset, limit);
    return {
      found: true,
      rel: String(row.rel),
      path: String(row.path),
      ext: String(row.ext),
      status,
      textSource: String(row.text_source),
      chars: Number(row.chars),
      pages: row.pages === null || row.pages === undefined ? undefined : Number(row.pages),
      ...result,
    };
  }

  /**
   * 解析"用本机程序打开"的目标：必须是索引里的文件，且路径确实落在已配置的根目录内。
   * 这样即使接口只监听回环，也不会被拿来打开任意文件。
   */
  function resolveOriginal(doc) {
    const row = store.getDocument(doc);
    if (row === undefined) return { found: false, message: `索引里没有找到「${doc}」。` };
    const target = resolve(String(row.path));
    const current = settings.get();
    const inside = current.roots.some(root => {
      const base = resolve(root);
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
    });
    if (!inside) {
      return { found: true, allowed: false, rel: String(row.rel), message: '该文件不在已配置的知识库根目录内，出于安全考虑不打开。' };
    }
    if (!existsSync(target)) {
      return { found: true, allowed: false, rel: String(row.rel), message: '文件已不在磁盘上（可能被移动或删除），请先同步索引。' };
    }
    return {
      found: true,
      allowed: true,
      rel: String(row.rel),
      name: String(row.name),
      ext: String(row.ext),
      path: target,
      size: Number(row.size),
      textSource: String(row.text_source),
    };
  }

  function list({ dir = '', depth = 1, filter = '' } = {}) {
    return store.listDir({ dir, depth, filter });
  }

  async function sync(mode = 'now', options = {}) {
    invalidateStaleness();
    const summary = await engine.run(mode === 'rebuild' ? 'rebuild' : 'now', options);
    triggerCache = { at: 0, names: new Set(), dirs: new Set() };
    return summary;
  }

  function progress() {
    return engine.snapshot();
  }

  function cancel() {
    return engine.cancel();
  }

  const sessionEnabled = sessionId => (sessionId === undefined ? false : store.sessionGet(sessionId) === true);
  const setSession = (sessionId, enabled) => {
    if (sessionId === undefined) throw new Error('缺少会话 id');
    store.sessionSet(sessionId, enabled);
    return enabled;
  };

  /** 路径点名用：索引里出现过的文件名与目录名（带缓存，统一做 NFKC + 小写）。 */
  function pathTriggerNames() {
    const now = Date.now();
    if (now - triggerCache.at < 60_000 && triggerCache.names.size > 0) return triggerCache;
    const names = new Set();
    const dirs = new Set();
    const fold = value => normalize(String(value)).toLocaleLowerCase('zh-CN');
    for (const row of store.listDocuments()) {
      const name = fold(row.name);
      if (name.length >= 3) names.add(name);
      for (const part of String(row.dir).split('/')) {
        const folded = fold(part);
        if (folded.length >= 3) dirs.add(folded);
      }
    }
    triggerCache = { at: now, names, dirs };
    return triggerCache;
  }

  function applyWatchMode() {
    const current = settings.get();
    if (current.autoSync !== 'watch' || current.roots.length === 0) {
      if (watcher !== null) {
        try { watcher.close(); } catch { /* 已关闭 */ }
        watcher = null;
      }
      return;
    }
    if (watcher !== null) return;
    const schedule = () => {
      if (watchTimer !== null) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        if (engine.isRunning()) return;
        void engine.run('now').catch(() => { /* 摘要已记录 */ });
      }, 3000);
    };
    try {
      watcher = watch(current.roots, { recursive: true, persistent: false }, schedule);
      watcher.on('error', error => logger.warn?.(`dsh-company-kb: 文件监听失败：${error.message}`));
    } catch (error) {
      logger.warn?.(`dsh-company-kb: 无法监听根目录（${error.message}）；autoSync=watch 未生效`);
      watcher = null;
    }
  }

  function dispose() {
    if (watcher !== null) {
      try { watcher.close(); } catch { /* 已关闭 */ }
      watcher = null;
    }
    if (watchTimer !== null) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
    store.close();
  }

  return {
    runtime,
    settings: currentSettings,
    rawSettings: () => settings.raw(),
    updateSettings,
    store,
    status,
    staleness,
    invalidateStaleness,
    search,
    read,
    resolveOriginal,
    list,
    sync,
    progress,
    cancel,
    sessionEnabled,
    setSession,
    pathTriggerNames,
    capabilities,
    applyWatchMode,
    dispose,
    databasePath,
  };
}
