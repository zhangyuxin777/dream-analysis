/**
 * 事件目录（所有分析器共用的**单一真源**）。
 *
 * 权威来源：主仓 `dream_develop/src/common/ossExport.ts` 的 `TIMELINE_EVENT_WHITELIST`（94 个事件名）——
 * 只有进白名单的事件才会出现在分片里。**别凭印象写事件名**：
 * ① 设计稿里的 `STOP_SIGNAL_RECEIVED`/`RESUME_SIGNAL_RECEIVED` **不存在**，真名是
 *    `STOP_SIGNAL`/`STOP_SIGNAL_RESUMED`（白名单注释里专门标了）；
 * ② `health` 早先用后缀正则（`_ERROR|_FAILED|UNRECOVERED|_ALERT`）数"异常类事件"，
 *    会漏掉 `ORDER_EXPIRED`/`ORDER_UNKNOWN_STATUS`/`RESET_RATE_LIMITED`/`RATE_LIMITED`/`SELL_ORDER_LOST`/
 *    `SELL_STATE_UNRECONCILED`/`SELL_FILLED_IGNORED`/`WORKER_WS_STALE_RECONNECT`/`WORKER_TICKER_INVALID`/
 *    `HEALTH_CHECK_NO_ORDERS`/`TOPUP_EXHAUSTED` 等 —— 所以这里改成**逐个列名**。
 */

/** 需要人看一眼的事件（异常/退化/未恢复）。逐个列名，不用后缀猜。 */
export const ATTENTION_EVENTS: readonly string[] = [
  // 轮次/复位
  'NEW_GAME_ERROR', 'RESET_CANCEL_FAILED', 'RESET_RATE_LIMITED', 'RESET_RETRY_FAILED',
  'WORKER_DEVIATION_RESET',
  // 补仓
  'TOPUP_FAILED', 'TOPUP_REPLACE_FAILED', 'TOPUP_EXHAUSTED', 'TOPUP_SKIPPED', 'TOPUP_LAST_TIER_REACHED',
  // 预算/止盈档
  'BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED_RECORDED', 'DYNAMIC_PROFIT_ERROR', 'DYNAMIC_PROFIT_REDUCED',
  // 止盈下单
  'PROFIT_ORDER_FAILED', 'PROFIT_PLACE_ERROR', 'PROFIT_BALANCE_FAILED',
  'PROFIT_CANCEL_SELL_FAILED', 'PROFIT_CANCEL_ALL_FAILED',
  // 深跌退出
  'CRASH_EXIT_REGRID_FAILED', 'CRASH_EXIT_RATE_LIMITED', 'CRASH_EXIT_NO_ANCHOR', 'CRASH_EXIT_GUARD_SKIP',
  // 订单异常
  'ORDER_EXPIRED', 'ORDER_UNKNOWN_STATUS', 'ORDER_FILL_ACCOUNT_ERROR', 'ORDER_MANUAL_SELL_CLEANUP',
  'ORDER_SELL_NO_LAST_ID', 'RATE_LIMITED',
  // 卖出异常与修复
  'SELL_ORDER_LOST', 'SELL_STATE_UNRECONCILED', 'SELL_STATE_CRASH_MANUAL', 'SELL_STATE_NO_LEDGER_MANUAL',
  'SELL_STATE_NO_LEDGER_WARMUP', 'SELL_REPAIRED_CID_MISMATCH', 'SELL_FILLED_IGNORED', 'SELL_REPAIR_SKIPPED',
  // 健康检查
  'HEALTH_CHECK_NO_ORDERS', 'HEALTH_CHECK_BUDGET_INSUFFICIENT', 'HEALTH_CHECK_ERROR',
  // 连接 / 行情流
  'UDS_SUBSCRIBE_FAIL', 'UDS_CONN_CLOSED', 'UDS_CONN_CLOSED_STALE', 'UDS_CONN_ERROR', 'UDS_CONN_UNAVAILABLE',
  'UDS_RETRY_FAIL_ALERT', 'MARKET_STREAM_REARM_FAILED', 'MARKET_STREAM_UNRECOVERED',
  'WS_ERROR', 'WS_USER_DATA_ERROR', 'WORKER_WS_ERROR', 'WORKER_WS_SUBSCRIBE_FAILED',
  'WORKER_WS_STALE_RECONNECT', 'WORKER_TICKER_INVALID', 'KLINE_PULL_FAILED', 'KLINE_FETCH_ERROR',
  // 启动/恢复
  'STARTUP_ERROR', 'RECOVERY_WRITE_FAILED', 'RECOVERY_NO_SNAPSHOT', 'RECOVERY_NO_ACTIVE_ROUND',
  'RECOVERY_DISCARDED',
  // carry
  'CARRY_RETURN_FAILED', 'CARRY_OPEN_FAILED',
];

/**
 * 最该立刻看的一小撮（未恢复/连续失败/丢单/未对账/启动失败）。
 * 出现它们就是"真出事了"，不该只混在异常堆里。
 */
export const CRITICAL_EVENTS: readonly string[] = [
  'UDS_RETRY_FAIL_ALERT', 'MARKET_STREAM_UNRECOVERED', 'WORKER_WS_STALE_RECONNECT',
  'SELL_ORDER_LOST', 'SELL_STATE_UNRECONCILED', 'STARTUP_ERROR', 'NEW_GAME_ERROR', 'RECOVERY_WRITE_FAILED',
];

