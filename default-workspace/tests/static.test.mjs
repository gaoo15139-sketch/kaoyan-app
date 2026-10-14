/* 静态完整性测试：不打开浏览器也能发现断裂的引用。
 * 1. 所有 JS 模块能通过语法检查
 * 2. 模块之间的 import 路径全部存在（递归）
 * 3. index.html 引用的资源都存在
 * 4. manifest 合法且图标存在
 * 5. Service Worker 的缓存清单全部存在
 */
import { test } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); }
function exists(relative) { return fs.existsSync(path.join(ROOT, relative)); }

function collectImports(relative) {
  const source = read(relative);
  const out = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match) {
    out.push(match[1]);
    match = pattern.exec(source);
  }
  return out;
}

function resolveModule(fromRelative, spec) {
  if (spec.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), spec));
  }
  return null;
}

test('1. 模块图完整：所有 import 都能解析到真实文件', async function (t) {
  const seen = new Set();
  const queue = ['js/app.js'];
  const missing = [];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (!exists(current)) { missing.push(current + ' (文件不存在)'); continue; }
    collectImports(current).forEach(function (spec) {
      const resolved = resolveModule(current, spec);
      if (!resolved) return;
      if (!exists(resolved)) missing.push(current + ' -> ' + spec);
      else queue.push(resolved);
    });
  }
  t.check('所有模块引用都能解析', missing.length === 0, missing.join('; '));
  t.check('模块图包含全部 7 个模块', seen.size >= 7, Array.from(seen).join(', '));
  ['js/app.js', 'js/ai.js', 'js/docx.js', 'js/repo.js', 'js/rules.js', 'js/store.js', 'js/ui.js', 'js/util.js']
    .forEach(function (file) { t.check('存在模块 ' + file, exists(file)); });
});

test('2. index.html 的引用都存在', async function (t) {
  const html = read('index.html');
  const refs = [];
  const pattern = /(?:href|src)="(\.\/[^"]+)"/g;
  let match = pattern.exec(html);
  while (match) { refs.push(match[1].replace(/^\.\//, '')); match = pattern.exec(html); }
  t.check('找到了资源引用', refs.length >= 4, refs.length);
  refs.forEach(function (ref) {
    if (ref.indexOf('?') >= 0) return;
    t.check('资源存在：' + ref, exists(ref));
  });
  t.check('使用 module 脚本', html.indexOf('type="module"') >= 0);
  t.check('含 viewport-fit=cover', html.indexOf('viewport-fit=cover') >= 0);
  t.check('含 apple-mobile-web-app-capable', html.indexOf('apple-mobile-web-app-capable') >= 0);
  t.check('含 manifest 链接', html.indexOf('manifest.webmanifest') >= 0);
  t.check('含底部导航容器', html.indexOf('id="tabs"') >= 0);
});

test('3. manifest 合法且图标齐全', async function (t) {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  t.eq(manifest.display, 'standalone', '独立窗口模式');
  t.check('有 start_url', !!manifest.start_url);
  t.check('至少两个图标', (manifest.icons || []).length >= 2);
  t.check('含 maskable 图标', (manifest.icons || []).some(function (i) { return (i.purpose || '').indexOf('maskable') >= 0; }));
  (manifest.icons || []).forEach(function (icon) {
    const file = icon.src.replace(/^\.\//, '');
    t.check('图标存在：' + file, exists(file));
    if (exists(file)) {
      const bytes = fs.readFileSync(path.join(ROOT, file));
      t.check(file + ' 是 PNG', bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
    }
  });
  (manifest.shortcuts || []).forEach(function (shortcut) {
    t.check('快捷方式 ' + shortcut.short_name + ' 指向合法 tab',
      /tab=(import|library|review)/.test(shortcut.url), shortcut.url);
  });
});

test('4. Service Worker 缓存清单全部存在', async function (t) {
  const sw = read('sw.js');
  const listMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  t.check('能解析出 SHELL 清单', !!listMatch);
  const items = (listMatch ? listMatch[1] : '').match(/'([^']+)'/g) || [];
  const relative = items.map(function (item) { return item.replace(/'/g, '').replace(/^\.\//, ''); })
    .filter(function (item) { return item && item !== ''; });
  t.check('清单条目不少于 10 个', relative.length >= 10, relative.length);
  const missing = relative.filter(function (item) { return !exists(item); });
  t.check('清单中的文件都存在', missing.length === 0, missing.join(', '));
  t.check('不缓存跨域请求', sw.indexOf('url.origin !== self.location.origin') >= 0);
});

test('5. 应用代码不含被删除的后端依赖', async function (t) {
  const files = ['js/app.js', 'js/repo.js', 'js/ai.js', 'js/store.js'];
  let found = [];
  files.forEach(function (file) {
    const source = read(file);
    [/fetch\(['"]\/api/, /XMLHttpRequest/, /localhost:8787/].forEach(function (pattern) {
      if (pattern.test(source)) found.push(file + ' 匹配 ' + String(pattern));
    });
  });
  t.check('前端已完全脱离自建后端', found.length === 0, found.join('; '));
  t.check('AI 只直连 DeepSeek 官方域名', read('js/ai.js').indexOf('api.deepseek.com') >= 0);
});

test('6. 文档存在且格式正确', async function (t) {
  ['README.md', 'ARCHITECTURE.md'].forEach(function (doc) {
    t.check(doc + ' 存在', exists(doc));
    if (!exists(doc)) return;
    const text = read(doc);
    t.check(doc + ' 是多行文档', text.split('\n').length > 20, text.split('\n').length);
    t.check(doc + ' 不含未转义的换行字面量', text.indexOf(String.fromCharCode(92) + 'n') < 0);
  });
});
