// 文档预览渲染单测：用现造的 docx / xlsx / pptx 跑真实渲染路径。
//   - docx：标题、加粗、表格、图片、自闭合 <w:p/> 不再吞掉后面的段落
//   - xlsx：多工作表、合并单元格、日期/百分比/千分位数字格式
//   - pptx：分页卡片、标题与要点、内嵌图片
//   - 安全：文档里的 HTML/脚本必须被转义

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDocxHtml } from '../lib/render/docx.js';
import { renderXlsxHtml } from '../lib/render/xlsx.js';
import { renderPptxHtml } from '../lib/render/pptx.js';
import { renderDocumentHtml } from '../lib/render/index.js';
import { makeZip, TINY_PNG } from './helpers/zip-writer.mjs';

const media = name => `/company-kb-api/media?rel=x.docx&name=${encodeURIComponent(name)}`;

function makeDocx(documentXml, extra = {}) {
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${documentXml}</w:body></w:document>`,
    ...extra,
  });
}

test('docx：标题、加粗、表格、图片都渲染出来', () => {
  const docx = makeDocx(
    '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>第一章 项目概述</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>普通正文，含</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>加粗</w:t></w:r><w:r><w:t>与结束。</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>设备</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12345</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:drawing><wp:extent cx="1905000" cy="952500"/><a:blip r:embed="rId9"/></w:drawing></w:r></w:p>',
    {
      'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships>'
        + '<Relationship Id="rId9" Type="image" Target="media/image1.png"/></Relationships>',
      'word/media/image1.png': TINY_PNG,
    },
  );

  const { html, stats } = renderDocxHtml(docx, media);
  assert.match(html, /<h2[^>]*>第一章 项目概述<\/h2>/u);
  assert.match(html, /<strong>加粗<\/strong>/u);
  assert.match(html, /<table class="tbl">/u);
  assert.match(html, /<th[^>]*><p>项目<\/p><\/th>/u);
  assert.match(html, /<td[^>]*><p>12345<\/p><\/td>/u);
  assert.match(html, /<img class="pic" src="\/company-kb-api\/media\?rel=x\.docx&amp;name=word%2Fmedia%2Fimage1\.png"/u);
  assert.ok(stats.paragraphs >= 5, `段落数应包含表格内容，实际 ${stats.paragraphs}`);
  assert.equal(stats.tables, 1);
});

test('docx：自闭合 <w:p/> 不会再把后面所有段落吞成一段', () => {
  const filler = '<w:p><w:r><w:t>段落A</w:t></w:r></w:p>'.repeat(3);
  const docx = makeDocx(
    '<w:p/>' + filler
    + '<w:p><w:r><w:t>空行前</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>空行后</w:t></w:r></w:p>'
    + filler,
  );
  const { html, stats } = renderDocxHtml(docx, media);
  assert.match(html, /<p>空行前<\/p>/u);
  assert.match(html, /<p>空行后<\/p>/u);
  assert.equal(stats.paragraphs, 8, '自闭合段落应被跳过，其余各自成段');
});

test('docx：编号与项目符号分别渲染成 ol / ul', () => {
  const docx = makeDocx(
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一条</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第二条</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>要点</w:t></w:r></w:p>',
    {
      'word/numbering.xml': '<?xml version="1.0"?><w:numbering>'
        + '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
        + '<w:abstractNum w:abstractNumId="8"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
        + '<w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num>'
        + '<w:num w:numId="2"><w:abstractNumId w:val="8"/></w:num>'
        + '</w:numbering>',
    },
  );
  const { html } = renderDocxHtml(docx, media);
  assert.match(html, /<ol><li><p>第一条<\/p><\/li><li><p>第二条<\/p><\/li><\/ol>/u);
  assert.match(html, /<ul><li><p>要点<\/p><\/li><\/ul>/u);
});

test('docx：文档里的 HTML 与脚本被转义', () => {
  const docx = makeDocx('<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; 与 A&amp;B</w:t></w:r></w:p>');
  const { html } = renderDocxHtml(docx, media);
  assert.ok(!html.includes('<script>'), '不能出现可执行的 script 标签');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /与 A&amp;B/u, 'XML 实体只应解码一次');
});

function makeXlsx(sheetXml, extra = {}) {
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets>'
      + '<sheet name="报价单" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships>'
      + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst count="3">'
      + '<si><t>设备名称</t></si><si><t>合计（元）</t></si><si><t>喷码机</t></si></sst>',
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet>'
      + '<numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy/m/d"/></numFmts>'
      + '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="3"/><xf numFmtId="176"/><xf numFmtId="10"/></cellXfs>'
      + '</styleSheet>',
    'xl/worksheets/sheet1.xml': sheetXml,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二张表</t></is></c></row></sheetData></worksheet>',
    ...extra,
  });
}

test('xlsx：网格、行号列标、合并单元格、数字格式（日期/千分位/百分比）', () => {
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>12345</v></c>'
    + '<c r="C2" s="2"><v>45292</v></c><c r="D2" s="3"><v>0.125</v></c></row>'
    + '</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>'
    + '<cols><col min="1" max="1" width="18"/></cols></worksheet>';
  const { html, stats } = renderXlsxHtml(makeXlsx(sheet));

  assert.match(html, /<table class="grid">/u);
  assert.match(html, /<h2>报价单<\/h2>/u);
  assert.match(html, /<h2>备注<\/h2>/u, '多工作表都要渲染');
  assert.match(html, />设备名称</u);
  assert.match(html, /12,345/u, '千分位格式');
  assert.match(html, /2024\/1\/1/u, '日期序列号应转成日期');
  assert.match(html, /12\.50%/u, '百分比格式');
  assert.match(html, /colspan="2"/u, '合并单元格');
  assert.match(html, /<th class="cn">A<\/th>/u);
  assert.match(html, /<th class="rn">2<\/th>/u);
  assert.equal(stats.sheets, 2);
});

test('xlsx：单元格里的 HTML 被转义', () => {
  const sheet = '<worksheet><sheetData><row r="1">'
    + '<c r="A1" t="inlineStr"><is><t>&lt;img src=x onerror=alert(1)&gt;</t></is></c>'
    + '</row></sheetData></worksheet>';
  const { html } = renderXlsxHtml(makeXlsx(sheet));
  assert.ok(!html.includes('<img src=x'), '不能出现可执行的 HTML');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
});

test('pptx：每页一张卡片，标题、要点、图片、备注都在', () => {
  const slide1 = '<p:sld><p:cSld><p:spTree>'
    + '<p:sp><p:txBody><a:p><a:r><a:t>项目背景</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>客户要求全流程追溯</a:t></a:r></a:p></p:txBody></p:sp>'
    + '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>'
    + '</p:spTree></p:cSld></p:sld>';
  const slide2 = '<p:sld><p:cSld><p:spTree>'
    + '<p:sp><p:txBody><a:p><a:r><a:t>实施计划</a:t></a:r></a:p></p:txBody></p:sp>'
    + '</p:spTree></p:cSld></p:sld>';
  const pptx = makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'ppt/slides/slide1.xml': slide1,
    'ppt/slides/slide2.xml': slide2,
    'ppt/slides/_rels/slide1.xml.rels': '<?xml version="1.0"?><Relationships>'
      + '<Relationship Id="rId2" Target="../media/image2.png"/></Relationships>',
    'ppt/media/image2.png': TINY_PNG,
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>记得确认验收标准</a:t></a:r></a:p></p:notes>',
  });

  const { html, stats } = renderPptxHtml(pptx, media);
  assert.equal(stats.slides, 2);
  assert.equal((html.match(/<section class="slide">/gu) ?? []).length, 2);
  assert.match(html, /<h2>项目背景<\/h2>/u);
  assert.match(html, /<li>客户要求全流程追溯<\/li>/u);
  assert.match(html, /<img src="[^"]*ppt%2Fmedia%2Fimage2\.png"/u);
  assert.match(html, /备注：记得确认验收标准/u);
  assert.match(html, /<h2>实施计划<\/h2>/u);
});

test('renderDocumentHtml：外壳带 CSP 友好的内联样式与统计脚注', () => {
  const docx = makeDocx('<w:p><w:r><w:t>正文</w:t></w:r></w:p>');
  const { html } = renderDocumentHtml({ buffer: docx, ext: '.docx', rel: '方案/示例.docx', mediaBase: '/company-kb-api/media' });
  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /<meta charset="utf-8">/u);
  assert.match(html, /段落 1 · 表格 0/u);
  assert.throws(
    () => renderDocumentHtml({ buffer: Buffer.from('x'), ext: '.doc', rel: 'a.doc', mediaBase: '/m' }),
    /暂不支持预览/u,
  );
});
