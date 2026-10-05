/**
 * 指令路由（本仓自己的对话层）。
 *
 * 与主仓 `command-router.ts` 的关系：**只借用它的"鉴权顺序"这一条经验**
 * （`whoami` 必须在权限检查之前，否则配白名单时根本拿不到 ID），
 * 其余全部重写 —— 主仓那套是"同步返回一段文本"，而这里要跑分析（可能几秒）。
 *
 * 三条设计取舍：
 * 1. **全部只读**：`sync` 之外不写任何东西；分析只读本地分片，不碰 OSS 的 `snapshot/`。
 * 2. **异步二次回复**：分析超过 `syncReplyBudgetMs`（默认 4s）就先回"⏳ 正在分析…"，
 *    结果出来后用 `reply(sessionWebhook, text)` 单独补一条。钉钉的 ack 由 SDK 负责，
 *    所以这里不存在飞书那种"3 秒不回就重推"的压力 —— 但**用户体验**需要这个反馈。
 * 3. **同一会话单并发**：分析是 CPU 活，同一会话同时只允许一个在跑（超出的直接拒绝，不排队）。
 *    慢任务转成"二次回复"后，占位会一直保留到那次分析结束，避免连点把 CPU 打满。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config';
import { ILogger } from '../common/logger';
import { formatBytes } from '../common/format';
import { AnalysisRegistry } from '../analysis/types';
import { createAnalysisRegistry } from '../analysis/index';
import { parseAnalysisParams, parseAnalyzeCommand, positionalNamesOf } from '../analysis/args';
import { AnalysisRunError, RunAnalysisOutput, runAnalysis } from '../analysis/runner';
import { WindowParseError, WindowTooLongError } from '../common/time';
import { buildStatusText } from '../report/status';
import { renderResult } from '../report/render';
import { PullResult, runSync } from '../sync/puller';
import { buildStore } from '../oss/storeFactory';
import { IncomingMessage } from './types';
import { DingTalkIncomingMessage } from './dingtalk-bot';

export const DEFAULT_SYNC_REPLY_BUDGET_MS = 4000;
/**
 * 进程级并发上限（默认 1）。**为什么必须有**：这台机器（dream-002）还跑着实盘，
 * 而"按会话"的闸门挡不住多群并发 —— 两个群各来一条就能同时扫两份整天分片。
 * 分析都在同一条 JS 线程上，并发不会更快，只会让所有人都等，还会抢实盘的 CPU。
 */
export const DEFAULT_MAX_CONCURRENT_ANALYSES = 1;
/** 落盘用的"无上限"预算（约 1MB 文本；报告不可能到这个量级） */
const FULL_REPORT_MAX_CHARS = 1_000_000;

export interface RouterDeps {
  config: AppConfig;
  logger: ILogger;
  registry?: AnalysisRegistry;
  /** 二次回复（默认由钉钉客户端的 replyText 提供） */
  reply?: (webhook: string, text: string) => Promise<void>;
  /** 分析完成要多快才走"一条回复"；超时则先回"正在分析"再补结果（0 = 永远等） */
  syncReplyBudgetMs?: number;
  /** 进程级并发上限（默认 1：这台机器还跑着实盘） */
  maxConcurrentAnalyses?: number;
  /** 注入同步实现（测试用；默认真跑 OSS + 本地） */
  runSyncFn?: (opts: { force: boolean }) => Promise<PullResult>;
  now?: () => Date;
}

export function buildHelpText(registry: AnalysisRegistry): string {
  return [
    '📋 指令列表',
    '',
    '其他:',
    '  h / help              本列表',
    '  whoami                查看 ID（配白名单用）',
    '  status                数据新鲜度 / 本地分片 / 同步情况',
    '  sync [--force]        立刻同步一次（默认管理员）',
    '',
    '分析:',
    '  a / analyze <名字> …  执行分析（名字见下）',
    '  hc / health […]       运行健康（数据完整性 / 心跳 / 异常计数）',
    '  r / rounds […]        轮次与成交（当天/某日的窗口统计）',
    '  sk / stuck […]        卡住轮（当前还没收口的轮、卡了多久、浮亏多少）',
    '  e / errors […]        异常事件明细（需要看一眼的：退化/未恢复/丢单…）',
    '  st / stream […]       行情流健康（断流次数与时长、重连、未恢复）',
    '',
    '参数：裸参数里长得像窗口的（2026-10-01 / 昨天 / 近24h / 区间）一律当 window；',
    '      其余按 symbol → instance → top 顺序填；也可以写 key=value。',
    '',
    registry.helpText(),
  ].join('\n');
}

export class CommandRouter {
  private registry: AnalysisRegistry;
  private inflight = new Set<string>();
  private running = 0;
  private now: () => Date;

