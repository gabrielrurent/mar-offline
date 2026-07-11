/* ============================================================
   MAR Mekanik — Otak aplikasi (M1: submit kerja offline)
   Prinsip: CACHE (simpan kartu WO di HP) → ANTRE (submit masuk
   kotak pos) → SINKRON (terkirim sendiri saat ada sinyal).
   Server selalu benar; antrean hanyalah usulan.
   ============================================================ */

var CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxVk6kf91AQlFo39XWSBugE0OxUvjhx9bsgBNLSPEkQlSh03fV2Ukl_YLcNhoNWUrqmbA/exec'   // ← GANTI dengan URL /exec deployment GAS
};

var state = { token: null, me: null, wos: [], outbox: [], lastSync: null, syncing: false };
var db = null;

/* ---------- IndexedDB: laci penyimpanan di HP ---------- */
function openDb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('mar_m1', 1);
    r.onupgradeneeded = function (e) {
      var d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'op_id' });
    };
    r.onsuccess = function () { db = r.result; res(); };
    r.onerror = function () { rej(r.error); };
  });
}
function idbReq(store, mode, fn) {
  return new Promise(function (res, rej) {
    var tx = db.transaction(store, mode);
    var rq = fn(tx.objectStore(store));
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}
function kvGet(k) { return idbReq('kv', 'readonly', function (s) { return s.get(k); }); }
function kvSet(k, v) { return idbReq('kv', 'readwrite', function (s) { return s.put(v, k); }); }
function obAll() { return idbReq('outbox', 'readonly', function (s) { return s.getAll(); }); }
function obPut(item) { return idbReq('outbox', 'readwrite', function (s) { return s.put(item); }); }
function obDel(opId) { return idbReq('outbox', 'readwrite', function (s) { return s.delete(opId); }); }

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---------- Bicara ke server GAS ---------- */
function api(action, data, opId) {
  var body = JSON.stringify({ token: state.token, action: action, data: data || {}, op_id: opId || undefined });
  return fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },   // text/plain = tanpa preflight CORS (pola aman GAS)
    body: body
  }).then(function (r) { return r.json(); });
}

/* ---------- Sinkron: tukang pos jalan ---------- */
function syncNow(manual) {
  if (state.syncing) return Promise.resolve();
  if (!navigator.onLine) {
    if (manual) toast('📴 Tidak ada sinyal — data aman di antrean, akan terkirim otomatis nanti');
    renderAll();
    return Promise.resolve();
  }
  state.syncing = true; renderAll();
  return flushOutbox()
    .then(pullWos)
    .then(function () {
      state.lastSync = new Date().toISOString();
      return kvSet('last_sync', state.lastSync);
    })
    .catch(function (e) { toast('⚠️ Sync gagal: ' + e.message); })
    .then(function () { state.syncing = false; return refreshOutbox(); })
    .then(renderAll);
}

function flushOutbox() {
  return obAll().then(function (items) {
    var queue = items.filter(function (it) { return it.status === 'queued' || it.status === 'failed_retry'; });
    var chain = Promise.resolve();
    queue.forEach(function (it) {
      chain = chain.then(function () {
        return api(it.action, it.payload, it.op_id).then(function (r) {
          if (r.success) { it.status = 'done'; it.result = r.result; }
          else { it.status = 'failed'; it.error = (typeof r.error === 'string') ? r.error : JSON.stringify(r.error); }
          return obPut(it);
        }).catch(function () {
          // jaringan putus di tengah — biarkan tetap antre, berhenti dulu
          return obPut(it).then(function () { throw new Error('koneksi terputus saat mengirim'); });
        });
      });
    });
    return chain;
  });
}

function pullWos() {
  return api('pull_my_wos').then(function (r) {
    if (!r.success) throw new Error((typeof r.error === 'string') ? r.error : 'gagal memuat WO');
    state.wos = (r.result && r.result.wos) || [];
    return kvSet('wos', state.wos);
  });
}

function refreshOutbox() { return obAll().then(function (o) { state.outbox = o || []; }); }

