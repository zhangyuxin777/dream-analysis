/**
 * 钉钉客户端冒烟单测（`src/bot/dingtalk-bot.ts`，主仓拷贝+改造）
 * **不碰真网络**（除了最后一个用例连本机一个必然拒绝的端口，用来验"回复失败不抛"）。
 * 真连钉钉要凭据，只能在服务器上验 —— 这里只钉"fail-soft"这条底线。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DingTalkBot, businessError } = require('../../../dist/bot/dingtalk-bot');
const { createLogger } = require('../../../dist/common/logger');

function capture() {
  const lines = [];
  return { lines, logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }) };
}

test('凭据缺失：start() 只记 warn、不抛（机器人不该有停掉同步/分析的权力）', async () => {
  const { lines, logger } = capture();
  const bot = new DingTalkBot({ clientId: '', clientSecret: '', allowedStaffIds: [] }, logger);
  assert.equal(bot.platform, 'dingtalk');
  await assert.doesNotReject(() => bot.start());
  assert.ok(lines.some((l) => /clientId\/clientSecret 未配置/.test(l)), lines.join('\n'));
  assert.doesNotThrow(() => bot.close());
});

test('setHandler 可设置；handler 只在收到消息时才被调用（这里没有消息 ⇒ 不被调用）', () => {
  const { logger } = capture();
  const bot = new DingTalkBot({ clientId: 'a', clientSecret: 'b', allowedStaffIds: [] }, logger);
  let calls = 0;
  bot.setHandler(async () => {
    calls++;
    return 'ok';
  });
  assert.equal(calls, 0);
});

test('businessError：HTTP 200 但业务码非 0 也算失败（sessionWebhook 就是这种，判成功会让结果永久丢失）', () => {
  assert.equal(businessError({ errcode: 0, errmsg: 'ok' }), null);
  assert.match(businessError({ errcode: 300001, errmsg: 'invalid webhook' }), /errcode=300001/);
  assert.match(businessError({ errcode: '300001', errmsg: 'x' }), /errcode=300001/);
  assert.equal(businessError({ accessToken: 'x', expireIn: 7200 }), null, 'token 响应没有 errcode，不能误判为失败');
  assert.match(businessError({ code: 'Forbidden', message: 'denied' }), /code=Forbidden/);
  assert.equal(businessError({ code: 0 }), null);
  assert.equal(businessError(null), null);
  assert.equal(businessError('text'), null);
});

test('replyText：网络失败只记 error、不抛（回复失败不能把进程带崩）', async () => {
  const { lines, logger } = capture();
  const bot = new DingTalkBot({ clientId: 'a', clientSecret: 'b', allowedStaffIds: [] }, logger);
  await assert.doesNotReject(() => bot.replyText('http://127.0.0.1:1/hook', 'hi'));
  assert.ok(lines.some((l) => /回复失败/.test(l)), lines.join('\n'));
});
