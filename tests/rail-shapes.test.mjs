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
  'planRailSegments', 'fitRailPlan', 'buildRailPath', 'railWaypointCount', 'railCornerTs', 'generateRailArc'];
const OLD = loadAt('acd1853', [...RAIL_DEPS, 'generateRailArc']);
const NEW = load([...RAIL_DEPS, ...RAIL_NEW]);

// Same seed → identical rail. Lengths < 6 stay on the single-shape path forever (Task 4 keeps it).
// Since the 2026-11-24 shape-fidelity rework the VERTEX shapes (hook, flick, zigzag, ramp,
// switchback, staircase) and wave are drawn larger and sampled on their corners on purpose, so
// only the untouched curves (ellipse, pendulum) are still pinned to acd1853; the reworked
// shapes are covered by the fidelity tests below instead.
const UNCHANGED = new Set(['ellipse', 'pendulum']);
const goldenCase = (k, maxLen) => {
  const len = 1 + (k * 0.37) % (maxLen - 1);
  const hand = k % 2, cross = k % 3 === 0;
  const start = hand === 0 ? 7 + (k % 6) : 1 + (k % 6);
  return [10, 1 + (k % 7), 10 + len, 4, 0.25, OLD.COL_X[start], hand, cross, 1.0, 120, null, null];
};
const strip = r => JSON.stringify({ w: r.waypoints, x: r.xEnd, r: r.rowEnd });

