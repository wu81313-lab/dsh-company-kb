// pptx 抽取：按 slide 顺序取 <a:t> 文本，每个段落独立成块。

import { readZip, decodeXml } from './zip.js';

export function extractPptx(buffer) {
  const zip = readZip(buffer);
  const blocks = [];
  const slideNames = zip.names()
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => {
      const a = Number(/slide(\d+)/u.exec(left)?.[1] ?? 0);
      const b = Number(/slide(\d+)/u.exec(right)?.[1] ?? 0);
      return a - b;
    });

  for (const name of slideNames) {
    const index = Number(/slide(\d+)/u.exec(name)?.[1] ?? 0);
    const xml = zip.readText(name) ?? '';
    blocks.push({ kind: 'heading', level: 2, text: `幻灯片 ${index}` });
    for (const paragraph of xml.split(/<a:p\b[^>]*>/u).slice(1)) {
      const text = [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1])).join('').trim();
      if (text.length > 0) blocks.push({ kind: 'para', text });
    }
  }

  if (zip.has('ppt/notesSlides/notesSlide1.xml')) {
    for (const name of zip.names().filter(item => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(item)).sort()) {
      const xml = zip.readText(name) ?? '';
      const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1])).join(' ').trim();
      if (text.length > 0) blocks.push({ kind: 'para', text: `备注：${text}` });
    }
  }

  return { blocks, meta: { slides: slideNames.length, warnings: slideNames.length === 0 ? ['pptx 未找到幻灯片'] : [] } };
}
