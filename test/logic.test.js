'use strict';
const assert = require('assert');
const T = require('../lib/tournament');

// Scoring: best of 3 to 15, cap 21
let m = { team_a: 1, team_b: 2, points: 15, best_of: 3, cap: 21, games: [], history: [], status: 'live' };
const play = (side, n) => { for (let i = 0; i < n; i++) m = { ...m, ...T.applyPoint(m, side) }; };
play('a', 15);
assert.deepStrictEqual(m.games, [[15, 0], [0, 0]], 'game 1 ends at 15 and game 2 opens');
play('b', 14); play('a', 14);
assert.deepStrictEqual(m.games[1], [14, 14], 'deuce continues past 15');
play('b', 2);
assert.strictEqual(m.games.length, 3);
play('a', 14); play('b', 14); for (let i = 0; i < 6; i++) { play('a', 1); play('b', 1); } play('a', 1);
assert.strictEqual(m.status, 'done');
assert.strictEqual(m.winner, 1, 'cap at 21 decides game 3');
const u = T.undoPoint(m); assert.strictEqual(u.status, 'live'); assert.deepStrictEqual(u.games[2], [20, 20]);

// Single game to 21
let s = { team_a: 5, team_b: 6, points: 21, best_of: 1, cap: 30, games: [], history: [], status: 'live' };
for (let i = 0; i < 21; i++) s = { ...s, ...T.applyPoint(s, 'b') };
assert.strictEqual(s.winner, 6);

// Round robin
const rr = T.roundRobin([1, 2, 3, 4, 5]);
assert.strictEqual(rr.length, 10);
const pairs = new Set(rr.map((x) => [x.a, x.b].sort().join('-')));
assert.strictEqual(pairs.size, 10);

// Standings
const st = T.standings([1, 2, 3], [
  { team_a: 1, team_b: 2, status: 'done', winner: 1, games: [[21, 10]], points: 21, cap: 30 },
  { team_a: 2, team_b: 3, status: 'done', winner: 2, games: [[21, 19]], points: 21, cap: 30 },
  { team_a: 1, team_b: 3, status: 'done', winner: 3, games: [[18, 21]], points: 21, cap: 30 },
]);
assert.strictEqual(st[0].team, 1, 'point difference breaks the three-way tie');

// Bracket: 3 groups, top 2 -> 8-slot draw, 2 byes, no same-group first round
const q = [];
['A', 'B', 'C'].forEach((g, gi) => [1, 2].forEach((r) => q.push({ team: gi * 10 + r, group: g, rank: r })));
const b = T.buildBracket(q);
assert.strictEqual(b.size, 8);
assert.strictEqual(b.rounds.length, 3);
assert.strictEqual(b.rounds[2][0].name, 'Final');
const grp = (id) => q.find((x) => x.team === id).group;
b.rounds[0].forEach((p) => { if (p.a && p.b) assert.notStrictEqual(grp(p.a), grp(p.b), 'same-group first-round match'); });
assert.strictEqual(b.rounds[0].filter((p) => !p.a || !p.b).length, 2, 'two byes');

// 4 groups top 2 -> A1 v B2 style crossover
const q2 = [];
['A', 'B', 'C', 'D'].forEach((g, gi) => [1, 2].forEach((r) => q2.push({ team: gi * 10 + r, group: g, rank: r })));
const b2 = T.buildBracket(q2);
b2.rounds[0].forEach((p) => { assert.ok(p.a && p.b); assert.notStrictEqual(q2.find((x) => x.team === p.a).group, q2.find((x) => x.team === p.b).group); });

console.log('All tournament logic tests passed');
