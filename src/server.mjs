#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

/**
 * 本地预览用的静态服务器：网页本身在浏览器里完成全部追踪（与 GitHub Pages 上的版本相同）。
 * 额外提供 /local-config.json，把本机 .env 里的 Key 交给页面，免得本地使用时再手动填写。
 */
const PORT = Number(process.env.PORT || 5178);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/local-config.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ TRONSCAN_API_KEY: process.env.TRONSCAN_API_KEY || '', TRONGRID_API_KEY: process.env.TRONGRID_API_KEY || '' }));
    }
    const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel);
    if (!path.startsWith(ROOT) || /(^|[/\\])\.(env|git)/.test(rel)) return res.writeHead(403).end('forbidden');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': `${TYPES[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`addr-risk 网页已启动：http://localhost:${PORT}`));
