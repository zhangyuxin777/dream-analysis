# env.json 字段说明

> `env.json` **不进 git**（`.gitignore` 已排除）。服务器上 `chmod 600 env.json`。
> 任何字段缺失/非法 ⇒ 启动 fail-fast 报错（不带错配置静默跑）。

## `name`

实例名，同时决定 pm2 进程名 `dream-analysis`（`ecosystem.config.js` 用它拼）。建议就用 `analysis`。

## `oss`

| 字段 | 说明 |
|---|---|
| `provider` | 目前只有 `ossutil`（包装 CLI，零新依赖） |
| `binary` | `ossutil` 可执行文件；在 PATH 里就写 `ossutil`，否则写绝对路径 |
| `endpoint` | **服务器**：`oss-cn-hongkong-internal.aliyuncs.com`（内网，免流量费）<br>**本机**：`oss-cn-hongkong.aliyuncs.com`（公网） |
| `bucket` | `dream-ana` |
| `prefix` | `snapshot/`（与上传侧约定，**不要改**） |
| `configFile` | ossutil 配置文件路径（内含 AK/SK）。留空 = 用默认 `~/.ossutilconfig` |

> **凭据只存在于 ossutil 自己的配置文件里**，本项目**不读 AK/SK、不打印**。
> 该文件建议 `chmod 600`；将来可换成只读 RAM 用户的那一对（见 `DESIGN.md` §十三）。

## `sync`

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalMinutes` | 60 | 定时拉取间隔。**与上传侧产出同频**（每小时），不要设 10 分钟 —— 当天分片每次重算 ETag 都变，会反复全量重下 |
| `minAgeSeconds` | 60 | 竞态保护：跳过 `LastModified` 不足这么多秒的对象 |
| `countIncludesHeader` | false | `header.count` 是否把 header 行算进去（**待上传侧最终确认**；先按不含实现） |
| `maxDiskGB` | 2 | 本地原始数据上限，超了淘汰最旧日期 |
| `retentionDays` | 90 | 本地保留天数 |
| `concurrency` | 1 | 拉取并发（保持 1：002 上有实盘） |

## `process.nice`

进程启动时把自己 nice 调到该值（默认 10，范围 0~19）。Windows 上会失败并记一条 warn（不影响功能）。

## `runtime`

`dataDir`（天分片落地）/ `stateDir`（水位线）/ `logDir`。相对路径按仓库根解析。

## `report`

`inlineMaxChars`：群里内联展示的字符上限，超出则落盘成文件；`signTtlHours`：签名 URL 有效期（M5）。

## `bot`（M3 才用，先留空）

| 字段 | 说明 |
|---|---|
| `type` | `dingtalk` 或 `lark` |
| `appId` / `appSecret` | **必须用独立应用**：长连接是集群模式、消息不广播，与实盘共用应用会让群里 @ 指令随机丢 |
| `allowedStaffIds` | 允许发指令的人（`whoami` 指令取）；**空 = 群内所有人可发指令，启动时会 warn** |
| `adminStaffIds` | 允许执行写类指令（如 `sync --force`）的人 |
| `notify.warn` | 告警推送的群 ID |
