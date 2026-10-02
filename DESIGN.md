# dream-analysis 设计方案

> 本文档是该项目的**唯一设计文档**（规则真源另见 `AGENTS.md`）。
> **v3（2026-10-02）**：定稿 —— 部署机 **`dream-002`**、机器人 **钉钉独立应用**、OSS 前缀 **`snapshot/`**（沿用现有严格策略，不动线上策略）。上传侧已按 §3.4 修正（offset 游标 / 轮转边界 / 连接类白名单 / header 细节）→ **M1 用真数据逐条核对**。
> **v2**：§三 按上传侧导出器方案（天分片 / gzip / 白名单 / final 两态）重写；v1 的「每小时不可变分片 + manifest」假设作废。

---

## 一、目标与边界

**一句话**：把上传侧每小时导出的**关键 NDJSON 天分片**拉到分析侧，做成一组**确定性分析器**，并挂一个**应用机器人**，让人在群里用对话触发分析、拿到结果。

### 做

- **拉取**：从 OSS（桶 `dream-ana`、前缀 `snapshot/`）增量拉取天分片，落地、校验、维护数据新鲜度。
- **分析**：对事件流做确定性统计/异常检测（运行健康、轮次与利润、补仓贡献、深跌、停轮、趋势……），输入固定 → 输出固定。
- **对话**：接入一个**独立的应用机器人**（钉钉/飞书），支持指令触发分析、返回文本/表格/文件，长任务先应答后回结果。
- **部署**：常驻服务器（pm2），定时同步 + 落后告警。

### 不做

- ❌ **不参与交易**：不连交易所、不下单、不改实盘配置，全部只读。
- ❌ **不碰上传**：导出器是另一个会话的产物，本项目只消费 OSS 对象（契约见 §三）。
- ❌ **不做回测**：回测与策略验证仍归主仓（`dream_develop` / `dream_lab`）。
- ❌ **P1 不引入 LLM**：指令解析走确定性指令表 + 参数语法（见 §七）。

---

## 二、整体架构

```
[交易实例 ×N]  dream-001 / dream-002 上跑的 grid-runner-*
     │  logs/events_<symbol>.ndjson（50MB 滚动 .1~.10）+ logs/events_account.ndjson
     │
     │  ① 上传侧（另一个会话）：读尾部 → 业务白名单筛 → 按 Asia/Shanghai 分桶 → gzip
     ▼
┌──────────────────────────── OSS: dream-ana / snapshot/ ────────────────────────────┐
│  snapshot/<instance>/<YYYY-MM-DD>.jsonl.gz     今天(final:false，每小时重写)          │
│                                                昨天(final:true，跨日最后补齐后封存)   │
│  report/<...>                                  本项目回传的报告（可选）              │
└───────────────────────────────────────────────────────────────────────────────────┘
     │  ② 拉取（本项目，每小时 + 手动）
     ▼
┌────────────────── dream-analysis（服务器常驻 / 本机开发） ──────────────────┐
│  sync 拉取器 ──► raw/ 天分片 ──► runtime/sync-state.json（ETag 幂等 + 水位线） │
│                                        │                                     │
│                                        ▼                                     │
│                              analysis/ 分析器注册表（纯函数）                  │
│                                        │                                     │
│                                        ▼                                     │
│                              report/ 渲染（markdown/表格/文件）                │
│                                        │                                     │
│                                        ▼                                     │
│                    bot/ 指令路由（复用主仓 bot 客户端）                        │
└──────────────────────────────────────────────────────────────────────────────┘
     │  ③ 群里发指令 / 回结果
     ▼
                  钉钉 / 飞书（独立应用，长连接）
```

| 层 | 输入 → 输出 | 关键约束 |
|---|---|---|
| sync | OSS 天分片 → 本地 + 水位线 | 幂等（ETag）、gz 校验、失败不炸 |
| store | 本地天分片 → 事件迭代器 | 按 (instance, date) 定位，**按天整体解压**（gz 不可随机访问） |
| analysis | 事件 + 参数 → 结构化结果 | **纯函数**，无 I/O、时钟注入 |
| report | 结果 → 文本/markdown/附件 | 长度可控；**未封存的天标"暂定"** |
| bot | 消息 → 指令 → 结果 | 鉴权、异步 ack、单会话并发 1 |

