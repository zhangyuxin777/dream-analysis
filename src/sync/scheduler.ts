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
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** 立即跑一次（正在跑则复用当前这次，不排队） */
  triggerNow(): Promise<void>;
  isRunning(): boolean;
  lastRunAt(): Date | null;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
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
      // 故意 unref：定时器不该单独决定进程生死（进程还有别的常驻职责时更明显）
      timer = setInterval(() => void triggerNow(), periodMs);
      if (typeof timer.unref === 'function') timer.unref();
      deps.logger.info('定时同步已启动', { intervalMinutes: deps.intervalMinutes });
    },
    stop(): void {
      if (timer) {
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
