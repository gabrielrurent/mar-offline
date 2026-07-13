/* ============================================================
   MAR Offline — M1 Mekanik + M2 Create + M3 Approval
   Prinsip: CACHE → ANTRE → SINKRON. Server selalu benar.
   ============================================================ */

var CONFIG = { API_URL: 'https://script.google.com/macros/s/AKfycbwdzTf6-YJq6zUVRns_cVUJaBXTJ6gVrkk8DIPMzvjv-44tJjt7UcjED7fqJUu9jbalAg/exec' };
var S = { token:null, me:null, role:null, wos:[], refs:null, pending:[], outbox:[], lastSync:null, syncing:false, tab:'wos' };
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
      if (S.role !== 'mechanic') { tasks.push(pullRefs()); tasks.push(pullPending()); }
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
    return kvSet('refs', S.refs);
  });
}
function pullPending() {
  return api('pull_pending').then(function(r) {
    if (!r.success) return;
    S.pending = (r.result && r.result.pending) || [];
    return kvSet('pending', S.pending);
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
        // deteksi role dari data mekanik
        var mechObj = null;
        // ping returns mechanic_id — cek apakah dia supervisor/superintendent lewat pull refs
        return kvSet('token',t).then(function() { return kvSet('me',S.me); })
          .then(function() { return api('pull_create_refs'); })
          .then(function(refR) {
            if (refR.success && refR.result && refR.result.refs) {
              S.refs = refR.result.refs;
              S.role = 'creator'; // bisa create = bukan mechanic biasa
              return kvSet('refs', S.refs);
            } else {
              S.role = 'mechanic';
            }
          })
          .catch(function() { S.role = 'mechanic'; })
          .then(function() { return kvSet('role',S.role); })
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
  if (!S.refs) { toast('Sync dulu untuk memuat data referensi'); return; }
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
  if (S.refs.work_conditions) {
    var wcs = S.refs.work_conditions;
    for (var wi=0;wi<wcs.length;wi++) {
      document.getElementById('cWc').innerHTML += '<option value="'+esc(wcs[wi].key||wcs[wi].value||wcs[wi])+'">'+esc(wcs[wi].label||wcs[wi])+'</option>';
    }
  }
  document.getElementById('cKet').value='';
  document.getElementById('cTeamList').innerHTML='';
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
}
function onPwaOthersToggle() {
  var checked = document.getElementById('cOthersCheck').checked;
  document.getElementById('cCascadeGroup').style.display = checked ? 'none' : 'block';
  document.getElementById('cOthersWrap').style.display = checked ? 'block' : 'none';
}
function onCreateSectionChange() {
  var sec = getCreateSection();
  var isTyre = (sec === 'tyreman');
  var isWs = (sec === 'workshop');
  // reset Others state
  document.getElementById('cOthersWrap').style.display = 'none';
  var othersCheckRow = document.getElementById('cOthersCheckRow');
  if (othersCheckRow) othersCheckRow.style.display = isTyre ? 'none' : 'block';
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
    for (var ci=0;ci<comps.length;ci++) cSel.innerHTML += '<option value="'+esc(comps[ci].component_no)+'">'+esc(comps[ci].component_name)+'</option>';
    populateTyreUnits();
  } else {
    populateCascadeRoot(sec);
  }
  refreshCreateMechanics();
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
function refreshCreateMechanics() {
  var sec = getCreateSection();
  var mechs = S.refs ? (S.refs.mechanics||[]) : [];
  var rows = document.querySelectorAll('.cTeamSel');
  for (var r=0;r<rows.length;r++) {
    var cur = rows[r].value;
    rows[r].innerHTML = '<option value="">-- Pilih Mekanik --</option>';
    for (var m=0;m<mechs.length;m++) {
      var ms = String(mechs[m].section||'').toLowerCase();
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
function queueCreate() {
  var sec = getCreateSection();
  var wc = document.getElementById('cWc').value;
  if (!wc) { toast('Pilih work condition'); return; }
  var payload = { section:sec, work_condition:wc, keterangan:document.getElementById('cKet').value.trim(), location: sec==='workshop'?'workshop':'field' };
  var pwaOthers = (sec === 'tyreman' && document.getElementById('cComp').value === 'COM-OTHERS') ||
                  (sec !== 'tyreman' && document.getElementById('cOthersCheck') && document.getElementById('cOthersCheck').checked);
  if (pwaOthers) {
    var odesc = document.getElementById('cOthersDesc').value.trim();
    var obp = parseFloat(document.getElementById('cOthersBp').value);
    var oth = parseFloat(document.getElementById('cOthersTh').value);
    if (!odesc) { toast('Deskripsi job Others wajib diisi'); return; }
    if (isNaN(obp) || obp <= 0) { toast('Base points Others wajib > 0'); return; }
    if (isNaN(oth) || oth <= 0) { toast('Target hours Others wajib > 0'); return; }
    payload.component_id = 'COM-OTHERS';
    payload.others_description = odesc;
    payload.others_base_points = obp;
    payload.others_target_hours = oth;
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
  var op = { op_id:uuid(), action:'create_wo', payload:payload, status:'queued', created_at:new Date().toISOString(), label:'Create '+sec+' WO' };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('createModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan! Terkirim saat ada sinyal');
    syncNow(false);
  });
}

/* ── M3: Approval ── */
var activeApproval = null;
function openApproveForm(woId) {
  activeApproval = null;
  for (var i=0;i<S.pending.length;i++) if (String(S.pending[i].id)===String(woId)) activeApproval=S.pending[i];
  if (!activeApproval) return;
  var a = activeApproval;
  document.getElementById('aTitle').textContent = a.wo_number;
  document.getElementById('aDesc').innerHTML = esc(a.component_name||'-')+'<br>'+esc(a.unit_name||'-')+' · target '+a.target_hours+' jam'+
    (a.actual_hours ? '<br>Aktual: '+a.actual_hours+' jam' : '')+(a.part_category ? '<br>Part: '+a.part_category : '')+
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
function badgeFor(wo,pendingOp) {
  if (pendingOp) {
    if (pendingOp.status==='queued') return ['📮 Antre','#b45309'];
    if (pendingOp.status==='failed') return ['❌ Ditolak','#b91c1c'];
    if (pendingOp.status==='done') return ['✅ Terkirim','#15803d'];
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
  document.getElementById('tabBar').style.display = isCreator ? 'flex' : 'none';
  document.getElementById('tabWos').className = 'tab'+(S.tab==='wos'?' active':'');
  document.getElementById('tabCreate').className = 'tab'+(S.tab==='create'?' active':'');
  document.getElementById('tabApproval').className = 'tab'+(S.tab==='approval'?' active':'');
  // outbox info
  var pend = S.outbox.filter(function(o){return o.status==='queued'||o.status==='failed_retry';}).length;
  document.getElementById('outboxInfo').textContent = pend?('📮 '+pend+' menunggu sinyal'):'';
  // failed outbox
  var failHtml = '';
  S.outbox.filter(function(o){return o.status==='failed';}).forEach(function(o) {
    failHtml += '<div class="card err"><b>'+(o.label||o.action)+' — '+(o.wo_number||'')+'</b><br>'+esc(o.error||'-')+
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
function renderApprovalTab(el) {
  if (!S.pending.length) { el.innerHTML='<div class="empty">Tidak ada WO pending dalam scope Anda.</div>'; return; }
  var html='<div class="sub">'+S.pending.length+' WO menunggu approval</div>';
  S.pending.forEach(function(wo) {
    var isL2 = wo.status==='pending_superintendent';
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:'+(isL2?'#b45309':'#7c3aed')+'">'+(isL2?'⏳ L2':'⏳ L1')+'</span>'+
      '<span class="badge" style="background:#334155">'+esc(wo.section)+'</span></div>'+
      '<div class="cardBody">'+esc(wo.component_name||'-')+(wo.unit_name?' · '+esc(wo.unit_name):'')+'<br>'+
      'Aktual: '+(wo.actual_hours||'-')+' jam · Target: '+wo.target_hours+' jam'+(wo.part_category?' · Part: '+wo.part_category:'')+
      '<br>Tim: '+(wo.team||[]).map(function(t){return t.name;}).join(', ')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      '<button class="big" onclick="openApproveForm(\''+esc(String(wo.id))+'\')">📋 Review & Approve</button></div>';
  });
  el.innerHTML=html;
}

/* ── Init ── */
window.addEventListener('online',function(){renderAll(); syncNow(false);});
window.addEventListener('offline',renderAll);
openDb().then(function() {
  return Promise.all([kvGet('token'),kvGet('me'),kvGet('wos'),kvGet('refs'),kvGet('pending'),kvGet('last_sync'),kvGet('role')]);
}).then(function(v) {
  S.token=v[0]||null; S.me=v[1]||null; S.wos=v[2]||[]; S.refs=v[3]||null; S.pending=v[4]||[]; S.lastSync=v[5]||null; S.role=v[6]||'mechanic';
  return refreshOutbox();
}).then(function() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  showScreen(S.token?'main':'login');
  renderAll();
  if (S.token && navigator.onLine) syncNow(false);
});
