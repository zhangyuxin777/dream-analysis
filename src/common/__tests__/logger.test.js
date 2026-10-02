/**
 * 日志器单测（`src/common/logger.ts`）
 * 重点：级别过滤、scope 组合、**上下文脱敏**（凭据绝不落日志）、文件写失败不炸。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../../../dist/common/logger');

function collect() {
  const lines = [];
  return { lines, sink: (line) => lines.push(line) };
}

test('级别过滤：info 级别下 debug 不输出，warn/error 照常', () => {
  const { lines, sink } = collect();
  const logger = createLogger({ level: 'info', sink, now: () => new Date('2026-10-02T12:00:00.000Z') });
  logger.debug('不该出现');
  logger.info('普通');
  logger.warn('警告');
  logger.error('错误');
  assert.equal(lines.length, 3);
  assert.ok(!lines.join('\n').includes('不该出现'));
  assert.match(lines[0], /^2026-10-02T12:00:00\.000Z \[INFO\] 普通$/);
  assert.match(lines[1], /\[WARN\] 警告/);
  assert.match(lines[2], /\[ERROR\] 错误/);
});

test('debug 级别下全输出；scope 可组合（父:子）', () => {
  const { lines, sink } = collect();
  const logger = createLogger({ level: 'debug', sink }).child('sync').child('puller');
  logger.debug('细节');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[DEBUG\] \[sync:puller\] 细节/);
});

test('上下文脱敏：凭据字段绝不进日志（AGENTS.md 铁律）', () => {
  const { lines, sink } = collect();
  const logger = createLogger({ level: 'info', sink });
  logger.info('配置', { endpoint: 'oss-cn-hongkong.aliyuncs.com', accessKeySecret: 'SUPER-SECRET-VALUE', nested: { appSecret: 'X' } });
  const text = lines.join('\n');
  assert.ok(!text.includes('SUPER-SECRET-VALUE'), 'secret 出现在日志里：' + text);
  assert.ok(!text.includes('"X"'));
  assert.match(text, /REDACTED/);
  assert.match(text, /oss-cn-hongkong\.aliyuncs\.com/, '非敏感字段要保留');
});

test('文件输出：追加写入且父目录自动创建；写失败不抛（磁盘满/权限不能带崩同步）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  const file = path.join(dir, 'nested', 'analysis.log');
  const logger = createLogger({ level: 'info', sink: () => undefined, filePath: file, now: () => new Date('2026-10-02T12:00:00.000Z') });
  logger.info('第一行');
  logger.info('第二行');
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content.trim().split('\n').length, 2);

  // 把 filePath 指向一个目录 ⇒ 写入必然失败，但绝不能抛
  const broken = createLogger({ level: 'info', sink: () => undefined, filePath: dir });
  assert.doesNotThrow(() => broken.info('写不进去也不该炸'));
});
