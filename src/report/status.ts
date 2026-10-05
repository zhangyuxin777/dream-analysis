/**
 * `status` 的文本构建（**CLI 与机器人共用同一份**）。
 *
 * 为什么单独成模块：CLI 与机器人各写一套状态文案必然漂移，而"数据落后了几天"这种信息
 * 一旦两边不一致，排障时就会互相打架。这里只负责产文本，打印/回复交给调用方。
 */
import * as os from 'os';
import * as path from 'path';
import { AppConfig } from '../config';
import { formatBytes, formatCount, formatDurationMs } from '../common/format';
import { loadState, listLocalShards } from '../sync/state';
import { lockPathOf, statePathOf } from '../sync/puller';
import { isProcessAlive, readLock } from '../sync/lock';
import { parseShardKey } from '../ndjson/types';
import { shanghaiDayOf } from '../common/time';

export interface StatusOptions {
  /** 注入时钟（机器人/测试用；默认取真实时间） */
  now?: Date;
  /** 根目录（用于把状态文件显示成相对路径） */
  rootDir?: string;
}

export function buildStatusText(config: AppConfig, opts: StatusOptions = {}): string {
  const now = opts.now ?? new Date();
  const stateFile = statePathOf(config);
  const { state, warnings } = loadState(stateFile);
  const lines: string[] = [];

  for (const w of warnings) lines.push(`⚠️  ${w}`);

  lines.push('=== 同步状态 ===');
  lines.push(`状态文件: ${opts.rootDir ? path.relative(opts.rootDir, stateFile) : stateFile}`);

  if (!state.lastRun) {
    lines.push('上次同步: 从未跑过（先执行 sync）');
  } else {
    const r = state.lastRun;
    const dur = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    lines.push(
      `上次同步: ${r.finishedAt} 用时 ${formatDurationMs(dur)} | 列举 ${r.listed} / 拉取 ${r.pulled} / 跳过 ${r.skipped} / 忽略 ${r.ignored} / 失败 ${r.failed} (${formatBytes(r.bytes)})`,
    );
    if (r.refusedByLock) lines.push('  本轮因"已有同步在进行"被跳过（跨进程互斥）');
    if (r.deferred) lines.push(`  退避中: ${r.deferred} 个分片（同内容按 30min×2^n 退避，换内容立刻重试）`);
    for (const c of r.whitelistChanges ?? []) lines.push(`  ⚠️ 数据口径变更: ${c}`);
    for (const e of r.errors.slice(0, 5)) lines.push(`  ❌ ${e}`);
  }

  const shards = listLocalShards(config.runtime.dataDir);
  const total = shards.reduce((s, x) => s + x.size, 0);
  lines.push(`本地分片: ${shards.length} 个，共 ${formatBytes(total)}`);

  const entries = Object.entries(state.objects).sort((a, b) => b[0].localeCompare(a[0]));
  for (const [key, obj] of entries.slice(0, 20)) {
    const parsed = parseShardKey(key, config.oss.prefix);
    const label = parsed ? `${parsed.instance.padEnd(10)} ${parsed.date}` : key;
    const flag = obj.final ? '已封存' : '未封存';
    const wl = obj.whitelistVersion ? `  口径=${obj.whitelistVersion}` : '';
    const warn = obj.warnings.length > 0 ? `  ⚠️ ${obj.warnings.length} 条告警` : '';
    lines.push(`  ${label}  ${flag}  ${formatCount(obj.dataLines)} 行  ${formatBytes(obj.size)}  拉于 ${obj.pulledAt}${wl}${warn}`);
  }
  if (entries.length > 20) lines.push(`  … 另有 ${entries.length - 20} 条`);

  const latestFinal = entries
    .filter(([, o]) => o.final)
    .map(([k]) => parseShardKey(k, config.oss.prefix)?.date ?? '')
    .filter((d) => d !== '')
    .sort()
    .pop();
  const todayShanghai = shanghaiDayOf(now.getTime());
  if (latestFinal) {
    const lagDays = Math.round((Date.parse(`${todayShanghai}T00:00:00Z`) - Date.parse(`${latestFinal}T00:00:00Z`)) / 86_400_000);
    lines.push(`已封存最新日期: ${latestFinal}（今天 ${todayShanghai}，落后 ${lagDays} 天）`);
    if (lagDays > 2) lines.push('⚠️  数据落后超过 2 天 —— 上游导出或本服务同步可能停了');
  } else {
    lines.push('还没有已封存的分片（final=true）');
  }

  const suspects = Object.entries(state.suspects).filter(([, s]) => s.count > 0);
  if (suspects.length > 0) {
    lines.push(`失败退避中的分片: ${suspects.length} 个`);
    for (const [k, s] of suspects.slice(0, 5)) lines.push(`  ⏸ ${k}（已失败 ${s.count} 次，最后失败于 ${s.lastErrorAt}）`);
  }

  // 本地分片不再自动删除（见 puller.ts）：盘上就是全部历史，所以这里只报数量与体积
  const shardsAll = listLocalShards(config.runtime.dataDir);
  if (shardsAll.length > 0) {
    const oldest = [...shardsAll].sort((a, b) => a.date.localeCompare(b.date))[0];
    lines.push(`历史覆盖: ${oldest.date} ~ 最新（本地分片永不自动删除；盘满会响亮失败，不会静默丢数据）`);
  }

  // 锁是"此刻有没有同步在跑"的唯一准确来源（被拒轮次不写状态文件 —— 写了会和持有者互相覆盖）
  const holder = readLock(lockPathOf(config));
  if (holder) {
    const heldMs = now.getTime() - Date.parse(holder.acquiredAt);
    lines.push(`当前有同步在进行: pid=${holder.pid}@${holder.host} 自 ${holder.acquiredAt}（已 ${formatDurationMs(heldMs)}）`);
    if (holder.host === os.hostname() && !isProcessAlive(holder.pid)) {
      lines.push('⚠️  该持有进程已不存在（残留锁）—— 下一次同步会自动接管');
    }
  }

  return lines.join('\n');
}
