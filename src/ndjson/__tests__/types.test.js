/**
 * 键解析单测（`src/ndjson/types.ts`）
 * 契约边界全在这里钉住：不匹配一律 null（调用方必须"忽略 + warn"，不许猜）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseShardKey,
  buildShardKey,
  buildShardKeyRe,
  isRealDate,
  isShardHeader,
  isEventRecord,
} = require('../../../dist/ndjson/types');

const PREFIX = 'snapshot/';

test('parseShardKey：合法键', () => {
  assert.deepEqual(parseShardKey('snapshot/boye888/2026-10-02.jsonl.gz', PREFIX), { instance: 'boye888', date: '2026-10-02' });
  assert.deepEqual(parseShardKey('snapshot/dream-001/2026-01-31.jsonl.gz', PREFIX), { instance: 'dream-001', date: '2026-01-31' });
});

test('parseShardKey：非法键一律 null（前缀/层级/后缀/日期/实例名）', () => {
  const bad = [
    'timeline/boye888/2026-10-02.jsonl.gz',      // 前缀不对
    'snapshot/boye888/2026-10-02.jsonl',         // 少了 .gz
    'snapshot/boye888/2026-10-02.gz',            // 后缀不符
    'snapshot/2026-10-02.jsonl.gz',              // 少了实例层
    'snapshot/a/b/2026-10-02.jsonl.gz',          // 多了一级（实例名不能含 /）
    'snapshot/boye888/2026-10-2.jsonl.gz',       // 日期未补零
    'snapshot/boye888/2026-13-01.jsonl.gz',      // 月份非法
    'snapshot/boye888/2026-02-30.jsonl.gz',      // 格式对但日子不存在
    'snapshot/  /2026-10-02.jsonl.gz',           // 实例名空白
    'snapshot/boye888/2026-10-02.jsonl.gz.1',    // 轮转后缀（不该出现在 OSS）
    'snapshot/.keep',                            // 占位文件
    'snapshot/boye888/x.jsonl.gz',               // 日期缺失
  ];
  for (const key of bad) {
    assert.equal(parseShardKey(key, PREFIX), null, `应判非法: ${key}`);
  }
});

test('parseShardKey：实例名含中文/空格/斜杠等一律拒绝（防路径穿越）', () => {
  assert.equal(parseShardKey('snapshot/实例/2026-10-02.jsonl.gz', PREFIX), null);
  assert.equal(parseShardKey('snapshot/..%2f/2026-10-02.jsonl.gz', PREFIX), null);
  assert.equal(parseShardKey('snapshot/../etc/2026-10-02.jsonl.gz', PREFIX), null);
});

test('buildShardKey 与 parseShardKey 互逆', () => {
  const key = buildShardKey(PREFIX, 'boye888', '2026-10-02');
  assert.equal(key, 'snapshot/boye888/2026-10-02.jsonl.gz');
  assert.deepEqual(parseShardKey(key, PREFIX), { instance: 'boye888', date: '2026-10-02' });
});

test('buildShardKeyRe：前缀里的正则元字符被转义（前缀不是正则片段）', () => {
  const re = buildShardKeyRe('data/v1.0+raw/');
  assert.ok(re.test('data/v1.0+raw/x/2026-10-02.jsonl.gz'), '字面前缀要能匹配');
  assert.ok(!re.test('data/v1X0+raw/x/2026-10-02.jsonl.gz'), '点号不该被当通配符');
});

test('isRealDate：闰年与月末', () => {
  assert.ok(isRealDate('2024-02-29'));
  assert.ok(!isRealDate('2026-02-29'));
  assert.ok(!isRealDate('2026-04-31'));
});

test('isShardHeader：必填字段缺一不可', () => {
  const good = { type: 'meta', schema: 1, instance: 'boye888', date: '2026-10-02', final: false };
  assert.ok(isShardHeader(good));
  assert.ok(isShardHeader({ ...good, count: 0, firstTs: 'x' }));
  assert.ok(!isShardHeader({ ...good, type: 'data' }));
  assert.ok(!isShardHeader({ ...good, schema: '1' }));
  assert.ok(!isShardHeader({ ...good, final: 'false' }), 'final 必须是布尔，字符串不算');
  assert.ok(!isShardHeader({ ...good, date: '2026-10-2' }));
  assert.ok(!isShardHeader(null));
});

test('isEventRecord：ts 必须可解析', () => {
  assert.ok(isEventRecord({ ts: '2026-10-02T13:00:00.000Z', event: 'NEW_ROUND' }));
  assert.ok(!isEventRecord({ ts: 'not-a-date', event: 'NEW_ROUND' }));
  assert.ok(!isEventRecord({ ts: '2026-10-02T13:00:00.000Z' }), 'event 必填');
  assert.ok(!isEventRecord({ ts: '2026-10-02T13:00:00.000Z', event: 'X', symbol: 1 }));
});

test('localDateOf：UTC ts → 分桶时区（Asia/Shanghai）的本地日', () => {
  const { localDateOf } = require('../../../dist/ndjson/types');
  assert.equal(localDateOf('2026-10-02T03:00:00.000Z'), '2026-10-02');
  assert.equal(localDateOf('2026-10-01T16:30:00.000Z'), '2026-10-02', '上海 00:30 属于 10-02（UTC 日期是 10-01，这正是旧实现的坑）');
  assert.equal(localDateOf('2026-10-01T15:59:59.000Z'), '2026-10-01', '上海 23:59:59 仍属前一天');
  assert.equal(localDateOf('2026-10-01T16:00:00.000Z'), '2026-10-02', '上海 00:00:00 边界');
  assert.equal(localDateOf('not-a-date'), null);
});

test('effectiveLocalDate：优先用上传侧的 localDate（契约权威值），非法/缺失才按 ts 推算', () => {
  const { effectiveLocalDate } = require('../../../dist/ndjson/types');
  assert.equal(effectiveLocalDate({ ts: '2026-10-01T16:30:00.000Z', localDate: '2026-10-02' }), '2026-10-02');
  assert.equal(effectiveLocalDate({ ts: '2026-10-01T16:30:00.000Z' }), '2026-10-02', '缺 localDate 时按 ts 推算');
  assert.equal(effectiveLocalDate({ ts: '2026-10-01T16:30:00.000Z', localDate: '2026-10-2' }), '2026-10-02', '格式非法则忽略');
  assert.equal(effectiveLocalDate({ ts: '2026-10-01T16:30:00.000Z', localDate: '2026-02-30' }), '2026-10-02', '不存在的日子也忽略');
  assert.equal(effectiveLocalDate({ ts: '2026-10-01T16:30:00.000Z', localDate: 123 }), '2026-10-02');
});
