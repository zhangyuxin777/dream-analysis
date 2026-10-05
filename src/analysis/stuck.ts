/**
 * `stuck` 分析器（别名 `sk`）：**当前仍未收口的轮**（跨窗口）—— 回答"现在卡着哪些轮、卡了多久、亏多少"。
 *
 * 为什么单独一个视图：`rounds` 是**窗口语义**（今天的轮次统计），而"卡住"是**状态语义** ——
 * 回测里最长卡住 165 天（≈3967h），`rounds` 的"未完成轮"在这种轮上只会给出"本窗口内未见收口"，
 * 而且窗口一换它就消失。这里从**本地全部历史**重建每个 (实例,币种) 的当前轮次状态。
 *
 * 全部是**过滤 + 关联**，没有新机制：
 * - 用 `roundsCore` 的收集器（与 rounds 同一套身份规则 `R<计数器>`）扫历史；
 * - 每个 (实例,币种) 取"开轮时间最晚的那一轮"，**未完成**就是还开着的（已完成 ⇒ 该币种当前空闲）；
 * - 仓位/市值**直接取**最近一条 `ACCOUNT_OBSERVED.balances`（观测值），成本取该轮最近一条
 *   `BUY_FILLED.accCost`（也是观测值）⇒ 浮亏 = 市值 − 成本，不做任何推断；
 * - 分档 >24h / >72h / >7天 对齐回测的"卡住率"口径（回测用 `duration_hours` = 末次买入→卖出，
 *   所以这里的"卡住"也按**末笔买入之后**算）。
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section } from './types';
import { Window, dayStartMs, formatShanghai, parseWindow } from '../common/time';
import { AccountSnapshot, RoundState, createRoundCollector, groupByInstance } from './roundsCore';

/** 常见计价币（长的在前，避免 ETHBTC 被 BTC 先吃掉一半） */
const QUOTE_ASSETS = ['FDUSD', 'USDT', 'USDC', 'TUSD', 'BUSD', 'BNB', 'BTC', 'ETH'];

/** `ETHFDUSD` → `ETH`（账户观测的 balances 是按**资产**给的） */
export function baseAssetOf(symbol: string): string {
  for (const q of QUOTE_ASSETS) {
    if (symbol.length > q.length && symbol.endsWith(q)) return symbol.slice(0, -q.length);
  }
  return symbol;
}

/** 小时 → 人类可读（超过 48h 用天） */
function hoursText(hours: number): string {
  return hours >= 48 ? `${(hours / 24).toFixed(1)}天` : `${hours.toFixed(1)}h`;
}

function money(v: number | null): string {
  return v === null ? '-' : v.toFixed(2);
}

interface StuckRow {
  instance: string;
  symbol: string;
  round: RoundState;
  /** 持仓时长（从首笔买入算，小时）；没建仓为 null */
  holdHours: number | null;
  /** 卡住时长（从**末笔买入**算；没建仓则退回从开轮算并标注空等） */
  stuckHours: number;
  /** 是否用"开轮"当起点（= 空等，还没建仓） */
  stuckFromOpen: boolean;
  balance: { qty: number; value: number | null } | null;
  /** 市值 − 成本（负数 = 浮亏） */
  pnl: number | null;
  /** 该实例最后一条事件距今多久（小时）——停了的实例，其旧轮不该被当成"正在卡住" */
  dataAgeHours: number;
}

/** 超过这个时长没有新事件 ⇒ 该实例很可能已经停了（上传侧每小时都在产出） */
export const STALE_INSTANCE_HOURS = 6;

