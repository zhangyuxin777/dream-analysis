/**
 * `stream` 分析器（别名 `st`）：**断流 / 重连 / 未恢复**。
 *
 * 这是"策略卡住 vs 系统挂了"的另一半答案：`stuck` 说明哪一轮压着仓位，
 * `stream` 说明行情流有没有断过、断了多久、恢复没有。
 *
 * 纯过滤 + 配对（事件名来自 `analysis/events.ts`，对照主仓白名单）：
 * - **断流开始**：`UDS_CONN_CLOSED` / `UDS_CONN_CLOSED_STALE` / `UDS_CONN_UNAVAILABLE`
 *   （`UDS_CONN_ERROR` 只算"报错"不算断流 —— 瞬时错误当断流会把时长虚高，这条是刻意的）
 * - **断流结束**：`UDS_SUBSCRIBE_OK` / `UDS_RETRY_OK` / `MARKET_STREAM_RECOVERED`
 *   配对算**每次断流时长**与**累计断流时长**；窗口结束时还没结束的记为"仍在断流"（算到参考时刻，标明）
 * - 其余连接事件（重连次数、rearm、WS 关闭原因、stale 重连）按类型统计
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section } from './types';
import { formatShanghai, windowHours } from '../common/time';
import {
  CONNECTION_EVENTS,
  OUTAGE_END_EVENTS,
  OUTAGE_START_EVENTS,
  detailOf,
  isConnection,
} from './events';

/** 累计断流超过窗口的这个比例就告警（行情流断这么久，策略等于瞎跑） */
export const OUTAGE_RATIO_ALERT = 0.02;

interface Outage {
  instance: string;
  startMs: number;
  startEvent: string;
  endMs: number | null;
  endEvent: string;
}

function hoursText(hours: number): string {
  return hours >= 48 ? `${(hours / 24).toFixed(1)}天` : hours >= 1 ? `${hours.toFixed(2)}h` : `${(hours * 60).toFixed(1)}min`;
}

