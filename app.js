import * as pdfjsLib from './vendor/pdf.min.mjs';
import {pageItems, speciesText, leadText} from './book.js';
import {SUPABASE_URL, SUPABASE_KEY} from './config.js';
import {glossMatches} from './glossar.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $main = document.getElementById('main');
const $title = document.getElementById('title');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = d => d ? d.split('-').reverse().join('.') : '';
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const store = {
  get(k, d) { try { const v = localStorage.getItem('ph.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ph.' + k, JSON.stringify(v)); } catch {} }
};

/* ---------- IndexedDB ---------- */
let dbP = null;
function idb() {
  return dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('pilzhandbuch', 1);
    r.onupgradeneeded = () => { for (const s of ['files', 'txt', 'img', 'outbox', 'cache']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function dbGet(s, k) { const db = await idb(); return new Promise(res => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }); }
async function dbAll(s) { const db = await idb(); return new Promise(res => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); }
async function dbKeys(s) { const db = await idb(); return new Promise(res => { const q = db.transaction(s).objectStore(s).getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); }
async function dbPut(s, k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function dbDel(s, k) { const db = await idb(); return new Promise(res => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).delete(k); t.oncomplete = res; t.onerror = res; }); }
async function dbClear(s) { const db = await idb(); return new Promise(res => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).clear(); t.oncomplete = res; t.onerror = res; }); }

/* ---------- Buch-PDF (bleibt auf dem Gerät) ---------- */
const PDF_NAME = 'kosmos-handbuch-pilze.pdf';
async function opfsDir() { try { return await navigator.storage.getDirectory(); } catch { return null; } }
async function savePdf(file, onProgress) {
  const dir = await opfsDir();
  if (dir) {
    try {
      const fh = await dir.getFileHandle(PDF_NAME, {create: true});
      const w = await fh.createWritable();
      const CH = 8 << 20;
      for (let o = 0; o < file.size; o += CH) { await w.write(await file.slice(o, o + CH).arrayBuffer()); onProgress?.(Math.min(1, (o + CH) / file.size)); }
      await w.close();
      await dbDel('files', 'pdf');
      return;
    } catch (e) { console.warn('OPFS nicht nutzbar, nehme IndexedDB', e); }
  }
  await dbPut('files', 'pdf', file);
  onProgress?.(1);
}
async function loadPdfBlob() {
  const b = await dbGet('files', 'pdf');
  if (b) return b;
  const dir = await opfsDir();
  if (dir) { try { const fh = await dir.getFileHandle(PDF_NAME); const f = await fh.getFile(); if (f.size > 0) return f; } catch {} }
  return null;
}
async function removePdf() {
  await dbDel('files', 'pdf');
  const dir = await opfsDir(); if (dir) { try { await dir.removeEntry(PDF_NAME); } catch {} }
  await dbClear('txt'); await dbClear('img');
}
class BlobRange extends pdfjsLib.PDFDataRangeTransport {
  constructor(blob) { super(blob.size, null); this.blob = blob; }
  requestDataRange(begin, end) {
    this.blob.slice(begin, end).arrayBuffer().then(b => this.onDataRange(begin, new Uint8Array(b)));
  }
}
let doc = null;
async function openPdf(blob) {
  const task = pdfjsLib.getDocument({range: new BlobRange(blob), length: blob.size, disableAutoFetch: true, disableStream: true,
    rangeChunkSize: 1 << 18, isEvalSupported: false, enableXfa: false});
  const d = await task.promise;
  return d;
}
async function checkBook(d) {
  if (d.numPages !== IDX.fp.pages) return `Die Datei hat ${d.numPages} Seiten, erwartet sind ${IDX.fp.pages}. Ist das wirklich das eBook „Das Kosmos Handbuch Pilze“ (2023)?`;
  // Stichprobe: stehen die erwarteten Artnamen an den erwarteten Stellen?
  const probes = [IDX.species.find(s => s.p === 318), IDX.species[0], IDX.species[700]];
  for (const s of probes) {
    const it = await pageItems(d, s.p);
    const head = it.filter(x => x.y > s.hdr[1] && x.y < s.hdr[3] + 4).map(x => x.s).join('');
    if (!norm(head).replace(/ /g, '').includes(norm(s.de.split(',')[0]).replace(/ /g, ''))) return 'Die Datei passt nicht zu dieser App (andere Ausgabe des Buchs?). Gebraucht wird das eBook-PDF von 2023/24 mit 760 Seiten.';
  }
  return null;
}

/* ---------- Seiten-Text (Cache) ---------- */
const itemCache = new Map();
let pdfQueue = Promise.resolve();
function viaQueue(fn) { const p = pdfQueue.then(fn, fn); pdfQueue = p.catch(() => {}); return p; }
async function itemsOf(p) {
  if (itemCache.has(p)) return itemCache.get(p);
  const pr = pageItems(doc, p);
  itemCache.set(p, pr);
  if (itemCache.size > 40) itemCache.delete(itemCache.keys().next().value);
  return pr;
}
async function spText(id) {
  const key = 'sp:' + id;
  let t = await dbGet('txt', key);
  if (!t) { const s = IDX.species[id]; t = speciesText(await itemsOf(s.p), s); await dbPut('txt', key, t); }
  return t;
}
async function ldText(kid, step, l) {
  const key = `ld:${kid}:${step}${l.l}`;
  let t = await dbGet('txt', key);
  if (!t) { t = leadText(await itemsOf(l.p), l.box); await dbPut('txt', key, t); }
  return t;
}

/* ---------- Bilder aus dem PDF ---------- */
async function renderBox(p, box, cssW, maxPx = 2400) {
  const page = await doc.getPage(p + 1);
  const [x0, y0, x1, y1] = box;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(cssW * dpr / (x1 - x0), maxPx / Math.max(x1 - x0, y1 - y0));
  const c = document.createElement('canvas');
  c.width = Math.ceil((x1 - x0) * scale); c.height = Math.ceil((y1 - y0) * scale);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({canvasContext: ctx, viewport: page.getViewport({scale}), transform: [1, 0, 0, 1, -x0 * scale, -y0 * scale]}).promise;
  return c;
}
const toBlob = (c, q = .85) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
const urlCache = new Map();
// Vorschaubild einer Art: ganze Tafelseite einmal klein rendern und alle Arten darauf ausschneiden
const plateJobs = new Map();
async function thumbUrl(id) {
  const s = IDX.species[id];
  if (!s?.plate) return null;
  if (urlCache.has('th' + id)) return urlCache.get('th' + id);
  let b = await dbGet('img', 'th' + id);
  if (!b) {
    const pg = s.plate[0];
    if (!plateJobs.has(pg)) plateJobs.set(pg, viaQueue(async () => {
      const page = await doc.getPage(pg + 1);
      const scale = 0.9;
      const vp = page.getViewport({scale});
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({canvasContext: ctx, viewport: vp}).promise;
      for (const o of IDX.species.filter(o => o.plate && o.plate[0] === pg)) {
        const [x0, y0, x1, y1] = o.plate[1];
        const w = (x1 - x0) * scale, h = (y1 - y0) * scale, k = Math.min(1, 220 / Math.max(w, h));
        const t = document.createElement('canvas'); t.width = Math.round(w * k); t.height = Math.round(h * k);
        const tc = t.getContext('2d'); tc.fillStyle = '#fff'; tc.fillRect(0, 0, t.width, t.height);
        tc.drawImage(c, x0 * scale, y0 * scale, w, h, 0, 0, t.width, t.height);
        await dbPut('img', 'th' + o.id, await toBlob(t, .8));
      }
    }));
    await plateJobs.get(pg);
    b = await dbGet('img', 'th' + id);
    if (!b) return null;
  }
  const u = URL.createObjectURL(b); urlCache.set('th' + id, u); return u;
}
function lazyThumbs(root = $main) {
  const imgs = root.querySelectorAll('img[data-th]');
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; io.unobserve(e.target);
    thumbUrl(+e.target.dataset.th).then(u => { if (u) e.target.src = u; });
  }), {rootMargin: '300px'});
  imgs.forEach(i => io.observe(i));
}
async function glossCanvas(g, w = 76) { return viaQueue(() => renderBox(758, g.box, w)); }

/* ---------- Zoom ---------- */
const $zoom = document.getElementById('zoom'), $zin = document.getElementById('zoomin');
$zoom.querySelector('.x').onclick = () => history.back();
async function zoomBox(p, box) {
  openZoom('<div class="spinner"></div>');
  const c = await renderBox(p, box, Math.min(window.innerWidth * 2, 1600), 3600);
  c.style.width = Math.min(window.innerWidth * 1.6, c.width / (window.devicePixelRatio || 1)) + 'px';
  $zin.innerHTML = ''; $zin.append(c);
}
function zoomImg(src) { openZoom(`<img src="${esc(src)}" style="max-width:100%;margin-top:60px">`); }
function openZoom(html) { $zin.innerHTML = html; $zoom.classList.add('on'); history.pushState({zoom: 1}, ''); }
window.addEventListener('popstate', () => { if ($zoom.classList.contains('on')) { $zoom.classList.remove('on'); $zin.innerHTML = ''; } });

/* ---------- Index ---------- */
let IDX = null;
let LAT = new Map();
async function loadIndex() {
  IDX = await (await fetch('kosmos-index.json')).json();
  for (const s of IDX.species) {
    s.q = norm(s.de + ' ' + s.lat + ' ' + (s.syn || []).join(' '));
    LAT.set(norm(s.lat), s.id);
    for (const y of s.syn || []) if (!LAT.has(norm(y))) LAT.set(norm(y), s.id);
  }
  IDX.keyOfStep = {};
}
const deName = s => s.de.split(',')[0];
const RL = {'0': 'ausgestorben oder verschollen', '1': 'vom Aussterben bedroht', '2': 'stark gefährdet', '3': 'gefährdet', 'G': 'Gefährdung unbekannten Ausmaßes', 'R': 'extrem selten', 'V': 'Vorwarnliste', 'D': 'Daten unzureichend'};

/* ---------- Supabase ---------- */
const sb = SUPABASE_URL && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true,
  // keine geräteweite Sperre: verhindert, dass Abfragen nach einem Anmelde-Ereignis endlos warten
  lock: async (_name, _timeout, fn) => fn()}}) : null;
