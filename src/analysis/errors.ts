/**
 * `errors` 分析器（别名 `e`）：**需要人看一眼的事件**明细（异常 / 退化 / 未恢复）。
 *
 * 纯过滤：事件名清单来自 `analysis/events.ts`（单一真源，逐个列名，**不用后缀正则猜** ——
 * 早先那样会漏掉 `ORDER_EXPIRED`/`SELL_ORDER_LOST`/`WORKER_WS_STALE_RECONNECT` 这一大票）。
 *
 * 分成两档：`CRITICAL_EVENTS`（未恢复/连续失败/丢单/未对账/启动失败 —— 真出事）
 * 与其余"需要看一眼"的（退化、跳过、限流、耗尽）。
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section } from './types';
import { windowHours } from '../common/time';
import { detailOf, isAttention, isCritical, kindOf } from './events';

/** 单类事件超过这个次数就提示"可能是风暴"（低频状态变化事件不该这么密） */
export const STORM_THRESHOLD = 20;

const KIND_LABEL: Record<string, string> = {
  round: '轮次/复位', profit: '止盈/订单', topup: '补仓', crash: '深跌', stop: '停轮',
  order: '订单/卖出', connection: '连接/行情流', recovery: '启动/恢复', account: '账户',
  config: '配置', signal: '信号', other: '其他',
};

