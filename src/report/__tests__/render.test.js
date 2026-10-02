/**
 * 渲染单测（`src/report/render.ts`）
 * 两条不变量：① 头部（标题/摘要/告警/暂定标记）**永远不能被截断掉**
 * ② 截断必须**说出来**（"仅显示前 K 行 / 共 N 行" + "已截断"），不许悄悄少半张表
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderResult, renderSection, DEFAULT_MAX_CHARS } = require('../../../dist/report/render');

const baseResult = {
  title: '轮次与成交 · 昨天',
  summary: '新轮 3 / 完成 2；止盈利润合计 12.34',
  warnings: ['窗口内缺 1 天的本地数据: 2026-10-01'],
  provisional: true,
  sections: [
    { heading: '按币种', headers: ['币种', '新轮'], rows: [['ETHFDUSD', '2'], ['BTCFDUSD', '1']] },
  ],
};

test('完整渲染：标题/暂定标记/摘要/告警/markdown 表格', () => {
  const { text, truncated } = renderResult(baseResult);
  assert.equal(truncated, false);
  assert.match(text, /^## 轮次与成交 · 昨天/);
  assert.match(text, /⚠️ \*\*暂定\*\*/);
  assert.match(text, /新轮 3 \/ 完成 2/);
  assert.match(text, /- ⚠️ 窗口内缺 1 天/);
  assert.match(text, /### 按币种/);
  assert.match(text, /\| 币种 \| 新轮 \|/);
  assert.match(text, /\| --- \| --- \|/);
  assert.match(text, /\| ETHFDUSD \| 2 \|/);
});

test('无 provisional 时不出现暂定标记（不能靠"总是打标记"糊弄）', () => {
  const { text } = renderResult({ ...baseResult, provisional: false });
  assert.ok(!text.includes('暂定'));
});

test('超长截断：头部与告警保留，表格写清"仅显示前 K 行"，末尾标"已截断"', () => {
  const rows = Array.from({ length: 200 }, (_, i) => [`SYM${i}`, String(i)]);
  const big = { ...baseResult, summary: '一句摘要', sections: [{ heading: '大表', headers: ['币种', '值'], rows }] };
  const { text, truncated } = renderResult(big, { maxChars: 400 });
  assert.equal(truncated, true);
  assert.match(text, /^## 轮次与成交 · 昨天/);
  assert.match(text, /一句摘要/);
  assert.match(text, /- ⚠️ 窗口内缺 1 天/, '告警不能被截掉');
  assert.match(text, /本节仅显示前 \d+ 行 \/ 共 200 行/);
  assert.match(text, /已截断/);
  assert.ok(text.length <= 600, '必须在预算附近收住，而不是先渲染完再截字符串');
});

test('整块放不下的节：能塞多少塞多少，并写清"仅显示前 K 行"（不许悄悄少半张表）', () => {
  const result = {
    title: 'T',
    summary: 'S',
    warnings: [],
    sections: [
      { heading: '小节', headers: ['a'], rows: [['1']] },
      { heading: '大节', headers: ['a'], rows: Array.from({ length: 50 }, (_, i) => [`x${i}`]) },
    ],
  };
  const { text, truncated } = renderResult(result, { maxChars: 120 });
  assert.equal(truncated, true);
  assert.match(text, /### 小节/);
  assert.match(text, /### 大节/);
  assert.match(text, /本节仅显示前 \d+ 行 \/ 共 50 行/);
  assert.ok(!text.includes('x49'), '不该把 50 行全渲染进去');
  assert.ok(text.length <= 200, '要在预算附近收住');
});

test('renderSection：无表头时按普通文本行渲染；note 会带出来', () => {
  const one = renderSection({ heading: '无表头', rows: [['a', 'b']], note: '口径说明' });
  assert.match(one, /### 无表头/);
  assert.match(one, /> 口径说明/);
  assert.ok(!one.includes('---'));

  const { text } = renderResult({ title: 'T', summary: '', warnings: [], sections: [{ heading: 'X', rows: [['a', 'b']], note: 'N' }] });
  assert.match(text, /a  b/, '无表头就是空格分隔');
});

test('默认预算是个明确常数（别散落在各处）', () => {
  assert.equal(DEFAULT_MAX_CHARS, 3500);
});