let session = null, profile = null;
async function initAuth() {
  if (!sb) return;
  window.__step = 'Anmeldung prüfen';
  try {
    const r = await Promise.race([sb.auth.getSession(), sleep(6000).then(() => ({data: {session: null}, timeout: true}))]);
    session = r.data?.session || null;
    if (r.timeout) console.warn('getSession Zeitüberschreitung');
  } catch (e) { console.warn('getSession', e); }
  sb.auth.onAuthStateChange((_e, s) => {
    session = s;
    // Supabase-Aufrufe nicht direkt im Callback starten (kann sonst blockieren)
    setTimeout(() => {
      if (s) { loadProfile(); loadComms(); sync(); const j = store.get('joinCode', null); if (j) location.hash = '#/beitreten/' + j; }
      else { profile = null; myComms = []; store.set('comms', []); }
    }, 0);
  });
  if (session) { loadProfile(); loadComms(); }
}
let myComms = store.get('comms', []);
async function loadComms() {
  if (!sb || !session) return (myComms = []);
  const {data, error} = await sb.from('mitglieder').select('rolle, communities(id, name)').eq('user_id', myId());
  if (!error) {
    myComms = (data || []).filter(x => x.communities).map(x => ({id: x.communities.id, name: x.communities.name, rolle: x.rolle})).sort((a, b) => a.name.localeCompare(b.name));
    store.set('comms', myComms);
  }
  return myComms;
}
const activeComm = () => myComms.find(c => c.id === store.get('aktivComm', null)) || myComms[0] || null;
const SICHT = {community: '👥', alle: '🌍', privat: '🔒'};
function sichtText(f) {
  if (f.sichtbarkeit === 'privat') return 'Nur für dich';
  if (f.sichtbarkeit === 'alle') return 'Für alle App-Nutzer*innen' + (f.communities?.name ? ` (aus ${f.communities.name})` : '');
  return 'Für die Community ' + (f.communities?.name || myComms.find(c => c.id === f.community_id)?.name || '');
}
async function loadProfile() {
  if (!sb || !session) return;
  const {data} = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  profile = data || {id: session.user.id, name: session.user.user_metadata?.name || ''};
  store.set('profile', profile);
}
const myId = () => session?.user?.id;
const signedCache = new Map();
async function signUrls(paths) {
  const need = [...new Set(paths)].filter(p => p && !signedCache.has(p));
  if (need.length && sb && navigator.onLine) {
    const {data} = await sb.storage.from('fotos').createSignedUrls(need, 60 * 60 * 6);
    for (const d of data || []) if (d.signedUrl) signedCache.set(d.path, d.signedUrl);
  }
  return paths.map(p => signedCache.get(p) || '');
}

/* ---------- Funde: lokale Warteschlange + Sync ---------- */
let syncing = false;
async function sync() {
  if (!sb || !session || syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const keys = await dbKeys('outbox');
    for (const k of keys) {
      const job = await dbGet('outbox', k);
      if (!job) continue;
      if (job.op === 'delete') {
        if (job.fotos?.length) await sb.storage.from('fotos').remove(job.fotos);
        const {error} = await sb.from('funde').delete().eq('id', job.id);
        if (error) throw error;
      } else {
        const paths = [...(job.row.fotos || [])];
        for (let i = 0; i < (job.neu || []).length; i++) {
          const path = `${myId()}/${job.id}/${Date.now().toString(36)}-${i}.jpg`;
          const {error} = await sb.storage.from('fotos').upload(path, job.neu[i], {contentType: 'image/jpeg', upsert: true});
          if (error) throw error;
          paths.push(path);
        }
        if (job.weg?.length) await sb.storage.from('fotos').remove(job.weg);
        const row = {...job.row, id: job.id, fotos: paths, updated_at: new Date().toISOString()};
        delete row.user_id;
        const {error} = await sb.from('funde').upsert(row);
        if (error) throw error;
      }
      await dbDel('outbox', k);
    }
  } catch (e) { console.warn('Sync fehlgeschlagen', e); }
  finally { syncing = false; }
}
window.addEventListener('online', sync);
async function pendingCount() { return (await dbKeys('outbox')).length; }

/* ---------- Ansichten ---------- */
let viewToken = 0;
function setView(title, html, tab) {
  $title.textContent = title; $main.innerHTML = html; window.scrollTo(0, 0);
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.t === tab));
}
const spinner = '<div class="spinner"></div>';
document.getElementById('back').onclick = () => { if (location.hash && location.hash !== '#/') history.back(); };
let fs = store.get('fs', 16);
document.documentElement.style.setProperty('--fs', fs + 'px');
document.getElementById('fsz').onclick = () => { fs = fs >= 22 ? 14 : fs + 2; store.set('fs', fs); document.documentElement.style.setProperty('--fs', fs + 'px'); };

function spItem(s, extra = '') {
  return `<li><a class="item" href="#/art/${s.id}"><img class="th" data-th="${s.id}" alt="">
    <span class="txt"><div class="de">${esc(deName(s))}${s.rl ? `<span class="badge">RL ${esc(s.rl)}</span>` : ''}${s.prot ? '<span class="badge">§</span>' : ''}</div>
    <div class="lat">${esc(s.lat)}</div>${extra}</span></a></li>`;
}

/* Start */
async function viewHome() {
  const pend = sb && session ? await pendingCount() : 0;
  const prog = store.get('ftProgress', 0);
  setView('Pilzhandbuch', `
    <a class="btn primary" href="#/k/0/1"><b>🔑 Pilz bestimmen</b></a>
    <div class="row">
      <a class="btn" href="#/arten"><b>📖 Arten</b><small>${IDX.species.length} Arten suchen</small></a>
      <a class="btn" href="#/merkmale"><b>✏️ Merkmale</b><small>Hutformen, Lamellen …</small></a>
    </div>
    <div class="sect">Schlüssel direkt</div>
    <div>${IDX.keys.filter(k => k.id > 0).map(k => `<a class="chip" href="#/k/${k.id}/1">${esc(k.title)}</a>`).join('')}</div>
    <div class="sect">Funde</div>
    <div class="row">
      <a class="btn" href="#/fund/neu"><b>＋ Neuer Fund</b><small>Mit Standort und Fotos</small></a>
      <a class="btn" href="#/funde"><b>📍 Funde ansehen</b><small>Community, alle, eigene · Liste und Karte</small></a>
    </div>
    ${pend ? `<div class="sync">${pend} Änderung(en) warten auf Netz und werden automatisch hochgeladen.</div>` : ''}
    ${!sb ? '<div class="note">Die Fund-Datenbank ist noch nicht eingerichtet.</div>' : !session ? '<div class="note">Für Funde brauchst du ein Konto: <a href="#/konto">Anmelden oder registrieren</a></div>' : ''}
    <div class="sect">Volltextsuche</div>
    <div id="ft">${prog >= 1 ? '<div class="tiny">Alle Artbeschreibungen sind für die Suche vorbereitet.</div>' : `<button class="btn" id="ftgo"><b>Volltextsuche vorbereiten</b><small>Liest einmalig alle Beschreibungen aus deinem PDF (dauert 1–3 Minuten).</small></button>`}</div>
    <div class="sect">Buch</div>
    <a class="btn" href="#/seite/758"><small>Abkürzungen & Merkmale (Innenklappe)</small></a>
    <a class="btn" href="#/seite/30"><small>Buchseite öffnen …</small></a>
    <p class="tiny">Begleit-App zum eBook „Das Kosmos Handbuch Pilze“ von Andreas Gminder und Peter Karasch (Kosmos 2023). Alle Texte und Bilder stammen aus deinem eigenen PDF und bleiben auf deinem Gerät. Die App ersetzt keine Pilzberatung: Vor dem Verzehr immer von Pilzsachverständigen prüfen lassen.</p>`, 'home');
  const b = document.getElementById('ftgo'); if (b) b.onclick = () => buildFulltext(document.getElementById('ft'));
}
let ftRunning = false;
async function buildFulltext(el) {
  if (ftRunning) return; ftRunning = true;
  const pages = [...new Set(IDX.species.map(s => s.p))];
  const have = new Set(await dbKeys('txt'));
  let i = 0;
  const show = () => { if (el && el.isConnected) el.innerHTML = `<div class="tiny">Lese Beschreibungen … ${Math.round(i / pages.length * 100)} %</div><div class="prog"><div style="width:${i / pages.length * 100}%"></div></div>`; };
  for (const p of pages) {
    const sps = IDX.species.filter(s => s.p === p && !have.has('sp:' + s.id));
    if (sps.length) {
      const it = await viaQueue(() => pageItems(doc, p));
      for (const s of sps) await dbPut('txt', 'sp:' + s.id, speciesText(it, s));
    }
    i++; if (i % 3 === 0) { show(); store.set('ftProgress', i / pages.length); await sleep(0); }
  }
  store.set('ftProgress', 1); ftRunning = false;
  if (el && el.isConnected) el.innerHTML = '<div class="tiny">Fertig: Die Suche unter „Arten“ durchsucht jetzt auch alle Beschreibungen.</div>';
}