export function streamAnalysis(): Analysis {
  return {
    name: 'stream',
    aliases: ['st'],
    help: '行情流健康：断流次数与时长、重连/未恢复、WS 关闭原因（区分"策略卡住"与"系统挂了"）',
    params: [
      { name: 'instance', description: '实例名（默认全部实例）', example: 'zyx666' },
      { name: 'window', description: `时间窗口（最长 ${MAX_WINDOW_HOURS}h）`, example: '近7d' },
      { name: 'top', description: '断开时间线取前 N 次（默认 10）', example: '30' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const topN = Math.max(1, Math.min(200, Number(ctx.params.top ?? '10') || 10));
      const referenceMs = Math.min(ctx.window.toMs, ctx.now.getTime());

      const byType = new Map<string, number>();
      const outages: Outage[] = [];
      const openByInstance = new Map<string, Outage>();
      const recent: Array<{ ts: string; instance: string; event: string; detail: string }> = [];
      let events = 0;

      const stats = await ctx.source.scan(
        { window: ctx.window, instance: ctx.params.instance },
        (e) => {
          if (!isConnection(e.event)) return;
          events++;
          byType.set(e.event, (byType.get(e.event) ?? 0) + 1);
          recent.push({ ts: e.ts, instance: e.instance, event: e.event, detail: detailOf(e.data, 2) });
          const ms = Date.parse(e.ts);
          if (!Number.isFinite(ms)) return;

          if (OUTAGE_START_EVENTS.includes(e.event)) {
            const prev = openByInstance.get(e.instance);
            if (prev && prev.endMs === null) return; // 已经在断流：不重复计时（连续几条断开事件算一次）
            const outage: Outage = { instance: e.instance, startMs: ms, startEvent: e.event, endMs: null, endEvent: '' };
            outages.push(outage);
            openByInstance.set(e.instance, outage);
            return;
          }
          if (OUTAGE_END_EVENTS.includes(e.event)) {
            const open = openByInstance.get(e.instance);
            if (open && open.endMs === null && ms >= open.startMs) {
              open.endMs = ms;
              open.endEvent = e.event;
              openByInstance.delete(e.instance);
            }
          }
        },
      );

      // 窗口结束时还在断流：算到参考时刻并标明（别假装已经恢复）
      const stillOpen = outages.filter((o) => o.endMs === null);
      for (const o of stillOpen) o.endMs = Math.max(o.startMs, referenceMs);

      const durations = outages.map((o) => ({ ...o, ms: Math.max(0, (o.endMs ?? referenceMs) - o.startMs) }));
      const totalMs = durations.reduce((sum, o) => sum + o.ms, 0);
      const longest = durations.slice().sort((a, b) => b.ms - a.ms)[0];
      const windowMs = Math.max(1, referenceMs - ctx.window.fromMs);
      const unrecovered = byType.get('MARKET_STREAM_UNRECOVERED') ?? 0;
      const failAlerts = byType.get('UDS_RETRY_FAIL_ALERT') ?? 0;

      const warnings: string[] = [];
      if (stats.missingDays.length > 0) {
        warnings.push(`窗口内缺 ${stats.missingDays.length} 天的本地数据: ${stats.missingDays.join(', ')}（断流可能被漏计）`);
      }
      if (stats.failedShards.length > 0) {
        warnings.push(`有 ${stats.failedShards.length} 个分片**读不出来** ⇒ 断流统计可能不完整: ` + stats.failedShards.slice(0, 3).map((f) => f.key).join(' | '));
      }
      if (stillOpen.length > 0) {
        warnings.push(
          `❗ 窗口结束时仍有 ${stillOpen.length} 个实例处于断流（${stillOpen.map((o) => o.instance).join('、')}）——`
            + ' 这是当前状态，不是历史记录',
        );
      }
      if (unrecovered > 0 || failAlerts > 0) {
        warnings.push(
          `❗ 出现未恢复/连续失败：MARKET_STREAM_UNRECOVERED×${unrecovered}、UDS_RETRY_FAIL_ALERT×${failAlerts}` +
            ' —— 说明自动重连没能自愈（这两条是"长时间一直恢复不了"的告警事件）',
        );
      }
      if (totalMs / windowMs > OUTAGE_RATIO_ALERT) {
        warnings.push(
          `累计断流 ${hoursText(totalMs / 3_600_000)}，占窗口 ${((totalMs / windowMs) * 100).toFixed(1)}%`
            + `（超过 ${(OUTAGE_RATIO_ALERT * 100).toFixed(0)}% 就告警）—— 断流期间行情是瞎的，策略等于盲跑`,
        );
      }
      if (events === 0 && stats.events > 0) {
        warnings.push('窗口内没有任何连接类事件 —— 白名单里它们本该在，先确认上传侧导出正常（doctor --deep 会核）');
      }

      const sections: Section[] = [
        {
          heading: '概览',
          headers: ['指标', '值'],
          rows: [
            ['窗口', `${ctx.window.label}（${windowHours(ctx.window).toFixed(1)}h）`],
            ['连接类事件', String(events)],
            ['断开次数', String(outages.length)],
            ['累计断流', hoursText(totalMs / 3_600_000) + (windowMs > 0 ? `（占 ${((totalMs / windowMs) * 100).toFixed(2)}%）` : '')],
            ['最长一次', longest ? `${hoursText(longest.ms / 3_600_000)}（${longest.instance}，${longest.startEvent}→${longest.endEvent || '未恢复'}）` : '-'],
            ['未恢复告警 / 连续失败告警', `${unrecovered} / ${failAlerts}`],
            ['窗口结束时仍在断流', stillOpen.length === 0 ? '否' : `是（${stillOpen.map((o) => o.instance).join('、')}）`],
          ],
          note: '断开 = `UDS_CONN_CLOSED`/`_CLOSED_STALE`/`_UNAVAILABLE`；恢复 = `UDS_SUBSCRIBE_OK`/`UDS_RETRY_OK`/`MARKET_STREAM_RECOVERED`。'
            + '`UDS_CONN_ERROR` 只算报错、不算断开（瞬时错误当断流会把时长虚高）。',
        },
      ];

      if (durations.length > 0) {
        const shown = durations.slice().sort((a, b) => b.ms - a.ms).slice(0, topN);
        sections.push({
          heading: `断开时间线 Top ${shown.length}（按时长降序）`,
          headers: ['实例', '断开于', '恢复于', '时长', '开始事件 → 结束事件'],
          rows: shown.map((o) => [
            o.instance,
            formatShanghai(o.startMs),
            o.endMs === null ? '-' : (o.endMs === referenceMs && o.endEvent === '' ? '窗口结束时仍未恢复' : formatShanghai(o.endMs)),
            hoursText(o.ms / 3_600_000),
            `${o.startEvent} → ${o.endEvent || '（未恢复）'}`,
          ]),
        });
      }

      if (byType.size > 0) {
        sections.push({
          heading: '按事件类型',
          headers: ['事件', '次数'],
          rows: [...byType.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([k, n]) => [k, String(n)]),
          note: '`UDS_RETRY_OK`/`WS_RECONNECTED` 多 = 反复重连；`WORKER_WS_CLOSE` 的 reason 字段能看出关闭原因。',
        });
      }

      if (recent.length > 0) {
        const shown = recent.slice(-Math.min(topN, recent.length)).reverse();
        sections.push({
          heading: `最近 ${shown.length} 条连接事件`,
          headers: ['时间', '实例', '事件', '关键字段'],
          rows: shown.map((r) => [r.ts.replace('T', ' ').slice(0, 19), r.instance, r.event, r.detail]),
        });
      }

      return {
        title: `行情流 · ${ctx.window.label}`,
        summary: events === 0
          ? (stats.events === 0 ? '窗口内没有事件（数据没到或没同步）' : '窗口内没有连接类事件')
          : `${outages.length} 次断开、累计 ${hoursText(totalMs / 3_600_000)}、最长 ${longest ? hoursText(longest.ms / 3_600_000) : '-'}`,
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}

/** 供测试/文档引用：连接事件全集（与 `CONNECTION_EVENTS` 同源） */
export const STREAM_EVENTS = CONNECTION_EVENTS;
