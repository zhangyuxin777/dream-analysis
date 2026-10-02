/**
 * 分析参数解析单测（`src/analysis/args.ts`）—— CLI 与机器人共用。
 *
 * 两条回归钉子（M3 review 的 Critical）：
 * ① 快捷指令 `r eth 昨天` 的第一个参数不能被当成"分析器名"吃掉（否则币种过滤静默失效、全部币种混算）；
 * ② 位置参数顺序按**分析器自己声明的 params**（health 第一个是 instance，rounds 第一个是 symbol）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnalysisParams, parseAnalyzeCommand, positionalNamesOf } = require('../../../dist/analysis/args');
const { createDefaultRegistry, POSITIONAL_PARAMS } = require('../../../dist/analysis/types');
const { healthAnalysis } = require('../../../dist/analysis/health');
const { roundsAnalysis } = require('../../../dist/analysis/rounds');

const registry = createDefaultRegistry([healthAnalysis(), roundsAnalysis()]);

test('parseAnalysisParams：窗口写法一眼识别（含纯中文相对词）；其余按位置参数填；key=value 优先', () => {
  assert.deepEqual(parseAnalysisParams(['eth', 'boye888', '近24h', 'top=3']), {
    symbol: 'eth',
    instance: 'boye888',
    top: '3',
    window: '近24h',
  });
  assert.deepEqual(parseAnalysisParams(['2026-10-02']), { window: '2026-10-02' });
  assert.deepEqual(parseAnalysisParams(['上周']), { window: '上周' }, '纯中文一定不是币种/实例名，交给 parseWindow 报错更诚实');
  assert.deepEqual(parseAnalysisParams(['eth', 'symbol=btc']), { symbol: 'btc' }, 'key=value 覆盖位置参数');
  assert.deepEqual(parseAnalysisParams(['a', 'b', 'c', 'd', 'e']), { symbol: 'a', instance: 'b', top: 'c' }, '多出来的忽略');
  assert.deepEqual(parseAnalysisParams([]), {});
});

test('positionalNamesOf：按分析器声明的参数决定顺序，没声明才退回全局默认', () => {
  assert.deepEqual([...positionalNamesOf(registry.get('health'))], ['instance']);
  assert.deepEqual([...positionalNamesOf(registry.get('rounds'))], ['symbol', 'instance', 'top']);
  assert.deepEqual([...positionalNamesOf(undefined)], [...POSITIONAL_PARAMS]);
});

test('★回归钉子①：快捷指令的第一个参数不能被吃掉（r eth 2026-10-01 的 eth 必须是 symbol）', () => {
  const params = parseAnalysisParams(['eth', '2026-10-01'], positionalNamesOf(registry.get('rounds')));
  assert.deepEqual(params, { symbol: 'eth', window: '2026-10-01' });
  assert.notEqual(params.symbol, undefined, 'symbol 被吃了 ⇒ 报告会把全部币种混算');
});

test('★回归钉子②：hc 的第一个裸参数是 instance（health 不声明 symbol）', () => {
  assert.deepEqual(parseAnalysisParams(['boye888'], positionalNamesOf(registry.get('health'))), { instance: 'boye888' });
  assert.deepEqual(parseAnalysisParams(['boye888', '昨天'], positionalNamesOf(registry.get('health'))), {
    instance: 'boye888',
    window: '昨天',
  });
});

test('parseAnalyzeCommand：第一个 token 是分析器名，其余按该分析器的位置参数解析', () => {
  assert.deepEqual(parseAnalyzeCommand(['rounds', 'eth', '昨天'], (n) => registry.get(n)), {
    name: 'rounds',
    params: { symbol: 'eth', window: '昨天' },
  });
  assert.deepEqual(parseAnalyzeCommand(['health', 'boye888'], (n) => registry.get(n)), {
    name: 'health',
    params: { instance: 'boye888' },
  });
  assert.deepEqual(parseAnalyzeCommand([], (n) => registry.get(n)), { name: '', params: {} });
  // 未知分析器：仍要能解析出名字（好让上层报"未知分析器 + 可用清单"），位置参数退回默认顺序
  assert.deepEqual(parseAnalyzeCommand(['nope', 'eth'], (n) => registry.get(n)), { name: 'nope', params: { symbol: 'eth' } });
});
