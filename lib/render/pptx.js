// pptx → 分页卡片（面板内预览用）。
//
// 每张幻灯片渲染成一张卡片：标题（第一个占位符的文字）、正文要点、图片
// （按 slide 的关系文件取 ppt/media/*），备注单独放在卡片底部。
// 不还原：主题配色与母版版式、动画、SmartArt/图表、精确的坐标排版。
// 目标是"一眼看清这页讲了什么"，而不是像素级还原。

import { readZip, decodeXml } from '../extract/zip.js';

const escapeHtml = text => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const EMU_TO_PX = 1 / 9525;

function attr(xml, name) {
  const match = new RegExp(`${name}="([^"]*)"`, 'u').exec(xml);
  return match === null ? undefined : match[1];
}

/** slide 的关系文件：rId → ppt/media/xxx */
function slideRels(zip, slideFile) {
  const base = slideFile.replace(/^ppt\//u, '').replace(/\.xml$/u, '');
  const xml = zip.readText(`ppt/slides/_rels/${base.split('/').pop()}.xml.rels`);
  const rels = new Map();
  if (xml === undefined) return rels;
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/gu)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    if (id === undefined || target === undefined) continue;
    const clean = target.replace(/^\.\.\//u, '').replace(/^\.\//u, '');
    rels.set(id, clean.startsWith('ppt/') ? clean : `ppt/${clean.replace(/^media\//u, 'media/')}`);
  }
  return rels;
}

/** 幻灯片里的形状：每个 <p:sp> 是一段文字块，<p:pic> 是图片。 */
function slideBlocks(xml, rels, mediaUrl) {
  const blocks = [];
  const shapePattern = /<p:sp>([\s\S]*?)<\/p:sp>|<p:pic>([\s\S]*?)<\/p:pic>/gu;
  for (const match of xml.matchAll(shapePattern)) {
    if (match[2] !== undefined) {
      const relId = attr(match[2], 'r:embed');
      const target = relId === undefined ? undefined : rels.get(relId);
      if (target !== undefined && /\.(png|jpe?g|gif|bmp|webp|emf|wmf)$/iu.test(target)) {
        blocks.push({ kind: 'image', src: mediaUrl(target) });
      }
      continue;
    }
    const shape = match[1];
    const paragraphs = [];
    for (const para of shape.matchAll(/<a:p>([\s\S]*?)<\/a:p>/gu)) {
      const text = [...para[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(item => decodeXml(item[1])).join('').trim();
      if (text.length > 0) paragraphs.push(text);
    }
    if (paragraphs.length > 0) blocks.push({ kind: 'text', paragraphs });
  }
  return blocks;
}

export function renderPptxHtml(buffer, mediaUrl, { highlight = text => text } = {}) {
  const zip = readZip(buffer);
  const slideNames = zip.names()
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => Number(/slide(\d+)/u.exec(left)?.[1] ?? 0) - Number(/slide(\d+)/u.exec(right)?.[1] ?? 0));

  const notes = new Map();
  for (const name of zip.names().filter(item => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(item))) {
    const index = Number(/notesSlide(\d+)/u.exec(name)?.[1] ?? 0);
    const xml = zip.readText(name) ?? '';
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(item => decodeXml(item[1])).join(' ').trim();
    if (text.length > 0 && !/^\d+$/u.test(text)) notes.set(index, text);
  }

  const cards = [];
  slideNames.forEach((name, position) => {
    const index = Number(/slide(\d+)/u.exec(name)?.[1] ?? position + 1);
    const xml = zip.readText(name) ?? '';
    const rels = slideRels(zip, name);
    const blocks = slideBlocks(xml, rels, mediaUrl);

    const firstText = blocks.find(block => block.kind === 'text');
    const title = firstText === undefined ? '' : (firstText.paragraphs[0] ?? '');
    const body = [];
    let seenTitle = false;
    for (const block of blocks) {
      if (block.kind === 'image') {
        body.push(`<figure><img src="${escapeHtml(block.src)}" alt=""></figure>`);
        continue;
      }
      const items = [];
      for (const paragraph of block.paragraphs) {
        if (!seenTitle && paragraph === title) {
          seenTitle = true;
          continue;
        }
        items.push(`<li>${highlight(escapeHtml(paragraph))}</li>`);
      }
      if (items.length > 0) body.push(`<ul>${items.join('')}</ul>`);
    }

    const note = notes.get(index);
    cards.push(`<section class="slide"><header><span class="no">${position + 1}</span>`
      + `<h2>${title.length > 0 ? highlight(escapeHtml(title)) : `幻灯片 ${index}`}</h2></header>`
      + (body.length > 0 ? body.join('') : '<p class="note">（本页没有可提取的文字）</p>')
      + (note === undefined ? '' : `<p class="note">备注：${escapeHtml(note)}</p>`)
      + '</section>');
  });

  if (cards.length === 0) return { html: '<p class="note">这个文件里没有找到幻灯片。</p>', stats: { slides: 0, bytes: buffer.length } };
  return { html: cards.join(''), stats: { slides: cards.length, bytes: buffer.length } };
}
