/**
 * 分析器注册表入口：**加分析器只改这一个文件**（`help` 与指令表由注册表生成，不会漂移）。
 */
import { Analysis, AnalysisRegistry, createDefaultRegistry } from './types';
import { healthAnalysis } from './health';
import { roundsAnalysis } from './rounds';
import { stuckAnalysis } from './stuck';
import { errorsAnalysis } from './errors';
import { streamAnalysis } from './stream';
import { topupAnalysis } from './topup';

/** 默认注册的实现清单（顺序即 help 的展示顺序，这里按名字排序了） */
export function defaultAnalyses(): Analysis[] {
  return [healthAnalysis(), roundsAnalysis(), stuckAnalysis(), errorsAnalysis(), streamAnalysis(), topupAnalysis()];
}

export function createAnalysisRegistry(): AnalysisRegistry {
  return createDefaultRegistry(defaultAnalyses());
}

export { MAX_WINDOW_HOURS, POSITIONAL_PARAMS } from './types';
export type { Analysis, AnalysisContext, AnalysisResult, Section, ParamSpec } from './types';