/* ---------- Login token ---------- */
function doLogin() {
  var t = document.getElementById('tokenInput').value.trim();
  if (!t) { toast('Isi token dulu'); return; }
  state.token = t;
  if (navigator.onLine) {
    api('ping').then(function (r) {
      if (r.success) {
        state.me = r.result;
        Promise.all([kvSet('token', t), kvSet('me', state.me)]).then(function () {
          showScreen('main'); syncNow(true);
        });
      } else { toast('❌ ' + (r.error || 'Token ditolak')); state.token = null; }
    }).catch(function () { saveTokenOffline(t); });
  } else { saveTokenOffline(t); }
}
function saveTokenOffline(t) {
  // tanpa sinyal: simpan dulu, diverifikasi saat sync pertama
  kvSet('token', t).then(function () {
    toast('📴 Token disimpan — akan diverifikasi saat ada sinyal');
    showScreen('main'); renderAll();
  });
}

/* ---------- Form submit kerja ---------- */
var activeWo = null;
function openForm(woId) {
  activeWo = null;
  for (var i = 0; i < state.wos.length; i++) if (String(state.wos[i].id) === String(woId)) activeWo = state.wos[i];
  if (!activeWo) return;
  document.getElementById('fTitle').textContent = activeWo.wo_number + ' — ' + (activeWo.component_name || '');
  document.getElementById('fKet').textContent = activeWo.keterangan ? ('📝 ' + activeWo.keterangan) : '';
  document.getElementById('fStart').value = '';
  document.getElementById('fEnd').value = '';
  document.getElementById('fHm').value = '';
  document.getElementById('fKm').value = '';
  document.getElementById('fPart').value = '';
  document.getElementById('formModal').style.display = 'flex';
}
function closeForm() { document.getElementById('formModal').style.display = 'none'; }

function queueSubmit() {
  var st = document.getElementById('fStart').value;
  var en = document.getElementById('fEnd').value;
  var hm = parseFloat(document.getElementById('fHm').value);
  var km = parseFloat(document.getElementById('fKm').value);
  var part = document.getElementById('fPart').value;
  if (!st || !en) { toast('Jam mulai & selesai wajib diisi'); return; }
  if (new Date(en) <= new Date(st)) { toast('Jam selesai harus setelah jam mulai'); return; }
  if (isNaN(hm) || hm <= 0) { toast('Hour Meter wajib > 0'); return; }
  if (isNaN(km) || km <= 0) { toast('Kilometer wajib > 0'); return; }

  var op = {
    op_id: uuid(),
    action: 'submit_work',
    wo_id: activeWo.id,
    wo_number: activeWo.wo_number,
    payload: {
      wo_id: activeWo.id,
      start_time: new Date(st).toISOString(),
      end_time: new Date(en).toISOString(),
      hour_meter: hm, kilometers: km,
      part_category: part
    },
    status: 'queued',
    created_at: new Date().toISOString()
  };
  obPut(op).then(refreshOutbox).then(function () {
    closeForm(); renderAll();
    toast(navigator.onLine ? '📮 Masuk antrean — mengirim...' : '📮 Tersimpan! Terkirim otomatis saat ada sinyal');
    syncNow(false);
  });
}

function retryOp(opId) {
  obAll().then(function (items) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].op_id === opId) { items[i].status = 'failed_retry'; return obPut(items[i]); }
    }
  }).then(function () { syncNow(true); });
}
function discardOp(opId) {
  if (!confirm('Buang kiriman gagal ini? Isian akan hilang.')) return;
  obDel(opId).then(refreshOutbox).then(renderAll);
}

