// Obstacle comfort reach (2026-11-22): during a crouch, notes stay in rows 4-7 under the bar.
// During a lean, every hand stays in the lean's band and out of the floor rows. Rails follow
// the same rule as free orbs. Aerobic mode switches the rule off and restores the old placement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { appSource, extract, load, withSeed, ROOT, RAIL_DEPS, colOf } from './harness.mjs';

const REACH = ['OBS_AEROBIC_REACH', 'OBS_REACH', 'obstacleReachBand', 'obstacleReachAt',
  'obstacleReachClamp', 'clampNotesToObstacleReach', 'railPosAt', 'fitAxisToBounds', 'fitRailToReach', 'clampRailsToObstacles'];
const G = load([...RAIL_DEPS, ...REACH]);
const Y_OFFSET = 0.0012;                      // export offset (server.py / exportBtn)
const LL = { beat: 20, duration: 2, wallType: 'leanLeft' };
const LR = { beat: 20, duration: 2, wallType: 'leanRight' };
const CR = { beat: 20, duration: 2, wallType: 'crouch' };
const S0 = { beat: 20, duration: 2, wallType: 'slide', slideType: 0 };
const S4 = { beat: 20, duration: 2, wallType: 'slide', slideType: 4 };
const inWall = (w, col, row) => {
  const lim = G.obstacleColLimit(w, row);
  return !!lim && ((lim.maxCol !== undefined && col > lim.maxCol) || (lim.minCol !== undefined && col < lim.minCol));
};

test('crouch band: the whole grid is under the bar, rows 0-3 stay blocked, rows 8+ are the floor reach', () => {
  const barUnderside = (G.OBS_BOX.crouch.y - G.OBS_BOX.crouch.h / 2) / G.P3D.y;     // game units
  assert.ok(barUnderside > G.ROW_Y[0] + Y_OFFSET, `bar ${barUnderside} cuts into row 0`);
  assert.deepEqual(G.OBS_REACH.crouch, { minRow: 4, maxRow: 7 });
  assert.ok(G.ROW_Y[G.OBS_REACH.crouch.minRow] < G.ROW_Y[3]);                         // C6 rows 0-3 excluded
  assert.ok(G.ROW_Y[G.OBS_REACH.crouch.maxRow + 1] + Y_OFFSET <= -0.40);              // row 8 = 0.41 below centre
  // The 3D preview draws every wall from this same table.
  assert.match(appSource(), /isCr \? OBS_BOX\.crouch : isCtr \? OBS_BOX\.center/);
});

test('every lean / slide comfort cell lies outside the wall volume (the band is inside the geometry)', () => {
  for (const w of [LL, LR, S0, S4]) for (let type = 0; type <= 3; type++) {
    const b = G.obstacleReachBand(w, type);
    assert.ok(b, `${w.wallType} type ${type}: no band`);
    if (b.minCol === 0 && b.maxCol === 14) continue;   // no lateral rule (a slide's free hand): geometry clamp only
    for (let row = b.minRow; row <= b.maxRow; row++)
      for (let col = b.minCol; col <= b.maxCol; col++)
        assert.ok(!inWall(w, col, row), `${w.wallType}/${w.slideType} type ${type}: (${col},${row}) is inside the wall`);
  }
});

test('lean and slide bands mirror across centre; leans cap rows at 7, slides do not', () => {
  const mirror = b => ({ ...b, minCol: 14 - b.maxCol, maxCol: 14 - b.minCol });
  const swap = t => (t === 0 ? 1 : t === 1 ? 0 : t);
  for (const [a, b] of [[LL, LR], [S0, S4]]) for (let t = 0; t <= 3; t++)
    assert.deepEqual(G.obstacleReachBand(b, swap(t)), mirror(G.obstacleReachBand(a, t)));
  // The bands applyObstacleOcclusion has always used for free orbs (leanLeft: right 6-8, left 2-5, gold/green 5-8).
  assert.deepEqual([0, 1, 2, 3].map(t => { const b = G.obstacleReachBand(LL, t); return [b.minCol, b.maxCol, b.maxRow]; }),
    [[6, 8, 7], [2, 5, 7], [5, 8, 7], [5, 8, 7]]);
  assert.equal(G.obstacleReachBand(S0, 1).maxRow, 10);
  assert.deepEqual([G.obstacleReachBand(S0, 1).minCol, G.obstacleReachBand(S0, 1).maxCol], [0, 14]);   // free hand unconstrained
});

