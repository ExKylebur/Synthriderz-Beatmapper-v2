// [ObstacleChoreo] (2026-11-24): notes in a wall's comfort window move AS A GROUP into a move the
// wall suggests (crouch -> swoop, lean -> tilt, slide -> full-body sway) instead of each being
// clamped to the nearest band edge; crouch holds get a swoop rail (buildSwoopRail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, RAIL_DEPS, colOf } from './harness.mjs';

const G = load([...RAIL_DEPS, 'OBS_AEROBIC_REACH', 'OBS_REACH', 'obstacleReachBand', 'obstacleReachAt',
  'obstacleReachClamp', 'clampNotesToObstacleReach', 'fitAxisToBounds',
  'OBS_CHOREO_RAMP_BEATS', 'OBS_TILT_COLS_PER_ROW', 'OBS_SWOOP_DEPTH', 'OBS_SWOOP_CONTOUR', 'applyObstacleChoreo',
  'SWOOP_RAIL_MIN_BEATS', 'buildSwoopRail']);
const COL = c => G.COL_X[c];
const W = (wallType, extra = {}) => ({ beat: 20, duration: 2, wallType, ...extra });
// A dense two-hand stream through the window [18, 24): right hand a 4-step up/down move at cols
// 9-12, left hand mirrored at cols 2-5, a note every half beat, plus ramp notes outside.
function stream(b0 = 15, b1 = 27) {
  const out = [];
  for (let b = b0, k = 0; b < b1; b += 0.5, k++) {
    const row = [3, 5, 7, 5][k % 4];
    out.push({ beat: b, row, type: 0, _x: COL(9 + (k % 4)) });
    out.push({ beat: b + 0.25, row: 10 - row, type: 1, _x: COL(5 - (k % 4)) });
  }
  return out;
}
const inWin = n => n.beat >= 18 && n.beat < 24;
const spearman = (xs, ys) => {
  const rk = a => { const s = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = Array(a.length);
    for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++;
      for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const a = rk(xs), b = rk(ys), m = (a.length - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - m) * (b[i] - m); da += (a[i] - m) ** 2; db += (b[i] - m) ** 2; }
  return num / Math.sqrt(da * db || 1);
};
const inBox = (walls, n) => {
  const b = G.obstacleReachAt(walls, n.beat, n.type);
  return !b || (n.row >= b.minRow && n.row <= b.maxRow && colOf(n._x) >= b.minCol && colOf(n._x) <= b.maxCol);
};

test('crouch -> swoop: rows dip toward the floor of the band under the bar and rise again, inside rows 4-7', () => {
  const walls = [W('crouch')], notes = stream();
  const st = G.applyObstacleChoreo(notes, walls);
  assert.ok(st.swoop > 0 && st.walls === 1);
  const win = notes.filter(inWin);
  for (const n of win) assert.ok(n.row >= 4 && n.row <= 7 && inBox(walls, n), `beat ${n.beat}: row ${n.row}`);
  const mean = f => { const a = win.filter(f); return a.reduce((s, n) => s + n.row, 0) / a.length; };
  const mid = mean(n => n.beat >= 20 && n.beat < 22), edge = mean(n => n.beat < 19 || n.beat >= 23);
  assert.ok(mid > edge + 0.5, `dip: rows under the bar ${mid.toFixed(2)} vs window edges ${edge.toFixed(2)}`);
  // the per-note clamp would give each note the nearest band edge: no dip at all
  const old = stream(); G.clampNotesToObstacleReach(old, walls);
  const om = f => { const a = old.filter(inWin).filter(f); return a.reduce((s, n) => s + n.row, 0) / a.length; };
  assert.ok(Math.abs(om(n => n.beat >= 20 && n.beat < 22) - om(n => n.beat < 19 || n.beat >= 23)) < 0.5, 'old clamp has no dip');
});