---

## 三、数据契约（**已对齐上传侧定稿**）

上传侧定稿（照其 §11.4 / §11.7，不重新讨论）：**读本地 ndjson 尾部 → 业务白名单筛 → 按本地日（Asia/Shanghai）分桶 → gzip 成天分片 → PUT 到 OSS**。

### 3.1 唯一数据源

```
snapshot/<instance>/<YYYY-MM-DD>.jsonl.gz
  ├ 首行 header：{type:"meta", schema:1, instance, host, date, generatedAt, final, count, firstTs, lastTs}
  └ 其后每行：原事件字段 + localDate + seq（当天分片内顺序号）
```

- `<instance>` = `env.json` 的 `name`（与 PM2 名 `grid-runner-<name>` 同源；**没配就拒绝上传**）✅
- **只覆盖写两个键**：今天（`final:false`，每小时重写）、昨天（跨日后最后一次补齐 → `final:true`，之后不再碰）；`--backfill <date>` 是例外
- 数据来自 `events_<symbol>.ndjson` **与** `events_account.ndjson`（**合并时间线**，account 行无业务 symbol）
- 白名单（业务动作子集）：轮次生命周期、成交 `BUY_FILLED/SELL_FILLED`、`TOPUP_*`、`CRASH_ENTERED/EXITED`、`DYNAMIC_PROFIT_REDUCED`/`PROFIT_PLACE_*`、`STOP_SIGNAL_RECEIVED`/`RESUME_SIGNAL_RECEIVED`、`ACCOUNT_OBSERVED`、配置与信号读数

### 3.2 消费侧必须适配的四条（v1 假设作废）

1. **同一对象键的内容会变** → 幂等靠 **ETag**：变了才重拉；重拉后**按天整体重建**（天分片是自洽快照，不做行级增量合并）
2. **当天不是终态** → 只用 `final:true` 的天出**归档结论**；`final:false` 的结果必须标 **「暂定（当天未封存）」**
3. **gz 不可随机访问** → 读取层整体解压 + 流式 parse，不假设字节偏移切片
4. **行级唯一键 = (instance, date, seq)**；`seq` 只保证**同一版本内**唯一 —— 重算后可能整体位移，**禁止跨版本 diff seq**

### 3.3 完整性校验（取代 v1 的 manifest）

| 校验 | 判据 | 失败处理 |
|---|---|---|
| 可解压 | gzip 解压无异常 | 丢弃 + 退避重试（见 §五） |
| 首行是 header | `type === "meta"` | 同上（可能拉到别人的对象） |
| 行数自洽 | 数据行数 == `header.count`（**count 是否含 header 行待确认**，先按"不含"实现，配置留开关） | 告警 + 仍入库，但标注「行数不符」 |
| 单行可解析 | 非法行计数，不抛 | 进 `warnings`，报告里体现 |
| 日期自洽 | **两层**：① 行内自洽 —— 上传侧盖的 `localDate` 必须与 `ts` 按契约时区推算的日一致；② 与分片日期比对 —— 优先用 `localDate`、缺失才用 `ts` 推算，允许 ±2h 跨夜 | 告警 |
| **独立完整性** | `final:true` 的分片，**我们自己算出来的**首条事件若晚于当天 04:00 ⇒ 疑似只含当日后段（上游尾部窗口截断） | 告警（§3.4-① 的兜底探测） |

> ⚠️ **必须知道的口径弱点**：`header.count / firstTs / lastTs` 都是**上传侧自报**的，拿它们做"自洽性"校验必然通过。
> 唯一**独立于上传侧**的信号是"我们自己从数据里算出来的首条事件时间"（上表最后一行）——
> 它能抓住"只导出了尾部窗口"这类最常见的截断，但抓不住"当天中段整段缺失"。要彻底解决只能靠上传侧补 manifest 或独立心跳基准（见 §3.4-①）。

> **"半写文件"这件事在天分片模式下不成立**：OSS 的 PUT（含分片上传 complete）是**原子替换**，消费者要么读到旧版本、要么读到新版本。原设计的"静默期 10 分钟"**取消**，只保留一条轻量竞态保护：**跳过 `LastModified` 不足 1 分钟的对象**。

