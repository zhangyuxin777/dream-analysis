/**
 * 本地事件源：把 `data/<instance>/<date>.jsonl.gz` 变成"按窗口/实例/币种过滤的事件流"。
 *
 * 关键取舍：
 * - **分片清单来自 `sync-state.json`**（那里已经有 dataLines/final/warnings），
 *   而不是每次扫描目录再解压读 header —— 解压 30 天的分片只为拿 header 是浪费。
 *   文件若被手工删掉，会在扫描时按"缺数据"如实报告（不比假装有更糟）。
 * - **窗口过滤用 `ts`**（契约时区换算后比），币种过滤支持短名（`btc` → `BTCFDUSD`）。
 * - **缺天必报**：窗口覆盖的本地日里，本地没有分片的，逐个进 `missingDays`
 *   —— 分析结果里必须能看出"这几天没数据"，而不是算出来一个偏小的数字。
 */
import * as fs from 'fs';
import * as path from 'path';
import { readShard } from '../ndjson/shard';
import { parseShardKey } from '../ndjson/types';
import { SyncState } from '../sync/state';
import { inWindow } from '../common/time';
import { EventSourceLike, LoadedEventLike, ScanStats, ShardInfo } from '../analysis/types';

export interface LocalEventSourceOptions {
  dataDir: string;
  prefix: string;
  state: SyncState;
  countIncludesHeader?: boolean;
}

export class LocalEventSource implements EventSourceLike {
  constructor(private readonly opts: LocalEventSourceOptions) {}

  /** 本地已有的分片（来自水位线，附 final 与行数） */
  shards(instance?: string): ShardInfo[] {
    const out: ShardInfo[] = [];
    for (const [key, obj] of Object.entries(this.opts.state.objects)) {
      const parsed = parseShardKey(key, this.opts.prefix);
      if (!parsed) continue;
      if (instance && parsed.instance !== instance) continue;
      const filePath = path.join(this.opts.dataDir, parsed.instance, `${parsed.date}.jsonl.gz`);
      if (!fs.existsSync(filePath)) continue; // 水位线说有、磁盘上没有 ⇒ 当缺数据处理
      out.push({
        key,
        instance: parsed.instance,
        date: parsed.date,
        filePath,
        size: fs.statSync(filePath).size,
        final: obj.final,
        dataLines: obj.dataLines,
        warnings: obj.warnings ?? [],
      });
    }
    return out.sort((a, b) => (a.date === b.date ? a.instance.localeCompare(b.instance) : a.date.localeCompare(b.date)));
  }

  instances(): string[] {
    return [...new Set(this.shards().map((s) => s.instance))].sort();
  }

  availableDays(instance?: string): string[] {
    return [...new Set(this.shards(instance).map((s) => s.date))].sort();
  }

  async scan(
    filter: { window: import('../common/time').Window; instance?: string; symbol?: string },
    onEvent: (event: LoadedEventLike) => void,
  ): Promise<ScanStats> {
    const inScope = this.shards(filter.instance);
    const wanted = new Set(filter.window.days);
    const target = inScope.filter((s) => wanted.has(s.date));

    const stats: ScanStats = {
      shards: 0,
      events: 0,
      badLines: 0,
      missingDays: [],
      provisional: false,
      failedShards: [],
      shardWarnings: [],
    };
    const coveredDays = new Set<string>();

    // 按 (date, instance) 顺序扫，保证事件在分析器里是时间有序的
    for (const shard of target) {
      const result = await readShard(shard.filePath, {
        countIncludesHeader: this.opts.countIncludesHeader,
        onEvent: (record, lineNo) => {
          const tsMs = Date.parse(record.ts);
          if (!Number.isFinite(tsMs) || !inWindow(filter.window, tsMs)) return;
          if (filter.symbol && !matchSymbol(record.symbol, filter.symbol)) return;
          stats.events++;
          onEvent({ ...record, instance: shard.instance, date: shard.date, lineNo });
        },
      });

      if (!result.ok) {
        // 读不出来的分片：不记入 coveredDays（该天要么进 missingDays，要么由这条失败记录解释）
        stats.failedShards.push({ key: shard.key, errors: result.errors });
        continue;
      }

      stats.shards++;
      stats.badLines += result.badLines;
      coveredDays.add(shard.date);
      if (!shard.final) stats.provisional = true;

      // 分片级告警：同步时校验出来的（行数不符/缺前段/日期不一致）+ 本次读取发现的
      const warnings = [...(shard.warnings ?? []), ...result.warnings];
      if (warnings.length > 0) stats.shardWarnings.push({ key: shard.key, warnings });
    }

    // 窗口内"应该有但没有"的本地日：按窗口逐日比对（多实例时只要有一个实例有数据就算覆盖到了那一天）
    for (const day of filter.window.days) {
      if (!coveredDays.has(day)) stats.missingDays.push(day);
    }

    return stats;
  }
}

/** 币种匹配：支持精确（ETHFDUSD）与短名（eth → ETHFDUSD），大小写不敏感 */
export function matchSymbol(eventSymbol: string | undefined, filter: string): boolean {
  if (!eventSymbol) return false;
  const target = filter.trim().toUpperCase();
  if (target === '') return true;
  return eventSymbol.toUpperCase() === target || eventSymbol.toUpperCase().startsWith(target);
}
