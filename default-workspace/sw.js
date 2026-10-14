/* Service Worker：把应用外壳缓存到手机上，之后断网也能打开。
 *
 * 数据不在缓存里 —— 数据全部在 IndexedDB，和这个缓存无关。
 * 升级应用时改 CACHE_NAME 即可让旧缓存自动清理。
 */
const CACHE_NAME = 'kaoyan-shell-0.2.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/ai.js',
  './js/repo.js',
  './js/rules.js',
  './js/store.js',
  './js/ui.js',
  './js/util.js',
  './js/docx.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(SHELL.map(function (asset) {
        return cache.add(asset).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE_NAME ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (error) { return; }
  // 只缓存同源外壳；DeepSeek 等跨域请求绝不缓存
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(request, { ignoreSearch: true }).then(function (cached) {
        const network = fetch(request).then(function (response) {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(request, response.clone()).catch(function () { return null; });
          }
          return response;
        }).catch(function () { return null; });

        if (cached) return cached;
        return network.then(function (response) {
          if (response) return response;
          if (request.mode === 'navigate') {
            return cache.match('./index.html').then(function (fallback) {
              return fallback || new Response('离线且无缓存', { status: 504 });
            });
          }
          return new Response('离线且无缓存', { status: 504 });
        });
      });
    })
  );
});
