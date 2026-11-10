'use strict';
// Pure tournament logic: formats, scoring, standings, round robin and knockout brackets.

// Kids play in separate Boys and Girls categories, singles and doubles only (no mixed doubles).
const CATEGORIES = {
  Men: ['Singles', 'Doubles', 'Mixed Doubles'],
  Women: ['Singles', 'Doubles', 'Mixed Doubles'],
  Boys: ['Singles', 'Doubles'],
  Girls: ['Singles', 'Doubles'],
};
const CATEGORY_LABELS = { Men: 'Men', Women: 'Women', Boys: 'Kids – Boys', Girls: 'Kids – Girls' };
const EVENT_KEYS = ['Men Singles', 'Men Doubles', 'Women Singles', 'Women Doubles', 'Mixed Doubles', 'Boys Singles', 'Boys Doubles', 'Girls Singles', 'Girls Doubles'];
// Only Men and Women may enter mixed doubles.
const eventAllowed = (cat, evt) => (CATEGORIES[cat] || []).includes(evt);

// Older settings stored a single "Kids" category; carry its choices over to Boys and Girls.
function normalizeEvents(stored) {
  const out = {};
  for (const [cat, list] of Object.entries(CATEGORIES)) {
    let chosen = stored && Array.isArray(stored[cat]) ? stored[cat] : null;
    if (!chosen && (cat === 'Boys' || cat === 'Girls') && stored && Array.isArray(stored.Kids)) chosen = stored.Kids;
    out[cat] = (chosen || list).filter((e) => list.includes(e));
  }
  return out;
}
const eventKey = (cat, evt) => (evt === 'Mixed Doubles' ? 'Mixed Doubles' : `${cat} ${evt}`);

const capFor = (points) => Math.max(points, Math.round((points * 10) / 7)); // 21 -> 30, 15 -> 21, 11 -> 16

const DEFAULT_FORMAT = {
  groups: 2,
  league: { points: 21, bestOf: 1, cap: 30 },
  knockout: { qualifiers: 2, points: 21, bestOf: 3, cap: 30 },
};

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

function normalizeStage(s, dflt, isKo) {
  s = s || {};
  const points = clampInt(s.points, 5, 51, dflt.points);
  const bestOf = [1, 3, 5].includes(+s.bestOf) ? +s.bestOf : dflt.bestOf;
  const cap = clampInt(s.cap, points, 99, capFor(points));
  const out = { points, bestOf, cap };
  if (isKo) out.qualifiers = clampInt(s.qualifiers, 1, 8, dflt.qualifiers);
  return out;
}

function normalizeFormat(f) {
  f = f || {};
  return {
    groups: clampInt(f.groups, 1, 16, DEFAULT_FORMAT.groups),
    league: normalizeStage(f.league, DEFAULT_FORMAT.league, false),
    knockout: normalizeStage(f.knockout, DEFAULT_FORMAT.knockout, true),
  };
}

const formatFor = (settings, ek) => normalizeFormat(((settings && settings.formats) || {})[ek]);

function gameOver(g, points, cap) {
  const [a, b] = g;
  const hi = Math.max(a, b);
  return (hi >= points && Math.abs(a - b) >= 2) || hi >= cap;
}

function tally(games, points, cap) {
  let a = 0, b = 0;
  for (const g of games || []) {
    if (!gameOver(g, points, cap)) continue;
    if (g[0] > g[1]) a++; else b++;
  }
  return [a, b];
}

function decided(m) {
  const need = Math.ceil(m.best_of / 2);
  const [a, b] = tally(m.games, m.points, m.cap);
  return a >= need ? 'a' : b >= need ? 'b' : null;
}

// Apply one rally point. Returns the fields to update on the match.
function applyPoint(m, side) {
  const games = (m.games || []).map((g) => g.slice());
  if (!games.length) games.push([0, 0]);
  let last = games[games.length - 1];
  if (gameOver(last, m.points, m.cap)) { games.push([0, 0]); last = games[games.length - 1]; }
  const i = side === 'a' ? 0 : 1;
  last[i]++;
  const history = [...(m.history || []), m.games || []].slice(-300);
  const out = { games, history, server: i, status: 'live', winner: null };
  const d = decided({ ...m, games });
  if (d) { out.status = 'done'; out.winner = d === 'a' ? m.team_a : m.team_b; }
  else if (gameOver(last, m.points, m.cap)) games.push([0, 0]);
  return out;
}

function undoPoint(m) {
  const history = (m.history || []).slice();
  if (!history.length) return null;
  const games = history.pop();
  // Undoing a walkover recorded before any rally puts the match back to scheduled.
  return { games, history, status: games.length ? 'live' : 'scheduled', winner: null };
}

