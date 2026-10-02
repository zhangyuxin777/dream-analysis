/**
 * 分析命令的参数解析（**CLI 与机器人共用**）。
 *
 * 规则：
 * - `key=value` 永远优先；
 * - 裸参数里**长得像窗口的**（`2026-10-02` / `昨天` / `近24h` / 区间）一律当 `window`
 *   —— 否则 `analyze health 2026-10-02` 会把日期当成币种（实测踩过的坑）；
 * - 其余裸参数按 `POSITIONAL_PARAMS` 顺序填（symbol → instance → top），多出来的忽略。
 */
import { POSITIONAL_PARAMS, WINDOW_ARG_RE } from './types';

export interface ParsedAnalysisArgs {
  name: string;
  params: Record<string, string>;
}

export function parseAnalysisArgs(args: string[]): ParsedAnalysisArgs {
  const [name = '', ...rest] = args;
  const params: Record<string, string> = {};
  let positional = 0;
  for (const arg of rest) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      params[arg.slice(0, eq)] = arg.slice(eq + 1);
      continue;
    }
    // 窗口特判：① 长得像窗口 ② 纯非 ASCII（中文相对词如"上周"）—— 后者一定不是币种/实例名，
    // 交给 parseWindow 报"无法解析的窗口写法"，比悄悄当成币种（然后输出 0 事件）好得多
    if (WINDOW_ARG_RE.test(arg) || !/[A-Za-z0-9]/.test(arg)) {
      params.window = arg;
      continue;
    }
    const key = POSITIONAL_PARAMS[positional];
    if (!key) break;
    params[key] = arg;
    positional++;
  }
  return { name, params };
}
