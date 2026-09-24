// 打开/定位的参数形式单测（纯函数，不真的弹窗口）。
// 这里锁死的是踩过三个坑才定下来的形式：引号必须自己带、整串原样交给 explorer。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openArgument, revealArgument } from '../lib/open.js';

test('定位参数：/select 与路径之间不加空格，整串自带引号', () => {
  assert.equal(revealArgument('F:\\资料\\方案.docx'), '/select,"F:\\资料\\方案.docx"');
});

test('路径里的空格、&、( ) 都不会被拆开或二次解析', () => {
  const messy = 'F:\\A 公司资料\\微信小程序注册&认证（260101）.docx';
  assert.equal(revealArgument(messy), `/select,"${messy}"`);
  assert.equal(openArgument(messy), `"${messy}"`);
});

test('打开参数就是带引号的完整路径（等价于双击）', () => {
  assert.equal(openArgument('D:\\kb\\公司简介.txt'), '"D:\\kb\\公司简介.txt"');
});
