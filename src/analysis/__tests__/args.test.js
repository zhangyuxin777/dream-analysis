/**
 * 分析参数解析单测（`src/analysis/args.ts`）—— CLI 与机器人共用，所以钉在这里。
 * 关键回归：日期**不能被当成币种**（实测踩过：`analyze health 2026-10-02` 曾输出 0 事件）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnalysisArgs } = require('../../../dist/analysis/args');

test('窗口写法一眼识别为 window；其余裸参数按 symbol/instance/top 填', () => {
  assert.deepEqual(parseAnalysisArgs(['r', 'eth', '昨天']), { name: 'r', params: { symbol: 'eth', window: '昨天' } });
  assert.deepEqual(parseAnalysisArgs(['health', '2026-10-02']), { name: 'health', params: { window: '2026-10-02' } });
  assert.deepEqual(parseAnalysisArgs(['r', '2026-10-01~2026-10-03', 'eth']), {
    name: 'r',
    params: { window: '2026-10-01~2026-10-03', symbol: 'eth' },
  });
  assert.deepEqual(parseAnalysisArgs(['r', 'eth', 'boye888', '近24h', 'top=3']), {
    name: 'r',
    params: { symbol: 'eth', instance: 'boye888', top: '3', window: '近24h' },
  });
});

test('纯中文裸参数当窗口（"上周"这种一定不是币种，宁可报错也别当成 symbol 输出 0 事件）', () => {
  assert.deepEqual(parseAnalysisArgs(['r', 'eth', '上周']), { name: 'r', params: { symbol: 'eth', window: '上周' } });
  assert.deepEqual(parseAnalysisArgs(['hc', '上个月']), { name: 'hc', params: { window: '上个月' } });
});

test('key=value 永远优先于位置参数', () => {
  assert.deepEqual(parseAnalysisArgs(['rounds', 'symbol=btc', 'top=3']), { name: 'rounds', params: { symbol: 'btc', top: '3' } });
  assert.deepEqual(parseAnalysisArgs(['r', 'eth', 'symbol=btc']), { name: 'r', params: { symbol: 'btc' } });
});

test('多出来的裸参数忽略（不猜）；空参数列表返回空 name', () => {
  assert.deepEqual(parseAnalysisArgs(['r', 'a', 'b', 'c', 'd', 'e']), { name: 'r', params: { symbol: 'a', instance: 'b', top: 'c' } });
  assert.deepEqual(parseAnalysisArgs([]), { name: '', params: {} });
});