### 3.4 三个已反馈项（上传侧已按其修正，**M1 用真数据逐条核对**）

> **前缀为什么是 `snapshot/`**：现有严格策略（资源 `acs:oss:oss-cn-hongkong:1404487916105436:dream-ana/snapshot/*`）**已实测覆盖，不需要改策略**（少一次线上变更 = 少一个坑）。
> 代价是消费侧**必须按正则严格匹配键**：`^snapshot/([^/]+)/(\d{4}-\d{2}-\d{2})\.jsonl\.gz$` —— 不匹配的键（占位文件、将来别的前缀数据）**忽略并记 warn**。这样上传侧哪天真改了布局，不会静默污染分析结果。

**① 当天分片是否包含"当天全部"事件？**
表述是"读尾部窗口 2MB，绝不扫全量"。若每次重算**只用尾部 2MB 重建**整个天分片，那么当天更早的事件就**不在分片里** → 轮数/利润/补仓贡献全部**低报且低报幅度不可知**。
必须明确其中一种：
- (a) **累积**：读旧分片 + 追加新增行（需注意"读-改-写"的失败/并发语义）；
- (b) **尾部重建**：仅当"当天事件总量 < 2MB"时才成立 —— 按白名单事件的量级（多币种 + account 行，一天可能数 MB～十几 MB）**大概率不成立**。
- 推荐形态：**文件内 offset 水位线 + 只 parse 新增字节**（CPU 比 2MB 盲扫更省，且不丢数据）。

**② 轮转边界会不会漏事件？**
主仓 ndjson 到 50MB 会**滚动重命名**（`events_X.ndjson` → `.1` → `.2` …）。只读"当前文件尾部 2MB"在**跨轮转**那一刻会漏掉被挪进 `.1` 的尾部。
建议：水位线用 **(inode, offset)**（或"最近 N 个文件各读尾部"），识别到轮转先读完 `.1` 未读部分再切新文件。

**③ 连接类稀疏事件能否进白名单？**
"不进"清单里含 `WS_*` / `UDS_*`。但这些**不是高频流水**，而是**稀疏的状态变化事件** —— 正是「断流 / 停摆 / 重连风暴」分析的唯一直接证据。缺了它们，`stream` 分析只能靠 `ACCOUNT_OBSERVED` 心跳缺口**间接猜**，且分不清"断流 / 停机 / 无成交"。
建议按语义判据拆开：**"有语义的状态变化"进，"周期性采样/批量流水/心跳"不进**：
- 建议**加进**：`UDS_CONN_CLOSED`、`UDS_RETRY_OK`、`UDS_RETRY_FAIL_ALERT`、`MARKET_STREAM_REARM*`、`MARKET_STREAM_RECOVERED`、`MARKET_STREAM_UNRECOVERED`、`WORKER_WS_STALE_RECONNECT`、`ORDER_CANCELED`（撤单异常信号）
- 保持**不进**：`PRICE_SNAPSHOT`、`GRID_BATCH_*`、`ORDER_PARTIAL_FILL`、心跳 ping/pong、调试类

### 3.5 协议细节（建议上传侧补进 header）

| 项 | 约定 |
|---|---|
| `count` | **不含 header 行**（写死） |
| account 行的 symbol | 固定保留值（建议 `"__account__"`），消费侧不猜 |
| **新增 `whitelistVersion`** | 白名单版本号/哈希。白名单一变，历史天的"同类事件完整性"就不可比 → 消费侧必须在报告里标注「数据口径于 X 时变更」。**已落地**：存进 `state.objects[].whitelistVersion`，`status` 显示；比较基准是**同一分片的上一次版本**与**紧邻前一天的版本**（不能拿"任意最新另一份"当基准 —— 回填旧日期会凭空报出变更），变化时打 warn 并写进 `lastRun.whitelistChanges` |
| `generatedAt` 的副作用 | 它每次都变 → gzip 字节每次都变 → **ETag 每次都变 → 当天文件每小时必然全量重下**。可接受（量小），但：① 同步频率与产出**同频（每小时）**，不要 10 分钟一次；② 分析服务放**同区**（内网免费）；③ 可选优化：把 `generatedAt` 移出压缩内容（放 OSS 对象 metadata）→ 恢复"内容确定 → ETag 稳定 → 零重下" |