for (const [wallType, sign] of [['leanLeft', 1], ['leanRight', -1]]) {
  test(`${wallType} -> tilt: each hand's notes line up parallel to the wall, higher = further toward the lean side`, () => {
    const walls = [W(wallType)], notes = stream();
    const st = G.applyObstacleChoreo(notes, walls);
    assert.ok(st.tilt > 0);
    for (const h of [0, 1]) {
      const hn = notes.filter(n => inWin(n) && n.type === h);
      for (const n of hn) assert.ok(inBox(walls, n), `${wallType} hand ${h} beat ${n.beat}: (${colOf(n._x)},${n.row}) outside its band`);
      // rows grow downward, so leanLeft (higher -> left) means col rises with row: positive correlation
      const rho = spearman(hn.map(n => n.row), hn.map(n => colOf(n._x)));
      assert.ok(sign * rho >= 0.5, `${wallType} hand ${h}: tilt correlation ${rho.toFixed(2)}`);
      assert.ok(new Set(hn.map(n => `${colOf(n._x)},${n.row}`)).size >= 3, 'the string uses >= 3 cells');
    }
    // the per-note clamp leaves no tilt on at least one hand (that is what this replaces)
    const old = stream(); G.clampNotesToObstacleReach(old, walls);
    const rhoOld = [0, 1].map(h => { const hn = old.filter(n => inWin(n) && n.type === h);
      return sign * spearman(hn.map(n => n.row), hn.map(n => colOf(n._x))); });
    assert.ok(Math.min(...rhoOld) < 0.5, `old clamp already tilted: ${rhoOld.map(r => r.toFixed(2))}`);
    // a flat run (every note on row 5) walks up and down the string
    const flat = stream().map(n => ({ ...n, row: 5 }));
    G.applyObstacleChoreo(flat, walls);
    for (const h of [0, 1]) {
      const hn = flat.filter(n => inWin(n) && n.type === h);
      assert.ok(Math.max(...hn.map(n => n.row)) - Math.min(...hn.map(n => n.row)) >= 2, `flat run hand ${h} stayed flat`);
      assert.ok(sign * spearman(hn.map(n => n.row), hn.map(n => colOf(n._x))) >= 0.5, `flat run hand ${h} not tilted`);
    }
  });
}

for (const [slideType, side] of [[0, 'left'], [4, 'right']]) {
  test(`slide ${slideType} -> sway: both hands shift ${side} together, the formation kept`, () => {
    const walls = [W('slide', { slideType })], notes = stream();
    const before = notes.map(n => colOf(n._x));
    const st = G.applyObstacleChoreo(notes, walls);
    assert.ok(st.sway > 0);
    const win = notes.map((n, i) => [n, before[i]]).filter(([n]) => inWin(n));
    for (const [n] of win) assert.ok(inBox(walls, n), `slide ${slideType} beat ${n.beat}: (${colOf(n._x)},${n.row})`);
    const shifts = win.map(([n, c]) => colOf(n._x) - c);
    const dir = slideType === 0 ? -1 : 1;
    // every note moves the same way (one body), most by the same amount (a rigid shift where it fits)
    for (const s of shifts) assert.ok(dir * s >= 0, `slide ${slideType}: a note moved against the sway (${s})`);
    assert.ok(shifts.some(s => s !== 0), 'nothing swayed');
    const spread = Math.max(...shifts) - Math.min(...shifts);
    assert.ok(spread <= 3, `slide ${slideType}: shifts spread ${spread} cols (formation squashed)`);
  });
}

test('approach and release: notes up to 2 beats outside a window move part of the way, nearer = further', () => {
  const walls = [W('slide', { slideType: 0 })], notes = stream();
  const before = new Map(notes.map(n => [n, colOf(n._x)]));
  const st = G.applyObstacleChoreo(notes, walls);
  assert.ok(st.ramp > 0);
  const d = n => colOf(n._x) - before.get(n);
  for (const n of notes) {
    if (n.beat < 16 || n.beat >= 26) assert.equal(d(n), 0, `beat ${n.beat}: outside the ramp but moved`);
    else if (!inWin(n)) assert.ok(d(n) <= 0, `beat ${n.beat}: ramp note moved against the sway`);
  }
  const ramp = h => notes.filter(n => n.type === h && n.beat >= 16 && n.beat < 18);
  const near = ramp(0).filter(n => n.beat >= 17), far = ramp(0).filter(n => n.beat < 17);
  const avg = a => a.reduce((s, n) => s + d(n), 0) / a.length;
  assert.ok(avg(near) <= avg(far), `nearer ramp notes move at least as far (${avg(near)} vs ${avg(far)})`);
});

test('no-ops: aerobic walls, rails, companions and orbit circles are left to their own passes', () => {
  const rail = { beat: 19, row: 2, type: 0, _x: COL(12), railEndBeat: 23, railEndRow: 2, railEnd_x: COL(12), railSegments: [] };
  const comp = { beat: 21, row: 2, type: 0, _x: COL(12), _comp: true };
  const orb  = { beat: 21.5, row: 2, type: 1, _x: COL(3), _orbit: 'parallel' };
  const notes = [rail, comp, orb, ...stream()];
  const snap = structuredClone(notes);
  G.applyObstacleChoreo(notes, [W('crouch', { aerobic: true })]);
  assert.deepEqual(notes, snap);
  G.applyObstacleChoreo(notes, [W('crouch')]);
  assert.deepEqual([notes[0], notes[1], notes[2]], [snap[0], snap[1], snap[2]]);
});

