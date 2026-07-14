var CACHE = 'mar-v23';
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
function swNotify(body) {
  try {
    if (self.Notification && Notification.permission === 'granted') {
      return self.registration.showNotification('MAR Offline', {body: body, icon: './icon-192.png', badge: './icon-192.png', tag: 'mar-' + body.slice(0, 16)});
    }
  } catch (e) {}
  return Promise.resolve();
}
function swFlushOutbox() {
  var sent = 0;
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
              if (r.success) { it.status = 'done'; it.result = r.result; sent++; }
              else { it.status = 'failed'; it.error = (typeof r.error === 'string') ? r.error : JSON.stringify(r.error); }
              return swReq(d, 'outbox', 'readwrite', function(s){ return s.put(it); });
            });
            // fetch gagal (masih offline) → reject → status tetap 'queued' → Chrome retry
          });
        });
        // Notif "tidak lagi antre" — juga saat kirim sebagian lalu putus (rethrow utk retry)
        return chain
          .then(function(){ if (sent > 0) return swNotify('✅ ' + sent + ' operasi terkirim — tidak lagi antre'); })
          .catch(function(err) {
            var p = sent > 0 ? swNotify('✅ ' + sent + ' operasi terkirim — sisanya menunggu sinyal') : Promise.resolve();
            return p.then(function(){ throw err; });
          });
      });
    });
  });
}
/* Cek WO yang menunggu → push notif (dipanggil saat SW bangun via sync/periodicsync).
   Anti-spam: hanya notif kalau jumlah berubah dari notif terakhir (kv sw_notif_*). */
function swCheckPending() {
  return swDb().then(function(d) {
    return Promise.all([
      swReq(d, 'kv', 'readonly', function(s){ return s.get('token'); }),
      swReq(d, 'kv', 'readonly', function(s){ return s.get('role'); })
    ]).then(function(v) {
      var token = v[0], role = v[1] || 'mechanic';
      if (!token) return;
      var action = (role !== 'mechanic') ? 'pull_pending' : 'pull_my_wos';
      return fetch(API_URL, {method: 'POST', headers: {'Content-Type': 'text/plain'},
        body: JSON.stringify({token: token, action: action, data: {}})})
        .then(function(r){ return r.json(); })
        .then(function(r) {
          if (!r.success || !r.result) return;
          var n, msg, key;
          if (role !== 'mechanic') {
            n = (r.result.pending || []).length;
            msg = '📋 ' + n + ' WO menunggu approval Anda';
            key = 'sw_notif_pending';
          } else {
            n = (r.result.wos || []).filter(function(w){ return String(w.status) === 'pending_mechanic_work'; }).length;
            msg = '📝 ' + n + ' WO menunggu diisi';
            key = 'sw_notif_mywo';
          }
          return swReq(d, 'kv', 'readonly', function(s){ return s.get(key); }).then(function(prev) {
            var p = (n > 0 && n !== prev) ? swNotify(msg) : Promise.resolve();
            return p.then(function(){ return swReq(d, 'kv', 'readwrite', function(s){ return s.put(n, key); }); });
          });
        });
    });
  }).catch(function(){});
}
self.addEventListener('sync', function(e) {
  if (e.tag === 'mar-outbox') e.waitUntil(swFlushOutbox().then(swCheckPending));
});
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'mar-check') e.waitUntil(swFlushOutbox().then(swCheckPending));
});
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    if (clients.openWindow) return clients.openWindow('./');
  }));
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
