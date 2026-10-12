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

> **凭据的两种放法（代码两条路都支持）**：
> - **A. 写进本文件**：`oss.accessKeyId` + `oss.accessKeySecret`（必须成对填；只填一个启动就报错）⇒
>   程序启动时按 ossutil 格式落一个 **0600** 的配置文件（`storeFactory` → `writeOssutilCredentialFile`，段头 `[Credentials]` 不能省）。
> - **B. 指向现成配置**：先在机器上 `ossutil config -e <endpoint> -i <AK> -k <SK>` 生成 `~/.ossutilconfig`（`chmod 600`），
>   本文件只填 `configFile` 指向它，不写 AK。
>
> 无论哪种，程序**永不打印 AK/SK**（`redact` 覆盖 `accessKeySecret`），`-e` 每次显式传（本文件是 endpoint 唯一真源）。
> **分析侧应该用只读 RAM 用户的那对 AK**（`GetObject` + `ListObjects`，见 `DESIGN.md` §十三 待办 1）——
> 上传侧才需要写权限，两把钥匙分开。

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
| `appId` / `appSecret` | **必须用独立应用**：长连接是集群模式、消息不广播，与实盘共用应用会让推送随机丢 |
| `allowedStaffIds` | 历史遗留（指令时代的白名单）；机器人现在是纯推送通道，不响应群指令，此字段仅传给客户端 |
| `adminStaffIds` | 历史遗留（指令时代的写指令白名单），同上 |
| `notify.warn` | 告警推送的群 ID |

> **定位（2026-10-12 定）**：机器人只发 LP 日报 + 异常实时通知，**不响应任何群指令**（@ 它不会有回复）。
> LP 想看报告/挂单明细，点日报末尾的看板"详情链接"。交互入口只有 web 看板一个。

## `web`（可选；不写 = 看板关闭）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉则不起静态服务、不聚合 summary.json |
| `host` | `127.0.0.1` | 静态服务监听地址（看板含账户权益数据，公网暴露请自行评估风险） |
| `port` | — | 必填，1~65535 |
| `publicUrl` | `""` | **LP 从钉钉点开看板的外网地址**（`http(s)://` 完整地址，通常经反向代理/frp 暴露，尾斜杠自动去掉）。日报末尾的"详情链接"用它；留空 = 日报不附链接。<br>⚠️ 不能用 `host:port` 拼：那是内网监听地址，LP 打不开 |
