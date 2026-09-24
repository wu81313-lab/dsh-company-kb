// 宿主 HTTP API：挂在 DSH 自己的 Web 服务下（同源、仅回环可访问），
// 供左栏面板 / 会话开关 / 设置页调用。它只读索引 + 触发手动同步 + 读写插件设置，
// 不会修改知识库文件夹里的任何文件。
// 「用本机程序打开」只是把文件交给系统默认程序（WPS/Office/PDF 阅读器），同样是只读打开。

import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { openWithSystem, revealInExplorer } from './open.js';
import { readZip } from './extract/zip.js';
import { renderDocumentHtml, PREVIEW_EXTS } from './render/index.js';

const MAX_BODY = 512 * 1024;

// 预览缓存：键是「路径|mtime|大小」，值是最新渲染出的 HTML；zip 句柄另存一份，
// 避免预览里的每张图片都把整个 docx 重新读一遍、重新解压一次。
const PREVIEW_CACHE_MAX = 6;
const previewCache = new Map();
const zipCache = new Map();

function cached(map, key, build) {
  if (map.has(key)) {
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
  }
  const value = build();
  map.set(key, value);
  while (map.size > PREVIEW_CACHE_MAX) map.delete(map.keys().next().value);
  return value;
}

// 只接受回环 Host：挡住 DNS rebinding（恶意网页把域名解析到 127.0.0.1 后打本接口）。
// 本接口本来也只监听回环，这一条是纵深防御。
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|\[::ffff:127\.0\.0\.1\])(?::\d+)?$/iu;

const MIME = new Map(Object.entries({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8', '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.dwg': 'application/acad', '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive',
}));

// 能在浏览器里直接渲染的类型走 inline，其余走 attachment（浏览器会下载而不是渲染乱码）
const INLINE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf',
  '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.xml', '.yml', '.yaml',
  '.mp4', '.webm', '.mp3', '.wav',
]);

/** 交给系统默认程序打开（等价于双击：docx→WPS/Word，pdf→PDF 阅读器）。 */
const defaultOpenPath = target => openWithSystem(target);

/** 在资源管理器中定位该文件。 */
const defaultRevealPath = target => revealInExplorer(target);

