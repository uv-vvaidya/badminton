(function () {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean);
const fileUrl = (id) => (id ? '/api/files/' + id : '');
const isPair = (k) => /Doubles/.test(k);
const unit = (k, n) => (isPair(k) ? (n === 1 ? 'team' : 'teams') : (n === 1 ? 'player' : 'players'));
const fmtDate = (s) => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
const fmtDay = (s) => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
const LETTERS = 'ABCDEFGHIJKLMNOP'.split('');

const S = {
  data: null, user: null, setup: null, view: 'home',
  fxEvent: null, fxMode: 'league', adminTab: 'regs', adminEv: null,
  scoreId: null, scoreFilter: 'mine', scoreCourt: '', lastDone: null,
  regs: [], regFilter: 'pending', regEvent: '', selected: new Set(), users: [], matchEvent: '',
};

// ---------- API ----------
async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (form) opt.body = form;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) { const e = new Error((data && data.error) || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}
// Runs an admin action; on 409 asks to confirm and retries with force.
async function act(path, body = {}, method = 'POST', okMsg) {
  try { const r = await api(path, { method, body }); if (okMsg) toast(okMsg); await refresh(); return r; }
  catch (e) {
    if (e.status === 409 && !body.force) return new Promise((res) => confirmBox(e.message + ' Continue anyway?', 'Continue', async () => res(await act(path, { ...body, force: true }, method, okMsg))));
    toast(e.message);
  }
}

// ---------- UI helpers ----------
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.setAttribute('role', 'status'); d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3000); }
function modal(html, onMount) {
  const r = $('#modalRoot');
  r.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="card">' + html + '</div></div>';
  const m = r.firstChild;
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) r.innerHTML = ''; });
  if (onMount) onMount(m);
  const f = m.querySelector('input,select,button'); if (f) f.focus();
  return m;
}
const closeModal = () => { $('#modalRoot').innerHTML = ''; };
function confirmBox(text, label, fn) {
  modal('<h3>' + esc(label) + '</h3><p>' + esc(text) + '</p><div class="toolbar"><button class="btn primary" id="cfYes">' + esc(label) + '</button><button class="btn" data-close>Cancel</button></div>',
    (m) => { m.querySelector('#cfYes').onclick = () => { closeModal(); fn(); }; });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
function compress(file, max = 1200, q = 0.85) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(u);
      c.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the image'))), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('That file is not an image we can read.')); };
    img.src = u;
  });
}

// ---------- data access ----------
const D = () => S.data || { settings: {}, formats: {}, teams: [], matches: [], players: [], standings: {}, eventKeys: [] };
const teamMap = () => { const m = {}; D().teams.forEach((t) => { m[t.id] = t; }); return m; };
const teamName = (id, tm = teamMap()) => (id && tm[id] ? (tm[id].names || []).join(' / ') : 'TBD');
const fmtOf = (ek) => D().formats[ek] || { groups: 2, league: { points: 21, bestOf: 1, cap: 30 }, knockout: { qualifiers: 2, points: 21, bestOf: 3, cap: 30 } };
const stageLabel = (s) => (s.bestOf === 1 ? '1 game' : 'Best of ' + s.bestOf) + ' to ' + s.points + ' (cap ' + s.cap + ')';
function gameOver(g, p, cap) { const hi = Math.max(g[0], g[1]); return (hi >= p && Math.abs(g[0] - g[1]) >= 2) || hi >= cap; }
function tally(m) { let a = 0, b = 0; (m.games || []).forEach((g) => { if (gameOver(g, m.points, m.cap)) { if (g[0] > g[1]) a++; else b++; } }); return [a, b]; }
const officialName = (id) => (id && D().officials && D().officials[id]) || '';
const isOfficial = () => !!S.user;
function canScore(m) {
  if (!S.user || !m) return false;
  if (S.user.role === 'admin' || S.user.role === 'scorer') return true;
  return !m.umpire_id || m.umpire_id === S.user.id;
}
const ROLE_LABEL = { admin: 'Admin', scorer: 'Scorer', umpire: 'Umpire' };
function activeEvents() {
  const set = new Set([...D().teams.map((t) => t.event_key), ...D().players.map((p) => p.event_key)]);
  return D().eventKeys.filter((k) => set.has(k));
}

let loading = null, again = false;
async function refresh() {
  if (loading) { again = true; return loading; }
  loading = (async () => {
    try {
      S.data = await api('/api/state');
      if (!S.presence && S.data.presence) { S.presence = S.data.presence; setTimeout(renderPresence); }
      if (S.user && S.user.role === 'admin' && S.view === 'admin' && S.adminTab === 'regs') S.regs = await api('/api/admin/registrations');
      renderAll();
    } catch (e) { console.warn(e); }
  })();
  await loading; loading = null;
  if (again) { again = false; return refresh(); }
}
// Audience: a random id per open tab (cid) and per browser (vid). Neither holds personal data.
const rid = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, '').slice(0, 20).padEnd(12, '0');
const CID = rid();
let VID = null;
try { VID = localStorage.getItem('uvb-vid'); if (!VID) { VID = rid(); localStorage.setItem('uvb-vid', VID); } } catch (e) { VID = null; }
const fmtNum = (n) => Number(n || 0).toLocaleString();
function renderPresence() {
  const p = S.presence; if (!p) return;
  const w = $('#liveWatch');
  if (w) { w.hidden = false; w.innerHTML = '<i class="live-dot on"></i> ' + fmtNum(p.live) + ' following live · ' + fmtNum(p.online) + ' on the site'; }
  $('#footTxt').innerHTML = '<span class="aud"><i class="live-dot on"></i> ' + fmtNum(p.online) + (p.online === 1 ? ' person' : ' people') + ' on the site now</span><span class="aud">' + fmtNum(p.views) + ' page views</span><span class="aud">' + fmtNum(p.visitors) + ' visitors</span>';
  if (S.view === 'home') renderHomeStats();
}
let streamOpen = false;
function sendPresence() { if (streamOpen) api('/api/presence', { method: 'POST', body: { cid: CID, view: S.view } }).catch(() => {}); }
function connectStream() {
  let es;
  try { es = new EventSource('/api/stream?cid=' + CID + '&view=' + encodeURIComponent(S.view)); } catch (e) { return; }
  let t = null;
  es.onopen = () => { streamOpen = true; sendPresence(); };
  es.addEventListener('presence', (e) => { try { S.presence = JSON.parse(e.data); renderPresence(); } catch (er) { /* ignore */ } });
  es.addEventListener('state', () => { clearTimeout(t); t = setTimeout(refresh, 150); });
  es.onerror = () => { /* EventSource reconnects on its own */ };
}

