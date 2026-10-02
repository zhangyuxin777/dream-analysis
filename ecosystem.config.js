/**
 * pm2 配置：dream-analysis
 *
 * ⚠️ dream-002 上还有实盘进程（grid-runner-*）。本进程的所有约束都是为了"别跟实盘抢资源"：
 * - fork 单实例、max_memory_restart 512M
 * - nice 由程序自己在启动时设置（`env.json` 的 `process.nice`，默认 10）
 * - 分析任务在进程内串行执行
 * 绝不要用 `pm2 restart all` / `pm2 delete all` 操作这台机器。
 */
module.exports = {
  apps: [
    {
      name: 'dream-analysis',
      script: 'dist/bin/analysis.js',
      args: 'run',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      merge_logs: true,
      time: true,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
