/**
 * 脱敏单测（`src/common/redact.ts`）
 * 这条铁律值一个专门的测试文件：AGENTS.md「绝不打印凭据」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactForLog, logSafeJson, redactText, REDACTED } = require('../../../dist/common/redact');

test('redactForLog：命中敏感键名一律替换（大小写/下划线/连字符都认）', () => {
  const out = redactForLog({
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    accessKeyId: 'LTAI5tabcdefg',
    accessKeySecret: 'secret-value',
    appSecret: 'app-secret',
    security_token: 'tok',
    'x-oss-signature': 'sig',
    privateKey: 'pem',
    nested: { password: 'p', keep: 'visible' },
  });
  assert.equal(out.accessKeyId, REDACTED);
  assert.equal(out.accessKeySecret, REDACTED);
  assert.equal(out.appSecret, REDACTED);
  assert.equal(out.security_token, REDACTED);
  assert.equal(out['x-oss-signature'], REDACTED);
  assert.equal(out.privateKey, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.equal(out.nested.keep, 'visible');
  assert.equal(out.endpoint, 'oss-cn-hongkong.aliyuncs.com', '非敏感键必须原样保留');
});

test('redactForLog：**不能脱敏过度**（`skipped`/`tasks` 这类含 sk/ak 子串的正常字段要保留）', () => {
  const out = redactForLog({ skipped: 3, tasks: 12, skew: 0.1, mask: 'x', risk: 1, keyField: 'v' });
  assert.equal(out.skipped, 3, 'skipped 被打码 = 把正常数据藏起来（实测踩过）');
  assert.equal(out.tasks, 12);
  assert.equal(out.skew, 0.1);
  assert.equal(out.mask, 'x');
  assert.equal(out.risk, 1);
  assert.equal(out.keyField, 'v');

  // 但短缩写作为独立段出现时仍必须打码
  const secret = redactForLog({ sk: 'abc', ak: 'def', 'x-oss-sign': 'sig' });
  assert.equal(secret.sk, REDACTED);
  assert.equal(secret.ak, REDACTED);
  assert.equal(secret['x-oss-sign'], REDACTED);
});

test('redactForLog：空值保持原样（便于区分"没配"与"配了但被打码"）', () => {
  const out = redactForLog({ accessKeyId: '', accessKeySecret: null });
  assert.equal(out.accessKeyId, '', '空串不该变成 REDACTED');
  assert.equal(out.accessKeySecret, null);
});

test('redactForLog：数组与深层结构也覆盖，且深度上限防环', () => {
  const out = redactForLog({ list: [{ token: 'a' }, { safe: 1 }] });
  assert.equal(out.list[0].token, REDACTED);
  assert.equal(out.list[1].safe, 1);

  let deep = { v: 0 };
  for (let i = 0; i < 20; i++) deep = { child: deep };
  assert.doesNotThrow(() => redactForLog(deep));
});

test('logSafeJson：序列化失败不抛（日志本身绝不能把主流程带崩）', () => {
  // BigInt 会让 JSON.stringify 抛 "Do not know how to serialize a BigInt"
  const text = logSafeJson({ count: 1n });
  assert.match(text, /unserializable/);
});

test('redactForLog：循环引用被深度上限截断（不抛、不死循环、能序列化）', () => {
  const circular = {};
  circular.self = circular;
  let out;
  assert.doesNotThrow(() => {
    out = redactForLog(circular);
  });
  assert.doesNotThrow(() => JSON.stringify(out), '截断后必须可序列化');
  assert.match(logSafeJson(circular), /MAX_DEPTH/);
});

test('redactText：URL 签名参数与 AK 形态被抹掉（第三方 stderr 进日志前过一遍）', () => {
  const raw = 'GET https://b.oss-cn-hongkong.aliyuncs.com/x?OSSAccessKeyId=LTAI5tabc123&Signature=abc%2Fdef&Expires=123 failed; key LTAI5tZZZZZZZZ9';
  const out = redactText(raw);
  assert.ok(!out.includes('LTAI5tabc123'), 'AK 明文必须消失');
  assert.ok(!out.includes('abc%2Fdef'), '签名必须消失');
  assert.match(out, /OSSAccessKeyId=\*\*\*REDACTED\*\*\*/);
  assert.match(out, /LTAI\*\*\*REDACTED\*\*\*/);
});
