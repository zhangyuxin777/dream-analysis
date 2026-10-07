/**
 * LP 报告：A 节奏（日报定时推送）+ B 触发（异常实时通知）。
 *
 * 设计原则（dream/docs/LP报告机制.md 同款）：
 * - LP 视角：只说"你的账户"，不说策略术语（ATR/档位/补仓一律不出现）
 * - 收益口径 = 已实现网格利润（ΣROUND_COMPLETED.profit），与实盘业绩记录一致
 * - 坏消息抢在 LP 发现之前说；没事绝不打扰
 * - "无需任何操作"是默认假设，消息里不写
 *
 * 触发状态持久化在 stateDir/lp-reporter-state.json，重启/重复同步不重复推送。
 */
import * as fs from 'fs';
import * as path from 'path';
import { LpAccountConfig } from '../config';
import { EventSourceLike, LoadedEventLike } from '../analysis/types';
import { ILogger } from '../common/logger';

const TZ = 'Asia/Shanghai';

export interface AccountFacts {
  /** 本地数据覆盖的日期（北京时区） */
  days: string[];
  /** 全部已实现利润（ΣROUND_COMPLETED.profit） */
  totalProfit: number;
  /** 今天（北京）已实现利润 */
  todayProfit: number;
  todayRounds: number;
  completedRounds: number;
  /** 最新账户估值快照 */
  latestObs: { t: string; total: number; fdusdFree: number } | null;
  /** 未收口且已建仓的轮（可能跨多天） */
  openRounds: OpenRound[];
  /** 深跌事件（含退出信息，若窗口内有） */
  crashes: CrashInfo[];
  topupCount: number;
  /** 今天是否零盈利（用于日报状态行） */
  zeroToday: boolean;
}

export interface OpenRound {
  roundId: string;
  symbol: string;
  lastBuyAt: string;
  sellPrice: number | null;
  /** 本轮买入笔数 */
  buyCount: number;
  /** 本轮累计投入（最后一笔的 accCost） */
  totalCost: number | null;
  /** 加权买入均价 */
  avgBuyPrice: number | null;
  /** 最近一笔买入价 */
  lastBuyPrice: number | null;
  /** 本轮动用备用金次数 */
  topupCount: number;
}

export interface CrashInfo {
  enteredAt: string;
  symbol: string;
  exitedAt: string | null;
  durationSec: number | null;
  /** 深跌期间买入总金额（0 = 未动用资金） */
  totalCost: number | null;
  /** 实际跌幅（CRASH_ENTERED 的 dropPercent） */
  dropPercent: number | null;
}

