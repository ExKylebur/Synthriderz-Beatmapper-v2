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