test('aerobic: off by default; an aerobic wall (or a centre slide) sets no comfort rule', () => {
  assert.equal(G.OBS_AEROBIC_REACH, false);
  for (const w of [LL, LR, CR, S0, S4]) assert.equal(G.obstacleReachBand({ ...w, aerobic: true }, 0), null);
  assert.equal(G.obstacleReachBand({ beat: 20, duration: 2, wallType: 'slide', slideType: 3 }, 0), null);
});

test('obstacleReachAt uses the occlusion window: lead-in before, buffer after, end exclusive', () => {
  const at = b => G.obstacleReachAt([CR], b, 0);
  assert.equal(at(17.99), null);
  assert.equal(at(18).maxRow, 7);                // 2-beat lead-in
  assert.equal(at(23.99).maxRow, 7);             // wall ends at 22, 2-beat buffer
  assert.equal(at(24), null);
  // A crouch and a lean overlapping: both rules apply at once.
  const box = G.obstacleReachAt([CR, LL], 21, 0);
  assert.deepEqual(box, { minCol: 6, maxCol: 8, minRow: 4, maxRow: 7 });
  // Opposite leans invert the right hand's column range (6-8 vs 9-12): collapse to one column,
  // and the clamp still never leaves the point inside a wall.
  const both = G.obstacleReachAt([LL, LR], 21, 0);
  assert.equal(both.minCol, both.maxCol);
  for (let row = 0; row <= 7; row++) {
    const p = G.obstacleReachClamp([LL, LR], 21, 0, 14, row);
    assert.ok(!inWall(LL, p.col, p.row) && !inWall(LR, p.col, p.row), `row ${row}: col ${p.col} inside a wall`);
  }
});

test('free orbs: nearest-edge clamp into the band, untouched outside the window or when aerobic', () => {
  const COL = c => G.COL_X[c];
  const mk = () => [
    { beat: 21, row: 8, type: 0, _x: COL(10) },        // crouch, floor reach -> row 7
    { beat: 21.5, row: 2, type: 1, _x: COL(3) },       // crouch, above the ducked head -> row 4
    { beat: 30, row: 9, type: 0, _x: COL(10) },        // outside every window: untouched
    { beat: 21, row: 5, type: 0, _x: COL(9), railEndBeat: 24 },   // rails are clampRailsToObstacles' job
  ];
  const n = mk();
  assert.equal(G.clampNotesToObstacleReach(n, [CR]).moved, 2);
  assert.deepEqual(n.map(x => [x.row, colOf(x._x)]), [[7, 10], [4, 3], [9, 10], [5, 9]]);
  const a = mk();
  assert.equal(G.clampNotesToObstacleReach(a, [{ ...CR, aerobic: true }]).moved, 0);
  assert.deepEqual(a, mk());
  // leanRight: the lean-side (right) hand at the far edge comes in to col 12, the side the old
  // band never checked; a floor row comes up to 7. leanLeft: the wall-side hand comes in to col 8.
  const l = [{ beat: 21, row: 9, type: 0, _x: COL(14) }];
  G.clampNotesToObstacleReach(l, [LR]);
  assert.deepEqual([l[0].row, colOf(l[0]._x)], [7, 12]);
  const r = [{ beat: 21, row: 5, type: 0, _x: COL(11), _comp: true }];
  G.clampNotesToObstacleReach(r, [LL]);
  assert.equal(colOf(r[0]._x), 8);
  assert.equal(G.clampNotesToObstacleReach([{ beat: 21, row: 5, type: 0, _x: COL(11), _comp: true }], [LL], { skipComps: true }).moved, 0);
});

