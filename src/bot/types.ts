/**
 * 聊天机器人平台无关契约。
 *
 * 来源：主仓 `dream_develop/src/bot/types.ts`（2026-10-02 拷贝）。
 * 改动：只保留钉钉需要的部分（`LARK_DOMAIN` 等飞书专用常量先不放进来 —— 加飞书时连 `lark-bot.ts` 一起拷，
 * 免得留一堆没人用的常量在这里漂移）。
 */

export const BOT_PLATFORM = {
  DINGTALK: 'dingtalk',
} as const;

export type BotPlatform = (typeof BOT_PLATFORM)[keyof typeof BOT_PLATFORM];

/** 平台无关的入站消息（各平台实现负责归一化成本结构） */
export interface IncomingMessage {
  /** 已剥离 @机器人 占位符的指令文本 */
  text: string;
  /** 发送者唯一标识：钉钉 = staffId */
  senderId: string;
  senderNick: string;
  /** 会话唯一标识：钉钉 = conversationId（群白名单与主动推送目标） */
  conversationId: string;
  conversationType: string;
  platform: BotPlatform;
}

/**
 * 处理入站消息，返回要回复给群里的文本（空/undefined = 不回复）。
 * 调用方负责"不让这段逻辑阻塞平台的事件 ack"。
 */
export type MessageHandler = (msg: IncomingMessage) => Promise<string | void>;

/** 应用机器人统一接口（将来加飞书 = 再加一个实现，指令层一行不改） */
export interface IChatBot {
  readonly platform: BotPlatform;
  /** 建立接收通道（长连接）。失败只记日志，绝不抛出影响主流程 */
  start(): Promise<void>;
  setHandler(handler: MessageHandler): void;
  /** 主动推送群消息；返回 false 由调用方决定是否回落 webhook */
  sendGroupMessage(conversationId: string, content: string): Promise<boolean>;
  /** 进程退出时断开长连接（部分 SDK 的定时器不 unref，不显式关闭会拖住进程退出） */
  close?(): void;
}