/** 收集一个 LP 账户的全部事实（扫本地所有可用天） */
export async function collectFacts(
  source: EventSourceLike,
  account: Pick<LpAccountConfig, 'instance'>,
  now: Date,
): Promise<AccountFacts> {
  const days = source.availableDays(account.instance);
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: TZ });

  const rounds = new Map<string, {
    symbol: string; openedAt: string; lastBuyAt: string | null; buyCount: number; completed: boolean;
    prevAccCost: number | null; costSum: number; spendSum: number;
    lastBuyPrice: number | null; topups: number; lastActivityAt: string;
  }>();
  let totalProfit = 0;
  let todayProfit = 0;
  let todayRounds = 0;
  let completedRounds = 0;
  let latestObs: AccountFacts['latestObs'] = null;
  const crashes = new Map<string, CrashInfo>();
  let topupCount = 0;
  // 所有出现过的 roundId（不论是否建仓）按轮号记活动时间 —— 恢复接管的 -RCV 轮可能没有 BUY_FILLED，
  // 但 ORDER_FILLED/SELL_FILLED/ORDER_CANCELED 等事件足够证明"同轮号的旧 id 已被接管"
  const prefixActivity = new Map<string, string>();

  const window = { label: '全部', fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, days };
  await source.scan({ window, instance: account.instance }, (e: LoadedEventLike) => {
    const ev = e.event;
    const rid = typeof e.roundId === 'string' ? e.roundId : null;
    // 任何带 roundId 的事件都算"该轮的活动"（重启恢复会产生新 roundId 接管同轮 ⇒ 旧 id 活动停止）
    if (rid) {
      const prefix = rid.split('-')[0];
      const prev = prefixActivity.get(prefix);
      if (prev == null || e.ts > prev) prefixActivity.set(prefix, e.ts);
      const touched = rounds.get(rid);
      if (touched && e.ts > touched.lastActivityAt) touched.lastActivityAt = e.ts;
    }
    if (ev === 'ROUND_COMPLETED' && rid) {
      const p = Number(e.data?.profit ?? 0);
      totalProfit += p;
      completedRounds += 1;
      const d = beijingDayOf(e.ts);
      if (d === todayStr) { todayProfit += p; todayRounds += 1; }
      const r = rounds.get(rid);
      if (r) r.completed = true;
    } else if (ev === 'NEW_ROUND' && rid) {
      if (!rounds.has(rid)) rounds.set(rid, {
        symbol: e.symbol ?? '?', openedAt: e.ts, lastBuyAt: null, buyCount: 0, completed: false,
        prevAccCost: null, costSum: 0, spendSum: 0, lastBuyPrice: null, topups: 0, lastActivityAt: e.ts,
      });
    } else if (ev === 'BUY_FILLED' && rid) {
      const r = rounds.get(rid) ?? {
        symbol: e.symbol ?? '?', openedAt: e.ts, lastBuyAt: null, buyCount: 0, completed: false,
        prevAccCost: null, costSum: 0, spendSum: 0, lastBuyPrice: null, topups: 0, lastActivityAt: e.ts,
      };
      if (e.ts > r.lastActivityAt) r.lastActivityAt = e.ts;
      r.buyCount += 1;
      r.lastBuyAt = e.ts;
      const buyPrice = Number(e.data?.buyPrice ?? NaN);
      const accCost = Number(e.data?.accCost ?? NaN);
      if (Number.isFinite(buyPrice)) r.lastBuyPrice = buyPrice;
      if (Number.isFinite(accCost)) {
        const spend = r.prevAccCost == null ? accCost : accCost - r.prevAccCost;
        if (Number.isFinite(buyPrice) && spend > 0) {
          r.costSum += buyPrice * spend;
          r.spendSum += spend;
        }
        r.prevAccCost = accCost;
      }
      rounds.set(rid, r);
    } else if (ev === 'ACCOUNT_OBSERVED') {
      const total = Number(e.data?.totalValue ?? NaN);
      const balances = Array.isArray(e.data?.balances) ? e.data.balances as Array<{ asset: string; qtyFree?: number }> : [];
      const fdusdFree = Number(balances.find((b) => b.asset === 'FDUSD')?.qtyFree ?? NaN);
      if (Number.isFinite(total) && Number.isFinite(fdusdFree)) {
        latestObs = { t: e.ts, total, fdusdFree };
      }
    } else if (ev === 'CRASH_ENTERED') {
      crashes.set(`${e.ts}:${e.symbol}`, {
        enteredAt: e.ts, symbol: e.symbol ?? '?',
        exitedAt: null, durationSec: null, totalCost: null,
        dropPercent: Number(e.data?.dropPercent ?? NaN) || null,
      });
    } else if (ev === 'CRASH_EXITED') {
      // 退出事件不带进入时间，按"之前最近的同币种进入"配对（简化：窗口内够用）
      const cand = [...crashes.values()].filter((c) => c.symbol === e.symbol && !c.exitedAt).pop();
      if (cand) {
        cand.exitedAt = e.ts;
        cand.durationSec = Number(e.data?.durationSec ?? NaN) || null;
        cand.totalCost = Number(e.data?.totalCost ?? NaN) || null;
      }
    } else if (ev.startsWith('TOPUP_')) {
      topupCount += 1;
      const r = rid ? rounds.get(rid) : undefined;
      if (r) r.topups += 1;
    }
  });

  const sellByRound = new Map<string, number>();
  await source.scan({ window, instance: account.instance }, (e: LoadedEventLike) => {
    if (e.event === 'PROFIT_PLACE_PARAMS' && typeof e.roundId === 'string') {
      const raw = typeof e.data?.params === 'string' ? e.data.params : '';
      const m = /"price":([\d.]+)/.exec(raw);
      if (m) sellByRound.set(e.roundId, Number(m[1]));
    }
  });

  // 重启恢复（RECOVERY_APPLIED）会把同轮仓位接管到新 roundId（如 R009-xxx-RCV），
  // 旧 roundId 从此再没事件 —— 它是"残影"，不是真持仓。同一轮号（R009）里只有活动最新的才是活轮。
  const openRounds: OpenRound[] = [...rounds.entries()]
    .filter(([, r]) => !r.completed && r.buyCount > 0)
    .filter(([rid, r]) => prefixActivity.get(rid.split('-')[0]) === r.lastActivityAt)
    .map(([rid, r]) => ({
      roundId: rid,
      symbol: r.symbol,
      lastBuyAt: r.lastBuyAt ?? r.openedAt,
      sellPrice: sellByRound.get(rid) ?? null,
      buyCount: r.buyCount,
      totalCost: r.prevAccCost,
      avgBuyPrice: r.spendSum > 0 ? r.costSum / r.spendSum : null,
      lastBuyPrice: r.lastBuyPrice,
      topupCount: r.topups,
    }))
    .sort((a, b) => a.lastBuyAt.localeCompare(b.lastBuyAt));

  return {
    days, totalProfit, todayProfit, todayRounds, completedRounds,
    latestObs, openRounds, crashes: [...crashes.values()], topupCount,
    zeroToday: todayProfit === 0,
  };
}