/* Artenliste */
async function viewArten(q0 = '') {
  const ftReady = store.get('ftProgress', 0) >= 1;
  setView('Arten', `
    <input type="search" class="inp" id="q" placeholder="Name, lateinisch${ftReady ? ' oder Merkmal (z. B. Anisgeruch)' : ''} …" value="${esc(q0)}" autocomplete="off">
    <div id="filters"></div><div id="res"></div>`, 'arten');
  const qi = document.getElementById('q'), res = document.getElementById('res');
  const secs = [...new Set(IDX.species.map(s => s.sec))];
  let sec = store.get('artsec', '');
  const fl = document.getElementById('filters');
  const drawF = () => { fl.innerHTML = ['', ...secs].map(x => `<button class="chip ${x === sec ? 'on' : ''}" data-s="${esc(x)}">${esc(x || 'Alle')}</button>`).join(''); fl.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { sec = b.dataset.s; store.set('artsec', sec); drawF(); draw(); }); };
  let texts = null;
  const draw = async () => {
    const t = norm(qi.value).split(' ').filter(Boolean);
    history.replaceState(null, '', '#/arten' + (qi.value ? '?q=' + encodeURIComponent(qi.value) : ''));
    let xs = IDX.species.filter(s => !sec || s.sec === sec);
    let ftHits = [];
    if (t.length) {
      const nameHits = xs.filter(s => t.every(w => s.q.includes(w)));
      if (ftReady && qi.value.trim().length >= 3) {
        texts ||= new Map((await Promise.all(IDX.species.map(async s => [s.id, (await dbGet('txt', 'sp:' + s.id))?.text || '']))).map(([k, v]) => [k, norm(v)]));
        const nh = new Set(nameHits.map(s => s.id));
        ftHits = xs.filter(s => !nh.has(s.id) && t.every(w => texts.get(s.id).includes(w)));
      }
      xs = nameHits;
    }
    let html = '';
    if (!t.length) {
      let last = null;
      for (const s of xs) { const g = s.sec + (s.sub ? ' · ' + s.sub : ''); if (g !== last) { html += `${last ? '</ul>' : ''}<div class="sect">${esc(g)}</div><ul class="list">`; last = g; } html += spItem(s); }
      html += '</ul>';
    } else {
      html = `<ul class="list">${xs.slice(0, 200).map(s => spItem(s)).join('')}</ul>`;
      if (ftHits.length) html += `<div class="sect">Im Beschreibungstext (${ftHits.length})</div><ul class="list">${ftHits.slice(0, 150).map(s => spItem(s, `<div class="tiny">${snippet(texts.get(s.id), t)}</div>`)).join('')}</ul>`;
      if (!xs.length && !ftHits.length) html = `<div class="note">Nichts gefunden.${ftReady ? '' : ' Tipp: Auf der Startseite die Volltextsuche vorbereiten, dann findest du auch Merkmale.'}</div>`;
    }
    res.innerHTML = html; lazyThumbs(res);
  };
  let tm; qi.oninput = () => { clearTimeout(tm); tm = setTimeout(draw, 180); };
  drawF(); draw();
}
function snippet(text, words) {
  const i = text.indexOf(words[0]); if (i < 0) return '';
  return '… ' + esc(text.slice(Math.max(0, i - 40), i + 70)) + ' …';
}

/* Art */
async function viewArt(id) {
  const s = IDX.species[id]; if (!s) return viewHome();
  const tok = ++viewToken;
  setView(deName(s), `<div class="art">
    <div class="tiny">${esc(s.sec)}${s.sub ? ' · ' + esc(s.sub) : ''} · S. ${s.p}</div>
    <h2>${esc(s.de)}</h2>
    <div class="latn">${esc(s.lat)}${s.syn?.length ? ` <span class="tiny">(Syn. ${esc(s.syn.join(', '))})</span>` : ''}</div>
    <div style="margin-top:6px"><span id="icons"></span>
      ${s.rl ? `<span class="badge" title="Rote Liste">RL ${esc(s.rl)}</span> <span class="tiny">${esc(RL[s.rl] || '')}</span>` : ''}
      ${s.prot ? '<span class="badge">§</span> <span class="tiny">gesetzlich geschützt</span>' : ''}</div>
    <div id="plate">${s.plate ? '<div class="spinner"></div>' : ''}</div>
    <div class="btext" id="txt">${spinner}</div>
    <div class="row"><a class="btn center" href="#/fund/neu/${s.id}"><b>＋ Fund speichern</b></a><a class="btn center" href="#/seite/${s.p}"><b>Buchseite</b></a></div>
    <div id="artfunde"></div>
    <div class="row">${id > 0 ? `<a class="btn center" href="#/art/${id - 1}">‹ ${esc(deName(IDX.species[id - 1]))}</a>` : ''}${id < IDX.species.length - 1 ? `<a class="btn center" href="#/art/${id + 1}">${esc(deName(IDX.species[id + 1]))} ›</a>` : ''}</div>
  </div>`, 'arten');
  // Symbole (Speisewert, Lebensweise) als Ausschnitt aus dem Buch
  viaQueue(() => renderBox(s.p, [287, s.hdr[1] - 2, 348, s.hdr[3] + 2], 64)).then(c => { if (tok !== viewToken) return; c.className = 'icons'; c.style.height = '34px'; c.style.width = 'auto'; document.getElementById('icons')?.append(c); });
  if (s.plate) viaQueue(() => renderBox(s.plate[0], s.plate[1], Math.min(window.innerWidth - 28, 700))).then(c => {
    if (tok !== viewToken) return;
    c.className = 'plate'; c.style.width = '100%'; c.style.height = 'auto';
    c.onclick = () => zoomBox(s.plate[0], s.plate[1]);
    const el = document.getElementById('plate'); el.innerHTML = ''; el.append(c);
  });
  const t = await spText(id);
  if (tok !== viewToken) return;
  document.getElementById('txt').innerHTML = linkLatin(t.html, s);
  artFunde(s, tok);
}
function linkLatin(html, s) {
  const genus = s.lat.split(' ')[0];
  return html.replace(/<i>([^<]+)<\/i>/g, (m, inner) => {
    const txt = inner.trim();
    let id = LAT.get(norm(txt));
    if (id == null) {
      const mm = txt.match(/^([A-Z][a-z]*)\.\s*([a-z-]+)/);
      if (mm) {
        const cands = IDX.species.filter(o => o.lat.startsWith(mm[1]) && norm(o.lat).split(' ')[1] === norm(mm[2]));
        id = (cands.find(o => o.lat.startsWith(genus + ' ')) || cands[0])?.id;
      } else {
        const full = IDX.species.find(o => norm(o.lat).startsWith(norm(txt)) && norm(txt).split(' ').length >= 2);
        id = full?.id;
      }
    }
    return id != null && id !== s.id ? `<a class="ref" href="#/art/${id}"><i>${inner}</i></a>` : m;
  });
}

/* Schlüssel */
function parseTrail(str) { return (str || '').split('~').filter(Boolean).map(x => { const [k, st, l] = x.split('.'); return {k: +k, s: +st, l}; }); }
const trailStr = tr => tr.map(t => `${t.k}.${t.s}.${t.l}`).join('~');
const glossFor = text => glossMatches(text).map(i => IDX.gloss[i]).filter(Boolean);
// Gruppenübersicht (Innenklappe, S. 759): Zeilen je Pilzgruppe
const GROUP_ROWS = [[42, 100], [100, 155], [155, 210], [210, 265], [265, 320], [320, 375], [375, 430], [430, 485], [485, 537]];
const GROUP_OF = [['Röhrlinge', 0], ['Blätterpilze', 1], ['Milchlinge', 2], ['Täublinge', 2], ['Porlinge', 3], ['Rindenpilze', 4], ['Nichtblätterpilze', 5], ['Gallertpilze', 5],
  ['Bauchpilze', 6], ['Hypogäen', 6], ['Schlauchpilze', 7], ['Operculate', 7], ['Inoperculate', 7], ['Pyrenomyceten', 7], ['Phytoparasiten', 8]];
function groupRow(l) {
  for (const g of l.go) {
    const name = g.k != null ? IDX.keys[g.k].title : g.sp ? IDX.species[g.sp[0]].sec : null;
    const hit = name && GROUP_OF.find(([n]) => name.startsWith(n));
    if (hit) return GROUP_ROWS[hit[1]];
  }
  return null;
}
async function viewKey(kid, step, trailS) {
  const k = IDX.keys[kid]; if (!k) return viewHome();
  const leads = k.steps[step]; if (!leads) return viewKey(kid, 1, trailS);
  const trail = parseTrail(trailS);
  const tok = ++viewToken;
  const trailHtml = trail.map((t, i) => {
    const pre = (i === 0 ? t.k !== kid || trail.some(x => x.k !== t.k) : trail[i - 1].k !== t.k) ? esc(IDX.keys[t.k].title.split(/[ ,]/)[0]) + ' ' : '';
    return `<a class="chip" href="#/k/${t.k}/${t.s}/${trailStr(trail.slice(0, i))}">${pre}${t.s}${t.l}</a>`;
  }).join('<span class="muted">›</span>');
  const curPre = trail.length && trail[trail.length - 1].k !== kid ? esc(k.title.split(/[ ,]/)[0]) + ' ' : '';
  setView(k.title, `
    <div class="trail">${trailHtml}${trail.length ? '<span class="muted">›</span>' : ''}<span class="chip on">${curPre}${step}</span></div>
    <div class="tiny">${esc(k.title)} · Schritt ${step} · S. ${leads[0].p}</div>
    <div id="leads">${leads.map((l, i) => `<div class="card lead" data-i="${i}"><span class="ll">${step}${l.l}</span><div class="lt">${spinner}</div><div class="gl"></div><div class="ex"></div><div class="go"></div></div>`).join('')}</div>
    <div class="row"><a class="btn center" href="#/seite/${leads[0].p}">Schlüsselseite im Buch</a>${kid !== 0 ? `<a class="btn center" href="#/k/${kid}/1">Neu beginnen</a>` : ''}</div>`, 'k');
  const cards = $main.querySelectorAll('.lead');
  leads.forEach(async (l, i) => {
    const card = cards[i];
    const t = await ldText(kid, step, l);
    if (tok !== viewToken) return;
    card.querySelector('.lt').innerHTML = t.html;
    const nextTrail = trailStr([...trail, {k: kid, s: step, l: l.l}]);
    const links = [];
    for (const g of l.go) {
      if (g.s != null) links.push({href: `#/k/${kid}/${g.s}/${nextTrail}`, label: `weiter zu ${g.s}`});
      else if (g.k != null) links.push({href: `#/k/${g.k}/1/${nextTrail}`, label: `Schlüssel ${IDX.keys[g.k].title}`});
      else if (g.sp) {
        if (g.sp.length === 1) links.push({href: `#/art/${g.sp[0]}`, label: deName(IDX.species[g.sp[0]])});
        else links.push({href: `#/liste/${g.sp.join(',')}/${encodeURIComponent((t.text.split('→').pop() || '').replace(/,?\s*S\.\s*\d+.*/, '').trim())}`, label: `${g.sp.length} Arten ansehen`});
      }
    }
    const go = card.querySelector('.go');
    if (!links.length) { card.classList.add('leaf'); go.innerHTML = '<span class="tiny">Diese Art wird im Buch nicht ausführlich beschrieben.</span>'; }
    else if (links.length === 1) { card.onclick = e => { if (!e.target.closest('a,figure')) location.hash = links[0].href; }; go.innerHTML = `<a class="chip on" href="${links[0].href}">${esc(links[0].label)} ›</a>`; }
    else go.innerHTML = links.map(x => `<a class="chip on" href="${x.href}">${esc(x.label)} ›</a>`).join('');
    // Beispielarten
    if (l.ex?.length) {
      card.querySelector('.ex').innerHTML = l.ex.map(id => `<a href="#/art/${id}"><img data-th="${id}" alt="">${esc(deName(IDX.species[id]))}</a>`).join('') + (l.cnt > 1 ? `<span class="tiny" style="align-self:center;flex:0 0 auto">führt zu ${l.cnt} Arten</span>` : '');
      lazyThumbs(card);
    }
    // Merkmalszeichnungen
    if (kid <= 1) {
      const row = groupRow(l);
      if (row) viaQueue(() => renderBox(759, [52, row[0], 345, row[1]], 300)).then(c => {
        if (tok !== viewToken) return;
        c.style.cssText = 'width:100%;max-width:340px;height:auto;display:block;margin-top:8px;border-radius:8px;background:#fff';
        card.querySelector('.gl').before(c);
      });
    }
    const gs = glossFor(t.text);
    const glEl = card.querySelector('.gl');
    for (const g of gs) {
      const f = document.createElement('figure'); f.innerHTML = '<div style="width:76px;height:60px"></div>'; f.title = g.t; f.setAttribute('aria-label', 'Zeichnung: ' + g.t); glEl.append(f);
      f.onclick = e => { e.stopPropagation(); zoomBox(758, g.box); };
      glossCanvas(g).then(c => { if (tok === viewToken) f.firstChild.replaceWith(c); });
    }
  });
}
async function viewListe(ids, title) {
  const xs = ids.split(',').map(Number).map(i => IDX.species[i]).filter(Boolean);
  setView(title || 'Ergebnis', `<div class="tiny">${xs.length} Arten aus diesem Zweig des Schlüssels</div><ul class="list">${xs.map(s => spItem(s)).join('')}</ul>`, 'k');
  lazyThumbs();
}

