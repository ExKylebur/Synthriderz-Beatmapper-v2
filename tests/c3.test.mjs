import test from 'node:test';
import assert from 'node:assert/strict';
import { load, colOf } from './harness.mjs';

const K = load(['COL_X', 'isPattern', 'railPosAt', '_htCol', 'handTrajectory', 'C3_MIN_GAP_SEC', 'c3TooFast',
  'buildRailsByHand', 'sameRailWindow', 'c3Pos', 'c3Movable', 'c3Jump', 'clampC3Jumps']);
const g = (beat, c, row) => ({ beat, type: 3, _x: K.COL_X[c], row, _goldSweep: true });

// Real case from Another Life (Master, BPM 184.57), 2026-11-21: a 6-orb GoldSweep run ending
// at c10/r7, then a right-hand rail head at c13/r1 0.49s later. Was "stuck" every iteration.
test('GoldSweep run edge is nudged to reach a rail head (was unresolvable)', () => {
  const bps = 184.57 / 60;
  const run = [g(192.75, 7, 6), g(193, 6, 4), g(193.5, 5, 2), g(194.25, 7, 4), g(195, 8, 6), g(195.75, 10, 7)];
  const rail = { beat: 197.25, type: 0, _x: K.COL_X[13], row: 1, railEndBeat: 202.25, railEndRow: 2,
    railEnd_x: K.COL_X[14], railSegments: [{ beat: 199, _x: K.COL_X[14], row: 1 }] };
  const notes = [...run, rail];
  const res = K.clampC3Jumps(notes, bps);
  assert.equal(res.stuck, 0);
  const last = run[run.length - 1];
  assert.ok(Math.abs(last.row - rail.row) <= 5, `edge row ${last.row}`);
  assert.deepEqual(run.slice(0, -1).map(n => [colOf(n._x), n.row]), [[7, 6], [6, 4], [5, 2], [7, 4], [8, 6]], 'interior untouched');
});

test('an interior GoldSweep orb is never moved', () => {
  const bps = 2;
  const run = [g(10, 7, 2), g(10.5, 7, 7), g(11, 7, 2)];          // middle orb is interior
  const r0 = { beat: 10.6, type: 0, _x: K.COL_X[8], row: 1 };      // loose red right after the middle orb
  const notes = [...run, r0];
  K.clampC3Jumps(notes, bps);
  assert.equal(run[1].row, 7);
});
