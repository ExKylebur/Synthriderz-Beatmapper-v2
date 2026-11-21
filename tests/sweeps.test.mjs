import test from 'node:test';
import assert from 'node:assert/strict';
import { load, colOf } from './harness.mjs';

const S = load(['COL_X', 'CROSS_REACH_COLS', 'handZoneCols', 'buildDanceMoves', 'DANCE_MOVES',
  'isPattern', 'smoothPatternBoundaries']);

test('DANCE_MOVES: the 14 named moves, in-range steps, non-cross moves stay home', () => {
  assert.deepEqual(S.DANCE_MOVES.map(m => m.name), ['parallelSpiral', 'mirrorSpiral', 'scissors',
    'doublePunch', 'altJabs', 'parallelStairs', 'accordion', 'mirrorWings', 'crossReturn',
    'dnaHelix', 'pendulum', 'outwardBloom', 'boxStep', 'heartbeat']);
  for (const m of S.DANCE_MOVES) for (const st of m.steps) {
    if (st.l) { assert.ok(st.l[1] >= 1 && st.l[1] <= 9); if (!m.cross) assert.ok(st.l[0] <= 7); }
    if (st.r) { assert.ok(st.r[1] >= 1 && st.r[1] <= 9); if (!m.cross) assert.ok(st.r[0] >= 7); }
  }
});

test('isPattern covers dense + sparse only', () => {
  assert.equal(S.isPattern({ _denseSweep: true }), true);
  assert.equal(S.isPattern({ _sparseSweep: true }), true);
  assert.equal(S.isPattern({ _goldSweep: true }), false);
  assert.equal(S.isPattern(null), false);
});

test('smoothPatternBoundaries nudges only the loose side, to exactly the C3 limit', () => {
  const anchor = { type: 1, beat: 10, _x: S.COL_X[0], row: 5, _sparseSweep: true };
  const loose  = { type: 1, beat: 10.5, _x: S.COL_X[7], row: 5 };                 // 7 cols: ok
  const far    = { type: 1, beat: 11, _x: S.COL_X[0], row: 0, _denseSweep: true };
  const loose2 = { type: 1, beat: 11.5, _x: S.COL_X[7], row: 9 };                 // 9 rows: too far
  const n = S.smoothPatternBoundaries([anchor, loose, far, loose2]);
  assert.equal(n, 1);
  assert.equal(colOf(loose._x), 7);
  assert.equal(loose2.row, 5);
  assert.equal(colOf(anchor._x), 0);
});

import { appSource } from './harness.mjs';
test('pattern checks go through isPattern (no stray _denseSweep-only gates)', () => {
  const src = appSource();
  for (const bad of ['n._denseSweep ? Math.max(lo', 'n._denseSweep ? 4 :',
    "!b._denseSweep && _movable(b, h)", "!a._denseSweep && _movable(a, h)",
    '(a._denseSweep || a._goldSweep) && (b._denseSweep || b._goldSweep)'])
    assert.ok(!src.includes(bad), `still present: ${bad}`);
  assert.ok(src.includes("n._sparseSweep ? { pattern: 'sparse' }"));
});

const W = load(['COL_X', 'CROSS_REACH_COLS', 'handZoneCols', 'buildDanceMoves', 'DANCE_MOVES',
  'isPattern', 'smoothPatternBoundaries', 'SSW_MAXGAP', 'SSW_MINRUN', 'SSW_MINSPAN', 'applySparseSweep']);

const orb = (beat, type, col = type === 0 ? 10 : 4, row = 5, extra = {}) =>
  ({ beat, type, _x: W.COL_X[col], row, ...extra });

test('sparse run (1-beat alternating) is choreographed; others untouched', () => {
  const run = Array.from({ length: 12 }, (_, i) => orb(20 + i, i % 2));
  const dense = [orb(40, 0, 10, 5, { _denseSweep: true }), orb(40.25, 1, 4, 5, { _denseSweep: true })];
  const rail = orb(50, 0, 11, 5, { railEndBeat: 54 });
  const gold = { beat: 60, type: 3, _x: 0, row: 5 };
  const sparseGap = [orb(70, 0), orb(72, 0), orb(74, 0), orb(76, 0), orb(78, 0)];   // 2-beat gaps: no run
  const all = [...run, ...dense, rail, gold, ...sparseGap];
  const res = W.applySparseSweep(all, {});
  assert.equal(res.runs, 1);
  assert.equal(res.tagged, 12);
  for (const n of run) {
    assert.ok(n._sparseSweep && n._preSweep);
    assert.ok(n.row >= 2 && n.row <= 8);
    const z = W.handZoneCols(n.type, true);
    assert.ok(colOf(n._x) >= z.colMin && colOf(n._x) <= z.colMax);
  }
  for (const n of [...dense, rail, gold, ...sparseGap]) assert.ok(!n._sparseSweep);
});

test('per-hand step cap scales with the gap (max 5)', () => {
  const run = Array.from({ length: 16 }, (_, i) => orb(i * 1.0, i % 2));
  W.applySparseSweep(run, {});
  for (const h of [0, 1]) {
    const hn = run.filter(n => n.type === h);
    for (let i = 1; i < hn.length; i++) {
      const cap = Math.min(5, 3 + Math.floor(hn[i].beat - hn[i - 1].beat));
      const m = Math.abs(colOf(hn[i]._x) - colOf(hn[i - 1]._x)) + Math.abs(hn[i].row - hn[i - 1].row);
      assert.ok(m <= cap + 1, `hand ${h} step ${i}: ${m} > ${cap}`);   // +1: row clamp after cap
    }
  }
});

test('pickMove hook receives section + region index', () => {
  const run = Array.from({ length: 8 }, (_, i) => orb(i, i % 2));
  const seen = [];
  W.applySparseSweep(run, { sectionAt: b => ({ name: 'chorus', b }), pickMove: (sec, reg) => { seen.push([sec.name, reg]); return 2; } });
  assert.deepEqual(seen, [['chorus', 0]]);
});
