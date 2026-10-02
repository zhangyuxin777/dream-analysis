/**
 * 跨进程互斥锁（文件锁）。
 *
 * 为什么需要它：常驻 `run` 进程与手动 `npm run sync` 是两个独立进程，
 * 共用同一批 `data/.tmp/<instance>/<date>.jsonl.gz` 与同一个 `runtime/sync-state.json`。
 * 两边同时拉同一个 key 时会互相覆盖/删除对方的 tmp（假失败 → suspects 上涨），
 * 状态文件"后写覆盖先写"还会让水位线说谎（文件是旧版、状态说已同步）。
 * 调度器的单并发闸门只在**进程内**有效，挡不住这种情况。
 *
 * 取舍：
 * - **按年龄判过期**（默认 30 分钟）：不查 pid（跨平台不可靠，且 holder 与 we 同机同用户）。
 *   硬杀进程留下的锁最多挡 30 分钟 —— 对 60 分钟一轮的同步来说不会卡死。
 * - **token 归属**：释放时只在 token 匹配时删除，避免"过期接管者"被原持有者误删。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface LockHolder {
  pid: number;
  token: string;
  acquiredAt: string;
  host: string;
}

export type AcquireResult = { ok: true; holder: LockHolder } | { ok: false; holder: LockHolder | null };

function readHolder(filePath: string): LockHolder | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LockHolder>;
    if (typeof raw.token !== 'string' || typeof raw.acquiredAt !== 'string') return null;
    return { pid: Number(raw.pid ?? 0), token: raw.token, acquiredAt: raw.acquiredAt, host: String(raw.host ?? '') };
  } catch {
    return null; // 损坏的锁等同于过期锁（否则会永久挡路）
  }
}

/** 尝试获取锁；已被占用（且未过期）时返回 ok:false + 持有者信息 */
export function acquireLock(
  filePath: string,
  opts: { now: Date; staleMs: number; token: string; host?: string; pid?: number },
): AcquireResult {
  const holder: LockHolder = {
    pid: opts.pid ?? process.pid,
    token: opts.token,
    acquiredAt: opts.now.toISOString(),
    host: opts.host ?? '',
  };

  if (fs.existsSync(filePath)) {
    const existing = readHolder(filePath);
    if (existing) {
      const heldMs = opts.now.getTime() - Date.parse(existing.acquiredAt);
      const fresh = Number.isFinite(heldMs) && heldMs >= 0 && heldMs < opts.staleMs;
      if (fresh) return { ok: false, holder: existing };
    }
    // 过期或损坏 → 接管（下面直接覆盖写）
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(holder, null, 2) + '\n', 'utf8');
  return { ok: true, holder };
}

/** 释放锁：只有 token 匹配（即仍是我们自己持有）才删除 */
export function releaseLock(filePath: string, token: string): void {
  const existing = readHolder(filePath);
  if (existing && existing.token !== token) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 释放失败不影响主流程（锁会随时间过期）
  }
}