// ---------- routing ----------
const VIEWS = ['home', 'register', 'fixtures', 'live', 'score', 'admin'];
function route() {
  let v = (location.hash || '#home').slice(1); if (!VIEWS.includes(v)) v = 'home';
  S.view = v;
  VIEWS.forEach((x) => { $('#view-' + x).hidden = x !== v; });
  $$('nav.tabs a').forEach((a) => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (v === 'admin' && S.user && S.user.role === 'admin') refresh();
  sendPresence();
  renderView(); window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
function renderAll() {
  renderHome(); renderView();
  $('#navLiveDot').classList.toggle('on', D().matches.some((m) => m.status === 'live'));
  $('#navAdmin').textContent = S.user ? (S.user.role === 'admin' ? 'Admin' : 'Account') : 'Login';
  $('#navScore').hidden = !S.user;
}
function renderView() {
  if (S.view === 'register') renderRegister();
  if (S.view === 'fixtures') renderFixtures();
  if (S.view === 'live') renderLive();
  if (S.view === 'score') renderScore();
  if (S.view === 'admin') renderAdmin();
}

// ---------- HOME ----------
let cdTimer = null;
function renderHome() {
  const c = D().settings; if (!c.name) return;
  document.title = c.name;
  $('#footLegal').innerHTML = '&copy; ' + new Date().getFullYear() + ' ' + esc(c.name) + '. All rights reserved.' + (c.footerEmail ? ' For more details, contact <span class="copyable">' + esc(c.footerEmail) + '</span>' : '');
  $('#brandName').textContent = c.name; $('#hName').textContent = c.name; $('#hEyebrow').textContent = c.eyebrow || ''; $('#hTag').textContent = c.tagline || '';
  $('#hFacts').innerHTML = [['When', c.dateText || fmtDay(c.startDate)], ['Where', c.venue], ['Register by', c.regDeadline ? fmtDay(c.regDeadline) : (c.regOpen ? 'Open now' : 'Closed')]]
    .filter((x) => x[1]).map(([k, v]) => '<div><small>' + esc(k) + '</small>' + esc(v) + '</div>').join('');
  $('#hMedia').innerHTML = c.gifId ? '<img alt="Badminton action" src="' + fileUrl(c.gifId) + '">' : shuttleSvg();
  clearInterval(cdTimer);
  const tick = () => {
    const t = c.startDate ? new Date(c.startDate) - Date.now() : NaN;
    if (!(t > 0)) { $('#hCountdown').innerHTML = c.startDate ? '<div><b>ON</b><span>Tournament day</span></div>' : ''; return; }
    const d = Math.floor(t / 864e5), h = Math.floor(t / 36e5) % 24, m = Math.floor(t / 6e4) % 60, s = Math.floor(t / 1e3) % 60;
    $('#hCountdown').innerHTML = [[d, 'days'], [h, 'hrs'], [m, 'min'], [s, 'sec']].map(([n, l]) => '<div><b class="tab-num">' + String(n).padStart(2, '0') + '</b><span>' + l + '</span></div>').join('');
  };
  tick(); cdTimer = setInterval(tick, 1000);
  const ps = D().players;
  renderHomeStats();
  $('#hFee').textContent = c.fee || '';
  $('#hEvents').innerHTML = Object.entries(c.events || {}).filter(([, evs]) => evs.length).map(([cat, evs]) => '<div class="event-card"><h3>' + esc((D().categoryLabels || {})[cat] || cat) + '</h3><div class="chips">' +
    evs.map((e) => '<span class="chip">' + esc(e) + ' · ' + ps.filter((x) => x.category === cat && x.event === e).length + '</span>').join('') + '</div></div>').join('');
  $('#hAbout').textContent = c.about || '';
  const li = (t) => lines(t).map((l, i) => { const p = l.split(' · '); return '<li><span class="k">' + (p.length > 1 ? '' : String(i + 1).padStart(2, '0')) + '</span><span>' + (p.length > 1 ? '<b>' + esc(p[0]) + '</b> · ' + esc(p.slice(1).join(' · ')) : esc(l)) + '</span></li>'; }).join('');
  $('#hRules').innerHTML = li(c.rules); $('#hSchedule').innerHTML = li(c.schedule); $('#hPrizes').innerHTML = li(c.prizes);
  $('#hContact').innerHTML = '<b>Questions?</b><span>' + esc(c.contactName) + '</span>' + (c.contactPhone ? '<span class="copyable">' + esc(c.contactPhone) + '</span>' : '');
}
function renderHomeStats() {
  const ps = D().players, ms = D().matches.filter((m) => m.status !== 'bye'), p = S.presence || D().presence || {};
  $('#hStats').innerHTML = [[ps.length, 'Registrations'], [D().teams.length, 'Confirmed entries'], [ms.filter((m) => m.status === 'done').length + ' / ' + ms.length, 'Matches played'], [fmtNum(p.online), 'Watching now'], [fmtNum(p.views), 'Page views']]
    .map(([n, l]) => '<div><b class="tab-num">' + esc(n) + '</b><span>' + esc(l) + '</span></div>').join('');
}
function shuttleSvg() { return '<svg viewBox="0 0 200 150" width="70%" aria-label="Shuttlecock" role="img"><g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" opacity=".9"><path d="M100 118 62 22l18 8 8-22 12 22 12-22 8 22 18-8z"/><path d="M76 58h48M84 82h32"/></g><circle cx="100" cy="126" r="14" fill="#E79A45"/><path d="M30 140h140" stroke="currentColor" stroke-width="2" opacity=".5"/></svg>'; }

// ---------- REGISTER ----------
const files = { photo: null, pay: null };
function regGate() {
  const c = D().settings;
  if (!S.data) return '<p class="note">Loading…</p>';
  if (!c.regOpen) return '<p class="note warn">Registrations are closed. Contact the committee if you need help.</p>';
  if (!Object.values(c.events || {}).some((l) => l && l.length)) return '<p class="note warn">No events are open for registration yet.' + (S.user && S.user.role === 'admin' ? ' Open them in Admin → Settings → Events open for registration, then Save settings.' : ' Check back soon or contact the committee.') + '</p>';
  if (c.regDeadline && new Date(c.regDeadline + 'T23:59:59') < new Date()) return '<p class="note warn">The registration deadline has passed.</p>';
  return '';
}
function renderRegister() {
  const gate = regGate(); $('#regGate').innerHTML = gate; $('#regForm').hidden = !!gate;
  const c = D().settings;
  $('#regDeadlineChip').textContent = c.regDeadline ? 'Closes ' + fmtDay(c.regDeadline) : 'Registration open';
  $('#payInfo').innerHTML = '<div class="pay">' + (c.qrId ? '<img src="' + fileUrl(c.qrId) + '" alt="Payment QR code">' : '') + '<div style="display:grid;gap:4px"><b>' + esc(c.fee) + '</b><span>' + esc(c.payNote) + '</span>' +
    (c.upiId ? '<span>UPI ID: <span class="copyable">' + esc(c.upiId) + '</span> <button type="button" class="btn small" id="cpUpi">Copy</button></span>' : '') + '</div></div>';
  const cp = $('#cpUpi'); if (cp) cp.onclick = () => navigator.clipboard.writeText(c.upiId).then(() => toast('UPI ID copied'), () => toast('Select the UPI ID to copy it'));
  syncEventOptions();
}
function syncEventOptions() {
  const evMap = D().settings.events || {};
  $$('#segCat label').forEach((l) => { const i = l.querySelector('input'); l.hidden = S.data && !(evMap[i.value] || []).length; });
  const cat = ($('input[name=cat]:checked') || {}).value;
  const allowed = cat ? (evMap[cat] || []) : ['Singles', 'Doubles', 'Mixed Doubles'];
  $$('input[name=evt]').forEach((i) => { i.disabled = !allowed.includes(i.value); if (i.disabled && i.checked) i.checked = false; });
  const evt = ($('input[name=evt]:checked') || {}).value;
  $('#partnerBlock').hidden = !(evt && evt !== 'Singles');
  const hp = ($('input[name=haspartner]:checked') || {}).value;
  $('#partnerFields').hidden = hp !== 'yes'; $('#assignNote').hidden = hp !== 'no';
  $('#evtHint').textContent = evt === 'Mixed Doubles' ? 'Mixed doubles pairs one man and one woman.' : 'Playing more than one event? Submit one registration per event.';
}
$('#regForm').addEventListener('change', syncEventOptions);
function previewFile(input, img, txt, key) {
  input.addEventListener('change', () => { const f = input.files[0]; files[key] = f || null; if (f) { img.src = URL.createObjectURL(f); img.hidden = false; txt.textContent = f.name; } else img.hidden = true; });
}
previewFile($('#fPhoto'), $('#fPhotoPrev'), $('#fPhotoTxt'), 'photo');
previewFile($('#fPay'), $('#fPayPrev'), $('#fPayTxt'), 'pay');
$('#regForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#regMsg'); msg.className = 'msg';
  const v = (id) => $(id).value.trim();
  const cat = ($('input[name=cat]:checked') || {}).value, evt = ($('input[name=evt]:checked') || {}).value, hp = ($('input[name=haspartner]:checked') || {}).value;
  const err = (t) => { msg.className = 'msg err'; msg.textContent = t; };
  if (!cat) return err('Pick a category: Men, Women, Kids – Boys or Kids – Girls.');
  if (!evt) return err('Pick an event.');
  if (!v('#fFirst') || !v('#fLast')) return err('Enter your first and last name.');
  if (v('#fMobile').replace(/\D/g, '').length < 10) return err('Enter a mobile number with at least 10 digits.');
  if (evt !== 'Singles' && !hp) return err('Tell us whether you have a partner.');
  if (hp === 'yes' && (!v('#fPName') || v('#fPMobile').replace(/\D/g, '').length < 10)) return err("Enter your partner's name and a 10-digit mobile number.");
  if (!files.photo) return err('Add your photo.');
  if (!files.pay) return err('Add the payment screenshot.');
  const btn = $('#regSubmit'); btn.disabled = true; msg.textContent = 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('category', cat); fd.append('event', evt); fd.append('firstName', v('#fFirst')); fd.append('lastName', v('#fLast')); fd.append('mobile', v('#fMobile'));
    fd.append('hasPartner', evt === 'Singles' ? 'no' : hp); fd.append('partnerName', v('#fPName')); fd.append('partnerMobile', v('#fPMobile')); fd.append('about', v('#fAbout'));
    fd.append('photo', await compress(files.photo, 1000), 'photo.jpg');
    fd.append('payment', await compress(files.pay, 1600, 0.88), 'payment.jpg');
    const r = await api('/api/register', { method: 'POST', form: fd });
    const name = v('#fFirst') + ' ' + v('#fLast');
    $('#regForm').reset(); files.photo = files.pay = null; ['#fPhotoPrev', '#fPayPrev'].forEach((s) => { $(s).hidden = true; });
    $('#fPhotoTxt').textContent = 'Choose a clear face photo (JPG or PNG)'; $('#fPayTxt').textContent = 'Upload the UPI / bank transfer screenshot';
    syncEventOptions(); msg.textContent = '';
    $('#myRegs').innerHTML = '<div class="card" style="display:grid;gap:8px"><h3>You are registered</h3><p><b>' + esc(name) + '</b> · ' + esc(r.eventKey) + '. The committee will check your payment and confirm your entry. Confirmed players appear on the Fixtures tab.</p><p style="color:var(--muted)">Registration number #' + esc(r.id) + '</p></div>';
    $('#myRegs').scrollIntoView({ behavior: 'smooth' });
    refresh();
  } catch (e) { err('Registration was not saved: ' + e.message); } finally { btn.disabled = false; }
});

// ---------- FIXTURES ----------
function renderFixtures() {
  const evs = activeEvents();
  if (!S.fxEvent || !evs.includes(S.fxEvent)) S.fxEvent = evs[0] || null;
  $('#fxMode').innerHTML = [['league', 'League'], ['knockout', 'Knockout'], ['players', 'Players']].map(([k, l]) => '<button aria-pressed="' + (S.fxMode === k) + '" data-mode="' + k + '">' + l + '</button>').join('');
  $('#fxEvents').innerHTML = evs.map((k) => '<button aria-pressed="' + (S.fxEvent === k) + '" data-ev="' + esc(k) + '">' + esc(k) + '</button>').join('');
  const b = $('#fxBody');
  if (!evs.length) { b.innerHTML = '<div class="empty">No entries yet. Fixtures appear here once players register and the committee draws the groups.</div>'; return; }
  const ev = S.fxEvent, f = fmtOf(ev);
  const fmtLine = '<div class="kv" style="margin-bottom:16px"><span>League <b>' + esc(stageLabel(f.league)) + '</b></span><span>Knockout <b>' + esc(stageLabel(f.knockout)) + '</b></span><span>Top <b>' + f.knockout.qualifiers + '</b> per group go through</span></div>';
  if (S.fxMode === 'players') { b.innerHTML = playersHtml(ev); return; }
  if (S.fxMode === 'knockout') { b.innerHTML = fmtLine + bracketHtml(ev); return; }
  const tm = teamMap();
  const st = D().standings[ev] || {};
  const groups = Object.keys(st).sort();
  let h = fmtLine;
  const confirmed = D().teams.filter((t) => t.event_key === ev).length;
  if (!groups.length) h += '<div class="empty">Groups for ' + esc(ev) + ' have not been drawn yet. ' + confirmed + ' ' + unit(ev, confirmed) + ' confirmed so far.</div>';
  if (groups.length) h += '<div class="section-head" style="margin-bottom:12px"><h2>Points table</h2><span class="chip">Updates as each match finishes</span></div>';
  if (groups.length) h += '<div class="groups">' + groups.map((g) => '<div class="card group-card"><h3>Group ' + esc(g) + '<span class="chip">' + st[g].length + ' ' + unit(ev, st[g].length) + '</span></h3><div class="table-wrap"><table class="std"><thead><tr><th>' + (isPair(ev) ? 'Team' : 'Player') +
    '</th><th>P</th><th>W</th><th>L</th><th>Games</th><th>+/−</th><th>Pts</th></tr></thead><tbody>' +
    st[g].map((r, i) => '<tr class="' + (i < f.knockout.qualifiers ? 'q' : '') + '"><td>' + esc(teamName(r.team, tm)) + '</td><td>' + r.p + '</td><td>' + r.w + '</td><td>' + r.l + '</td><td>' + r.gw + '–' + r.gl + '</td><td>' + (r.pf - r.pa > 0 ? '+' : '') + (r.pf - r.pa) + '</td><td><b>' + r.pts + '</b></td></tr>').join('') +
    '</tbody></table></div><p style="font-size:12px;color:var(--muted);margin-top:8px">Green marker: knockout places. 2 points per win, then wins, game difference, point difference.</p></div>').join('') + '</div>';
  const lg = D().matches.filter((m) => m.event_key === ev && m.stage === 'league');
  if (lg.length) h += '<div class="section" style="margin-top:28px"><div class="section-head"><h2>League matches</h2><span class="chip">' + lg.filter((m) => m.status === 'done').length + ' of ' + lg.length + ' played</span></div><div class="matches">' + lg.map((m) => matchHtml(m, tm)).join('') + '</div></div>';
  b.innerHTML = h;
}
$('#fxMode').addEventListener('click', (e) => { const x = e.target.closest('button'); if (x) { S.fxMode = x.dataset.mode; renderFixtures(); } });
$('#fxEvents').addEventListener('click', (e) => { const x = e.target.closest('button'); if (x) { S.fxEvent = x.dataset.ev; renderFixtures(); } });