test('golden: single-shape ellipse/pendulum rails identical to acd1853 (len < 6)', () => {
  let checked = 0;
  for (let k = 0; k < 400; k++) {
    const args = goldenCase(k, 5.99);
    const a = withSeed(k + 1, () => OLD.generateRailArc(...args));
    const b = withSeed(k + 1, () => NEW.generateRailArc(...args));
    if (!UNCHANGED.has(b.plan[0].shape)) continue;
    assert.equal(strip(b), strip(a), `case ${k}`);
    checked++;
  }
  assert.ok(checked > 150, `only ${checked} unchanged-shape cases`);
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

// ── Shape fidelity (2026-11-24 play-test: "stairs were mostly straight", curves too shallow) ──
// The game and the 3D preview draw a rail as a smooth spline through head, waypoints and tail.
// These tests render it the same way (uniform Catmull-Rom, timed by beat) and check that what
// the player sees keeps the shape's defining features.
function railPts(r, head, row, col) {
  return [{ b: head, c: col, r: row }, ...r.waypoints.map(w => ({ b: w.beat, c: colOf(w._x), r: w.row })),
          { b: r.waypoints.length ? Infinity : head, c: colOf(r.xEnd), r: r.rowEnd }];
}
const forced = (shape, len, k, { snap = 0.25, head = 0 } = {}) => {
  const hand = k % 2, col = hand === 0 ? 7 + (k % 8) : (k % 8), row = 1 + (k % 8);
  const r = withSeed(k + 3, () => NEW.generateRailArc(head, row, head + len, row, snap, NEW.COL_X[col], hand, false, 1, 120, null, null, [{ frac: 1, shape }]));
  const pts = railPts(r, head, row, col); pts[pts.length - 1].b = head + len;
  return { r, pts, hand, col, row };
};
const span = (pts, k) => Math.max(...pts.map(p => p[k])) - Math.min(...pts.map(p => p[k]));

test('fidelity: oscillating shapes swing >= 4 rows; wave, zigzag and ramp never draw the same path', () => {
  for (let k = 0; k < 200; k++) {
    for (const s of ['wave', 'zigzag', 'ramp', 'switchback']) {
      const { pts } = forced(s, 4 + (k % 4), k);
      assert.ok(span(pts, 'r') >= 4, `${s} k=${k}: row span ${span(pts, 'r')}`);
    }
    const key = s => JSON.stringify(forced(s, 4 + (k % 4), k).pts.map(p => [p.c, p.r]));
    assert.ok(new Set(['wave', 'zigzag', 'ramp'].map(key)).size === 3, `k=${k}: two shapes coincide`);
  }
});

test('fidelity: staircase is >= 2 discrete steps, each >= 2 cols and >= 2 rows, with flat treads', () => {
  for (let k = 0; k < 300; k++) {
    const { pts } = forced('staircase', 8 + (k % 7), k);
    // collapse to the row levels the rail holds flat for >= 1 beat
    const levels = [];
    for (let i = 1; i < pts.length; i++)
      if (pts[i].r === pts[i - 1].r && pts[i].b - pts[i - 1].b >= 0.5 - 1e-9) {
        const lv = levels[levels.length - 1];
        if (!lv || lv.r !== pts[i].r) levels.push({ r: pts[i].r, c0: pts[i - 1].c, c1: pts[i].c });
        else lv.c1 = pts[i].c;
      }
    assert.ok(levels.length >= 2, `k=${k}: ${levels.length} flat treads`);
    for (let i = 1; i < levels.length; i++)
      assert.ok(Math.abs(levels[i].r - levels[i - 1].r) >= 2, `k=${k}: riser ${Math.abs(levels[i].r - levels[i - 1].r)} rows`);
    // every tread but the landing carries the rail >= 2 cols sideways
    for (const l of levels.slice(0, -1)) assert.ok(Math.abs(l.c1 - l.c0) >= 2, `k=${k}: tread ${Math.abs(l.c1 - l.c0)} cols`);
    // monotone: rows never reverse direction (it is a staircase, not a zigzag)
    const d = pts.slice(1).map((p, i) => Math.sign(p.r - pts[i].r)).filter(Boolean);
    assert.ok(d.every(x => x === d[0]), `k=${k}: rows reverse`);
  }
});

test('fidelity: every corner of a vertex shape gets a waypoint ON it (all grids)', () => {
  const Z = NEW.handZoneCols;
  for (const snap of [0.25, 1 / 3, 0.5])
    for (let k = 0; k < 120; k++)
      for (const [s, len] of [['zigzag', 5], ['switchback', 5], ['ramp', 6], ['hook', 2], ['flick', 2], ['staircase', 10]]) {
        const { pts, hand, col, row } = forced(s, len, k, { snap });
        const z = Z(hand, false);
        const { posAt, corners } = NEW.buildRailPath(s, len, col, row, z.colMin, z.colMax, 1, 0.5);
        assert.ok(corners && corners.length, s);
        for (const tc of corners) {
          const b = len * tc;
          const near = pts.filter(p => Math.abs(p.b - b) <= snap / 2 + 1e-9);
          if (!near.length) continue;                       // corner fell on a beat already taken
          const q = posAt(tc), ic = Math.max(z.colMin, Math.min(z.colMax, q.col)), ir = Math.max(1, Math.min(8, q.row));
          assert.ok(near.some(p => Math.abs(p.c - ic) <= 1 && Math.abs(p.r - ir) <= 1), `${s} k=${k} snap=${snap} corner t=${tc}`);
        }
        for (let i = 1; i < pts.length; i++) {
          assert.ok(pts[i].b > pts[i - 1].b, `${s} k=${k}: beats not increasing`);
          // validate.py RAIL_NODE_DIST: a node gap > 2 beats may render wrong (staircase treads)
          assert.ok(pts[i].b - pts[i - 1].b <= 2 + snap, `${s} k=${k} snap=${snap}: node gap ${pts[i].b - pts[i - 1].b}`);
        }
      }
});

test('fidelity: corners survive the spline — rendered rail stays within 1 cell of the drawn polyline', () => {
  const cr = (pts, b) => {
    let i = 0; while (i < pts.length - 2 && b > pts[i + 1].b) i++;
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const u = Math.max(0, Math.min(1, (b - p1.b) / ((p2.b - p1.b) || 1)));
    const f = key => 0.5 * (2 * p1[key] + (-p0[key] + p2[key]) * u + (2 * p0[key] - 5 * p1[key] + 4 * p2[key] - p3[key]) * u * u
                             + (-p0[key] + 3 * p1[key] - 3 * p2[key] + p3[key]) * u * u * u);
    return { c: f('c'), r: f('r') };
  };
  const lin = (pts, b) => {
    let i = 0; while (i < pts.length - 2 && b > pts[i + 1].b) i++;
    const a = pts[i], c = pts[i + 1], u = Math.max(0, Math.min(1, (b - a.b) / ((c.b - a.b) || 1)));
    return { c: a.c + (c.c - a.c) * u, r: a.r + (c.r - a.r) * u };
  };
  for (let k = 0; k < 150; k++)
    for (const [s, len] of [['zigzag', 5], ['switchback', 5], ['ramp', 6], ['staircase', 10]]) {
      const { pts } = forced(s, len, k);
      for (let j = 0; j <= 400; j++) {
        const b = len * j / 400, p = cr(pts, b), q = lin(pts, b);
        assert.ok(Math.hypot(p.c - q.c, p.r - q.r) <= 1.0, `${s} k=${k} beat ${b.toFixed(2)}`);
      }
    }
});
