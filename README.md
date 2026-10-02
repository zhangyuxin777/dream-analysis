# dream-analysis

DREAM 交易实例的**运行数据分析服**：从 OSS 拉取每小时导出的 ndjson 天分片，做确定性分析，并通过机器人对话触发。

- 设计方案：[DESIGN.md](DESIGN.md)
- 项目规则：[AGENTS.md](AGENTS.md)

## 快速上手（本机）

```bash
npm install
cp env.json.example env.json     # 填 OSS 与（后续的）机器人配置；env.json 不进 git
npm run build
npm run doctor                   # 自检：配置 / OSS 连通 / 目录可写 / 数据新鲜度
npm run sync                     # 拉取一次
npm run status                   # 看拉到了什么、落后多久
```

> 本机开发用**公网** endpoint（`oss-cn-hongkong.aliyuncs.com`）；服务器上用**内网** endpoint（`oss-cn-hongkong-internal.aliyuncs.com`，免流量费）。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | `tsc` → `dist/` |
| `npm test` | 编译 + 全量测试 |
| `npm run test:only -- <子串>` | 不编译，按路径子串挑测试 |
| `npm run test:coverage` | 全量 + 覆盖率硬门槛（80/80/80） |
| `npm run doctor` | 自检五项 |
| `npm run sync` | 手动拉取（幂等：相同 ETag 跳过） |
| `npm run status` | 数据新鲜度 / 上次同步结果 / 磁盘占用 |

CLI 也支持细粒度参数：`node dist/bin/analysis.js sync --force`、`... list`、`... verify <key>`。

## 部署到 dream-002

```bash
# 1) 目录（与实盘目录彻底分开）
git clone git@github.com:zhangyuxin777/dream-analysis.git /root/dream_analysis
cd /root/dream_analysis && npm ci && npm run build

# 2) 配置（凭据只写在这台机器的 env.json，chmod 600）
cp env.json.example env.json && vi env.json
#    oss.endpoint = oss-cn-hongkong-internal.aliyuncs.com（内网）
#    oss.prefix   = snapshot/

# 3) 自检 + 起进程
node dist/bin/analysis.js doctor
pm2 start ecosystem.config.js && pm2 list && pm2 save
```

⚠️ **安全约束（务必遵守）**：这台机器上还跑着实盘。只允许操作 `dream-analysis` 这一个进程：
**绝不动 `grid-runner-*`、绝不 `pm2 restart all`**。进程自身会把 nice 调到 10（`env.json` 的 `process.nice`），
分析任务串行执行，`max_memory_restart` 512M，尽量不抢实盘的 CPU。

## 排障

| 现象 | 先看 |
|---|---|
| `doctor` 报 OSS 不通 | `oss.endpoint` 是不是内网域名用在了非阿里云机器上（本机要用公网域名） |
| 拉取全部跳过 | ETag 未变 = 数据没更新（正常）；要强制重扫用 `sync --force` |
| `sync` 报"已有同步在进行" | 常驻进程正在跑（跨进程锁 `runtime/sync.lock`）；等下一轮，或确认没有僵尸进程后删掉该文件 |
| 某天分片一直不拉、`status` 里有"失败退避中" | 同内容按 30min×2^n（上限 6h）退避；上传侧重算（ETag 变）会立刻重试；急着要就 `sync --force` |
| 行数不符告警 | 上传侧分片与 `header.count` 不一致 → 看 `logs/` 里的 MISMATCH 明细 |
| 结果标「暂定」 | 窗口里含 `final:false` 的当天数据（当天未封存，属正常） |
| 报告里出现「数据口径变更」 | 上传侧 `whitelistVersion` 变了 —— 跨这次变更的统计不可直接比较 |

## 开发约定

- 零运行时依赖；测试 `npm test`（node:test，113 个用例，~0.25s）。
- 覆盖率硬门槛：`npm run test:coverage`（Node 原生 `--test-coverage-*`，80/80/80，不达标 exit 1）。
- 加测试 = 在 `__tests__/` 新建 `*.test.js`，`package.json` 不用改（集合 = 磁盘发现）。
