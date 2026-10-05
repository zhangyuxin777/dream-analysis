/**
 * 分析契约与注册表单测（`src/analysis/types.ts`）
 * 注册表是"指令表与 help 的唯一来源"，重名/别名冲突必须在注册期就炸。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { AnalysisRegistry, createDefaultRegistry, numOf, strOf, MAX_WINDOW_HOURS, POSITIONAL_PARAMS, WINDOW_ARG_RE } = require('../../../dist/analysis/types');

const mk = (name, aliases = [], help = '说明') => ({ name, aliases, help, run: async () => ({ title: name, summary: '', warnings: [] }) });

test('注册与查找：名字与别名都能取到，未知返回 undefined', () => {
  const reg = new AnalysisRegistry();
  reg.register(mk('rounds', ['r', 'R']));
  assert.equal(reg.get('rounds').name, 'rounds');
  assert.equal(reg.get('R').name, 'rounds', '别名大小写不敏感');
  assert.equal(reg.get(' r ').name, 'rounds', '两侧空白要容忍');
  assert.equal(reg.get('nope'), undefined);
});

test('重名/别名冲突在注册期就抛（不许后注册的静默覆盖）', () => {
  const reg = new AnalysisRegistry();
  reg.register(mk('rounds', ['r']));
  assert.throws(() => reg.register(mk('r')), /分析名冲突/);
  assert.throws(() => reg.register(mk('other', ['ROUNDS'])), /分析名冲突/);
});

test('all() 去重并按名字排序；helpText 由注册表生成（含参数说明）', () => {
  const reg = createDefaultRegistry([
    mk('rounds', ['r'], '轮数/成交'),
    { ...mk('health', ['hc'], '健康检查'), params: [{ name: 'instance', description: '实例名', example: 'boye888' }] },
  ]);
  assert.deepEqual(reg.all().map((a) => a.name), ['health', 'rounds']);

  const help = reg.helpText();
  assert.match(help, /health \(hc\)  健康检查/);
  assert.match(help, /rounds \(r\)  轮数\/成交/);
  assert.match(help, /instance\s+实例名\s+例: boye888/);
  assert.match(help, /^分析器:/);
});

test('numOf / strOf：数字字符串接受（防御），占位符/垃圾值要挡', () => {
  assert.equal(numOf({ profit: 12.5 }, 'profit'), 12.5);
  // 真分片里数值字段都是 number，唯一的非 number 是 localtest `RECOVERY_APPLIED.buyPrice = "-"`（占位符）。
  // 这里接受数字字符串是"类型不统一时别静默丢值"的保险 —— 不声称这是已观测到的数据问题。
  assert.equal(numOf({ profit: '12.5' }, 'profit'), 12.5, '数字字符串要认（保险）');
  assert.equal(numOf({ profit: ' 12.5 ' }, 'profit'), 12.5, '两边空白要能容错');
  assert.equal(numOf({ profit: '-' }, 'profit'), null, '占位符 "-" ⇒ null（真数据里的那种）');
  assert.equal(numOf({ profit: '' }, 'profit'), null, '空串 ⇒ null');
  assert.equal(numOf({ profit: '   ' }, 'profit'), null, '纯空白 ⇒ null');
  assert.equal(numOf({ profit: 'abc' }, 'profit'), null, '非数字串 ⇒ null');
  assert.equal(numOf({ profit: NaN }, 'profit'), null);
  assert.equal(numOf({ profit: Infinity }, 'profit'), null);
  assert.equal(numOf({ profit: true }, 'profit'), null, '布尔不是数字');
  assert.equal(numOf(undefined, 'profit'), null);
  assert.equal(strOf({ exchange: 'binance' }, 'exchange'), 'binance');
  assert.equal(strOf({ exchange: '' }, 'exchange'), null);
  assert.equal(strOf({ exchange: 42 }, 'exchange'), '42', '数字也要能当字符串取（roundId 可能是数字，别静默丢）');
});

test('常量：窗口上限与位置参数顺序是单一口径（CLI 与将来的机器人共用）', () => {
  assert.equal(MAX_WINDOW_HOURS, 720);
  assert.deepEqual([...POSITIONAL_PARAMS], ['symbol', 'instance', 'top'], 'window 不在位置参数里 —— 它由"长得像窗口"识别');
  assert.ok(WINDOW_ARG_RE.test('2026-10-02'));
  assert.ok(WINDOW_ARG_RE.test('2026-10-01~2026-10-03'));
  assert.ok(WINDOW_ARG_RE.test('昨天'));
  assert.ok(WINDOW_ARG_RE.test('近24h'));
  assert.ok(!WINDOW_ARG_RE.test('eth'), '币种不能被当成窗口');
  assert.ok(!WINDOW_ARG_RE.test('boye888'));
});
