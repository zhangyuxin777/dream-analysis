/**
 * `doctor` 的连接类事件判定：必须用事件目录（`isConnection`）这一处真源。
 * 原来它硬编码 `['UDS_','MARKET_STREAM_','WORKER_WS_','ORDER_CANCELED']`：
 * ① `ORDER_CANCELED` **不是**连接事件（是订单事件）⇒ 让"上传侧有没有把连接事件放进来"这个契约检查**假通过**；
 * ② 漏了 `WS_`（WS_ERROR/WS_RECONNECTED/WS_USER_DATA_ERROR）⇒ 只有 WS 事件的分片会被误判成"没有"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isConnection, CONNECTION_EVENTS } = require('../../../dist/analysis/events');

test('连接类事件判定：用目录，不硬编码前缀（ORDER_CANCELED 不算、WS_* 要算）', () => {
  assert.equal(isConnection('ORDER_CANCELED'), false, 'ORDER_CANCELED 是订单事件 —— 算成连接事件会让契约检查假通过');
  assert.equal(isConnection('WS_RECONNECTED'), true, 'WS_* 是连接事件（旧前缀表漏了它）');
  assert.equal(isConnection('WS_ERROR'), true);
  assert.equal(isConnection('UDS_SUBSCRIBE_OK'), true);
  assert.equal(isConnection('MARKET_STREAM_UNRECOVERED'), true);
  assert.equal(isConnection('WORKER_WS_STALE_RECONNECT'), true);
  assert.equal(isConnection('BUY_FILLED'), false);
  assert.ok(CONNECTION_EVENTS.includes('WS_RECONNECTED'));
});
