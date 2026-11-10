'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { q, tx, migrate } = require('./lib/db');
const T = require('./lib/tournament');

const PORT = process.env.PORT || 3000;
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';
const SESSION_DAYS = 14;

const DEFAULT_SETTINGS = {
  name: process.env.TOURNAMENT_NAME || 'Badminton Tournament',
  eyebrow: 'Annual company tournament',
  tagline: 'Three days of rallies, smashes and drop shots. Open to every team member and their families.',
  startDate: '', dateText: 'Dates to be announced', venue: 'Venue to be announced', regDeadline: '',
  fee: 'Entry fee per event: to be announced',
  about: 'Describe who can play, the spirit of the event and anything players should bring. Edit this from Admin → Settings.',
  rules: 'League: round robin inside each group\nKnockouts: top finishers from each group\nRally scoring, 2-point lead, capped\nNon-marking sports shoes required',
  schedule: 'Day 1 · League matches\nDay 2 · Knockouts\nDay 3 · Finals and prize ceremony',
  prizes: 'Winners · Trophy and medals\nRunners-up · Medals',
  contactName: 'Tournament committee', contactPhone: '', upiId: '',
  payNote: 'Pay the entry fee by UPI, then upload the screenshot below.',
  qrId: '', gifId: '', regOpen: true,
  events: T.CATEGORIES,
  formats: {},
};

// ---------- helpers ----------
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const digits = (v) => String(v ?? '').replace(/[^\d+]/g, '').slice(0, 16);

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    if (++h.n > max) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    next();
  };
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function saveFile(file, isPrivate, db = { query: q }) {
  const mime = sniffImage(file && file.buffer);
  if (!mime) throw bad('Images must be JPG, PNG, GIF or WebP.');
  const id = crypto.randomUUID();
  await db.query('INSERT INTO files (id, mime, data, private) VALUES ($1,$2,$3,$4)', [id, mime, file.buffer, isPrivate]);
  return id;
}

async function getSettings() {
  const r = await q("SELECT value FROM settings WHERE key='tournament'");
  return { ...DEFAULT_SETTINGS, ...(r.rows[0] ? r.rows[0].value : {}) };
}
async function saveSettings(s) {
  await q("INSERT INTO settings (key, value) VALUES ('tournament', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s]);
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    for (const res of clients) res.write(`event: state\ndata: ${Date.now()}\n\n`);
  }, 120);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '200kb' }));

// CSRF guard: every state-changing API call must come from our own fetch() with this header.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Request blocked.' });
  next();
});

// Session
function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
app.use(ah(async (req, res, next) => {
  const sid = parseCookies(req.headers.cookie).sid;
  req.user = null;
  if (sid) {
    const r = await q('SELECT u.id, u.username, u.role, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=$1 AND s.expires_at > now()', [sha256(sid)]);
    req.user = r.rows[0] || null;
  }
  next();
}));
const needRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can do this.' });
  next();
};
function setSession(req, res, token) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
}
async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), userId]);
  setSession(req, res, token);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 2, fields: 30 } });
const uploadOne = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- setup & auth ----------
app.get('/api/setup/status', ah(async (req, res) => {
  const r = await q('SELECT count(*)::int AS n FROM users');
  res.json({ needsSetup: r.rows[0].n === 0, tokenRequired: !!SETUP_TOKEN });
}));

