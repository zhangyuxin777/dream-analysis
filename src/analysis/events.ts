/**
 * 事件目录（所有分析器共用的**单一真源**）。
 *
 * 权威来源：主仓 `dream_develop/src/common/ossExport.ts` → `TIMELINE_EVENT_WHITELIST`
 * （**140 个**事件名，2026-10-05 核对）。只有进白名单的事件才会出现在分片里。
 *
 * 三条纪律（都是踩过坑换来的）：
 * ① **别凭印象写事件名**：设计稿里的 `STOP_SIGNAL_RECEIVED`/`RESUME_SIGNAL_RECEIVED` **不存在**，
 *    真名是 `STOP_SIGNAL`/`STOP_SIGNAL_RESUMED`。
 * ② **别用后缀正则猜"异常"**：`health` 早先用 `(_ERROR|_FAILED|UNRECOVERED|_ALERT)$` 计数，
 *    漏掉 `ORDER_EXPIRED`/`ORDER_UNKNOWN_STATUS`/`RESET_RATE_LIMITED`/`RATE_LIMITED`/`SELL_ORDER_LOST`/
 *    `SELL_STATE_UNRECONCILED`/`WORKER_TICKER_INVALID`/`TOPUP_EXHAUSTED` 等一大票（真数据近 7 天真实 32 条，
 *    正则只数出十几条）⇒ 这里**逐个列名**。
 * ③ 严重度**不抄 `notify` 标志**：模板表里 notify 默认就是推送（164 条显式 `notify:false`），
 *    拿它当"严重程度"会把 `NEW_ROUND` 也算严重。这里的 `CRITICAL_EVENTS` 是照着模板注释的**意图**挑的
 *    （如 `NEW_GAME_ERROR` 注释写"会自动重试开轮（无需处理）"⇒ 不算最紧急；
 *    `WORKER_WS_STALE_RECONNECT` 写"能自愈就不出声"⇒ 不算；而撤单失败/需人工介入的才算）。
 */

/** 需要人看一眼的事件（异常/退化/未恢复/需人工）。逐个列名，不用后缀猜。 */
export const ATTENTION_EVENTS: readonly string[] = [
  // 轮次/复位（`WORKER_DEVIATION_RESET` 是**正常**换锚机制，模板里 notify:false ⇒ 不算"需要看"；
  // 真正可动的是 SKIP —— 想复位却被 guard 挡住）
  'NEW_GAME_ERROR', 'RESET_CANCEL_FAILED', 'RESET_RATE_LIMITED', 'RESET_RETRY_FAILED', 'WORKER_DEVIATION_SKIP',
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
  'WORKER_TICKER_INVALID', 'KLINE_PULL_FAILED', 'KLINE_FETCH_ERROR',
  // 启动/恢复
  'STARTUP_ERROR', 'RECOVERY_WRITE_FAILED', 'RECOVERY_NO_SNAPSHOT', 'RECOVERY_NO_ACTIVE_ROUND',
  'RECOVERY_DISCARDED',
  // carry
  'CARRY_RETURN_FAILED', 'CARRY_OPEN_FAILED',
];

/**
 * 最该立刻看的一小撮（未恢复 / 连续失败 / 丢单 / 未对账 / 资金安全 / 启动失败）。
 * 依据：模板注释里"需要处理"的语义 + 不在 `notify:false`（即主仓自己也会推送）的那些。
 * 刻意**不含** `WORKER_WS_STALE_RECONNECT`（注释：能自愈就不出声）与 `NEW_GAME_ERROR`（注释：会自动重试，无需处理）——
 * 把它们算"最紧急"会让每次自愈/重试都在告警头部刷"最该立刻看"，把真正需要人工的淹掉。
 */
export const CRITICAL_EVENTS: readonly string[] = [
  'UDS_RETRY_FAIL_ALERT', 'MARKET_STREAM_UNRECOVERED',
  'SELL_ORDER_LOST', 'SELL_STATE_UNRECONCILED', 'SELL_STATE_NO_LEDGER_MANUAL',
  'RESET_CANCEL_FAILED', // 撤单失败 ⇒ 交易所可能仍留着本程序的挂单（资金安全）
  // 补仓已成交但**换卖单失败**：模板注释写"本轮补过仓属于'不自动重建'的守卫，程序不会自动重挂卖单；
  // 下一笔买单成交时会再挂"⇒ 这轮在下一笔买单成交前**不会卖出**（就是我们看到的"卡住"），且注释明说要人工核对
  'TOPUP_REPLACE_FAILED',
  'STARTUP_ERROR', 'RECOVERY_WRITE_FAILED',
];

// ---------------- 连接：分**通道**配对（三个互相独立的连接，混在一张表里会串） ----------------

/**
 * 三条独立的连接通道：
 * - `uds`：币安用户数据流（`MyBinanceSpot`）—— `UDS_*`
 * - `market`：行情 WebSocket（`MarketStreamManager`）—— `MARKET_STREAM_*`
 * - `worker-ws`：worker 自己的 WS —— `WORKER_WS_*` / `WS_*`
 * 混成一条会把"行情流断了"用一条 UDS 恢复事件收尾（断流次数/时长/最长一次全错）。
 */
export type ConnChannel = 'uds' | 'market' | 'worker-ws';

