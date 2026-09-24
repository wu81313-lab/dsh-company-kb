// 运行时设置：cordis 行配置是启动默认值，settings.json 是热生效的覆盖层。
// 面板「设置」页写的就是这个文件；改动不需要重启 profile。

import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = {
  roots: [],
  include: [
    '**/*.md', '**/*.markdown', '**/*.txt', '**/*.csv', '**/*.json', '**/*.log',
    '**/*.docx', '**/*.doc', '**/*.xlsx', '**/*.xls', '**/*.pptx',
    '**/*.pdf', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.bmp', '**/*.tif', '**/*.tiff',
  ],
  excludeDirs: ['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information'],
  excludeGlobs: ['~$*', '*.tmp', '*.crdownload', '*.partial'],
  maxFileBytes: 256 * 1024 * 1024,
  autoSync: 'off',            // 'off' = 纯手动 | 'watch' = 事件驱动增量（仍无定时器）
  stalenessHint: true,
  pathTriggers: true,
  triggers: [
    '知识库', '资料库', '公司资料', '公司资料库', '公司资料', '公司知识库',
    '用知识库', '查知识库', '查一下资料', '查一下文档', '查一下文件', '翻一下资料', '/kb',
  ],
  chunkChars: 900,
  chunkOverlap: 150,
  trigram: true,
  topK: 8,
  maxChunksPerDoc: 3,
  ocrWidth: 1600,
  maxOcrPagesPerFile: 60,
  // 内嵌图片 OCR：把方案书 / 投标文件里架构图、界面截图上的文字也纳入检索
  ocrEmbeddedImages: true,
  embeddedImageMinBytes: 20 * 1024,   // 小于这个体积的图按 logo/图标跳过
  maxEmbeddedImagesPerFile: 40,
  legacyDoc: 'word-com',      // 'word-com' | 'skip'
  explicitOnly: true,
  exposeWeb: true,
  webPath: '/company-kb-api',
  reconcileStaleMs: 5 * 60 * 1000,
};

const KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

function pickKnown(input) {
  const out = {};
  if (input === null || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (KEYS.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  merged.roots = (Array.isArray(merged.roots) ? merged.roots : []).map(String).filter(Boolean);
  merged.include = (Array.isArray(merged.include) ? merged.include : DEFAULT_SETTINGS.include).map(String);
  merged.excludeDirs = (Array.isArray(merged.excludeDirs) ? merged.excludeDirs : []).map(String);
  merged.excludeGlobs = (Array.isArray(merged.excludeGlobs) ? merged.excludeGlobs : []).map(String);
  merged.triggers = (Array.isArray(merged.triggers) ? merged.triggers : DEFAULT_SETTINGS.triggers).map(String).filter(Boolean);
  merged.autoSync = merged.autoSync === 'watch' ? 'watch' : 'off';
  merged.legacyDoc = merged.legacyDoc === 'skip' ? 'skip' : 'word-com';
  for (const key of ['maxFileBytes', 'chunkChars', 'chunkOverlap', 'topK', 'maxChunksPerDoc', 'ocrWidth', 'maxOcrPagesPerFile', 'reconcileStaleMs', 'embeddedImageMinBytes', 'maxEmbeddedImagesPerFile']) {
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_SETTINGS[key];
  }
  merged.explicitOnly = merged.explicitOnly !== false;
  merged.stalenessHint = merged.stalenessHint !== false;
  merged.pathTriggers = merged.pathTriggers !== false;
  merged.ocrEmbeddedImages = merged.ocrEmbeddedImages !== false;
  merged.exposeWeb = merged.exposeWeb !== false;
  merged.webPath = typeof merged.webPath === 'string' && merged.webPath.startsWith('/') ? merged.webPath : DEFAULT_SETTINGS.webPath;
  return merged;
}

/**
 * 设置管理器：进程内单例，带 mtime 缓存，外部手改文件也能被发现。
 */
export function createSettings({ settingsPath, config = {} }) {
  let cache = null;
  let cachedMtime = -1;
  let cachedRaw = null;

  const configLayer = pickKnown(config);

  function readFileLayer() {
    if (settingsPath === undefined) return {};
    let mtime = -1;
    try {
      mtime = statSync(settingsPath).mtimeMs;
    } catch {
      // 文件还不存在：用空覆盖层
      cache = normalizeSettings({ ...configLayer });
      cachedMtime = -1;
      cachedRaw = null;
      return null;
    }
    if (cache !== null && mtime === cachedMtime) return null;
    cachedMtime = mtime;
    try {
      cachedRaw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      cachedRaw = null;
    }
    cache = normalizeSettings({ ...configLayer, ...pickKnown(cachedRaw) });
    return null;
  }

  function get() {
    readFileLayer();
    if (cache === null) cache = normalizeSettings({ ...configLayer });
    return cache;
  }

  function persist(next) {
    if (settingsPath === undefined) throw new Error('未配置 settingsPath，无法保存设置');
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, settingsPath);
    cachedMtime = -1;
    cache = null;
    return get();
  }

  function update(patch) {
    const current = get();
    const next = normalizeSettings({ ...current, ...pickKnown(patch) });
    return persist(next);
  }

  function raw() {
    readFileLayer();
    return cachedRaw === null ? { ...configLayer } : { ...configLayer, ...pickKnown(cachedRaw) };
  }

  return { get, update, raw, path: settingsPath };
}