app.post('/api/setup', limiter(10, 15 * 60e3), ah(async (req, res) => {
  const { username, password, setupToken, tournamentName } = req.body || {};
  if (SETUP_TOKEN && setupToken !== SETUP_TOKEN) throw new HttpError(403, 'The setup token is not correct.');
  const u = str(username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw bad('Username: 3–40 letters, numbers, dots, dashes or underscores.');
  if (String(password || '').length < 10) throw bad('Use a password of at least 10 characters.');
  const hash = await bcrypt.hash(String(password), 12);
  const created = await tx(async (c) => {
    await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const n = (await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    if (n > 0) return null;
    return (await c.query("INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin') RETURNING id", [u, hash])).rows[0];
  });
  if (!created) throw new HttpError(409, 'Setup is already complete. Sign in instead.');
  const s = await getSettings();
  if (tournamentName) s.name = str(tournamentName, 80);
  await saveSettings(s);
  await createSession(req, res, created.id);
  broadcast();
  res.json({ ok: true });
}));

app.post('/api/auth/login', limiter(10, 15 * 60e3), ah(async (req, res) => {
  const u = str(req.body && req.body.username, 40).toLowerCase();
  const r = await q('SELECT id, password_hash FROM users WHERE username=$1', [u]);
  const ok = r.rows[0] && (await bcrypt.compare(String((req.body && req.body.password) || ''), r.rows[0].password_hash));
  if (!ok) throw new HttpError(401, 'Username or password is not correct.');
  await createSession(req, res, r.rows[0].id);
  res.json({ ok: true });
}));
app.post('/api/auth/logout', ah(async (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) await q('DELETE FROM sessions WHERE token_hash=$1', [sha256(sid)]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));
app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
app.post('/api/auth/password', needRole('official'), ah(async (req, res) => {
  const { current, next } = req.body || {};
  const r = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(current || ''), r.rows[0].password_hash))) throw bad('Current password is not correct.');
  if (String(next || '').length < 10) throw bad('Use a new password of at least 10 characters.');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(next), 12), req.user.id]);
  res.json({ ok: true });
}));

// ---------- public data ----------
async function loadAll() {
  const [settings, teams, matches, regs] = await Promise.all([
    getSettings(),
    q('SELECT id, event_key, names, reg_ids, grp FROM teams ORDER BY id'),
    q('SELECT id, event_key, stage, grp, round, round_name, slot, team_a, team_b, court, start_time, status, games, winner, server, points, best_of, cap, next_match_id, next_slot, seq, finished_at, updated_at, umpire_id, result_note FROM matches ORDER BY seq, id'),
    q("SELECT id, first_name, last_name, category, event, event_key, has_partner, partner_name, about, photo_id, status, team_id, created_at FROM registrations WHERE status <> 'rejected' ORDER BY id"),
  ]);
  return { settings, teams: teams.rows, matches: matches.rows, regs: regs.rows };
}

function computeStandings(teams, matches) {
  const out = {};
  for (const ek of T.EVENT_KEYS) {
    const evTeams = teams.filter((t) => t.event_key === ek && t.grp);
    const groups = [...new Set(evTeams.map((t) => t.grp))].sort();
    if (!groups.length) continue;
    out[ek] = {};
    for (const g of groups) {
      const ids = evTeams.filter((t) => t.grp === g).map((t) => t.id);
      const ms = matches.filter((m) => m.event_key === ek && m.stage === 'league' && m.grp === g);
      out[ek][g] = T.standings(ids, ms);
    }
  }
  return out;
}

app.get('/api/state', ah(async (req, res) => {
  const { settings, teams, matches, regs } = await loadAll();
  const formats = {};
  for (const ek of T.EVENT_KEYS) formats[ek] = T.formatFor(settings, ek);
  const { formats: _f, ...pub } = settings;
  res.set('Cache-Control', 'no-store');
  const officials = {};
  (await q("SELECT id, username, display_name FROM users WHERE role IN ('umpire','scorer')")).rows.forEach((u) => { officials[u.id] = u.display_name || u.username; });
  res.json({ settings: pub, formats, teams, matches, players: regs, standings: computeStandings(teams, matches), eventKeys: T.EVENT_KEYS, officials });
}));

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/files/:id', ah(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).end();
  const r = await q('SELECT mime, data, private FROM files WHERE id=$1', [req.params.id]);
  const f = r.rows[0];
  if (!f) return res.status(404).end();
  if (f.private && (!req.user || req.user.role !== 'admin')) return res.status(403).end();
  res.set({ 'Content-Type': f.mime, 'Cache-Control': f.private ? 'private, no-store' : 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline' });
  res.send(f.data);
}));

