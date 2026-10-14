/* 可选的本地预览服务器（仅用于开发/首次安装，不保存任何数据）。
 * 数据全部在手机浏览器的 IndexedDB 里，这个进程只负责把静态文件发出去。
 *
 * 用法： node tests/serve.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

http.createServer(function (request, response) {
  const urlPath = decodeURIComponent(String(request.url || '/').split('?')[0]);
  let relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, function (error, content) {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found: ' + relative);
      return;
    }
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    }).end(content);
  });
}).listen(PORT, function () {
  console.log('静态预览已启动： http://localhost:' + PORT);
  console.log('注意：这是可选的前端预览服务，不保存任何数据；数据都在浏览器 IndexedDB 里。');
});
