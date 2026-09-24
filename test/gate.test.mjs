// 门禁单测：显式调用的正例、否定词、英文、路径点名、同步意图。
// 直接测纯函数，不需要 agent / DSH 运行时。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explicitlyRequested, requestsSync } from '../lib/gate.js';

const TRIGGERS = ['知识库', '资料库', '公司资料', '公司资料', '用知识库', '查一下资料', '查一下文档', '查一下文件', '/kb'];
const NAMES = ['(农药)农药行业追溯方案建议书（260923）.docx', '方案模板', '投标文件相关模块', '标准报价'];

const yes = text => explicitlyRequested(text, { triggers: TRIGGERS, names: NAMES });
const no = text => assert.equal(yes(text), false, `不应放行：${text}`);

test('点名即放行', () => {
  assert.equal(yes('用知识库查一下农药追溯二维码的政策要求'), true);
  assert.equal(yes('知识库里有没有 UDI 和 GS1 的资料'), true);
  assert.equal(yes('查一下资料里的袋线瓶线报价'), true);
  assert.equal(yes('公司资料里关于 4Q 验证的文件'), true);
  assert.equal(yes('/kb 农药追溯政策'), true);
});

test('路径点名也算（不必说"知识库"）', () => {
  assert.equal(yes('按 (农药)农药行业追溯方案建议书（260923）.docx 的结构写一份新方案'), true);
  assert.equal(yes('参考 方案模板 里的通用模板'), true);
  assert.equal(yes('投标文件相关模块 里那段技术方案翻出来'), true);
});

test('否定不放行', () => {
  no('这次不要用知识库，直接回答');
  no('不用知识库');
  no('知识库先别用了');
  no('不要查一下资料了');
  no("don't use the KB for this one");
  no('no knowledge base needed');
});

test('无关消息不放行', () => {
  no('帮我把这段代码重构一下');
  no('今天天气怎么样');
  no('');
  no('写一份新的技术方案（不涉及公司资料）');
  no('这次不查公司资料，用你自己的判断');
});

test('同步意图', () => {
  assert.equal(requestsSync('同步一下知识库'), true);
  assert.equal(requestsSync('把知识库的索引更新一下'), true);
  assert.equal(requestsSync('重建索引'), true);
  assert.equal(requestsSync('查一下知识库里的报价'), false);
  assert.equal(requestsSync('不要同步知识库'), false);
});