/* ---------- Tampilan ---------- */
function showScreen(nm) {
  document.getElementById('screen-login').style.display = nm === 'login' ? 'block' : 'none';
  document.getElementById('screen-main').style.display = nm === 'main' ? 'block' : 'none';
}
function badgeFor(wo, pendingOp) {
  if (pendingOp) {
    if (pendingOp.status === 'queued') return ['📮 Antre — menunggu sinyal', '#b45309'];
    if (pendingOp.status === 'failed') return ['❌ Ditolak server', '#b91c1c'];
    if (pendingOp.status === 'done') return ['✅ Terkirim — menunggu approval', '#15803d'];
  }
  var s = String(wo.status || '');
  if (s === 'pending_mechanic_work') return ['📝 Perlu diisi', '#1d4ed8'];
  if (s === 'pending_supervisor') return ['⏳ Menunggu approval L1', '#7c3aed'];
  if (s === 'pending_superintendent') return ['⏳ Menunggu approval L2', '#7c3aed'];
  if (s === 'approved') return ['✅ Approved', '#15803d'];
  return [s || '-', '#475569'];
}
function renderAll() {
  var on = navigator.onLine;
  document.getElementById('netDot').style.background = on ? '#22c55e' : '#ef4444';
  document.getElementById('netText').textContent = on ? 'Online' : 'Offline';
  document.getElementById('syncBtn').textContent = state.syncing ? '⏳ Sinkron...' : '🔄 Sync';
  document.getElementById('lastSync').textContent = state.lastSync
    ? 'Sync terakhir: ' + new Date(state.lastSync).toLocaleString('id-ID') : 'Belum pernah sync';
  var meEl = document.getElementById('meName');
  meEl.textContent = state.me ? (state.me.name + ' (' + state.me.mechanic_id + ')') : '';

  var opByWo = {};
  state.outbox.forEach(function (o) {
    if (!opByWo[o.wo_id] || o.created_at > opByWo[o.wo_id].created_at) opByWo[o.wo_id] = o;
  });

  var list = document.getElementById('woList');
  if (!state.wos.length) {
    list.innerHTML = '<div class="empty">Belum ada kartu WO tersimpan.<br>Tekan 🔄 Sync saat ada sinyal.</div>';
    return;
  }
  var html = '';
  state.wos.forEach(function (wo) {
    var op = opByWo[wo.id];
    var b = badgeFor(wo, op);
    var canFill = String(wo.status) === 'pending_mechanic_work' && (!op || op.status === 'failed');
    html += '<div class="card">' +
      '<div class="cardTop"><b>' + esc(wo.wo_number || wo.id) + '</b>' +
      '<span class="badge" style="background:' + b[1] + '">' + b[0] + '</span></div>' +
      '<div class="cardBody">' + esc(wo.component_name || '-') +
      (wo.unit_name ? ' · ' + esc(wo.unit_name) : '') +
      (wo.target_hours ? ' · target ' + wo.target_hours + ' jam' : '') + '</div>' +
      (wo.keterangan ? '<div class="ket">📝 ' + esc(wo.keterangan) + '</div>' : '') +
      (op && op.status === 'failed' ? '<div class="err">Alasan: ' + esc(op.error || '-') +
        '<br><button class="mini" onclick="retryOp(\'' + op.op_id + '\')">🔁 Coba lagi</button> ' +
        '<button class="mini gray" onclick="discardOp(\'' + op.op_id + '\')">🗑 Buang</button></div>' : '') +
      (canFill ? '<button class="big" onclick="openForm(\'' + esc(String(wo.id)) + '\')">✍️ Isi & Kirim Laporan</button>' : '') +
      '</div>';
  });
  var pend = state.outbox.filter(function (o) { return o.status === 'queued' || o.status === 'failed_retry'; }).length;
  document.getElementById('outboxInfo').textContent = pend ? ('📮 ' + pend + ' kiriman menunggu sinyal') : '';
  list.innerHTML = html;
}
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 3500);
}

/* ---------- Mulai ---------- */
window.addEventListener('online', function () { syncNow(false); });
window.addEventListener('offline', renderAll);

openDb().then(function () {
  return Promise.all([kvGet('token'), kvGet('me'), kvGet('wos'), kvGet('last_sync')]);
}).then(function (vals) {
  state.token = vals[0] || null;
  state.me = vals[1] || null;
  state.wos = vals[2] || [];
  state.lastSync = vals[3] || null;
  return refreshOutbox();
}).then(function () {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  showScreen(state.token ? 'main' : 'login');
  renderAll();
  if (state.token && navigator.onLine) syncNow(false);
});