/** 流式返回原文件，支持 Range（PDF/视频拖动进度）。 */
function serveFile(req, res, path) {
  const ext = extname(path).toLowerCase();
  const size = statSync(path).size;
  const headers = {
    'content-type': MIME.get(ext) ?? 'application/octet-stream',
    'content-disposition': `${INLINE.has(ext) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/u.exec(String(req.headers?.range ?? ''));
  if (range !== null) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2] || 0)) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < size) {
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(path).pipe(res);
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function registerWebApi(webServer, core, {
  webPath = '/company-kb-api',
  logger = console,
  openPath = defaultOpenPath,
  revealPath = defaultRevealPath,
} = {}) {
  const base = webPath.endsWith('/') ? webPath.slice(0, -1) : webPath;

  const handler = async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' });
      res.end();
      return;
    }
    if (!LOOPBACK_HOST.test(String(req.headers?.host ?? ''))) {
      json(res, 403, { error: '只允许本机回环访问' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(base.length).replace(/\/+$/u, '') || '/';
    try {
      if (method === 'GET' && route === '/status') {
        json(res, 200, core.status());
        return;
      }
      if (method === 'GET' && route === '/progress') {
        json(res, 200, core.progress());
        return;
      }
      if (method === 'GET' && route === '/log') {
        json(res, 200, { entries: core.store.recentLogs(Math.min(200, Number(url.searchParams.get('limit') ?? 30) || 30)) });
        return;
      }
      // 只重抽指定文件（同步记录里失败的项、或面板上手动指定）：显式动作，同样不自动跑
      if (method === 'POST' && route === '/resync') {
        const body = await readBody(req);
        const rels = (Array.isArray(body.rels) ? body.rels : [body.rel])
          .map(item => String(item ?? '').trim())
          .filter(Boolean)
          .slice(0, 200);
        if (rels.length === 0) {
          json(res, 400, { error: '没有指定要重抽的文件' });
          return;
        }
        if (core.progress().running) {
          json(res, 409, { error: '已有同步在进行中' });
          return;
        }
        void core.sync('now', { only: rels })
          .then(summary => logger.info?.(`dsh-company-kb: 重抽 ${rels.length} 个文件完成（失败 ${summary.failed}）`))
          .catch(error => logger.warn?.(`dsh-company-kb: 重抽失败：${error.message}`));
        json(res, 200, { started: true, rels });
        return;
      }
      if (method === 'POST' && route === '/sync') {
        const body = await readBody(req);
        const mode = body.mode === 'rebuild' ? 'rebuild' : 'now';
        if (core.progress().running) {
          json(res, 200, { started: false, progress: core.progress() });
          return;
        }
        void core.sync(mode).catch(error => logger.warn?.(`dsh-company-kb: 同步失败：${error.message}`));
        json(res, 200, { started: true, mode });
        return;
      }
      if (method === 'POST' && route === '/cancel') {
        json(res, 200, { cancelled: core.cancel() });
        return;
      }
      // 用本机程序打开（WPS / Office / PDF 阅读器）与在资源管理器中定位
      if ((method === 'POST' && (route === '/open' || route === '/reveal'))) {
        const body = await readBody(req);
        const target = core.resolveOriginal(String(body.rel ?? url.searchParams.get('rel') ?? ''));
        if (target.found !== true) {
          json(res, 404, target);
          return;
        }
        if (target.allowed !== true) {
          json(res, 403, target);
          return;
        }
        try {
          if (route === '/open') await openPath(target.path);
          else await revealPath(target.path);
          json(res, 200, { opened: true, revealed: route === '/reveal', rel: target.rel, name: target.name, path: target.path });
        } catch (error) {
          json(res, 500, { error: `调用系统程序失败：${error.message}`, rel: target.rel });
        }
        return;
      }
      // 文档预览：docx / xlsx / pptx 由插件自己解析成 HTML。
      // 不启动 Office、不写临时文件、不依赖本机装了什么——纯本地解析。
      if (method === 'GET' && route === '/preview') {
        const target = core.resolveOriginal(url.searchParams.get('rel') ?? '');
        if (target.found !== true) {
          json(res, 404, target);
          return;
        }
        if (target.allowed !== true) {
          json(res, 403, target);
          return;
        }
        const ext = extname(target.path).toLowerCase();
        if (!PREVIEW_EXTS.has(ext)) {
          json(res, 415, { error: `暂不支持预览 ${ext} 文件，用「用本机程序打开」原样查看` });
          return;
        }
        const stat = statSync(target.path);
        const query = url.searchParams.get('q') ?? '';
        const key = `${target.path}|${stat.mtimeMs}|${stat.size}|${query}`;
        const html = cached(previewCache, key, () => renderDocumentHtml({
          buffer: readFileSync(target.path),
          ext,
          rel: String(target.rel ?? ''),
          mediaBase: `${base}/media`,
          query,
        }).html);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // 文档内容是不可信输入：禁止脚本/表单/外部请求，只允许同源图片与内联样式
          'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        });
        res.end(html);
        return;
      }
      // 预览里的内嵌图片：直接从 zip 条目里读出来，不落盘
      if (method === 'GET' && route === '/media') {
        const target = core.resolveOriginal(url.searchParams.get('rel') ?? '');
        if (target.found !== true || target.allowed !== true) {
          json(res, target.found === true ? 403 : 404, target);
          return;
        }
        const name = url.searchParams.get('name') ?? '';
        if (!PREVIEW_EXTS.has(extname(target.path).toLowerCase())) {
          json(res, 415, { error: '该类型不支持内嵌图片' });
          return;
        }
        const stat = statSync(target.path);
        const zip = cached(zipCache, `${target.path}|${stat.mtimeMs}|${stat.size}`, () => readZip(readFileSync(target.path)));
        if (!zip.entries.has(name)) {
          json(res, 404, { error: '压缩包里没有这个条目' });
          return;
        }
        const data = zip.read(name);
        res.writeHead(200, {
          'content-type': MIME.get(extname(name).toLowerCase()) ?? 'application/octet-stream',
          'cache-control': 'private, max-age=600',
          'x-content-type-options': 'nosniff',
          'content-length': data.length,
        });
        res.end(data);
        return;
      }
      // 原文件直出（图片/PDF 在面板里内联预览；其它类型走下载）
      if (method === 'GET' && route === '/raw') {
        const target = core.resolveOriginal(url.searchParams.get('rel') ?? '');
        if (target.found !== true) {
          json(res, 404, target);
          return;
        }
        if (target.allowed !== true) {
          json(res, 403, target);
          return;
        }
        serveFile(req, res, target.path);
        return;
      }
      if (method === 'GET' && route === '/search') {        const query = url.searchParams.get('q') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? 10) || 10;
        const dir = url.searchParams.get('dir') ?? undefined;
        const ext = url.searchParams.get('ext') ?? undefined;
        const days = Number(url.searchParams.get('days') ?? '') || undefined;
        json(res, 200, core.search(query, { limit, dir, ext, days }));
        return;
      }
      if (method === 'GET' && route === '/doc') {
        const rel = url.searchParams.get('rel') ?? '';
        const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
        const limit = Number(url.searchParams.get('limit') ?? 20000) || 20000;
        json(res, 200, core.read({ doc: rel, offset, limit }));
        return;
      }
      if (method === 'GET' && route === '/tree') {
        json(res, 200, core.list({
          dir: url.searchParams.get('dir') ?? '',
          depth: Number(url.searchParams.get('depth') ?? 1) || 1,
          filter: url.searchParams.get('filter') ?? '',
        }));
        return;
      }
      if (route === '/session') {
        if (method === 'GET') {
          const id = url.searchParams.get('id') ?? '';
          json(res, 200, { id, enabled: id.length > 0 ? core.sessionEnabled(id) : false });
          return;
        }
        const body = await readBody(req);
        if (typeof body.id !== 'string' || body.id.length === 0) {
          json(res, 400, { error: '缺少会话 id' });
          return;
        }
        json(res, 200, { id: body.id, enabled: core.setSession(body.id, body.enabled === true) });
        return;
      }
      if (route === '/settings') {
        if (method === 'GET') {
          json(res, 200, { settings: core.settings(), raw: core.rawSettings(), path: core.settings().settingsPath ?? null });
          return;
        }
        const body = await readBody(req);
        const patch = body.patch ?? body;
        const next = core.updateSettings(patch);
        json(res, 200, { settings: next });
        return;
      }
      json(res, 404, { error: `未知接口 ${method} ${route}` });
    } catch (error) {
      logger.warn?.(`dsh-company-kb: 接口 ${method} ${route} 失败：${error.message}`);
      json(res, 400, { error: error.message });
    }
  };

  return webServer.register({ kind: 'prefix', path: base, handler });
}