function matchActions(m) {
  if (!S.user) return '';
  let a = '';
  if (canScore(m) && ((m.status === 'scheduled' && m.team_a && m.team_b) || m.status === 'live')) a += '<button class="btn small primary" data-act="console" data-id="' + m.id + '">' + (m.status === 'live' ? 'Score' : 'Score this match') + '</button>';
  if (S.user.role === 'admin') a += '<button class="btn small" data-act="edit" data-id="' + m.id + '">Edit</button>';
  return a ? '<span class="sp">' + a + '</span>' : '';
}
function matchHtml(m, tm = teamMap()) {
  const [ga, gb] = tally(m);
  const sc = (m.games || []).filter((g) => g[0] || g[1]).map((g) => g[0] + '–' + g[1]).join(', ');
  const st = m.status === 'live' ? '<span class="chip live">LIVE</span>' : m.status === 'done' ? '<span class="chip">Final</span>' : m.status === 'bye' ? '<span class="chip">Bye</span>' : '<span class="chip warn">Scheduled</span>';
  return '<div class="match"><div class="side ' + (m.winner && m.winner === m.team_a ? 'win' : '') + '">' + esc(teamName(m.team_a, tm)) + '</div><div class="mid">' +
    (m.status === 'scheduled' || m.status === 'bye' ? '<b>vs</b>' : '<b class="tab-num">' + ga + ' – ' + gb + '</b><span class="tab-num">' + esc(sc) + '</span>') +
    '</div><div class="side b ' + (m.winner && m.winner === m.team_b ? 'win' : '') + '">' + esc(teamName(m.team_b, tm)) + '</div><div class="meta">' + st + '<span>' + esc(m.round_name) + '</span>' +
    (m.court ? '<span>Court ' + esc(m.court) + '</span>' : '') + (m.start_time ? '<span>' + esc(fmtDate(m.start_time)) + '</span>' : '') + '<span>' + esc(m.event_key) + ' · ' + (m.best_of === 1 ? '1 game' : 'Bo' + m.best_of) + ' to ' + m.points + '</span>' +
    (m.result_note ? '<span class="chip warn">' + esc(m.result_note) + '</span>' : '') + (m.umpire_id ? '<span>Umpire: ' + esc(officialName(m.umpire_id)) + '</span>' : '') + matchActions(m) + '</div></div>';
}
function bracketHtml(ev) {
  const tm = teamMap();
  const ko = D().matches.filter((m) => m.event_key === ev && m.stage === 'knockout');
  if (!ko.length) return '<div class="empty">The knockout draw for ' + esc(ev) + ' appears here once the league stage is complete.</div>';
  const bracketed = ko.filter((m) => m.round > 0), extra = ko.filter((m) => !m.round);
  const rounds = [...new Set(bracketed.map((m) => m.round))].sort((a, b) => a - b);
  let h = '<div class="bracket">' + rounds.map((r) => {
    const ms = bracketed.filter((m) => m.round === r).sort((a, b) => a.slot - b.slot);
    return '<div class="col"><h4>' + esc(ms[0].round_name) + '</h4>' + ms.map((m) => {
      const [ga, gb] = tally(m);
      const row = (t, g) => '<div class="t ' + (m.winner && m.winner === t ? 'win' : '') + '"><span>' + esc(m.status === 'bye' && !t ? 'Bye' : teamName(t, tm)) + '</span><b>' + (m.status === 'done' || m.status === 'live' ? g : '') + '</b></div>';
      return '<div class="bk ' + (m.status === 'live' ? 'live' : '') + '">' + row(m.team_a, ga) + row(m.team_b, gb) + '<div class="ft">' + (m.status === 'live' ? '<span class="chip live">LIVE</span>' : '') +
        esc([(m.games || []).filter((g) => g[0] || g[1]).map((g) => g[0] + '–' + g[1]).join(', '), m.result_note].filter(Boolean).join(' · ') || (m.court ? 'Court ' + m.court : m.status === 'bye' ? 'Advances' : 'Scheduled')) + matchActions(m) + '</div></div>';
    }).join('') + '</div>';
  }).join('') + '</div>';
  if (extra.length) h += '<div class="section"><div class="section-head"><h2>Other knockout matches</h2></div><div class="matches">' + extra.map((m) => matchHtml(m, tm)).join('') + '</div></div>';
  return h;
}
function playersHtml(ev) {
  const tm = teamMap();
  const es = D().players.filter((e) => e.event_key === ev);
  const manual = D().teams.filter((t) => t.event_key === ev && !(t.reg_ids || []).length);
  if (!es.length && !manual.length) return '<div class="empty">No players registered for ' + esc(ev) + ' yet.</div>';
  return '<div class="players">' + es.map((e) => {
    const name = e.first_name + ' ' + e.last_name;
    const t = e.team_id && tm[e.team_id];
    const partner = e.event === 'Singles' ? '' : t ? teamName(t.id, tm) : e.has_partner ? 'With ' + e.partner_name : 'Partner to be assigned';
    return '<article class="player"><div class="ph">' + (e.photo_id ? '<img loading="lazy" src="' + fileUrl(e.photo_id) + '" alt="' + esc(name) + '">' : esc(name[0])) + '</div><div class="pb"><b>' + esc(name) + '</b><div class="chips"><span class="chip">' + esc(e.category) + '</span><span class="chip">' + esc(e.event) + '</span>' +
      (t && t.grp ? '<span class="chip cork">Group ' + esc(t.grp) + '</span>' : '') + (e.status === 'pending' ? '<span class="chip warn">Awaiting confirmation</span>' : '') + '</div>' + (partner ? '<span style="font-size:13px;font-weight:600">' + esc(partner) + '</span>' : '') + (e.about ? '<p>' + esc(e.about) + '</p>' : '') + '</div></article>';
  }).join('') + manual.map((t) => '<article class="player"><div class="ph">' + esc((t.names[0] || '?')[0]) + '</div><div class="pb"><b>' + esc(t.names.join(' / ')) + '</b><div class="chips">' + (t.grp ? '<span class="chip cork">Group ' + esc(t.grp) + '</span>' : '') + '</div></div></article>').join('') + '</div>';
}

// ---------- LIVE ----------
function renderLive() {
  const tm = teamMap(), ms = D().matches;
  const live = ms.filter((m) => m.status === 'live');
  $('#liveCount').textContent = live.length ? live.length + ' on court' : 'No matches on court';
  $('#liveNow').innerHTML = live.length ? live.map((m) => boardHtml(m, tm)).join('') : '<div class="empty">No match is in play right now. This board updates on its own when a match starts.</div>';
  const next = ms.filter((m) => m.status === 'scheduled' && m.team_a && m.team_b).sort((a, b) => (a.start_time || '~').localeCompare(b.start_time || '~') || a.seq - b.seq).slice(0, 10);
  const done = ms.filter((m) => m.status === 'done').sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0)).slice(0, 10);
  $('#liveNext').innerHTML = next.length ? next.map((m) => matchHtml(m, tm)).join('') : '<div class="empty">Nothing scheduled.</div>';
  $('#liveDone').innerHTML = done.length ? done.map((m) => matchHtml(m, tm)).join('') : '<div class="empty">No results yet.</div>';
}
const shortName = (id, tm) => { const n = teamName(id, tm); return n.length > 18 ? n.split(' ')[0] : n; };
function boardHtml(m, tm) {
  const g = m.games && m.games.length ? m.games : [[0, 0]];
  const cur = g[g.length - 1], prev = g.slice(0, -1);
  const row = (t, i) => '<div class="board-row"><div class="nm">' + (m.server === i ? '<i class="serve" title="Serving"></i>' : '') + esc(teamName(t, tm)) + '</div><div class="gms tab-num">' + prev.map((p) => '<span>' + p[i] + '</span>').join('') + '</div><div class="cur tab-num">' + cur[i] + '</div></div>';
  const ctrl = canScore(m) ? '<div class="board-ctrl"><button class="btn small" data-act="console" data-id="' + m.id + '">Open scorer</button><button class="btn primary" data-act="pt" data-side="a" data-id="' + m.id + '">+1 ' + esc(shortName(m.team_a, tm)) + '</button><button class="btn primary" data-act="pt" data-side="b" data-id="' + m.id + '">+1 ' + esc(shortName(m.team_b, tm)) + '</button><button class="btn small" data-act="undo" data-id="' + m.id + '">Undo</button>' +
    (S.user.role === 'admin' ? '<button class="btn small" data-act="edit" data-id="' + m.id + '">Edit</button>' : '') + '</div>' : '';
  return '<div class="board"><div class="board-head"><span>' + esc(m.event_key) + ' · ' + esc(m.round_name) + '</span><span>' + (m.court ? 'Court ' + esc(m.court) + ' · ' : '') + 'Game ' + g.length + ' of ' + (m.best_of === 1 ? '1' : 'best ' + m.best_of) + ' · to ' + m.points + (m.umpire_id ? ' · Umpire ' + esc(officialName(m.umpire_id)) : '') + '</span></div>' + row(m.team_a, 0) + row(m.team_b, 1) + ctrl + '</div>';
}
let scoring = false;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = +b.dataset.id, a = b.dataset.act;
  if (a === 'edit') return matchEditor(D().matches.find((m) => m.id === id));
  if (a === 'console') { S.scoreId = id; if (location.hash === '#score') renderScore(); else location.hash = '#score'; return; }
  if ((a === 'pt' || a === 'undo') && !scoring) {
    scoring = true;
    try {
      await scoreCall(id, a === 'pt' ? 'point' : 'undo', { side: b.dataset.side });
    } catch (er) { toast(er.message); } finally { scoring = false; }
  }
});