export const CONNECTION_EVENTS: readonly string[] = [
  'UDS_SUBSCRIBE_OK', 'UDS_SUBSCRIBE_FAIL', 'UDS_CONN_CLOSED', 'UDS_CONN_CLOSED_STALE',
  'UDS_CONN_ERROR', 'UDS_CONN_UNAVAILABLE', 'UDS_RETRY_OK', 'UDS_RETRY_FAIL_ALERT',
  'MARKET_STREAM_REARM', 'MARKET_STREAM_REARM_OK', 'MARKET_STREAM_REARM_FAILED',
  'MARKET_STREAM_RECOVERED', 'MARKET_STREAM_UNRECOVERED',
  'WS_RECONNECTED', 'WS_ERROR', 'WS_USER_DATA_ERROR',
  'WORKER_WS_CLOSE', 'WORKER_WS_ERROR', 'WORKER_WS_SUBSCRIBE_FAILED', 'WORKER_WS_STALE_RECONNECT',
];

function channelOf(event: string): ConnChannel | null {
  if (event.startsWith('UDS_')) return 'uds';
  if (event.startsWith('MARKET_STREAM_')) return 'market';
  if (event.startsWith('WORKER_WS_') || event.startsWith('WS_')) return 'worker-ws';
  return null;
}

/** 断流**开始**：该通道确实断了/确认不可用（`UDS_CONN_ERROR` 只是报错，不算断开，否则时长虚高） */
export function outageStartChannel(event: string): ConnChannel | null {
  switch (event) {
    case 'UDS_CONN_CLOSED':
    case 'UDS_CONN_CLOSED_STALE':
    case 'UDS_CONN_UNAVAILABLE':
      return 'uds';
    // 行情流：币安路径不发 UDS_CONN_CLOSED 表示行情断流；**rearm 一开始就说明流是坏的**（那是唯一权威起点）
    case 'MARKET_STREAM_REARM':
    case 'MARKET_STREAM_REARM_FAILED':
    case 'MARKET_STREAM_UNRECOVERED':
      return 'market';
    case 'WORKER_WS_CLOSE':
    case 'WORKER_WS_STALE_RECONNECT':
      return 'worker-ws';
    default:
      return null;
  }
}

/** 断流**结束**（该通道恢复） */
export function outageEndChannel(event: string): ConnChannel | null {
  switch (event) {
    case 'UDS_SUBSCRIBE_OK':
    case 'UDS_RETRY_OK':
      return 'uds';
    case 'MARKET_STREAM_REARM_OK':
    case 'MARKET_STREAM_RECOVERED':
      return 'market';
    case 'WS_RECONNECTED':
    case 'WORKER_WS_SUBSCRIBED':
      return 'worker-ws';
    default:
      return null;
  }
}

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

const ATTENTION_SET = new Set(ATTENTION_EVENTS);
const CRITICAL_SET = new Set(CRITICAL_EVENTS);

export function isAttention(e: string): boolean {
  return ATTENTION_SET.has(e);
}

export function isCritical(e: string): boolean {
  return CRITICAL_SET.has(e);
}

export function isConnection(e: string): boolean {
  return channelOf(e) !== null;
}

/** 事件分类（用于分组展示；认不出的归 other） */
export type EventKind = 'round' | 'profit' | 'topup' | 'crash' | 'stop' | 'order' | 'connection' | 'recovery' | 'account' | 'config' | 'signal' | 'other';

const KIND_BY_PREFIX: Array<[RegExp, EventKind]> = [
  [/^TOPUP_/, 'topup'],
  [/^CRASH_/, 'crash'],
  [/^STOP_SIGNAL(_RESUMED)?$/, 'stop'],
  [/^(RESET_|NEW_ROUND|NEW_GAME|ROUND_|BUY_FILLED|SELL_FILLED|WORKER_DEVIATION)/, 'round'],
  [/^(PROFIT_|ORDER_FILLED|ORDER_EXTERNAL)/, 'profit'],
  [/^(ORDER_|SELL_|RATE_LIMITED|HEALTH_CHECK_)/, 'order'],
  [/^(UDS_|MARKET_STREAM_|WS_|WORKER_WS_|WORKER_TICKER|KLINE_)/, 'connection'],
  [/^(STARTUP_|RECOVERY_|SALVAGE_)/, 'recovery'],
  [/^ACCOUNT_OBSERVED$/, 'account'],
  [/^WORKER_(CONFIG|ENV)_/, 'config'],
  [/^(ATR_|SQUEEZE_|SIDEWAYS_|SIGNAL_)/, 'signal'],
];

export function kindOf(event: string): EventKind {
  for (const [re, kind] of KIND_BY_PREFIX) if (re.test(event)) return kind;
  return 'other';
}

/** 已知类别（供参数校验/文档用） */
export const EVENT_KINDS: readonly EventKind[] = [
  'round', 'profit', 'topup', 'crash', 'stop', 'order', 'connection', 'recovery', 'account', 'config', 'signal', 'other',
];

/**
 * 注意 摘出这条事件里值得展示的字段。
 * 注意 **不用固定的字段白名单**（那是我照猜的：真数据上 32 条里 24 条的"关键字段"是空的）。
 * 直接遍历 data 自己的**标量**字段（跳过嵌套对象/数组与超长字符串），按出现顺序取前 N 个。
 */
export function detailOf(data: Record<string, unknown> | undefined, max = 4, maxLen = 40): string {
  if (!data || typeof data !== 'object') return '';
  const parts: string[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (parts.length >= max) break;
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') continue; // 嵌套结构不进明细（分片里有全量）
    const text = String(v);
    parts.push(`${key}=${text.length > maxLen ? `${text.slice(0, maxLen)}…` : text}`);
  }
  return parts.join(' ');
}
