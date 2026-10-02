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
