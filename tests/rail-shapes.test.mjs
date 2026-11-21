import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const T = load(['RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE', 'fitShapeToLength']);

test('railTierOf boundaries', () => {
  assert.equal(T.railTierOf(2.49), 'short');
  assert.equal(T.railTierOf(2.5), 'mid');
  assert.equal(T.railTierOf(7.99), 'mid');
  assert.equal(T.railTierOf(8), 'long');
});

test('pickRailShape matches the legacy weighted roll', () => {
  assert.equal(T.pickRailShape(2, 0.49), 'ellipse');
  assert.equal(T.pickRailShape(2, 0.77), 'hook');
  assert.equal(T.pickRailShape(2, 0.99), 'flick');
  assert.equal(T.pickRailShape(5, 0.60), 'zigzag');
  assert.equal(T.pickRailShape(5, 0.95), 'ramp');
  assert.equal(T.pickRailShape(9, 0.50), 'spiral');
  assert.equal(T.pickRailShape(9, 0.95), 'staircase');
});

test('every picked shape belongs to its tier', () => {
  for (const len of [1, 3, 6, 9, 14])
    for (let r = 0; r < 1; r += 0.01)
      assert.ok(T.RAIL_SHAPE_TIERS[T.railTierOf(len)].includes(T.pickRailShape(len, r)));
});

test('fitShapeToLength downgrades gracefully and always lands in tier', () => {
  assert.equal(T.fitShapeToLength('spiral', 5), 'ellipse');
  assert.equal(T.fitShapeToLength('staircase', 5), 'switchback');
  assert.equal(T.fitShapeToLength('staircase', 2), 'hook');
  assert.equal(T.fitShapeToLength('wave', 2), 'flick');
  assert.equal(T.fitShapeToLength('hook', 10), 'ellipse');   // short-only shape in a long slot
  for (const tier of Object.values(T.RAIL_SHAPE_TIERS))
    for (const s of tier) for (const len of [1, 4, 10])
      assert.ok(T.RAIL_SHAPE_TIERS[T.railTierOf(len)].includes(T.fitShapeToLength(s, len)));
});

import { loadAt, withSeed, RAIL_DEPS, colOf } from './harness.mjs';

const RAIL_NEW = ['RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE',
  'fitShapeToLength', 'RAIL_SEG_MIN_BEATS', 'RAIL_MULTISEG_MIN_BEATS', 'assignSegmentShapes',
  'planRailSegments', 'fitRailPlan', 'buildRailPath', 'railWaypointCount', 'generateRailArc'];
const OLD = loadAt('acd1853', [...RAIL_DEPS, 'generateRailArc']);
const NEW = load([...RAIL_DEPS, ...RAIL_NEW]);

// Same seed → identical rail. Lengths < 6 stay on the single-shape path forever (Task 4 keeps it).
const goldenCase = (k, maxLen) => {
  const len = 1 + (k * 0.37) % (maxLen - 1);
  const hand = k % 2, cross = k % 3 === 0;
  const start = hand === 0 ? 7 + (k % 6) : 1 + (k % 6);
  return [10, 1 + (k % 7), 10 + len, 4, 0.25, OLD.COL_X[start], hand, cross, 1.0, 120, null, null];
};
const strip = r => JSON.stringify({ w: r.waypoints, x: r.xEnd, r: r.rowEnd });

test('golden: single-shape rails identical to acd1853 (len < 6)', () => {
  for (let k = 0; k < 400; k++) {
    const args = goldenCase(k, 5.99);
    const a = withSeed(k + 1, () => OLD.generateRailArc(...args));
    const b = withSeed(k + 1, () => NEW.generateRailArc(...args));
    assert.equal(strip(b), strip(a), `case ${k}`);
  }
});

test('railWaypointCount: corners get exact counts, cap 12', () => {
  assert.equal(NEW.railWaypointCount('hook', 2, 0), 3);
  assert.equal(NEW.railWaypointCount('switchback', 5, 0), 4);
  assert.equal(NEW.railWaypointCount('staircase', 10, 4), 8);
  assert.equal(NEW.railWaypointCount('ellipse', 20, 0), 12);
});


const P = load(['RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE',
  'fitShapeToLength', 'RAIL_SEG_MIN_BEATS', 'RAIL_MULTISEG_MIN_BEATS',
  'assignSegmentShapes', 'planRailSegments', 'fitRailPlan']);
const sum = a => a.reduce((x, y) => x + y, 0);

