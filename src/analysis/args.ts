/**
 * 分析命令的参数解析（**CLI 与机器人共用**）。
 *
 * 两个入口，别混用：
 * - `parseAnalysisParams(tokens, positional)` —— **只解析参数**（快捷指令 `r …` / `hc …` 用这个：
 *   命令名本身就是分析器名，参数列表里不该再有一个"名字"位置）；
 * - `parseAnalyzeCommand(tokens, analysisOf)` —— `analyze <名字> [参数…]` 用这个（第一个 token 是名字）。
 *
 * ⚠️ 实测踩过的坑（M3 review 的 Critical）：快捷指令曾把参数列表交给"名字在前"的解析器，
 * 于是 `r eth 昨天` 的 `eth` 被当成分析器名吃掉 ⇒ 币种过滤静默失效、报告把**全部币种混算**。
 *
 * 位置参数顺序**按分析器自己声明的 `params` 决定**（`health` 的第一个裸参数是 `instance`，
 * `rounds` 的第一个是 `symbol`）—— 用一个全局固定顺序就会让 `hc boye888` 静默失去实例过滤。
 */
import { Analysis, POSITIONAL_PARAMS, WINDOW_ARG_RE } from './types';

/** 该分析器的位置参数顺序：取它自己声明的参数名（去掉 window），没声明就退回全局默认 */
export function positionalNamesOf(analysis: Analysis | undefined): readonly string[] {
  const declared = (analysis?.params ?? []).map((p) => p.name).filter((n) => n !== 'window');
  return declared.length > 0 ? declared : POSITIONAL_PARAMS;
}

export function parseAnalysisParams(tokens: string[], positional: readonly string[] = POSITIONAL_PARAMS): Record<string, string> {
  const params: Record<string, string> = {};
  let index = 0;
  for (const arg of tokens) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      params[arg.slice(0, eq)] = arg.slice(eq + 1);
      continue;
    }
    // 窗口特判：① 长得像窗口 ② 纯非 ASCII（中文相对词如"上周"）—— 后者一定不是币种/实例名，
    // 交给 parseWindow 报"无法解析的窗口写法"，比悄悄当成 symbol（然后输出 0 事件）好得多
    if (WINDOW_ARG_RE.test(arg) || !/[A-Za-z0-9]/.test(arg)) {
      params.window = arg;
      continue;
    }
    const key = positional[index];
    if (!key) break; // 多出来的裸参数不猜
    params[key] = arg;
    index++;
  }
  return params;
}

export interface ParsedAnalyzeCommand {
  name: string;
  params: Record<string, string>;
}

/** `analyze <名字> [参数…]`：`analysisOf` 用来按名字查分析器（决定位置参数顺序） */
export function parseAnalyzeCommand(
  tokens: string[],
  analysisOf?: (name: string) => Analysis | undefined,
): ParsedAnalyzeCommand {
  const [name = '', ...rest] = tokens;
  return { name, params: parseAnalysisParams(rest, positionalNamesOf(analysisOf?.(name))) };
}