/* Merkmale */
function viewMerkmale() {
  const cats = [...new Set(IDX.gloss.map(g => g.cat))];
  setView('Merkmale', cats.map(c => `<div class="sect">${esc(c)}</div><div class="gloss-grid">${IDX.gloss.map((g, i) => [g, i]).filter(([g]) => g.cat === c).map(([g, i]) => `<figure data-g="${i}" aria-label="${esc(g.t)}"><div style="height:76px"></div></figure>`).join('')}</div>`).join('') +
    '<a class="btn center" href="#/seite/758">Ganze Seite ansehen</a>', 'home');
  const tok = ++viewToken;
  $main.querySelectorAll('[data-g]').forEach(f => {
    const g = IDX.gloss[+f.dataset.g];
    f.onclick = () => zoomBox(758, g.box);
    glossCanvas(g, 100).then(c => { if (tok === viewToken) f.firstChild.replaceWith(c); });
  });
}

/* Buchseite */
async function viewSeite(p) {
  p = Math.max(0, Math.min(IDX.fp.pages - 1, p));
  setView('Seite ' + p, `<div class="row"><a class="btn center" href="#/seite/${p - 1}">‹ ${p - 1}</a><a class="btn center" href="#/seite/${p + 1}">${p + 1} ›</a></div>
    <div class="pagewrap" id="pg">${spinner}</div><p class="tiny">Tippen zum Vergrößern.</p>`, 'home');
  const tok = ++viewToken;
  const page = await doc.getPage(p + 1);
  const box = [0, 0, page.view[2], page.view[3]];
  const c = await viaQueue(() => renderBox(p, box, Math.min(window.innerWidth - 28, 700)));
  if (tok !== viewToken) return;
  c.style.width = '100%'; c.onclick = () => zoomBox(p, box);
  const el = document.getElementById('pg'); el.innerHTML = ''; el.append(c);
}

/* Konto */
async function viewKonto() {
  if (!sb) return setView('Konto', '<div class="note">Die Fund-Datenbank ist noch nicht eingerichtet.</div>', 'konto');
  if (!session) {
    const mode = store.get('authmode', 'login');
    setView('Konto', `
      <div><button class="chip ${mode === 'login' ? 'on' : ''}" data-m="login">Anmelden</button><button class="chip ${mode === 'reg' ? 'on' : ''}" data-m="reg">Registrieren</button></div>
      <div class="card">
        ${mode === 'reg' ? '<label class="tiny">Name (sehen die anderen bei deinen Funden)</label><input class="inp" id="name" autocomplete="nickname">' : ''}
        <label class="tiny">E-Mail</label><input class="inp" id="mail" type="email" autocomplete="email">
        <label class="tiny">Passwort${mode === 'reg' ? ' (mindestens 8 Zeichen)' : ''}</label><input class="inp" id="pw" type="password" autocomplete="${mode === 'reg' ? 'new-password' : 'current-password'}">
        <button class="btn primary" id="go">${mode === 'reg' ? 'Konto anlegen' : 'Anmelden'}</button>
        ${mode === 'login' ? '<button class="btn center" id="reset"><small>Passwort vergessen?</small></button>' : ''}
        <div id="msg" class="tiny"></div>
      </div>
      <p class="tiny">Alle angemeldeten Mitglieder sehen alle Funde mit genauem Standort, Fotos und Namen.</p>`, 'konto');
    $main.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { store.set('authmode', b.dataset.m); viewKonto(); });
    const msg = document.getElementById('msg');
    document.getElementById('go').onclick = async () => {
      const email = document.getElementById('mail').value.trim(), password = document.getElementById('pw').value;
      msg.textContent = '…';
      if (mode === 'reg') {
        const name = document.getElementById('name').value.trim();
        if (!name) return msg.textContent = 'Bitte einen Namen angeben.';
        if (password.length < 8) return msg.textContent = 'Das Passwort braucht mindestens 8 Zeichen.';
        const {data, error} = await sb.auth.signUp({email, password, options: {data: {name}, emailRedirectTo: location.origin + location.pathname}});
        if (error) return msg.textContent = 'Fehler: ' + error.message;
        if (!data.session) msg.textContent = 'Fast geschafft: Bitte bestätige deine E-Mail-Adresse über den Link, den du gleich bekommst. Danach kannst du dich hier anmelden.';
        else location.hash = store.get('joinCode', null) ? '#/beitreten/' + store.get('joinCode', null) : '#/funde';
      } else {
        const {error} = await sb.auth.signInWithPassword({email, password});
        if (error) return msg.textContent = error.message.includes('Invalid') ? 'E-Mail oder Passwort stimmt nicht.' : 'Fehler: ' + error.message;
        location.hash = store.get('joinCode', null) ? '#/beitreten/' + store.get('joinCode', null) : '#/funde';
      }
    };
    const r = document.getElementById('reset');
    if (r) r.onclick = async () => {
      const email = document.getElementById('mail').value.trim();
      if (!email) return msg.textContent = 'Bitte zuerst die E-Mail-Adresse eintragen.';
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname + '#/konto'});
      msg.textContent = error ? 'Fehler: ' + error.message : 'Wenn es ein Konto gibt, kommt gleich eine E-Mail mit einem Link.';
    };
    return;
  }
  await loadProfile();
  const pend = await pendingCount();
  setView('Konto', `<div class="card">
      <div class="tiny">Angemeldet als ${esc(session.user.email)}</div>
      <label class="tiny">Dein Name</label><input class="inp" id="name" value="${esc(profile?.name || '')}">
      <button class="btn center" id="save">Name speichern</button>
      <label class="tiny">Neues Passwort</label><input class="inp" id="pw" type="password" autocomplete="new-password">
      <button class="btn center" id="pwsave">Passwort ändern</button>
      <div id="msg" class="tiny"></div></div>
    ${pend ? `<div class="sync">${pend} Änderung(en) noch nicht hochgeladen. <button class="chip" id="syncnow">Jetzt hochladen</button></div>` : ''}
    <div class="sect">Communitys</div>
    <div id="comms">${spinner}</div>
    <button class="btn center" id="newcomm">＋ Neue Community gründen</button>
    <a class="btn center" href="#/import">Funde aus der Parey-App übernehmen</a>
    <div class="row" style="align-items:center"><input class="inp" id="joincode" placeholder="Einladungslink oder Code" style="flex:2;min-width:160px"><button class="btn center" id="join" style="flex:1">Beitreten</button></div>
    <button class="btn center" id="out">Abmelden</button>
    <div class="sect">Buch auf diesem Gerät</div>
    <button class="btn center danger" id="rmpdf"><small>PDF von diesem Gerät entfernen</small></button>`, 'konto');
  const msg = document.getElementById('msg');
  document.getElementById('save').onclick = async () => {
    const name = document.getElementById('name').value.trim(); if (!name) return;
    const {error} = await sb.from('profiles').update({name}).eq('id', myId());
    msg.textContent = error ? 'Fehler: ' + error.message : 'Gespeichert.';
  };
  document.getElementById('pwsave').onclick = async () => {
    const pw = document.getElementById('pw').value; if (pw.length < 8) return msg.textContent = 'Mindestens 8 Zeichen.';
    const {error} = await sb.auth.updateUser({password: pw}); msg.textContent = error ? 'Fehler: ' + error.message : 'Passwort geändert.';
  };
  const sn = document.getElementById('syncnow'); if (sn) sn.onclick = async () => { await sync(); viewKonto(); };
  loadComms().then(cs => {
    const el = document.getElementById('comms'); if (!el) return;
    el.innerHTML = cs.length ? `<ul class="list">${cs.map(c => `<li><a class="item" href="#/community/${c.id}"><span class="th" style="display:flex;align-items:center;justify-content:center;font-size:26px">👥</span><span class="txt"><div class="de">${esc(c.name)}</div><div class="tiny">${c.rolle === 'admin' ? 'Admin' : 'Mitglied'}${activeComm()?.id === c.id ? ' · Standard für neue Funde' : ''}</div></span></a></li>`).join('')}</ul>`
      : '<div class="note">Du bist noch in keiner Community. Gründe eine oder tritt über einen Einladungslink bei. Ohne Community kannst du Funde privat oder für alle speichern.</div>';
  });
  document.getElementById('newcomm').onclick = async () => {
    const name = prompt('Name der Community, z. B. „Pilzfreund*innen Halle“'); if (!name || name.trim().length < 2) return;
    const id = uuid();
    const {error} = await sb.from('communities').insert({id, name: name.trim()});
    if (error) return alert('Konnte nicht angelegt werden: ' + error.message);
    store.set('aktivComm', id); await loadComms(); location.hash = '#/community/' + id;
  };
  document.getElementById('join').onclick = () => {
    const v = document.getElementById('joincode').value.trim(); if (!v) return;
    location.hash = '#/beitreten/' + (v.match(/beitreten\/([0-9a-f]+)/)?.[1] || v);
  };
  document.getElementById('out').onclick = async () => { await sb.auth.signOut(); session = null; viewKonto(); };
  document.getElementById('rmpdf').onclick = async () => { if (!confirm('Das Buch-PDF und alle daraus gelesenen Texte von diesem Gerät löschen? Deine Funde bleiben erhalten.')) return; await removePdf(); location.hash = '#/'; location.reload(); };
}