// Winner from a manually entered score list.
function winnerFromGames(m, games) {
  const d = decided({ ...m, games });
  return d === 'a' ? m.team_a : d === 'b' ? m.team_b : null;
}

function standings(teamIds, matches) {
  const rows = new Map(teamIds.map((id) => [id, { team: id, p: 0, w: 0, l: 0, gw: 0, gl: 0, pf: 0, pa: 0, pts: 0 }]));
  for (const m of matches) {
    if (m.status !== 'done' || !rows.has(m.team_a) || !rows.has(m.team_b)) continue;
    const A = rows.get(m.team_a), B = rows.get(m.team_b);
    const [ga, gb] = tally(m.games, m.points, m.cap);
    A.p++; B.p++;
    A.gw += ga; A.gl += gb; B.gw += gb; B.gl += ga;
    for (const g of m.games || []) { A.pf += g[0]; A.pa += g[1]; B.pf += g[1]; B.pa += g[0]; }
    if (m.winner === m.team_a) { A.w++; B.l++; A.pts += 2; }
    else if (m.winner === m.team_b) { B.w++; A.l++; B.pts += 2; }
  }
  const list = [...rows.values()];
  // Head-to-head result between two tied teams
  const h2h = (x, y) => {
    const m = matches.find((k) => k.status === 'done' && ((k.team_a === x && k.team_b === y) || (k.team_a === y && k.team_b === x)));
    return m ? (m.winner === x ? -1 : m.winner === y ? 1 : 0) : 0;
  };
  list.sort((x, y) => y.pts - x.pts || y.w - x.w || (y.gw - y.gl) - (x.gw - x.gl) || (y.pf - y.pa) - (x.pf - x.pa) || h2h(x.team, y.team) || x.team - y.team);
  return list;
}

// Circle method: every pair meets once, spread across rounds.
function roundRobin(ids) {
  const t = ids.slice();
  if (t.length < 2) return [];
  if (t.length % 2) t.push(null);
  const out = [];
  const rounds = t.length - 1, half = t.length / 2;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const a = t[i], b = t[t.length - 1 - i];
      if (a != null && b != null) out.push({ round: r + 1, a: r % 2 ? b : a, b: r % 2 ? a : b });
    }
    t.splice(1, 0, t.pop());
  }
  return out;
}

function seedOrder(size) {
  let arr = [1, 2];
  while (arr.length < size) {
    const n = arr.length * 2;
    arr = arr.flatMap((s) => [s, n + 1 - s]);
  }
  return arr;
}

const roundName = (teamsLeft) => (teamsLeft === 2 ? 'Final' : teamsLeft === 4 ? 'Semifinal' : teamsLeft === 8 ? 'Quarterfinal' : `Round of ${teamsLeft}`);

// qualifiers: [{team, group, rank}] -> { size, rounds: [[{a,b,name}]] } first round filled, later rounds empty.
function buildBracket(qualifiers) {
  const seeds = qualifiers.slice().sort((x, y) => x.rank - y.rank || String(x.group).localeCompare(String(y.group)));
  const Q = seeds.length;
  if (Q < 2) return null;
  let size = 2;
  while (size < Q) size *= 2;
  const order = seedOrder(size);
  const pairs = [];
  for (let i = 0; i < order.length; i += 2) pairs.push([seeds[order[i] - 1] || null, seeds[order[i + 1] - 1] || null]);
  // Avoid same-group meetings in the first round where a swap fixes it.
  for (const p of pairs) {
    if (!p[0] || !p[1] || p[0].group !== p[1].group) continue;
    for (const q of pairs) {
      if (q === p || !q[0] || !q[1]) continue;
      if (p[0].group !== q[1].group && q[0].group !== p[1].group && q[1].rank === p[1].rank) {
        const tmp = p[1]; p[1] = q[1]; q[1] = tmp; break;
      }
    }
  }
  const rounds = [];
  let count = size / 2, left = size;
  rounds.push(pairs.map(([a, b]) => ({ a: a && a.team, b: b && b.team, name: roundName(left) })));
  while (count > 1) {
    count /= 2; left /= 2;
    rounds.push(Array.from({ length: count }, () => ({ a: null, b: null, name: roundName(left) })));
  }
  return { size, rounds };
}

module.exports = {
  CATEGORIES, CATEGORY_LABELS, EVENT_KEYS, eventKey, eventAllowed, normalizeEvents, DEFAULT_FORMAT, normalizeFormat, formatFor, capFor,
  gameOver, tally, decided, applyPoint, undoPoint, winnerFromGames, standings, roundRobin, seedOrder, buildBracket,
};
