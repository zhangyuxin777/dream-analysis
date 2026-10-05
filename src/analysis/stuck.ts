/**
 * `stuck` 分析器（别名 `sk`）：**当前仍未收口的轮**（跨窗口）—— 回答"现在卡着哪些轮、卡了多久、这一轮亏多少"。
 *
 * 为什么单独一个视图：`rounds` 是**窗口语义**（某天的轮次统计），而"卡住"是**状态语义** ——
 * 回测里最长卡住 165 天（≈3967h），`rounds` 的"未完成轮"在这种轮上只会给出"本窗口内未见收口"，窗口一换就消失。
 *
 * 三条原则（P5 批二 review 换来的，改动前先读）：
 * 1. **只做过滤 + 关联，不发明数字**：仓位只从观测里取，浮亏只在**轮次级**数字之间算
 *    （账户级市值 − 轮次级 accCost 是两个不同范围的量，相减出来的是假值 —— 真数据上出现过 +2769 的假浮盈）。
 * 2. **别漏轮**：一个 (实例,币种) 下可能有多个未收口的轮（计数器复用/被复位后没重开），全部要列出来。
 * 3. **别扫全部历史**：从最新一天往回扫，直到每个 (实例,币种) 当前那轮的开轮事件都找到就停（通常 1~3 天）；
 *    真正卡了几百天的轮会因此多扫几天 —— 那正是要看的，所以给一个上限（`MAX_LOOKBACK_DAYS`）并在超限时标 ≥。
 */
import { Analysis, AnalysisContext, AnalysisResult, LoadedEventLike, MAX_WINDOW_HOURS, Section } from './types';
import { dayStartMs, formatShanghai, parseWindow } from '../common/time';
import { AccountSnapshot, RoundState, allRoundsOf, createRoundCollector, groupByInstance, nextFirstMsOf, roundCounterOf } from './roundsCore';

/** 常见计价币（长的在前，避免 ETHBTC 被 BTC 先吃掉一半） */
const QUOTE_ASSETS = ['FDUSD', 'USDT', 'USDC', 'TUSD', 'BUSD', 'BNB', 'BTC', 'ETH'];

/** 回看上限：覆盖回测里最长的 165 天并留足余量；超过就标 ≥（起点不可知） */
export const MAX_LOOKBACK_DAYS = 400;
/** 最少回看天数：轮次"静默"（既没成交也没复位）时不会有新事件，靠多扫几天兜住 */
export const MIN_LOOKBACK_DAYS = 3;

/** 超过这个时长没有新事件 ⇒ 该实例很可能已经停了（上传侧每小时都在产出） */
export const STALE_INSTANCE_HOURS = 6;

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

/** 数量显示：去掉浮点噪声（6 位有效数字够用） */
function qtyText(q: number): string {
  if (q === 0) return '0';
  return Number(q.toPrecision(6)).toString();
}

interface StuckRow {
  instance: string;
  symbol: string;
  round: RoundState;
  /** 持仓时长（从首笔买入算，小时）；没建仓为 null */
  holdHours: number | null;
  /** 卡住时长（从**末笔买入**算；没建仓则退回从开轮算并标注空等） */
  stuckHours: number;
  stuckFromOpen: boolean;
  /** 账户里该资产的总数量（可用+锁仓，观测值） */
  accountQty: number | null;
  /** 该资产的观测价格 = 市值 / 数量（观测值推出） */
  price: number | null;
  /** 这一轮自己的持仓市值 = 本轮数量 × 观测价格（只跟本轮成本比） */
  roundValue: number | null;
  /** 轮次级浮亏 = 本轮市值 − 本轮累计成本 */
  pnl: number | null;
  /** 该实例最后一条事件距今多久（小时）——停了的实例，其旧轮不该被当成"正在卡住" */
  dataAgeHours: number;
}

