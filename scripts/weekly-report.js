#!/usr/bin/env node
/**
 * 周报数据生成器（只读本地已同步的分片，不连 OSS、不连交易所）
 *
 * 用法：
 *   node scripts/weekly-report.js                          # 近 7 天（含今天），所有实例
 *   node scripts/weekly-report.js --days 14                # 近 14 天
 *   node scripts/weekly-report.js --instance boye888       # 只跑某个实例
 *
 * 配置：仓库根 weekly-report.config.json（不进 git 也行，不含机密）
 *   { "instances": { "boye888": { "label": "主账户BTC", "principal": 50000, "priorProfit": 0 } } }
 *   - principal    该实例本金（U），算累计收益率用
 *   - priorProfit  数据窗口之前已确认的利润（U），OSS 数据只从 10-02 开始，早于此的用这个补
 *
 * 输出：markdown 到 stdout。口径与 dream/docs/实盘业绩记录.md 一致：
 *   收益 = ΣROUND_COMPLETED.profit（已实现网格利润）；最大回撤 = 小时级账户估值的峰谷差。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------- 参数 ----------
function parseArgs(argv) {
  const opts = { days: 7, instance: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--instance') opts.instance = argv[++i];
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return opts;
}

// ---------- 时间（北京时区，与分片 localDate 口径一致）----------
const TZ = 'Asia/Shanghai';
function beijingDay(d) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
function beijingHour(d) {
  return d.toLocaleString('en-CA', { timeZone: TZ, hour12: false }).replace(', ', ' ');
}

// ---------- 读取分片 ----------
function readInstanceEvents(rootDir, instance) {
  const dir = path.join(rootDir, 'data', instance);
  if (!fs.existsSync(dir)) return { events: [], files: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz')).sort();
  const events = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const text = require('node:zlib').gunzipSync(buf).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { /* 坏行由 sync 层告警，这里跳过 */ }
    }
  }
  return { events, files };
}

// ---------- 分析 ----------
function analyze(events, sinceMs, untilMs) {
  const win = events.filter((e) => {
    const t = Date.parse(e.ts);
    return t >= sinceMs && t <= untilMs;
  }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // 轮次：按 roundId 聚合
  const rounds = new Map(); // roundId -> {symbol, openedAt, lastBuyAt, buyCount, completed, profit, durationHours, crash}
  let profit = 0;
  for (const e of win) {
    const id = e.roundId;
    if (e.event === 'NEW_ROUND') {
      if (!rounds.has(id)) rounds.set(id, { symbol: e.symbol, openedAt: Date.parse(e.ts), lastBuyAt: null, buyCount: 0, completed: false, profit: 0, durationHours: null, crash: false });
    } else if (e.event === 'BUY_FILLED' && id) {
      const r = rounds.get(id) || { symbol: e.symbol, openedAt: Date.parse(e.ts), lastBuyAt: null, buyCount: 0, completed: false, profit: 0, durationHours: null, crash: false };
      r.buyCount += 1; r.lastBuyAt = Date.parse(e.ts);
      rounds.set(id, r);
    } else if (e.event === 'ROUND_COMPLETED' && id) {
      const r = rounds.get(id) || { symbol: e.symbol, openedAt: Date.parse(e.ts), lastBuyAt: null, buyCount: 0, completed: false, profit: 0, durationHours: null, crash: false };
      r.completed = true;
      r.profit = Number(e.data?.profit ?? 0);
      r.durationHours = e.data?.durationHours ?? null;
      r.avgBuyPrice = e.data?.avgBuyPrice ?? null;
      profit += r.profit;
      rounds.set(id, r);
    }
    if (typeof id === 'string' && (e.event.startsWith('CRASH_'))) {
      const r = rounds.get(id); if (r) r.crash = true;
    }
  }
  const all = [...rounds.values()];
  const completedRounds = all.filter((r) => r.completed);
  const openNow = all.filter((r) => !r.completed && r.buyCount > 0); // 已建仓未收口
  const maxDuration = completedRounds.reduce((m, r) => Math.max(m, r.durationHours ?? 0), 0);

  // 异常 / 关注类事件
  const anomalyPatterns = [
    ['WS_RECONNECTED', /^(WS_RECONNECTED|UDS_RETRY_|MARKET_STREAM_|WORKER_WS_)/],
    ['启动恢复', /^(STARTUP_RECOVERY_DONE|STARTUP_HAS_ORDERS|RECOVERY_APPLIED)/],
    ['复位', /^WORKER_DEVIATION_RESET/],
    ['补仓', /^TOPUP_/],
    ['深跌', /^CRASH_/],
  ];
  const anomalies = {};
  for (const [label, re] of anomalyPatterns) anomalies[label] = win.filter((e) => re.test(e.event)).length;

  // 账户估值序列：窗口内（算回撤）+ 全量（算"当前"，不受窗口右边界截断）
  const pickObs = (list) => list.filter((e) => e.event === 'ACCOUNT_OBSERVED')
    .map((e) => ({
      t: Date.parse(e.ts),
      total: Number(e.data?.totalValue ?? NaN),
      fdusdFree: Number((e.data?.balances || []).find((b) => b.asset === 'FDUSD')?.qtyFree ?? NaN),
    }))
    .filter((o) => Number.isFinite(o.total) && Number.isFinite(o.fdusdFree));
  const obs = pickObs(win);
  let maxDrawdownPct = 0;
  let peak = null;
  for (const o of obs) {
    if (peak === null || o.total > peak) peak = o.total;
    if (peak !== null) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - o.total) / peak * 100);
  }
  const latestObs = obs.length ? obs[obs.length - 1] : null;
  const obsAll = pickObs(events);
  const currentObs = obsAll.length ? obsAll[obsAll.length - 1] : null;
  const occupancyLatest = currentObs && currentObs.total > 0 ? (currentObs.total - currentObs.fdusdFree) / currentObs.total * 100 : null;
  // 峰值占用率：窗口起点至今（含今天的暂定观测；boye888 的分片里观测事件很少，只看窗口会得到 0）
  const occupancyMax = obsAll.filter((o) => o.t >= sinceMs).reduce((m, o) => (o.total > 0 ? Math.max(m, (o.total - o.fdusdFree) / o.total * 100) : m), 0);

  // 数据覆盖
  const daysPresent = [...new Set(win.map((e) => e.localDate))].sort();
  const coverage = { from: daysPresent[0] || '-', to: daysPresent[daysPresent.length - 1] || '-', days: daysPresent.length };

  return { win, rounds: { all, completedRounds, openNow, maxDuration }, profit, anomalies, obs, currentObs, maxDrawdownPct, occupancyLatest, occupancyMax, coverage };
}

