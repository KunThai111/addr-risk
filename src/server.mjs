#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { trace, learnAddress, DEFAULTS } from './trace.mjs';

const PORT = Number(process.env.PORT || 5178);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const intParam = (params, key, min, max) => {
  const v = Number(params.get(key));
  return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, Math.floor(v))) : DEFAULTS[key];
};

async function handleTrace(req, res, params) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  const opts = {
    hops: intParam(params, 'hops', 1, 5),
    fanout: intParam(params, 'fanout', 1, 50),
    perNode: intParam(params, 'perNode', 50, 1000),
    maxNodes: intParam(params, 'maxNodes', 5, 1000),
  };
  const started = Date.now();
  try {
    await trace((params.get('address') || '').trim(), opts, send, abort.signal);
    send('status', { message: `完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒` });
  } catch (e) {
    send('fail', { message: e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/trace') return await handleTrace(req, res, url.searchParams);
    if (url.pathname === '/api/learn') {
      const p = url.searchParams;
      const result = await learnAddress((p.get('address') || '').trim(), p.get('label') || '火币地址（用户确认）').catch((e) => ({ error: e.message }));
      res.writeHead(result.error ? 400 : 200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(join(PUBLIC, 'index.html')));
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message));
  }
}).listen(PORT, () => console.log(`addr-risk 网页已启动：http://localhost:${PORT}`));
