import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Dream 网格策略数据看板前端。
// 数据契约：fetch('/data/summary.json')，由主服务 dashboard 聚合器直出
// （`analysis.js dashboard --out …`，服务器上每轮 sync 后自动刷新）。
// 本目录独立构建（npm run build → dist/），不参与主服务的 tsc 构建。
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
