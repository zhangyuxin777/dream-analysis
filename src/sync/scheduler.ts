/**
 * 定时调度器：**单并发**（同一时刻只有一个同步在跑）。
 *
 * 为什么必须有单并发：`dream-002` 上还有实盘，两个同步撞同一批文件不但浪费 IO，
 * 还会让状态文件互相覆盖（后写的把先写的进度拍掉）。
 * 触发来源：定时器 + 手动（CLI/机器人指令）；手动撞上正在跑的，**不排队**、只记一条 warn
 * ——排队会在"数据没变、每轮都跳过"时积累无用任务。
 */
import { ILogger } from '../common/logger';

export interface SchedulerDeps {
  intervalMinutes: number;
  logger: ILogger;
  run: () => Promise<unknown>;
  now?: () => Date;
  /**
   * 对齐整点后的第 N 分钟首次触发（0~59，可选）。
   * 策略侧导出在整点 X:00:02 运行，同步对齐到 X+N 就能把数据时滞压到约 1 小时；
   * 不配置则保持旧行为（从启动时刻起每 intervalMinutes，部署重启后触发分钟会漂移）。
   */
  alignMinute?: number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** 立即跑一次（正在跑则复用当前这次，不排队） */
  triggerNow(): Promise<void>;
  isRunning(): boolean;
  lastRunAt(): Date | null;
}

/** 距下一个"整区间边界 + alignMinute"的毫秒数（interval=60 时即整点后第 N 分钟） */
export function alignedDelayMs(fromMs: number, alignMinute: number, intervalMinutes: number): number {
  const coeff = Math.max(1, intervalMinutes) * 60_000;
  const aligned = Math.floor(fromMs / coeff) * coeff + alignMinute * 60_000;
  return (aligned <= fromMs ? aligned + coeff : aligned) - fromMs;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let lastRun: Date | null = null;

  const triggerNow = (): Promise<void> => {
    if (inflight) {
      deps.logger.warn('上一次同步还在跑，本轮跳过（不排队）');
      return inflight;
    }
    const startedMs = now().getTime();
    inflight = (async () => {
      try {
        await deps.run();
      } catch (err) {
        // 定时任务里的异常绝不能冒泡到进程（那会让 pm2 反复重启）
        deps.logger.error('同步任务异常', { detail: err instanceof Error ? err.message : String(err) });
      } finally {
        lastRun = now();
        deps.logger.debug('同步任务结束', { durationMs: now().getTime() - startedMs });
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    start(): void {
      if (timer) return;
      const periodMs = Math.max(1, deps.intervalMinutes) * 60_000;
      if (deps.alignMinute != null) {
        // 对齐整点后第 N 分钟：首次用 setTimeout 到位，之后按周期 setInterval，重启/部署不再漂移
        const firstDelayMs = alignedDelayMs(now().getTime(), deps.alignMinute, deps.intervalMinutes);
        const boot = setTimeout(() => {
          void triggerNow();
          timer = setInterval(() => void triggerNow(), periodMs);
          if (typeof timer.unref === 'function') timer.unref();
        }, firstDelayMs);
        if (typeof boot.unref === 'function') boot.unref();
        timer = boot;
        deps.logger.info('定时同步已启动（整点对齐）', { intervalMinutes: deps.intervalMinutes, alignMinute: deps.alignMinute, firstDelayMs });
        return;
      }
      // 故意 unref：定时器不该单独决定进程生死（进程还有别的常驻职责时更明显）
      timer = setInterval(() => void triggerNow(), periodMs);
      if (typeof timer.unref === 'function') timer.unref();
      deps.logger.info('定时同步已启动', { intervalMinutes: deps.intervalMinutes });
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
        deps.logger.info('定时同步已停止');
      }
    },
    triggerNow,
    isRunning: () => inflight !== null,
    lastRunAt: () => lastRun,
  };
}