// ---------- ADMIN ----------
function renderAdmin() {
  const body = $('#adminBody'), st = $('#adminState');
  if (!S.setup) { body.innerHTML = '<p class="note">Loading…</p>'; return; }
  if (!S.user && S.setup.needsSetup) return renderSetup(body);
  if (!S.user) { st.innerHTML = ''; return renderLogin(body); }
  st.innerHTML = '<span class="chip">' + esc(S.user.display_name || S.user.username) + ' · ' + esc(ROLE_LABEL[S.user.role]) + '</span> <button class="btn small" id="logoutBtn">Sign out</button>';
  $('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); S.user = null; S.scoreId = null; location.hash = '#admin'; renderAll(); };
  if (S.user.role !== 'admin') {
    body.innerHTML = '<div class="card" style="display:grid;gap:10px;max-width:560px"><h3>' + ROLE_LABEL[S.user.role] + ' access</h3><p>' + (S.user.role === 'umpire' ? 'You can score matches assigned to you, and any unassigned match you start.' : 'You can score any match.') +
      ' Open the Score tab, pick a match, choose who serves first, then tap a side for every rally. Games and matches end on their own, and the points table updates when a match finishes.</p><a class="btn primary" href="#score" style="justify-self:start">Open the Score tab</a></div>' + passwordCard();
    bindPassword(); return;
  }
  const tabs = [['regs', 'Registrations'], ['event', 'Event setup'], ['matches', 'Matches'], ['settings', 'Settings'], ['users', 'Users'], ['data', 'Testing & reset']];
  body.innerHTML = '<div class="admin-tabs">' + tabs.map(([k, l]) => '<button aria-pressed="' + (S.adminTab === k) + '" data-tab="' + k + '">' + l + '</button>').join('') + '</div><div id="adminPane" style="margin-top:16px"></div>';
  body.querySelector('.admin-tabs').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return; S.adminTab = b.dataset.tab;
    if (S.adminTab === 'regs') S.regs = await api('/api/admin/registrations').catch(() => S.regs);
    if (S.adminTab === 'users') S.users = await api('/api/admin/users').catch(() => []);
    renderAdmin();
  };
  ({ regs: adminRegs, event: adminEvent, matches: adminMatches, settings: adminSettings, users: adminUsers, data: adminData })[S.adminTab]($('#adminPane'));
}

function renderSetup(body) {
  body.innerHTML = '<form class="card form setup" id="setupForm"><h3>Set up your tournament</h3><p>Create the first admin account. You can add more admins and scorers afterwards.</p>' +
    (S.setup.tokenRequired ? '<label class="f">Setup token <small>the SETUP_TOKEN value from your Railway variables</small><input type="password" id="suToken" autocomplete="off" required></label>' : '<p class="note warn">No SETUP_TOKEN is set, so anyone who opens this page first can create the admin account. Finish setup now.</p>') +
    '<label class="f">Tournament name<input type="text" id="suName" value="' + esc(D().settings.name || '') + '" required></label><label class="f">Admin username<input type="text" id="suUser" autocomplete="username" required></label>' +
    '<label class="f">Password <small>at least 10 characters</small><input type="password" id="suPass" autocomplete="new-password" required></label><label class="f">Confirm password<input type="password" id="suPass2" autocomplete="new-password" required></label>' +
    '<div class="toolbar"><button class="btn primary">Create admin</button><span class="msg err" id="suErr"></span></div></form>';
  $('#setupForm').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#suPass').value !== $('#suPass2').value) { $('#suErr').textContent = 'Passwords do not match.'; return; }
    try {
      await api('/api/setup', { method: 'POST', body: { setupToken: ($('#suToken') || {}).value, tournamentName: $('#suName').value, username: $('#suUser').value, password: $('#suPass').value } });
      await loadSession(); S.adminTab = 'settings'; await refresh(); toast('Setup complete. Fill in your tournament details.');
    } catch (er) { $('#suErr').textContent = er.message; }
  };
}
function renderLogin(body) {
  body.innerHTML = '<form class="card form setup" id="loginForm"><h3>Sign in</h3><p>For tournament admins, scorers and umpires.</p><label class="f">Username<input type="text" id="liUser" autocomplete="username" required></label><label class="f">Password<input type="password" id="liPass" autocomplete="current-password" required></label><div class="toolbar"><button class="btn primary">Sign in</button><span class="msg err" id="liErr"></span></div></form>';
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: $('#liUser').value, password: $('#liPass').value } });
      await loadSession(); await refresh();
      if (S.user && S.user.role !== 'admin') location.hash = '#score';
    }
    catch (er) { $('#liErr').textContent = er.message; }
  };
}
function passwordCard() { return '<form class="card form" id="pwForm" style="max-width:420px;margin-top:16px"><h3>Change your password</h3><label class="f">Current password<input type="password" id="pwCur" autocomplete="current-password"></label><label class="f">New password<input type="password" id="pwNew" autocomplete="new-password" minlength="10"></label><button class="btn">Update password</button></form>'; }
function bindPassword() {
  const f = $('#pwForm'); if (!f) return;
  f.onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/password', { method: 'POST', body: { current: $('#pwCur').value, next: $('#pwNew').value } }); f.reset(); toast('Password updated'); } catch (er) { toast(er.message); } };
}

// Registrations
const statusChip = (s) => (s === 'approved' ? '<span class="chip good">Confirmed</span>' : s === 'rejected' ? '<span class="chip bad">Rejected</span>' : '<span class="chip warn">Awaiting review</span>');
const needsPartner = (r) => r.status !== 'rejected' && r.event !== 'Singles' && !r.has_partner && !r.team_id;
function adminRegs(p) {
  const all = S.regs.filter((r) => !S.regEvent || r.event_key === S.regEvent);
  const F = { all: () => true, pending: (r) => r.status === 'pending', needs: needsPartner, approved: (r) => r.status === 'approved', rejected: (r) => r.status === 'rejected' };
  const list = all.filter(F[S.regFilter]);
  const sel = [...S.selected].filter((id) => list.some((r) => r.id === id));
  p.innerHTML = '<div class="toolbar" style="margin-bottom:12px"><select id="rEv" aria-label="Event"><option value="">All events</option>' + D().eventKeys.map((k) => '<option ' + (k === S.regEvent ? 'selected' : '') + '>' + esc(k) + '</option>').join('') + '</select><div class="pillbar" id="rf">' +
    [['pending', 'Awaiting review'], ['needs', 'Needs partner'], ['approved', 'Confirmed'], ['rejected', 'Rejected'], ['all', 'All']].map(([k, l]) => '<button aria-pressed="' + (S.regFilter === k) + '" data-f="' + k + '">' + l + ' · ' + all.filter(F[k]).length + '</button>').join('') + '</div></div>' +
    (S.regFilter === 'needs' ? '<div class="toolbar" style="margin-bottom:12px"><button class="btn small primary" id="pairBtn" ' + (sel.length === 2 ? '' : 'disabled') + '>Pair the 2 selected</button><span style="font-size:13px;color:var(--muted)">Tick two players from the same event to make a team.</span></div>' : '') +
    '<div class="card">' + (list.length ? list.map((r) => {
      const name = r.first_name + ' ' + r.last_name;
      return '<div class="reg">' + (S.regFilter === 'needs' ? '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-sel="' + r.id + '" ' + (S.selected.has(r.id) ? 'checked' : '') + ' aria-label="Select ' + esc(name) + '">' : '') +
        (r.photo_id ? '<img class="av" src="' + fileUrl(r.photo_id) + '" alt="" data-img="' + r.photo_id + '">' : '<span class="av">' + esc(name[0]) + '</span>') + (S.regFilter === 'needs' ? '</label>' : '') +
        '<div><b>' + esc(name) + '</b> · ' + esc(r.event_key) + ' ' + statusChip(r.status) + '<div class="sub">#' + r.id + ' · Mobile <span class="copyable">' + esc(r.mobile) + '</span>' +
        (r.event !== 'Singles' ? (r.has_partner ? ' · Partner: ' + esc(r.partner_name) + ' (<span class="copyable">' + esc(r.partner_mobile) + '</span>)' : ' · Needs a partner') : '') +
        (r.team_id ? ' · Team: ' + esc(teamName(r.team_id)) : '') + ' · ' + new Date(r.created_at).toLocaleDateString() + '</div>' + (r.about ? '<div class="sub">' + esc(r.about) + '</div>' : '') + '</div><div class="act">' +
        (r.payment_id ? '<button class="btn small" data-img="' + r.payment_id + '">Payment</button>' : '') +
        (r.status !== 'approved' ? '<button class="btn small primary" data-ap="' + r.id + '">Confirm</button>' : '') +
        (r.status !== 'rejected' ? '<button class="btn small danger" data-rj="' + r.id + '">Reject</button>' : '') + '</div></div>';
    }).join('') : '<div class="empty">No registrations in this view.</div>') + '</div>';
  p.querySelector('#rEv').onchange = (e) => { S.regEvent = e.target.value; S.selected.clear(); renderAdmin(); };
  p.querySelector('#rf').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.regFilter = b.dataset.f; S.selected.clear(); renderAdmin(); } };
  $$('[data-sel]', p).forEach((cb) => { cb.onchange = () => { const id = +cb.dataset.sel; if (cb.checked) S.selected.add(id); else S.selected.delete(id); renderAdmin(); }; });
  $$('[data-img]', p).forEach((b) => { b.onclick = () => modal('<img src="' + fileUrl(b.dataset.img) + '" alt=""><button class="btn" data-close>Close</button>'); });
  $$('[data-ap]', p).forEach((b) => { b.onclick = () => act('/api/admin/registrations/' + b.dataset.ap + '/approve', {}, 'POST', 'Entry confirmed'); });
  $$('[data-rj]', p).forEach((b) => { b.onclick = () => confirmBox('This entry will be removed from teams and fixtures that have not started.', 'Reject entry', () => act('/api/admin/registrations/' + b.dataset.rj + '/reject', {}, 'POST', 'Entry rejected')); });
  const pb = p.querySelector('#pairBtn');
  if (pb) pb.onclick = async () => { await act('/api/admin/teams/pair', { regIds: sel }, 'POST', 'Team created'); S.selected.clear(); };
}