export function stuckAnalysis(): Analysis {
  return {
    name: 'stuck',
    aliases: ['sk'],
    help: '卡住轮：当前仍未收口的轮（跨窗口）、已持有/卡住多久、本轮仓位与浮亏、>24h/>72h/>7天 分档',
    params: [
      { name: 'instance', description: '实例名（默认全部实例）', example: 'zyx666' },
      { name: 'symbol', description: '币种（支持短名，默认全部）', example: 'eth' },
      { name: 'window', description: `回看起点（默认自动往前找开轮事件，最多 ${MAX_LOOKBACK_DAYS} 天）`, example: '近30d' },
      { name: 'top', description: '列表取前 N（默认 10）', example: '20' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const topN = Math.max(1, Math.min(200, Number(ctx.params.top ?? '10') || 10));
      const nowMs = ctx.now.getTime();
      const warnings: string[] = [];

      // `window` 只当**回看起点**用（不拿它过滤事件！）—— 过滤会让"开轮在窗口外"的轮整个消失或让时长被低估
      let boundMs: number | null = null;
      let boundLabel = `最多回看 ${MAX_LOOKBACK_DAYS} 天`;
      if (ctx.params.window) {
        const w = parseWindow(ctx.params.window, ctx.now, '近30d', { maxHours: MAX_WINDOW_HOURS });
        boundMs = w.fromMs;
        boundLabel = `回看起点 ${w.label}`;
      }

      // 可用天数：从最新往回，最多 MAX_LOOKBACK_DAYS 天（成本 ∝ 实际扫的天数，不 ∝ 历史总量）
      const days = ctx.source.availableDays()
        .map((d) => ({ d, ms: dayStartMs(d) }))
        .filter((x) => Number.isFinite(x.ms) && x.ms < nowMs && (boundMs === null || x.ms + 86_400_000 > boundMs))
        .sort((a, b) => b.ms - a.ms);

      const collector = createRoundCollector();
      const buffers: Array<{ ms: number; events: Array<LoadedEventLike & { instance: string }> }> = [];
      let scannedDays = 0;
      let stoppedEarly = false;
      let provisional = false;
      let badLines = 0;
      const failedShards: string[] = [];
      for (const day of days) {
        if (scannedDays >= MAX_LOOKBACK_DAYS) break;
        const events: Array<LoadedEventLike & { instance: string }> = [];
        // ⚠️ 不传 symbol：那会把 ACCOUNT_OBSERVED（symbol = `__account__`）一起滤掉 ⇒ 仓位/浮亏全成 '-'。
        // 币种过滤放到取行之后做（见下）。
        const dayStats = await ctx.source.scan(
          { window: { label: day.d, fromMs: day.ms, toMs: day.ms + 86_400_000, days: [day.d] }, instance: ctx.params.instance },
          (e) => events.push(e),
        );
        provisional = provisional || dayStats.provisional;
        badLines += dayStats.badLines;
        for (const f of dayStats.failedShards) failedShards.push(f.key);
        buffers.push({ ms: day.ms, events });
        scannedDays++;
        const progress = scanProgress(buffers);
        // 停的条件：**已经找到每个见过的 (实例,币种) 当前那轮的开轮** 且 **最旧那天没带来新的 (实例,币种)**
        // （后者是"静默日"判据；否则会出现"只扫了最新一天就把别的币种/停了的实例整个漏掉"）。
        if (scannedDays >= MIN_LOOKBACK_DAYS && progress.allOpened && !progress.addedNewKeys) {
          stoppedEarly = true;
          break;
        }
      }
      if (days.length === 0) warnings.push('本地没有任何分片落在选定范围内 —— 先同步（sync），或把 window 放宽');
      // 倒着扫的缓冲按时间正序喂给收集器（收集器假定事件按时间递增：它靠"同一计数器又开一轮"识别复用）
      for (const buf of [...buffers].reverse()) for (const e of buf.events) collector.onEvent(e);

      const bySymbol = collector.symbols();
      const accounts = collector.accounts();
      const lastSeen = collector.lastSeen();

      // **还开着**的轮 = 没有 ROUND_COMPLETED **且没有后继轮**。
      // 只判"没看到完成事件"是不够的：偏离复位（PRICE_DEVIATION）掐断的轮也不会有完成事件，
      // 但它已经结束了（后面开了新一轮）——真数据上那样会把 10 个空等轮全列成"未收口"，把真正在开的那轮埋掉。
      const rows: StuckRow[] = [];
      for (const [symbol, s] of bySymbol.entries()) {
        if (ctx.params.symbol && !symbol.toUpperCase().startsWith(ctx.params.symbol.toUpperCase())) continue;
        for (const list of groupByInstance(allRoundsOf(s)).values()) {
          for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (r.completed) continue;
            const nextFirstMs = nextFirstMsOf(list, i);
            if (nextFirstMs !== null) continue; // 有后继轮 ⇒ 这一轮已经结束（完成或掐断）
            const acc = accounts.get(r.instance) ?? null;
            const base = baseAssetOf(symbol);
            const bal = acc?.balances.get(base) ?? null;
            const accountQty = bal ? bal.qtyFree + bal.qtyLocked : null;
            const price = bal && accountQty !== null && accountQty > 0 && bal.value !== null ? bal.value / accountQty : null;
            const roundValue = price !== null && r.qty > 0 ? r.qty * price : null;
            const holdHours = r.firstBuyMs === null ? null : Math.max(0, nowMs - r.firstBuyMs) / 3_600_000;
            const stuckHours = r.lastBuyMs === null
              ? Math.max(0, nowMs - r.firstMs) / 3_600_000
              : Math.max(0, nowMs - r.lastBuyMs) / 3_600_000;
            const seenMs = lastSeen.get(r.instance);
            rows.push({
              instance: r.instance,
              symbol,
              round: r,
              holdHours,
              stuckHours,
              stuckFromOpen: r.lastBuyMs === null,
              accountQty,
              price,
              roundValue,
              pnl: roundValue !== null && r.accCost !== null ? roundValue - r.accCost : null,
              dataAgeHours: seenMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - seenMs) / 3_600_000,
            });
          }
        }
      }
      rows.sort((a, b) => b.stuckHours - a.stuckHours);

      // ---- 告警（每一条都要能指向"哪里不对"）----
      stats0Guard(warnings, days.length, scannedDays, stoppedEarly, boundLabel);
      if (failedShards.length > 0) {
        warnings.push(
          `有 ${failedShards.length} 个分片**读不出来** ⇒ 这些天的轮次状态可能不完整（未收口轮可能被漏掉/误判）: ` +
            failedShards.slice(0, 3).join(' | '),
        );
      }
      if (badLines > 0) warnings.push(`有 ${badLines} 行无法解析（分片本身可疑，见 verify）`);
      const withPosition = rows.filter((r) => r.round.firstBuyMs !== null);
      const noAccount = rows.filter((r) => r.accountQty === null);
      if (rows.length === 0) {
        warnings.push('当前没有还开着的轮（每个 (实例,币种) 的最后一轮都已收口/被掐断）—— 若与实盘不符，先确认数据是否已同步');
      } else if (noAccount.length > 0) {
        warnings.push(`有 ${noAccount.length} 轮拿不到账户观测（ACCOUNT_OBSERVED 里没有对应资产）⇒ 市值/浮亏显示为 "-"`);
      }
      const mismatch = rows.filter(
        (r) => r.accountQty !== null && r.round.qty > 0 && Math.abs(r.accountQty - r.round.qty) / Math.max(r.accountQty, r.round.qty) > 0.02,
      );
      if (mismatch.length > 0) {
        warnings.push(
          `有 ${mismatch.length} 轮的"本轮数量"与账户该资产总量不一致（可能有其他来源、或上一轮还没卖完）⇒ `
            + '浮亏只按**本轮自己的数量**算，账户总量见"账户同币"列',
        );
      }
      const outsideScan = rows.filter((r) => r.round.startOutsideScan).length;
      if (outsideScan > 0) {
        warnings.push(
          `有 ${outsideScan} 轮的开轮事件不在已扫描范围（${boundLabel}）⇒ 它们的"已开/卡住"是**下界**（已用 ≥ 标出）`,
        );
      }
      const reused = [...bySymbol.values()].reduce((n, s) => n + s.supersededRounds.length, 0);
      if (reused > 0) {
        warnings.push(`发生 ${reused} 次计数器复用（同一个 R<计数器> 开过两轮）—— 理论上不该发生，请核对主仓的轮次计数器`);
      }
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
      if (collector.symbols().size === 0) warnings.push('扫描范围内没有任何事件（本地分片是空的？）');

      // **反向核对**（观测 → 轮次）：账户里持有着某个**基础资产**，却没找到它对应的还开着的轮。
      // 只针对"我们见过的币种里出现过的基础资产"（否则现金计价币 FDUSD 会被当成对不上 —— 真数据踩过）。
      const heldWithoutRound: string[] = [];
      const seenBases = new Set<string>();
      for (const symbol of bySymbol.keys()) seenBases.add(baseAssetOf(symbol));
      const openByInstanceBase = new Set(rows.map((r) => `${r.instance}\u0000${baseAssetOf(r.symbol)}`));
      for (const acc of accounts.values()) {
        for (const [asset, b] of acc.balances) {
          if (b.qtyFree + b.qtyLocked <= 0) continue;
          if (!seenBases.has(asset)) continue; // 不是任何币种的基础资产（例如 FDUSD 现金）⇒ 不参与核对
          if (openByInstanceBase.has(`${acc.instance}\u0000${asset}`)) continue;
          heldWithoutRound.push(`${acc.instance} 持有 ${asset}（${qtyText(b.qtyFree + b.qtyLocked)}）但没找到还开着的轮`);
        }
      }
      if (heldWithoutRound.length > 0) {
        warnings.push(
          `账户持仓与轮次对不上：${heldWithoutRound.slice(0, 3).join('；')}${heldWithoutRound.length > 3 ? ` 等 ${heldWithoutRound.length} 项` : ''}` +
            ` —— 可能是"静默卡住"（该轮既没成交也没复位，近 ${scannedDays} 天内没有它的事件），` +
            '用 `window=近90d` 往前多扫一段再确认',
        );
      }

      // ---- 报表 ----
      const sections: Section[] = [];

      const buckets = [
        { label: '>24h', test: (h: number) => h > 24 },
        { label: '>72h', test: (h: number) => h > 72 },
        { label: '>7天', test: (h: number) => h > 24 * 7 },
      ];
      const longest = withPosition.length > 0 ? Math.max(...withPosition.map((r) => r.stuckHours)) : null;
      sections.push({
        heading: '卡住分档',
        headers: ['档位', '轮数'],
        rows: [
          ['未收口合计', String(rows.length)],
          ['其中已建仓', String(withPosition.length)],
          // 分档只算**已建仓**的轮：回测的 duration_hours 只存在于有成交的轮上，
          // 把"空等"（一笔没成交就被复位）也算进来会把卡住率系统性抬高（P5 批二的 Warning）
          ...buckets.map((b) => [b.label, String(withPosition.filter((r) => b.test(r.stuckHours)).length)]),
          ['空等轮（未建仓，不计入分档）', String(rows.length - withPosition.length)],
          ['最长卡住（已建仓）', longest === null ? '-' : hoursText(longest)],
        ],
        note: '卡住 = 从**末笔买入**算起（与回测 duration_hours 同口径：末次买入→卖出）；空等轮（还没成交就被复位/一直没等到买单）'
          + '不参与分档，单列出来。未收口 = 既没有 ROUND_COMPLETED、后面也没有再开新一轮（**真还开着**）。',
      });

      if (rows.length > 0) {
        sections.push({
          heading: `未收口轮 Top ${Math.min(topN, rows.length)}（按卡住时长降序）`,
          headers: ['实例', '数据', '币种', '轮次', '已开', '持仓', '卡住', '本轮仓位', '账户同币', '轮次成本', '浮亏', '补仓'],
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
              qtyText(r.round.qty),
              r.accountQty === null ? '-' : qtyText(r.accountQty),
              money(r.round.accCost),
              r.pnl === null ? '-' : (r.pnl >= 0 ? `+${money(r.pnl)}` : money(r.pnl)),
              String(Math.max(0, r.round.buyFills - 1)),
            ];
          }),
          note: '本轮仓位 = 该轮买入成交累加出来的数量（`BUY_FILLED` 没有数量字段，用**累计成本增量 ÷ 该笔价**推得）；'
            + '账户同币 = 最近一条 ACCOUNT_OBSERVED 里该资产的总量（可用+锁仓，**观测值**）；'
            + '浮亏 = **本轮仓位 × 观测价格（账户市值 ÷ 账户数量）** − 本轮累计成本（accCost，**观测值**）'
            + ' —— 只用轮次级数字，不拿账户级市值去减单轮成本（那会得出假浮盈）。'
            + ` 数据 = 该实例最后一条事件距今多久（⚠ 表示超过 ${STALE_INSTANCE_HOURS}h，实例可能已停）。`
            + ' 已开/持仓带 ≥ 表示起点不在已扫描范围（只是下界）。',
        });
      }

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
              [...a.balances.entries()].filter(([, b]) => b.qtyFree + b.qtyLocked > 0).map(([asset, b]) => `${asset} ${qtyText(b.qtyFree + b.qtyLocked)}`).join(' ') || '-',
            ]),
          note: '每小时一条的账户观测（上传侧）；这里是每个实例的**最新**一条。',
        });
      }

      const summary = rows.length === 0
        ? `当前没有还开着的轮（扫了 ${scannedDays} 天 / ${bySymbol.size} 个币种）`
        : `${rows.length} 轮还开着（已建仓 ${withPosition.length}）` + (longest === null ? '' : `，最长卡住 ${hoursText(longest)}`);

      return {
        title: `卡住轮 · ${ctx.params.symbol ? ctx.params.symbol.toUpperCase() + ' · ' : ''}${boundLabel}`,
        summary,
        sections,
        warnings,
        provisional,
      };
    },
  };
}