/* Funde */
const needLogin = title => setView(title, !sb ? '<div class="note">Die Fund-Datenbank ist noch nicht eingerichtet.</div>' : '<div class="note">Für Funde brauchst du ein Konto.</div><a class="btn primary" href="#/konto">Anmelden oder registrieren</a>', 'funde');
function fundName(f) { return f.art_id != null && IDX.species[f.art_id] ? deName(IDX.species[f.art_id]) : (f.art_frei || 'Unbestimmt'); }
async function fetchFunde(filter = {}) {
  let q = sb.from('funde').select('*, profiles(name), communities(name), kommentare(count)').order('datum', {ascending: false}).order('created_at', {ascending: false}).limit(500);
  if (filter.user) q = q.eq('user_id', filter.user);
  if (filter.comm) q = q.eq('community_id', filter.comm).in('sichtbarkeit', ['community', 'alle']);
  if (filter.alle) q = q.eq('sichtbarkeit', 'alle');
  if (filter.art != null) q = q.eq('art_id', filter.art);
  const {data, error} = await q;
  if (error) throw error;
  return data;
}
async function localPending() {
  const out = [];
  for (const j of await dbAll('outbox')) if (j.op !== 'delete') out.push({...j.row, id: j.id, _pending: true, profiles: {name: profile?.name || 'Ich'}, kommentare: [{count: 0}], _neu: j.neu?.length || 0});
  return out;
}
async function fundListHtml(fs) {
  const firsts = await signUrls(fs.map(f => f.fotos?.[0]).filter(Boolean));
  const m = new Map(fs.map(f => f.fotos?.[0]).filter(Boolean).map((p, i) => [p, firsts[i]]));
  return `<ul class="list">${fs.map(f => {
    const src = f.fotos?.[0] ? m.get(f.fotos[0]) : (f.art_id != null ? null : null);
    const thumb = src ? `<img class="th cover" src="${esc(src)}" alt="">` : f.art_id != null && IDX.species[f.art_id]?.plate ? `<img class="th" data-th="${f.art_id}" alt="">` : '<span class="th" style="display:flex;align-items:center;justify-content:center;font-size:24px">📍</span>';
    const nk = f.kommentare?.[0]?.count || 0;
    return `<li><a class="item" href="#/fund/${f.id}">${thumb}<span class="txt"><div class="de">${esc(fundName(f))}${f.unsicher ? ' <span class="tiny">(unsicher)</span>' : ''}</div>
      <div class="tiny">${SICHT[f.sichtbarkeit] || ''} ${fmtDate(f.datum)} · ${esc(f.profiles?.name || '')}${f.ort ? ' · ' + esc(f.ort) : ''}${nk ? ` · 💬 ${nk}` : ''}${f._pending ? ' · ⏳ noch nicht hochgeladen' : ''}</div></span></a></li>`;
  }).join('')}</ul>`;
}
async function viewFunde(filt, mode = 'liste') {
  if (!sb || !session) return needLogin('Funde');
  const tok = ++viewToken;
  if (!filt) filt = activeComm() ? 'c' + activeComm().id : 'alle';
  const chips = [...myComms.map(c => ['c' + c.id, '👥 ' + c.name]), ['alle', '🌍 Alle'], ['meine', '🔒 Meine']];
  setView('Funde', `<a class="btn primary" href="#/fund/neu">＋ Neuer Fund</a>
    <div>${chips.map(([k, l]) => `<a class="chip ${k === filt ? 'on' : ''}" href="#/funde/${k}/${mode}">${esc(l)}</a>`).join('')}</div>
    <div style="margin:4px 0"><a class="chip ${mode === 'liste' ? 'on' : ''}" href="#/funde/${filt}/liste">Liste</a><a class="chip ${mode === 'karte' ? 'on' : ''}" href="#/funde/${filt}/karte">Karte</a></div>
    <div class="tiny">${filt === 'alle' ? 'Funde, die Leute aus allen Communitys für alle freigegeben haben.' : filt === 'meine' ? 'Alle deine eigenen Funde, auch private.' : 'Funde dieser Community.'}${!myComms.length ? ' <a href="#/konto">Community gründen oder beitreten</a>' : ''}</div>
    <div id="fl">${spinner}</div>`, 'funde');
  sync();
  const filter = filt === 'meine' ? {user: myId()} : filt === 'alle' ? {alle: true} : {comm: filt.slice(1)};
  if (filter.comm) store.set('aktivComm', filter.comm);
  let fs;
  try { fs = await fetchFunde(filter); await dbPut('cache', 'funde-' + filt, fs); }
  catch (e) { fs = await dbGet('cache', 'funde-' + filt) || []; if (tok === viewToken) document.getElementById('fl').insertAdjacentHTML('beforebegin', '<div class="note warn">Offline: Du siehst den zuletzt geladenen Stand.</div>'); }
  const pend = (await localPending()).filter(p => filt === 'meine' || (filt === 'alle' ? p.sichtbarkeit === 'alle' : p.community_id === filter.comm && p.sichtbarkeit !== 'privat'));
  const ids = new Set(pend.map(p => p.id));
  fs = [...pend, ...fs.filter(f => !ids.has(f.id))];
  if (tok !== viewToken) return;
  const el = document.getElementById('fl');
  if (mode === 'karte') return drawMap(el, fs);
  el.innerHTML = fs.length ? await fundListHtml(fs) : '<div class="note">Hier gibt es noch keine Funde.</div>';
  lazyThumbs(el);
}
function drawMap(el, fs) {
  const pts = fs.filter(f => f.lat != null && f.lon != null);
  el.innerHTML = `<div id="map"></div><div class="tiny">${pts.length} Funde mit Standort. Kartendaten © OpenStreetMap-Mitwirkende.</div>`;
  if (!window.L) { el.innerHTML = '<div class="note">Karte nicht verfügbar.</div>'; return; }
  const map = L.map('map');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '© OpenStreetMap'}).addTo(map);
  const ms = pts.map(f => L.marker([f.lat, f.lon]).addTo(map).bindPopup(`<b>${esc(fundName(f))}</b><br>${fmtDate(f.datum)} · ${esc(f.profiles?.name || '')}<br><a href="#/fund/${f.id}">Öffnen</a>`));
  if (ms.length) map.fitBounds(L.featureGroup(ms).getBounds().pad(0.2), {maxZoom: 14}); else map.setView([51.48, 11.97], 9);
}
async function artFunde(s, tok) {
  if (!sb || !session) return;
  try {
    const fs = await fetchFunde({art: s.id});
    if (tok !== viewToken || !fs.length) return;
    const el = document.getElementById('artfunde');
    el.innerHTML = `<div class="sect">Funde dieser Art (${fs.length})</div>` + await fundListHtml(fs.slice(0, 20));
  } catch {}
}
async function resizePhoto(file, max = 1600) {
  const img = await createImageBitmap(file, {imageOrientation: 'from-image'}).catch(() => createImageBitmap(file));
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return toBlob(c, .82);
}
async function viewFundEdit(fid, artId) {
  if (!sb || !session) return needLogin('Neuer Fund');
  const isNew = fid === 'neu';
  let f;
  await loadComms();
  const ac = activeComm();
  if (isNew) f = {id: uuid(), art_id: Number.isFinite(artId) ? artId : null, art_frei: '', unsicher: false, datum: new Date().toISOString().slice(0, 10), lat: null, lon: null, genauigkeit: null, ort: '', notiz: '', fotos: [],
    sichtbarkeit: ac ? 'community' : 'privat', community_id: ac?.id || null};
  else {
    const job = await dbGet('outbox', fid);
    if (job && job.op !== 'delete') f = {...job.row, id: fid, _neu: job.neu || []};
    else { const {data} = await sb.from('funde').select('*').eq('id', fid).maybeSingle(); f = data; }
    if (!f) return viewFunde();
    if (f.user_id && f.user_id !== myId()) return viewFund(fid);
  }
  let neu = [...(f._neu || [])], weg = [], fotos = [...(f.fotos || [])];
  setView(isNew ? 'Neuer Fund' : 'Fund bearbeiten', `
    <div class="sect">Art</div>
    <div id="artsel" class="card" style="margin-top:0"></div>
    <input type="search" class="inp" id="artq" placeholder="Art suchen …" autocomplete="off" style="position:static">
    <div id="artres"></div>
    <label class="tiny"><input type="checkbox" id="uns" ${f.unsicher ? 'checked' : ''}> Bestimmung unsicher</label>
    <div class="sect">Datum</div><input type="date" id="datum" class="inp" value="${esc(f.datum)}">
    <div class="sect">Standort</div>
    <button class="btn center" id="gps">📍 Aktuellen Standort übernehmen</button>
    <div id="gpsinfo" class="tiny"></div>
    <input type="text" id="ort" class="inp" placeholder="Ortsbeschreibung, z. B. Dölauer Heide, Nordrand" value="${esc(f.ort || '')}">
    <div class="sect">Notiz</div>
    <textarea id="notiz" rows="4" class="inp" placeholder="Bäume in der Nähe, Geruch, Anzahl, Bestimmungsmerkmale …">${esc(f.notiz || '')}</textarea>
    <div class="sect">Fotos</div>
    <div class="ph-edit" id="phs"></div>
    <label class="btn center">📷 Foto aufnehmen oder wählen<input type="file" id="foto" accept="image/*" multiple hidden></label>
    <div class="sect">Wer sieht diesen Fund?</div>
    <select class="inp" id="sicht">
      ${myComms.map(c => `<option value="c${c.id}" ${f.sichtbarkeit === 'community' && f.community_id === c.id ? 'selected' : ''}>👥 Community ${esc(c.name)}</option>`).join('')}
      <option value="alle" ${f.sichtbarkeit === 'alle' ? 'selected' : ''}>🌍 Alle App-Nutzer*innen (auch andere Communitys)</option>
      <option value="privat" ${f.sichtbarkeit === 'privat' ? 'selected' : ''}>🔒 Nur ich</option>
    </select>
    <div class="tiny" id="sichthint"></div>
    <button class="btn primary" id="save">Speichern</button>
    ${isNew ? '' : '<button class="btn center danger" id="del">Fund löschen</button>'}`, 'funde');
  const sel = document.getElementById('sicht'), hint = document.getElementById('sichthint');
  const showHint = () => hint.textContent = sel.value === 'privat' ? 'Nur du siehst diesen Fund.' : sel.value === 'alle' ? 'Alle angemeldeten Nutzer*innen der App sehen den Fund mit genauem Standort, Fotos und deinem Namen.' : 'Alle Mitglieder dieser Community sehen den Fund mit genauem Standort, Fotos und deinem Namen.';
  sel.onchange = showHint; showHint();
  const showArt = () => {
    const s = f.art_id != null ? IDX.species[f.art_id] : null;
    document.getElementById('artsel').innerHTML = s ? `<div class="de">${esc(s.de)}</div><div class="lat">${esc(s.lat)}</div><button class="chip" id="artclr">Entfernen</button>`
      : f.art_frei ? `<div class="de">${esc(f.art_frei)}</div><div class="tiny">nicht im Buch</div><button class="chip" id="artclr">Entfernen</button>` : '<div class="de">Noch unbestimmt</div><div class="tiny">Du kannst die Art auch später eintragen.</div>';
    const c = document.getElementById('artclr'); if (c) c.onclick = () => { f.art_id = null; f.art_frei = ''; showArt(); };
  };
  showArt();
  const aq = document.getElementById('artq'), ar = document.getElementById('artres');
  aq.oninput = () => {
    const t = norm(aq.value).split(' ').filter(Boolean);
    if (aq.value.trim().length < 2) { ar.innerHTML = ''; return; }
    const xs = IDX.species.filter(s => t.every(w => s.q.includes(w))).slice(0, 12);
    ar.innerHTML = xs.map(s => `<button class="chip" data-a="${s.id}">${esc(deName(s))}</button>`).join('') + `<button class="chip" data-frei="1">„${esc(aq.value.trim())}“ (nicht im Buch)</button>`;
    ar.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { f.art_id = +b.dataset.a; f.art_frei = ''; aq.value = ''; ar.innerHTML = ''; showArt(); });
    ar.querySelector('[data-frei]').onclick = () => { f.art_id = null; f.art_frei = aq.value.trim(); aq.value = ''; ar.innerHTML = ''; showArt(); };
  };
  const gi = document.getElementById('gpsinfo');
  const showGps = () => gi.innerHTML = f.lat != null ? `Gespeichert: ${(+f.lat).toFixed(5)}, ${(+f.lon).toFixed(5)}${f.genauigkeit ? ` (± ${Math.round(f.genauigkeit)} m)` : ''} · <a href="geo:${f.lat},${f.lon}?q=${f.lat},${f.lon}">In Karten-App öffnen</a> · <a href="#" id="gpsclr">entfernen</a>` : 'Noch kein Standort gespeichert.';
  showGps();
  gi.onclick = e => { if (e.target.id === 'gpsclr') { e.preventDefault(); f.lat = f.lon = f.genauigkeit = null; showGps(); } };
  document.getElementById('gps').onclick = () => {
    if (!navigator.geolocation) return gi.textContent = 'Dieser Browser kann keinen Standort liefern.';
    gi.textContent = 'Suche Standort …';
    navigator.geolocation.getCurrentPosition(p => { f.lat = p.coords.latitude; f.lon = p.coords.longitude; f.genauigkeit = p.coords.accuracy; showGps(); },
      e => gi.textContent = 'Kein Standort: ' + (e.code === 1 ? 'Zugriff verweigert. Bitte in den Browser-Einstellungen erlauben.' : e.message),
      {enableHighAccuracy: true, timeout: 20000, maximumAge: 0});
  };
  const phs = document.getElementById('phs');
  const drawPhotos = async () => {
    const urls = await signUrls(fotos);
    phs.innerHTML = fotos.map((p, i) => `<div><img src="${esc(urls[i])}" alt=""><button data-old="${i}" aria-label="Foto entfernen">×</button></div>`).join('') +
      neu.map((b, i) => `<div><img src="${URL.createObjectURL(b)}" alt=""><button data-neu="${i}" aria-label="Foto entfernen">×</button></div>`).join('');
    phs.querySelectorAll('[data-old]').forEach(b => b.onclick = () => { weg.push(fotos[+b.dataset.old]); fotos.splice(+b.dataset.old, 1); drawPhotos(); });
    phs.querySelectorAll('[data-neu]').forEach(b => b.onclick = () => { neu.splice(+b.dataset.neu, 1); drawPhotos(); });
  };
  drawPhotos();
  document.getElementById('foto').onchange = async e => { for (const file of e.target.files) neu.push(await resizePhoto(file)); e.target.value = ''; drawPhotos(); };
  document.getElementById('save').onclick = async () => {
    const row = {art_id: f.art_id, art_lat: f.art_id != null ? IDX.species[f.art_id].lat : null, art_de: f.art_id != null ? IDX.species[f.art_id].de : null, art_frei: f.art_frei || null,
      unsicher: document.getElementById('uns').checked, datum: document.getElementById('datum').value || f.datum,
      lat: f.lat, lon: f.lon, genauigkeit: f.genauigkeit, ort: document.getElementById('ort').value.trim() || null, notiz: document.getElementById('notiz').value.trim() || null, fotos};
    const sv = sel.value;
    if (sv.startsWith('c')) { row.sichtbarkeit = 'community'; row.community_id = sv.slice(1); store.set('aktivComm', row.community_id); }
    else if (sv === 'alle') { row.sichtbarkeit = 'alle'; row.community_id = (f.community_id && myComms.some(c => c.id === f.community_id)) ? f.community_id : (activeComm()?.id || null); }
    else { row.sichtbarkeit = 'privat'; row.community_id = null; }
    const prev = await dbGet('outbox', f.id);
    await dbPut('outbox', f.id, {op: 'upsert', id: f.id, row, neu, weg: [...(prev?.weg || []), ...weg], t: Date.now()});
    await sync();
    location.replace('#/fund/' + f.id);
  };
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm('Diesen Fund wirklich löschen?')) return;
    await dbPut('outbox', f.id, {op: 'delete', id: f.id, fotos: [...(f.fotos || []), ...weg]});
    await sync(); location.replace('#/funde');
  };
}
async function viewFund(fid) {
  if (!sb || !session) return needLogin('Fund');
  const tok = ++viewToken;
  setView('Fund', spinner, 'funde');
  let f = null, pend = false;
  const job = await dbGet('outbox', fid);
  if (job && job.op !== 'delete') { f = {...job.row, id: fid, user_id: myId(), profiles: {name: profile?.name || 'Ich'}}; pend = true; }
  else { const {data} = await sb.from('funde').select('*, profiles(name), communities(name)').eq('id', fid).maybeSingle().then(r => r, () => ({data: null})); f = data; }
  if (!f) return setView('Fund', '<div class="note">Diesen Fund gibt es nicht (mehr).</div>', 'funde');
  if (tok !== viewToken) return;
  const s = f.art_id != null ? IDX.species[f.art_id] : null;
  const urls = await signUrls(f.fotos || []);
  const own = f.user_id === myId();
  setView(fundName(f), `
    <div class="card">
      ${s ? `<a href="#/art/${s.id}" class="item" style="border:0;padding:0"><img class="th" data-th="${s.id}" alt=""><span class="txt"><div class="de">${esc(s.de)}</div><div class="lat">${esc(s.lat)}</div><div class="tiny">Im Buch öffnen ›</div></span></a>` : `<div class="de">${esc(fundName(f))}</div>`}
      ${f.unsicher ? '<div class="note warn">Bestimmung unsicher</div>' : ''}
      <div class="tiny" style="margin-top:8px">${fmtDate(f.datum)} · gefunden von ${esc(f.profiles?.name || '')}</div>
      <div class="tiny">${SICHT[f.sichtbarkeit] || ''} ${esc(sichtText(f))}</div>
      ${pend ? `<div class="sync">⏳ Wird hochgeladen, sobald Netz da ist${job.neu?.length ? ` (${job.neu.length} Foto(s))` : ''}.</div>` : ''}
    </div>
    ${urls.length ? `<div class="photos">${urls.map(u => `<img src="${esc(u)}" alt="">`).join('')}</div>` : ''}
    ${f.lat != null ? `<div class="card"><b>Standort</b><div class="tiny">${(+f.lat).toFixed(5)}, ${(+f.lon).toFixed(5)}${f.genauigkeit ? ` (± ${Math.round(f.genauigkeit)} m)` : ''}</div>${f.ort ? `<div>${esc(f.ort)}</div>` : ''}<div class="row" style="margin-top:6px"><a class="btn center" href="geo:${f.lat},${f.lon}?q=${f.lat},${f.lon}">In Karten-App</a><a class="btn center" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=16/${f.lat}/${f.lon}">OpenStreetMap</a></div></div>` : f.ort ? `<div class="card"><b>Ort</b><div>${esc(f.ort)}</div></div>` : ''}
    ${f.notiz ? `<div class="card"><b>Notiz</b><div style="white-space:pre-wrap">${esc(f.notiz)}</div></div>` : ''}
    ${own ? `<a class="btn center" href="#/fund/${f.id}/bearbeiten">Bearbeiten</a>` : ''}
    <div class="sect">Kommentare</div><div id="kom">${pend ? '<div class="tiny">Kommentare gibt es, sobald der Fund hochgeladen ist.</div>' : spinner}</div>`, 'funde');
  lazyThumbs();
  $main.querySelectorAll('.photos img').forEach(i => i.onclick = () => zoomImg(i.src));
  if (!pend) loadKommentare(f.id, tok);
}
async function loadKommentare(fid, tok) {
  const el = document.getElementById('kom');
  const {data, error} = await sb.from('kommentare').select('*, profiles(name)').eq('fund_id', fid).order('created_at');
  if (tok !== viewToken) return;
  if (error) { el.innerHTML = '<div class="tiny">Kommentare konnten nicht geladen werden.</div>'; return; }
  el.innerHTML = data.map(k => `<div class="comment"><div class="tiny">${esc(k.profiles?.name || '')} · ${new Date(k.created_at).toLocaleDateString('de-DE')}${k.user_id === myId() ? ` · <a href="#" data-del="${k.id}">löschen</a>` : ''}</div><div style="white-space:pre-wrap">${esc(k.text)}</div></div>`).join('') +
    `<textarea class="inp" id="ktext" rows="2" placeholder="Kommentar, z. B. Bestimmungshinweis …"></textarea><button class="btn center" id="ksend">Kommentar senden</button>`;
  el.querySelectorAll('[data-del]').forEach(a => a.onclick = async e => { e.preventDefault(); await sb.from('kommentare').delete().eq('id', a.dataset.del); loadKommentare(fid, tok); });
  document.getElementById('ksend').onclick = async () => {
    const text = document.getElementById('ktext').value.trim(); if (!text) return;
    const {error} = await sb.from('kommentare').insert({fund_id: fid, text});
    if (error) return alert('Kommentar konnte nicht gespeichert werden: ' + error.message);
    loadKommentare(fid, tok);
  };
}

/* Funde aus der Parey-App (gleiche Website paantones.github.io, darum lesbar) */
async function oldDbFunde() {
  if (indexedDB.databases) { const ds = await indexedDB.databases().catch(() => null); if (ds && !ds.some(d => d.name === 'pilzbuch')) return null; }
  const db = await new Promise(res => { const r = indexedDB.open('pilzbuch'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
  if (!db) return null;
  if (!db.objectStoreNames.contains('funde')) { db.close(); return null; }
  const all = (s, kind) => new Promise(res => { try { const q = db.transaction(s).objectStore(s)[kind](); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch { res([]); } });
  const funde = await all('funde', 'getAll');
  const fotos = new Map();
  if (db.objectStoreNames.contains('fotos')) { const ks = await all('fotos', 'getAllKeys'), vs = await all('fotos', 'getAll'); ks.forEach((k, i) => fotos.set(k, vs[i])); }
  db.close();
  return funde.map(f => ({...f, _foto: fotos.get(f.id) || null}));
}
async function pareyData() {
  const [js, map] = await Promise.all([fetch('../pilzbuch/data.js').then(r => r.ok ? r.text() : ''), fetch('parey-map.json').then(r => r.json())]);
  const A = js ? JSON.parse(js.slice(js.indexOf('{'), js.lastIndexOf('}') + 1)).arten : [];
  return {A, map};
}
async function viewImport() {
  if (!sb || !session) return needLogin('Funde übernehmen');
  setView('Funde übernehmen', spinner, 'funde');
  await loadComms();
  let funde = await oldDbFunde().catch(() => null), quelle = 'app';
  const {A, map} = await pareyData().catch(() => ({A: [], map: {}}));
  const done = new Set(store.get('importiert', []));
  const draw = () => {
    const rows = (funde || []).map((f, i) => {
      const p = f.art != null ? A[f.art] : null, kid = f.art != null ? map[f.art] : undefined;
      const k = kid != null ? IDX.species[kid] : null;
      f._kid = kid; f._frei = !k && p ? `${p.de.split(',')[0]} (${p.lat})` : null;
      return `<li class="item" style="display:block"><label style="display:flex;gap:10px;align-items:flex-start">
        <input type="checkbox" data-i="${i}" ${done.has(f.id) ? '' : 'checked'} style="margin-top:5px">
        <span><b>${esc(k ? deName(k) : f._frei || 'Unbestimmt')}</b>${done.has(f.id) ? ' <span class="badge">schon übernommen</span>' : ''}
        <div class="tiny">${fmtDate(f.datum)}${f.ort ? ' · ' + esc(f.ort) : ''}${f.lat != null ? ' · 📍' : ''}${f._foto ? ' · 📷 Foto' : ''}</div>
        ${p && !k ? '<div class="tiny">Diese Art steht nicht im Kosmos-Handbuch, der Name aus dem Parey wird übernommen.</div>' : ''}
        ${p && k && norm(k.lat) !== norm(p.lat) ? `<div class="tiny">Im Parey: ${esc(p.de.split(',')[0])} (${esc(p.lat)})</div>` : ''}</span></label></li>`;
    }).join('');
    setView('Funde übernehmen', `
      ${funde?.length ? `<div class="note">${quelle === 'app' ? `In der Parey-App auf diesem Gerät gibt es ${funde.length} Fund(e).` : `Die Sicherungsdatei enthält ${funde.length} Fund(e). Fotos sind in Sicherungsdateien nicht enthalten.`}</div>
        <ul class="list">${rows}</ul>
        <div class="sect">Wer soll die Funde sehen?</div>
        <select class="inp" id="sicht">${myComms.map(c => `<option value="c${c.id}" ${activeComm()?.id === c.id ? 'selected' : ''}>👥 Community ${esc(c.name)}</option>`).join('')}
          <option value="alle">🌍 Alle App-Nutzer*innen</option><option value="privat" ${myComms.length ? '' : 'selected'}>🔒 Nur ich</option></select>
        <button class="btn primary" id="go">Ausgewählte Funde übernehmen</button>`
      : `<div class="note">Auf diesem Gerät habe ich keine Funde aus der Parey-App gefunden. Die Übernahme klappt nur im selben Browser auf dem Handy, auf dem du die Funde angelegt hast.</div>`}
      <div class="sect">Von einem anderen Gerät</div>
      <p class="tiny">Exportiere in der Parey-App unter „Sicherung“ eine Datei und wähle sie hier aus. Fotos sind darin nicht enthalten, die kannst du danach beim Fund ergänzen.</p>
      <label class="btn center">Sicherungsdatei wählen<input type="file" id="file" accept=".json,application/json,text/plain" hidden></label>
      <div id="st" class="tiny"></div>`, 'funde');
    document.getElementById('file').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try { const d = JSON.parse((await file.text()).replace(/^PILZBUCH-BILDER\s*/, '')); funde = (d.funde || []).filter(f => f && f.id && f.datum).map(f => ({...f, _foto: null})); quelle = 'datei'; draw(); }
      catch { document.getElementById('st').textContent = 'Das ist keine Sicherungsdatei der Parey-App.'; }
    };
    const go = document.getElementById('go');
    if (go) go.onclick = async () => {
      const sv = document.getElementById('sicht').value;
      const picked = [...$main.querySelectorAll('[data-i]:checked')].map(c => funde[+c.dataset.i]);
      if (!picked.length) return;
      go.disabled = true; go.textContent = 'Übernehme …';
      for (const f of picked) {
        const k = f._kid != null ? IDX.species[f._kid] : null;
        const row = {art_id: k ? k.id : null, art_lat: k?.lat || null, art_de: k?.de || null, art_frei: k ? null : f._frei, unsicher: false,
          datum: f.datum, lat: f.lat ?? null, lon: f.lon ?? null, genauigkeit: f.acc ?? null, ort: f.ort || null, notiz: f.notiz || null, fotos: [],
          sichtbarkeit: sv.startsWith('c') ? 'community' : sv, community_id: sv.startsWith('c') ? sv.slice(1) : sv === 'alle' ? (activeComm()?.id || null) : null};
        const nid = uuid();
        await dbPut('outbox', nid, {op: 'upsert', id: nid, row, neu: f._foto ? [f._foto] : [], weg: [], t: Date.now()});
        done.add(f.id);
      }
      store.set('importiert', [...done]);
      await sync();
      location.hash = '#/funde/meine/liste';
    };
  };
  draw();
}

/* Communitys */
async function viewCommunity(cid) {
  if (!sb || !session) return needLogin('Community');
  const tok = ++viewToken;
  setView('Community', spinner, 'konto');
  const [{data: c}, {data: ms}] = await Promise.all([
    sb.from('communities').select('*').eq('id', cid).maybeSingle(),
    sb.from('mitglieder').select('user_id, rolle, created_at, profiles(name)').eq('community_id', cid).order('created_at')]);
  if (tok !== viewToken) return;
  if (!c) return setView('Community', '<div class="note">Diese Community gibt es nicht oder du bist kein Mitglied (mehr).</div>', 'konto');
  const me = (ms || []).find(m => m.user_id === myId());
  const admin = me?.rolle === 'admin';
  const admins = (ms || []).filter(m => m.rolle === 'admin').length;
  let inv = [];
  if (admin) inv = (await sb.from('einladungen').select('*').eq('community_id', cid).order('created_at', {ascending: false})).data || [];
  const link = code => location.origin + location.pathname + '#/beitreten/' + code;
  setView(c.name, `
    <div class="card">
      <h2 style="margin:0">${esc(c.name)}</h2>
      ${c.beschreibung ? `<p>${esc(c.beschreibung)}</p>` : ''}
      <div class="tiny">${ms.length} Mitglied${ms.length === 1 ? '' : 'er'} · du bist ${admin ? 'Admin' : 'Mitglied'}</div>
      <a class="btn center" href="#/funde/c${c.id}/liste">Funde dieser Community</a>
      ${activeComm()?.id !== c.id ? '<button class="btn center" id="aktiv">Als Standard für neue Funde wählen</button>' : '<div class="tiny">Standard für neue Funde</div>'}
    </div>
    ${admin ? `<div class="sect">Leute einladen</div>
      <div class="tiny">Ein Einladungslink gilt 30 Tage. Wer ihn öffnet und angemeldet ist, wird Mitglied.</div>
      <button class="btn primary" id="newinv">Einladungslink erstellen</button>
      <ul class="list">${inv.map(i => {
        const abgelaufen = new Date(i.gueltig_bis) < new Date();
        return `<li class="item" style="display:block"><div class="tiny">${abgelaufen ? 'abgelaufen' : 'gültig bis ' + new Date(i.gueltig_bis).toLocaleDateString('de-DE')} · ${i.nutzungen}× genutzt</div>
          <div style="word-break:break-all;font-size:13px">${esc(link(i.code))}</div>
          <button class="chip" data-share="${esc(i.code)}">Teilen / kopieren</button><button class="chip" data-revoke="${esc(i.code)}">Widerrufen</button></li>`;
      }).join('')}</ul>` : ''}
    <div class="sect">Mitglieder</div>
    <ul class="list">${ms.map(m => `<li class="item" style="display:flex;justify-content:space-between;flex-wrap:wrap">
      <span><b>${esc(m.profiles?.name || '?')}</b>${m.user_id === myId() ? ' (du)' : ''} <span class="tiny">${m.rolle === 'admin' ? 'Admin' : 'Mitglied'}</span></span>
      ${admin && m.user_id !== myId() ? `<span>${m.rolle === 'admin' ? `<button class="chip" data-rolle="mitglied" data-u="${m.user_id}">Admin-Rechte entziehen</button>` : `<button class="chip" data-rolle="admin" data-u="${m.user_id}">Zum Admin machen</button>`}<button class="chip" data-kick="${m.user_id}">Entfernen</button></span>` : ''}
    </li>`).join('')}</ul>
    ${admin ? `<div class="sect">Verwaltung</div>
      <button class="btn center" id="rename">Name und Beschreibung ändern</button>` : ''}
    <button class="btn center danger" id="leave">Community verlassen</button>
    ${admin ? '<button class="btn center danger" id="delc"><small>Community auflösen</small></button>' : ''}
    <p class="tiny">Funde, die du für diese Community gespeichert hast, bleiben erhalten. Wenn du austrittst, sehen die anderen sie nicht mehr, außer du hast sie für alle freigegeben.</p>`, 'konto');
  const reload = () => viewCommunity(cid);
  const a = document.getElementById('aktiv'); if (a) a.onclick = () => { store.set('aktivComm', c.id); reload(); };
  const share = async code => {
    const url = link(code), text = `Komm in unsere Pilz-Community „${c.name}“ in der Pilzhandbuch-App: ${url}`;
    try { if (navigator.share) { await navigator.share({title: c.name, text, url}); return; } } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); alert('Link kopiert.'); } catch { prompt('Link kopieren:', url); }
  };
  const ni = document.getElementById('newinv');
  if (ni) ni.onclick = async () => {
    const {data, error} = await sb.from('einladungen').insert({community_id: cid}).select().single();
    if (error) return alert('Fehler: ' + error.message);
    await share(data.code); reload();
  };
  $main.querySelectorAll('[data-share]').forEach(b => b.onclick = () => share(b.dataset.share));
  $main.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { await sb.from('einladungen').delete().eq('code', b.dataset.revoke); reload(); });
  $main.querySelectorAll('[data-rolle]').forEach(b => b.onclick = async () => {
    const {error} = await sb.from('mitglieder').update({rolle: b.dataset.rolle}).eq('community_id', cid).eq('user_id', b.dataset.u);
    if (error) alert('Fehler: ' + error.message); reload();
  });
  $main.querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
    if (!confirm('Diese Person aus der Community entfernen?')) return;
    const {error} = await sb.from('mitglieder').delete().eq('community_id', cid).eq('user_id', b.dataset.kick);
    if (error) alert('Fehler: ' + error.message); reload();
  });
  const rn = document.getElementById('rename');
  if (rn) rn.onclick = async () => {
    const name = prompt('Name der Community', c.name); if (name == null) return;
    const beschreibung = prompt('Kurze Beschreibung (optional)', c.beschreibung || ''); if (beschreibung == null) return;
    const {error} = await sb.from('communities').update({name: name.trim(), beschreibung: beschreibung.trim() || null}).eq('id', cid);
    if (error) alert('Fehler: ' + error.message); await loadComms(); reload();
  };
  document.getElementById('leave').onclick = async () => {
    if (admin && admins === 1 && ms.length > 1) return alert('Du bist die einzige Admin-Person. Mach vorher jemand anderen zum Admin.');
    if (!confirm(`„${c.name}“ wirklich verlassen?`)) return;
    const {error} = await sb.from('mitglieder').delete().eq('community_id', cid).eq('user_id', myId());
    if (error) return alert('Fehler: ' + error.message);
    if (store.get('aktivComm', null) === cid) store.set('aktivComm', null);
    await loadComms(); location.hash = '#/konto';
  };
  const dc = document.getElementById('delc');
  if (dc) dc.onclick = async () => {
    if (prompt(`Zum Auflösen bitte den Namen „${c.name}“ eintippen. Funde bleiben bei ihren Finder*innen, sind dann aber nur noch für sie sichtbar (außer „für alle“).`) !== c.name) return;
    const {error} = await sb.from('communities').delete().eq('id', cid);
    if (error) return alert('Fehler: ' + error.message);
    await loadComms(); location.hash = '#/konto';
  };
}
async function viewBeitreten(code) {
  if (!sb) return needLogin('Einladung');
  if (!session) {
    store.set('joinCode', code);
    return setView('Einladung', '<div class="note">Du wurdest in eine Pilz-Community eingeladen. Melde dich an oder registriere dich, danach geht es automatisch weiter.</div><a class="btn primary" href="#/konto">Anmelden oder registrieren</a>', 'konto');
  }
  setView('Einladung', spinner, 'konto');
  store.set('joinCode', null);
  const {data, error} = await sb.rpc('community_beitreten', {p_code: code});
  if (error || !data?.length) return setView('Einladung', `<div class="note warn">${esc(error?.message?.includes('ungültig') ? 'Diese Einladung ist ungültig oder abgelaufen. Bitte frag nach einem neuen Link.' : 'Beitritt hat nicht geklappt: ' + (error?.message || ''))}</div><a class="btn center" href="#/konto">Zum Konto</a>`, 'konto');
  store.set('aktivComm', data[0].community_id);
  await loadComms();
  setView('Willkommen', `<div class="card"><h2 style="margin-top:0">Willkommen in „${esc(data[0].name)}“ 🍄</h2><p>Neue Funde werden ab jetzt standardmäßig mit dieser Community geteilt. Das kannst du bei jedem Fund ändern.</p>
    <a class="btn primary" href="#/funde/c${data[0].community_id}/liste">Funde der Community ansehen</a></div>`, 'funde');
}

/* Einrichtung: eigenes PDF laden */
function viewSetup(err) {
  window.__started = true;
  document.getElementById('tabs').hidden = true;
  setView('Pilzhandbuch', `
    <div class="card">
      <h2 style="margin-top:0">Willkommen 🍄</h2>
      <p>Diese App ist ein Begleiter zum eBook <b>„Das Kosmos Handbuch Pilze“</b> von Andreas Gminder und Peter Karasch (Kosmos, 2023). Sie bringt einen durchklickbaren Bestimmungsschlüssel, gut lesbare Artbeschreibungen, eine Suche und eine gemeinsame Fund-Datenbank für unsere Gruppe mit.</p>
      <p>Die App selbst enthält <b>keine Buchinhalte</b>. Du brauchst dein eigenes, gekauftes eBook als PDF (erhältlich z. B. bei Kosmos, Thalia oder ebook.de, ca. 37 €). Die Datei wird nur auf deinem Gerät gespeichert und nirgendwohin hochgeladen. Bitte gib sie nicht weiter, sie trägt deine Käuferdaten.</p>
      ${err ? `<div class="note warn">${esc(err)}</div>` : ''}
      <label class="btn primary">PDF auswählen<input type="file" id="f" accept="application/pdf,.pdf" hidden></label>
      <div id="st" class="tiny"></div>
    </div>
    <p class="tiny">Tipp: Danach im Browsermenü „Zum Startbildschirm hinzufügen“ wählen, dann funktioniert die App auch im Wald ohne Netz.</p>`, 'home');
  document.getElementById('f').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const st = document.getElementById('st');
    try {
      st.innerHTML = 'Prüfe die Datei …';
      const d = await openPdf(file);
      const bad = await checkBook(d);
      if (bad) { await d.destroy(); return viewSetup(bad); }
      await d.destroy();
      st.innerHTML = '<div>Speichere das Buch auf dem Gerät …</div><div class="prog"><div id="pp"></div></div>';
      await savePdf(file, x => { const pp = document.getElementById('pp'); if (pp) pp.style.width = Math.round(x * 100) + '%'; });
      try { await navigator.storage?.persist?.(); } catch {}
      await start();
    } catch (er) { console.error(er); viewSetup('Die Datei konnte nicht gelesen werden: ' + er.message); }
  };
}

/* Router */
async function route() {
  if (!doc) return;
  const [path, qs] = location.hash.slice(1).split('?');
  const h = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  ++viewToken;
  switch (h[0]) {
    case 'arten': return viewArten(q.get('q') || '');
    case 'art': return viewArt(+h[1]);
    case 'k': return viewKey(+h[1] || 0, +h[2] || 1, h[3] || '');
    case 'liste': return viewListe(h[1], decodeURIComponent(h[2] || ''));
    case 'merkmale': return viewMerkmale();
    case 'seite': return viewSeite(+h[1] || 0);
    case 'konto': return viewKonto();
    case 'funde': return viewFunde(h[1], h[2] || 'liste');
    case 'community': return viewCommunity(h[1]);
    case 'import': return viewImport();
    case 'beitreten': return viewBeitreten(h[1]);
    case 'fund':
      if (h[1] === 'neu') return viewFundEdit('neu', h[2] != null ? +h[2] : NaN);
      if (h[2] === 'bearbeiten') return viewFundEdit(h[1]);
      return viewFund(h[1]);
    default: return viewHome();
  }
}
window.addEventListener('hashchange', () => { if ($zoom.classList.contains('on')) { $zoom.classList.remove('on'); $zin.innerHTML = ''; } route(); });

async function start() {
  window.__step = 'Buch öffnen';
  const jm = location.hash.match(/^#\/beitreten\/([0-9a-zA-Z]+)/); if (jm && !session) store.set('joinCode', jm[1]);
  const blob = await loadPdfBlob();
  if (!blob) return viewSetup();
  try { doc = await openPdf(blob); }
  catch (e) { console.error(e); return viewSetup('Das gespeicherte PDF konnte nicht geöffnet werden. Bitte wähle es noch einmal aus.'); }
  document.getElementById('tabs').hidden = false;
  window.__started = true;
  route();
  sync();
}

(async () => {
  try {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    window.__step = 'Register laden'; await loadIndex();
    await initAuth();
    profile ||= store.get('profile', null);
    window.__step = 'Buch auf dem Gerät suchen'; await start();
    window.__started = true;
  } catch (e) {
    console.error(e);
    window.__fail?.(e);
  }
})();