---

## 四、目录结构与模块

```
dream-analysis/
├─ AGENTS.md  DESIGN.md  README.md
├─ package.json  tsconfig.json  .nvmrc(22)  .gitignore  .editorconfig
├─ env.json.example  env.json.md         # 真 env.json 不进 git
├─ ecosystem.config.js                   # pm2：dream-analysis
├─ src/
│  ├─ bin/analysis.ts        # 入口：配置 → sync 调度 → bot → 信号处理
│  ├─ config/index.ts        # env.json 解析 + 强校验（fail-fast）
│  ├─ oss/  store.ts  ossutilStore.ts    # ObjectStore 接口 + ossutil 实现
│  ├─ sync/  puller.ts  state.ts  scheduler.ts
│  ├─ store/ layout.ts  eventSource.ts   # raw/<instance>/<date>.jsonl.gz → 事件迭代器
│  ├─ ndjson/ parse.ts  types.ts         # gz 流式解析 + header 校验 + 脏行统计
│  ├─ analysis/ registry.ts  health.ts  rounds.ts  errors.ts  stream.ts  trend.ts
│  ├─ report/ render.ts  deliver.ts      # markdown 渲染 + 超长/附件投递
│  ├─ bot/                               # ← 拷贝自主仓 dream_develop/src/bot
│  │  types.ts  dingtalk-bot.ts  lark-bot.ts  factory.ts  lark-message.ts  router.ts
│  └─ common/ logger.ts  time.ts  format.ts
├─ scripts/  run-tests.js  ai-tools/buildtest.js  deploy.sh
├─ logs/  runtime/  data/raw/            # gitignore
└─ src/**/__tests__/*.test.js            # node:test + node:assert/strict
```

---

## 五、拉取器设计

**接口**：`ObjectStore { head(key); list(prefix); getTo(key, localPath); put(...); sign(key, ttl) }`。P1 用 **ossutil CLI** 实现（零新依赖、服务器已验证、内网 endpoint 已配、运维可手动复现），将来换 `ali-oss` SDK 时上层不动。

**一次同步（幂等、可中断）**：

```
0. 取跨进程锁 runtime/sync.lock（拿不到 ⇒ 明确拒绝本轮，不排队、不硬闯）
1. list(prefix) → 正则筛出合法天分片键 → [{key, size, lastModified, etag}]（不匹配的键忽略 + warn）
2. 过滤：只保留 lastModified 早于 minAgeSeconds 的对象（竞态保护）
3. 对每个对象：
   a. state.etag == 当前 etag → 跳过（**这是幂等的核心**）
   b. 同内容且上次失败未过退避期 → 跳过并记入 deferred（**换内容则立刻重试**）
   c. getTo → data/.tmp/<instance>/<date>.jsonl.gz
   d. 校验：可解压 / 首行 header / 行数 == count / 日期归属 / 独立完整性（§3.3）
   e. 通过 → 原子 rename 到 data/<instance>/<date>.jsonl.gz，写 state{etag,size,count,final,whitelistVersion}
      失败 → 删除 tmp，suspects[key] = {count, etag, lastErrorAt}（**退避，不是拉黑**）
4. 更新 runtime/sync-state.json：每 (instance,date) 一条记录 + lastRun（含 deferred/whitelistChanges）
5. 清理：>1 小时的 tmp 残留；raw 按 retentionDays / maxDiskGB 淘汰最旧（记日志）
6. 释放锁（finally）
```

**跨进程互斥**：常驻 `run` 与手动 `npm run sync` 是两个进程，共用同一批 tmp 与同一个状态文件
⇒ 用 `runtime/sync.lock`。三条实现要求（都是 review 用真问题换来的）：
① **原子独占创建**（`openSync(path,'wx')`）—— 先 `existsSync` 再写有 TOCTOU 窗口，两个进程同一毫秒进来会各写各的；
② **同机以"持有进程是否还活着"为准**（`process.kill(pid,0)`）：活着 ⇒ 绝不抢（慢同步也不会被抢），死了 ⇒ 立刻接管（`pm2 restart`/Ctrl+C 打断后不该被残留锁挡满一个周期）；
③ 年龄（默认 30 分钟）只作**异机/无从判活**时的兜底；token 归属防止"接管者"被原持有者误删。
`status` 直接读锁文件展示"此刻有没有同步在跑"（被拒轮次不写状态文件 —— 写了会和持有者互相覆盖）。