  constructor(private readonly deps: RouterDeps) {
    if (!deps.config.bot) throw new Error('未配置 bot（config.bot 为空时不该创建 router）');
    this.registry = deps.registry ?? createAnalysisRegistry();
    this.now = deps.now ?? (() => new Date());
  }

  async handle(msg: IncomingMessage | DingTalkIncomingMessage): Promise<string | void> {
    const bot = this.deps.config.bot!;
    const tokens = (msg.text ?? '').trim().split(/\s+/).filter((t) => t !== '');
    const command = (tokens[0] ?? '').toLowerCase();
    const rest = tokens.slice(1);

    // whoami 必须在权限检查之前 —— 否则配白名单时拿不到 ID（主仓的经验）
    if (command === 'whoami') {
      return [
        `平台: ${msg.platform}`,
        `staffId: ${msg.senderId}`,
        `conversationId: ${msg.conversationId}`,
        `nick: ${msg.senderNick}`,
      ].join('\n');
    }

    if (bot.allowedConversationIds.length > 0 && !bot.allowedConversationIds.includes(msg.conversationId)) {
      this.deps.logger.warn('[router] 群未授权', { conversationId: msg.conversationId });
      return '该群未授权（发 whoami 取 conversationId，让管理员加到 bot.allowedConversationIds）';
    }
    if (bot.allowedStaffIds.length > 0 && !bot.allowedStaffIds.includes(msg.senderId)) {
      this.deps.logger.warn('[router] 无权限', { senderId: msg.senderId, nick: msg.senderNick });
      return '无权限操作，请联系管理员';
    }

    switch (command) {
      case 'h':
      case 'help':
        return buildHelpText(this.registry);
      case 'status':
        return buildStatusText(this.deps.config, { now: this.now(), rootDir: this.deps.config.rootDir });
      case 'sync':
        return this.handleSync(msg, rest);
      case 'a':
      case 'analyze': {
        const parsed = parseAnalyzeCommand(rest, (n) => this.registry.get(n));
        if (!parsed.name) return `用法: analyze <名字> …\n\n${this.registry.helpText()}`;
        return this.runNamed(parsed.name, parsed.params, msg);
      }
      case 'hc':
      case 'health':
        // ⚠️ 快捷指令用 parseAnalysisParams（不消耗"名字"位）：否则第一个参数被当成分析器名吃掉，
        //    实例/币种过滤静默失效（M3 review 的 Critical）
        return this.runNamed('health', parseAnalysisParams(rest, positionalNamesOf(this.registry.get('health'))), msg);
      case 'r':
      case 'rounds':
        return this.runNamed('rounds', parseAnalysisParams(rest, positionalNamesOf(this.registry.get('rounds'))), msg);
      case 'sk':
      case 'stuck':
        return this.runNamed('stuck', parseAnalysisParams(rest, positionalNamesOf(this.registry.get('stuck'))), msg);
      case 'e':
      case 'errors':
        return this.runNamed('errors', parseAnalysisParams(rest, positionalNamesOf(this.registry.get('errors'))), msg);
      case 'st':
      case 'stream':
        return this.runNamed('stream', parseAnalysisParams(rest, positionalNamesOf(this.registry.get('stream'))), msg);
      case 'tu':
      case 'topup':
        return this.runNamed('topup', parseAnalysisParams(rest, positionalNamesOf(this.registry.get('topup'))), msg);
      default:
        if (command === '') return buildHelpText(this.registry);
        return `未知指令: ${command}（发 h 看指令列表）`;
    }
  }

  private async handleSync(msg: IncomingMessage, rest: string[]): Promise<string> {
    const bot = this.deps.config.bot!;
    if (bot.adminStaffIds.length > 0 && !bot.adminStaffIds.includes(msg.senderId)) {
      return '只有管理员能触发同步（发 whoami 取 staffId，让管理员加到 bot.adminStaffIds）';
    }
    const force = rest.includes('--force');
    try {
      const fn = this.deps.runSyncFn
        ?? ((opts: { force: boolean }) => runSync({ store: buildStore(this.deps.config), config: this.deps.config, logger: this.deps.logger.child('sync') }, opts));
      const r = await fn({ force });
      if (r.refusedByLock) return '已有同步在进行（可能是常驻进程），稍后再试';
      return `同步完成：列举 ${r.listed} / 拉取 ${r.pulled.length} / 跳过 ${r.skipped} / 忽略 ${r.ignored} / 失败 ${r.failed.length} / 退避 ${r.deferred.length}，共 ${formatBytes(r.bytes)}`;
    } catch (err) {
      return `同步失败：${errorText(err)}`;
    }
  }

