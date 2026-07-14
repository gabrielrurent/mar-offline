/* ============================================================
   MAR Offline — M1 Mekanik + M2 Create + M3 Approval
   Prinsip: CACHE → ANTRE → SINKRON. Server selalu benar.
   ============================================================ */

var CONFIG = { API_URL: 'https://script.google.com/macros/s/AKfycbwlwlQvOGVF6FdKkYRNlbgdJCets5L-0AfufMB4_79_HzvoQkeE9aZAqkKZiXCZHXnG6Q/exec' };
var S = { token:null, me:null, role:null, wos:[], refs:null, refsAt:null, pending:[], active:[], approved:[], outbox:[], lastSync:null, syncing:false, tab:'wos', appSub:'pending', showOutbox:false, crossFunc:false };
// PERF: katalog referensi (±1400 job) berat — tarik ulang maks 1x/12 jam.
var REFS_TTL_MS = 12*60*60*1000;
function refsStale() { return !S.refs || !S.refsAt || (Date.now() - new Date(S.refsAt).getTime() > REFS_TTL_MS); }
var db = null;

/* ── IndexedDB ── */
function openDb() {
  return new Promise(function(res,rej) {
    var r = indexedDB.open('mar_v2',2);
    r.onupgradeneeded = function(e) {
      var d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox',{keyPath:'op_id'});
    };
    r.onsuccess = function() { db = r.result; res(); };
    r.onerror = function() { rej(r.error); };
  });
}
function idbReq(store,mode,fn) {
  return new Promise(function(res,rej) {
    var tx = db.transaction(store,mode);
    var rq = fn(tx.objectStore(store));
    rq.onsuccess = function() { res(rq.result); };
    rq.onerror = function() { rej(rq.error); };
  });
}
function kvGet(k) { return idbReq('kv','readonly',function(s){return s.get(k);}); }
function kvSet(k,v) { return idbReq('kv','readwrite',function(s){return s.put(v,k);}); }
function obAll() { return idbReq('outbox','readonly',function(s){return s.getAll();}); }
function obPut(item) { return idbReq('outbox','readwrite',function(s){return s.put(item);}); }
function obDel(opId) { return idbReq('outbox','readwrite',function(s){return s.delete(opId);}); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'op-'+Date.now()+'-'+Math.random().toString(36).slice(2,10); }

/* ── API ── */
function api(action,data,opId) {
  var body = JSON.stringify({token:S.token, action:action, data:data||{}, op_id:opId||undefined});
  return fetch(CONFIG.API_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:body})
    .then(function(r){return r.json();});
}

/* ── Sync ── */
function syncNow(manual) {
  if (S.syncing) return Promise.resolve();
  if (!navigator.onLine) { if (manual) toast('📴 Offline — data aman di antrean'); renderAll(); return Promise.resolve(); }
  S.syncing = true; renderAll();
  return flushOutbox()
    .then(function() {
      var tasks = [pullWos()];
      // PERF: refs (katalog job ±1400 baris) hanya bila kadaluarsa (12 jam) —
      // pending approval tetap ditarik tiap sync karena selalu berubah.
      if (S.role !== 'mechanic') { tasks.push(pullPending()); tasks.push(pullActive()); if (refsStale()) tasks.push(pullRefs()); }
      return Promise.all(tasks);
    })
    .then(function() { S.lastSync = new Date().toISOString(); return kvSet('last_sync',S.lastSync); })
    .catch(function(e) { toast('⚠️ Sync gagal: '+e.message); })
    .then(function() { S.syncing = false; return refreshOutbox(); })
    .then(renderAll);
}
function flushOutbox() {
  return obAll().then(function(items) {
    var queue = items.filter(function(it){return it.status==='queued'||it.status==='failed_retry';});
    var chain = Promise.resolve();
    queue.forEach(function(it) {
      chain = chain.then(function() {
        return api(it.action, it.payload, it.op_id).then(function(r) {
          if (r.success) { it.status='done'; it.result=r.result; }
          else { it.status='failed'; it.error=(typeof r.error==='string')?r.error:JSON.stringify(r.error); }
          return obPut(it);
        }).catch(function() { return obPut(it).then(function(){throw new Error('koneksi terputus');}); });
      });
    });
    return chain;
  });
}
function pullWos() {
  return api('pull_my_wos').then(function(r) {
    if (!r.success) return;
    S.wos = (r.result && r.result.wos) || [];
    return kvSet('wos', S.wos);
  });
}
function pullRefs() {
  return api('pull_create_refs').then(function(r) {
    if (!r.success) return;
    S.refs = r.result.refs;
    S.refsAt = new Date().toISOString();
    return kvSet('refs', S.refs).then(function(){ return kvSet('refs_at', S.refsAt); });
  });
}
function pullPending() {
  return api('pull_pending').then(function(r) {
    if (!r.success) return;
    S.pending = (r.result && r.result.pending) || [];
    return kvSet('pending', S.pending);
  });
}
function pullActive() {
  return api('pull_active').then(function(r) {
    if (!r.success) return;
    S.active = (r.result && r.result.active) || [];
    return kvSet('active', S.active);
  });
}
function pullApproved() {
  return api('pull_approved').then(function(r) {
    if (!r.success) return;
    S.approved = (r.result && r.result.approved) || [];
    return kvSet('approved', S.approved);
  });
}
function refreshOutbox() { return obAll().then(function(o){S.outbox=o||[];}); }

