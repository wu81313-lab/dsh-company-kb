// 分块：把抽取出来的块（标题/段落/页码标记）切成带标题面包屑的检索单元。
//
// 为什么分块要带 heading：检索结果要能告诉模型"这是《XX方案》第 4.2 节系统架构里的
// 一段"，模型才敢引用；同时 heading 单独进一列索引，命中标题的块会被加权。

const HEADING_PATTERNS = [
  /^(第[一二三四五六七八九十百]+[章节部分篇])\s*(.{0,60})$/u,
  /^([一二三四五六七八九十]+[、.．])\s*(.{0,60})$/u,
  /^(（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\))\s*(.{0,60})$/u,
  /^(\d+(?:\.\d+){0,3})[、.．\s]\s*(.{0,60})$/u,
];

/** 文本行是否像标题（用于 txt/md 这类没有样式信息的来源）。 */
export function detectHeadingLevel(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return 0;
  const markdown = /^(#{1,6})\s+\S/u.exec(trimmed);
  if (markdown !== null) return markdown[1].length;
  for (const pattern of HEADING_PATTERNS) {
    if (pattern.test(trimmed)) return 2;
  }
  return 0;
}

/** 把连续文本（无结构来源）转成块序列。 */
export function textToBlocks(rawText) {
  const blocks = [];
  for (const line of rawText.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;
    const level = detectHeadingLevel(text);
    blocks.push(level > 0 ? { kind: 'heading', level, text } : { kind: 'para', text });
  }
  return blocks;
}

export function blocksToText(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.kind === 'page') out.push(`【第${block.n}页】`);
    else if (block.kind === 'heading') out.push(`${'#'.repeat(Math.max(1, Math.min(6, block.level ?? 2)))} ${block.text}`);
    else out.push(block.text);
  }
  return out.join('\n');
}

/**
 * 切块：优先在标题处断开，其次按段落累积到 chunkChars，超长段落按句子切。
 * 相邻块之间保留 chunkOverlap 字符重叠，避免答案被切断。
 */
export function chunkBlocks(blocks, { chunkChars = 900, chunkOverlap = 150 } = {}) {
  const chunks = [];
  const stack = [];
  let buffer = '';
  let heading = '';
  let page = undefined;
  let chunkPage = undefined;

  const pushChunk = (force = false) => {
    const text = buffer.trim();
    buffer = '';
    if (text.length === 0) return;
    if (!force && text.length < 40 && chunks.length > 0) {
      // 太短的尾块并回上一块，避免出现只有一行字的检索单元
      const last = chunks[chunks.length - 1];
      if (last.text.length + text.length <= chunkChars * 1.5) {
        last.text = `${last.text}\n${text}`;
        return;
      }
    }
    chunks.push({
      ord: chunks.length,
      heading: heading.slice(0, 300),
      page: chunkPage ?? page,
      text,
    });
    if (chunkOverlap > 0 && text.length > chunkOverlap) {
      buffer = text.slice(-chunkOverlap);
    }
  };

  const appendText = (text) => {
    if (text.length > chunkChars * 3) {
      // 超长段落：按句子切开后逐段塞入
      const sentences = text.split(/(?<=[。！？；!?;])/u);
      for (const sentence of sentences) {
        if (buffer.length + sentence.length > chunkChars && buffer.length > 0) pushChunk();
        buffer += sentence;
      }
      return;
    }
    if (buffer.length > 0) buffer += '\n';
    buffer += text;
    if (buffer.length >= chunkChars) pushChunk();
  };

  const headingTexts = [];
  for (const block of blocks) {
    if (block.kind === 'page') {
      page = block.n;
      if (buffer.trim().length > 0) pushChunk();
      chunkPage = page;
      continue;
    }
    if (block.kind === 'heading') {
      if (buffer.trim().length > 0) pushChunk();
      const level = Math.max(1, Math.min(6, block.level ?? 2));
      stack.length = level - 1;
      stack[level - 1] = block.text;
      heading = stack.filter(Boolean).join(' / ');
      headingTexts.push(block.text);
      chunkPage = page;
      continue;
    }
    if (chunkPage === undefined) chunkPage = page;
    appendText(block.text);
  }
  if (buffer.trim().length > 0) pushChunk(true);
  // 只有标题、没有正文的文档（例如只剩章节大纲、或整篇是图片），
  // 至少把标题本身做成一个块，否则整个文件会变成"未解析出文本"。
  if (chunks.length === 0 && headingTexts.length > 0) {
    chunks.push({
      ord: 0,
      heading: headingTexts.join(' / ').slice(0, 300),
      page: chunkPage,
      text: headingTexts.join('\n'),
    });
  }
  return chunks.filter(chunk => chunk.text.trim().length > 0);
}
