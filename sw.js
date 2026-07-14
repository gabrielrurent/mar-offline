var CACHE = 'mar-v21';
var ASSETS = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(ASSETS);}));
  self.skipWaiting();
});
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});
/* ── Background Sync: kirim antrean walau app sudah ditutup ──
   Saat sinyal kembali, Chrome membangunkan SW ini → flush outbox dari
   IndexedDB. Kalau masih gagal (offline), promise reject → Chrome retry
   otomatis dgn backoff. Server dedup via op_id (ProcessedOps) → aman dobel. */
var API_URL = 'https://script.google.com/macros/s/AKfycbwlwlQvOGVF6FdKkYRNlbgdJCets5L-0AfufMB4_79_HzvoQkeE9aZAqkKZiXCZHXnG6Q/exec';
function swDb() {
  return new Promise(function(res, rej) {
    var r = indexedDB.open('mar_v2', 2);
    r.onsuccess = function(){ res(r.result); };
    r.onerror = function(){ rej(r.error); };
  });
}
function swReq(d, store, mode, fn) {
  return new Promise(function(res, rej) {
    var rq = fn(d.transaction(store, mode).objectStore(store));
    rq.onsuccess = function(){ res(rq.result); };
    rq.onerror = function(){ rej(rq.error); };
  });
}
function swFlushOutbox() {
  return swDb().then(function(d) {
    return swReq(d, 'kv', 'readonly', function(s){ return s.get('token'); }).then(function(token) {
      if (!token) return;
      return swReq(d, 'outbox', 'readonly', function(s){ return s.getAll(); }).then(function(items) {
        var queue = (items || []).filter(function(it){ return it.status === 'queued' || it.status === 'failed_retry'; });
        var chain = Promise.resolve();
        queue.forEach(function(it) {
          chain = chain.then(function() {
            return fetch(API_URL, {
              method: 'POST', headers: {'Content-Type': 'text/plain'},
              body: JSON.stringify({token: token, action: it.action, data: it.payload || {}, op_id: it.op_id})
            }).then(function(r){ return r.json(); }).then(function(r) {
              if (r.success) { it.status = 'done'; it.result = r.result; }
              else { it.status = 'failed'; it.error = (typeof r.error === 'string') ? r.error : JSON.stringify(r.error); }
              return swReq(d, 'outbox', 'readwrite', function(s){ return s.put(it); });
            });
            // fetch gagal (masih offline) → reject → status tetap 'queued' → Chrome retry
          });
        });
        return chain;
      });
    });
  });
}
self.addEventListener('sync', function(e) {
  if (e.tag === 'mar-outbox') e.waitUntil(swFlushOutbox());
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(function(hit) {
      if (hit) return hit;
      return fetch(e.request).then(function(resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function(c){c.put(e.request,copy);});
        return resp;
      }).catch(function(){return caches.match('./index.html');});
    })
  );
});