**失败是退避，不是拉黑**：同内容按 `30min × 2^(n-1)`（上限 6h）退避重试，ETag 一变立刻重试；
被推迟的分片进 `deferred`，在日志、`sync` 输出与 `status` 里**都看得见**。
（早期实现是"连续失败 3 次就永久跳过"，那等于把自己关掉：`final:true` 的历史天 ETag 永不变，一旦被拉黑就永久缺失。）

**边界情况**：

| 情况 | 处理 |
|---|---|
| 同一对象重复拉到 | ETag 命中 → 跳过 |
| 对象被重算覆盖（ETag 变） | 重拉 + **按天整体重建** + 记 `RECOMPUTED` 日志（当天属正常，历史天属 backfill，可在报告标注） |
| 行数不符 / 解压失败 | 不入库（或入库但标注），退避重试，日志 + `lastRun.errors` |
| 手动 sync 撞上常驻同步 | 后来者拿不到锁 ⇒ **明确拒绝**并在输出里说明；`status` 会显示当前持有者与时长 |
| 残留锁（持有者进程已死） | 下一次同步**自动接管**（同机判活）；`status` 提示"残留锁，下次自动接管" |
| OSS 不可达 / 403 | 不抛出进程；记 error；本轮结束、下一轮按间隔重试（**list 的指数退避重试列为 M4 待办**） |
| 磁盘水位 | 超 `sync.maxDiskGB` → 淘汰最旧日期（至少留一份） |
| 时区 | 全部 `Asia/Shanghai`（契约时区；判日期归属必须用它，不能拿 `ts` 的 UTC 日期前缀） |
| 并发 | **进程内单并发**（调度器 promise 闸门）+ **跨进程单并发**（`sync.lock`）；分析任务同样串行（§九） |

---

## 六、分析层设计

### 统一契约

```ts
interface AnalysisContext {
  source: EventSource;        // 只读事件迭代器（按 instance/symbol/时间窗口）
  now: Date;                  // 时钟注入（可测性）
  params: Record<string, string>;
}
interface AnalysisResult {
  title: string;
  summary: string;            // 1~3 行结论（群里第一眼看的）
  sections?: Array<{ heading: string; rows: string[][]; headers?: string[] }>;
  warnings?: string[];        // 数据缺口 / 未封存 / 口径变更 —— 必须如实写
  provisional?: boolean;      // true = 含 final:false 的天，结论仅供参考
}
interface Analysis {
  name: string; aliases: string[];
  help: string; params: ParamSpec[];
  maxWindowHours?: number;
  run(ctx: AnalysisContext): Promise<AnalysisResult>;
}
```

- **纯函数**：不读环境变量、不取 `Date.now()`、不写盘。
- `help`/指令表由注册表自动生成（不手写两份，防漂移）。
- **未封存提示是硬要求**：窗口内任何一天 `final:false` → `provisional: true` + `warnings` 写明。
- **数据缺口如实报告**："该窗口缺 2026-10-01 数据" 不许静默跳过。

### P1 首批分析器

| name | 别名 | 说明 | 依赖事件 | 依赖上传侧 |
|---|---|---|---|---|
| `health` | `hc` | 数据新鲜度、事件密度、`ACCOUNT_OBSERVED` 心跳缺口、异常计数 | 全部 + account | — |
| `rounds` | `r` | 轮数、成交笔数、止盈/整轮利润、未完成轮、卡轮 Top N | `NEW_ROUND` `SELL_FILLED` `ROUND_COMPLETED` | — |
| `topup` | `tu` | 补仓次数/贡献、深跌期行为 | `TOPUP_*` `CRASH_*` | — |
| `stopgaps` | `sg` | **有没有偷偷停轮**：`STOP_SIGNAL_RECEIVED` / `RESUME_SIGNAL_RECEIVED` 时间线 | 停轮/复轮 | — |
| `errors` | `e` | 异常事件分组明细（按类型 + 最近 N 条） | `*_ERROR` `*_FAILED` `SELL_STATE_*` | 部分需 ③ |
| `stream` | `st` | 断流/断连次数、累计时长、未恢复告警 | `UDS_*` `MARKET_STREAM_*` | **⛔ 需 §3.4-③** |
| `trend` | `tr` | 按小时/天的活跃度与收益趋势 | 同 `rounds` | — |