test('rails: the whole path through a crouch window stays in rows 4-7, edges included; aerobic is untouched', () => {
  const COL = c => G.COL_X[c];
  const mk = () => [{ beat: 17, row: 2, type: 0, _x: COL(10), railEndBeat: 27, railEndRow: 9, railEnd_x: COL(10),
    railSegments: [17.5, 19, 20, 21, 22, 23, 24, 26].map((beat, i) => ({ beat, row: [1, 2, 9, 1, 8, 3, 9, 1][i], _x: COL(10) })) }];
  const [rail] = mk();
  G.clampRailsToObstacles([rail], [CR]);
  // Sample the continuous path (linear between points), not only the authored points: the
  // stretches entering at 18 (from row 1) and leaving at 24 (toward row 9) are what used to leak.
  for (let b = 18; b <= 24 + 1e-9; b += 0.05) {
    const r = G.railPosAt(rail, b).row;
    assert.ok(r >= 4 - 1e-9 && r <= 7 + 1e-9, `beat ${b.toFixed(2)}: path at row ${r.toFixed(2)}`);
  }
  assert.ok(rail.railSegments.some(s => s.beat === 18), 'no edge point pinned at the lead-in');
  const outsidePts = [{ beat: rail.beat, row: rail.row }, ...rail.railSegments, { beat: rail.railEndBeat, row: rail.railEndRow }]
    .filter(p => p.beat < 18 || p.beat > 24);
  assert.deepEqual(outsidePts.map(p => p.row), [2, 1, 1, 9]);                          // untouched
  const [old] = mk();
  G.clampRailsToObstacles([old], [{ ...CR, aerobic: true }]);
  assert.deepEqual(old, mk()[0]);
});

test('rails: a rail entering a slide window from the box side no longer cuts through the box', () => {
  const COL = c => G.COL_X[c];
  // Right-hand rail at col 12 until beat 17, then at col 7: the straight stretch from 17 to 19
  // used to cross the slide box (cols 8-14 at every row) during the lead-in from beat 18.
  const rail = { beat: 16, row: 5, type: 0, _x: COL(12), railEndBeat: 23, railEndRow: 5, railEnd_x: COL(7),
    railSegments: [{ beat: 17, row: 5, _x: COL(12) }, { beat: 19, row: 5, _x: COL(7) }, { beat: 21, row: 5, _x: COL(7) }] };
  G.clampRailsToObstacles([rail], [S0]);
  for (let b = 18; b <= 23; b += 0.05) {
    const c = colOf(G.railPosAt(rail, b)._x);
    assert.ok(!inWall(S0, c, 5), `beat ${b.toFixed(2)}: col ${c} is inside the slide box`);
  }
});

test('rails: the wall-side hand is held off the leaning wall\'s underside (band, not just geometry)', () => {
  const COL = c => G.COL_X[c];
  const rail = () => ({ beat: 19, row: 5, type: 0, _x: COL(11), railEndBeat: 23, railEndRow: 6, railEnd_x: COL(12),
    railSegments: [{ beat: 20, row: 5, _x: COL(12) }, { beat: 21, row: 8, _x: COL(11) }, { beat: 22, row: 4, _x: COL(10) }] });
  const now = rail();
  G.clampRailsToObstacles([now], [LL]);
  // Since fitRailToReach (2026-11-24) the in-window stretch moves AS A WHOLE: cols 11-12-11-10-12
  // shift 4 into the 6-8 band (they used to collapse onto col 8), rows shift up 1 so the row-8
  // point reaches 7 (the lean's row cap) and the shape keeps its 4-row dip.
  assert.deepEqual([colOf(now._x), ...now.railSegments.map(s => colOf(s._x)), colOf(now.railEnd_x)], [7, 8, 7, 6, 8]);
  assert.deepEqual([now.row, ...now.railSegments.map(s => s.row), now.railEndRow], [4, 4, 7, 3, 5]);
  // Aerobic: only the wall's own limit applies (old behaviour), so the rail can hug the underside.
  const old = rail();
  G.clampRailsToObstacles([old], [{ ...LL, aerobic: true }]);
  const lim = r => G.obstacleColLimit(LL, r).maxCol;
  assert.deepEqual(old.railSegments.map(s => colOf(s._x)), [Math.min(12, lim(5)), Math.min(11, lim(8)), Math.min(10, lim(4))]);
  assert.ok(colOf(old._x) > 8, 'aerobic rail no longer reaches past the comfort band');
});