// ---------- 输出 ----------
function fmt(n, digits = 2) { return Number(n).toFixed(digits); }

function renderInstance(instance, cfg, a, now) {
  const L = [];
  const principal = cfg?.principal ?? null;
  const priorProfit = cfg?.priorProfit ?? 0;
  const cumProfit = priorProfit + a.profit;
  const days = Math.max(1, a.coverage.days);
  const weekReturnPct = principal ? a.profit / principal * 100 : null;
  const annualized = principal ? (a.profit / principal) / days * 365 * 100 : null;
  const cumReturnPct = principal ? cumProfit / principal * 100 : null;

  L.push(`### ${cfg?.label || instance}（实例 \`${instance}\`）`);
  L.push('');
  L.push(`- 数据覆盖：${a.coverage.from} ~ ${a.coverage.to}（${a.coverage.days} 天；OSS 上传自 10-02 起，此前历史不在窗口内）`);
  L.push(`- 窗口已实现收益：**+$${fmt(a.profit)}**${principal ? `（本金 $${fmt(principal, 0)}，窗口收益率 ${fmt(weekReturnPct)}%，折算年化 ${fmt(annualized)}%）` : '（未配置本金，收益率不算）'}`);
  L.push(`- 累计收益：+$${fmt(cumProfit)}${principal ? `（累计 ${fmt(cumReturnPct)}%）` : ''}${priorProfit ? `（含数据窗口前已确认 +$${fmt(priorProfit)}）` : ''}`);
  const rc = a.rounds.completedRounds.length;
  L.push(`- 轮次：新开 ${a.rounds.all.length} / 完成 ${rc}${rc ? `（均轮利润 $${fmt(a.profit / rc)}，最长 ${fmt(a.rounds.maxDuration, 1)}h）` : ''} / 当前未收口 ${a.rounds.openNow.length}`);
  if (a.rounds.openNow.length) {
    const top = a.rounds.openNow.map((r) => ({ r, hours: (now - (r.lastBuyAt || r.openedAt)) / 3600000 })).sort((x, y) => y.hours - x.hours)[0];
    L.push(`- 当前最长未收口轮：${top.r.symbol}，末笔买入后已 ${fmt(top.hours, 1)}h${top.r.crash ? '（期间经历深跌模式）' : ''}`);
  }
  L.push(`- 最大回撤（小时级账户估值峰谷）：${fmt(a.maxDrawdownPct)}%`);
  L.push(`- 资金占用率：当前 ${a.occupancyLatest === null ? '-' : fmt(a.occupancyLatest) + '%'}（观测峰值 ${fmt(a.occupancyMax)}%）`);
  if (a.currentObs) L.push(`- 最新账户估值（${beijingHour(new Date(a.currentObs.t))} 北京）：$${fmt(a.currentObs.total)}`);
  L.push(`- 异常计数：WS/连接类 ${a.anomalies['WS_RECONNECTED']}，启动恢复 ${a.anomalies['启动恢复']}，急涨复位 ${a.anomalies['复位']}，深跌 ${a.anomalies['深跌']}，补仓 ${a.anomalies['补仓']}`);
  L.push('');
  return L.join('\n');
}

// ---------- main ----------
function main() {
  const opts = parseArgs(process.argv);
  const rootDir = path.join(__dirname, '..');
  const cfgPath = path.join(rootDir, 'weekly-report.config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { instances: {} };

  // 北京时间昨天 24 点 = 窗口终点（今天的数据未封存，先不算完整天）
  const now = new Date();
  const untilMs = Date.parse(`${beijingDay(now)}T00:00:00+08:00`);
  const sinceMs = untilMs - opts.days * 86400000;

  const instances = opts.instance
    ? [opts.instance]
    : fs.readdirSync(path.join(rootDir, 'data'))
        .filter((d) => !d.startsWith('.') && fs.statSync(path.join(rootDir, 'data', d)).isDirectory());

  const header = [
    `# 周报数据（dream-analysis 自动生成）`,
    ``,
    `> 窗口：${beijingDay(new Date(sinceMs))} ~ ${beijingDay(new Date(untilMs - 1))}（北京时区）｜ 生成于 ${beijingHour(now)} 北京`,
    `> 口径：已实现网格利润（ΣROUND_COMPLETED.profit）；回撤/占用率来自 ACCOUNT_OBSERVED 小时级快照`,
    ``,
  ].join('\n');

  const sections = instances.map((inst) => {
    const { events } = readInstanceEvents(rootDir, inst);
    if (!events.length) return `### ${inst}\n\n（本地无数据，先跑 npm run sync）\n`;
    const a = analyze(events, sinceMs, untilMs);
    return renderInstance(inst, cfg.instances?.[inst], a, now);
  });

  console.log(header + '\n' + sections.join('\n'));
}

main();
