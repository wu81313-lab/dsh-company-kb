// 工具层：kb_search / kb_read / kb_list / kb_status / kb_session。
// 输出一律是纯文本，长度有上限（避免一次检索吃掉上下文）。

import { createGate } from './gate.js';
import { openWithSystem } from './open.js';

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('工具参数必须是对象');
  return value;
}

function requireString(value, name, max = 400) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} 必须是非空字符串`);
  return value.trim().slice(0, max);
}

function optionalInt(value, name, min, max) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} 必须是数字`);
  return Math.max(min, Math.min(max, Math.round(number)));
}

function sourceLabel(hit) {
  if (hit.textSource === 'ocr') return '（OCR 识别，个别字符可能有误）';
  if (hit.textSource === 'word') return '（Word 提取）';
  if (hit.textSource === 'metadata') return '（未抽取正文，仅元数据）';
  return '';
}

export function registerTools(ctx, core) {
  const gate = createGate(core);

  const searchTool = {
    name: 'kb_search',
    description: [
      '在用户本地公司知识库（公司资料）里检索资料，用于写项目方案、投标文件、政策核对等场景。',
      '只有本会话已启用知识库时才可用；未启用时会返回一段说明而不是结果。',
      '返回若干命中片段，包含文件相对路径、标题层级、页码与 docId；需要看完整上下文时再用 kb_read。',
      '建议一次用 2-3 种不同措辞各查一次（例如"二维码政策"和"追溯码编码规则"），以提高召回。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索需求，可以是关键词或一句自然语言问题。' },
        limit: { type: 'integer', description: '返回条数，默认 8，最大 20。' },
        dir: { type: 'string', description: '可选：限定在某个子目录内检索，例如"投标文件相关模块"。' },
        ext: { type: 'array', items: { type: 'string' }, description: '可选：限定文件类型，例如[".docx",".pdf"]。' },
      },
      required: ['query'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec) {
      const decision = gate.evaluate(exec.agent);
      if (!decision.allowed) return decision.reason;
      const args = asRecord(raw);
      const query = requireString(args.query, 'query', 600);
      const limit = optionalInt(args.limit, 'limit', 1, 20);
      const dir = typeof args.dir === 'string' ? args.dir.trim().slice(0, 200) : undefined;
      const ext = Array.isArray(args.ext) ? args.ext.filter(item => typeof item === 'string').slice(0, 10) : undefined;
      const result = core.search(query, { limit, dir, ext });
      if (result.hits.length === 0) {
        const stale = result.stale;
        const hint = stale && (stale.changed > 0 || stale.added > 0 || stale.removed > 0)
          ? `（提醒：索引之后有 ${stale.changed + stale.added + stale.removed} 个文件变化，用户可手动同步后重试）`
          : '';
        return `没有命中。查询词：${[...result.plan.phrases, ...result.plan.terms].join(' / ') || query}${hint}\n`
          + '可以换同义词再查，或先用 kb_list 看看目录里有哪些文件。';
      }
      const lines = [
        `命中 ${result.hits.length} 处，覆盖 ${new Set(result.hits.map(hit => hit.rel)).size} 个文件`
        + `（候选 ${result.candidates} 条；查询词：${[...result.plan.phrases, ...result.plan.terms].join(' / ')}）`,
      ];
      result.hits.forEach((hit, index) => {
        const page = hit.page === undefined ? '' : `，第${hit.page}页`;
        const heading = hit.heading ? `，${hit.heading}` : '';
        lines.push('');
        lines.push(`${index + 1}. ${hit.rel}${heading}${page}${sourceLabel(hit)}`);
        // charStart 是该块在整篇正文里的起始位置：直接 kb_read(doc, offset=charStart) 就能跳到命中处
        lines.push(`   docId=${hit.docId}${hit.charStart > 0 ? `｜起始第 ${hit.charStart} 字` : ''}｜片段：${hit.snippet.replace(/\s+/gu, ' ')}`);
      });
      const stale = result.stale;
      if (stale && (stale.changed > 0 || stale.added > 0 || stale.removed > 0)) {
        lines.push('');
        lines.push(`⚠️ 索引之后检测到变化：修改 ${stale.changed}、新增 ${stale.added}、删除 ${stale.removed}。结果可能不是最新，可提醒用户手动同步。`);
      }
      return lines.join('\n');
    },
  };

  const readTool = {
    name: 'kb_read',
    description: [
      '读取知识库里某个文件的抽取正文（分页返回）。',
      'doc 可以传 kb_search/kb_list 返回的相对路径、文件名或 docId。',
      'PDF/图片是 OCR 文本，可能有个别识别错误；未抽取正文的二进制文件只会返回它的完整路径。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        doc: { type: 'string', description: '相对路径、文件名或 docId。' },
        offset: { type: 'integer', description: '起始字符位置，默认 0。' },
        limit: { type: 'integer', description: '读取字符数，默认 12000，最大 40000。' },
        open: { type: 'boolean', description: '可选：用本机默认程序（WPS/Office/PDF 阅读器）打开这个原文件，供用户自己查看或编辑。仅在用户明确要求"打开/用 WPS 打开/我要看原件"时使用。' },
      },
      required: ['doc'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec) {
      const decision = gate.evaluate(exec.agent);
      if (!decision.allowed) return decision.reason;
      const args = asRecord(raw);
      const doc = requireString(args.doc, 'doc', 400);
      if (args.open === true) {
        const target = core.resolveOriginal(doc);
        if (target.found !== true) return target.message;
        if (target.allowed !== true) return target.message;
        try {
          openWithSystem(target.path);
          return `已用系统默认程序打开：${target.rel}\n路径：${target.path}`;
        } catch (error) {
          return `打开失败：${error.message}\n可手动打开：${target.path}`;
        }
      }
      const offset = optionalInt(args.offset, 'offset', 0, 5_000_000) ?? 0;
      const limit = optionalInt(args.limit, 'limit', 200, 40000) ?? 12000;
      const result = core.read({ doc, offset, limit });
      if (result.found !== true) return result.message;
      const header = `${result.rel}｜状态=${result.status}｜来源=${result.textSource}｜总字数=${result.chars}`
        + `${result.pages === undefined ? '' : `｜${result.pages} 页`}`
        + `｜本次返回 ${result.text.length} 字（偏移 ${result.offset}）`;
      if (result.message) return `${header}\n${result.message}`;
      return `${header}\n\n${result.text}`;
    },
  };

  const listTool = {
    name: 'kb_list',
    description: [
      '浏览知识库目录（不检索），列出子目录与文件、大小、抽取字数与状态。',
      '当不确定资料放在哪里、或想确认某个文件是否存在时使用；随后再用 kb_search / kb_read。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: { type: 'string', description: '目录相对路径，留空表示根目录。' },
        depth: { type: 'integer', description: '是否展开子目录汇总：1=只看当前层，2=附带下一层。默认 1。' },
        filter: { type: 'string', description: '可选：按名称片段过滤。' },
      },
      required: [],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec) {
      const decision = gate.evaluate(exec.agent);
      if (!decision.allowed) return decision.reason;
      const args = asRecord(raw);
      const dir = typeof args.dir === 'string' ? args.dir.trim().slice(0, 300) : '';
      const depth = optionalInt(args.depth, 'depth', 1, 3) ?? 1;
      const filter = typeof args.filter === 'string' ? args.filter.trim().slice(0, 100) : '';
      const result = core.list({ dir, depth, filter });
      const lines = [`目录：/${result.dir}${result.dirs.length === 0 && result.files.length === 0 ? '（空）' : ''}`];
      for (const item of result.dirs) lines.push(`  [目录] ${item.dir}（${item.files} 个文件 / ${item.chars} 字）`);
      for (const file of result.files) {
        const kb = file.size >= 1024 * 1024 ? `${(file.size / 1048576).toFixed(1)}MB` : `${Math.round(file.size / 1024)}KB`;
        lines.push(`  [文件] ${file.rel}｜${kb}｜${file.status}${file.chars > 0 ? `｜${file.chars}字` : ''}`
          + `${file.error ? `｜${file.error}` : ''}`);
      }
      return lines.join('\n');
    },
  };

  const statusTool = {
    name: 'kb_status',
    description: [
      '查看知识库状态：文件数、字数、上次同步时间、失败清单、根目录是否可用、是否有变化未同步。',
      'action=now 会在用户明确要求同步时执行增量同步；action=rebuild 全量重建；action=progress 查看正在进行的同步进度。',
      '同步是手动行为：没有用户的明确要求，不要自行调用 now/rebuild。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'now', 'rebuild', 'progress'], description: '默认 status。' },
      },
      required: [],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec) {
      const args = asRecord(raw);
      const action = typeof args.action === 'string' ? args.action : 'status';
      if (action === 'progress') {
        const state = core.progress();
        if (!state.running) {
          const summary = state.summary;
          return summary === null
            ? '当前没有正在进行的同步。'
            : `当前没有正在进行的同步。上次同步：扫描 ${summary.scanned}，新增 ${summary.added}，更新 ${summary.updated}，删除 ${summary.removed}，失败 ${summary.failed}，耗时 ${summary.durationMs}ms。`;
        }
        return `同步进行中：阶段 ${state.phase}，进度 ${state.done}/${state.total}，当前：${state.current || '—'}`;
      }
      if (action === 'now' || action === 'rebuild') {
        const decision = gate.evaluate(exec.agent, { requireSync: true });
        if (!decision.allowed) return decision.reason;
        if (!decision.syncAllowed) {
          return '需要用户明确要求同步才执行（例如"同步一下知识库"）。如果只是查看状态，用 action=status。';
        }
        const state = core.progress();
        if (state.running) {
          return `已有同步在进行：阶段 ${state.phase}，进度 ${state.done}/${state.total}，当前 ${state.current || '—'}。`;
        }
        const estimate = core.staleness({ force: true });
        const pending = (estimate?.changed ?? 0) + (estimate?.added ?? 0) + (estimate?.removed ?? 0);
        const built = core.store.stats().docs > 0;
        if (!built || action === 'rebuild' || pending > 5) {
          void core.sync(action === 'rebuild' ? 'rebuild' : 'now').catch(() => { /* 摘要会写入 sync_log */ });
          return `已开始后台同步（${action === 'rebuild' ? '全量重建' : '增量'}，预计处理 ${pending} 个变化${built ? '' : '，首次建库需要 1-5 分钟'}）。`
            + '同步期间检索仍可用，只是结果可能不是最新；可用 kb_status action=progress 查看进度，完成后新的内容即可检索到。';
        }
        const summary = await core.sync('now');
        return [
          `同步完成：扫描 ${summary.scanned}，新增 ${summary.added}，更新 ${summary.updated}，删除 ${summary.removed}，跳过 ${summary.skipped}，失败 ${summary.failed}，耗时 ${summary.durationMs}ms。`,
          summary.errors.length > 0 ? `问题：${summary.errors.slice(0, 5).join(' | ')}` : '',
        ].filter(Boolean).join('\n');
      }

      const status = core.status();
      const last = status.lastSyncAt === null ? '从未同步' : new Date(status.lastSyncAt).toLocaleString('zh-CN');
      const webApiState = status.webApi?.state;
      const webApiText = webApiState === 'registered'
        ? `已注册（${status.webApi.path}）`
        : webApiState === 'disabled' ? '已按设置关闭'
          : webApiState === 'no-service' ? '未注册：运行时没有 webServer 服务'
            : webApiState === 'failed' ? `注册失败：${status.webApi.error}`
              : '未知（本进程未自检）';
      const lines = [
        `索引：${status.built ? '已建立' : '尚未建立（需要用户手动同步）'}`,
        `文档 ${status.stats.docs} 个｜块 ${status.stats.chunks} 个｜字符 ${status.stats.chars.toLocaleString('en-US')}｜上次同步 ${last}`,
        `面板接口：${webApiText}`,
        `来源分布：${status.stats.bySource.map(item => `${item.source}=${item.n}`).join('  ')}`,
        `类型分布：${status.stats.byExt.slice(0, 12).map(item => `${item.ext || '(无)'}=${item.n}`).join('  ')}`,
        `根目录：${status.roots.map(item => `${item.path}${item.ok ? '' : '（不可访问）'}`).join('；') || '（未配置）'}`,
        `OCR 能力：${status.capabilities === null ? '未探测' : `可用=${status.capabilities.ocr === true}，语言=${(status.capabilities.ocrLangs ?? []).join('/') || '未知'}`}`,
      ];
      if (status.stale !== null && status.stale !== undefined) {
        lines.push(`体检：修改 ${status.stale.changed}、新增 ${status.stale.added}、删除 ${status.stale.removed}`
          + `${status.stale.unreachable ? '（部分根目录不可访问）' : ''}`);
      }
      if (core.progress().running) {
        const state = core.progress();
        lines.push(`正在同步：阶段 ${state.phase}，进度 ${state.done}/${state.total}`);
      }
      if (status.stats.failures.length > 0) {
        lines.push(`未抽取正文的文件（最多列 10 个）：`);
        for (const failure of status.stats.failures.slice(0, 10)) {
          lines.push(`  - [${failure.status}] ${failure.rel}${failure.error ? ` :: ${failure.error}` : ''}`);
        }
      }
      return lines.join('\n');
    },
  };

  const sessionTool = {
    name: 'kb_session',
    description: [
      '打开或关闭"本会话的知识库"。on=本会话启用（等同用户点名），off=关闭，status=查看当前状态。',
      '只有在用户明确要求打开或关闭时才调用；不要为了让检索可用而自行打开。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['on', 'off', 'status'], description: '默认 status。' },
      },
      required: [],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw, exec) {
      const args = asRecord(raw);
      const action = typeof args.action === 'string' ? args.action : 'status';
      const sessionId = exec.agent?.session?.id;
      if (sessionId === undefined) throw new Error('无法确定当前会话 id');
      const decision = gate.evaluate(exec.agent);
      if (action === 'status') {
        return `本会话知识库：${core.sessionEnabled(sessionId) ? '已启用' : '未启用'}`
          + `${decision.requested && decision.enabled ? '（本轮用户消息已点名，已自动启用）' : ''}`;
      }
      // 打开/关闭都要有用户意图：开启允许由点名触发；关闭需要用户明说关闭。
      if (action === 'on') {
        if (core.settings().explicitOnly !== false && !decision.requested && !core.sessionEnabled(sessionId)) {
          return '用户没有在本轮要求启用知识库，因此没有打开。可以提示用户直接点名，或使用输入框右侧的「知识库」开关。';
        }
        core.setSession(sessionId, true);
        return '已启用本会话知识库。可以直接用 kb_search 检索了。';
      }
      core.setSession(sessionId, false);
      return '已关闭本会话知识库（后续检索请求会被拒绝）。';
    },
  };

  const tools = [searchTool, readTool, listTool, statusTool, sessionTool];
  const disposers = tools.map(tool => ctx.tools.register(tool));
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* fiber 卸载时可能已释放 */ }
    }
  };
}
