/**
 * 指令路由 —— LP 产品化后的极简版。
 *
 * 机器人只保留三个 LP -facing 能力：
 *   1. 定时报告：LP 日报（每天北京时间 dailyHour）+ 异常实时通知 —— 由 lpReporter 负责，不在本文件
 *   2. 随时报告：群里发 `r`（@机器人），立即渲染一份 LP 视角的账户报告
 *   3. 挂单详情：群里发 `g`，看当前持仓的卖单价 / 预计收益 / 距离成交还差多少（缓解卡单焦虑）
 *
 * 取舍记录（相比 M1 的分析器路由）：
 * - 删掉 status / sync / analyze / health / rounds / stuck / errors / stream / topup 全套技术指令：
 *   LP 看不懂也不需要；维护者用 SSH + CLI（analyze/lp/status 都在）。
 * - `r` 的输出 = renderDaily 同一份 LP 日报格式（LP 熟悉的版式，不出现策略术语）。
 * - 群 → 账户的绑定走 lp.accounts[].conversationId（LP 日报本来就配了这个），不引入第二份映射。
 * - whoami 也删了：群 ID 配置是一次性的，已由管理员完成；以后要用走 SSH + CLI。
 * - 权限检查（allowedConversationIds / allowedStaffIds）保留：配了白名单就生效，不配不限制。
 */
import { AppConfig } from '../config';
import { ILogger } from '../common/logger';
import { EventSourceLike } from '../analysis/types';
import { LocalEventSource } from '../store/eventSource';
import { loadState } from '../sync/state';
import { statePathOf } from '../sync/puller';
import { collectFacts, renderDaily, renderOpenOrders } from '../lp/lpReporter';
import { IncomingMessage } from './types';

export const REPORT_HINT = '发 r 看账户报告，发 g 看挂单详情 📊';

export interface RouterDeps {
  config: AppConfig;
  logger: ILogger;
  /** 注入事件源（测试用；默认本地分片 + 同步水位线） */
  source?: EventSourceLike;
  now?: () => Date;
}

export class CommandRouter {
  private now: () => Date;
  private source: EventSourceLike | null;

  constructor(private readonly deps: RouterDeps) {
    if (!deps.config.bot) throw new Error('未配置 bot（config.bot 为空时不该创建 router）');
    this.now = deps.now ?? (() => new Date());
    this.source = deps.source ?? null;
  }

  private buildSource(): EventSourceLike {
    if (this.source) return this.source;
    const { config } = this.deps;
    const { state } = loadState(statePathOf(config));
    this.source = new LocalEventSource({
      dataDir: config.runtime.dataDir,
      prefix: config.oss.prefix,
      state,
      countIncludesHeader: config.sync.countIncludesHeader,
    });
    return this.source;
  }

  async handle(msg: IncomingMessage): Promise<string> {
    const bot = this.deps.config.bot!;
    const tokens = (msg.text ?? '').trim().split(/\s+/).filter((t) => t !== '');
    const command = (tokens[0] ?? '').toLowerCase();

    if (bot.allowedConversationIds.length > 0 && !bot.allowedConversationIds.includes(msg.conversationId)) {
      this.deps.logger.warn('[router] 群未授权', { conversationId: msg.conversationId });
      return '该群未授权，请联系管理员';
    }
    if (bot.allowedStaffIds.length > 0 && !bot.allowedStaffIds.includes(msg.senderId)) {
      this.deps.logger.warn('[router] 无权限', { senderId: msg.senderId, nick: msg.senderNick });
      return '无权限操作，请联系管理员';
    }

    if (command === 'r' || command === 'rounds' || command === '报告') {
      return this.handleReport(msg);
    }
    if (command === 'g' || command === 'orders' || command === '挂单') {
      return this.handleOrders(msg);
    }
    return REPORT_HINT;
  }

  /** 随时报告：按群找绑定的 LP 账户，渲染一份 LP 日报同款的实时版 */
  private async handleReport(msg: IncomingMessage): Promise<string> {
    const account = this.deps.config.lp?.accounts.find(
      (a) => a.conversationId !== '' && a.conversationId === msg.conversationId,
    );
    if (!account) {
      this.deps.logger.warn('[router] 该群未绑定 LP 账户', { conversationId: msg.conversationId });
      return '该群还没绑定账户，请联系管理员配置';
    }
    try {
      const facts = await collectFacts(this.buildSource(), account, this.now());
      if (facts.days.length === 0) return '还没有数据，等第一次同步完成后再试';
      return renderDaily(facts, account, this.now());
    } catch (err) {
      this.deps.logger.error('[router] 随时报告失败', { detail: err instanceof Error ? err.message : String(err) });
      return '报告生成失败，请稍后再试';
    }
  }

  /** 挂单详情：LP 焦虑时的"望远镜"——卖单价 / 预计收益 / 还差多少成交 */
  private async handleOrders(msg: IncomingMessage): Promise<string> {
    const account = this.deps.config.lp?.accounts.find(
      (a) => a.conversationId !== '' && a.conversationId === msg.conversationId,
    );
    if (!account) {
      this.deps.logger.warn('[router] 该群未绑定 LP 账户', { conversationId: msg.conversationId });
      return '该群还没绑定账户，请联系管理员配置';
    }
    try {
      const facts = await collectFacts(this.buildSource(), account, this.now());
      if (facts.days.length === 0) return '还没有数据，等第一次同步完成后再试';
      return renderOpenOrders(facts, account, this.now());
    } catch (err) {
      this.deps.logger.error('[router] 挂单详情失败', { detail: err instanceof Error ? err.message : String(err) });
      return '挂单详情生成失败，请稍后再试';
    }
  }
}
