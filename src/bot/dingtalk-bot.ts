/**
 * 钉钉应用机器人（长连接 Stream 模式）。
 *
 * 来源：主仓 `dream_develop/src/bot/dingtalk-bot.ts`（2026-10-02 拷贝）。
 * **改动点**（就这三处，其余结构与常量一字未动，便于以后对比同步）：
 *   1. HTTP 从 `got` 换成 Node 原生 `fetch`（本仓 Node ≥22）—— 少一个运行时依赖；
 *   2. logger 类型换成本仓的 `ILogger`（方法名一致：debug/info/warn/error）；
 *   3. 注释里补上"钉钉的 ack 由 SDK 负责，没有飞书那 3 秒硬限制"这一条事实。
 *
 * 保留的关键防护（都是踩过坑换来的）：
 *   - SDK 缺失/凭据缺失 ⇒ **只记日志不抛**（机器人不该有停掉主流程的权力）；
 *   - 启动重试 + 指数退避；
 *   - access_token 缓存 + 失败冷却（避免把令牌接口打挂）；
 *   - 主动推送连续失败 ⇒ 熔断 5 分钟，由调用方决定回落 webhook；
 *   - `replyText` 是 **public** 的：长任务的"二次回复"靠它（先回"正在分析"再补结果）。
 */
import { ILogger } from '../common/logger';
import { BOT_PLATFORM, IChatBot, IncomingMessage, MessageHandler } from './types';

let DWClient: any;
let EventAck: any;
let TOPIC_ROBOT: string;

try {
  const stream = require('dingtalk-stream');
  DWClient = stream.DWClient;
  EventAck = stream.EventAck;
  const constants = require('dingtalk-stream/constants');
  TOPIC_ROBOT = constants.TOPIC_ROBOT;
} catch {
  // SDK 未安装 —— bot 功能禁用（交易/同步照常）
}

const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const GROUP_MSG_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const TOKEN_COOLDOWN_MS = 60 * 1000;
const CIRCUIT_BREAK_THRESHOLD = 3;
const CIRCUIT_BREAK_RECOVER_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

export interface BotConfig {
  clientId: string;
  clientSecret: string;
  allowedStaffIds: string[];
}

/** 钉钉事件里的额外字段（不属于平台无关契约：sessionWebhook 是钉钉独有的回复通道） */
export interface DingTalkExtras {
  sessionWebhook: string;
  isAdmin: boolean;
  /** 兼容旧字段名 —— 与契约里的 senderId 同值（staffId） */
  senderStaffId: string;
}

export type DingTalkIncomingMessage = IncomingMessage & DingTalkExtras;

/** POST JSON（原生 fetch + 超时）；非 2xx 抛错，空响应体返回 null */
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  return text === '' ? null : JSON.parse(text);
}

export class DingTalkBot implements IChatBot {
  readonly platform = BOT_PLATFORM.DINGTALK;
  private config: BotConfig;
  private logger: ILogger;
  private client: any = null;
  private handler: MessageHandler | null = null;

  private accessToken = '';
  private tokenExpiresAt = 0;
  private tokenRefreshPromise: Promise<string> | null = null;
  private tokenCooldownUntil = 0;

  private sendFailCount = 0;
  private circuitOpenUntil = 0;

  constructor(config: BotConfig, logger: ILogger) {
    this.config = config;
    this.logger = logger;
  }

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  private static MAX_START_RETRIES = 3;