> 若 §3.4-③ 不解决：`stream` 降级为"**疑似停摆**"（用 account 心跳间隔推断），并在结果里明确写"数据源不含连接事件，无法区分断流/停机"。

### M2 已交付（2026-10-02）

`health` / `rounds` 已实现并跑过真数据；配套的契约与基建：

- **窗口**（`common/time.ts`）：`近Nh/近Nd/今天/昨天/单日/区间`，全部按契约时区算；
  **格式对但不存在的日子（2026-02-30）必须拒绝**（`Date.parse` 会静默进位成 03-02，用户会拿到另一天的数字）；
  **超长窗口在枚举天数之前就拦**（否则 `近100000d` 会先把天数数组撑爆）。
- **事件源**（`store/eventSource.ts`）：按窗口/实例/币种过滤；**缺天必报**；
  **读不出来的分片进 `failedShards`（不算"已覆盖"）**，同步时校验出的分片级告警（行数不符/缺前段）随 `shardWarnings` 一起带进报告
  —— 这两条是 M2 review 的 Critical：不报就会把"静默低报"伪装成健康数字。
- **渲染**（`report/render.ts`）：markdown + 长度预算；头部与告警**永不截断**，截断必须写明"仅显示前 K 行 / 共 N 行"。
- **注册表**（`analysis/types.ts`）：`help`/指令表由注册表生成；加分析器 = 在 `analysis/index.ts` 挂一行。
- 已知取舍：`health` 的心跳**按实例分开统计**（多实例混成一条游标会既漏报又错值）；
  `rounds` 的"未完成轮"按 roundId 判（带/不带 id 的事件分别算），并额外给"未完成轮已运行时长 Top N"
  —— 只看已结束的轮会把"哪一轮卡住"答反。

---

## 七、对话层设计

复用主仓机器人客户端（`types.ts` / `dingtalk-bot.ts` / `lark-bot.ts` / `factory.ts` / `lark-message.ts`），只重写 `router.ts`。

### 指令表（P1）

```
h / help                      指令列表（注册表自动生成）
whoami                        senderId / conversationId（配白名单用）
status                        数据新鲜度：最新已封存日期、当天是否拉全、落后时长、上次同步结果、磁盘占用
sync [--force]                手动拉取一次（--force 忽略 ETag/静默期重扫）
a / analyze <name> [参数]     执行分析（名字与参数说明由注册表提供）
hc / health [instance] [窗口] 运行健康（数据完整性 / 心跳 / 异常计数）
r / rounds [symbol] [窗口]    轮次与成交（利润 / 未完成轮 / 卡轮）
report [instance] [窗口]      M3：概览（health + rounds 摘要）——**与 rounds 别名分开**，别占用 `r`
```

**参数规则（CLI 与机器人共用一套，`POSITIONAL_PARAMS` + `WINDOW_ARG_RE`）**：
`key=value` 永远优先；裸参数里**长得像窗口的**（`2026-10-01` / `昨天` / `近24h` / `区间`）一律当 `window`；
其余裸参数按 `symbol → instance → top` 顺序填。
> 为什么窗口要特判：`analyze health 2026-10-02` 曾把日期当成 symbol ⇒ 窗口悄悄退回"昨天"、输出 0 事件（实测踩过）。

窗口语法（`common/time.ts` 统一解析）：`近1h / 近24h / 近7d / 今天 / 昨天 / 2026-10-01 / 2026-10-01~2026-10-03`。

**异步应答（硬要求）**：飞书 3 秒不 ack 会重推同一条消息；分析可能跑数秒 → **先答"⏳ 正在分析…"，再异步回结果**。`router.dispatch(msg) → { immediate?: string; job?: Promise<string> }`；同一会话并发上限 1，超出回"上一个任务还在跑"。

