/**
 * 分析执行器（**CLI 与机器人共用**）：注册表查找 → 窗口解析 → 事件源 → 跑分析器 → 渲染。
 *
 * 为什么抽出来：机器人回话与 CLI 打印必须是同一份结果、同一套错误文案；
 * 两边各写一遍必然出现"CLI 能跑、机器人报另一个错"这种最难查的漂移。
 */
import { AppConfig } from '../config';
import { Window, parseWindow } from '../common/time';
import { loadState } from '../sync/state';
import { statePathOf } from '../sync/puller';
import { LocalEventSource } from '../store/eventSource';
import { RenderOutput, renderResult } from '../report/render';
import { Analysis, AnalysisRegistry, AnalysisResult, MAX_WINDOW_HOURS } from './types';
import { createAnalysisRegistry } from './index';

export type AnalysisRunErrorKind = 'unknown-analysis' | 'no-data';

export class AnalysisRunError extends Error {
  constructor(message: string, public readonly kind: AnalysisRunErrorKind) {
    super(message);
    this.name = 'AnalysisRunError';
  }
}

export interface RunAnalysisOptions {
  config: AppConfig;
  name: string;
  params: Record<string, string>;
  /** 注入时钟（可测性）；窗口默认"昨天" */
  now?: Date;
  registry?: AnalysisRegistry;
  maxWindowHours?: number;
}

export interface RunAnalysisOutput {
  analysis: Analysis;
  window: Window;
  result: AnalysisResult;
  rendered: RenderOutput;
  elapsedMs: number;
}

/** 查分析器；未知则抛 `AnalysisRunError('unknown-analysis')` */
export function resolveAnalysis(registry: AnalysisRegistry, name: string): Analysis {
  const analysis = registry.get(name);
  if (!analysis) throw new AnalysisRunError(`未知分析器: ${name}`, 'unknown-analysis');
  return analysis;
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<RunAnalysisOutput> {
  const registry = opts.registry ?? createAnalysisRegistry();
  const analysis = resolveAnalysis(registry, opts.name);
  const now = opts.now ?? new Date();

  // 窗口解析的错误（WindowParseError / WindowTooLongError）原样抛出，由调用方给出对应文案
  const window = parseWindow(opts.params.window, now, undefined, { maxHours: opts.maxWindowHours ?? MAX_WINDOW_HOURS });

  const { state, warnings } = loadState(statePathOf(opts.config));
  const source = new LocalEventSource({
    dataDir: opts.config.runtime.dataDir,
    prefix: opts.config.oss.prefix,
    state,
    countIncludesHeader: opts.config.sync.countIncludesHeader,
  });
  if (source.instances().length === 0) {
    throw new AnalysisRunError('本地还没有任何分片 —— 先同步一次（sync / npm run sync）', 'no-data');
  }

  const started = Date.now();
  const result = await analysis.run({ source, now, window, params: opts.params });
  if (warnings.length > 0) {
    result.warnings = [...warnings.map((w) => `状态文件有问题：${w}`), ...result.warnings];
  }
  const rendered = renderResult(result, { maxChars: opts.config.report.inlineMaxChars });
  return { analysis, window, result, rendered, elapsedMs: Date.now() - started };
}