/* ── Login ── */
function doLogin() {
  var t = document.getElementById('tokenInput').value.trim();
  if (!t) { toast('Isi token dulu'); return; }
  S.token = t;
  if (navigator.onLine) {
    api('ping').then(function(r) {
      if (r.success) {
        S.me = r.result;
        // Role ASLI dari backend (bukan tebakan). Mekanik = hanya WO Saya.
        S.role = (r.result && r.result.role) ? r.result.role : 'mechanic';
        return kvSet('token',t).then(function() { return kvSet('me',S.me); })
          .then(function() { return kvSet('role',S.role); })
          .then(function() {
            // Hanya non-mekanik (planner/approver) yang perlu refs utk Buat WO.
            if (S.role !== 'mechanic') return pullRefs().catch(function(){});
          })
          .then(function() { showScreen('main'); syncNow(false); });
      } else { toast('❌ '+(r.error||'Token ditolak')); S.token=null; }
    }).catch(function() { saveTokenOffline(t); });
  } else { saveTokenOffline(t); }
}
function saveTokenOffline(t) {
  kvSet('token',t).then(function() { toast('📴 Token disimpan — verifikasi saat ada sinyal'); showScreen('main'); renderAll(); });
}
function doLogout() {
  if (!confirm('Logout? Data lokal akan dihapus.')) return;
  var tx = db.transaction(['kv','outbox'],'readwrite');
  tx.objectStore('kv').clear();
  tx.objectStore('outbox').clear();
  tx.oncomplete = function() { S = {token:null,me:null,role:null,wos:[],refs:null,pending:[],outbox:[],lastSync:null,syncing:false,tab:'wos'}; showScreen('login'); };
}

/* ── Tab ── */
function switchTab(tab) { S.tab = tab; renderAll(); }

/* ── M1: Submit form ── */
var activeWo = null;
function openSubmitForm(woId) {
  activeWo = null;
  for (var i=0;i<S.wos.length;i++) if (String(S.wos[i].id)===String(woId)) activeWo=S.wos[i];
  if (!activeWo) return;
  document.getElementById('fTitle').textContent = activeWo.wo_number;
  document.getElementById('fDesc').textContent = (activeWo.component_name||'')+(activeWo.unit_name?' · '+activeWo.unit_name:'');
  document.getElementById('fKet').textContent = activeWo.keterangan ? '📝 '+activeWo.keterangan : '';
  document.getElementById('fKet').style.display = activeWo.keterangan ? 'block' : 'none';
  document.getElementById('fStart').value=''; document.getElementById('fEnd').value='';
  document.getElementById('fHm').value=''; document.getElementById('fKm').value='';
  document.getElementById('fPart').value='';
  showModal('submitModal');
}
function queueSubmit() {
  var st=document.getElementById('fStart').value, en=document.getElementById('fEnd').value;
  var hm=parseFloat(document.getElementById('fHm').value), km=parseFloat(document.getElementById('fKm').value);
  var part=document.getElementById('fPart').value;
  if (!st||!en) { toast('Jam mulai & selesai wajib'); return; }
  if (new Date(en)<=new Date(st)) { toast('Jam selesai harus setelah mulai'); return; }
  if (isNaN(hm)||hm<=0) { toast('Hour Meter wajib > 0'); return; }
  if (isNaN(km)||km<=0) { toast('Kilometer wajib > 0'); return; }
  var op = { op_id:uuid(), action:'submit_work', wo_id:activeWo.id, wo_number:activeWo.wo_number,
    payload:{wo_id:activeWo.id, start_time:new Date(st).toISOString(), end_time:new Date(en).toISOString(), hour_meter:hm, kilometers:km, part_category:part},
    status:'queued', created_at:new Date().toISOString() };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('submitModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan! Terkirim saat ada sinyal');
    syncNow(false);
  });
}