**长结果投递**：摘要进群；完整报告写文件 →（可选）传 OSS `report/` → 回**签名 URL**（TTL 24h）。P2 再考虑给机器人加发图片/文件能力。

**鉴权**：沿用主仓语义 —— `allowedStaffIds`（空 = 所有人可发指令，**必须 warn**）+ `allowedConversationIds`；写类指令（`sync --force`）限 `adminStaffIds`。**所有指令只读**：不写 `timeline/`、不碰交易、不删原始数据。

### 为什么 P1 不上 LLM

分析必须可复现、可测试（同一句指令 → 同一分析器 → 同一结果）。LLM 编造数字比没有数字更糟。触发条件：出现大量"自由语言描述的需求"且指令表明显不够用时，再加"自然语言 → {analysis, params}"的**参数翻译**，且**必须回显解析结果让人确认**后才执行。

---

## 八、配置（`env.json`）

```jsonc
{
  "name": "analysis",                     // → pm2: dream-analysis
  "oss": {
    "provider": "ossutil",
    "binary": "/usr/local/bin/ossutil",
    "endpoint": "oss-cn-hongkong-internal.aliyuncs.com",  // 香港区内网；本机开发用公网域名
    "bucket": "dream-ana",
    "prefix": "snapshot/",
    "configFile": "/root/.ossutilconfig"  // 只读 RAM 用户，chmod 600
  },
  "sync": {
    "intervalMinutes": 60,                // 与上传侧产出同频（不要 10 分钟，见 §3.5）
    "minAgeSeconds": 60,                  // 竞态保护
    "countIncludesHeader": false,         // 待上传侧确认
    "maxDiskGB": 2,
    "retentionDays": 90,
    "concurrency": 1
  },
  "bot": {
    "type": "lark",                       // 或 dingtalk；**必须独立应用**
    "appId": "…", "appSecret": "…",
    "allowedStaffIds": ["…"], "adminStaffIds": ["…"],
    "notify": { "warn": "…" }
  },
  "analysis": { "defaultWindow": "昨天", "maxWindowHours": 2160 },
  "report":   { "signTtlHours": 24, "inlineMaxChars": 3500 }
}
```

配置错一律 **fail-fast**；启动首行日志打印 `name/host/endpoint/bucket/prefix/版本`，**永不打印 AK/SK**。

---

## 九、部署与运维

| 项 | 决策 |
|---|---|
| 目标机 | **`dream-002`**（已定）。约束：`nice 10`、分析任务串行、`max_memory_restart: 512M`、资源让位于实盘 |
| 进程 | pm2 `dream-analysis`。**只允许操作这一个进程**：绝不动 `grid-runner-*`、**绝不 `pm2 restart all`**、`pm2 save` 前先 `pm2 list` 核对 |
| 目录 | `/root/dream_analysis`（与 `/root/dream_boye888` 等实盘目录彻底分开） |
| Node | ≥22，`npm ci` |
| 网络 | 服务器走**内网 endpoint**（免费 + 快）；本机开发走公网 |
| 权限 | 前缀沿用 `snapshot/` ⇒ **现有严格策略不用改**（上传侧/拉取侧先共用同一对 AK）。**建议后续新增只读用户**（`GetObject`+`ListObjects`+`GetObjectMeta`，资源同 `snapshot/*`）给分析侧：**新增用户不动现有策略**，而分析服务挂着机器人、暴露面最大，不宜持有能写能删的钥匙。回传报告若走 OSS 需另配 `report/*` 写权限（P1 不做） |
| 自检 | `node dist/bin/analysis.js doctor`：配置/OSS 连通/目录可写/机器人连通/数据新鲜度 |
| 监控 | 落后 > 2 小时、同步连续失败、行数不符 → 走机器人 warn 群 |

---

## 十、与主仓的关系

| 复用 | 做法 | 理由 |
|---|---|---|
| `src/bot/*` 客户端 | **拷贝**进本仓，文件头注明来源 commit | 避免跨仓 import 造成版本耦合 |
| 事件语义 | 以主仓代码为准，本仓 `ndjson/types.ts` 集中声明并注明来源 | 事实源在交易侧，本仓只读解释 |
| 测试/构建脚手架 | 拷贝并按需裁剪 | 同一套开发体验 |
| 数值/格式化口径 | `common/format.ts` 注明与主仓一致 | 避免两边算出不同的"利润" |