  async start(): Promise<void> {
    if (!DWClient) {
      this.logger.warn('[DingTalkBot] dingtalk-stream SDK 未安装，bot 功能禁用');
      return;
    }
    if (!this.config.clientId || !this.config.clientSecret) {
      this.logger.warn('[DingTalkBot] clientId/clientSecret 未配置，bot 功能禁用');
      return;
    }

    for (let attempt = 1; attempt <= DingTalkBot.MAX_START_RETRIES; attempt++) {
      try {
        this.client = new DWClient({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          keepAlive: true,
          debug: false,
        });

        this.client.registerCallbackListener(TOPIC_ROBOT, (msg: any) => {
          // 钉钉的 ack 由 SDK 负责（与飞书不同：那边要求 3 秒内处理完，否则重推）
          try {
            this._onMessage(msg);
          } catch (err) {
            this.logger.error(`[DingTalkBot] 消息处理异常: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.client.socketCallBackResponse(msg.headers?.messageId, { status: EventAck.SUCCESS });
        });

        await this.client.connect();
        this.logger.info('[DingTalkBot] Stream 连接成功');
        return;
      } catch (err) {
        this.logger.error(`[DingTalkBot] 启动失败(${attempt}/${DingTalkBot.MAX_START_RETRIES}): ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < DingTalkBot.MAX_START_RETRIES) {
          const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 30_000);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    this.logger.error('[DingTalkBot] 达到最大重试次数，bot 功能未启动（不影响同步与分析）');
  }

  // ============ token 管理 ============

  private _ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return Promise.resolve(this.accessToken);
    }
    if (Date.now() < this.tokenCooldownUntil) {
      return Promise.reject(new Error('token 刷新冷却中'));
    }
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }
    this.tokenRefreshPromise = this._refreshToken();
    return this.tokenRefreshPromise;
  }

  private async _refreshToken(): Promise<string> {
    try {
      const body: any = await postJson(TOKEN_URL, { appKey: this.config.clientId, appSecret: this.config.clientSecret });
      this.accessToken = body.accessToken;
      const expireIn = (body.expireIn || 7200) * 1000;
      this.tokenExpiresAt = Date.now() + expireIn - TOKEN_REFRESH_MARGIN_MS;
      this.tokenCooldownUntil = 0;
      this.logger.debug('[DingTalkBot] access_token 刷新成功');
      return this.accessToken;
    } catch (err) {
      this.tokenCooldownUntil = Date.now() + TOKEN_COOLDOWN_MS;
      this.logger.error(`[DingTalkBot] access_token 获取失败，${TOKEN_COOLDOWN_MS / 1000}s 内不再重试: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  // ============ 主动推送 ============

  async sendGroupMessage(openConversationId: string, content: string): Promise<boolean> {
    if (!openConversationId) return false;
    if (this.sendFailCount >= CIRCUIT_BREAK_THRESHOLD && Date.now() < this.circuitOpenUntil) {
      return false;
    }
    try {
      const token = await this._ensureToken();
      await postJson(
        GROUP_MSG_URL,
        {
          msgParam: JSON.stringify({ content }),
          msgKey: 'sampleText',
          openConversationId,
          robotCode: this.config.clientId,
        },
        { 'x-acs-dingtalk-access-token': token },
      );
      this.sendFailCount = 0;
      return true;
    } catch (err) {
      this.sendFailCount++;
      if (this.sendFailCount >= CIRCUIT_BREAK_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_BREAK_RECOVER_MS;
        this.logger.warn(`[DingTalkBot] 连续 ${this.sendFailCount} 次推送失败，熔断 ${CIRCUIT_BREAK_RECOVER_MS / 1000}s`);
      }
      this.logger.error(`[DingTalkBot] 群消息推送失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ============ 消息接收 ============

  private _onMessage(msg: any): void {
    if (msg.headers?.topic !== TOPIC_ROBOT) {
      return;
    }

    let data: any;
    try {
      data = JSON.parse(msg.data);
    } catch {
      this.logger.warn('[DingTalkBot] 消息 data 解析失败');
      return;
    }

    const incoming: DingTalkIncomingMessage = {
      text: (data.text?.content || '').trim(),
      senderId: data.senderStaffId || '',
      senderStaffId: data.senderStaffId || '',
      senderNick: data.senderNick || '',
      conversationId: data.conversationId || '',
      conversationType: data.conversationType || '',
      sessionWebhook: data.sessionWebhook || '',
      isAdmin: data.isAdmin || false,
      platform: this.platform,
    };

    if (!incoming.text || !incoming.sessionWebhook) {
      return;
    }

    this.logger.info(`[DingTalkBot] 收到消息: "${incoming.text}" from ${incoming.senderNick}(${incoming.senderStaffId})`);

    if (this.handler) {
      this.handler(incoming)
        .then((reply) => {
          if (reply) void this.replyText(incoming.sessionWebhook, reply);
        })
        .catch((err) => {
          this.logger.error(`[DingTalkBot] handler 异常: ${err instanceof Error ? err.message : String(err)}`);
          void this.replyText(incoming.sessionWebhook, '指令执行异常，请检查日志');
        });
    }
  }

  /** 回复某条消息（长任务的"二次回复"也走这里） */
  async replyText(webhook: string, content: string): Promise<void> {
    try {
      await postJson(webhook, { msgtype: 'text', text: { content } });
    } catch (err) {
      this.logger.error(`[DingTalkBot] 回复失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): void {
    try {
      this.client?.disconnect?.();
    } catch {
      // 关闭失败不影响退出
    }
  }
}
