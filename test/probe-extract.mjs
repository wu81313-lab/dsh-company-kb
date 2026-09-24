// 诊断脚本：在真实语料上逐个验证抽取器（docx/xlsx/pptx/txt）与 OCR/Word 助手。
// 用法：
//   node test/probe-extract.mjs            # 跑内置样例
//   node test/probe-extract.mjs <文件路径>  # 只跑指定文件

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractLocal, kindOf } from '../lib/extract/index.js';
import { createOcrBridge } from '../lib/ocr.js';

const ROOT = process.env.DSH_LOCAL_KB_ROOT ?? 'D:\\example-org\\公司资料';
const SAMPLES = [
  `${ROOT}\\公司介绍\\示例科技有限公司简介.docx`,
  `${ROOT}\\测试报告模板\\XXXX项目出厂测试报告模板.docx`,
  `${ROOT}\\标准报价\\示例产品对外报价（250101）.xlsx`,
  `${ROOT}\\系统后台\\数据中心拓扑图案例.pptx`,
  `${ROOT}\\系统后台\\测试环境说明.txt`,
  `${ROOT}\\政策法规\\示例行业二维码政策.pdf`,
  `${ROOT}\\系统后台\\软件截图\\Screenshot_20260101-101131.png`,
  `${ROOT}\\系统后台\\系统操作手册.doc`,
];

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : SAMPLES;
const bridge = createOcrBridge({ logger: console });

console.log('--- 助手能力探测 ---');
const caps = await bridge.probe();
console.log(JSON.stringify(caps, null, 2));

for (const path of targets) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const kind = kindOf(ext);
  const started = Date.now();
  try {
    const local = extractLocal({ kind, path });
    if (local.needs === null) {
      const chars = local.text.length;
      console.log(`[OK ] ${kind.padEnd(11)} chars=${String(chars).padStart(7)} blocks=${String(local.blocks.length).padStart(5)} ${Date.now() - started}ms  ${basename(path)}`);
      if (chars > 0) console.log(`      head: ${local.text.replace(/\s+/gu, ' ').slice(0, 120)}`);
      continue;
    }
    const id = basename(path);
    if (local.needs === 'ocr') {
      const job = kind === 'pdf'
        ? { id, kind: 'pdf', path, maxPages: 3, width: 1600 }
        : { id, kind: 'image', path };
      const result = (await bridge.recognize([job])).get(id);
      const text = result.pages?.length > 0 ? result.pages.map(page => page.text).join('\n') : result.text;
      console.log(`[OCR] ${kind.padEnd(11)} ok=${result.ok} chars=${String(text.length).padStart(7)} ${Date.now() - started}ms  ${id}`);
      if (result.error) console.log(`      error: ${result.error}`);
      if (text.length > 0) console.log(`      head: ${text.replace(/\s+/gu, ' ').slice(0, 140)}`);
      continue;
    }
    if (local.needs === 'word') {
      const result = (await bridge.readLegacyDocs([{ id, kind: 'doc', path }])).get(id);
      console.log(`[DOC] ${kind.padEnd(11)} ok=${result.ok} chars=${String((result.text ?? '').length).padStart(7)} ${Date.now() - started}ms  ${id}`);
      if (result.error) console.log(`      error: ${result.error}`);
      if (result.text) console.log(`      head: ${result.text.replace(/\s+/gu, ' ').slice(0, 140)}`);
      continue;
    }
    console.log(`[SKIP] ${kind} ${basename(path)}`);
  } catch (error) {
    console.log(`[ERR] ${kind.padEnd(11)} ${basename(path)} :: ${error.message}`);
  }
}

// 顺带确认 docx 的 zip 读取在大文件上不会炸（例如几十 MB 的投标文件）
const BIG = process.env.DSH_LOCAL_KB_BIG ?? `${ROOT}\\投标文件相关模块\\投标相关模块.docx`;
try {
  const size = readFileSync(BIG).byteLength;
  const started = Date.now();
  const result = extractLocal({ kind: 'docx', path: BIG });
  console.log(`[BIG] docx chars=${result.text.length} blocks=${result.blocks.length} read=${Date.now() - started}ms（原始 ${(size / 1048576).toFixed(1)}MB）`);
} catch (error) {
  console.log(`[BIG] 失败：${error.message}`);
}