**不共享代码**（不用 workspace / npm link）：规则真源各自独立。

---

## 十一、测试策略

- **分析器**：真实 ndjson 裁剪样本 → 结果快照；必须覆盖"窗口内缺天"与"含 final:false 天"两个告警分支。
- **拉取器**：mock `ObjectStore` —— ETag 命中跳过、ETag 变化重拉、解压失败、行数不符、退避重试、磁盘淘汰。
- **ndjson 解析**：gz 流式、header 校验、坏行计数、account 行处理。
- **时间窗口解析**：表驱动。
- **指令路由**：表驱动（鉴权、未知指令、并发上限、help 由注册表生成）。
- **不测网络**：机器人只测 router 与消息解析。

---

## 十二、里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M1 骨架** | 配置、`ObjectStore`(ossutil)、`sync`、`status`/`doctor` | 真拉到 `timeline/` 里的天分片；重复跑不重复下载；ETag 变化能重拉 |
| **M2 首批分析** | `ndjson` 解析 + `health`/`rounds` + 渲染 | 样本结果稳定；缺天/未封存告警有测试 |
| **M3 机器人** | 复制 bot 客户端 + router + 异步 ack + 白名单 | 群里发 `r boye888 昨天` 拿到结果；越权被拒 |
| **M4 部署** | 每小时同步、落后告警、pm2、README 排障 | 断网/403 不崩；重启续跑 |
| **M5 扩展** | `errors`/`stream`/`trend`/`topup`/`stopgaps` + 签名 URL | 群里可用 |

---

## 十三、待办与待确认（v3）

### 已定稿

| 项 | 定稿 |
|---|---|
| 部署机 | **`dream-002`**（受限运行，见 §九） |
| 机器人 | **钉钉 + 独立应用**（不与实盘共用 —— 长连接集群模式、消息不广播） |
| OSS 前缀 | **`snapshot/`** —— 沿用现有严格策略，**不改线上策略** |
| 上传侧阻塞项 | 已按 §3.4 修正 → **M1 用真数据核对** |
| M1 交付状态 | 代码完成：121 个测试全绿、覆盖率 86.4/82.6/82.5（门槛 80/80/80）；**两轮四角色审查**（第一轮 3C+9W 全修；第二轮复检 6W，其中 5 条已修，1 条（锁的 stale 窗口）由"同机判活"从根上解决） |
| M2 交付状态 | `health` + `rounds` 已实现并在真分片上验证（746 事件 / 暂定标记 / 账户估值 93683.55）；测试 177 全绿、覆盖率 89.4/84.4/84.7；四角色审查 4C+7W 已按条修复（分片读失败与分片级告警不再被吞、窗口日期校验、多实例心跳分实例、未完成轮按 id 混算 + 已运行时长 Top N） |

### 待办

0. **M4：`list` 失败的指数退避重试**（现在失败只记 error + 等下一轮，间隔 60 分钟）。要加就加在有注入 sleep 的地方，并补"退避期间不重复调用"的单测。
1. **只读用户**（建议，**不阻塞开工**）：给分析侧单独一对 AK（`GetObject` + `ListObjects` + `GetObjectMeta`，资源 `snapshot/*`）。**新增用户不动现有策略**。理由：分析服务挂着机器人、对外接收消息，是暴露面最大的一环，不宜持有"能写能删"的钥匙。
2. **钉钉应用凭据**：AppKey/AppSecret 由大哥填进 002 的 `env.json`（不经我手）；随后在群里 @ 机器人一次，用 `whoami` 取 `staffId` / `conversationId` 回填白名单。
3. **保留策略**：OSS 90 天 / 本地 90 天，独立可调。
4. **M1 契约核对清单**（拿第一批真数据跑）：
   ① `header.count` 与数据行数一致；
   ② `firstTs/lastTs` 覆盖整天；
   ③ 白名单里能看到 `UDS_*` / `MARKET_STREAM_*` / `ORDER_CANCELED`；
   ④ 用 `ACCOUNT_OBSERVED` 心跳密度反查有没有时间缺口（验证轮转边界不丢事件）；
   ⑤ 当天 `final:false` → 分析结果标「暂定」。
