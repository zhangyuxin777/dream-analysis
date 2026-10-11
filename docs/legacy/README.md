# legacy 留档

## build_summary.py（2026-10-11 退役）

dream 看板的**第一代数据后端**（Python）：读 `raw/<instance>/<date>.jsonl.gz` 事件分片 → 产出看板消费的 `summary.json`。

退役原因与去向：

- 口径逻辑（轮号重号切段 / -RCV 恢复链 accCost 差额 / 市价从持仓估值反推）已在
  `src/dashboard/aggregator.ts` 逐条翻译为 TS，**同分片产物逐字段对拍全过**（数值容差 0.011）
  后切换，本文件不再维护。
- 看板前端自独立工程 `dream-dashboard` 并入本仓库 `web/`；聚合由主服务在每次 sync 后自动执行
  （`analysis.js dashboard --out …` / env.json `web` 段），数据源就是服务器本地分片，
  不再需要任何机器上的二手 raw 副本。

保留本文件仅为口径考古：若未来对 `src/dashboard/aggregator.ts` 的某个数字起疑，
可用它对同一份分片重算一遍当独立基准（`DREAM_RAW=<分片目录> SUMMARY_OUT=<输出> python3 build_summary.py`）。
