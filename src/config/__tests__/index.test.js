/**
 * 配置校验单测（`src/config/index.ts`）
 * 重点：① 一次报出全部问题 ② 错误信息里**不出现值**（防凭据泄漏） ③ 缺省值只在安全处给
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseConfig, ConfigError } = require('../../../dist/config/index');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function base(over = {}) {
  return {
    name: 'analysis',
    oss: {
      provider: 'ossutil',
      binary: 'ossutil',
      endpoint: 'oss-cn-hongkong.aliyuncs.com',
      bucket: 'dream-ana',
      prefix: 'snapshot/',
      configFile: '',
    },
    sync: {},
    ...over,
  };
}

test('最小合法配置：缺省值都落在安全处，且目录解析成绝对路径', () => {
  const { config } = parseConfig(base(), { rootDir: ROOT });
  assert.equal(config.name, 'analysis');
  assert.equal(config.sync.intervalMinutes, 60);
  assert.equal(config.sync.minAgeSeconds, 60);
  assert.equal(config.sync.countIncludesHeader, false);
  assert.equal(config.sync.concurrency, 1);
  assert.equal(config.process.nice, 10);
  assert.ok(path.isAbsolute(config.runtime.dataDir));
  assert.equal(path.relative(ROOT, config.runtime.dataDir), 'data');
  assert.equal(config.bot, null, 'bot 没填 = 不配置（M1/M2 不需要）');
});

test('缺必填字段时一次报出全部问题', () => {
  let err;
  try {
    parseConfig({ name: '', oss: { bucket: 'X', prefix: 'bad prefix' }, sync: { intervalMinutes: 0 } }, { rootDir: ROOT });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigError);
  const text = err.problems.join('\n');
  assert.match(text, /name/);
  assert.match(text, /oss\.binary/);
  assert.match(text, /oss\.endpoint/);
  assert.match(text, /oss\.bucket/);
  assert.match(text, /oss\.prefix/);
  assert.match(text, /intervalMinutes/);
  assert.ok(err.problems.length >= 6, '应该一次全报出来，实际 ' + err.problems.length);
});

test('错误信息里绝不回显值（把"值"塞进密钥字段也不会泄漏）', () => {
  let err;
  try {
    parseConfig({ name: 'analysis', oss: { binary: 'ossutil', endpoint: 'LTAI_SUPER_SECRET_AK', bucket: 'dream-ana', prefix: 'snapshot/' } }, { rootDir: ROOT });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigError);
  assert.ok(!err.message.includes('LTAI_SUPER_SECRET_AK'), '错误信息里出现了疑似凭据的值：' + err.message);
});

test('bucket 名走 OSS 规则（大写/下划线一律拒绝）', () => {
  assert.throws(() => parseConfig(base({ oss: { ...base().oss, bucket: 'Dream-Ana' } }), { rootDir: ROOT }), /bucket/);
  assert.throws(() => parseConfig(base({ oss: { ...base().oss, bucket: 'dream_ana' } }), { rootDir: ROOT }), /bucket/);
});

test('内网 endpoint 只告警不拦（同区机器合法用法）', () => {
  const { config, warnings } = parseConfig(base({ oss: { ...base().oss, endpoint: 'oss-cn-hongkong-internal.aliyuncs.com' } }), { rootDir: ROOT });
  assert.equal(config.oss.endpoint, 'oss-cn-hongkong-internal.aliyuncs.com');
  assert.ok(warnings.some((w) => w.includes('内网域名')));
});

test('intervalMinutes 太小 → 告警（当天分片会被反复全量重下）；非法区间 → 报错', () => {
  const tooFrequent = parseConfig(base({ sync: { intervalMinutes: 10 } }), { rootDir: ROOT });
  assert.ok(tooFrequent.warnings.some((w) => w.includes('反复全量重下')));
  assert.throws(() => parseConfig(base({ sync: { intervalMinutes: 0 } }), { rootDir: ROOT }), /intervalMinutes/);
  assert.throws(() => parseConfig(base({ sync: { concurrency: 4, maxDiskGB: 0 } }), { rootDir: ROOT }), /maxDiskGB/);
});

test('bot：全空 = 不配置；填一半 = 报错；填全 = 生效且空白名单给告警', () => {
  assert.equal(parseConfig(base({ bot: { type: 'dingtalk', appId: '', appSecret: '', allowedStaffIds: [], adminStaffIds: [], notify: { warn: '' } } }), { rootDir: ROOT }).config.bot, null);

  assert.throws(
    () => parseConfig(base({ bot: { type: 'dingtalk', appId: 'ding-abc', appSecret: '', allowedStaffIds: [] } }), { rootDir: ROOT }),
    /bot\.appSecret/,
  );

  const filled = parseConfig(base({ bot: { type: 'dingtalk', appId: 'ding-abc', appSecret: 's3cr3t-value', allowedStaffIds: [], adminStaffIds: ['u1'], notify: { warn: 'cid' } } }), { rootDir: ROOT });
  assert.equal(filled.config.bot.type, 'dingtalk');
  assert.equal(filled.config.bot.adminStaffIds[0], 'u1');
  assert.ok(filled.warnings.some((w) => w.includes('群内')));
});

test('prefix：写 snapshot 或 snapshot/ 都接受（自动补斜杠并留 warning）', () => {
  const noSlash = parseConfig(base({ oss: { ...base().oss, prefix: 'snapshot' } }), { rootDir: ROOT });
  assert.equal(noSlash.config.oss.prefix, 'snapshot/', '两个仓的配置写法必须互通');
  assert.ok(noSlash.warnings.some((w) => w.includes('自动按目录前缀处理')));

  const withSlash = parseConfig(base(), { rootDir: ROOT });
  assert.equal(withSlash.config.oss.prefix, 'snapshot/');
  assert.equal(withSlash.warnings.filter((w) => w.includes('自动按目录前缀')).length, 0, '写法正确时不该有噪音');

  assert.throws(() => parseConfig(base({ oss: { ...base().oss, prefix: 'snap shot/' } }), { rootDir: ROOT }), /prefix/);
});

test('凭据：可以像上传侧那样直接写在 env.json，但必须成对', () => {
  const both = parseConfig(base({ oss: { ...base().oss, accessKeyId: 'LTAI-fake-id', accessKeySecret: 'fake-secret' } }), { rootDir: ROOT });
  assert.equal(both.config.oss.accessKeyId, 'LTAI-fake-id');
  assert.equal(both.config.oss.accessKeySecret, 'fake-secret');

  assert.throws(
    () => parseConfig(base({ oss: { ...base().oss, accessKeyId: 'LTAI-fake-id' } }), { rootDir: ROOT }),
    /必须同时提供/,
  );
  assert.throws(
    () => parseConfig(base({ oss: { ...base().oss, accessKeySecret: 'fake-secret' } }), { rootDir: ROOT }),
    /必须同时提供/,
  );

  const none = parseConfig(base(), { rootDir: ROOT });
  assert.equal(none.config.oss.accessKeyId, '', '不填凭据 = 走 ossutil 自己的配置文件');
});

test('bot.allowedStaffIds 里有非字符串 → 报错（不许静默丢弃）', () => {
  assert.throws(
    () => parseConfig(base({ bot: { type: 'dingtalk', appId: 'a', appSecret: 'b', allowedStaffIds: ['ok', 42], adminStaffIds: [] } }), { rootDir: ROOT }),
    /allowedStaffIds/,
  );
});

test('根节点不是对象 / provider 不支持 → 报错', () => {
  assert.throws(() => parseConfig([], { rootDir: ROOT }), /根节点/);
  assert.throws(() => parseConfig(base({ oss: { ...base().oss, provider: 'ali-oss' } }), { rootDir: ROOT }), /provider/);
});
