/**
 * ossutil 实现单测（`src/oss/ossutilStore.ts`）
 * 解析用的是**真机实测输出**（2026-10-02 在 dream-002 上跑出来的原样文本），
 * 不是自己编的样例 —— 否则测的是"我以为的格式"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLsOutput, parseOssTime, OssutilStore } = require('../../../dist/oss/ossutilStore');
const { ObjectStoreError } = require('../../../dist/oss/store');

/** 真机输出原样（含表头 / 对象行 / 结尾统计行） */
const REAL_LS_OUTPUT = [
  'LastModifiedTime                   Size(B)  StorageClass   ETAG                                  ObjectName',
  '2026-10-02 20:10:49 +0800 CST           63      Standard   FA1765809EB3C61C5C198B86917E2217      oss://dream-ana/snapshot/.keep',
  '2026-10-02 19:27:31 +0800 CST            2      Standard   60B725F10C9C85C70D97880DFE8191B3      oss://dream-ana/snapshot/_clsdir/a.ndjson',
  '2026-10-02 18:02:43 +0800 CST            0            IA   D41D8CD98F00B204E9800998ECF8427E      oss://dream-ana/snapshoot/',
  'Object Number is: 3',
  '',
].join('\n');

test('parseLsOutput：真机输出解析出 3 个对象，键剥掉 oss://bucket/ 前缀', () => {
  const { objects, unparsed } = parseLsOutput(REAL_LS_OUTPUT);
  assert.equal(unparsed.length, 0, '真机输出不该有无法解析的行');
  assert.equal(objects.length, 3);
  assert.deepEqual(objects.map((o) => o.key), ['snapshot/.keep', 'snapshot/_clsdir/a.ndjson', 'snapshoot/']);
  assert.equal(objects[0].size, 63);
  assert.equal(objects[0].etag, 'FA1765809EB3C61C5C198B86917E2217');
  assert.equal(objects[2].size, 0, '0 字节对象也要能解析');
});

test('parseOssTime：按 +0800 解释（不能用本机时区硬套）', () => {
  assert.equal(parseOssTime('2026-10-02 20:10:49 +0800 CST'), Date.parse('2026-10-02T12:10:49.000Z'));
  assert.equal(parseOssTime('2026-10-02 20:10:49 -0500 EST'), Date.parse('2026-10-03T01:10:49.000Z'));
  assert.equal(parseOssTime('2026-10-02 20:10:49'), Date.parse('2026-10-02T20:10:49.000Z'), '无时区按 UTC');
  assert.equal(parseOssTime('不是时间'), null);
});

test('parseLsOutput：列数不足的行进 unparsed（宁可报错也不猜）', () => {
  const out = ['oss://dream-ana/snapshot/x.jsonl.gz'].join('\n');
  const parsed = parseLsOutput(out);
  assert.equal(parsed.objects.length, 0);
  assert.equal(parsed.unparsed.length, 1);
});

test('list()：把 endpoint/配置文件显式传给 ossutil；成功返回对象', async () => {
  const calls = [];
  const store = new OssutilStore({
    binary: 'ossutil',
    endpoint: 'oss-cn-hongkong-internal.aliyuncs.com',
    bucket: 'dream-ana',
    configFile: '/root/.ossutilconfig',
    exec: async (file, args) => {
      calls.push({ file, args });
      return { stdout: REAL_LS_OUTPUT, stderr: '', code: 0 };
    },
  });
  const objects = await store.list('snapshot/');
  assert.equal(objects.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'ossutil');
  assert.equal(calls[0].args[0], 'ls');
  assert.equal(calls[0].args[1], 'oss://dream-ana/snapshot/');
  assert.ok(calls[0].args.includes('-e') && calls[0].args.includes('oss-cn-hongkong-internal.aliyuncs.com'), 'endpoint 必须显式传');
  assert.ok(calls[0].args.includes('-c') && calls[0].args.includes('/root/.ossutilconfig'));
});

test('list() 失败：抛 ObjectStoreError，且 stderr 里的疑似凭据被脱敏', async () => {
  const store = new OssutilStore({
    binary: 'ossutil',
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    bucket: 'dream-ana',
    exec: async () => ({ stdout: '', stderr: 'Error: AccessDenied for LTAI5tREALLOOKINGSECRET', code: 1 }),
  });
  let err;
  try {
    await store.list('snapshot/');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ObjectStoreError);
  assert.equal(err.kind, 'list');
  assert.ok(!err.detail.includes('LTAI5tREALLOOKINGSECRET'), 'stderr 里的 AK 必须被脱敏：' + err.detail);
  assert.match(err.detail, /LTAI\*\*\*REDACTED\*\*\*/);
});

test('list() 输出无法解析的行 → 抛错（ossutil 版本变了要立刻发现）', async () => {
  const store = new OssutilStore({
    binary: 'ossutil',
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    bucket: 'dream-ana',
    exec: async () => ({ stdout: 'oss://dream-ana/x\n', stderr: '', code: 0 }),
  });
  await assert.rejects(() => store.list('snapshot/'), /无法解析/);
});

test('getTo()：下载成功后再确认文件存在；文件没落地视为失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ossutil-get-'));
  const dest = path.join(dir, 'nested', 'out.jsonl.gz');
  const okStore = new OssutilStore({
    binary: 'ossutil',
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    bucket: 'dream-ana',
    exec: async (_file, args) => {
      assert.equal(args[0], 'cp');
      assert.equal(args[1], 'oss://dream-ana/snapshot/a/2026-10-02.jsonl.gz');
      assert.equal(args[2], dest);
      assert.ok(args.includes('-f'), '必须 -f 覆盖（幂等重拉靠它）');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'x');
      return { stdout: 'Succeed', stderr: '', code: 0 };
    },
  });
  await okStore.getTo('snapshot/a/2026-10-02.jsonl.gz', dest);
  assert.ok(fs.existsSync(dest));

  const liarStore = new OssutilStore({
    binary: 'ossutil',
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    bucket: 'dream-ana',
    exec: async () => ({ stdout: 'Succeed: OK num:1', stderr: '', code: 0 }),
  });
  await assert.rejects(() => liarStore.getTo('snapshot/a/2026-10-02.jsonl.gz', path.join(dir, 'missing.jsonl.gz')), /目标文件不存在/);
});

test('version()：可用来做 doctor 的第一次连通检查', async () => {
  const store = new OssutilStore({
    binary: 'ossutil',
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    bucket: 'dream-ana',
    exec: async () => ({ stdout: 'ossutil version: v1.7.19\n', stderr: '', code: 0 }),
  });
  assert.equal(await store.version(), 'ossutil version: v1.7.19');
});

test('无法执行二进制（ENOENT）→ ObjectStoreError，kind=config', async () => {
  const store = new OssutilStore({
    binary: 'definitely-not-here',
    endpoint: 'oss-cn-hongkong.aliyuncs.com',
    bucket: 'dream-ana',
    exec: async () => {
      throw new Error('spawn definitely-not-here ENOENT');
    },
  });
  let err;
  try {
    await store.version();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ObjectStoreError);
  assert.equal(err.kind, 'config');
});