// ---------- registration ----------
app.post('/api/register', limiter(20, 60 * 60e3), upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'payment', maxCount: 1 }]), ah(async (req, res) => {
  const s = await getSettings();
  if (!s.regOpen) throw bad('Registrations are closed.');
  if (s.regDeadline && new Date(`${s.regDeadline}T23:59:59`) < new Date()) throw bad('The registration deadline has passed.');
  const b = req.body || {};
  const category = str(b.category, 20), event = str(b.event, 20);
  if (!(s.events[category] || []).includes(event)) throw bad('Pick a category and an event that are open for registration.');
  const first = str(b.firstName, 60), last = str(b.lastName, 60);
  if (!first || !last) throw bad('Enter your first and last name.');
  const mobile = digits(b.mobile);
  if (mobile.replace(/\D/g, '').length < 10) throw bad('Enter a mobile number with at least 10 digits.');
  const doubles = event !== 'Singles';
  const hasPartner = doubles && b.hasPartner === 'yes';
  if (doubles && !['yes', 'no'].includes(b.hasPartner)) throw bad('Tell us whether you have a partner.');
  const partnerName = hasPartner ? str(b.partnerName, 120) : '';
  const partnerMobile = hasPartner ? digits(b.partnerMobile) : '';
  if (hasPartner && (!partnerName || partnerMobile.replace(/\D/g, '').length < 10)) throw bad("Enter your partner's name and a 10-digit mobile number.");
  const photo = req.files && req.files.photo && req.files.photo[0];
  const pay = req.files && req.files.payment && req.files.payment[0];
  if (!photo) throw bad('Add your photo.');
  if (!pay) throw bad('Add the payment screenshot.');
  const row = await tx(async (c) => {
    const photoId = await saveFile(photo, false, c);
    const payId = await saveFile(pay, true, c);
    return (await c.query(
      `INSERT INTO registrations (first_name,last_name,mobile,category,event,event_key,has_partner,partner_name,partner_mobile,about,photo_id,payment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [first, last, mobile, category, event, T.eventKey(category, event), hasPartner, partnerName, partnerMobile, str(b.about, 500), photoId, payId],
    )).rows[0];
  });
  broadcast();
  res.json({ ok: true, id: row.id, eventKey: T.eventKey(category, event) });
}));

// ---------- admin: settings, files, users ----------
const admin = express.Router();
admin.use(needRole('admin'));

const TEXT_FIELDS = ['name', 'eyebrow', 'tagline', 'startDate', 'dateText', 'venue', 'regDeadline', 'fee', 'about', 'rules', 'schedule', 'prizes', 'contactName', 'contactPhone', 'upiId', 'payNote', 'qrId', 'gifId'];
admin.put('/settings', ah(async (req, res) => {
  const s = await getSettings();
  const b = req.body || {};
  for (const k of TEXT_FIELDS) if (k in b) s[k] = str(b[k], 4000);
  if ('regOpen' in b) s.regOpen = !!b.regOpen;
  if (b.events && typeof b.events === 'object') {
    const ev = {};
    for (const [cat, list] of Object.entries(T.CATEGORIES)) ev[cat] = list.filter((e) => (b.events[cat] || []).includes(e));
    s.events = ev;
  }
  await saveSettings(s);
  broadcast();
  res.json({ ok: true });
}));

admin.put('/formats/:ek', ah(async (req, res) => {
  const ek = req.params.ek;
  if (!T.EVENT_KEYS.includes(ek)) throw bad('Unknown event.');
  const s = await getSettings();
  const targets = req.body.applyToAll ? T.EVENT_KEYS : [ek];
  const f = T.normalizeFormat(req.body.format);
  s.formats = { ...(s.formats || {}) };
  for (const k of targets) s.formats[k] = f;
  await saveSettings(s);
  // Matches that have not started pick up the new scoring format.
  for (const k of targets) {
    await q("UPDATE matches SET points=$1, best_of=$2, cap=$3 WHERE event_key=$4 AND stage='league' AND status='scheduled'", [f.league.points, f.league.bestOf, f.league.cap, k]);
    await q("UPDATE matches SET points=$1, best_of=$2, cap=$3 WHERE event_key=$4 AND stage='knockout' AND status='scheduled'", [f.knockout.points, f.knockout.bestOf, f.knockout.cap, k]);
  }
  broadcast();
  res.json({ ok: true, format: f });
}));

admin.post('/files', uploadOne.single('file'), ah(async (req, res) => {
  if (!req.file) throw bad('Choose a file.');
  res.json({ id: await saveFile(req.file, false) });
}));

admin.get('/users', ah(async (req, res) => {
  res.json((await q('SELECT id, username, display_name, role, created_at FROM users ORDER BY id')).rows);
}));
const ROLES = ['admin', 'scorer', 'umpire'];
admin.post('/users', ah(async (req, res) => {
  const u = str(req.body.username, 40).toLowerCase();
  const role = ROLES.includes(req.body.role) ? req.body.role : 'umpire';
  const displayName = str(req.body.displayName, 60);
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw bad('Username: 3–40 letters, numbers, dots, dashes or underscores.');
  if (String(req.body.password || '').length < 10) throw bad('Use a password of at least 10 characters.');
  try {
    await q('INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4)', [u, await bcrypt.hash(String(req.body.password), 12), role, displayName]);
  } catch (e) {
    if (e.code === '23505') throw bad('That username is taken.');
    throw e;
  }
  res.json({ ok: true });
}));
admin.patch('/users/:id', ah(async (req, res) => {
  const id = +req.params.id, b = req.body || {};
  if ('role' in b) {
    if (!ROLES.includes(b.role)) throw bad('Unknown role.');
    if (id === req.user.id && b.role !== 'admin') throw bad('You cannot remove your own admin access.');
    await q('UPDATE users SET role=$1 WHERE id=$2', [b.role, id]);
  }
  if ('displayName' in b) await q('UPDATE users SET display_name=$1 WHERE id=$2', [str(b.displayName, 60), id]);
  if (b.password) {
    if (String(b.password).length < 10) throw bad('Use a password of at least 10 characters.');
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(b.password), 12), id]);
    await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  }
  broadcast();
  res.json({ ok: true });
}));
admin.delete('/users/:id', ah(async (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) throw bad('You cannot remove your own account.');
  await q('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// ---------- admin: registrations & teams ----------
admin.get('/registrations', ah(async (req, res) => {
  res.json((await q('SELECT * FROM registrations ORDER BY id DESC')).rows);
}));

admin.post('/registrations/:id/approve', ah(async (req, res) => {
  await tx(async (c) => {
    const r = (await c.query('SELECT * FROM registrations WHERE id=$1 FOR UPDATE', [+req.params.id])).rows[0];
    if (!r) throw new HttpError(404, 'Registration not found.');
    let teamId = r.team_id;
    if (!teamId && (r.event === 'Singles' || r.has_partner)) {
      const names = r.event === 'Singles' ? [`${r.first_name} ${r.last_name}`] : [`${r.first_name} ${r.last_name}`, r.partner_name];
      teamId = (await c.query('INSERT INTO teams (event_key, names, reg_ids) VALUES ($1,$2,$3) RETURNING id', [r.event_key, JSON.stringify(names), JSON.stringify([r.id])])).rows[0].id;
    }
    await c.query("UPDATE registrations SET status='approved', team_id=$1 WHERE id=$2", [teamId, r.id]);
  });
  broadcast();
  res.json({ ok: true });
}));

admin.post('/registrations/:id/reject', ah(async (req, res) => {
  await tx(async (c) => {
    const r = (await c.query('SELECT * FROM registrations WHERE id=$1 FOR UPDATE', [+req.params.id])).rows[0];
    if (!r) throw new HttpError(404, 'Registration not found.');
    if (r.team_id) await removeTeam(c, r.team_id);
    await c.query("UPDATE registrations SET status='rejected', team_id=NULL WHERE id=$1", [r.id]);
  });
  broadcast();
  res.json({ ok: true });
}));

admin.post('/teams/pair', ah(async (req, res) => {
  const ids = (req.body.regIds || []).map(Number);
  if (ids.length !== 2) throw bad('Pick exactly two players.');
  await tx(async (c) => {
    const rs = (await c.query('SELECT * FROM registrations WHERE id = ANY($1) FOR UPDATE', [ids])).rows;
    if (rs.length !== 2) throw bad('Registration not found.');
    if (rs[0].event_key !== rs[1].event_key) throw bad('Both players must be in the same event.');
    if (rs.some((r) => r.team_id)) throw bad('One of these players already has a team.');
    const names = rs.map((r) => `${r.first_name} ${r.last_name}`);
    const t = (await c.query('INSERT INTO teams (event_key, names, reg_ids) VALUES ($1,$2,$3) RETURNING id', [rs[0].event_key, JSON.stringify(names), JSON.stringify(ids)])).rows[0];
    await c.query("UPDATE registrations SET status='approved', team_id=$1 WHERE id = ANY($2)", [t.id, ids]);
  });
  broadcast();
  res.json({ ok: true });
}));

admin.post('/teams', ah(async (req, res) => {
  const ek = req.body.eventKey;
  if (!T.EVENT_KEYS.includes(ek)) throw bad('Unknown event.');
  const names = (req.body.names || []).map((n) => str(n, 80)).filter(Boolean).slice(0, 2);
  if (!names.length) throw bad('Enter at least one player name.');
  await q('INSERT INTO teams (event_key, names, grp) VALUES ($1,$2,$3)', [ek, JSON.stringify(names), str(req.body.group, 4).toUpperCase()]);
  broadcast();
  res.json({ ok: true });
}));

admin.patch('/teams/:id', ah(async (req, res) => {
  const b = req.body || {};
  if ('group' in b) await q('UPDATE teams SET grp=$1 WHERE id=$2', [str(b.group, 4).toUpperCase(), +req.params.id]);
  if (Array.isArray(b.names)) await q('UPDATE teams SET names=$1 WHERE id=$2', [JSON.stringify(b.names.map((n) => str(n, 80)).filter(Boolean).slice(0, 2)), +req.params.id]);
  broadcast();
  res.json({ ok: true });
}));

async function removeTeam(c, id) {
  await c.query("DELETE FROM matches WHERE stage='league' AND (team_a=$1 OR team_b=$1) AND status='scheduled'", [id]);
  await c.query("UPDATE registrations SET team_id=NULL, status=CASE WHEN status='approved' THEN 'pending' ELSE status END WHERE team_id=$1", [id]);
  await c.query('DELETE FROM teams WHERE id=$1', [id]);
}
admin.delete('/teams/:id', ah(async (req, res) => {
  await tx((c) => removeTeam(c, +req.params.id));
  broadcast();
  res.json({ ok: true });
}));

// ---------- admin: groups, league, knockout ----------
function evParam(req) {
  const ek = req.params.ek;
  if (!T.EVENT_KEYS.includes(ek)) throw bad('Unknown event.');
  return ek;
}
const LETTERS = 'ABCDEFGHIJKLMNOP';

admin.post('/events/:ek/draw', ah(async (req, res) => {
  const ek = evParam(req);
  const s = await getSettings();
  const n = Math.max(1, Math.min(16, parseInt(req.body.groups, 10) || T.formatFor(s, ek).groups));
  const teams = (await q('SELECT id FROM teams WHERE event_key=$1', [ek])).rows.map((r) => r.id);
  if (teams.length < 2) throw bad('Confirm at least two teams or players before drawing groups.');
  if (n > teams.length) throw bad(`You have ${teams.length} entries, so use ${teams.length} groups or fewer.`);
  const started = (await q("SELECT count(*)::int AS n FROM matches WHERE event_key=$1 AND stage='league' AND status<>'scheduled'", [ek])).rows[0].n;
  if (started && !req.body.force) throw new HttpError(409, 'League matches have already started. Redrawing will discard those results.');
  // Fisher–Yates shuffle, then deal round the groups
  for (let i = teams.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [teams[i], teams[j]] = [teams[j], teams[i]]; }
  await tx(async (c) => {
    for (let i = 0; i < teams.length; i++) await c.query('UPDATE teams SET grp=$1 WHERE id=$2', [LETTERS[i % n], teams[i]]);
    await c.query("DELETE FROM matches WHERE event_key=$1 AND stage='league'", [ek]);
  });
  s.formats = { ...(s.formats || {}), [ek]: { ...T.formatFor(s, ek), groups: n } };
  await saveSettings(s);
  broadcast();
  res.json({ ok: true });
}));

admin.post('/events/:ek/league', ah(async (req, res) => {
  const ek = evParam(req);
  const s = await getSettings();
  const f = T.formatFor(s, ek).league;
  const teams = (await q("SELECT id, grp FROM teams WHERE event_key=$1 AND grp<>'' ORDER BY id", [ek])).rows;
  const groups = [...new Set(teams.map((t) => t.grp))].sort();
  if (!groups.length) throw bad('Put teams into groups first, by auto draw or by hand.');
  const started = (await q("SELECT count(*)::int AS n FROM matches WHERE event_key=$1 AND stage='league' AND status<>'scheduled'", [ek])).rows[0].n;
  if (started && !req.body.force) throw new HttpError(409, 'Some league matches have results. Regenerating will discard them.');
  let created = 0;
  await tx(async (c) => {
    await c.query("DELETE FROM matches WHERE event_key=$1 AND stage='league'", [ek]);
    let seq = 0;
    const perGroup = groups.map((g) => T.roundRobin(teams.filter((t) => t.grp === g).map((t) => t.id)).map((m) => ({ ...m, g })));
    // Interleave groups round by round so the order of play alternates between groups.
    const maxRound = Math.max(0, ...perGroup.flat().map((m) => m.round));
    for (let r = 1; r <= maxRound; r++) {
      for (const list of perGroup) {
        for (const m of list.filter((x) => x.round === r)) {
          await c.query(
            `INSERT INTO matches (event_key, stage, grp, round, round_name, team_a, team_b, points, best_of, cap, seq)
             VALUES ($1,'league',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [ek, m.g, r, `Group ${m.g} · Round ${r}`, m.a, m.b, f.points, f.bestOf, f.cap, ++seq],
          );
          created++;
        }
      }
    }
  });
  broadcast();
  res.json({ ok: true, created });
}));

