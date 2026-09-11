import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const port = Number(process.env.PORT || 5173);
const root = path.resolve('dist');
try { await stat(path.join(root, 'index.html')); } catch { console.error('Run npm run build first.'); process.exit(1); }
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json', '.svg':'image/svg+xml', '.gz':'application/gzip' };
http.createServer(async (req, res) => {
  // This serves application assets only. There is deliberately no upload or data API.
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => { console.log(`Occlude: http://127.0.0.1:${port} (local device only)`); if(process.argv.includes('--open'))spawn(process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open',[`http://127.0.0.1:${port}`],{stdio:'ignore'}); });