/* ── M2: Create WO form ── */
function openCreateForm() {
  if (!S.refs) {
    if (navigator.onLine) {
      toast('⏳ Memuat data referensi...');
      pullRefs().then(function(){ if (S.refs) openCreateForm(); else toast('❌ Gagal memuat referensi'); })
        .catch(function(){ toast('❌ Gagal memuat referensi'); });
    } else { toast('📴 Sync dulu saat ada sinyal untuk memuat referensi'); }
    return;
  }
  // Refs basi / tanpa work_conditions → refresh senyap (sembuhkan cache lama)
  if (navigator.onLine && (refsStale() || !(S.refs.work_conditions && S.refs.work_conditions.length))) { pullRefs().catch(function(){}); }
  // reset form
  var secs = S.refs.sections || [];
  var secHtml = '';
  for (var si=0;si<secs.length;si++) {
    var icons = {tyreman:'🛢️',field:'🚜',workshop:'🏭'};
    secHtml += '<label class="secOpt"><input type="radio" name="cSec" value="'+secs[si]+'"'+(si===0?' checked':'')+'>'+
               '<span class="secCard">'+(icons[secs[si]]||'')+' '+secs[si]+'</span></label>';
  }
  document.getElementById('cSecPicker').innerHTML = secHtml;
  document.getElementById('cWc').innerHTML = '';
  // Fallback bawaan bila refs basi/kosong → dropdown SELALU terisi (key stabil).
  // Factor uang TETAP dihitung server dari Config_Factors, bukan dari sini.
  var wcs = (S.refs && S.refs.work_conditions && S.refs.work_conditions.length)
    ? S.refs.work_conditions
    : [{key:'normal',label:'Shift 1'},{key:'difficult',label:'Shift 2'},{key:'extreme',label:'Kondisi Ekstrim'}];
  for (var wi=0;wi<wcs.length;wi++) {
    document.getElementById('cWc').innerHTML += '<option value="'+esc(wcs[wi].key||wcs[wi].value||wcs[wi])+'">'+esc(wcs[wi].label||wcs[wi])+'</option>';
  }
  document.getElementById('cKet').value='';
  ['cOthersDesc','cOthersBp','cOthersTh','cOthersUf'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('cTeamList').innerHTML='';
  S.crossFunc=false; var _cf=document.getElementById('cCrossFunc'); if(_cf) _cf.checked=false;
  addTeamMember();
  onCreateSectionChange();
  // listeners
  var radios = document.querySelectorAll('input[name="cSec"]');
  for (var ri=0;ri<radios.length;ri++) radios[ri].onchange = onCreateSectionChange;
  showModal('createModal');
}
function onCompChange() {
  var isOthers = document.getElementById('cComp').value === 'COM-OTHERS';
  document.getElementById('cOthersWrap').style.display = isOthers ? 'block' : 'none';
  document.getElementById('cTyreUnit').parentNode.style.display = isOthers ? 'none' : 'block';
  updateCreatePreview();
}
function updateCreatePreview(){
  var box=document.getElementById('cPreview'); if(!box) return;
  var sec=getCreateSection();
  var ocEl=document.getElementById('cOthersCheck');
  var isOthers = ocEl && ocEl.checked;
  var bp=null, ph=null, uf=1.0, name='';
  if (isOthers) {
    bp=parseFloat(document.getElementById('cOthersBp').value)||0;
    ph=parseFloat(document.getElementById('cOthersTh').value)||0;
    uf=parseFloat(document.getElementById('cOthersUf').value)||0;
    name=document.getElementById('cOthersDesc').value||'Others';
  } else if (sec==='tyreman') {
    var cv=document.getElementById('cComp').value;
    var comps=(S.refs&&S.refs.components)||[];
    for(var i=0;i<comps.length;i++){ if(String(comps[i].component_no)===cv){ bp=parseFloat(comps[i].base_points)||0; ph=parseFloat(comps[i].target_hours)||0; name=comps[i].component_name; break; } }
    uf=1.0;
  } else {
    var js=document.getElementById('cCasJob'); var opt=js.options[js.selectedIndex];
    if(opt&&opt.value){ bp=parseFloat(opt.getAttribute('data-bp'))||0; ph=parseFloat(opt.getAttribute('data-ph'))||0; name=opt.textContent; }
    if(sec==='field'){ var uv=document.getElementById('cUnit').value; var units=(S.refs&&S.refs.units)||[]; for(var u=0;u<units.length;u++){ if(String(units[u].unit_id)===uv){ uf=parseFloat(units[u].unit_factor)||1.0; break; } } }
    else uf=1.0; // workshop placeholder
  }
  if (bp===null && ph===null) { box.style.display='none'; return; }
  var wcSel=document.getElementById('cWc'); var wcOpt=wcSel.options[wcSel.selectedIndex];
  document.getElementById('cPreviewBody').innerHTML =
    '<b>'+esc(name||'-')+'</b><br>Base Points: '+(bp||0)+' · Target: '+(ph||0)+' jam<br>Unit Factor: '+(uf||1)+' 🔒 · Kondisi: '+esc(wcOpt?wcOpt.textContent:'-');
  box.style.display='block';
}
function onPwaOthersToggle() {
  var checked = document.getElementById('cOthersCheck').checked;
  document.getElementById('cOthersWrap').style.display = checked ? 'block' : 'none';
  if (checked) {
    // Job manual: sembunyikan SEMUA picker katalog (tyreman & cascade), pakai deskripsi
    document.getElementById('cTyreGroup').style.display = 'none';
    document.getElementById('cCascadeGroup').style.display = 'none';
  } else {
    onCreateSectionChange(); // kembalikan picker sesuai section
  }
  updateCreatePreview();
}
function onCreateSectionChange() {
  var sec = getCreateSection();
  var isTyre = (sec === 'tyreman');
  var isWs = (sec === 'workshop');
  // reset Others state
  document.getElementById('cOthersWrap').style.display = 'none';
  var othersCheckRow = document.getElementById('cOthersCheckRow');
  if (othersCheckRow) othersCheckRow.style.display = 'block'; // Others via centang di SEMUA section
  var othersCheck = document.getElementById('cOthersCheck');
  if (othersCheck) othersCheck.checked = false;
  document.getElementById('cTyreGroup').style.display = isTyre ? 'block' : 'none';
  document.getElementById('cCascadeGroup').style.display = isTyre ? 'none' : 'block';
  document.getElementById('cUnitGroup').style.display = (isTyre || isWs) ? 'none' : 'block';
  document.getElementById('cModelGroup').style.display = isWs ? 'block' : 'none';
  if (isTyre) {
    var cSel = document.getElementById('cComp');
    cSel.innerHTML = '<option value="">-- Pilih --</option>';
    var comps = S.refs.components || [];
    for (var ci=0;ci<comps.length;ci++) {
      if (String(comps[ci].component_no) === 'COM-OTHERS') continue; // Others lewat centang, bukan dropdown
      cSel.innerHTML += '<option value="'+esc(comps[ci].component_no)+'">'+esc(comps[ci].component_name)+'</option>';
    }
    populateTyreUnits();
  } else {
    populateCascadeRoot(sec);
  }
  refreshCreateMechanics();
  updateCreatePreview();
}
function getCreateSection() {
  var r = document.querySelector('input[name="cSec"]:checked');
  return r ? r.value : 'tyreman';
}
function populateTyreUnits() {
  var sel = document.getElementById('cTyreUnit');
  sel.innerHTML = '<option value="">-- Pilih Unit --</option>';
  var units = S.refs.units || [];
  for (var i=0;i<units.length;i++) sel.innerHTML += '<option value="'+esc(units[i].unit_id)+'">'+esc(units[i].unit_name)+' ('+esc(units[i].unit_type)+')</option>';
}
function populateCascadeRoot(sec) {
  var jobs = (sec==='workshop') ? (S.refs.jobs_workshop||[]) : (S.refs.jobs_field||[]);
  if (sec === 'field') {
    var validModels = {};
    for (var j=0;j<jobs.length;j++) validModels[jobs[j].unit_model] = true;
    var sel = document.getElementById('cUnit');
    sel.innerHTML = '<option value="">-- Pilih Unit --</option>';
    var units = S.refs.units||[];
    for (var u=0;u<units.length;u++) {
      if (!units[u].unit_model || !validModels[units[u].unit_model]) continue;
      sel.innerHTML += '<option value="'+esc(units[u].unit_id)+'" data-model="'+esc(units[u].unit_model)+'">'+esc(units[u].unit_name)+' ('+esc(units[u].unit_type)+')</option>';
    }
  } else {
    var models = {}; for (var mj=0;mj<jobs.length;mj++) models[jobs[mj].unit_model]=true;
    var mSel = document.getElementById('cModel');
    mSel.innerHTML = '<option value="">-- Pilih Model --</option>';
    for (var mk in models) mSel.innerHTML += '<option value="'+esc(mk)+'">'+esc(mk)+'</option>';
  }
  document.getElementById('cCasComp').innerHTML = '<option value="">-- Component --</option>';
  document.getElementById('cCasSub').innerHTML = '<option value="">-- Sub Component --</option>';
  document.getElementById('cCasJob').innerHTML = '<option value="">-- Job --</option>';
}
function onCasUnitOrModel() {
  var sec = getCreateSection();
  var jobs = (sec==='workshop') ? (S.refs.jobs_workshop||[]) : (S.refs.jobs_field||[]);
  var model = '';
  if (sec==='workshop') { model = document.getElementById('cModel').value; }
  else { var opt = document.getElementById('cUnit').options[document.getElementById('cUnit').selectedIndex]; model = opt ? (opt.getAttribute('data-model')||'') : ''; }
  var comps = {};
  for (var i=0;i<jobs.length;i++) { if (jobs[i].unit_model===model) comps[jobs[i].component]=true; }
  var sel = document.getElementById('cCasComp');
  sel.innerHTML = '<option value="">-- Component --</option>';
  for (var c in comps) sel.innerHTML += '<option value="'+esc(c)+'">'+esc(c)+'</option>';
  document.getElementById('cCasSub').innerHTML = '<option value="">-- Sub Component --</option>';
  document.getElementById('cCasJob').innerHTML = '<option value="">-- Job --</option>';
}
function onCasComp() {
  var sec = getCreateSection();
  var jobs = (sec==='workshop') ? (S.refs.jobs_workshop||[]) : (S.refs.jobs_field||[]);
  var model = sec==='workshop' ? document.getElementById('cModel').value : (document.getElementById('cUnit').options[document.getElementById('cUnit').selectedIndex]||{}).getAttribute('data-model')||'';
  var comp = document.getElementById('cCasComp').value;
  var subs = {};
  for (var i=0;i<jobs.length;i++) { if (jobs[i].unit_model===model && jobs[i].component===comp) subs[jobs[i].sub_component]=true; }
  var sel = document.getElementById('cCasSub');
  sel.innerHTML = '<option value="">-- Sub Component --</option>';
  for (var s in subs) sel.innerHTML += '<option value="'+esc(s)+'">'+esc(s)+'</option>';
  document.getElementById('cCasJob').innerHTML = '<option value="">-- Job --</option>';
}
function onCasSub() {
  var sec = getCreateSection();
  var jobs = (sec==='workshop') ? (S.refs.jobs_workshop||[]) : (S.refs.jobs_field||[]);
  var model = sec==='workshop' ? document.getElementById('cModel').value : (document.getElementById('cUnit').options[document.getElementById('cUnit').selectedIndex]||{}).getAttribute('data-model')||'';
  var comp = document.getElementById('cCasComp').value;
  var sub = document.getElementById('cCasSub').value;
  var sel = document.getElementById('cCasJob');
  sel.innerHTML = '<option value="">-- Job --</option>';
  for (var i=0;i<jobs.length;i++) {
    var j = jobs[i];
    if (j.unit_model===model && j.component===comp && j.sub_component===sub) {
      sel.innerHTML += '<option value="'+esc(j.job_id)+'" data-bp="'+j.base_point+'" data-ph="'+j.plan_hours+'">'+esc(j.job_description)+' ('+j.plan_hours+'jam · '+j.base_point+'pts)</option>';
    }
  }
}
function onCrossFuncToggle(){ var cf=document.getElementById('cCrossFunc'); S.crossFunc = !!(cf && cf.checked); refreshCreateMechanics(); }
function refreshCreateMechanics() {
  var sec = getCreateSection();
  var mechs = S.refs ? (S.refs.mechanics||[]) : [];
  var showAll = !!S.crossFunc;
  var rows = document.querySelectorAll('.cTeamSel');
  for (var r=0;r<rows.length;r++) {
    var cur = rows[r].value;
    rows[r].innerHTML = '<option value="">-- Pilih Mekanik --</option>';
    for (var m=0;m<mechs.length;m++) {
      var ms = String(mechs[m].section||'').toLowerCase();
      // Default: hanya mekanik section terpilih. Lintas fungsi → tampilkan semua (dgn tag section).
      if (!showAll && ms !== sec) continue;
      var tag = (ms && ms !== sec) ? ' ['+ms+']' : '';
      rows[r].innerHTML += '<option value="'+esc(mechs[m].mechanic_id)+'">'+esc(mechs[m].mechanic_name)+esc(tag)+'</option>';
    }
    rows[r].value = cur;
  }
}
function addTeamMember() {
  var div = document.createElement('div'); div.className = 'teamRow';
  div.innerHTML = '<select class="cTeamSel inp"></select><button type="button" class="mini gray" onclick="this.parentNode.remove()">✕</button>';
  document.getElementById('cTeamList').appendChild(div);
  refreshCreateMechanics();
}
function queueCreate(keepOpen) {
  var sec = getCreateSection();
  var wc = document.getElementById('cWc').value;
  if (!wc) { toast('Pilih work condition'); return; }
  var payload = { section:sec, work_condition:wc, keterangan:document.getElementById('cKet').value.trim(), location: sec==='workshop'?'workshop':'field' };
  var _oc = document.getElementById('cOthersCheck');
  var pwaOthers = !!(_oc && _oc.checked); // Others via centang, seragam semua section
  if (pwaOthers) {
    var odesc = document.getElementById('cOthersDesc').value.trim();
    var obp = parseFloat(document.getElementById('cOthersBp').value);
    var oth = parseFloat(document.getElementById('cOthersTh').value);
    var ouf = parseFloat(document.getElementById('cOthersUf').value);
    if (!odesc) { toast('Deskripsi job Others wajib diisi'); return; }
    if (isNaN(obp) || obp <= 0) { toast('Base points Others wajib > 0'); return; }
    if (isNaN(oth) || oth <= 0) { toast('Target hours Others wajib > 0'); return; }
    if (isNaN(ouf) || ouf <= 0) { toast('Unit factor Others wajib > 0'); return; }
    payload.component_id = 'COM-OTHERS';
    payload.others_description = odesc;
    payload.others_base_points = obp;
    payload.others_target_hours = oth;
    payload.others_unit_factor = ouf;
  } else if (sec === 'tyreman') {
    var comp = document.getElementById('cComp').value;
    var unit = document.getElementById('cTyreUnit').value;
    if (!comp) { toast('Pilih joblist tyreman'); return; }
    if (!unit) { toast('Pilih unit'); return; }
    payload.component_id = comp; payload.unit_id = unit;
  } else {
    var jobSel = document.getElementById('cCasJob');
    if (!jobSel.value) { toast('Pilih job dari katalog'); return; }
    payload.job_id = jobSel.value;
    if (sec === 'field') {
      var fUnit = document.getElementById('cUnit').value;
      if (!fUnit) { toast('Pilih unit'); return; }
      payload.unit_id = fUnit;
    }
  }
  // team
  var sels = document.querySelectorAll('.cTeamSel');
  var team=[],seen={};
  for (var i=0;i<sels.length;i++) {
    var mid = sels[i].value;
    if (!mid) continue;
    if (seen[mid]) { toast('Mekanik duplikat'); return; }
    seen[mid]=true; team.push({mechanic_id:mid});
  }
  if (!team.length) { toast('Tambah minimal 1 mekanik'); return; }
  payload.team = team;
  var op = { op_id:uuid(), action:'create_wo', payload:payload, status:'queued', created_at:new Date().toISOString(), label:'Buat WO '+sec };
  obPut(op).then(refreshOutbox).then(function() {
    renderAll();
    if (keepOpen) {
      resetCreateFieldsForNext();
      toast('📮 WO diantre — isi WO berikutnya (section & kondisi dipertahankan)');
    } else {
      closeModal('createModal');
      toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan! Terkirim saat ada sinyal');
    }
    syncNow(false);
  });
}
function resetCreateFieldsForNext(){
  document.getElementById('cKet').value='';
  ['cOthersDesc','cOthersBp','cOthersTh','cOthersUf'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  var oc=document.getElementById('cOthersCheck'); if(oc) oc.checked=false;
  document.getElementById('cTeamList').innerHTML='';
  addTeamMember();
  onCreateSectionChange(); // reset picker utk section aktif (section & kondisi dipertahankan)
}

/* ── M3: Approval ── */
var activeApproval = null;
var cancelWoId = null;
function openCancelForm(woId, woNumber){
  cancelWoId = woId;
  document.getElementById('cxDesc').textContent = woNumber || woId;
  document.getElementById('cxReason').value = '';
  showModal('cancelModal');
}
function queueCancel(){
  var reason = document.getElementById('cxReason').value.trim();
  if (!reason) { toast('Isi alasan pembatalan'); return; }
  var woNum = document.getElementById('cxDesc').textContent;
  var op = { op_id:uuid(), action:'cancel_wo', wo_id:cancelWoId, wo_number:woNum,
    payload:{ wo_id:cancelWoId, reason:reason }, status:'queued', created_at:new Date().toISOString(), label:'Batal '+woNum };
  obPut(op).then(refreshOutbox).then(function(){
    closeModal('cancelModal'); closeModal('approveModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan!');
    syncNow(false);
  });
}
function openApproveForm(woId) {
  activeApproval = null;
  for (var i=0;i<S.pending.length;i++) if (String(S.pending[i].id)===String(woId)) activeApproval=S.pending[i];
  if (!activeApproval) return;
  var a = activeApproval;
  document.getElementById('aTitle').textContent = a.wo_number;
  var atl = a.timeliness;
  document.getElementById('aDesc').innerHTML = '<b>'+esc(a.component_name||'-')+'</b>'+(a.is_others?' <span class="badge" style="background:#0ea5e9">OTHERS</span>':'')+'<br>'+
    (a.unit_name?'🚜 '+esc(a.unit_name)+'<br>':'')+
    '📍 Lokasi: '+esc(locLabel(a.location))+'<br>'+
    'Kondisi: '+esc(wcLabel(a.work_condition))+'<br>'+
    'Base Points: '+(a.base_points||0)+' pts<br>'+
    'Target: '+fmtJamMenit(a.target_hours)+' · Aktual: '+fmtJamMenit(a.actual_hours)+
    (atl ? ' ('+esc(atl.label)+' ×'+atl.factor+')' : '')+'<br>'+
    'Unit Factor: '+(a.unit_factor||1)+' 🔒<br>'+
    '🔧 Part: '+esc(partLabel(a.part_category))+
    (a.hour_meter ? '<br>HM: '+esc(a.hour_meter) : '')+(a.kilometers ? ' · KM: '+esc(a.kilometers) : '')+
    (a.created_by ? '<br>👤 Pembuat: '+esc(a.created_by) : '')+
    (a.keterangan ? '<br>📝 '+esc(a.keterangan) : '');
  document.getElementById('aTeam').textContent = 'Tim: '+(a.team||[]).map(function(t){return t.name;}).join(', ');
  document.getElementById('aStatus').textContent = 'Status: '+a.status;
  var isL2 = (a.status === 'pending_superintendent');
  document.getElementById('aBtnL1').style.display = isL2 ? 'none' : 'block';
  document.getElementById('aBtnL2').style.display = isL2 ? 'block' : 'none';
  document.getElementById('aNotes').value='';
  document.getElementById('aSafety').checked = false;
  document.getElementById('aMtbf').value = 'first_time';
  document.getElementById('aReason').value='';
  document.getElementById('aRejectSection').style.display='none';
  showModal('approveModal');
}
function toggleRejectSection() {
  var el = document.getElementById('aRejectSection');
  el.style.display = el.style.display==='none' ? 'block' : 'none';
}
function queueApprove(level) {
  var action = level===1 ? 'approve_l1' : 'approve_l2';
  var op = { op_id:uuid(), action:action, wo_id:activeApproval.id, wo_number:activeApproval.wo_number,
    payload:{ wo_id:activeApproval.id, notes:document.getElementById('aNotes').value, safety_incident:document.getElementById('aSafety').checked, mtbf_status:document.getElementById('aMtbf').value },
    status:'queued', created_at:new Date().toISOString(), label:(level===1?'L1':'L2')+' '+activeApproval.wo_number };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('approveModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan!');
    syncNow(false);
  });
}
function queueReject() {
  var reason = document.getElementById('aReason').value.trim();
  if (!reason) { toast('Isi alasan reject'); return; }
  var stage = activeApproval.status==='pending_superintendent' ? 'superintendent' : 'supervisor';
  var op = { op_id:uuid(), action:'reject', wo_id:activeApproval.id, wo_number:activeApproval.wo_number,
    payload:{ wo_id:activeApproval.id, stage:stage, reason:reason },
    status:'queued', created_at:new Date().toISOString(), label:'Reject '+activeApproval.wo_number };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('approveModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan!');
    syncNow(false);
  });
}

