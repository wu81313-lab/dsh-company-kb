// 客户端 bundle 单测：不装浏览器、不装 React，用最小假 React 把真实模块跑起来，
// 直接检查「同步记录明细」渲染出来的树。
//   - 分组顺序：新增 / 更新 / 删除 / 失败
//   - 文件名、补记标签、错误文本都在
//   - 超过上限时给出"还有 N 个文件未列出"
//   - 没有明细（老记录）时返回 null，不影响原渲染

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadClient() {
  const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
  let plugin = null;
  const fakeReact = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) },
    }),
    useState: initial => [initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: factory => factory(),
    useCallback: fn => fn,
  };
  const fakeWindow = {
    __ModuleLoader__: {
      load: descriptor => {
        plugin = descriptor.factory(name => {
          if (name === 'react') return fakeReact;
          throw new Error(`客户端只允许 require('react')，实际请求：${name}`);
        });
      },
    },
  };
  // client.js 是普通脚本（无 ESM 语法），可以直接求值
  // eslint-disable-next-line no-new-func
  new Function('window', 'fetch', source)(fakeWindow, async () => { throw new Error('测试里不应发请求'); });
  return plugin;
}

/** 把假 React 的树拍平成文案数组，方便断言。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node === 'object' && node.props !== undefined) {
    out.push(`<${typeof node.type === 'string' ? node.type : 'C'}>`);
    flatten(node.props.children, out);
  }
  return out;
}

const SAMPLE = {
  added: [{ rel: '三期检测/OCR操作手册.docx' }, { rel: '图纸/结构图.dwg', note: '仅登记元数据' }],
  updated: [{ rel: '公司简介.txt' }],
  removed: ['方案模板/旧模板.docx'],
  failed: [{ rel: '损坏文件.docx', error: '抽取失败：文件头损坏' }],
};

test('客户端 bundle 导出 apply / inject，且 inject 声明 slots 服务', () => {
  const plugin = loadClient();
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots']);
});

test('同步记录明细：按新增/更新/删除/失败分组列出文件名', () => {
  const { LogDetails } = loadClient();
  const tree = LogDetails({ details: SAMPLE });
  const text = flatten(tree);

  // 分组表头顺序
  const heads = text.filter(item => /^(新增|更新|删除|失败) \d+ 个$/u.test(item));
  assert.deepEqual(heads, ['新增 2 个', '更新 1 个', '删除 1 个', '失败 1 个']);

  // 文件都在
  for (const rel of ['三期检测/OCR操作手册.docx', '图纸/结构图.dwg', '公司简介.txt', '方案模板/旧模板.docx', '损坏文件.docx']) {
    assert.ok(text.includes(rel), `明细里应出现 ${rel}`);
  }
  assert.ok(text.includes('仅登记元数据'), '元数据登记项应带说明标签');
  assert.ok(text.includes('抽取失败：文件头损坏'), '失败项应带错误文本');
});

test('同步记录明细：没有明细的老记录返回 null', () => {
  const { LogDetails } = loadClient();
  assert.equal(LogDetails({ details: null }), null);
  assert.equal(LogDetails({ details: undefined }), null);
  assert.equal(LogDetails({ details: {} }), null);
});

test('同步记录明细：超过上限时截断并提示剩余数量', () => {
  const { LogDetails, LOG_FILES_MAX } = loadClient();
  const many = Array.from({ length: LOG_FILES_MAX + 5 }, (_, index) => ({ rel: `资料/文件-${index}.txt` }));
  const text = flatten(LogDetails({ details: { added: many, updated: [], removed: [], failed: [] } }));
  assert.ok(text.includes(`新增 ${LOG_FILES_MAX + 5} 个`), '表头显示真实数量');
  assert.ok(text.includes(`……还有 5 个文件未列出`), `应提示剩余数量，实际：${text.filter(t => t.includes('还有')).join('/')}`);
  assert.equal(text.filter(item => /^资料\/文件-\d+\.txt$/u.test(item)).length, LOG_FILES_MAX);
});


test('布局：比例与高度都被夹在合法区间，脏值回落默认', () => {
  const { clampSplit, clampHeight, SPLIT_RANGE, HEIGHT_RANGE } = loadClient();
  assert.equal(clampSplit(36), 36);
  assert.equal(clampSplit(SPLIT_RANGE[0] - 10), SPLIT_RANGE[0]);
  assert.equal(clampSplit(SPLIT_RANGE[1] + 10), SPLIT_RANGE[1]);
  assert.equal(clampSplit('abc'), 36);
  assert.equal(clampSplit(undefined), 36);
  assert.equal(clampSplit(Number.NaN), 36);

  assert.equal(clampHeight(620), 620);
  assert.equal(clampHeight(HEIGHT_RANGE[0] - 100), HEIGHT_RANGE[0]);
  assert.equal(clampHeight(HEIGHT_RANGE[1] + 100), HEIGHT_RANGE[1]);
  assert.equal(clampHeight(-5), HEIGHT_RANGE[0], '负数夹到下限');
  assert.equal(clampHeight(''), 620, '空串当没给值');
});

test('布局：默认高度跟着窗口走，但始终在区间内', () => {
  const { defaultHeight, HEIGHT_RANGE, clampHeight } = loadClient();
  assert.equal(defaultHeight(1200), 720, '大窗口封顶 720');
  assert.equal(defaultHeight(600), 360, '小窗口也要比旧的"视口减 290"大一档');
  assert.equal(defaultHeight(0), 620, '拿不到视口高度时用 620');
  assert.equal(defaultHeight(undefined), 620);
  for (const viewport of [200, 400, 600, 800, 1200, 4000]) {
    const height = defaultHeight(viewport);
    assert.ok(height >= HEIGHT_RANGE[0] && height <= HEIGHT_RANGE[1], '视口高度 ' + viewport + ' 时结果应在区间内');
    assert.equal(height, clampHeight(height));
  }
});

test('布局：读 storage 容错——非法 JSON、缺字段、越界值都能安全落地', () => {
  const { readLayout, writeLayout, LAYOUT_KEY, SPLIT_RANGE, HEIGHT_RANGE } = loadClient();
  const store = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
    };
  };

  assert.deepEqual(readLayout(store()), { ratio: 36, height: null }, '空 storage 用默认');
  assert.deepEqual(readLayout(null), { ratio: 36, height: null }, '拿不到 storage 也不炸');
  assert.deepEqual(readLayout(store({ [LAYOUT_KEY]: '{不是 JSON' })), { ratio: 36, height: null });
  assert.deepEqual(readLayout(store({ [LAYOUT_KEY]: '"字符串"' })), { ratio: 36, height: null });
  assert.deepEqual(readLayout(store({ [LAYOUT_KEY]: '{"ratio":"abc","height":-5}' })), { ratio: 36, height: null });
  assert.deepEqual(readLayout(store({ [LAYOUT_KEY]: '{"ratio":95,"height":99999}' })),
    { ratio: SPLIT_RANGE[1], height: HEIGHT_RANGE[1] }, '越界值被夹紧');

  const storage = store();
  writeLayout(storage, { ratio: 52, height: 880 });
  assert.deepEqual(readLayout(storage), { ratio: 52, height: 880 }, '写进去能读回来');
  writeLayout(storage, { ratio: 10, height: null });
  assert.deepEqual(readLayout(storage), { ratio: SPLIT_RANGE[0], height: null }, '写的时候也要夹紧');
});

test('布局：storage 抛异常时静默失败，不影响使用', () => {
  const { readLayout, writeLayout } = loadClient();
  const hostile = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.deepEqual(readLayout(hostile), { ratio: 36, height: null });
  assert.doesNotThrow(() => writeLayout(hostile, { ratio: 50, height: 700 }));
});