test('planRailSegments: null below 6 beats, 2 segs for 6-12, 3 for 12+', () => {
  assert.equal(P.planRailSegments(5.9), null);
  for (let k = 0; k < 300; k++) {
    const len = 6 + (k * 0.11) % 12;
    const plan = withSeed(k + 7, () => P.planRailSegments(len));
    assert.equal(plan.length, len >= 12 ? 3 : 2);
    assert.ok(Math.abs(sum(plan.map(s => s.frac)) - 1) < 1e-9);
    for (let i = 0; i < plan.length; i++) {
      assert.ok(plan[i].frac * len >= 2.5 - 1e-9, `seg ${i} too short`);
      assert.ok(P.RAIL_SHAPE_TIERS[P.railTierOf(plan[i].frac * len)].includes(plan[i].shape));
      if (i) assert.notEqual(plan[i].shape, plan[i - 1].shape, 'adjacent shapes must differ');
    }
  }
});

test('fitRailPlan: replays shapes + proportions, downgrades, keeps invariants', () => {
  const rec = [{ frac: 0.25, shape: 'spiral' }, { frac: 0.5, shape: 'staircase' }, { frac: 0.25, shape: 'wave' }];
  const p = withSeed(3, () => P.fitRailPlan(rec, 14));
  assert.equal(p.length, 3);
  assert.ok(p[1].frac > p[0].frac);                          // proportions survive
  assert.ok(Math.abs(sum(p.map(s => s.frac)) - 1) < 1e-9);
  for (const s of p) assert.ok(s.frac * 14 >= 2.5 - 1e-9);
  const p2 = withSeed(3, () => P.fitRailPlan(rec, 8));       // 3 recorded → 2 slots
  assert.equal(p2.length, 2);
  const p3 = P.fitRailPlan(rec, 4);                          // short rail → single fitted shape
  assert.deepEqual(p3, [{ frac: 1, shape: 'ellipse' }]);     // spiral downgrades to ellipse at 4 beats
  assert.equal(P.fitRailPlan(null, 10), null);
});

const randRail = (k, cross) => {
  const hand = k % 2, len = 1 + ((k * 0.613) % 15);
  const start = hand === 0 ? 7 + (k % 7) : (k % 8);
  return { hand, len, args: [0, 1 + (k % 8), len, 4, 0.25, NEW.COL_X[start], hand, cross, 1.0, 120, null, null] };
};

test('multi-seg: zone, rows, waypoint cap, plan shape over 20k rails', () => {
  for (let k = 0; k < 20000; k++) {
    const cross = k % 3 === 0;
    const { hand, len, args } = randRail(k, cross);
    const r = withSeed(k + 11, () => NEW.generateRailArc(...args));
    const z = NEW.handZoneCols(hand, cross);
    for (const p of [...r.waypoints.map(w => ({ c: colOf(w._x), row: w.row })), { c: colOf(r.xEnd), row: r.rowEnd }]) {
      assert.ok(p.c >= z.colMin && p.c <= z.colMax, `zone k=${k}`);
      assert.ok(p.row >= 1 && p.row <= 8, `row k=${k}`);
    }
    assert.ok(r.waypoints.length <= 12);
    assert.equal(r.plan.length, len >= 12 ? 3 : len >= 6 ? 2 : 1);
  }
});

// Only SEAM steps are checked: inside one shape, consecutive waypoints of an ellipse/zigzag
// may legitimately be far apart (the rail is continuous; C3 never applies within a rail).
test('multi-seg: each segment seeds from the previous clamped endpoint; seam step within C3 caps', () => {
  for (let k = 0; k < 3000; k++) {
    const { args } = randRail(k, k % 2 === 0);
    if (args[2] < 6) continue;
    const r = withSeed(k + 5, () => NEW.generateRailArc(...args));
    const pts = [...r.waypoints.map(w => [colOf(w._x), w.row]), [colOf(r.xEnd), r.rowEnd]];
    let idx = 0;
    for (let i = 0; i < r.segments.length; i++) {
      if (i > 0) {
        assert.equal(r.segments[i].startCol, r.segments[i - 1].endCol);
        assert.equal(r.segments[i].startRow, r.segments[i - 1].endRow);
        const seam = pts[idx - 1], next = pts[idx];               // seam point → first point of segment i
        assert.ok(Math.abs(next[0] - seam[0]) <= 7, `seam col step k=${k}`);
        assert.ok(Math.abs(next[1] - seam[1]) <= 5, `seam row step k=${k}`);
      }
      idx += r.segments[i].count;
    }
  }
});

test('motifPlan replay: recorded shapes come back on a different length', () => {
  const rec = [{ frac: 0.6, shape: 'wave' }, { frac: 0.4, shape: 'pendulum' }];
  const r = withSeed(9, () => NEW.generateRailArc(0, 4, 9, 4, 0.25, NEW.COL_X[10], 0, false, 1, 120, null, null, rec));
  assert.deepEqual(r.plan.map(s => s.shape), ['wave', 'pendulum']);
});