/**
 * 早停判据（每个 (实例,币种) 为一个 key，`i=0` 是最新那天）：
 * - `allOpened`：每个 key **最新那条轮次事件所属的计数器**都已经看到了它的 `NEW_ROUND`（当前轮状态完整）；
 * - `addedNewKeys`：**最旧那天**是否带来了更新的那些天没见过的 key。
 *   为真 ⇒ 更早的天可能还有别的实例/币种，不能收工（否则"只扫一天就把别的币种、停了的实例整个漏掉"）。
 */
function scanProgress(buffers: Array<{ ms: number; events: Array<LoadedEventLike & { instance: string }> }>): { allOpened: boolean; addedNewKeys: boolean } {
  const opened = new Set<string>();
  const newestCounter = new Map<string, string>();
  const keysByBuffer: Array<Set<string>> = buffers.map(() => new Set());

  for (let i = 0; i < buffers.length; i++) {
    for (const e of buffers[i].events) {
      const roundId = e.roundId ?? '';
      if (roundId === '') continue;
      const key = `${e.instance}\u0000${e.symbol ?? '(无 symbol)'}`;
      keysByBuffer[i].add(key);
      const counter = roundCounterOf(roundId);
      if (e.event === 'NEW_ROUND') opened.add(`${key}\u0000${counter}`);
      if (!newestCounter.has(key)) newestCounter.set(key, counter); // i 从小到大 = 从新到旧，首次即最新
    }
  }

  let allOpened = newestCounter.size > 0;
  for (const [key, counter] of newestCounter) {
    if (!opened.has(`${key}\u0000${counter}`)) {
      allOpened = false;
      break;
    }
  }

  const last = keysByBuffer[keysByBuffer.length - 1] ?? new Set<string>();
  const before = new Set<string>();
  for (let i = 0; i < keysByBuffer.length - 1; i++) for (const k of keysByBuffer[i]) before.add(k);
  const addedNewKeys = [...last].some((k) => !before.has(k));
  return { allOpened, addedNewKeys };
}

/** 早停/回看相关的提示（保持 run() 主体清爽） */
function stats0Guard(warnings: string[], dayCount: number, scannedDays: number, stoppedEarly: boolean, boundLabel: string): void {
  if (scannedDays >= MAX_LOOKBACK_DAYS && !stoppedEarly) {
    warnings.push(`回看已达上限 ${MAX_LOOKBACK_DAYS} 天（${boundLabel}）—— 更早开的轮起点不可知（标 ≥）`);
  } else if (dayCount > scannedDays) {
    warnings.push(`为找开轮事件回看了 ${scannedDays} 天（本地共有 ${dayCount} 天）—— 更早的历史没有参与本次判断`);
  }
}