function beijingDayOf(ts: string): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
}

function beijingTimeOf(ts: string): string {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

/** 金额：千分位 + 固定小数位（LP 看到的 $100,137.02 形式） */
function money(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 带符号百分比 */
function signedPct(n: number, digits = 2): string {
  return (n < 0 ? '-' : '+') + fmt(Math.abs(n), digits) + '%';
}

function shortSymbol(symbol: string): string {
  return symbol.replace(/FDUSD$|USDT$/i, '');
}

// ============ A 节奏：日报渲染 ============

/** LP 日报（格式与 dream/docs 里 LP 确认的模板一致） */
export function renderDaily(facts: AccountFacts, account: LpAccountConfig, now: Date): string {
  // 累计收益用权益口径（估值-本金），与"账户估值"一行自洽；LP 视角"我的钱现在值多少"优先于会计口径
  const valuation = facts.latestObs ? facts.latestObs.total : account.principal + facts.totalProfit;
  const cum = valuation - account.principal;
  const cumPct = (cum / account.principal) * 100;
  const dayLabel = `第 ${Math.max(1, facts.days.length)} 天`;
  const obsTime = facts.latestObs ? beijingTimeOf(facts.latestObs.t).slice(5) : beijingTimeOf(now.toISOString()).slice(5);

  const lines = [
    `【日报】${account.label}`,
    '━━━━━━━━━━━━━━━',
    `今日收益：${facts.todayProfit < 0 ? '-' : '+'}$${money(Math.abs(facts.todayProfit))}`,
    `累计收益：${cum < 0 ? '-' : '+'}$${money(Math.abs(cum))}（${signedPct(cumPct)}）`,
    `账户估值：$${money(valuation)} ｜ 运行：${dayLabel}`,
    '━━━━━━━━━━━━━━━',
  ];
  if (facts.zeroToday) {
    lines.push('状态：今天市场平淡，持仓等待中，属正常节奏');
  } else {
    lines.push(`状态：正常运作中，今天完成 ${facts.todayRounds} 轮买卖`);
  }
  lines.push(`数据时间：${obsTime}`);
  return lines.join('\n');
}

// ============ B 触发：判定 ============

export interface TriggerHit {
  kind: 'crash' | 'stuck' | 'day_spike';
  message: string;
  /** 去重键（同一事件只推一次） */
  dedupeKey: string;
}

interface AccountTriggerState {
  lastCheckTs: string;
  fired: string[];
}

interface ReporterState {
  checks: Record<string, AccountTriggerState>;
  lastDaily: Record<string, string>;
}

export function evaluateTriggers(
  facts: AccountFacts,
  account: LpAccountConfig,
  now: Date,
  prev: AccountTriggerState | undefined,
): { hits: TriggerHit[]; next: AccountTriggerState } {
  const fired = new Set(prev?.fired ?? []);
  const hits: TriggerHit[] = [];
  const nowMs = now.getTime();

  const MAX_CRASH_AGE_MS = 48 * 3600_000;
  for (const c of facts.crashes) {
    const key = `crash:${c.enteredAt}:${c.symbol}`;
    if (fired.has(key)) continue;
    // 只报"已结束"的深跌（进入后还没退出的，等退出再报——LP 要的是结果）
    if (!c.exitedAt) continue;
    // 超过 48 小时的深跌是旧闻，首次部署别当新闻推
    if (Date.parse(c.enteredAt) < nowMs - MAX_CRASH_AGE_MS) continue;
    const hours = c.durationSec != null ? c.durationSec / 3600 : null;
    const costNote = c.totalCost != null && c.totalCost > 0
      ? `期间按计划在低位接货 $${money(c.totalCost)}。`
      : '本次防御没有动用你的备用资金。';
    const dropNote = c.dropPercent != null ? `${(c.dropPercent * 100).toFixed(1)}%` : '约 4%';
    hits.push({
      kind: 'crash',
      dedupeKey: key,
      message: [
        '⚠️ 实时通知',
        '━━━━━━━━━━━━━━━',
        `${shortSymbol(c.symbol)} 今天出现急跌（短时跌幅 ${dropNote}），程序已自动进入防守状态，放慢买入节奏保护本金。`,
        '━━━━━━━━━━━━━━━',
        `结果：${hours != null ? `约 ${fmt(hours, 1)} 小时后` : ''}市场回升，程序已自动恢复正常，${costNote}`,
        `数据时间：${beijingTimeOf(now.toISOString()).slice(5)}`,
      ].join('\n'),
    });
  }

  for (const r of facts.openRounds) {
    const hours = (nowMs - Date.parse(r.lastBuyAt)) / 3600_000;
    if (hours < account.stuckAlertHours) continue;
    const key = `stuck:${r.roundId}`;
    if (fired.has(key)) continue;
    const sym = shortSymbol(r.symbol);
    const h = Math.floor(hours);
    const durationNote = h >= 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 小时` : `${h} 小时`;

    // 详情块：LP 看得懂的数字，不出现策略术语
    const detailLines: string[] = [];
    if (r.totalCost != null && Number.isFinite(r.totalCost)) {
      detailLines.push(`· 已投入资金：$${money(r.totalCost)}（分 ${r.buyCount} 笔买入）`);
    } else {
      detailLines.push(`· 已分 ${r.buyCount} 笔买入`);
    }
    if (r.avgBuyPrice != null) detailLines.push(`· 买入均价：$${money(r.avgBuyPrice)}`);
    if (r.lastBuyPrice != null) {
      detailLines.push(`· 最近一笔买入：$${money(r.lastBuyPrice)}（${beijingTimeOf(r.lastBuyAt).slice(5)}）`);
    }
    if (r.sellPrice != null) {
      const gap = r.avgBuyPrice != null && r.avgBuyPrice > 0
        ? `，比买入均价高 ${(((r.sellPrice - r.avgBuyPrice) / r.avgBuyPrice) * 100).toFixed(1)}%`
        : '';
      detailLines.push(`· 当前挂卖价：$${money(r.sellPrice)}${gap}`);
    }
    if (r.topupCount > 0) detailLines.push(`· 已动用备用金 ${r.topupCount} 次（策略允许的安全机制）`);

    hits.push({
      kind: 'stuck',
      dedupeKey: key,
      message: [
        '📌 实时通知',
        '━━━━━━━━━━━━━━━',
        `你有一笔 ${sym} 持仓已等待 ${durationNote}尚未卖出，详情如下：`,
        ...detailLines,
        '━━━━━━━━━━━━━━━',
        '属正常持仓等反弹，历史上多数 1~3 天内成交。',
        `数据时间：${beijingTimeOf(now.toISOString()).slice(5)}`,
      ].join('\n'),
    });
  }

  const spikeThreshold = (account.principal * account.dayProfitAlertPct) / 100;
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const spikeKey = `day_spike:${todayStr}`;
  if (facts.todayProfit >= spikeThreshold && !fired.has(spikeKey)) {
    hits.push({
      kind: 'day_spike',
      dedupeKey: spikeKey,
      message: [
        '📈 实时通知',
        '━━━━━━━━━━━━━━━',
        `今天市场波动较大，你的账户已赚 $${fmt(facts.todayProfit)}，明显超出平常水平。属于行情馈赠，不代表每天都能如此。`,
        `数据时间：${beijingTimeOf(now.toISOString()).slice(5)}`,
      ].join('\n'),
    });
  }

  for (const h of hits) fired.add(h.dedupeKey);
  return { hits, next: { lastCheckTs: now.toISOString(), fired: [...fired].slice(-500) } };
}

// ============ 常驻器 ============

export interface LpReporterDeps {
  configLp: { accounts: LpAccountConfig[] };
  source: EventSourceLike;
  stateDir: string;
  /** 推送通道（钉钉 sendGroupMessage 或测试桩） */
  send: (conversationId: string, text: string) => Promise<boolean>;
  logger: ILogger;
  now?: () => Date;
}

export class LpReporter {
  private state: ReporterState;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: LpReporterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.state = this.loadState();
  }

  private statePath(): string {
    return path.join(this.deps.stateDir, 'lp-reporter-state.json');
  }

  private loadState(): ReporterState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
      if (raw && typeof raw === 'object' && raw.checks && raw.lastDaily) return raw as ReporterState;
    } catch { /* 首次运行或文件损坏：从空状态开始 */ }
    return { checks: {}, lastDaily: {} };
  }

  private saveState(): void {
    fs.mkdirSync(this.deps.stateDir, { recursive: true });
    fs.writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2));
  }

  /** A 节奏：到了发送时刻就推日报（每个账户每天最多一条） */
  async runDaily(accountOverride?: string): Promise<Array<{ account: string; text: string; sent: boolean }>> {
    const out: Array<{ account: string; text: string; sent: boolean }> = [];
    for (const account of this.deps.configLp.accounts) {
      if (accountOverride && account.instance !== accountOverride) continue;
      const todayStr = this.now().toLocaleDateString('en-CA', { timeZone: TZ });
      if (!accountOverride && this.state.lastDaily[account.instance] === todayStr) {
        this.deps.logger.debug('LP 日报今天已发过，跳过', { instance: account.instance });
        continue;
      }
      const facts = await collectFacts(this.deps.source, account, this.now());
      if (facts.days.length === 0) {
        this.deps.logger.warn('LP 日报跳过：无本地数据', { instance: account.instance });
        continue;
      }
      const text = renderDaily(facts, account, this.now());
      let sent = false;
      if (account.conversationId) {
        sent = await this.deps.send(account.conversationId, text);
      } else {
        this.deps.logger.warn('LP 日报只渲染不推送（未配 conversationId）', { instance: account.instance });
      }
      this.state.lastDaily[account.instance] = todayStr;
      this.saveState();
      out.push({ account: account.instance, text, sent });
    }
    return out;
  }

  /** B 触发：同步后调用；新命中才推送 */
  async runTriggers(): Promise<Array<{ account: string; hits: TriggerHit[] }>> {
    const results: Array<{ account: string; hits: TriggerHit[] }> = [];
    for (const account of this.deps.configLp.accounts) {
      this.deps.logger.info('LP 触发判定开始', { instance: account.instance });
      const facts = await collectFacts(this.deps.source, account, this.now());
      if (facts.days.length === 0) continue;
      const { hits, next } = evaluateTriggers(facts, account, this.now(), this.state.checks[account.instance]);
      this.state.checks[account.instance] = next;
      this.saveState();
      this.deps.logger.info('LP 触发判定完成', { instance: account.instance, hits: hits.length });
      for (const h of hits) {
        if (account.conversationId) {
          const ok = await this.deps.send(account.conversationId, h.message);
          if (!ok) this.deps.logger.error('LP 触发推送失败', { instance: account.instance, kind: h.kind });
        } else {
          this.deps.logger.warn('LP 触发只渲染不推送（未配 conversationId）', { instance: account.instance, kind: h.kind });
        }
      }
      if (hits.length > 0) results.push({ account: account.instance, hits });
    }
    return results;
  }

  /** 启动 A 节奏定时器：对齐每个账户的 dailyHour:dailyMinute（北京时区） */
  start(): void {
    if (this.dailyTimer) return;
    const tick = async (): Promise<void> => {
      const now = this.now();
      // 显式按北京时区算"到没到点"，不依赖部署机器的时区设置
      const beijing = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
      const nowMin = beijing.getHours() * 60 + beijing.getMinutes();
      for (const account of this.deps.configLp.accounts) {
        if (nowMin === account.dailyHour * 60 + account.dailyMinute) {
          await this.runDaily().catch((err) => {
            this.deps.logger.error('LP 日报任务异常', { detail: err instanceof Error ? err.message : String(err) });
          });
        }
      }
    };
    // 每分钟看一次是否到点（比算下一次间隔更耐时钟回拨/夏令时，成本可忽略）
    this.dailyTimer = setInterval(() => void tick(), 60_000);
    if (typeof this.dailyTimer.unref === 'function') this.dailyTimer.unref();
  }

  stop(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.dailyTimer = null;
  }
}