  private async runNamed(name: string, params: Record<string, string>, msg: IncomingMessage): Promise<string> {
    const key = msg.conversationId || msg.senderId;
    if (this.inflight.has(key)) return '上一个任务还在跑，稍后再试';

    const maxConcurrent = this.deps.maxConcurrentAnalyses ?? DEFAULT_MAX_CONCURRENT_ANALYSES;
    if (this.running >= maxConcurrent) {
      return `当前有 ${this.running} 个分析在跑（并发上限 ${maxConcurrent}，这台机器还要让着实盘），稍后再试`;
    }
    this.inflight.add(key);
    this.running++;

    const webhook = (msg as DingTalkIncomingMessage).sessionWebhook ?? '';
    const budget = this.deps.syncReplyBudgetMs ?? DEFAULT_SYNC_REPLY_BUDGET_MS;
    const canFollowUp = budget > 0 && webhook !== '' && typeof this.deps.reply === 'function';
    let keepGate = false;
    const release = (): void => {
      this.inflight.delete(key);
      this.running = Math.max(0, this.running - 1);
    };

    const work = runAnalysis({
      config: this.deps.config,
      name,
      params,
      now: this.now(),
      registry: this.registry,
    });

    try {
      if (canFollowUp) {
        const outcome = await Promise.race([
          work.then((out) => ({ kind: 'done' as const, out })),
          delay(budget).then(() => ({ kind: 'slow' as const })),
        ]);
        if (outcome.kind === 'slow') {
          keepGate = true;
          // 闸门在**分析结束那一刻**就释放（不等网络发送）：闸门是防 CPU 打满的，
          // 回复发送失败不该让这个会话卡住
          void work
            .then(async (out) => {
              release();
              await this.safeFollowUp(webhook, out);
            })
            .catch(async (err) => {
              release();
              await this.safeFollowUp(webhook, null, err);
            });
          return `⏳ 正在分析 ${name}（${params.window ?? '昨天'}）…结果稍后单独发`;
        }
        return this.format(outcome.out);
      }
      return this.format(await work);
    } catch (err) {
      return formatAnalysisError(err, name, this.registry);
    } finally {
      if (!keepGate) release();
    }
  }

  /** 结果文本；被截断时把完整报告落盘并附上路径（M5 再考虑传 OSS 换签名 URL） */
  private format(out: RunAnalysisOutput): string {
    let text = out.rendered.text;
    if (out.rendered.truncated) {
      const file = this.saveFullReport(out);
      text += file ? `\n\n（完整报告已落盘：${file}）` : '\n\n（完整报告落盘失败，见日志）';
    }
    this.deps.logger.info('[router] 分析完成', { analysis: out.analysis.name, ms: out.elapsedMs, warnings: out.result.warnings.length });
    return text;
  }

  /** 二次回复：任何失败都自己吞掉并记日志（否则会漏出未捕获拒绝，而用户以为结果还在路上） */
  private async safeFollowUp(webhook: string, out: RunAnalysisOutput | null, err?: unknown): Promise<void> {
    try {
      const text = out ? this.format(out) : formatAnalysisError(err, '分析', this.registry);
      await this.deps.reply!(webhook, text);
    } catch (e) {
      this.deps.logger.error('[router] 二次回复失败（结果只在日志里）', { detail: errorText(e) });
    }
  }

  private saveFullReport(out: RunAnalysisOutput): string | null {
    try {
      const dir = path.join(this.deps.config.runtime.logDir, 'reports');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${out.analysis.name}-${out.window.label.replace(/[^\w~-]/g, '_')}.md`);
      // ⚠️ 落盘的必须是**完整报告**：`out.rendered.text` 是按群消息预算截断过的
      // （早期实现直接写它 ⇒ 落盘文件和群里看到的一样缺，等于白存）
      const full = renderResult(out.result, { maxChars: FULL_REPORT_MAX_CHARS });
      fs.writeFileSync(file, full.text + '\n', 'utf8');
      return path.relative(this.deps.config.rootDir, file);
    } catch (err) {
      this.deps.logger.error('[router] 完整报告落盘失败', { detail: errorText(err) });
      return null;
    }
  }
}

/** 把各类错误变成"群里能看懂"的一句话（未知分析器额外附上可用清单） */
export function formatAnalysisError(err: unknown, name: string, registry: AnalysisRegistry): string {
  if (err instanceof AnalysisRunError) {
    if (err.kind === 'unknown-analysis') return `${err.message}\n\n${registry.helpText()}`;
    return err.message;
  }
  if (err instanceof WindowParseError || err instanceof WindowTooLongError) return err.message;
  return `分析 ${name} 失败：${errorText(err)}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 延时（unref：不拖住进程退出；测试里也不会挂住） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