test('rails keep their shape through a comfort window: shifted and scaled as a whole, not flattened per point', () => {
  const COL = c => G.COL_X[c];
  // A zigzag swinging rows 2-6 entirely inside a crouch window (rows 4-7): the per-point clamp
  // gave 4-6-4-6-4 (2 rows). Fitted, it scales 0.75 into 4-7-4-7-4 (the band's full 3 rows).
  const zz = { beat: 19, row: 2, type: 0, _x: COL(10), railEndBeat: 23, railEndRow: 2, railEnd_x: COL(10),
    railSegments: [{ beat: 20, row: 6, _x: COL(10) }, { beat: 21, row: 2, _x: COL(10) }, { beat: 22, row: 6, _x: COL(10) }] };
  G.clampRailsToObstacles([zz], [CR]);
  assert.deepEqual([zz.row, ...zz.railSegments.map(s => s.row), zz.railEndRow], [4, 7, 4, 7, 4]);
  // The wall-side hand swinging cols 9-13 during a leanLeft (its band is cols 6-8): every point
  // sat past the band, so the clamp put the whole rail on col 8. Fitted, it still swings 6-8.
  const sw = { beat: 19, row: 5, type: 0, _x: COL(9), railEndBeat: 23, railEndRow: 5, railEnd_x: COL(13),
    railSegments: [{ beat: 20, row: 5, _x: COL(13) }, { beat: 21, row: 5, _x: COL(9) }, { beat: 22, row: 5, _x: COL(13) }] };
  G.clampRailsToObstacles([sw], [LL]);
  assert.deepEqual([colOf(sw._x), ...sw.railSegments.map(s => colOf(s._x)), colOf(sw.railEnd_x)], [6, 8, 6, 8, 8]);
  // Fitting is a no-op for a rail already inside its boxes, and for aerobic walls.
  const fine = { beat: 19, row: 5, type: 0, _x: COL(10), railEndBeat: 23, railEndRow: 6, railEnd_x: COL(10),
    railSegments: [{ beat: 21, row: 7, _x: COL(10) }] };
  assert.equal(G.fitRailToReach(structuredClone(fine), [CR]), 0);
  assert.equal(G.fitRailToReach(structuredClone(zz), [{ ...CR, aerobic: true }]), 0);
});

test('fitAxisToBounds: rigid shift when it fits, largest scale when it does not, null when boxes are disjoint', () => {
  assert.deepEqual(G.fitAxisToBounds([1, 3, 1], [4, 4, 4], [7, 7, 7]), [4, 6, 4]);          // shift only
  assert.deepEqual(G.fitAxisToBounds([0, 8, 0], [4, 4, 4], [7, 7, 7]), [4, 7, 4]);          // scale 3/8
  assert.deepEqual(G.fitAxisToBounds([5, 5], [4, 4], [7, 7]), [5, 5]);                      // already inside
  assert.equal(G.fitAxisToBounds([5, 5], [0, 6], [3, 9]), null);                            // no common row
});