export function errorsAnalysis(): Analysis {
  return {
    name: 'errors',
    aliases: ['e'],
    help: '需要人看一眼的事件明细（异常/退化/未恢复）：按类型、按实例、最严重的一批 + 最近明细',
    params: [
      { name: 'instance', description: '实例名（默认全部实例）', example: 'zyx666' },
      { name: 'window', description: `时间窗口（最长 ${MAX_WINDOW_HOURS}h）`, example: '近7d' },
      { name: 'top', description: '最近明细条数（默认 10）', example: '30' },
      { name: 'kind', description: '只看某一类（round/profit/topup/crash/stop/order/connection/recovery）', example: 'connection' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const topN = Math.max(1, Math.min(200, Number(ctx.params.top ?? '10') || 10));
      const kindFilter = (ctx.params.kind ?? '').toLowerCase();
      const knownKinds = ['round', 'profit', 'topup', 'crash', 'stop', 'order', 'connection', 'recovery', 'account', 'config', 'signal', 'other'];

      const byType = new Map<string, number>();
      const byInstance = new Map<string, number>();
      const byKind = new Map<string, number>();
      const critical: Array<{ ts: string; instance: string; symbol: string; event: string; detail: string }> = [];
      const recent: Array<{ ts: string; instance: string; symbol: string; event: string; detail: string }> = [];
      let total = 0;

      const stats = await ctx.source.scan(
        { window: ctx.window, instance: ctx.params.instance },
        (e) => {
          if (!isAttention(e.event)) return;
          const kind = kindOf(e.event);
          if (kindFilter !== '' && kind !== kindFilter) return;
          total++;
          byType.set(e.event, (byType.get(e.event) ?? 0) + 1);
          byInstance.set(e.instance, (byInstance.get(e.instance) ?? 0) + 1);
          byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
          const row = { ts: e.ts, instance: e.instance, symbol: e.symbol ?? '-', event: e.event, detail: detailOf(e.data, 3) };
          if (isCritical(e.event)) critical.push(row);
          recent.push(row);
        },
      );

      const warnings: string[] = [];
      // kind 写错要给告警：否则会输出"窗口内没有需要看的事件"，把拼写错误伪装成"一切正常"
      if (kindFilter !== '' && !knownKinds.includes(kindFilter)) {
        warnings.push(`kind="${ctx.params.kind}" 不是已知类别（可用：${knownKinds.join('/')}）—— 本次按该类别过滤，结果必然是空的`);
      }
      if (stats.missingDays.length > 0) {
        warnings.push(`窗口内缺 ${stats.missingDays.length} 天的本地数据: ${stats.missingDays.join(', ')}（异常可能被漏掉）`);
      }
      if (stats.failedShards.length > 0) {
        warnings.push(`有 ${stats.failedShards.length} 个分片**读不出来** ⇒ 其中的异常没有统计进来: ` + stats.failedShards.slice(0, 3).map((f) => f.key).join(' | '));
      }
      if (critical.length > 0) {
        const kinds = [...new Set(critical.map((c) => c.event))].join('、');
        warnings.push(`❗ 出现 ${critical.length} 条**最该立刻看**的事件（${kinds}）—— 未恢复/连续失败/丢单/未对账/启动失败这一档，逐条看下面的明细`);
      }
      const storms = [...byType.entries()].filter(([, n]) => n > STORM_THRESHOLD);
      if (storms.length > 0) {
        warnings.push(
          `有 ${storms.length} 类事件超过 ${STORM_THRESHOLD} 次（${storms.slice(0, 3).map(([k, n]) => `${k}×${n}`).join('、')}）——`
            + '低频状态变化事件这么密，通常是风暴或参数不合适，值得看一眼',
        );
      }
      if (total === 0 && stats.events > 0) warnings.push('窗口内没有需要看的事件（这是好事，不是数据缺失）');

      const sections: Section[] = [
        {
          heading: '概览',
          headers: ['指标', '值'],
          rows: [
            ['窗口', `${ctx.window.label}（${windowHours(ctx.window).toFixed(1)}h）`],
            ['分片 / 事件', `${stats.shards} / ${stats.events}`],
            ['需要看的事件', String(total)],
            ['其中"最该立刻看"', String(critical.length)],
            ['涉及类型 / 实例', `${byType.size} / ${byInstance.size}`],
          ],
          note: '事件名清单来自 `analysis/events.ts`（对照主仓白名单逐个列名）；"最该立刻看"= 未恢复/连续失败/丢单/未对账/启动失败。',
        },
      ];

      if (byKind.size > 0) {
        sections.push({
          heading: '按类别',
          headers: ['类别', '次数'],
          rows: [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [KIND_LABEL[k] ?? k, String(n)]),
        });
      }

      if (byType.size > 0) {
        sections.push({
          heading: `按事件类型（Top ${Math.min(15, byType.size)}）`,
          headers: ['事件', '次数', '类别'],
          rows: [...byType.entries()]
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, 15)
            .map(([name, n]) => [name, String(n), KIND_LABEL[kindOf(name)] ?? '-']),
        });
      }

      if (critical.length > 0) {
        const shown = [...critical].slice(-Math.min(topN, critical.length)).reverse();
        sections.push({
          heading: `最该立刻看（${critical.length} 条，按时间倒序最多 ${shown.length} 条）`,
          headers: ['时间', '实例', '币种', '事件', '关键字段'],
          rows: shown.map((c) => [c.ts.replace('T', ' ').slice(0, 19), c.instance, c.symbol, c.event, c.detail]),
        });
      }

      if (recent.length > 0) {
        const shown = [...recent].slice(-topN).reverse();
        sections.push({
          heading: `最近 ${shown.length} 条`,
          headers: ['时间', '实例', '币种', '事件', '关键字段'],
          rows: shown.map((c) => [c.ts.replace('T', ' ').slice(0, 19), c.instance, c.symbol, c.event, c.detail]),
          note: '关键字段是从事件 data 里挑的（error/reason/code/retryCount…）；完整字段在分片里（verify 可看）。',
        });
      }

      if (byInstance.size > 1) {
        sections.push({
          heading: '按实例',
          headers: ['实例', '次数'],
          rows: [...byInstance.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, String(n)]),
        });
      }

      return {
        title: `异常事件 · ${ctx.window.label}${kindFilter ? ` · ${kindFilter}` : ''}`,
        summary: total === 0
          ? (stats.events === 0 ? '窗口内没有事件（数据没到或没同步）' : '窗口内没有需要看的事件')
          : `${total} 条需要看的事件（最该立刻看 ${critical.length} 条，涉及 ${byType.size} 类）`,
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}