export function stuckAnalysis(): Analysis {
  return {
    name: 'stuck',
    aliases: ['sk'],
    help: '卡住轮：当前仍未收口的轮（跨窗口）、已持有/卡住多久、仓位市值与浮亏、>24h/>72h/>7天 分档',
    params: [
      { name: 'instance', description: '实例名（默认全部实例）', example: 'zyx666' },
      { name: 'symbol', description: '币种（支持短名，默认全部）', example: 'eth' },
      { name: 'window', description: `看哪一段开轮历史（默认本地全部；最长 ${MAX_WINDOW_HOURS}h）`, example: '近30d' },
      { name: 'top', description: '列表取前 N（默认 10）', example: '20' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const topN = Math.max(1, Math.min(200, Number(ctx.params.top ?? '10') || 10));
      const nowMs = ctx.now.getTime();

      // 默认看**本地全部历史**（不传 window 时 fromMs = 0）：卡了很多天的轮，起点可能在很早以前
      let fromMs = 0;
      let toMs = nowMs;
      let label = '本地全部历史';
      if (ctx.params.window) {
        const w = parseWindow(ctx.params.window, ctx.now, '近30d', { maxHours: MAX_WINDOW_HOURS });
        fromMs = w.fromMs;
        toMs = Math.min(w.toMs, nowMs);
        label = w.label;
      }
      // ⚠️ `scan` 是按 `window.days` 挑分片的（不是只看 from/to）——给它空 days 会一个分片都不扫，
      // 于是"当前没有未收口的轮"这种**假结论**就出来了（真数据上实测踩到）。
      // 这里用**本地实际有的天**过滤，既不漏也不去凭空枚举几十年的日期。
      const availableDays = ctx.source.availableDays();
      const history: Window = {
        label,
        fromMs,
        toMs,
        days: availableDays.filter((d) => {
          const ms = dayStartMs(d);
          return Number.isFinite(ms) && ms + 86_400_000 > fromMs && ms < toMs;
        }),
      };

      const collector = createRoundCollector();
      const stats = await ctx.source.scan(
        { window: history, instance: ctx.params.instance, symbol: ctx.params.symbol },
        (e) => collector.onEvent(e),
      );
      const bySymbol = collector.symbols();
      const accounts = collector.accounts();
      const lastSeen = collector.lastSeen();

      const warnings: string[] = [];
      if (history.days.length === 0) {
        warnings.push('本地没有任何分片落在选定范围内 —— 先同步（sync），或把 window 放宽');
      }
      if (stats.failedShards.length > 0) {
        warnings.push(
          `有 ${stats.failedShards.length} 个分片**读不出来** ⇒ 这些天的轮次状态可能不完整（未收口轮可能被漏掉/误判）: ` +
            stats.failedShards.slice(0, 3).map((f) => f.key).join(' | '),
        );
      }
      if (stats.badLines > 0) warnings.push(`有 ${stats.badLines} 行无法解析（分片本身可疑，见 verify）`);

      // 未收口的轮 = 每个 (实例,币种) 里**开轮时间最晚**的那一轮且未完成
      const rows: StuckRow[] = [];
      for (const [symbol, s] of bySymbol.entries()) {
        for (const list of groupByInstance([...s.rounds.values()]).values()) {
          const last = list[list.length - 1];
          if (last.completed) continue; // 该 (实例,币种) 当前没有开着的轮
          const acc = accounts.get(last.instance) ?? null;
          const base = baseAssetOf(symbol);
          const bal = acc?.balances.get(base) ?? null;
          const holdHours = last.firstBuyMs === null ? null : Math.max(0, nowMs - last.firstBuyMs) / 3_600_000;
          const stuckHours = last.lastBuyMs === null
            ? Math.max(0, nowMs - last.firstMs) / 3_600_000
            : Math.max(0, nowMs - last.lastBuyMs) / 3_600_000;
          const value = bal?.value ?? null;
          const seenMs = lastSeen.get(last.instance);
          rows.push({
            instance: last.instance,
            symbol,
            round: last,
            holdHours,
            stuckHours,
            stuckFromOpen: last.lastBuyMs === null,
            balance: bal ? { qty: bal.qtyFree + bal.qtyLocked, value } : null,
            pnl: value !== null && last.accCost !== null ? value - last.accCost : null,
            dataAgeHours: seenMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - seenMs) / 3_600_000,
          });
        }
      }
      rows.sort((a, b) => b.stuckHours - a.stuckHours);

      const withPosition = rows.filter((r) => r.round.firstBuyMs !== null);
      const noAccount = rows.filter((r) => r.balance === null);
      if (rows.length === 0) {
        warnings.push('当前没有未收口的轮（每个 (实例,币种) 的最后一轮都已收口）—— 若与实盘不符，先确认数据是否已同步');
      } else if (noAccount.length > 0) {
        warnings.push(`有 ${noAccount.length} 轮拿不到账户观测（ACCOUNT_OBSERVED 里没有对应资产）⇒ 市值/浮亏显示为 "-"`);
      }
      const outsideScan = rows.filter((r) => r.round.startOutsideScan).length;
      if (outsideScan > 0) {
        warnings.push(
          `有 ${outsideScan} 轮的开轮事件早于本地分片起点 ⇒ 它们的"已开/卡住"是**下界**（已用 ≥ 标出），` +
            '要更准就得让本地历史更早（本地分片永不自动删除，所以只要同步过就不会丢）',
        );
      }
      const reused = rows.filter((r) => r.round.reusedCount > 0).length;
      if (reused > 0) {
        warnings.push(`有 ${reused} 个计数器被复用（同一个 R<计数器> 又开了一轮）—— 理论上不该发生，请核对主仓的轮次计数器`);
      }

      // 停了的实例：它的旧轮会被算成"卡了很多天"，但真相可能是"这个实例已经不跑了"
      // （真数据实测：localtest 自测实例停了 3 天，4 个旧轮全被列成"卡住 3.1 天"）
      const staleInstances = new Map<string, number>();
      for (const r of rows) {
        if (r.dataAgeHours > STALE_INSTANCE_HOURS) {
          const prev = staleInstances.get(r.instance);
          if (prev === undefined || r.dataAgeHours > prev) staleInstances.set(r.instance, r.dataAgeHours);
        }
      }
      if (staleInstances.size > 0) {
        const detail = [...staleInstances.entries()].map(([inst, h]) => `${inst}（${hoursText(h)} 无新数据）`).join('、');
        warnings.push(
          `有 ${staleInstances.size} 个实例已经很久没有新事件：${detail} —— 它们最后那些轮**未必真在卡着**（可能是实例停了或上传断了）；`
            + '表里用 ⚠ 标出，别把它们当成活跃的卡轮',
        );
      }

      const sections: Section[] = [];

      // ① 分档（对齐回测的"卡住率"口径：>24h / >72h / >7天）
      const buckets = [
        { label: '>24h', test: (h: number) => h > 24 },
        { label: '>72h', test: (h: number) => h > 72 },
        { label: '>7天', test: (h: number) => h > 24 * 7 },
      ];
      const longest = rows.length > 0 ? rows[0].stuckHours : null;
      sections.push({
        heading: '卡住分档',
        headers: ['档位', '轮数'],
        rows: [
          ['未收口合计', String(rows.length)],
          ['其中已建仓', String(withPosition.length)],
          ...buckets.map((b) => [b.label, String(rows.filter((r) => b.test(r.stuckHours)).length)]),
          ['最长卡住', longest === null ? '-' : hoursText(longest)],
        ],
        note: '卡住 = 从**末笔买入**算起（与回测 duration_hours 同口径：末次买入→卖出）；还没建仓的轮按开轮算并标"空等"。'
          + ' 未收口 = 该 (实例,币种) 开轮时间最晚的一轮还没有 ROUND_COMPLETED。',
      });

      // ② 未收口轮明细
      if (rows.length > 0) {
        sections.push({
          heading: `未收口轮 Top ${Math.min(topN, rows.length)}（按卡住时长降序）`,
          headers: ['实例', '数据', '币种', '轮次', '已开', '持仓', '卡住', '仓位市值', '成本', '浮亏', '补仓'],
          rows: rows.slice(0, topN).map((r) => {
            const openHours = Math.max(0, nowMs - r.round.firstMs) / 3_600_000;
            const stale = r.dataAgeHours > STALE_INSTANCE_HOURS;
            return [
              r.instance,
              `${stale ? '⚠' : ''}${r.dataAgeHours === Number.POSITIVE_INFINITY ? '未知' : hoursText(r.dataAgeHours)}`,
              r.symbol,
              `${r.round.startOutsideScan ? '≥' : ''}${r.round.displayId}`,
              `${r.round.startOutsideScan ? '≥' : ''}${hoursText(openHours)}`,
              r.holdHours === null ? '-' : hoursText(r.holdHours),
              `${hoursText(r.stuckHours)}${r.stuckFromOpen ? '(空等)' : ''}`,
              r.balance === null ? '-' : `${r.balance.qty} / ${money(r.balance.value)}`,
              money(r.round.accCost),
              r.pnl === null ? '-' : (r.pnl >= 0 ? `+${money(r.pnl)}` : money(r.pnl)),
              String(Math.max(0, r.round.buyFills - 1)),
            ];
          }),
          note: '仓位市值 = 最近一条 ACCOUNT_OBSERVED 里该资产的**可用+锁仓**数量与市值（**观测值**；'
            + '挂着的止盈卖单会把币锁住，撤单后就只剩可用，所以两个都要算）；成本 = 该轮最近一条 BUY_FILLED 的 accCost（**观测值**）；'
            + '浮亏 = 市值 − 成本。补仓 = 该轮买入成交笔数 − 1。'
            + ` 数据 = 该实例最后一条事件距今多久（⚠ 表示超过 ${STALE_INSTANCE_HOURS}h，实例可能已停 —— 这类"卡住"要先确认实例还活着）。`
            + ' 已开/持仓带 ≥ 表示起点早于本地分片（只是下界）。',
        });
      }

      // ③ 账户观测（每个实例最近一次）
      if (accounts.size > 0) {
        sections.push({
          heading: '账户观测（最近一次）',
          headers: ['实例', '观测时间', '总估值', '交易所', '持币'],
          rows: [...accounts.values()]
            .sort((a, b) => b.ms - a.ms)
            .map((a: AccountSnapshot) => [
              a.instance,
              formatShanghai(a.ms),
              money(a.totalValue),
              a.exchange ?? '-',
              [...a.balances.entries()].filter(([, b]) => b.qtyFree + b.qtyLocked > 0).map(([asset, b]) => `${asset} ${b.qtyFree + b.qtyLocked}`).join(' ') || '-',
            ]),
          note: '每小时一条的账户观测（上传侧）；这里是每个实例的**最新**一条。',
        });
      }

      const summary = rows.length === 0
        ? `当前没有未收口的轮（扫了 ${stats.shards} 个分片 / ${history.label}）`
        : `${rows.length} 轮未收口（已建仓 ${withPosition.length}）` +
          (longest === null ? '' : `，最长卡住 ${hoursText(longest)}`);

      return {
        title: `卡住轮 · ${ctx.params.symbol ? ctx.params.symbol.toUpperCase() + ' · ' : ''}${history.label}`,
        summary,
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}
