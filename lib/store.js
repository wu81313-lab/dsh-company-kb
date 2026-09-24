// 索引库：SQLite（node:sqlite）+ 双 FTS5 索引 + RRF 融合检索。
//
// 双索引的原因（实测）：unicode61 不切中文，原文直索会漏；trigram 能子串匹配但
// 对 2 字查询的 MATCH 无效。所以
//   chunk_fts(seg, head_seg, path_seg) ← 分词后的文本，负责词级 BM25 排序
//   chunk_tri(text)                    ← 原文，负责子串（>=3 字走 MATCH，2 字走 LIKE）
// 两路结果用 RRF 融合（只看名次，避免 BM25 与子串两种量纲直接相加）。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { escapeTerm, segmentForIndex } from './segment.js';

const SCHEMA_VERSION = 1;
const RRF_K = 60;

function likeEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function windowSnippet(text, terms, phrases, size = 420) {
  const normalized = text.replace(/\s+/gu, ' ');
  const needles = [...phrases, ...terms].filter(Boolean);
  let at = -1;
  let needle = '';
  for (const candidate of needles) {
    const index = normalized.toLowerCase().indexOf(String(candidate).toLowerCase());
    if (index >= 0 && (at === -1 || index < at)) {
      at = index;
      needle = candidate;
    }
  }
  let slice;
  if (at === -1) {
    slice = normalized.slice(0, size);
  } else {
    const start = Math.max(0, at - Math.floor(size / 3));
    slice = normalized.slice(start, start + size);
    if (start > 0) slice = `…${slice}`;
    if (start + size < normalized.length) slice = `${slice}…`;
  }
  // 命中词加「」，便于模型快速定位；只标注实际出现过的词。
  for (const candidate of needles.slice(0, 12)) {
    if (candidate.length < 2) continue;
    const index = slice.toLowerCase().indexOf(String(candidate).toLowerCase());
    if (index === -1) continue;
    slice = `${slice.slice(0, index)}「${slice.slice(index, index + candidate.length)}」${slice.slice(index + candidate.length)}`;
  }
  return slice;
}