/* ── Outbox management ── */
function retryOp(opId) {
  obAll().then(function(items) {
    for (var i=0;i<items.length;i++) { if (items[i].op_id===opId) { items[i].status='failed_retry'; return obPut(items[i]); } }
  }).then(function() { syncNow(true); });
}
function discardOp(opId) {
  if (!confirm('Buang kiriman ini?')) return;
  obDel(opId).then(refreshOutbox).then(renderAll);
}

/* ── Modal ── */
function showModal(id) { document.getElementById(id).style.display='flex'; }
function closeModal(id) { document.getElementById(id).style.display='none'; }

/* ── Render ── */
function showScreen(nm) {
  document.getElementById('screen-login').style.display = nm==='login'?'block':'none';
  document.getElementById('screen-main').style.display = nm==='main'?'block':'none';
}
function esc(s) { return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function toast(msg) {
  var t=document.getElementById('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._h); t._h=setTimeout(function(){t.style.display='none';},3500);
}
function toggleOutboxDetail(){ S.showOutbox = !S.showOutbox; renderAll(); }
function opLabel(o){
  var names = {submit_work:'Submit', create_wo:'Buat WO', approve_l1:'L1', approve_l2:'L2', reject:'Reject'};
  var base = o.label || names[o.action] || o.action;
  if (o.wo_number && String(base).indexOf(o.wo_number)===-1) base += ' '+o.wo_number;
  return base;
}
function fmtDateTime(iso){
  if(!iso) return '-';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function badgeFor(wo,pendingOp) {
  if (pendingOp) {
    if (pendingOp.status==='queued') return ['📮 Antre','#b45309'];
    if (pendingOp.status==='failed') return ['❌ Ditolak','#b91c1c'];
    // 'done' TIDAK menimpa: pakai status asli WO agar berubah (Terkirim→L1→L2→Approved) setelah sync
  }
  var s=String(wo.status||'');
  if (s==='pending_mechanic_work') return ['📝 Perlu diisi','#1d4ed8'];
  if (s==='pending_supervisor') return ['⏳ L1','#7c3aed'];
  if (s==='pending_superintendent') return ['⏳ L2','#7c3aed'];
  if (s==='approved') return ['✅ Approved','#15803d'];
  return [s||'-','#475569'];
}
function renderAll() {
  var on=navigator.onLine;
  document.getElementById('netDot').style.background=on?'#22c55e':'#ef4444';
  document.getElementById('netText').textContent=on?'Online':'Offline';
  document.getElementById('syncBtn').textContent=S.syncing?'⏳':'🔄 Sync';
  document.getElementById('lastSync').textContent=S.lastSync?'Sync: '+new Date(S.lastSync).toLocaleString('id-ID'):'Belum sync';
  document.getElementById('meName').textContent=S.me?(S.me.name||S.me.mechanic_id):'';
  // tabs
  var isCreator = S.role!=='mechanic';
  // L1/L2 (approver): sembunyikan tab "WO Saya" — hanya Buat WO + Approval
  if (isCreator && S.tab==='wos') S.tab='approval';
  document.getElementById('tabBar').style.display = isCreator ? 'flex' : 'none';
  document.getElementById('tabWos').style.display = isCreator ? 'none' : '';
  document.getElementById('tabWos').className = 'tab'+(S.tab==='wos'?' active':'');
  document.getElementById('tabCreate').className = 'tab'+(S.tab==='create'?' active':'');
  document.getElementById('tabApproval').className = 'tab'+(S.tab==='approval'?' active':'');
  // outbox info — bisa diklik utk lihat WO mana yg mengantre + waktu masuk antrean
  var queued = S.outbox.filter(function(o){return o.status==='queued'||o.status==='failed_retry';});
  var oi = document.getElementById('outboxInfo');
  oi.textContent = queued.length ? ('📮 '+queued.length+' menunggu sinyal '+(S.showOutbox?'▲':'▼')) : '';
  var od = document.getElementById('outboxDetail');
  if (queued.length && S.showOutbox) {
    od.style.display='block';
    od.innerHTML = queued.map(function(o){
      return '<div class="card" style="padding:10px;margin-bottom:6px">'+
        '<b>'+esc(opLabel(o))+'</b>'+
        '<div class="sub" style="margin:2px 0 0">🕒 Masuk antrean: '+esc(fmtDateTime(o.created_at))+'</div>'+
        '</div>';
    }).join('');
  } else { od.style.display='none'; od.innerHTML=''; }
  // failed outbox
  var failHtml = '';
  S.outbox.filter(function(o){return o.status==='failed';}).forEach(function(o) {
    failHtml += '<div class="card err"><b>'+esc(opLabel(o))+'</b><br>'+esc(o.error||'-')+
      '<br><button class="mini" onclick="retryOp(\''+o.op_id+'\')">🔁 Coba lagi</button> '+
      '<button class="mini gray" onclick="discardOp(\''+o.op_id+'\')">🗑 Buang</button></div>';
  });
  document.getElementById('failedOps').innerHTML = failHtml;
  // content
  var content = document.getElementById('content');
  if (!isCreator || S.tab==='wos') { renderWos(content); }
  else if (S.tab==='create') { renderCreateTab(content); }
  else if (S.tab==='approval') { renderApprovalTab(content); }
}
function renderWos(el) {
  var opByWo={};
  S.outbox.forEach(function(o){if(o.wo_id&&(!opByWo[o.wo_id]||o.created_at>opByWo[o.wo_id].created_at))opByWo[o.wo_id]=o;});
  if (!S.wos.length) { el.innerHTML='<div class="empty">Belum ada kartu WO.<br>Tekan 🔄 Sync saat ada sinyal.</div>'; return; }
  var html='';
  S.wos.forEach(function(wo) {
    var op=opByWo[wo.id]; var b=badgeFor(wo,op);
    var canFill=String(wo.status)==='pending_mechanic_work'&&(!op||op.status==='failed');
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:'+b[1]+'">'+b[0]+'</span></div>'+
      '<div class="cardBody">'+esc(wo.component_name||'-')+(wo.unit_name?' · '+esc(wo.unit_name):'')+(wo.target_hours?' · '+wo.target_hours+' jam':'')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      (canFill?'<button class="big" onclick="openSubmitForm(\''+esc(String(wo.id))+'\')">✍️ Isi & Kirim</button>':'')+
      '</div>';
  });
  el.innerHTML=html;
}
function renderCreateTab(el) {
  if (!S.refs) { el.innerHTML='<div class="empty">Tekan 🔄 Sync untuk memuat data referensi.</div>'; return; }
  el.innerHTML='<button class="big" onclick="openCreateForm()" style="margin-bottom:12px">➕ Buat Work Order Baru</button>'+
    '<div class="sub">Data referensi: '+(S.refs.jobs_field||[]).length+' job field, '+(S.refs.jobs_workshop||[]).length+' job WS, '+(S.refs.components||[]).length+' komponen tyreman</div>';
}
function wcLabel(wc){ return wc==='normal'?'Shift 1':wc==='difficult'?'Shift 2':wc==='extreme'?'Kondisi Ekstrim':(wc||'-'); }
function partLabel(p){ return p==='baru'?'🆕 Sparepart Baru':p==='repair'?'🔧 Repair':p==='kanibal'?'♻️ Kanibal':(p||'Tanpa Part'); }
function locLabel(l){ return l==='field'?'Lapangan':l==='workshop'?'Bengkel':(l||'-'); }
function fmtJamMenit(h){
  h=parseFloat(h)||0;
  if(h<=0) return '-';
  var j=Math.floor(h), m=Math.round((h-j)*60);
  if(m===60){ j++; m=0; }
  if(j>0&&m>0) return j+' jam '+m+' menit';
  if(j>0) return j+' jam';
  return m+' menit';
}
function renderApprovalTab(el) {
  var subs = [['pending','✅ Pending',S.pending.length],['active','⏳ Aktif',S.active.length],['approved','🏆 Approved',S.approved.length]];
  var bar = '<div class="tabBar" style="display:flex;margin-bottom:12px">'+subs.map(function(s){
    return '<button class="tab'+(S.appSub===s[0]?' active':'')+'" onclick="switchAppSub(\''+s[0]+'\')">'+s[1]+' ('+s[2]+')</button>';
  }).join('')+'</div>';
  var body = S.appSub==='active' ? renderActiveList() : (S.appSub==='approved' ? renderApprovedList() : renderPendingList());
  el.innerHTML = bar + body;
}
function switchAppSub(sub){
  S.appSub = sub;
  if (sub==='approved' && !S.approved.length && navigator.onLine) { toast('⏳ Memuat approved...'); pullApproved().then(renderAll).catch(function(){}); }
  renderAll();
}
function fmtIdr(n){ n=parseFloat(n)||0; return n.toLocaleString('id-ID'); }
function teamStr(team){ return (team||[]).map(function(t){ return esc(t.name)+(t.email?' <span class="sub" style="display:inline;margin:0">('+esc(t.email)+')</span>':''); }).join(', '); }
function ovBadges(wo){ return (wo.has_override_spv?'<span class="badge" style="background:#4338ca">SPV override</span>':'')+(wo.has_override_supt?'<span class="badge" style="background:#7c3aed">SUPT override</span>':''); }
function cancelBtn(wo){ return '<button class="big secondary" onclick="openCancelForm(\''+esc(String(wo.id))+'\',\''+esc(String(wo.wo_number))+'\')">🗑 Batalkan WO</button>'; }
function renderPendingList(){
  if (!S.pending.length) return '<div class="empty">Tidak ada WO pending dalam scope Anda.</div>';
  var html='<div class="sub">'+S.pending.length+' WO menunggu approval</div>';
  S.pending.forEach(function(wo){
    var isL2 = wo.status==='pending_superintendent';
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    var tl = wo.timeliness;
    var tlBadge = tl ? '<span class="badge" style="background:'+(tl.status==='on_time'?'#15803d':tl.status==='late'?'#b45309':'#b91c1c')+'">⏱️ '+esc(tl.label)+' ×'+tl.factor+'</span>' : '';
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:'+(isL2?'#b45309':'#7c3aed')+'">'+(isL2?'⏳ L2':'⏳ L1')+'</span>'+
      '<span class="badge" style="background:#334155">'+esc(wo.section)+'</span>'+othersBadge+tlBadge+ovBadges(wo)+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b>'+(wo.unit_name?' · '+esc(wo.unit_name):'')+'<br>'+
      '📍 Lokasi: '+esc(locLabel(wo.location))+'<br>'+
      'Kondisi: '+esc(wcLabel(wo.work_condition))+' · Aktual: '+fmtJamMenit(wo.actual_hours)+' · Target: '+fmtJamMenit(wo.target_hours)+'<br>'+
      'Base: '+(wo.base_points||0)+' pts · Unit Factor: '+(wo.unit_factor||1)+' 🔒<br>'+
      '🔧 Part: '+esc(partLabel(wo.part_category))+
      (wo.hour_meter?' · HM: '+esc(wo.hour_meter):'')+(wo.kilometers?' · KM: '+esc(wo.kilometers):'')+
      '<br>👥 Tim: '+teamStr(wo.team)+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      '<button class="big" onclick="openApproveForm(\''+esc(String(wo.id))+'\')">📋 Review & Approve</button>'+cancelBtn(wo)+'</div>';
  });
  return html;
}
function renderActiveList(){
  if (!S.active.length) return '<div class="empty">Tidak ada WO aktif (belum di-submit mekanik).</div>';
  var html='<div class="sub">'+S.active.length+' WO aktif — belum di-submit mekanik</div>';
  S.active.forEach(function(wo){
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:#1d4ed8">📝 Belum diisi</span>'+
      (wo.section?'<span class="badge" style="background:#334155">'+esc(wo.section)+'</span>':'')+othersBadge+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b><br>'+
      '📍 Lokasi: '+esc(locLabel(wo.location))+'<br>'+
      'Kondisi: '+esc(wcLabel(wo.work_condition))+(wo.created_by?' · Pembuat: '+esc(wo.created_by):'')+'<br>'+
      '👥 Tim: '+(wo.team_names||[]).map(function(n){return esc(n);}).join(', ')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+cancelBtn(wo)+'</div>';
  });
  return html;
}
function renderApprovedList(){
  if (!S.approved.length) return '<div class="empty">Belum ada WO approved.<br>Tekan 🔄 Sync saat online.</div>';
  var html='<div class="sub">'+S.approved.length+' WO approved (maks 100 terbaru)</div>';
  S.approved.forEach(function(wo){
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    var safety = wo.safety_incident ? '<span class="badge" style="background:#b91c1c">SAFETY</span>' : '';
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:#15803d">✅ Approved</span>'+
      (wo.section?'<span class="badge" style="background:#334155">'+esc(wo.section)+'</span>':'')+othersBadge+safety+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b><br>'+
      '📍 Lokasi: '+esc(locLabel(wo.location))+'<br>'+
      'Poin: '+(wo.final_points||0)+' · Rp '+fmtIdr(wo.final_idr||0)+'<br>'+
      'Aktual: '+fmtJamMenit(wo.actual_hours)+(wo.part_category?' · 🔧 '+esc(partLabel(wo.part_category)):'')+
      (wo.created_at_str?' · '+esc(wo.created_at_str):'')+'<br>'+
      '👥 Tim: '+(wo.team_names||[]).map(function(n){return esc(n);}).join(', ')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+cancelBtn(wo)+'</div>';
  });
  return html;
}

/* ── Init ── */
window.addEventListener('online',function(){renderAll(); syncNow(false);});
window.addEventListener('offline',renderAll);
openDb().then(function() {
  return Promise.all([kvGet('token'),kvGet('me'),kvGet('wos'),kvGet('refs'),kvGet('pending'),kvGet('last_sync'),kvGet('role'),kvGet('refs_at'),kvGet('active'),kvGet('approved')]);
}).then(function(v) {
  S.token=v[0]||null; S.me=v[1]||null; S.wos=v[2]||[]; S.refs=v[3]||null; S.pending=v[4]||[]; S.lastSync=v[5]||null; S.role=v[6]||'mechanic'; S.refsAt=v[7]||null; S.active=v[8]||[]; S.approved=v[9]||[];
  return refreshOutbox();
}).then(function() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js');
    // Auto-reload SEKALI saat SW baru mengambil alih → update otomatis, user TIDAK perlu hapus cache.
    var _swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function() {
      if (_swReloaded) return; _swReloaded = true; window.location.reload();
    });
  }
  showScreen(S.token?'main':'login');
  renderAll();
  if (S.token && navigator.onLine) {
    // Refresh role dari server tiap buka (self-heal role lama yg salah — tanpa perlu logout/login).
    api('ping').then(function(r){
      if (r.success && r.result && r.result.role && r.result.role !== S.role) {
        S.role = r.result.role; kvSet('role', S.role); renderAll();
      }
    }).catch(function(){});
    syncNow(false);
  }
});
