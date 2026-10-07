# dream-analysis 部署 / 运维备忘

> 维护者：zyb ｜ 最后更新：2026-10-07

## 架构一句话

dream（策略引擎）把运行日志写到 OSS → 本服务定时拉取到本地分片 → 做确定性分析 + 生成 LP 报告 → 通过钉钉企业机器人推送。日志的生产（dream）与消费（本服务）完全解耦。

## 服务器

- 机器：腾讯云轻量 `43.167.211.50`（Ubuntu 24.04），pm2 常驻
- 目录：`~/projects/dream-analysis`
- Node：`/root/.nvm/versions/node/v22.22.0/bin`（pm2 与该 node 配套，勿混用系统 node）
- 进程：pm2 应用名 `dream-analysis`（nice=10、内存上限 512M，让位于实盘）

## 日常命令（在服务器上执行）

```bash
export PATH=/root/.nvm/versions/node/v22.22.0/bin:$PATH

pm2 list                          # 看进程状态
pm2 logs dream-analysis           # 看日志（Ctrl+C 退出）
pm2 restart dream-analysis        # 重启（只动这一个应用）

# 调试（只渲染不推送，不影响去重状态……见下方注意）
node dist/bin/analysis.js lp daily boye888
node dist/bin/analysis.js lp triggers
node dist/bin/analysis.js status
```

### ⚠️ 铁律

- **绝不** `pm2 restart all` / `pm2 delete all`——这台机器上还有 `grid-runner-main`（实盘进程，当前停止状态），以及别的服务。
- 调试命令 `lp daily` / `lp triggers` 会写 `runtime/lp-reporter-state.json` 去重状态：
  - 在**服务器**上跑 `lp daily` 会消耗当天日报额度（今晚 21:07 就不会再发）；
  - 在**服务器**上跑 `lp triggers` 会把当前异常标记为"已通知"，真实推送就不会再发。
  - 想在服务器上安全试跑：先 `cp runtime/lp-reporter-state.json /tmp/` 备份，试完恢复。
- `env.json` 含 OSS 与钉钉凭据，**绝不进 git**（已 gitignore）。

## 更新部署流程（zyb 分支）

```bash
# 本机（Mac）：改代码 → 测试 → 提交推送
npm test
git push origin zyb

# 服务器：拉代码 → 构建 → 重启
cd ~/projects/dream-analysis
git fetch origin && git reset --hard origin/zyb
export PATH=/root/.nvm/versions/node/v22.22.0/bin:$PATH
npm ci --omit=dev        # 依赖有变化时
npx tsc                  # 本机没编译就 rsync dist/ 过来
pm2 restart dream-analysis
```

服务器上的 `env.json`、`runtime/`、`data/`、`tools/`、`logs/` 都是 gitignore 的本地文件，`git reset --hard` 不会动它们。

## LP 报告配置（env.json 的 `lp` 段）

```jsonc
"lp": {
  "accounts": [
    {
      "instance": "boye888",          // OSS 里的实例名
      "label": "你的账户（10 万 U）",  // 报告抬头
      "principal": 100000,            // 本金（算累计收益用）
      "conversationId": "cidXXX==",   // 钉钉群 ID，群里发 whoami 获取
      "dailyHour": 21, "dailyMinute": 7,  // 日报发送时刻（北京时间）
      "dayProfitAlertPct": 0.3,       // 单日已实现 ≥ 本金 0.3% 时发"行情馈赠"通知
      "stuckAlertHours": 24           // 持仓超 N 小时未卖出发通知
    }
  ]
}
```

新增 LP 账户：复制一段、改 instance/label/principal/conversationId 即可，无需改代码。

## 推送节奏

| 类型 | 频率 | 说明 |
|---|---|---|
| 日报 | 每天 Beijing 21:07 | 每个账户一条，去重状态在 `runtime/lp-reporter-state.json` |
| 异常通知（B 触发） | 实时 | 三种：急跌已退出（48h 内）、持仓超时未卖出、单日超额收益；同一事件只推一次 |

## 常见问题

- **日报没发**：`pm2 logs` 里搜 `LP`；常见原因——机器人未启动（bot 段没配）、conversationId 为空（只渲染不推送）、当天额度已消耗。
- **换机器部署**：新机器装好 node≥22 + pm2，拉代码后补 `env.json`（从旧机器 scp）+ Linux 版 ossutil（放 `tools/current/ossutil-linux-amd64/ossutil`，[官方下载](https://gosspublic.alicdn.com/ossutil/1.7.19/ossutil-v1.7.19-linux-amd64.zip)），改 `env.json` 的 `oss.binary` 路径。