// ── The real pipeline: onsetsToNotes on a 4-stem song with crouch and lean walls ─────────────
function closure(src, roots) {
  const names = new Set();
  for (const l of src.split(/\r?\n/)) {
    const m = l.match(/^(?:async\s+)?function ([A-Za-z_$][\w$]*)\(|^(?:const|let) ([A-Za-z_$][\w$]*)\s*=/);
    if (m) names.add(m[1] || m[2]);
  }
  const decl = new Map();
  for (const n of names) { try { decl.set(n, extract(src, n)); } catch { /* not loadable */ } }
  const want = new Set(roots), queue = [...roots];
  while (queue.length) {
    const text = decl.get(queue.pop());
    for (const tok of new Set(text.match(/[A-Za-z_$][\w$]*/g)))
      if (decl.has(tok) && !want.has(tok)) { want.add(tok); queue.push(tok); }
  }
  const order = [...want].sort((a, b) => src.indexOf(decl.get(a)) - src.indexOf(decl.get(b)));
  return new Function(`${order.map(n => decl.get(n)).join('\n')}\nreturn { ${roots.join(', ')} };`)();
}
// BASE = the last commit before the comfort-reach rule. Aerobic mode must reproduce it exactly.
// If a later change MEANS to alter this song's output, re-pin BASE to that commit and say so.
// Re-pinned 99ee4f3 -> ab9e2f1 ([Orbit] circles): main @ 99ee4f3 merged with the orbit work, so
// still everything except the comfort-reach rule.
// Re-pinned ab9e2f1 -> 3d387b1 (stem density, 2026-11-23): ab9e2f1 merged with the density work,
// so again everything except the comfort-reach rule.
// Re-pinned 3d387b1 -> c0777cb (Orbit C3 edge anchors, 2026-11-24): 3d387b1 plus that fix, so
// again everything except the comfort-reach rule.
// Re-pinned c0777cb -> e421a8e (rail shape fidelity, 2026-11-24): c0777cb plus the 1f535b0 rail
// geometry, nothing else.
// Re-pinned -> b6f1f66 (obstacle choreography, 2026-11-24), shared by tests/swing and tests/obstacles:
// c0777cb (everything before the comfort-reach rule) + the rail-shape fidelity + the parts of d75efb1 that
// act in aerobic mode (swoop rails, the orbit same-cell nudge, the gold-C2 swoop priority) + e7f5dfa
// (dedup-removed rails release companions). e7f5dfa was a no-op for these songs until swoop rails
// existed; without it the random band picks in a lean window diverged. [ObstacleChoreo] and
// fitRailToReach are no-ops for aerobic walls, so they are not in the base.
// Re-pinned b6f1f66 -> 93fca8b (lyric walls, 2026-11-26), tests/obstacles only: b6f1f66 + lyric walls
// outranking auto walls in the spacing dedup and the hold-merge. This file's fixture carries lyric
// cues (tests/swing's songs do not, so it keeps b6f1f66). Merged into lyric-choreo with -s ours.
const BASE = '93fca8b';
const ROOTS = ['onsetsToNotes', '_detectC1Count', 'clampC3Jumps', 'obstacleReachBand', 'obstacleSide'];
const NOW = closure(appSource(), ROOTS);
const OLD = closure(execSync(`git show ${BASE}:synthriders-creator.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString(), ['onsetsToNotes']);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function song(seed, { bpm = 110, beats = 224 } = {}) {
  const r = rng(seed), bps = bpm / 60, T = b => b / bps;
  const drums = [], bass = [], other = [], vocals = [], oreg = [], vreg = [];
  for (let b = 0; b < beats; b++) {
    drums.push({ time: T(b), energy: 0.9, subtype: b % 2 ? 'snare' : 'kick' });
    for (const p of [0.25, 0.5, 0.75]) if (r() < 0.6) drums.push({ time: T(b + p), energy: 0.4, subtype: 'hat' });
    if (r() < 0.8) bass.push({ time: T(b), energy: 0.7 });
    if (r() < 0.6) bass.push({ time: T(b + 0.5), energy: 0.5 });
    if (r() < 0.5) other.push({ time: T(b + 0.25), energy: 0.5 });
    if (b % 8 === 0) { vocals.push({ time: T(b), energy: 0.6, pitch_row: 2 + (b % 7) }); vreg.push({ start: T(b), end: T(b + 3), energy: 0.6 }); }
    if (b % 16 === 4) { other.push({ time: T(b), energy: 0.6 }); oreg.push({ start: T(b), end: T(b + 5), energy: 0.5 }); }
  }
  const analysis = { bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [],
    energyCurve: Array.from({ length: beats }, (_, b) => 0.45 + 0.4 * Math.abs(Math.sin(b / 23))),
    duration: T(beats), panningByBeat: null,
    stemData: { drums: { onsets: drums, regions: [] }, bass: { onsets: bass, regions: [] },
                other: { onsets: other, regions: oreg }, vocals: { onsets: vocals, regions: vreg } } };
  const names = ['intro', 'verse', 'chorus', 'verse 2', 'chorus 2', 'bridge', 'outro'];
  const sections = names.map((name, i) => ({ name, startBeat: i * 32, endBeat: (i + 1) * 32, avgRow: 5,
    rowVariance: 3, rowContour: 'plateau', noteStyle: 'alternating-flow', handMode: 'alternating',
    density: 0.8, climax: name.startsWith('chorus') }));
  // Lyric cues pin a known set of crouches and leans (the lyric path places walls exactly here).
  const lyricCues = [24, 56, 88, 120, 152, 184].map(beat => ({ beat, action: 'crouch', lyric: 'get down' }))
    .concat([40, 104, 168].map(beat => ({ beat, action: 'leanLeft', lyric: 'lean left' })))
    .concat([72, 136, 200].map(beat => ({ beat, action: 'leanRight', lyric: 'lean right' })));
  return { analysis, sections, bpm, hints: { lyricCues } };
}
function run(lib, s, seed, extra = {}) {
  const quiet = ['log', 'warn', 'debug', 'error', 'info'].map(k => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  globalThis.window = {};
  try {
    return withSeed(seed, () => lib.onsetsToNotes(structuredClone(s.analysis), s.bpm, 9,
      structuredClone(s.sections), structuredClone({ ...s.hints, ...extra })));
  } finally { for (const [k, f] of quiet) console[k] = f; delete globalThis.window; }
}
// Every authored point during a wall's window: orbs, companions, rail heads, waypoints, ends.
function windowPoints(notes, w) {
  const a = w.beat - 2, b = w.beat + w.duration + 2, out = [];
  const add = (beat, row, x, type, kind) => { if (beat >= a && beat < b) out.push({ beat, row, col: colOf(x ?? 0), type, kind }); };
  for (const n of notes) {
    add(n.beat, n.row, n._x, n.type, n.railEndBeat != null ? 'head' : n._comp ? 'comp' : 'orb');
    if (n.railEndBeat == null) continue;
    for (const s of n.railSegments || []) add(s.beat, s.row, s._x, n.type, 'rail');
    if (n.railEnd_x !== undefined) add(n.railEndBeat, n.railEndRow ?? n.row, n.railEnd_x, n.type, 'rail');
  }
  return out;
}
// Points outside their comfort box, scored against the default (non-aerobic) rule.
function outside(res) {
  const bad = [];
  for (const w of res.walls) {
    const plain = { ...w, aerobic: false };
    for (const p of windowPoints(res.notes, w)) {
      const box = NOW.obstacleReachBand(plain, p.type);
      if (!box) continue;
      if (p.row < box.minRow || p.row > box.maxRow || p.col < box.minCol || p.col > box.maxCol)
        bad.push({ wall: w.wallType, ...p, box });
    }
  }
  return bad;
}

const SONGS = [song(11), song(23)];
for (const [i, s] of SONGS.entries()) {
  for (const seed of [3, 8]) {
    test(`onsetsToNotes song ${i} seed ${seed}: crouch and lean windows hold the comfort band; C1/C3 stay clean`, () => {
      const res = run(NOW, s, seed);
      const ctrl = run(NOW, s, seed, { aerobicReach: true });
      const kinds = new Set(res.walls.map(w => w.wallType));
      assert.ok(kinds.has('crouch') && kinds.has('leanLeft') && kinds.has('leanRight'), [...kinds].join());
      // The control must break the rule, or this test proves nothing.
      assert.ok(outside(ctrl).length > 0, 'aerobic control never left the comfort band');
      const bad = outside(res);
      // Crouches and every rail point: exact.
      assert.deepEqual(bad.filter(p => p.wall === 'crouch' || p.kind === 'rail' || p.kind === 'head'), []);
      // Leans, orbs and companions: no floor rows at all. A lateral edge case can remain where the
      // final clampC3Jumps pulls an orb one column toward a neighbour outside the window.
      assert.deepEqual(bad.filter(p => p.row > p.box.maxRow), []);
      const lean = res.walls.filter(w => w.wallType !== 'crouch').flatMap(w => windowPoints(res.notes, w));
      assert.ok(bad.length <= Math.max(1, lean.length * 0.02), `${bad.length}/${lean.length} lean points off-band`);
      assert.equal(NOW._detectC1Count(res.notes), 0);
      assert.deepEqual(NOW.clampC3Jumps(structuredClone(res.notes), s.bpm / 60), { clamped: 0, stuck: 0 });
      assert.equal(res.notes.length, ctrl.notes.length, 'the rule moves notes, it never adds or drops one');
    });
  }
  test(`onsetsToNotes song ${i}: aerobic reach reproduces the pre-rule placement exactly (${BASE})`, () => {
    const a = run(NOW, s, 5, { aerobicReach: true }), b = run(OLD, s, 5);
    assert.ok(a.walls.length > 0 && a.walls.every(w => w.aerobic === true));
    // lyricCues (the aligned cues returned for the critic's lyric report) is not in BASE.
    const { lyricCues, ...rest } = a;
    assert.equal(lyricCues?.length, 12);
    assert.deepEqual({ ...rest, walls: rest.walls.map(({ aerobic, ...w }) => w) }, b);
  });
}

test('the Advanced toggle reaches onsetsToNotes as hints.aerobicReach', () => {
  const src = appSource();
  assert.match(src, /<input type="checkbox" id="settAerobicReach"/);
  assert.match(extract(src, 'onsetsToNotes'), /hints\.aerobicReach/);
  assert.match(src, /aerobicReach:\s+document\.getElementById\('settAerobicReach'\)\?\.checked\s+\|\| OBS_AEROBIC_REACH/);
});
