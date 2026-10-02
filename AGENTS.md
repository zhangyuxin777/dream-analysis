# dream-analysis 项目指令（本仓唯一真源）

> DREAM 运行数据分析服务：从 OSS 拉取 ndjson 天分片 → 确定性分析器 → 机器人对话触发。
> 设计方案见 `DESIGN.md`（唯一设计文档）。**规则真源只有本文件**，别的文档只做指向。

## 项目概况

TypeScript + Node ≥22，**零运行时依赖**（只用 Node 内置模块），编译产物 `dist/`。

- 入口：`src/bin/analysis.ts`（CLI：`sync` / `status` / `doctor` / `list` / `verify`）
- 配置：`src/config/`（`env.json` 解析 + **fail-fast 校验**，凭据绝不打印）
- 数据源：`src/oss/`（`ObjectStore` 接口 + `ossutil` 实现）
- 拉取：`src/sync/`（`state` 水位线 + `puller` 幂等拉取 + `scheduler` 定时）
- 解析：`src/ndjson/`（`.jsonl.gz` 天分片：header + 行 + 校验）

## 铁律（先读这几条）

1. **只读**：本项目不连交易所、不下单、不改实盘配置；对 OSS 只读 `snapshot/`（不写、不删）。
2. **绝不打印凭据**：AK/SK 只在 `env.json` 里，`env.json` **不进 git**；日志/异常/报错信息里不得出现。
3. **服务器禁 git 写操作**，只 `git pull --ff-only` + `npm ci` + `npm run build` + 重启本项目进程。
4. **不许直接提交 main**：新开分支（`feat/` `fix/` `refactor/` `chore/`），合并时机由大哥定。
5. **只操作自己的进程**：在 `dream-002` 上只允许碰 `dream-analysis` 这一个 pm2 进程；
   **绝不动 `grid-runner-*`、绝不 `pm2 restart all`**（那台机器上还有实盘）。
6. **数据缺口如实报告**，不许把"缺数据"静默当成"没问题"；`final:false` 的当天数据一律标「暂定」。

## 数据契约（改代码前必读 `DESIGN.md` §三）

- 唯一数据源：`snapshot/<instance>/<YYYY-MM-DD>.jsonl.gz`（首行 header + 若干事件行）
- 键必须匹配 `^snapshot/([^/]+)/(\d{4}-\d{2}-\d{2})\.jsonl\.gz$`；不匹配的键**忽略并 warn**
- 幂等靠 **ETag**：相同 ETag 跳过；ETag 变了 ⇒ 重拉 + **按天整体重建**
- 行级唯一键 = `(instance, date, seq)`，**禁止跨版本 diff seq**

## 构建和测试

```bash
npm run build          # tsc → dist/
npm test               # tsc + 全量测试（scripts/run-tests.js 裸调用）
npm run test:only -- sync    # 不编译，按路径子串挑
node scripts/run-tests.js --list          # 只列会跑哪些
npm run test:coverage  # 全量 + 覆盖率硬门槛（80/80/80，不过即 exit 1）
npm run sync           # 手动拉取一次
npm run status         # 数据新鲜度
npm run doctor         # 自检：配置 / OSS 连通 / 目录 / 数据
```

**测试规则**（唯一真源 = 主仓 `skill("testing")`，本仓沿用同一套）：

- 集合 = **磁盘发现**（`src/`、`scripts/` 下的 `*.test.js`）；**新增测试 = 新建文件**，`package.json` 一个字不用改。
- 写法：`node:test` + `node:assert/strict`；**禁止 `process.exit`**；测试文件放同层 `__tests__/`，与源文件同名。
- 覆盖率 `npm run test:coverage` 是**硬门槛**（Node 原生 `--test-coverage-*`），没有"警告档"。

## 编码规范（要点）

- **TS strict**；不用 `any` 兜底，外部数据（`env.json`、OSS 返回、ndjson 行）一律**显式校验后再用**。
- **纯函数优先**：时间、文件系统、OSS、CLI 都通过参数注入（便于单测，别在逻辑里 `Date.now()`）。
- 数值/时长/金额格式化口径与主仓一致（比较数字时先对齐单位与小数位）。
- 注释写"**为什么**"，别复述代码；关键取舍（为什么这样设计）写进 `DESIGN.md` 或代码头注释。
- 日志：结构化、可 grep；错误必须带**上下文**（哪个 key / 哪个文件 / 哪个实例）。
- 配置错 ⇒ **fail-fast**（启动即报错退出），不要"带错配置静默跑"。

## Encoding Rule

- 默认读写 UTF-8 (no BOM)；历史非 UTF-8 先说明再单独处理，禁隐式转码。