// Event setup: format, groups, league, knockout
function stageInputs(prefix, s, isKo) {
  const pts = [11, 15, 21];
  return '<div class="fmt-grid">' +
    (isKo ? '<label class="f">Qualify from each group<select id="' + prefix + 'Q">' + [1, 2, 3, 4].map((n) => '<option value="' + n + '" ' + (s.qualifiers === n ? 'selected' : '') + '>Top ' + n + '</option>').join('') + '</select></label>' : '') +
    '<label class="f">Points per game<select id="' + prefix + 'P">' + pts.map((n) => '<option ' + (s.points === n ? 'selected' : '') + '>' + n + '</option>').join('') + (pts.includes(s.points) ? '' : '<option selected>' + s.points + '</option>') + '</select></label>' +
    '<label class="f">Games<select id="' + prefix + 'B">' + [1, 3, 5].map((n) => '<option value="' + n + '" ' + (s.bestOf === n ? 'selected' : '') + '>' + (n === 1 ? '1 game' : 'Best of ' + n) + '</option>').join('') + '</select></label>' +
    '<label class="f">Score cap <small>max points</small><input type="number" id="' + prefix + 'C" min="5" max="99" value="' + s.cap + '"></label></div>';
}
function adminEvent(p) {
  const evs = D().eventKeys;
  if (!S.adminEv) S.adminEv = activeEvents()[0] || evs[0];
  const ev = S.adminEv, f = fmtOf(ev), tm = teamMap();
  const teams = D().teams.filter((t) => t.event_key === ev).sort((a, b) => (a.grp || '~').localeCompare(b.grp || '~') || a.id - b.id);
  const league = D().matches.filter((m) => m.event_key === ev && m.stage === 'league');
  const ko = D().matches.filter((m) => m.event_key === ev && m.stage === 'knockout');
  const st = D().standings[ev] || {};
  const groups = Object.keys(st).sort();
  const quals = groups.flatMap((g) => st[g].slice(0, f.knockout.qualifiers).map((r, i) => g + (i + 1) + ' ' + teamName(r.team, tm)));
  const usedGroups = Math.max(f.groups, ...teams.map((t) => LETTERS.indexOf(t.grp) + 1));
  p.innerHTML = '<div class="toolbar" style="margin-bottom:16px"><label class="f" style="display:flex;gap:8px;align-items:center">Event<select id="aEv">' + evs.map((k) => '<option ' + (k === ev ? 'selected' : '') + '>' + esc(k) + '</option>').join('') + '</select></label><span class="chip">' + teams.length + ' confirmed ' + unit(ev, teams.length) + '</span></div>' +
    '<div style="display:grid;gap:16px">' +
    // 1. Format
    '<form class="card stage-card" id="fmtForm"><div class="section-head"><h3>1 · Match format</h3></div><b>League stage</b>' + stageInputs('fL', f.league, false) + '<b>Knockout stage</b>' + stageInputs('fK', f.knockout, true) +
    '<p class="note">Changes apply to matches that have not started. Common choices: 1 game to 21, best of 3 to 15, or best of 3 to 21.</p><div class="toolbar"><button class="btn primary">Save for ' + esc(ev) + '</button><button class="btn" type="button" id="fmtAll">Save for all events</button></div></form>' +
    // 2. Groups
    '<div class="card stage-card"><div class="section-head"><h3>2 · Groups</h3><span class="chip">' + groups.length + ' group(s)</span></div>' +
    '<div class="toolbar"><b>Automatic</b><label class="f" style="display:flex;gap:6px;align-items:center;font-weight:500">Number of groups<input type="number" id="gN" min="1" max="16" value="' + Math.min(Math.max(1, f.groups), Math.max(1, teams.length)) + '" style="width:80px"></label><button class="btn primary small" id="drawBtn" ' + (teams.length < 2 ? 'disabled' : '') + '>Draw groups randomly</button></div>' +
    '<p style="font-size:13px;color:var(--muted)">Or set each ' + unit(ev, 1) + "'s group by hand below. Manual changes take effect when you create the league matches.</p>" +
    '<div>' + (teams.length ? teams.map((t) => '<div class="reg" style="grid-template-columns:1fr auto"><div><b>' + esc(t.names.join(' / ')) + '</b><div class="sub">' + (t.reg_ids.length ? 'From registration' : 'Added by admin') + '</div></div><div class="act"><select data-grp="' + t.id + '" aria-label="Group for ' + esc(t.names.join(' / ')) + '"><option value="">No group</option>' +
      LETTERS.slice(0, Math.max(usedGroups, 2) + 1).map((g) => '<option value="' + g + '" ' + (t.grp === g ? 'selected' : '') + '>Group ' + g + '</option>').join('') + '</select><button class="btn small danger" data-deltm="' + t.id + '">Remove</button></div></div>').join('') : '<div class="empty">No confirmed entries yet. Confirm registrations first, or add one by hand.</div>') + '</div>' +
    '<div class="toolbar"><button class="btn small" id="addTeam">Add ' + unit(ev, 1) + ' by hand</button></div></div>' +
    // 3. League
    '<div class="card stage-card"><div class="section-head"><h3>3 · League matches</h3><span class="chip">' + league.filter((m) => m.status === 'done').length + ' of ' + league.length + ' played</span></div>' +
    '<p>Creates a round robin inside each group: everyone plays everyone once, using the league format above.</p><div class="toolbar"><button class="btn primary small" id="leagueBtn" ' + (groups.length ? '' : 'disabled') + '>' + (league.length ? 'Recreate league matches' : 'Create league matches') + '</button>' + (league.length ? '<a class="btn small" href="#fixtures">View standings</a>' : '') + '</div></div>' +
    // 4. Knockout
    '<div class="card stage-card"><div class="section-head"><h3>4 · Knockout</h3><span class="chip">Top ' + f.knockout.qualifiers + ' per group</span></div>' +
    (quals.length ? '<p>Current qualifiers (' + quals.length + '): ' + esc(quals.join(' · ')) + '</p>' : '<p>Qualifiers appear once groups have standings.</p>') +
    '<p style="font-size:13px;color:var(--muted)">Group winners are seeded first and teams from the same group are kept apart in the first round where possible. If the qualifier count is not a power of two, top seeds get a bye.</p>' +
    '<div class="toolbar"><button class="btn primary small" id="koBtn" ' + (quals.length >= 2 ? '' : 'disabled') + '>' + (ko.length ? 'Regenerate knockout draw' : 'Generate knockout draw') + '</button>' + (ko.length ? '<button class="btn small danger" id="koClear">Clear knockout</button><button class="btn small" id="koView">View bracket</button>' : '') + '</div></div>' +
    '</div>';
  const enc = encodeURIComponent(ev);
  p.querySelector('#aEv').onchange = (e) => { S.adminEv = e.target.value; renderAdmin(); };
  const readFmt = () => ({
    groups: +p.querySelector('#gN').value || f.groups,
    league: { points: +p.querySelector('#fLP').value, bestOf: +p.querySelector('#fLB').value, cap: +p.querySelector('#fLC').value },
    knockout: { qualifiers: +p.querySelector('#fKQ').value, points: +p.querySelector('#fKP').value, bestOf: +p.querySelector('#fKB').value, cap: +p.querySelector('#fKC').value },
  });
  // Keep the cap sensible when the points change.
  [['#fLP', '#fLC'], ['#fKP', '#fKC']].forEach(([a, c]) => { p.querySelector(a).onchange = (e) => { const n = +e.target.value; p.querySelector(c).value = Math.max(n, Math.round(n * 10 / 7)); }; });
  p.querySelector('#fmtForm').onsubmit = (e) => { e.preventDefault(); act('/api/admin/formats/' + enc, { format: readFmt() }, 'PUT', 'Format saved for ' + ev); };
  p.querySelector('#fmtAll').onclick = () => confirmBox('Use this format for every event?', 'Save for all events', () => act('/api/admin/formats/' + enc, { format: readFmt(), applyToAll: true }, 'PUT', 'Format saved for all events'));
  p.querySelector('#drawBtn').onclick = () => confirmBox('Shuffle ' + teams.length + ' ' + unit(ev, teams.length) + ' into ' + p.querySelector('#gN').value + ' group(s)? This clears existing league matches for ' + ev + '.', 'Draw groups', () => act('/api/admin/events/' + enc + '/draw', { groups: +p.querySelector('#gN').value }, 'POST', 'Groups drawn. Now create the league matches.'));
  $$('[data-grp]', p).forEach((s) => { s.onchange = () => act('/api/admin/teams/' + s.dataset.grp, { group: s.value }, 'PATCH'); });
  $$('[data-deltm]', p).forEach((b) => { b.onclick = () => confirmBox('Remove ' + teamName(+b.dataset.deltm, tm) + '? Their unplayed league matches are deleted and linked registrations go back to Awaiting review.', 'Remove', () => act('/api/admin/teams/' + b.dataset.deltm, {}, 'DELETE', 'Removed')); });
  p.querySelector('#addTeam').onclick = () => modal('<h3>Add to ' + esc(ev) + '</h3><label class="f">' + (isPair(ev) ? 'Player 1' : 'Player') + '<input type="text" id="mt1"></label>' + (isPair(ev) ? '<label class="f">Player 2<input type="text" id="mt2"></label>' : '') +
    '<label class="f">Group<select id="mtG"><option value="">No group</option>' + LETTERS.slice(0, Math.max(usedGroups, 2)).map((g) => '<option>' + g + '</option>').join('') + '</select></label><div class="toolbar"><button class="btn primary" id="mtSave">Add</button><button class="btn" data-close>Cancel</button></div>',
  (m) => { m.querySelector('#mtSave').onclick = () => { const names = [m.querySelector('#mt1').value, (m.querySelector('#mt2') || { value: '' }).value]; closeModal(); act('/api/admin/teams', { eventKey: ev, names, group: m.querySelector('#mtG').value }, 'POST', 'Added'); }; });
  p.querySelector('#leagueBtn').onclick = () => confirmBox('Create the round robin for ' + groups.length + ' group(s) in ' + ev + (league.length ? '? Existing league matches will be replaced.' : '?'), 'Create matches', () => act('/api/admin/events/' + enc + '/league', {}, 'POST', 'League matches created'));
  p.querySelector('#koBtn').onclick = () => confirmBox('Build the knockout draw from the top ' + f.knockout.qualifiers + ' of each group?' + (ko.length ? ' The current knockout matches will be replaced.' : ''), 'Generate draw', () => act('/api/admin/events/' + enc + '/knockout', {}, 'POST', 'Knockout draw created'));
  const kc = p.querySelector('#koClear'); if (kc) kc.onclick = () => confirmBox('Delete all knockout matches for ' + ev + '?', 'Clear knockout', () => act('/api/admin/events/' + enc + '/knockout', {}, 'DELETE', 'Knockout cleared'));
  const kv = p.querySelector('#koView'); if (kv) kv.onclick = () => { S.fxEvent = ev; S.fxMode = 'knockout'; location.hash = '#fixtures'; };
}

