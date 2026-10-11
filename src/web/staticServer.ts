/**
 * 看板静态文件服务（node 原生 http，零新增依赖）。
 *
 * 设计约束：
 * - **只读**：只允许 GET/HEAD，只Serving白名单根目录（web/dist），路径一律规范化后防目录穿越（`..`）。
 * - SPA 回退：`/data/` 前缀与带扩展名的路径不回退；其余 404 一律回 index.html
 *   （前端 base './'，路由只有一页，刷新/深链都不至于白屏）。
 * - 任何失败只记日志、绝不 throw —— 看板不该有停掉同步/机器人的权力（与 bot 同规则）。
 * - Content-Type 只覆盖看板实际用到的几类；未知的给 application/octet-stream。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { ILogger } from '../common/logger';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServerOptions {
  rootDir: string;
  host: string;
  port: number;
  logger: ILogger;
}

export interface StaticServer {
  close: () => Promise<void>;
  /** 实际监听的 host:port（日志用） */
  address: () => string;
  /** listen 完成（或失败）后 resolve —— 测试与"启动后立刻刷新数据"的调用方等它 */
  ready: Promise<void>;
}

export function createStaticServer(opts: StaticServerOptions): StaticServer {
  const { rootDir, host, port, logger } = opts;
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end('Method Not Allowed');
        return;
      }
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const candidate = path.normalize(path.join(rootDir, urlPath));
      if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let filePath = candidate;
      let isFallback = false;
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        // SPA 回退：/data/ 与带扩展名的路径不回退（404 是真实信号）
        const ext = path.extname(urlPath);
        if (urlPath.startsWith('/data/') || ext !== '') {
          res.writeHead(404).end('Not Found');
          return;
        }
        filePath = path.join(rootDir, 'index.html');
        isFallback = true;
        if (!fs.existsSync(filePath)) {
          res.writeHead(404).end('Not Found');
          return;
        }
      }
      const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': filePath.endsWith('index.html') || isFallback ? 'no-cache' : 'max-age=300',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      logger.error('看板静态服务异常', { detail: err instanceof Error ? err.message : String(err) });
      try { res.writeHead(500).end('Internal Server Error'); } catch { /* 连接已断 */ }
    }
  });
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  server.once('listening', () => markReady());
  server.on('error', (err) => {
    // listen 失败（端口占用等）只记日志 —— 看板是锦上添花，不拖死主服务
    logger.error('看板静态服务启动失败（不影响同步与机器人）', { detail: err instanceof Error ? err.message : String(err) });
    markReady(); // 别让等待方挂死
  });
  server.listen(port, host);
  return {
    ready,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    address: () => {
      const a = server.address();
      return typeof a === 'object' && a !== null ? `${host}:${a.port}` : `${host}:${port}`;
    },
  };
}
