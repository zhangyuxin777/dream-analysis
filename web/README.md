# dream-analysis-web — Dream 网格策略数据看板（前端）

dream-analysis 的 dashboard 模块前端，2026-10-11 自独立工程 `dream-dashboard` 并入。

- 技术栈：React 19 + Vite 7 + Tailwind 3 + shadcn/ui（仅保留实际用到的 4 个组件）+ Recharts
- 数据契约：`fetch('/data/summary.json')`，形状定义在 `src/types/summary.ts`，
  由主服务聚合器直出（TS 实现，口径与 legacy `build_summary.py` 逐字段对拍通过）

## 开发

```bash
npm install
# 本地预览需要一份 summary.json：
cp <某处>/summary.json public/data/summary.json
npm run dev        # http://localhost:3000
```

## 构建与部署

```bash
npm run build      # 产物 dist/
```

服务器上由 dream-analysis 主进程内置的只读静态服务托管（env.json `web` 段），
`dist/data/summary.json` 由聚合器每轮 sync 后自动重写——**不要**把 data 提交进 git。
