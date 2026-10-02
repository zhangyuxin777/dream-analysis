/**
 * 天分片读取单测（`src/ndjson/shard.ts`）—— 用真实 .jsonl.gz 夹具（临时目录）。
 * 覆盖三类判定：errors（不入库）/ warnings（入库但标注）/ 正常。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { readShard } = require('../../../dist/ndjson/shard');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-test-'));

function writeShard(name, lines) {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  return file;
}

const header = (over = {}) => JSON.stringify({ type: 'meta', schema: 1, instance: 'boye888', date: '2026-10-02', final: false, ...over });
const ev = (ts, event, symbol = 'ETH', extra = {}) => JSON.stringify({ ts, event, symbol, localDate: ts.slice(0, 10), seq: 1, ...extra });

test('正常分片：header + 3 行 → ok，计数/首末时间/事件分布都正确', async () => {
  const file = writeShard('ok.jsonl.gz', [
    header({ count: 3, firstTs: '2026-10-02T01:00:00.000Z', lastTs: '2026-10-02T03:00:00.000Z' }),
    ev('2026-10-02T01:00:00.000Z', 'NEW_ROUND'),
    ev('2026-10-02T02:00:00.000Z', 'BUY_FILLED'),
    ev('2026-10-02T03:00:00.000Z', 'SELL_FILLED', 'BTC'),
  ]);
  const stats = await readShard(file);
  assert.equal(stats.ok, true, JSON.stringify(stats.errors));
  assert.equal(stats.dataLines, 3);
  assert.equal(stats.badLines, 0);
  assert.deepEqual(stats.eventCounts, { NEW_ROUND: 1, BUY_FILLED: 1, SELL_FILLED: 1 });
  assert.deepEqual(stats.symbolCounts, { ETH: 2, BTC: 1 });
  assert.equal(stats.firstTs, '2026-10-02T01:00:00.000Z');
  assert.equal(stats.lastTs, '2026-10-02T03:00:00.000Z');
  assert.equal(stats.warnings.length, 0, '干净数据不该有告警');
  assert.equal(stats.header.instance, 'boye888');
});

test('行数不符 → 只是 warning（仍入库，报告里标注）；两种 count 口径都要对', async () => {
  const file = writeShard('mismatch.jsonl.gz', [header({ count: 5 }), ev('2026-10-02T01:00:00.000Z', 'A')]);
  const strict = await readShard(file, { countIncludesHeader: false });
  assert.equal(strict.ok, true, 'warning 不该导致不入库');
  assert.match(strict.warnings.join(' '), /行数不符/);

  const includesHeader = await readShard(file, { countIncludesHeader: true });
  assert.match(includesHeader.warnings.join(' '), /行数不符/, 'count=5 含 header 时数据行应为 4，仍不符');
});

test('count 口径 = 含 header 时，count = 数据行 + 1 不再告警', async () => {
  const file = writeShard('count-with-header.jsonl.gz', [header({ count: 3 }), ev('2026-10-02T01:00:00.000Z', 'A'), ev('2026-10-02T02:00:00.000Z', 'B')]);
  const stats = await readShard(file, { countIncludesHeader: true });
  assert.equal(stats.dataLines, 2);
  assert.equal(stats.warnings.filter((w) => w.includes('行数不符')).length, 0);
});

test('坏行（非法 JSON / 缺字段 / ts 不合法）只计数 + 告警，不阻断其它行', async () => {
  const file = writeShard('badlines.jsonl.gz', [
    header({ count: 2 }),
    ev('2026-10-02T01:00:00.000Z', 'GOOD'),
    '{ 这不是 JSON',
    JSON.stringify({ ts: '2026-10-02T02:00:00.000Z' }),          // 缺 event
    JSON.stringify({ ts: 'nope', event: 'BAD_TS' }),              // ts 不可解析
    ev('2026-10-02T03:00:00.000Z', 'GOOD2'),
  ]);
  const stats = await readShard(file);
  assert.equal(stats.ok, true);
  assert.equal(stats.dataLines, 2);
  assert.equal(stats.badLines, 3);
  assert.ok(stats.warnings.some((w) => w.includes('不是合法 JSON')));
});

test('首行不是 header → 直接判失败（不入库）', async () => {
  const file = writeShard('no-header.jsonl.gz', [ev('2026-10-02T01:00:00.000Z', 'NEW_ROUND')]);
  const stats = await readShard(file);
  assert.equal(stats.ok, false);
  assert.equal(stats.header, null);
  assert.match(stats.errors.join(' '), /首行不是合法 header/);
});

test('空文件 → 失败；文件不存在 → 失败（不抛异常）', async () => {
  const empty = path.join(tmpRoot, 'empty.jsonl.gz');
  fs.writeFileSync(empty, zlib.gzipSync(Buffer.from('', 'utf8')));
  const emptyStats = await readShard(empty);
  assert.equal(emptyStats.ok, false);
  assert.ok(emptyStats.errors.length > 0);

  const missing = await readShard(path.join(tmpRoot, 'nope.jsonl.gz'));
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.errors, ['文件不存在']);
});

test('不是 gzip（或被截断）→ 解压失败进 errors，不抛', async () => {
  const file = path.join(tmpRoot, 'not-gzip.jsonl.gz');
  fs.writeFileSync(file, 'plain text, not gzip');
  const stats = await readShard(file);
  assert.equal(stats.ok, false);
  assert.match(stats.errors.join(' '), /gzip 解压失败/);
});

test('事件日期与 header.date 不一致 → 告警并给出样本（跨夜数据要看得见）', async () => {
  const file = writeShard('crossday.jsonl.gz', [
    header({ count: 2 }),
    ev('2026-10-02T23:59:00.000Z', 'A'),
    ev('2026-10-03T00:01:00.000Z', 'B'),
  ]);
  const stats = await readShard(file);
  assert.equal(stats.ok, true);
  assert.ok(stats.warnings.some((w) => w.includes('日期与 header.date 不一致')), stats.warnings.join('|'));
});

test('onEvent 回调按行序收到事件（不含 header），M2 分析器就挂在这里', async () => {
  const file = writeShard('iterate.jsonl.gz', [header(), ev('2026-10-02T01:00:00.000Z', 'A'), ev('2026-10-02T02:00:00.000Z', 'B')]);
  const seen = [];
  await readShard(file, { onEvent: (e, lineNo) => seen.push([lineNo, e.event]) });
  assert.deepEqual(seen, [[2, 'A'], [3, 'B']]);
});

test('只有 header、没有数据行 → 告警（当天可能还没产出）', async () => {
  const file = writeShard('header-only.jsonl.gz', [header({ count: 0 })]);
  const stats = await readShard(file);
  assert.equal(stats.ok, true);
  assert.equal(stats.dataLines, 0);
  assert.ok(stats.warnings.some((w) => w.includes('只有 header')));
});

test('大分片跨多个 chunk 也要正确切行（每行 ~2KB × 300 行）', async () => {
  const lines = [header()];
  const filler = 'x'.repeat(2000);
  for (let i = 0; i < 300; i++) lines.push(ev(`2026-10-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`, 'BIG', 'ETH', { data: { filler } }));
  const file = writeShard('big.jsonl.gz', lines);
  const stats = await readShard(file);
  assert.equal(stats.ok, true);
  assert.equal(stats.dataLines, 300);
  assert.equal(stats.badLines, 0);
});

test('UTF-8 跨 gunzip 块边界不能被撕坏（多字节字符静默变 U+FFFD 是数据损坏）', async () => {
  const CHUNK = 16384; // Node zlib 默认 chunkSize
  const target = '中文测试🀄';
  const headerLine = header({ count: 1 });
  const headerBytes = Buffer.byteLength(headerLine + '\n', 'utf8');

  const makeLine = (padLen) =>
    JSON.stringify({ ts: '2026-10-02T01:00:00.000Z', event: 'ZH', symbol: 'ETH', localDate: '2026-10-02', seq: 1, data: { pad: 'x'.repeat(padLen), note: target } });
  const probe = makeLine(0);
  const offsetInLine = Buffer.byteLength(probe.slice(0, probe.indexOf(target)), 'utf8');
  const padLen = CHUNK - 1 - headerBytes - offsetInLine;
  assert.ok(padLen > 0, '夹具构造失败（pad 必须为正）');
  const line = makeLine(padLen);

  const stream = headerLine + '\n' + line + '\n';
  const targetByteOffset = Buffer.byteLength(stream.slice(0, stream.indexOf(target)), 'utf8');
  assert.equal(targetByteOffset, CHUNK - 1, '夹具必须把多字节字符压在第 16384 字节的边界上，否则这条测试没测到东西');

  const file = writeShard('utf8-boundary.jsonl.gz', [headerLine, line]);
  const notes = [];
  const stats = await readShard(file, { onEvent: (e) => notes.push(e.data.note) });
  assert.equal(stats.ok, true);
  assert.equal(stats.badLines, 0, '旧实现会把它当"合法 JSON"收下，只是内容被改写 —— 所以这里必须断言内容本身');
  assert.deepEqual(notes, [target]);
  assert.ok(!notes[0].includes('\uFFFD'), '多字节字符被替换成 U+FFFD = 静默数据损坏');
});

test('日期归属按契约时区（Asia/Shanghai）：上海凌晨的事件不该被误报"日期不一致"', async () => {
  const file = writeShard('tz-ok.jsonl.gz', [
    header({ count: 3, date: '2026-10-02' }),
    ev('2026-10-01T16:30:00.000Z', 'A', 'ETH', { localDate: '2026-10-02' }), // 上海 10-02 00:30
    ev('2026-10-02T03:00:00.000Z', 'B', 'ETH', { localDate: '2026-10-02' }), // 上海 10-02 11:00
    ev('2026-10-02T15:30:00.000Z', 'C', 'ETH', { localDate: '2026-10-02' }), // 上海 10-02 23:30
  ]);
  const stats = await readShard(file);
  assert.equal(stats.warnings.filter((w) => w.includes('日期与 header.date 不一致')).length, 0, stats.warnings.join('|'));
});

test('±2h 跨夜容差：本地次日凌晨的事件不算"日期不一致"', async () => {
  const file = writeShard('tz-tolerance.jsonl.gz', [
    header({ count: 1, date: '2026-10-02' }),
    ev('2026-10-02T17:00:00.000Z', 'A', 'ETH', { localDate: '2026-10-03' }), // 上海 10-03 01:00
  ]);
  const stats = await readShard(file);
  assert.equal(stats.warnings.filter((w) => w.includes('日期与 header.date 不一致')).length, 0);
});

test('事件真的落在别的日子 → 必须报"日期不一致"（容差不能把真信号吃掉）', async () => {
  const file = writeShard('tz-bad.jsonl.gz', [
    header({ count: 1, date: '2026-10-02' }),
    ev('2026-10-05T03:00:00.000Z', 'A', 'ETH', { localDate: '2026-10-05' }),
  ]);
  const stats = await readShard(file);
  assert.ok(stats.warnings.some((w) => w.includes('日期与 header.date 不一致')), stats.warnings.join('|'));
});

test('已封存分片却从当天下午才开始 → 报"前段可能没导出"（唯一独立于上传侧自报的完整性信号）', async () => {
  const file = writeShard('partial.jsonl.gz', [
    header({ count: 2, date: '2026-10-02', final: true }),
    ev('2026-10-02T06:00:00.000Z', 'A'), // 上海 14:00
    ev('2026-10-02T07:00:00.000Z', 'B'),
  ]);
  const stats = await readShard(file);
  assert.ok(stats.warnings.some((w) => w.includes('当天前段可能没有导出')), stats.warnings.join('|'));
  assert.ok(stats.warnings.some((w) => w.includes('经验值')), '必须说明阈值是经验值，不能假装是契约判据');
});

test('已封存分片从当天凌晨就开始 → 不该误报"缺早段"', async () => {
  const file = writeShard('complete.jsonl.gz', [
    header({ count: 2, date: '2026-10-02', final: true }),
    ev('2026-10-01T16:10:00.000Z', 'A'), // 上海 00:10
    ev('2026-10-02T15:50:00.000Z', 'B'), // 上海 23:50
  ]);
  const stats = await readShard(file);
  assert.equal(stats.warnings.filter((w) => w.includes('当天前段可能没有导出')).length, 0);
});

test('行内不自洽也必须报（只信 localDate 会把这条判据变成永不复活的死代码）', async () => {
  const file = writeShard('self-inconsistent.jsonl.gz', [
    header({ count: 1, date: '2026-10-02' }),
    // ts 是 10-05，上传侧却把桶日期 10-02 盖在 localDate 上 ⇒ 两者矛盾，必须报
    ev('2026-10-05T03:00:00.000Z', 'A', 'ETH', { localDate: '2026-10-02' }),
  ]);
  const stats = await readShard(file);
  assert.ok(stats.warnings.some((w) => w.includes('日期与 header.date 不一致')), stats.warnings.join('|'));
  assert.ok(stats.warnings.some((w) => w.includes('不符')), '要指出是 ts 与 localDate 不符');
});
