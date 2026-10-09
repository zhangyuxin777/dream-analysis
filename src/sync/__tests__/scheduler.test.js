/**
 * 调度器单测（`src/sync/scheduler.ts`）
 * 两条不变量：① 单并发（绝不并发跑两次同步） ② 任务异常不冒泡（定时任务不能把进程带崩）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../../../dist/sync/scheduler');
const { createLogger } = require('../../../dist/common/logger');

const quietLogger = () => createLogger({ level: 'error', sink: () => undefined });

test('单并发：跑到一半再触发，不会启动第二次（也不排队）', async () => {
  let calls = 0;
  let release = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const scheduler = createScheduler({
    intervalMinutes: 60,
    logger: quietLogger(),
    run: async () => {
      calls++;
      await gate;
    },
  });

  const first = scheduler.triggerNow();
  const second = scheduler.triggerNow();
  assert.equal(calls, 1, '第二次触发必须复用进行中的那次');
  assert.equal(scheduler.isRunning(), true);

  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(scheduler.isRunning(), false);
  assert.ok(scheduler.lastRunAt() instanceof Date);
});

test('run 抛异常不冒泡（否则 pm2 会反复重启）', async () => {
  const scheduler = createScheduler({
    intervalMinutes: 60,
    logger: quietLogger(),
    run: async () => {
      throw new Error('boom');
    },
  });
  await assert.doesNotReject(() => scheduler.triggerNow());
  assert.equal(scheduler.isRunning(), false, '异常后必须释放闸门，否则后续触发永远被吞');
});

test('定时触发按间隔发生，stop 之后不再触发（假时钟）', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const scheduler = createScheduler({
    intervalMinutes: 1,
    logger: quietLogger(),
    run: async () => {
      calls++;
    },
  });

  scheduler.start();
  scheduler.start(); // 重复 start 不该叠加计时器
  t.mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, '重复 start 后仍应只触发一次');

  t.mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);

  scheduler.stop();
  t.mock.timers.tick(120_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'stop 之后绝不该再触发');
  t.mock.timers.reset();
});

test('alignedDelayMs：整点对齐的毫秒数（纯函数，跨边界正确）', () => {
  const { alignedDelayMs } = require('../../../dist/sync/scheduler');
  const H = 3_600_000;
  const base = Date.parse('2026-10-09T12:00:00+08:00'); // 整点
  assert.equal(alignedDelayMs(base, 7, 60), 7 * 60_000, '整点时刻 → 7 分钟后');
  assert.equal(alignedDelayMs(base + 5 * 60_000, 7, 60), 2 * 60_000, '12:05 → 12:07');
  assert.equal(alignedDelayMs(base + 7 * 60_000, 7, 60), 60 * 60_000, '恰好 12:07 → 下一轮 13:07（不零延迟自爆）');
  assert.equal(alignedDelayMs(base + 59 * 60_000, 7, 60), 8 * 60_000, '12:59 → 13:07');
  assert.equal(alignedDelayMs(base + H + 30 * 60_000, 7, 60), 37 * 60_000, '跨小时边界 13:30 → 14:07');
});

test('alignMinute：首次触发对齐整点后第 N 分钟，之后按周期走（假时钟）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  // now 固定在 12:05:00，alignMinute=7 → 首次延迟 2 分钟，之后每 60 分钟
  const now = () => new Date(Date.parse('2026-10-09T12:05:00+08:00'));
  let calls = 0;
  const scheduler = createScheduler({
    intervalMinutes: 60,
    alignMinute: 7,
    now,
    logger: quietLogger(),
    run: async () => {
      calls++;
    },
  });
  scheduler.start();
  t.mock.timers.tick(60_000); // 12:06：还没到
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  t.mock.timers.tick(60_000); // 12:07：首次触发
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  t.mock.timers.tick(59 * 60_000); // 13:06：周期未到
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  t.mock.timers.tick(60_000); // 13:07：第二次
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  scheduler.stop();
  t.mock.timers.tick(120 * 60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, 'stop 之后绝不该再触发');
  t.mock.timers.reset();
});
