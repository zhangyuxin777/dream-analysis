/**
 * 跨进程互斥锁（文件锁）。
 *
 * 为什么需要它：常驻 `run` 进程与手动 `npm run sync` 是两个独立进程，
 * 共用同一批 `data/.tmp/<instance>/<date>.jsonl.gz` 与同一个 `runtime/sync-state.json`。
 * 两边同时拉同一个 key 时会互相覆盖/删除对方的 tmp（假失败 → suspects 上涨），
 * 状态文件"后写覆盖先写"还会让水位线说谎（文件是旧版、状态说已同步）。
 * 调度器的单并发闸门只在**进程内**有效，挡不住这种情况。
 *
 * 三条硬要求（第二轮的 review 教训）：
 * 1. **必须原子独占创建**（`openSync(path,'wx')`）—— 先 `existsSync` 再写有 TOCTOU 窗口，
 *    两个进程同一毫秒进来会各写各的，锁形同不存在。
 * 2. **同机持有者已死 ⇒ 立刻可接管**（`process.kill(pid,0)`）—— 否则 `pm2 restart` / Ctrl+C 打断同步后，
 *    残留锁会把接下来的同步挡满一个 stale 周期（60 分钟间隔的同步等于停一小时）。
 * 3. **按年龄过期只作为异机/无法判活时的兜底**；token 归属防止"过期接管者"被原持有者误删。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LockHolder {
  pid: number;
  token: string;
  acquiredAt: string;
  host: string;
}

export type AcquireResult = { ok: true; holder: LockHolder } | { ok: false; holder: LockHolder | null };

/** 读锁文件（status 展示也用；损坏/不存在返回 null） */
export function readLock(filePath: string): LockHolder | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LockHolder>;
    if (typeof raw.token !== 'string' || typeof raw.acquiredAt !== 'string') return null;
    return { pid: Number(raw.pid ?? 0), token: raw.token, acquiredAt: raw.acquiredAt, host: String(raw.host ?? '') };
  } catch {
    return null;
  }
}

/** 进程是否还活着（同机判定；EPERM = 存在但没权限，仍算活着） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isFresh(existing: LockHolder, opts: { now: Date; staleMs: number; host: string }): boolean {
  const sameHost = existing.host !== '' && existing.host === opts.host;
  if (sameHost) {
    // 同机：**以"持有进程是否还活着"为准**。
    // 活着 ⇒ 绝不抢（哪怕年龄超过 stale 时长：慢同步/冷启动都可能跑很久，抢了就是"两个同步同时跑"）；
    // 死了 ⇒ 立刻可接管（pm2 restart / Ctrl+C 打断同步后，不该被残留锁挡满一个周期）。
    return isProcessAlive(existing.pid);
  }
  // 异机或无从判活：只能按年龄兜底
  const heldMs = opts.now.getTime() - Date.parse(existing.acquiredAt);
  if (!Number.isFinite(heldMs) || heldMs < 0) return false; // 时间不可信 ⇒ 当过期处理
  return heldMs < opts.staleMs;
}

/** 尝试获取锁；已被**活着的**持有者占用时返回 ok:false + 持有者信息 */
export function acquireLock(
  filePath: string,
  opts: { now: Date; staleMs: number; token: string; host?: string; pid?: number },
): AcquireResult {
  const host = opts.host ?? os.hostname();
  const holder: LockHolder = {
    pid: opts.pid ?? process.pid,
    token: opts.token,
    acquiredAt: opts.now.toISOString(),
    host,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // 最多两轮：第一轮撞到"已存在"，判断为过期/持有者已死就清掉再抢一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filePath, 'wx'); // ★ 原子独占创建（TOCTOU 就死在这里）
      try {
        fs.writeFileSync(fd, JSON.stringify(holder, null, 2) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, holder };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readLock(filePath);
      if (existing && isFresh(existing, { now: opts.now, staleMs: opts.staleMs, host })) {
        return { ok: false, holder: existing };
      }
      // 过期 / 损坏 / 同机持有者已死 ⇒ 接管
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // 删不掉就让下一轮去处理（最坏情况是返回 ok:false）
      }
    }
  }
  return { ok: false, holder: readLock(filePath) };
}

/** 释放锁：只有 token 匹配（即仍是我们自己持有）才删除 */
export function releaseLock(filePath: string, token: string): void {
  const existing = readLock(filePath);
  if (existing && existing.token !== token) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 释放失败不影响主流程（锁会随时间过期）
  }
}