// Matches
function adminMatches(p) {
  const tm = teamMap();
  const ms = D().matches.filter((m) => !S.matchEvent || m.event_key === S.matchEvent).sort((a, b) => a.event_key.localeCompare(b.event_key) || a.seq - b.seq);
  p.innerHTML = '<div class="toolbar" style="margin-bottom:12px"><select id="mEv" aria-label="Event"><option value="">All events</option>' + D().eventKeys.map((k) => '<option ' + (k === S.matchEvent ? 'selected' : '') + '>' + esc(k) + '</option>').join('') + '</select><button class="btn primary small" id="newM">Add match</button><span style="font-size:13px;color:var(--muted)">Edit sets the court, start time, players or a corrected score.</span></div>' +
    '<div class="matches">' + (ms.length ? ms.map((m) => matchHtml(m, tm)).join('') : '<div class="empty">No matches yet. Create them from Event setup.</div>') + '</div>';
  p.querySelector('#mEv').onchange = (e) => { S.matchEvent = e.target.value; renderAdmin(); };
  p.querySelector('#newM').onclick = () => matchEditor(null);
}
function matchEditor(m) {
  if (!S.user || S.user.role !== 'admin') return;
  const isNew = !m;
  m = m || { event_key: S.matchEvent || S.adminEv || activeEvents()[0] || D().eventKeys[0], stage: 'knockout', round_name: 'Final', team_a: null, team_b: null, court: '', start_time: '', games: [], best_of: 3, status: 'scheduled' };
  const opts = (ev, sel) => '<option value="">TBD</option>' + D().teams.filter((t) => t.event_key === ev).map((t) => '<option value="' + t.id + '" ' + (t.id === sel ? 'selected' : '') + '>' + esc(t.names.join(' / ')) + '</option>').join('');
  const rows = Math.max(m.best_of || 1, (m.games || []).length);
  const games = Array.from({ length: rows }, (_, i) => (m.games || [])[i] || ['', '']);
  const md = modal('<h3>' + (isNew ? 'Add match' : 'Edit match') + '</h3>' +
    (isNew ? '<div class="row"><label class="f">Event<select id="meEv">' + D().eventKeys.map((k) => '<option ' + (k === m.event_key ? 'selected' : '') + '>' + esc(k) + '</option>').join('') + '</select></label><label class="f">Stage<select id="meStage"><option value="knockout">Knockout</option><option value="league">League</option></select></label></div>' : '<p class="sub">' + esc(m.event_key) + ' · ' + esc(m.stage) + '</p>') +
    '<label class="f">Round name<input type="text" id="meRound" value="' + esc(m.round_name) + '"></label>' +
    '<div class="row"><label class="f">Side A<select id="meA">' + opts(m.event_key, m.team_a) + '</select></label><label class="f">Side B<select id="meB">' + opts(m.event_key, m.team_b) + '</select></label></div>' +
    '<div class="row"><label class="f">Court<input type="text" id="meCourt" value="' + esc(m.court) + '"></label><label class="f">Start time<input type="datetime-local" id="meTime" value="' + esc(m.start_time) + '"></label></div>' +
    '<label class="f">Umpire <small>only this umpire can score it; scorers and admins always can</small><select id="meUmp"><option value="">Not assigned (any umpire can take it)</option>' +
    Object.entries(D().officials || {}).map(([id, n]) => '<option value="' + id + '" ' + (+id === m.umpire_id ? 'selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></label>' +
    (isNew ? '' : '<fieldset><legend>Score (A – B), leave blank for games not played</legend>' + games.map((g, i) => '<div class="toolbar"><span style="width:64px">Game ' + (i + 1) + '</span><input type="number" min="0" max="99" data-g="' + i + '" data-s="0" value="' + g[0] + '" style="width:80px" aria-label="Game ' + (i + 1) + ' side A"><span>–</span><input type="number" min="0" max="99" data-g="' + i + '" data-s="1" value="' + g[1] + '" style="width:80px" aria-label="Game ' + (i + 1) + ' side B"></div>').join('') + '</fieldset>') +
    '<div class="toolbar"><button class="btn primary" id="meSave">Save</button><button class="btn" data-close>Cancel</button>' + (isNew ? '' : '<button class="btn danger" id="meDel" style="margin-left:auto">Delete</button>') + '</div>');
  if (isNew) md.querySelector('#meEv').onchange = (e) => { md.querySelector('#meA').innerHTML = opts(e.target.value); md.querySelector('#meB').innerHTML = opts(e.target.value); };
  const origScore = JSON.stringify((m.games || []).filter((g) => g[0] || g[1]));
  md.querySelector('#meSave').onclick = async () => {
    const v = (s) => md.querySelector(s).value;
    closeModal();
    if (isNew) return act('/api/admin/matches', { eventKey: v('#meEv'), stage: v('#meStage'), roundName: v('#meRound'), teamA: +v('#meA') || null, teamB: +v('#meB') || null, court: v('#meCourt'), startTime: v('#meTime'), umpireId: +v('#meUmp') || null }, 'POST', 'Match added');
    const body = { roundName: v('#meRound'), teamA: +v('#meA') || null, teamB: +v('#meB') || null, court: v('#meCourt'), startTime: v('#meTime'), umpireId: +v('#meUmp') || null };
    const g = games.map((_, i) => [md.querySelector('[data-g="' + i + '"][data-s="0"]').value, md.querySelector('[data-g="' + i + '"][data-s="1"]').value]).filter((x) => x[0] !== '' || x[1] !== '').map((x) => [+x[0] || 0, +x[1] || 0]);
    if (JSON.stringify(g) !== origScore) body.games = g;
    act('/api/admin/matches/' + m.id, body, 'PATCH', 'Match saved');
  };
  const del = md.querySelector('#meDel');
  if (del) del.onclick = () => { closeModal(); confirmBox('Delete this match?', 'Delete match', () => act('/api/admin/matches/' + m.id, {}, 'DELETE', 'Match deleted')); };
}

// Settings
function adminSettings(p) {
  const c = D().settings;
  const f = (id, label, val, type = 'text', hint = '') => '<label class="f">' + label + (hint ? ' <small>' + hint + '</small>' : '') + '<input type="' + type + '" id="' + id + '" value="' + esc(val || '') + '"></label>';
  const ta = (id, label, val, hint = '') => '<label class="f">' + label + (hint ? ' <small>' + hint + '</small>' : '') + '<textarea id="' + id + '">' + esc(val || '') + '</textarea></label>';
  const cats = D().categories || {};
  const catLabel = (k) => (D().categoryLabels || {})[k] || k;
  p.innerHTML = '<form class="card form" id="cfgForm"><h3>Home page</h3><div class="row">' + f('cName', 'Tournament name', c.name) + f('cEyebrow', 'Small heading', c.eyebrow) + '</div>' + ta('cTag', 'Tagline', c.tagline) +
    '<div class="row">' + f('cStart', 'Start date and time', c.startDate, 'datetime-local', 'drives the countdown') + f('cDateText', 'Dates as shown', c.dateText, 'text', 'e.g. 14–16 Nov 2026') + '</div>' +
    '<div class="row">' + f('cVenue', 'Venue', c.venue) + f('cDeadline', 'Registration closes', c.regDeadline, 'date') + '</div>' + ta('cAbout', 'About the tournament', c.about) +
    ta('cRules', 'Format & rules', c.rules, 'one per line') + ta('cSchedule', 'Schedule', c.schedule, "one per line; use ' · ' between day and detail") + ta('cPrizes', 'Prizes', c.prizes, 'one per line') +
    '<div class="row">' + f('cContact', 'Contact name', c.contactName) + f('cPhone', 'Contact phone', c.contactPhone, 'tel') + '</div>' + f('cFootEmail', 'Footer contact email', c.footerEmail, 'email', 'shown after "All rights reserved"') +
    '<h3 style="margin-top:8px">Registration &amp; payment</h3><div class="row">' + f('cFee', 'Fee text', c.fee) + f('cUpi', 'UPI ID', c.upiId) + '</div>' + f('cPayNote', 'Payment instructions', c.payNote) +
    '<fieldset><legend>Events open for registration</legend><div class="seg">' + Object.entries(cats).flatMap(([cat, evs]) => evs.map((e) => { const on = ((c.events || {})[cat] || []).includes(e); return '<label><input type="checkbox" data-cat="' + cat + '" data-evt="' + e + '" ' + (on ? 'checked' : '') + '><span>' + esc(catLabel(cat)) + ' · ' + e + '</span></label>'; })).join('') + '</div></fieldset>' +
    '<label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cOpen" ' + (c.regOpen ? 'checked' : '') + '> Registrations open</label>' +
    '<div class="toolbar"><button class="btn primary">Save settings</button><span class="msg" id="cfgMsg"></span></div></form>' +
    '<div class="card form" style="margin-top:16px"><h3>Images</h3><div class="row"><div style="display:grid;gap:8px"><b>Home page GIF</b><label class="drop" for="upGif">' + (c.gifId ? '<img src="' + fileUrl(c.gifId) + '" alt="">' : '') + '<span>' + (c.gifId ? 'Replace GIF' : 'Upload your badminton GIF (up to 15 MB)') + '</span><input type="file" id="upGif" accept="image/gif,image/png,image/jpeg,image/webp"></label>' + (c.gifId ? '<button class="btn small" id="rmGif" style="justify-self:start">Remove GIF</button>' : '') + '</div>' +
    '<div style="display:grid;gap:8px"><b>Payment QR code</b><label class="drop" for="upQr">' + (c.qrId ? '<img src="' + fileUrl(c.qrId) + '" alt="">' : '') + '<span>' + (c.qrId ? 'Replace QR' : 'Upload UPI QR image') + '</span><input type="file" id="upQr" accept="image/*"></label></div></div><span class="msg" id="upMsg"></span></div>';
  const v = (s) => p.querySelector(s).value.trim();
  p.querySelector('#cfgForm').onsubmit = (e) => {
    e.preventDefault();
    const events = {}; Object.keys(cats).forEach((k) => { events[k] = []; });
    $$('[data-cat]', p).forEach((cb) => { if (cb.checked) events[cb.dataset.cat].push(cb.dataset.evt); });
    act('/api/admin/settings', { name: v('#cName'), eyebrow: v('#cEyebrow'), tagline: v('#cTag'), startDate: v('#cStart'), dateText: v('#cDateText'), venue: v('#cVenue'), regDeadline: v('#cDeadline'), about: p.querySelector('#cAbout').value, rules: p.querySelector('#cRules').value, schedule: p.querySelector('#cSchedule').value, prizes: p.querySelector('#cPrizes').value, contactName: v('#cContact'), contactPhone: v('#cPhone'), footerEmail: v('#cFootEmail'), fee: v('#cFee'), upiId: v('#cUpi'), payNote: v('#cPayNote'), events, regOpen: p.querySelector('#cOpen').checked }, 'PUT', 'Settings saved');
  };
  const up = (sel, key) => {
    p.querySelector(sel).onchange = async (e) => {
      const fl = e.target.files[0]; if (!fl) return;
      const m = p.querySelector('#upMsg'); m.className = 'msg'; m.textContent = 'Uploading…';
      try { const fd = new FormData(); fd.append('file', fl); const r = await api('/api/admin/files', { method: 'POST', form: fd }); await act('/api/admin/settings', { [key]: r.id }, 'PUT', 'Image updated'); }
      catch (er) { m.className = 'msg err'; m.textContent = 'Upload failed: ' + er.message; }
    };
  };
  up('#upGif', 'gifId'); up('#upQr', 'qrId');
  const rm = p.querySelector('#rmGif'); if (rm) rm.onclick = () => act('/api/admin/settings', { gifId: '' }, 'PUT', 'GIF removed');
}

// Testing & reset
function adminData(p) {
  const d = D();
  const evs = d.eventKeys;
  const counts = { regs: d.players.length, teams: d.teams.length, matches: d.matches.length };
  p.innerHTML = '<div style="display:grid;gap:16px;max-width:760px">' +
    '<form class="card form" id="tpForm"><h3>Add test players</h3><p>Creates confirmed entries named "Test …" in one event so you can try groups, league, knockouts and scoring without real sign-ups. Remove them later with <b>Start a new tournament</b> below, or one by one in Event setup.</p>' +
    '<div class="row"><label class="f">Event<select id="tpEv">' + evs.map((k) => '<option>' + esc(k) + '</option>').join('') + '</select></label><label class="f">How many ' + 'entries <small>2–32</small><input type="number" id="tpN" min="2" max="32" value="8"></label></div>' +
    '<div class="toolbar"><button class="btn primary">Add test players</button></div></form>' +
    '<div class="card"><h3>Audience</h3><div class="stats" style="margin-top:10px"><div><b class="tab-num">' + fmtNum((S.presence || {}).online) + '</b><span>On the site now</span></div><div><b class="tab-num">' + fmtNum((S.presence || {}).live) + '</b><span>Following live</span></div><div><b class="tab-num">' + fmtNum((S.presence || {}).views) + '</b><span>Page views</span></div><div><b class="tab-num">' + fmtNum((S.presence || {}).visitors) + '</b><span>Unique visitors</span></div></div><p style="font-size:13px;color:var(--muted);margin-top:8px">One view per page load. Visitors are counted by an anonymous browser id; no names or IP addresses are stored.</p></div>' +
    '<div class="card form danger-card"><h3>Start a new tournament</h3><p>Permanently deletes <b>all</b> current tournament data: ' + counts.regs + ' registrations (with photos and payment screenshots), ' + counts.teams + ' teams and ' + counts.matches + ' matches, including scores and points tables. Admin, scorer and umpire logins are kept.</p>' +
    '<p class="note warn">This cannot be undone. Download anything you need first, for example screenshots of the final standings.</p>' +
    '<div class="toolbar"><button class="btn danger" id="resetBtn">Delete everything and start new…</button></div></div></div>';
  p.querySelector('#tpForm').onsubmit = (e) => {
    e.preventDefault();
    const ek = p.querySelector('#tpEv').value, n = +p.querySelector('#tpN').value || 8;
    act('/api/admin/test-players', { eventKey: ek, count: n }, 'POST', 'Added ' + n + ' test ' + unit(ek, n) + ' to ' + ek + '. Draw groups in Event setup.');
  };
  p.querySelector('#resetBtn').onclick = () => modal(
    '<h3>Start a new tournament</h3><label class="f">New tournament name<input type="text" id="rsName" value="' + esc(d.settings.name || '') + '"></label>' +
    '<fieldset><legend>Home page and registration settings</legend><div class="seg"><label><input type="radio" name="rsKeep" value="keep" checked><span>Keep (venue, rules, fee, GIF, events, formats)</span></label><label><input type="radio" name="rsKeep" value="reset"><span>Reset to defaults</span></label></div></fieldset>' +
    '<label class="f" style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" id="rsViews" checked> Also reset page views and visitor count</label>' +
    '<label class="f">Type DELETE to confirm<input type="text" id="rsConfirm" autocomplete="off"></label>' +
    '<label class="f">Your password<input type="password" id="rsPass" autocomplete="current-password"></label>' +
    '<span class="msg err" id="rsErr"></span><div class="toolbar"><button class="btn danger" id="rsGo">Delete all data</button><button class="btn" data-close>Cancel</button></div>',
    (m) => {
      m.querySelector('#rsGo').onclick = async () => {
        const btn = m.querySelector('#rsGo'); btn.disabled = true;
        try {
          const r = await api('/api/admin/reset', { method: 'POST', body: { newName: m.querySelector('#rsName').value, keepSettings: m.querySelector('input[name=rsKeep]:checked').value === 'keep', resetViews: m.querySelector('#rsViews').checked, confirm: m.querySelector('#rsConfirm').value.trim(), password: m.querySelector('#rsPass').value } });
          closeModal(); S.regs = []; S.selected.clear(); S.scoreId = null; S.fxEvent = null; S.adminEv = null;
          toast('New tournament started. Removed ' + r.removed.regs + ' registrations, ' + r.removed.teams + ' teams and ' + r.removed.matches + ' matches.');
          await refresh();
        } catch (er) { m.querySelector('#rsErr').textContent = er.message; btn.disabled = false; }
      };
    });
}

// Users
const ROLE_HELP = { admin: 'Full access', scorer: 'Scores any match', umpire: 'Scores assigned or unassigned matches' };
function adminUsers(p) {
  const v = (sel) => p.querySelector(sel).value.trim();
  p.innerHTML = '<div class="grid-2"><div class="card"><h3 style="margin-bottom:8px">Accounts</h3>' + S.users.map((u) => '<div class="reg" style="grid-template-columns:1fr auto"><div><b>' + esc(u.display_name || u.username) + '</b><div class="sub">' + esc(u.username) + ' · ' + ROLE_HELP[u.role] + '</div></div><div class="act">' +
    (u.id === S.user.id ? '<span class="chip">You · Admin</span>' : '<select data-role="' + u.id + '" aria-label="Role for ' + esc(u.username) + '">' + ['umpire', 'scorer', 'admin'].map((r) => '<option value="' + r + '" ' + (u.role === r ? 'selected' : '') + '>' + ROLE_LABEL[r] + '</option>').join('') + '</select><button class="btn small" data-pw="' + u.id + '">Reset password</button><button class="btn small danger" data-rmu="' + u.id + '">Remove</button>') + '</div></div>').join('') + '</div>' +
    '<form class="card form" id="uForm"><h3>Add login</h3><label class="f">Name shown on matches <small>e.g. Ravi K</small><input type="text" id="uDisp" autocomplete="off"></label><label class="f">Username<input type="text" id="uName" autocomplete="off" required></label><label class="f">Temporary password <small>at least 10 characters; share it privately</small><input type="password" id="uPass" autocomplete="new-password" required></label>' +
    '<label class="f">Role<select id="uRole"><option value="umpire">Umpire: scores matches assigned to them</option><option value="scorer">Scorer: scores any match</option><option value="admin">Admin: everything</option></select></label><button class="btn primary">Add login</button></form></div>' + passwordCard();
  const reload = async () => { S.users = await api('/api/admin/users'); await refresh(); };
  p.querySelector('#uForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/users', { method: 'POST', body: { displayName: v('#uDisp'), username: v('#uName'), password: p.querySelector('#uPass').value, role: v('#uRole') } }); toast('Login added'); await reload(); }
    catch (er) { toast(er.message); }
  };
  $$('[data-role]', p).forEach((sel) => { sel.onchange = async () => { try { await api('/api/admin/users/' + sel.dataset.role, { method: 'PATCH', body: { role: sel.value } }); toast('Role updated'); await reload(); } catch (er) { toast(er.message); } }; });
  $$('[data-pw]', p).forEach((b) => { b.onclick = () => modal('<h3>Reset password</h3><label class="f">New password <small>at least 10 characters; this signs them out</small><input type="password" id="rpNew" autocomplete="new-password"></label><div class="toolbar"><button class="btn primary" id="rpSave">Reset</button><button class="btn" data-close>Cancel</button></div>',
    (m) => { m.querySelector('#rpSave').onclick = async () => { try { await api('/api/admin/users/' + b.dataset.pw, { method: 'PATCH', body: { password: m.querySelector('#rpNew').value } }); closeModal(); toast('Password reset'); } catch (er) { toast(er.message); } }; }); });
  $$('[data-rmu]', p).forEach((b) => { b.onclick = () => confirmBox('Remove this login? They will be signed out.', 'Remove login', async () => { await api('/api/admin/users/' + b.dataset.rmu, { method: 'DELETE', body: {} }).catch((er) => toast(er.message)); await reload(); }); });
  bindPassword();
}

