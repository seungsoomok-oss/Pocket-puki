// 앱 셸 캐시 (오프라인에서도 앱과 지난 보고서를 열 수 있게). API 호출은 캐시하지 않습니다.
const CACHE = 'ai-interview-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/prompts.js',
  './js/llm.js',
  './js/interview.js',
  './js/storage.js',
  './js/share.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/html2canvas.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return; // API 호출(POST)은 그대로 통과
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // 네트워크 우선, 실패 시 캐시 (수정 사항이 바로 반영되도록)
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match('./index.html')))
  );
});