export function openStore({ databasePath, logger = console }) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        rel TEXT NOT NULL,
        dir TEXT NOT NULL,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        sha1 TEXT,
        kind TEXT NOT NULL DEFAULT 'binary',
        text_source TEXT NOT NULL DEFAULT 'native',
        chars INTEGER NOT NULL DEFAULT 0,
        pages INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        indexed_at INTEGER NOT NULL DEFAULT 0,
        tries INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS docs_dir ON docs(dir);
      CREATE INDEX IF NOT EXISTS docs_status ON docs(status);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        page INTEGER,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id, ord);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        seg, head_seg, path_seg, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_tri USING fts5(text, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run('schemaVersion', String(SCHEMA_VERSION));
  }

  const getMeta = (key) => {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
    return row === undefined ? undefined : String(row.v);
  };
  const setMeta = (key, value) => {
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, String(value));
  };

  const listDocuments = () => db.prepare(
    'SELECT id, path, rel, dir, name, ext, size, mtime, sha1, kind, text_source, chars, pages, status, error, indexed_at, tries FROM docs',
  ).all();

  const findDocument = (path) => db.prepare('SELECT * FROM docs WHERE path = ?').get(path) ?? undefined;

  function upsertDocument(doc, chunks, { trigram = true } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT id FROM docs WHERE path = ?').get(doc.path);
      let docId;
      if (existing === undefined) {
        const result = db.prepare(`
          INSERT INTO docs (path, rel, dir, name, ext, size, mtime, sha1, kind, text_source, chars, pages, status, error, indexed_at, tries)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          doc.path, doc.rel, doc.dir, doc.name, doc.ext, doc.size, doc.mtime, doc.sha1 ?? null,
          doc.kind, doc.textSource ?? 'native', doc.chars ?? 0, doc.pages ?? null,
          doc.status ?? 'indexed', doc.error ?? null, Date.now(), doc.tries ?? 0,
        );
        docId = Number(result.lastInsertRowid);
      } else {
        docId = Number(existing.id);
        db.prepare(`
          UPDATE docs SET rel = ?, dir = ?, name = ?, ext = ?, size = ?, mtime = ?, sha1 = ?,
            kind = ?, text_source = ?, chars = ?, pages = ?, status = ?, error = ?, indexed_at = ?, tries = ?
          WHERE id = ?
        `).run(
          doc.rel, doc.dir, doc.name, doc.ext, doc.size, doc.mtime, doc.sha1 ?? null,
          doc.kind, doc.textSource ?? 'native', doc.chars ?? 0, doc.pages ?? null,
          doc.status ?? 'indexed', doc.error ?? null, Date.now(), doc.tries ?? 0, docId,
        );
        db.prepare('DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId);
        db.prepare('DELETE FROM chunk_tri WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId);
        db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
      }

      const insertChunk = db.prepare('INSERT INTO chunks (doc_id, ord, heading, page, text) VALUES (?, ?, ?, ?, ?)');
      const insertFts = db.prepare('INSERT INTO chunk_fts (rowid, seg, head_seg, path_seg) VALUES (?, ?, ?, ?)');
      const insertTri = db.prepare('INSERT INTO chunk_tri (rowid, text) VALUES (?, ?)');
      const pathSeg = segmentForIndex(`${doc.rel} ${doc.name}`);
      for (const chunk of chunks) {
        const result = insertChunk.run(docId, chunk.ord, chunk.heading ?? '', chunk.page ?? null, chunk.text);
        const chunkId = Number(result.lastInsertRowid);
        insertFts.run(chunkId, segmentForIndex(chunk.text), segmentForIndex(chunk.heading ?? ''), pathSeg);
        if (trigram) insertTri.run(chunkId, chunk.text);
      }
      return docId;
    } finally {
      db.exec('COMMIT');
    }
  }

  function deleteDocument(path) {
    const row = db.prepare('SELECT id FROM docs WHERE path = ?').get(path);
    if (row === undefined) return false;
    const docId = Number(row.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId);
      db.prepare('DELETE FROM chunk_tri WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)').run(docId);
      db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
      db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
      return true;
    } finally {
      db.exec('COMMIT');
    }
  }

  function clearAll() {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM chunk_fts');
      db.exec('DELETE FROM chunk_tri');
      db.exec('DELETE FROM chunks');
      db.exec('DELETE FROM docs');
      return true;
    } finally {
      db.exec('COMMIT');
    }
  }

  function buildFilters({ dir, ext }) {
    const where = [];
    const args = [];
    if (typeof dir === 'string' && dir.trim().length > 0) {
      const prefix = dir.trim().replace(/^[./\\]+|[./\\]+$/gu, '').replaceAll('\\', '/');
      where.push("(d.dir = ? OR d.dir LIKE ? ESCAPE '\\')");
      args.push(prefix, `${likeEscape(prefix)}/%`);
    }
    if (Array.isArray(ext) && ext.length > 0) {
      where.push(`d.ext IN (${ext.map(() => '?').join(',')})`);
      args.push(...ext.map(item => String(item).toLowerCase()));
    }
    return { sql: where.length === 0 ? '' : ` AND ${where.join(' AND ')}`, args };
  }

  /** 检索：A 路词级 BM25 + B 路子串 → RRF 融合 → 加权重排 → 每文件去重。 */
  function search(plan, { limit = 8, maxPerDoc = 3, dir, ext, candidateLimit = 80 } = {}) {
    const filters = buildFilters({ dir, ext });
    const ranked = new Map(); // chunkId -> { rankA, rankB, docId }
    const addRank = (chunkId, docId, path, position) => {
      const current = ranked.get(chunkId) ?? { docId: Number(docId), path, rankA: null, rankB: null };
      if (path === 'A' && current.rankA === null) current.rankA = position;
      if (path === 'B' && current.rankB === null) current.rankB = position;
      ranked.set(chunkId, current);
    };

    if (plan.fts.length > 0) {
      try {
        const rows = db.prepare(`
          SELECT c.id AS chunk_id, c.doc_id AS doc_id, d.path AS path
          FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid JOIN docs d ON d.id = c.doc_id
          WHERE chunk_fts MATCH ?${filters.sql}
          ORDER BY bm25(chunk_fts, 4.0, 2.0, 1.5)
          LIMIT ?
        `).all(plan.fts, ...filters.args, candidateLimit);
        rows.forEach((row, index) => addRank(Number(row.chunk_id), row.doc_id, 'A', index));
      } catch (error) {
        logger.warn?.(`dsh-company-kb: 词级检索失败（${error.message}），继续用子串检索`);
      }
    }

    const runTri = (sql, arg) => {
      try {
        const rows = db.prepare(sql).all(arg, ...filters.args, candidateLimit);
        rows.forEach((row, index) => addRank(Number(row.chunk_id), row.doc_id, 'B', index));
      } catch (error) {
        logger.warn?.(`dsh-company-kb: 子串检索失败（${error.message}）`);
      }
    };
    const triSql = `
      SELECT c.id AS chunk_id, c.doc_id AS doc_id, d.path AS path
      FROM chunk_tri JOIN chunks c ON c.id = chunk_tri.rowid JOIN docs d ON d.id = c.doc_id
      WHERE chunk_tri MATCH ?${filters.sql} LIMIT ?`;
    const likeSql = `
      SELECT c.id AS chunk_id, c.doc_id AS doc_id, d.path AS path
      FROM chunk_tri JOIN chunks c ON c.id = chunk_tri.rowid JOIN docs d ON d.id = c.doc_id
      WHERE chunk_tri.text LIKE ? ESCAPE '\\'${filters.sql} LIMIT ?`;
    for (const term of plan.tri) runTri(triSql, escapeTerm(term));
    for (const term of plan.like) {
      const pattern = `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      runTri(likeSql, pattern);
    }

    if (ranked.size === 0) return { hits: [], candidates: 0 };

    const ids = [...ranked.keys()];
    const rows = db.prepare(`
      SELECT c.id AS chunk_id, c.ord AS ord, c.heading AS heading, c.page AS page, c.text AS text,
             (SELECT COALESCE(SUM(LENGTH(c2.text)), 0) FROM chunks c2
               WHERE c2.doc_id = c.doc_id AND c2.ord < c.ord) AS char_start,
             d.id AS doc_id, d.rel AS rel, d.path AS path, d.name AS name, d.dir AS dir, d.ext AS ext,
             d.kind AS kind, d.text_source AS text_source, d.mtime AS mtime, d.status AS status
      FROM chunks c JOIN docs d ON d.id = c.doc_id
      WHERE c.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);

    const byId = new Map(rows.map(row => [Number(row.chunk_id), row]));
    const scored = [];
    for (const [chunkId, info] of ranked) {
      const row = byId.get(chunkId);
      if (row === undefined) continue;
      let score = 0;
      if (info.rankA !== null) score += 1 / (RRF_K + info.rankA + 1);
      if (info.rankB !== null) score += 1 / (RRF_K + info.rankB + 1);
      const text = String(row.text);
      const lower = text.toLowerCase();
      for (const phrase of plan.phrases) if (phrase.length >= 2 && lower.includes(phrase.toLowerCase())) score += 0.02;
      if (plan.terms.length > 1 && plan.terms.every(term => lower.includes(String(term).toLowerCase()))) score += 0.012;
      const headingLower = `${row.heading} ${row.rel}`.toLowerCase();
      if (plan.terms.some(term => headingLower.includes(String(term).toLowerCase()))) score += 0.008;
      if (text.length > 1600) score -= 0.004;
      scored.push({ row, score, chunkId });
    }
    scored.sort((left, right) => right.score - left.score);

    const perDoc = new Map();
    const hits = [];
    for (const item of scored) {
      const docId = Number(item.row.doc_id);
      const used = perDoc.get(docId) ?? 0;
      if (used >= maxPerDoc) continue;
      perDoc.set(docId, used + 1);
      hits.push({
        docId,
        rel: String(item.row.rel),
        path: String(item.row.path),
        name: String(item.row.name),
        dir: String(item.row.dir),
        ext: String(item.row.ext),
        kind: String(item.row.kind),
        textSource: String(item.row.text_source),
        status: String(item.row.status),
        mtime: Number(item.row.mtime),
        ord: Number(item.row.ord),
        heading: String(item.row.heading ?? ''),
        // 该块在整篇抽取正文里的起始位置：面板据此把预览直接定位到命中处，
        // 工具侧也能用它做 kb_read(doc, offset=…)
        charStart: Number(item.row.char_start ?? 0),
        page: item.row.page === null || item.row.page === undefined ? undefined : Number(item.row.page),
        score: Number(item.score.toFixed(6)),
        snippet: windowSnippet(String(item.row.text), plan.terms, plan.phrases),
      });
      if (hits.length >= limit) break;
    }
    return { hits, candidates: ranked.size };
  }

  function getDocument(key) {
    const numeric = Number(key);
    const row = Number.isInteger(numeric) && String(numeric) === String(key).trim()
      ? db.prepare('SELECT * FROM docs WHERE id = ?').get(numeric)
      : db.prepare('SELECT * FROM docs WHERE rel = ? OR name = ? OR path = ? ORDER BY (rel = ?) DESC LIMIT 1')
        .get(String(key), String(key), String(key), String(key));
    return row ?? undefined;
  }

  function readDocumentText(docId, offset = 0, limit = 12000) {
    const rows = db.prepare('SELECT ord, heading, page, text FROM chunks WHERE doc_id = ? ORDER BY ord').all(docId);
    if (rows.length === 0) return { text: '', total: 0, parts: [] };
    const full = rows.map(row => {
      const head = row.heading ? `【${row.heading}】\n` : '';
      const page = row.page === null || row.page === undefined ? '' : `【第${row.page}页】\n`;
      return `${head}${page}${row.text}`;
    }).join('\n\n');
    const start = Math.max(0, Math.min(offset, full.length));
    const end = Math.max(start, Math.min(start + limit, full.length));
    return {
      text: full.slice(start, end),
      total: full.length,
      offset: start,
      limit,
      parts: rows.map(row => ({ ord: Number(row.ord), heading: String(row.heading ?? ''), page: row.page === null || row.page === undefined ? undefined : Number(row.page) })),
    };
  }

  function listDir({ dir = '', depth = 1, filter = '' } = {}) {
    const base = String(dir ?? '').replace(/^[./\\]+|[./\\]+$/gu, '').replaceAll('\\', '/');
    const filterLike = filter ? `%${likeEscape(filter)}%` : null;
    const files = db.prepare(`
      SELECT rel, name, ext, size, chars, status, error, kind, text_source, pages
      FROM docs WHERE dir = ?${filterLike === null ? '' : " AND (name LIKE ? ESCAPE '\\' OR rel LIKE ? ESCAPE '\\')"}
      ORDER BY name
    `).all(...(filterLike === null ? [base] : [base, filterLike, filterLike]));

    // 子目录必须无条件返回直接子目录：depth 控制"往下展开几层"，而不是"要不要列目录"。
    // （曾经的实现把 depth=1 当成"只列文件"，结果根目录下没有任何直接文件时，
    //   面板的「目录」和 kb_list 都显示"这个目录是空的"——资料其实都在子目录里。）
    const maxDepth = Math.max(1, Math.min(5, Number(depth) || 1));
    const prefix = base.length === 0 ? '' : `${base}/`;
    const rows = db.prepare(`
      SELECT dir, COUNT(*) AS files, SUM(chars) AS chars FROM docs
      WHERE (? = '' OR dir LIKE ? ESCAPE '\\') GROUP BY dir
    `).all(base, `${likeEscape(prefix)}%`);
    const aggregated = new Map();
    for (const row of rows) {
      const full = String(row.dir);
      const rest = full.slice(prefix.length);
      if (rest.length === 0) continue; // 本目录自己的文件，不属于子目录
      const parts = rest.split('/');
      const key = parts.length > maxDepth ? `${prefix}${parts.slice(0, maxDepth).join('/')}` : full;
      const current = aggregated.get(key) ?? { dir: key, files: 0, chars: 0 };
      current.files += Number(row.files);
      current.chars += Number(row.chars ?? 0);
      aggregated.set(key, current);
    }
    const dirs = [...aggregated.values()].sort((left, right) => left.dir.localeCompare(right.dir, 'zh'));

    return {
      dir: base,
      dirs,
      files: files.map(row => ({
        rel: String(row.rel),
        name: String(row.name),
        ext: String(row.ext),
        size: Number(row.size),
        chars: Number(row.chars),
        pages: row.pages === null || row.pages === undefined ? undefined : Number(row.pages),
        status: String(row.status),
        error: row.error === null || row.error === undefined ? undefined : String(row.error),
        kind: String(row.kind),
        textSource: String(row.text_source),
      })),
    };
  }

  function stats() {
    const totals = db.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(chars), 0) AS chars FROM docs').get();
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
    const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM docs GROUP BY status ORDER BY n DESC').all();
    const byExt = db.prepare('SELECT ext, COUNT(*) AS n, COALESCE(SUM(chars), 0) AS chars FROM docs GROUP BY ext ORDER BY n DESC').all();
    const bySource = db.prepare('SELECT text_source, COUNT(*) AS n FROM docs GROUP BY text_source ORDER BY n DESC').all();
    const failures = db.prepare(`
      SELECT rel, status, error, size, indexed_at FROM docs
      WHERE status IN ('error', 'needs_ocr', 'needs_conversion')
      ORDER BY indexed_at DESC LIMIT 50
    `).all();
    let databaseBytes = 0;
    try {
      databaseBytes = statSync(databasePath).size;
      const wal = `${databasePath}-wal`;
      if (existsSync(wal)) databaseBytes += statSync(wal).size;
    } catch { /* 文件可能刚被重建 */ }
    return {
      docs: Number(totals.docs),
      chars: Number(totals.chars),
      chunks: Number(chunks.n),
      databaseBytes,
      byStatus: byStatus.map(row => ({ status: String(row.status), n: Number(row.n) })),
      byExt: byExt.map(row => ({ ext: String(row.ext), n: Number(row.n), chars: Number(row.chars) })),
      bySource: bySource.map(row => ({ source: String(row.text_source), n: Number(row.n) })),
      failures: failures.map(row => ({
        rel: String(row.rel),
        status: String(row.status),
        error: row.error === null || row.error === undefined ? undefined : String(row.error),
        size: Number(row.size),
      })),
    };
  }

  const sessionGet = (sessionId) => {
    const row = db.prepare('SELECT enabled FROM session_state WHERE session_id = ?').get(String(sessionId));
    return row === undefined ? undefined : Number(row.enabled) === 1;
  };
  const sessionSet = (sessionId, enabled) => {
    db.prepare(`
      INSERT INTO session_state(session_id, enabled, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(String(sessionId), enabled ? 1 : 0, Date.now());
  };
  const logSync = (level, message) => {
    db.prepare('INSERT INTO sync_log(ts, level, message) VALUES(?, ?, ?)').run(Date.now(), level, String(message).slice(0, 4000));
    db.prepare('DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 500)').run();
  };
  const recentLogs = (limit = 30) => db.prepare('SELECT ts, level, message FROM sync_log ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map(row => ({ ts: Number(row.ts), level: String(row.level), message: String(row.message) }));

  return {
    db,
    migrate,
    getMeta,
    setMeta,
    listDocuments,
    findDocument,
    upsertDocument,
    deleteDocument,
    clearAll,
    search,
    getDocument,
    readDocumentText,
    listDir,
    stats,
    sessionGet,
    sessionSet,
    logSync,
    recentLogs,
    close: () => db.close(),
    databasePath,
  };
}