/** 连接/行情流的状态变化（断流、重连、停摆的唯一直接证据） */
export const CONNECTION_EVENTS: readonly string[] = [
  'UDS_SUBSCRIBE_OK', 'UDS_SUBSCRIBE_FAIL', 'UDS_CONN_CLOSED', 'UDS_CONN_CLOSED_STALE',
  'UDS_CONN_ERROR', 'UDS_CONN_UNAVAILABLE', 'UDS_RETRY_OK', 'UDS_RETRY_FAIL_ALERT',
  'MARKET_STREAM_REARM', 'MARKET_STREAM_REARM_OK', 'MARKET_STREAM_REARM_FAILED',
  'MARKET_STREAM_RECOVERED', 'MARKET_STREAM_UNRECOVERED',
  'WS_RECONNECTED', 'WS_ERROR', 'WS_USER_DATA_ERROR',
  'WORKER_WS_CLOSE', 'WORKER_WS_ERROR', 'WORKER_WS_SUBSCRIBE_FAILED', 'WORKER_WS_STALE_RECONNECT',
];

/** 断流开始（连接确实断了/不可用）；`UDS_CONN_ERROR` 只算"报错"不算断流，避免把瞬时错误当断流 */
export const OUTAGE_START_EVENTS: readonly string[] = ['UDS_CONN_CLOSED', 'UDS_CONN_CLOSED_STALE', 'UDS_CONN_UNAVAILABLE'];
/** 断流结束（重新订阅成功 / 重连成功） */
export const OUTAGE_END_EVENTS: readonly string[] = ['UDS_SUBSCRIBE_OK', 'UDS_RETRY_OK', 'MARKET_STREAM_RECOVERED'];

/** 停轮 / 复轮（"有没有偷偷停轮"的唯一证据；真名见白名单注释） */
export const STOP_EVENTS: readonly string[] = ['STOP_SIGNAL', 'STOP_SIGNAL_RESUMED'];

/** 补仓动作（低频业务动作） */
export const TOPUP_EVENTS: readonly string[] = [
  'TOPUP_TRIGGERED', 'TOPUP_EXECUTED', 'TOPUP_ORDER_FILLED', 'TOPUP_FAILED', 'TOPUP_EXHAUSTED',
  'TOPUP_SKIPPED', 'TOPUP_LAST_TIER_REACHED', 'TOPUP_PROFIT_RESET', 'TOPUP_REPLACE_FAILED',
];

/** 深跌进出 */
export const CRASH_EVENTS: readonly string[] = ['CRASH_ENTERED', 'CRASH_EXITED'];

/** 配置回显（启动一次 ⇒ 参数溯源；展示层会折叠它） */
export const CONFIG_ECHO_RE = /^WORKER_(CONFIG|ENV)_/;

/** 明细里值得展示的字段（按白名单事件的 data 形状挑的，取不到就跳过） */
export const DETAIL_FIELDS: readonly string[] = [
  'error', 'reason', 'code', 'message', 'retryCount', 'delaySec', 'downtimeSec', 'attempts', 'channel',
  'clientOrderId', 'orderId', 'symbol', 'price', 'qty', 'profit', 'dropPercent', 'drawdownPercent',
  'remaining', 'spent', 'tier', 'index', 'staleSec', 'elapsedSec',
];

const ATTENTION_SET = new Set(ATTENTION_EVENTS);
const CRITICAL_SET = new Set(CRITICAL_EVENTS);
const CONNECTION_SET = new Set(CONNECTION_EVENTS);

export function isAttention(e: string): boolean {
  return ATTENTION_SET.has(e);
}

export function isCritical(e: string): boolean {
  return CRITICAL_SET.has(e);
}

export function isConnection(e: string): boolean {
  return CONNECTION_SET.has(e);
}

/** 事件分类（用于分组展示；认不出的归 other） */
export type EventKind = 'round' | 'profit' | 'topup' | 'crash' | 'stop' | 'order' | 'connection' | 'recovery' | 'account' | 'config' | 'signal' | 'other';

const KIND_BY_PREFIX: Array<[RegExp, EventKind]> = [
  [/^TOPUP_/, 'topup'],
  [/^CRASH_/, 'crash'],
  [/^(STOP_SIGNAL|STOP_SIGNAL_RESUMED)$/, 'stop'],
  [/^(RESET_|NEW_ROUND|NEW_GAME|ROUND_|BUY_FILLED|SELL_FILLED|WORKER_DEVIATION)/, 'round'],
  [/^(PROFIT_|ORDER_)/, 'profit'],
  [/^(ORDER_|SELL_|RATE_LIMITED|HEALTH_CHECK_)/, 'order'],
  [/^(UDS_|MARKET_STREAM_|WS_|WORKER_WS_|WORKER_TICKER|KLINE_)/, 'connection'],
  [/^(STARTUP_|RECOVERY_|SALVAGE_)/, 'recovery'],
  [/^ACCOUNT_OBSERVED$/, 'account'],
  [/^WORKER_(CONFIG|ENV)_/, 'config'],
  [/^(ATR_|SQUEEZE_|SIDEWAYS_)/, 'signal'],
];

export function kindOf(event: string): EventKind {
  for (const [re, kind] of KIND_BY_PREFIX) if (re.test(event)) return kind;
  return 'other';
}

/** 摘出这条事件里值得展示的字段（短字符串，供明细表用） */
export function detailOf(data: Record<string, unknown> | undefined, max = 3, maxLen = 40): string {
  if (!data || typeof data !== 'object') return '';
  const parts: string[] = [];
  for (const key of DETAIL_FIELDS) {
    if (parts.length >= max) break;
    const v = data[key];
    if (v === undefined || v === null || v === '') continue;
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${key}=${text.length > maxLen ? `${text.slice(0, maxLen)}…` : text}`);
  }
  return parts.join(' ');
}