// ---------- SCORE (scorers, umpires, admins) ----------
let scoreBusy = false;
async function scoreCall(id, action, body = {}) {
  if (scoreBusy) return null;
  scoreBusy = true;
  try {
    const before = D().matches.find((x) => x.id === id);
    const m = await api('/api/score/' + id + '/' + action, { method: 'POST', body });
    const i = S.data.matches.findIndex((x) => x.id === id); if (i >= 0) S.data.matches[i] = { ...S.data.matches[i], ...m };
    if (m.status === 'done' && (!before || before.status !== 'done')) {
      S.lastDone = id;
      toast(teamName(m.winner) + ' win. ' + (m.stage === 'league' ? 'Points table updated.' : 'Winner moves to the next round.'));
      if (navigator.vibrate) try { navigator.vibrate(120); } catch (e) { /* ignore */ }
    }
    renderAll();
    refresh(); // pull fresh standings
    return m;
  } catch (er) { toast(er.message); return null; } finally { scoreBusy = false; }
}
function renderScore() {
  const root = $('#scoreBody');
  if (!S.user) { root.innerHTML = '<div class="card" style="max-width:520px;display:grid;gap:10px"><h3>Sign in to score</h3><p>Scorers and umpires sign in with the login the tournament admin gave them.</p><a class="btn primary" href="#admin" style="justify-self:start">Sign in</a></div>'; return; }
  const m = S.scoreId && D().matches.find((x) => x.id === S.scoreId);
  if (m) return renderConsole(root, m);
  S.scoreId = null;
  const tm = teamMap();
  const ready = (x) => x.team_a && x.team_b && (x.status === 'live' || x.status === 'scheduled');
  let list = D().matches.filter((x) => ready(x) && canScore(x));
  const mine = list.filter((x) => x.umpire_id === S.user.id);
  const courts = [...new Set(list.map((x) => x.court).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (S.scoreFilter === 'mine' && S.user.role !== 'umpire') S.scoreFilter = 'live';
  if (S.scoreFilter === 'mine') list = mine;
  if (S.scoreFilter === 'live') list = list.filter((x) => x.status === 'live');
  if (S.scoreFilter === 'next') list = list.filter((x) => x.status === 'scheduled');
  if (S.scoreCourt) list = list.filter((x) => x.court === S.scoreCourt);
  list.sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) || (a.start_time || '~').localeCompare(b.start_time || '~') || a.seq - b.seq);
  const filters = (S.user.role === 'umpire' ? [['mine', 'Assigned to me · ' + mine.length]] : []).concat([['live', 'In play'], ['next', 'Ready to start'], ['all', 'All']]);
  root.innerHTML = '<div class="toolbar" style="margin-bottom:14px"><div class="pillbar" id="scF">' + filters.map(([k, l]) => '<button aria-pressed="' + (S.scoreFilter === k) + '" data-f="' + k + '">' + l + '</button>').join('') + '</div>' +
    (courts.length ? '<select id="scCourt" aria-label="Court"><option value="">All courts</option>' + courts.map((c) => '<option ' + (c === S.scoreCourt ? 'selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' : '') + '</div>' +
    '<div class="matches">' + (list.length ? list.map((x) => '<button class="pick" data-pick="' + x.id + '"><span class="pk-teams"><b>' + esc(teamName(x.team_a, tm)) + '</b><span>vs</span><b>' + esc(teamName(x.team_b, tm)) + '</b></span><span class="pk-meta">' +
      (x.status === 'live' ? '<span class="chip live">LIVE ' + esc((x.games || []).map((g) => g[0] + '–' + g[1]).join(', ')) + '</span>' : '<span class="chip warn">Ready</span>') + '<span>' + esc(x.event_key) + ' · ' + esc(x.round_name) + '</span>' + (x.court ? '<span>Court ' + esc(x.court) + '</span>' : '') + (x.start_time ? '<span>' + esc(fmtDate(x.start_time)) + '</span>' : '') +
      (x.umpire_id ? '<span>Umpire ' + esc(officialName(x.umpire_id)) + '</span>' : '<span>No umpire yet</span>') + '</span></button>').join('')
      : '<div class="empty">' + (S.scoreFilter === 'mine' ? 'No matches are assigned to you yet. Check Ready to start for unassigned matches.' : 'No matches here. Matches appear once both sides are known.') + '</div>') + '</div>';
  root.querySelector('#scF').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.scoreFilter = b.dataset.f; renderScore(); } };
  const cs = root.querySelector('#scCourt'); if (cs) cs.onchange = () => { S.scoreCourt = cs.value; renderScore(); };
  $$('[data-pick]', root).forEach((b) => { b.onclick = () => { S.scoreId = +b.dataset.pick; renderScore(); window.scrollTo(0, 0); }; });
}
function renderConsole(root, m) {
  const tm = teamMap();
  const back = '<button class="btn small" id="scBack">All matches</button>';
  const head = '<div class="toolbar" style="justify-content:space-between;margin-bottom:12px">' + back + '<span class="chip">' + esc(m.event_key) + ' · ' + esc(m.round_name) + (m.court ? ' · Court ' + esc(m.court) : '') + '</span></div>';
  const fmt = (m.best_of === 1 ? '1 game' : 'Best of ' + m.best_of) + ' to ' + m.points + ', 2-point lead, cap ' + m.cap;
  const allowed = canScore(m);
  if (!allowed) { root.innerHTML = head + '<div class="note warn">This match is assigned to ' + esc(officialName(m.umpire_id)) + '. Only that umpire, scorers and admins can score it.</div>'; bindBack(root); return; }
  // Pre-match: pick first server
  if (m.status === 'scheduled') {
    root.innerHTML = head + '<div class="card" style="display:grid;gap:14px;max-width:640px"><h3>Before you start</h3><p>' + esc(fmt) + '.' + (S.user.role === 'umpire' && !m.umpire_id ? ' Starting assigns this match to you.' : '') + '</p><b>Who serves first?</b><div class="serve-pick">' +
      '<button class="btn" data-first="a">' + esc(teamName(m.team_a, tm)) + '</button><button class="btn" data-first="b">' + esc(teamName(m.team_b, tm)) + '</button></div>' +
      '<details><summary>Walkover</summary><p style="margin:8px 0">Use this if a side does not turn up. The other side gets the win and 2 points.</p><div class="toolbar"><button class="btn small danger" data-wo="a">' + esc(teamName(m.team_a, tm)) + ' win by walkover</button><button class="btn small danger" data-wo="b">' + esc(teamName(m.team_b, tm)) + ' win by walkover</button></div></details></div>';
    bindBack(root);
    $$('[data-first]', root).forEach((b) => { b.onclick = () => scoreCall(m.id, 'start', { server: b.dataset.first }); });
    $$('[data-wo]', root).forEach((b) => { b.onclick = () => confirmBox(teamName(b.dataset.wo === 'a' ? m.team_a : m.team_b, tm) + ' win by walkover?', 'Record walkover', () => scoreCall(m.id, 'end', { winner: b.dataset.wo, reason: 'walkover' })); });
    return;
  }
  const g = m.games && m.games.length ? m.games : [[0, 0]];
  const cur = g[g.length - 1];
  const [wa, wb] = tally(m);
  if (m.status === 'done' || m.status === 'bye') {
    const st = m.stage === 'league' && (D().standings[m.event_key] || {})[m.grp];
    const fq = fmtOf(m.event_key).knockout.qualifiers;
    root.innerHTML = head + '<div class="card result-card"><span class="eyebrow">Match finished' + (m.result_note ? ' · ' + esc(m.result_note) : '') + '</span><h2>' + esc(teamName(m.winner, tm)) + ' win</h2><p class="tab-num" style="font-family:var(--mono);font-size:18px">' + wa + ' – ' + wb + (g.filter((x) => x[0] || x[1]).length ? ' · ' + esc(g.filter((x) => x[0] || x[1]).map((x) => x[0] + '–' + x[1]).join(', ')) : '') + '</p>' +
      (st ? '<h3 style="margin-top:8px">Group ' + esc(m.grp) + ' points table</h3><div class="table-wrap"><table class="std"><thead><tr><th>' + (isPair(m.event_key) ? 'Team' : 'Player') + '</th><th>P</th><th>W</th><th>L</th><th>+/−</th><th>Pts</th></tr></thead><tbody>' +
        st.map((r, i) => '<tr class="' + (i < fq ? 'q' : '') + '"' + (r.team === m.winner ? ' style="font-weight:700"' : '') + '><td>' + esc(teamName(r.team, tm)) + '</td><td>' + r.p + '</td><td>' + r.w + '</td><td>' + r.l + '</td><td>' + (r.pf - r.pa > 0 ? '+' : '') + (r.pf - r.pa) + '</td><td><b>' + r.pts + '</b></td></tr>').join('') + '</tbody></table></div>'
        : m.stage === 'knockout' ? '<p>' + (m.next_match_id ? 'The winner moves into the next round of the bracket.' : 'This was the final.') + '</p>' : '') +
      '<div class="toolbar"><button class="btn primary" id="scNext">Score another match</button><button class="btn small" data-sc="undo">Undo last point</button></div><p style="font-size:13px;color:var(--muted)">Pressed the wrong side on match point? Undo reopens the match and reverses the result.</p></div>';
    bindBack(root);
    root.querySelector('#scNext').onclick = () => { S.scoreId = null; renderScore(); };
    root.querySelector('[data-sc=undo]').onclick = () => scoreCall(m.id, 'undo');
    return;
  }
  const sideHtml = (t, i, won) => '<button class="tap side-' + (i ? 'b' : 'a') + (m.server === i ? ' serving' : '') + '" data-tap="' + (i ? 'b' : 'a') + '" aria-label="Point to ' + esc(teamName(t, tm)) + '">' +
    '<span class="tap-name">' + (m.server === i ? '<i class="serve" title="Serving"></i>' : '') + esc(teamName(t, tm)) + '</span><span class="tap-score tab-num">' + cur[i] + '</span><span class="tap-games">Games won ' + won + (m.server === i ? ' · Serving' : '') + '</span></button>';
  const over = Math.max(...cur) >= m.points;
  root.innerHTML = head + '<div class="console">' + sideHtml(m.team_a, 0, wa) + sideHtml(m.team_b, 1, wb) + '</div>' +
    '<p class="console-info">Game ' + g.length + ' · ' + esc(fmt) + (g.length > 1 ? ' · Earlier games ' + esc(g.slice(0, -1).map((x) => x[0] + '–' + x[1]).join(', ')) : '') + (over ? ' · <b>Deuce: 2-point lead needed</b>' : '') + '</p>' +
    '<div class="toolbar console-tools"><button class="btn" data-sc="undo">Undo last point</button><button class="btn" data-sc="swap">Change server</button><button class="btn danger" data-sc="end">End match early</button></div>';
  bindBack(root);
  $$('[data-tap]', root).forEach((b) => { b.onclick = () => scoreCall(m.id, 'point', { side: b.dataset.tap }); });
  root.querySelector('[data-sc=undo]').onclick = () => scoreCall(m.id, 'undo');
  root.querySelector('[data-sc=swap]').onclick = () => scoreCall(m.id, 'server', { side: m.server === 0 ? 'b' : 'a' });
  root.querySelector('[data-sc=end]').onclick = () => modal('<h3>End match early</h3><p>Use when a side retires (injury) or does not continue. The other side gets the win and 2 points. Games played so far are kept.</p><div class="toolbar"><button class="btn danger" data-endw="a">' + esc(teamName(m.team_a, tm)) + ' win</button><button class="btn danger" data-endw="b">' + esc(teamName(m.team_b, tm)) + ' win</button></div><button class="btn" data-close>Cancel</button>',
    (md) => { $$('[data-endw]', md).forEach((b) => { b.onclick = () => { closeModal(); scoreCall(m.id, 'end', { winner: b.dataset.endw, reason: 'retired' }); }; }); });
}
function bindBack(root) { const b = root.querySelector('#scBack'); if (b) b.onclick = () => { S.scoreId = null; renderScore(); }; }
// Keyboard shortcuts on a laptop at the court: A / B add a point, U undoes.
document.addEventListener('keydown', (e) => {
  if (S.view !== 'score' || !S.scoreId || e.target.closest('input,select,textarea') || $('#modalRoot').firstChild) return;
  const m = D().matches.find((x) => x.id === S.scoreId);
  if (!m || m.status !== 'live') return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'b') scoreCall(m.id, 'point', { side: k });
  if (k === 'u') scoreCall(m.id, 'undo');
});

// ---------- boot ----------
async function loadSession() {
  const [me, setup] = await Promise.all([api('/api/auth/me').catch(() => ({ user: null })), api('/api/setup/status').catch(() => null)]);
  S.user = me.user; S.setup = setup;
}
route();
(async () => {
  await loadSession();
  await refresh();
  if (S.setup && S.setup.needsSetup && !S.user) location.hash = '#admin';
  connectStream();
  api('/api/hit', { method: 'POST', body: { vid: VID } }).then((p) => { S.presence = { ...(S.presence || {}), views: p.views, visitors: p.visitors }; renderPresence(); }).catch(() => {});
})();
})();