admin.post('/events/:ek/knockout', ah(async (req, res) => {
  const ek = evParam(req);
  const s = await getSettings();
  const f = T.formatFor(s, ek).knockout;
  const { teams, matches } = await loadAll();
  const st = computeStandings(teams, matches)[ek];
  if (!st) throw bad('This event has no groups yet.');
  const league = matches.filter((m) => m.event_key === ek && m.stage === 'league');
  const unfinished = league.filter((m) => m.status !== 'done').length;
  if (unfinished && !req.body.force) throw new HttpError(409, `${unfinished} league match(es) are not finished. Standings may still change.`);
  const qualifiers = [];
  for (const [g, rows] of Object.entries(st)) rows.slice(0, f.qualifiers).forEach((r, i) => qualifiers.push({ team: r.team, group: g, rank: i + 1 }));
  const bracket = T.buildBracket(qualifiers);
  if (!bracket) throw bad('At least two qualifiers are needed for a knockout.');
  await tx(async (c) => {
    await c.query("DELETE FROM matches WHERE event_key=$1 AND stage='knockout'", [ek]);
    const ids = [];
    const base = 10000;
    for (let r = bracket.rounds.length - 1; r >= 0; r--) {
      ids[r] = [];
      for (let i = 0; i < bracket.rounds[r].length; i++) {
        const m = bracket.rounds[r][i];
        const next = r < bracket.rounds.length - 1 ? ids[r + 1][Math.floor(i / 2)] : null;
        const row = (await c.query(
          `INSERT INTO matches (event_key, stage, round, round_name, slot, team_a, team_b, points, best_of, cap, next_match_id, next_slot, seq)
           VALUES ($1,'knockout',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [ek, r + 1, m.name, i, m.a, m.b, f.points, f.bestOf, f.cap, next, next ? (i % 2 ? 'b' : 'a') : null, base + (r + 1) * 100 + i],
        )).rows[0];
        ids[r][i] = row.id;
      }
    }
    // Byes: a lone first-round team goes straight through.
    for (let i = 0; i < bracket.rounds[0].length; i++) {
      const m = bracket.rounds[0][i];
      if ((m.a && !m.b) || (!m.a && m.b)) {
        const w = m.a || m.b;
        await c.query("UPDATE matches SET status='bye', winner=$1, finished_at=now() WHERE id=$2", [w, ids[0][i]]);
        await propagate(c, ids[0][i], w);
      }
    }
  });
  broadcast();
  res.json({ ok: true, qualifiers: qualifiers.length, size: bracket.size });
}));

admin.delete('/events/:ek/knockout', ah(async (req, res) => {
  await q("DELETE FROM matches WHERE event_key=$1 AND stage='knockout'", [evParam(req)]);
  broadcast();
  res.json({ ok: true });
}));

async function propagate(c, matchId, winner) {
  const m = (await c.query('SELECT next_match_id, next_slot FROM matches WHERE id=$1', [matchId])).rows[0];
  if (!m || !m.next_match_id) return;
  const col = m.next_slot === 'b' ? 'team_b' : 'team_a';
  await c.query(`UPDATE matches SET ${col}=$1, updated_at=now() WHERE id=$2 AND status='scheduled'`, [winner, m.next_match_id]);
}

// ---------- admin: matches ----------
admin.post('/matches', ah(async (req, res) => {
  const b = req.body || {};
  if (!T.EVENT_KEYS.includes(b.eventKey)) throw bad('Unknown event.');
  const stage = b.stage === 'league' ? 'league' : 'knockout';
  const f = T.formatFor(await getSettings(), b.eventKey)[stage];
  await q(
    `INSERT INTO matches (event_key, stage, grp, round_name, team_a, team_b, court, start_time, points, best_of, cap, seq, umpire_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [b.eventKey, stage, str(b.group, 4).toUpperCase(), str(b.roundName, 40) || (stage === 'knockout' ? 'Knockout' : ''), b.teamA || null, b.teamB || null, str(b.court, 20), str(b.startTime, 30), f.points, f.bestOf, f.cap, 50000 + Math.floor(Date.now() / 1000) % 40000, b.umpireId ? +b.umpireId : null],
  );
  broadcast();
  res.json({ ok: true });
}));

admin.patch('/matches/:id', ah(async (req, res) => {
  const b = req.body || {};
  await tx(async (c) => {
    const m = (await c.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [+req.params.id])).rows[0];
    if (!m) throw new HttpError(404, 'Match not found.');
    const next = { ...m };
    if ('court' in b) next.court = str(b.court, 20);
    if ('startTime' in b) next.start_time = str(b.startTime, 30);
    if ('roundName' in b) next.round_name = str(b.roundName, 40);
    if ('teamA' in b) next.team_a = b.teamA ? +b.teamA : null;
    if ('teamB' in b) next.team_b = b.teamB ? +b.teamB : null;
    if ('umpireId' in b) next.umpire_id = b.umpireId ? +b.umpireId : null;
    if (Array.isArray(b.games)) {
      next.games = b.games.map((g) => [Math.max(0, Math.min(99, +g[0] || 0)), Math.max(0, Math.min(99, +g[1] || 0))]).slice(0, 5);
      next.history = [];
      const w = T.winnerFromGames(next, next.games);
      next.winner = w;
      next.status = w ? 'done' : next.games.length ? 'live' : 'scheduled';
      next.result_note = '';
    }
    if (b.status && ['scheduled', 'live', 'done'].includes(b.status) && !Array.isArray(b.games)) next.status = b.status;
    await c.query(
      'UPDATE matches SET court=$1, start_time=$2, round_name=$3, team_a=$4, team_b=$5, games=$6, history=$7, winner=$8, status=$9, finished_at=CASE WHEN $9=\'done\' THEN now() ELSE NULL END, umpire_id=$11, result_note=$12, scored_by=$13, updated_at=now() WHERE id=$10',
      [next.court, next.start_time, next.round_name, next.team_a, next.team_b, JSON.stringify(next.games), JSON.stringify(next.history || []), next.winner, next.status, m.id, next.umpire_id, next.result_note || '', req.user.id],
    );
    if (next.status === 'done' && next.winner) await propagate(c, m.id, next.winner);
  });
  broadcast();
  res.json({ ok: true });
}));

admin.delete('/matches/:id', ah(async (req, res) => {
  await q('DELETE FROM matches WHERE id=$1', [+req.params.id]);
  broadcast();
  res.json({ ok: true });
}));

app.use('/api/admin', admin);

// ---------- scoring (admins, scorers and umpires) ----------
// Admins and scorers can score any match. Umpires score matches assigned to them,
// or claim an unassigned match by starting it.
const score = express.Router();
score.use(needRole('official'));
function checkOfficial(user, m) {
  if (user.role === 'admin' || user.role === 'scorer') return;
  if (m.umpire_id && m.umpire_id !== user.id) throw new HttpError(403, 'This match is assigned to another umpire.');
}
async function withMatch(req, fn) {
  return tx(async (c) => {
    const m = (await c.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [+req.params.id])).rows[0];
    if (!m) throw new HttpError(404, 'Match not found.');
    checkOfficial(req.user, m);
    return fn(c, m);
  });
}
async function writeScore(c, m, u, user) {
  const note = u.result_note || '';
  await c.query(
    "UPDATE matches SET games=$1, history=$2, status=$3, winner=$4, server=$5, result_note=$6, scored_by=$7, umpire_id=$8, finished_at=CASE WHEN $3='done' THEN now() ELSE NULL END, updated_at=now() WHERE id=$9",
    [JSON.stringify(u.games), JSON.stringify(u.history), u.status, u.winner, u.server ?? m.server, note, user.id, u.umpire_id !== undefined ? u.umpire_id : m.umpire_id, m.id],
  );
  if (u.status === 'done' && u.winner) await propagate(c, m.id, u.winner);
  if (m.status === 'done' && u.status !== 'done') await propagate(c, m.id, null);
  return { ...m, ...u, result_note: note };
}
const scoreRoute = (name, fn) => score.post('/:id/' + name, ah(async (req, res) => {
  const m = await withMatch(req, (c, m) => fn(req, c, m));
  broadcast();
  res.json(m);
}));
scoreRoute('start', (req, c, m) => {
  if (!m.team_a || !m.team_b) throw bad('Both sides must be known before the match starts.');
  if (m.status === 'done' || m.status === 'bye') throw bad('This match is finished. Ask an admin to correct the score.');
  const claim = req.user.role === 'umpire' && !m.umpire_id ? req.user.id : undefined;
  const server = req.body.server === 'b' ? 1 : req.body.server === 'a' ? 0 : m.server;
  return writeScore(c, m, { games: m.games.length ? m.games : [[0, 0]], history: m.history, status: 'live', winner: null, server, umpire_id: claim }, req.user);
});
scoreRoute('point', (req, c, m) => {
  if (m.status !== 'live') throw bad('Start the match before scoring.');
  return writeScore(c, m, T.applyPoint(m, req.body.side === 'b' ? 'b' : 'a'), req.user);
});
scoreRoute('undo', (req, c, m) => {
  const u = T.undoPoint(m);
  if (!u) throw bad('Nothing to undo.');
  return writeScore(c, m, u, req.user);
});
scoreRoute('server', (req, c, m) => {
  if (m.status !== 'live') throw bad('The match is not in play.');
  return writeScore(c, m, { games: m.games, history: m.history, status: 'live', winner: null, server: req.body.side === 'b' ? 1 : 0 }, req.user);
});
// End early: walkover (opponent did not show) or retired (injury mid-match).
scoreRoute('end', (req, c, m) => {
  const reason = req.body.reason === 'walkover' ? 'walkover' : 'retired';
  if (!m.team_a || !m.team_b) throw bad('Both sides must be known.');
  if (m.status === 'done' || m.status === 'bye') throw bad('This match is already finished.');
  const side = req.body.winner === 'b' ? 'b' : 'a';
  const winner = side === 'a' ? m.team_a : m.team_b;
  const loserName = req.body.winner === 'b' ? 'A' : 'B';
  const games = (m.games || []).filter((g) => g[0] || g[1]);
  return writeScore(c, m, {
    games, history: [...(m.history || []), m.games || []], status: 'done', winner,
    result_note: reason === 'walkover' ? 'Walkover' : `Retired (side ${loserName})`,
  }, req.user);
});
app.use('/api/score', score);

// ---------- static & errors ----------
// index.html is served with the configured tournament name filled in, so the tab title and header are right before the page script runs.
const INDEX_TEMPLATE = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sendIndex = ah(async (req, res) => {
  const s = await getSettings();
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(INDEX_TEMPLATE.split('{{TOURNAMENT_NAME}}').join(htmlEsc(s.name || DEFAULT_SETTINGS.name)));
});
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, sendIndex);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That image is too large. Use one under 8 MB.' : 'Upload failed.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server. Try again.' : err.message });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`Badminton portal listening on :${PORT}`)))
  .catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