test('notes in two walls\' windows at once are left to the clamps', () => {
  const walls = [W('leanLeft'), { beat: 23, duration: 1, wallType: 'leanRight' }];   // windows overlap 21-24
  const notes = stream(), snap = structuredClone(notes);
  G.applyObstacleChoreo(notes, walls);
  notes.forEach((n, i) => { if (n.beat >= 21 && n.beat < 24) assert.deepEqual(n, snap[i], `beat ${n.beat}`); });
});

test('buildSwoopRail: enters at the band top, deepest under the bar centre, back to the top; on grid; capped length', () => {
  for (const [dur, snap] of [[2, 0.25], [4, 0.25], [3, 1 / 3], [2, 0.5]]) {
    const w = { beat: 40, duration: dur, wallType: 'crouch' };
    for (const hand of [0, 1]) {
      const r = G.buildSwoopRail(w, hand, snap);
      assert.equal(r.beat, 39); assert.equal(r.railEndBeat, 40 + dur + 1);
      assert.equal(r.row, 4); assert.equal(r.railEndRow, 4);
      const pts = [{ beat: r.beat, row: r.row }, ...r.railSegments, { beat: r.railEndBeat, row: r.railEndRow }];
      for (let i = 1; i < pts.length; i++) assert.ok(pts[i].beat > pts[i - 1].beat, 'beats increase');
      for (const p of r.railSegments) {
        assert.ok(Math.abs(p.beat * Math.round(1 / snap) - Math.round(p.beat * Math.round(1 / snap))) < 1e-9, `off grid ${p.beat}`);
        assert.ok(p.row >= 4 && p.row <= 7, `row ${p.row} outside the crouch band`);
      }
      const deepest = r.railSegments.reduce((a, p) => (p.row > a.row ? p : a));
      assert.equal(deepest.row, 7);
      assert.ok(Math.abs(deepest.beat - (40 + dur / 2)) <= 1, `deepest at ${deepest.beat}, bar centre ${40 + dur / 2}`);
      const z = G.handZoneCols(hand);
      for (const p of r.railSegments) assert.ok(colOf(p._x) >= z.colMin && colOf(p._x) <= z.colMax);
      assert.ok(r.railSegments.length <= 12);
    }
  }
  const capped = G.buildSwoopRail({ beat: 40, duration: 4, wallType: 'crouch' }, 0, 0.25, { maxBeats: 4 });
  assert.equal(capped.railEndBeat - capped.beat, 4);
  assert.equal((capped.beat + capped.railEndBeat) / 2, 42, 'still centred on the bar');
});

test('clearGoldC2: a swoop rail under a crouch keeps its rail; a gold orb beside it becomes the other hand\'s orb', () => {
  const C = load([...RAIL_DEPS, 'C2_BEAT_EPS', 'clearGoldC2']);
  const swoop = G.buildSwoopRail({ beat: 40, duration: 2, wallType: 'crouch' }, 0, 0.25);
  const gold  = { beat: 41.5, row: 5, type: 3, _x: COL(7) };
  const notes = [swoop, gold];
  assert.equal(C.clearGoldC2(notes), 1);
  assert.equal(swoop.railEndBeat, 43, 'the swoop is still a rail');
  assert.equal(gold.type, 1, 'the gold became a left-hand orb');
  const z = G.handZoneCols(1);
  assert.ok(colOf(gold._x) >= z.colMin && colOf(gold._x) <= z.colMax);
  assert.equal(C.clearGoldC2(notes), 0, 'nothing left to clear');
  // the same gold beside an ordinary rail still strips that rail (unchanged rule)
  const plain = { beat: 40, row: 5, type: 0, _x: COL(10), railEndBeat: 43, railEndRow: 5, railEnd_x: COL(10), railSegments: [] };
  C.clearGoldC2([plain, { beat: 41.5, row: 5, type: 3, _x: COL(7) }]);
  assert.equal(plain.railEndBeat, undefined);
  // the other hand already has a note on that beat: never two left-hand notes on one beat (here the
  // existing C2 rule removes the left orb beside the gold first, then the gold converts)
  const sw2 = G.buildSwoopRail({ beat: 40, duration: 2, wallType: 'crouch' }, 0, 0.25);
  const n2 = [sw2, { beat: 41.5, row: 5, type: 3, _x: COL(7) }, { beat: 41.5, row: 6, type: 1, _x: COL(3) }];
  C.clearGoldC2(n2);
  assert.equal(sw2.railEndBeat, 43);
  assert.equal(n2.filter(n => n.type === 1 && n.beat === 41.5).length, 1);
  assert.equal(n2.filter(n => n.type === 3).length, 0);
});
