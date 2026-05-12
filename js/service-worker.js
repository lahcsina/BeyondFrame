const CACHE_NAME = 'beyondframe-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/Gallery.html',
  '/submit.html',
  '/profile.html',
  '/auth.html',
  '/css/style.css',
  '/js/script.js',
  '/json/manifest.json',
  '/camera-logo.svg'
];

// Install: Cache all defined static assets
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

// Activate: Clean up old caches from previous versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME)
                  .map((name) => caches.delete(name))
      );
    })
  );
});

// Fetch: Smart strategy - Bypass cache for API calls, use Cache-First for assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to the network for API requests to ensure fresh data
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
});