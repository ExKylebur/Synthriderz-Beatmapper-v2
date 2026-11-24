// [Orbit] circular two-hand phrases, on the REAL declarations in the app.
// Unit tests drive applyOrbitPhrases directly; the integration tests run the whole onsetsToNotes
// (every post-pass) and measure the circles that come OUT, against the pre-orbit commit (OLD).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { ROOT, appSource, extract, load, withSeed, colOf } from './harness.mjs';

const O = load(['COL_X', 'OBSTACLE_BUFFER_BEATS', 'OBSTACLE_LEAD_BEATS', 'CROSS_REACH_COLS', 'handZoneCols',
  'isPattern', 'smoothPatternBoundaries', 'ORBIT_VARIANTS', 'ORBIT_GEOM', 'ORBIT_PERIODS', 'ORBIT_NPR',
  'ORBIT_NPR_MIN', 'ORBIT_NPR_MAX', 'ORBIT_TURN_SEC_MIN', 'ORBIT_TURN_SEC_MAX', 'ORBIT_MIN_TURNS',
  'ORBIT_MAX_TURNS', 'ORBIT_MIN_NOTES', 'ORBIT_JOIN_GAP', 'ORBIT_SPACING', 'ORBIT_MAX_SHARE',
  'orbitPoint', 'orbitPeriods', 'applyOrbitPhrases']);

// ── circularity metric (the one used for the before/after numbers) ──────────────────────
// Kasa least-squares circle through the points (col, row: equal steps in game units), then:
// R, radial spread cv = std(r)/mean(r), turns = |sum of wrapped angle steps| / 2π, mono = share
// of steps turning the same way, maxStep = largest single angle step.
function circle(pts) {
  const n = pts.length;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (const [x, y] of pts) { const z = x * x + y * y; Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; Sxz += x * z; Syz += y * z; Sz += z; }
  const A = [[Sxx, Sxy, Sx, -Sxz], [Sxy, Syy, Sy, -Syz], [Sx, Sy, n, -Sz]];
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return { R: 0, cv: 1, turns: 0, mono: 0, maxStep: Math.PI, n };
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k]; }
  }
  const D = A[0][3] / A[0][0], E = A[1][3] / A[1][1], F = A[2][3] / A[2][2];
  const cx = -D / 2, cy = -E / 2, R = Math.sqrt(Math.max(0, cx * cx + cy * cy - F));
  const r = pts.map(([x, y]) => Math.hypot(x - cx, y - cy)), mr = r.reduce((a, b) => a + b, 0) / n;
  const cv = Math.sqrt(r.reduce((a, b) => a + (b - mr) ** 2, 0) / n) / (mr || 1);
  const th = pts.map(([x, y]) => Math.atan2(y - cy, x - cx)), d = [];
  for (let i = 1; i < n; i++) { let v = th[i] - th[i - 1]; while (v > Math.PI) v -= 2 * Math.PI; while (v <= -Math.PI) v += 2 * Math.PI; d.push(v); }
  const tot = d.reduce((a, b) => a + b, 0), sg = Math.sign(tot) || 1;
  return { n, R, cv, turns: Math.abs(tot) / (2 * Math.PI), mono: d.filter(v => Math.sign(v) === sg && Math.abs(v) > 0.05).length / d.length,
           maxStep: Math.max(...d.map(Math.abs)) };
}
// A circle a player can recognise in VR: >= 6 notes of >= 3/4 turn, round, one direction, real size.
const readable = m => m.n >= 6 && m.R >= 2 && m.R <= 6 && m.cv <= 0.3 && m.mono >= 0.8 && m.turns >= 0.75 && m.maxStep <= 1.75;

// ── unit: geometry and period ────────────────────────────────────────────────────────────
test('orbitPoint: parallel hands stay 7 columns apart on one row; mirror keeps >= 3 columns at the inner point', () => {
  for (let k = 0; k < 64; k++) {
    const th = k / 64 * 2 * Math.PI;
    const [rc, rr] = O.orbitPoint('parallel', 0, th, 5, 3), [lc, lr] = O.orbitPoint('parallel', 1, th, 5, 3);
    assert.ok(Math.abs(rc - lc - 7) < 1e-9 && Math.abs(rr - lr) < 1e-9);
    assert.ok(Math.abs(Math.hypot(rc - 10.5, rr - 5) - 3) < 1e-9, 'parallel is a true circle, radius 3');
    const [mR] = O.orbitPoint('mirror', 0, th, 5, 3), [mL] = O.orbitPoint('mirror', 1, th, 5, 3);
    assert.ok(Math.abs((mR - 7) - (7 - mL)) < 1e-9, 'mirror images about the centre column');
    assert.ok(Math.round(mR) - Math.round(mL) >= 3, `mirror hands ${Math.round(mL)} / ${Math.round(mR)}`);
    for (const v of O.ORBIT_VARIANTS) for (const h of [0, 1]) {
      const [c, r] = O.orbitPoint(v, h, th, 5, 3), z = O.handZoneCols(h);
      assert.ok(Math.round(c) >= z.colMin && Math.round(c) <= z.colMax, `${v} hand ${h} col ${c}`);
      assert.ok(Math.round(r) >= 2 && Math.round(r) <= 8);
    }
  }
});

test('orbitPeriods: notes per turn near 10, a turn between 1.6 and 6 s, ties to the shorter period', () => {
  const ok = (gap, bps) => O.orbitPeriods(gap, bps).every(P => P / gap >= 6 && P / gap <= 16 && P / bps >= 1.6 && P / bps <= 6);
  assert.deepEqual(O.orbitPeriods(0.5, 102.86 / 60), [4, 6, 3, 8]);   // 16ths alternating: a bar per turn, 8 notes
  assert.deepEqual(O.orbitPeriods(0.25, 2), [4]);                     // 2 beats would be a 1 s flail
  assert.deepEqual(O.orbitPeriods(2, 2), [12]);                       // Easy: 6 notes over 6 s
  assert.deepEqual(O.orbitPeriods(3, 2), []);
  for (const g of [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2]) for (const bpm of [80, 100, 120, 160, 190]) assert.ok(ok(g, bpm / 60));
});

// ── unit: applyOrbitPhrases on note streams ──────────────────────────────────────────────
// Both hands every `per` beats, offset by half that (so the any-hand gap is per/2).
const stream = (a, b, per = 0.5) => {
  const out = [];
  for (let t = a; t < b - 1e-9; t += per) {
    out.push({ beat: t, type: 0, _x: O.COL_X[10], row: 5 });
    out.push({ beat: t + per / 2, type: 1, _x: O.COL_X[4], row: 5 });
  }
  return out;
};
const hands = notes => [0, 1].map(h => notes.filter(n => n.type === h && n._orbit).sort((a, b) => a.beat - b.beat));
const pts = hn => hn.map(n => [colOf(n._x), n.row]);

test('a clean 16th stream becomes full circles: round, one way, radius ~3, in zone, no C3 step', () => {
  const notes = stream(0, 12);
  const res = O.applyOrbitPhrases(notes, { bps: 2, maxShare: 1 });
  assert.equal(res.phrases, 1);
  assert.equal(res.tagged, notes.length);
  for (const [h, hn] of hands(notes).entries()) {
    const m = circle(pts(hn));
    assert.ok(readable(m), `hand ${h}: ${JSON.stringify(m)}`);
    assert.ok(m.turns >= 2.5 && m.R >= 2.6 && m.R <= 3.4 && m.cv < 0.15, JSON.stringify(m));
    const z = O.handZoneCols(h);
    for (let i = 0; i < hn.length; i++) {
      const c = colOf(hn[i]._x);
      assert.ok(c >= z.colMin && c <= z.colMax && hn[i].row >= 2 && hn[i].row <= 8);
      assert.ok(hn[i]._preSweep, 'demotion snapshot');
      if (i) assert.ok(Math.abs(c - colOf(hn[i - 1]._x)) <= 7 && Math.abs(hn[i].row - hn[i - 1].row) <= 5);
    }
  }
});

test('walls: never inside a lean/slide occlusion window; a phrase under a crouch keeps to rows 4+', () => {
  const lead = O.OBSTACLE_LEAD_BEATS, buf = O.OBSTACLE_BUFFER_BEATS;
  for (const wallType of ['leanLeft', 'leanRight', 'slide']) {
    const notes = stream(0, 24);
    O.applyOrbitPhrases(notes, { walls: [{ beat: 6, duration: 1, wallType, slideType: 0 }], bps: 2, maxShare: 1 });
    const orb = notes.filter(n => n._orbit);
    assert.ok(orb.length > 20, `${wallType}: ${orb.length} orbit notes`);
    assert.deepEqual(orb.filter(n => n.beat >= 6 - lead && n.beat <= 7 + buf).map(n => n.beat), [], wallType);
  }
  const notes = stream(0, 12);
  O.applyOrbitPhrases(notes, { walls: [{ beat: 6, duration: 2, wallType: 'crouch' }], bps: 2, maxShare: 1 });
  const orb = notes.filter(n => n._orbit);
  assert.equal(orb.length, notes.length, 'a crouch does not block the phrase');
  assert.ok(orb.every(n => n.row >= 4 && n.row <= 8), 'the whole phrase sits under the crouch bar');
  for (const hn of hands(notes)) assert.ok(readable(circle(pts(hn))), JSON.stringify(circle(pts(hn))));
});

test('rails, gold and green: no orbit note within a beat of them', () => {
  const notes = stream(0, 40);
  notes.push({ beat: 9, type: 3, _x: 0, row: 5 }, { beat: 25, type: 2, _x: 0, row: 5 },
             { beat: 31, type: 0, _x: O.COL_X[11], row: 5, railEndBeat: 34, railEndRow: 5, railSegments: [] });
  O.applyOrbitPhrases(notes, { bps: 2, maxShare: 1 });
  const orb = notes.filter(n => n._orbit);
  assert.ok(orb.length > 0);
  for (const n of orb) {
    assert.ok(Math.abs(n.beat - 9) > 1 && Math.abs(n.beat - 25) > 1, `orbit note at ${n.beat}`);
    assert.ok(n.beat < 30 || n.beat > 35, `orbit note at ${n.beat} inside the rail window`);
  }
});

test('budget, spacing and sparse rhythm', () => {
  const notes = stream(0, 96);
  O.applyOrbitPhrases(notes, { bps: 2, maxShare: 0.2 });
  const orb = notes.filter(n => n._orbit).sort((a, b) => a.beat - b.beat);
  assert.ok(orb.length <= 0.2 * notes.length && orb.length > 0);
  for (let i = 1; i < orb.length; i++) {
    const gap = orb[i].beat - orb[i - 1].beat;
    assert.ok(gap <= 3 || gap >= O.ORBIT_SPACING, `phrases ${gap} beats apart`);
  }
  // Easy-like: each hand every 2 beats → 12-beat turns, 6 notes per turn
  const easy = stream(0, 40, 2);
  const res = O.applyOrbitPhrases(easy, { bps: 2, maxShare: 1 });
  assert.equal(res.phrases, 1);
  for (const hn of hands(easy)) assert.ok(readable(circle(pts(hn))), JSON.stringify(circle(pts(hn))));
});

test('a hand resting longer than a quarter turn ends the phrase (no jump across the circle)', () => {
  const notes = stream(0, 8).concat(stream(10.5, 30));        // a 2.75-beat rest; a turn here is 4 beats
  O.applyOrbitPhrases(notes, { bps: 2, maxShare: 1 });
  let n = 0;
  for (const hn of hands(notes)) for (let i = 1; i < hn.length; i++, n++) {
    const dt = hn[i].beat - hn[i - 1].beat;
    assert.ok(dt <= 1 + 1e-9 || dt >= O.ORBIT_SPACING, `consecutive orbit notes ${dt} beats apart`);
  }
  assert.ok(n > 20);
});

test('the passes that would bend a circle skip _orbit notes', () => {
  const src = appSource();
  assert.ok(src.includes('if (orbs[i]._orbit) { i++; continue; }'), '[DenseSweep] region builder');
  assert.ok(src.includes('!n._gapFill && !n._underSquatRail && !n._sparseSweep && !n._orbit)'), '[Crossover] pool');
  assert.ok(extract(src, 'isPattern').includes('n._orbit'), 'SparseSweep / _toBand / C3 preference via isPattern');
  assert.ok(src.includes("n._orbit ? { pattern: 'orbit' }"), 'critic note_sample');
  const body = extract(src, 'onsetsToNotes');
  assert.ok(body.indexOf('applyOrbitPhrases(result') < body.indexOf('[DenseSweep] flowing groups'), 'Orbit runs before DenseSweep');
});

// ── integration: the whole onsetsToNotes, circles measured on what comes OUT ─────────────
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
const ROOTS = ['onsetsToNotes', '_detectC1Count', 'clampC3Jumps', 'clearGoldC2'];
// NOW records each orbit note's placed position right after the [Orbit] block, to prove that no
// later pass (FinalSweep, Crossover, ObstacleFinal, C3 clamp) moved it.
const nowSrc = appSource();
const ANCHOR = '    if (_orb.phrases) console.log(';
assert.ok(nowSrc.includes(ANCHOR));
const NOW = closure(nowSrc.replace(ANCHOR, '    globalThis.__orbPlaced?.(result);\n' + ANCHOR), ROOTS);
// OLD = the last commit with the 8-step spiral moves; its spiral notes get a _move tag in memory.
const OLD_REV = '79cc1d9';
const oldSrc = execSync(`git show ${OLD_REV}:synthriders-creator.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString()
  .replace('o._denseSweep = true;', 'o._denseSweep = true; o._move = mv.name;')
  .replace('o._sparseSweep = true;', 'o._sparseSweep = true; o._move = mv.name;');
const OLD = closure(oldSrc, ROOTS);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// A straight 4-stem rock song: kick/snare on beats, 16th hats, bass, plucks, a vocal and a guitar
// region (rails) every 32 beats.
function song({ bpm = 120, beats = 224, seed = 5 } = {}) {
  const r = rng(seed), bps = bpm / 60, T = b => b / bps, j = () => (r() - 0.5) * 0.02;
  const drums = [], bass = [], other = [], vocals = [], oreg = [], vreg = [];
  for (let b = 0; b < beats; b++) {
    drums.push({ time: T(b + j()), energy: 0.9, subtype: b % 2 ? 'snare' : 'kick' });
    for (const p of [0.25, 0.5, 0.75]) if (r() < 0.75) drums.push({ time: T(b + p + j()), energy: 0.45, subtype: 'hat' });
    if (r() < 0.85) bass.push({ time: T(b + j()), energy: 0.7 });
    if (r() < 0.6) bass.push({ time: T(b + 0.5 + j()), energy: 0.5 });
    if (r() < 0.5) other.push({ time: T(b + 0.25 + j()), energy: 0.5 });
    if (b % 32 === 0) { vocals.push({ time: T(b), energy: 0.6, pitch_row: 3 + (b % 5) }); vreg.push({ start: T(b), end: T(b + 3), energy: 0.6 }); }
    if (b % 32 === 16) { other.push({ time: T(b), energy: 0.6 }); oreg.push({ start: T(b), end: T(b + 5), energy: 0.5 }); }
  }
  const analysis = {
    bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [], panningByBeat: null, duration: T(beats),
    energyCurve: Array.from({ length: beats }, (_, b) => 0.45 + 0.45 * Math.abs(Math.sin(b / 19))),
    stemData: { drums: { onsets: drums, regions: [] }, bass: { onsets: bass, regions: [] },
                other: { onsets: other, regions: oreg }, vocals: { onsets: vocals, regions: vreg } },
  };
  const names = ['intro', 'verse', 'chorus', 'verse 2', 'chorus 2', 'bridge', 'outro'];
  const sections = names.map((name, i) => ({ name, startBeat: i * 32, endBeat: (i + 1) * 32, avgRow: 5, rowVariance: 2,
    rowContour: 'plateau', noteStyle: 'alternating-flow', handMode: 'alternating', density: 0.75, climax: name.startsWith('chorus') }));
  return { analysis, sections, bpm };
}
function run(lib, s, diff, seed) {
  const quiet = ['log', 'warn', 'debug', 'error', 'info'].map(k => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  globalThis.window = {};
  let placed = null;
  globalThis.__orbPlaced = res => { placed = new Map(res.filter(n => n._orbit).map(n => [n, [n._x, n.row]])); };
  try {
    const out = withSeed(seed, () => lib.onsetsToNotes(structuredClone(s.analysis), s.bpm, diff, structuredClone(s.sections), {}));
    return { out, placed };
  } finally { for (const [k, f] of quiet) console[k] = f; delete globalThis.window; delete globalThis.__orbPlaced; }
}
// Per-hand circle instances in a final map: consecutive same-hand notes sharing one circle tag.
function instances(notes, tagOf) {
  const res = [];
  for (const h of [0, 1]) {
    let cur = null;
    for (const n of notes.filter(m => m.type === h).sort((a, b) => a.beat - b.beat)) {
      const t = tagOf(n);
      if (t && cur && cur.t === t && n.beat - cur.last <= 3.5) { cur.p.push([colOf(n._x), n.row]); cur.last = n.beat; }
      else { if (cur) res.push(cur.p); cur = t ? { t, p: [[colOf(n._x), n.row]], last: n.beat } : null; }
    }
    if (cur) res.push(cur.p);
  }
  return res.filter(p => p.length >= 3).map(circle);
}
const oldTag = n => (n._denseSweep || n._sparseSweep) && /Spiral/.test(n._move || '') ? n._move : null;
const nowTag = n => n._orbit || null;

for (const diff of [9, 6]) {
  test(`onsetsToNotes diff ${diff}: circles survive every post-pass and read far better than the old spiral moves`, () => {
    let readNow = 0, readOld = 0, moved = 0, placedN = 0, turnsNow = [], turnsOld = [], nNow = [], nOld = [];
    for (const seed of [1, 2, 3]) {
      const s = song({ seed: 10 + seed });
      const now = run(NOW, s, diff, seed), old = run(OLD, s, diff, seed);
      for (const [n, [x, row]] of now.placed) { placedN++; if (now.out.notes.includes(n) && (n._x !== x || n.row !== row || !n._orbit)) moved++; }
      const iN = instances(now.out.notes, nowTag), iO = instances(old.out.notes, oldTag);
      readNow += iN.filter(readable).length; readOld += iO.filter(readable).length;
      turnsNow.push(...iN.map(m => m.turns)); turnsOld.push(...iO.map(m => m.turns));
      nNow.push(...iN.map(m => m.n)); nOld.push(...iO.map(m => m.n));
      // the invariants still hold on the new output
      const bps = s.bpm / 60;
      assert.equal(NOW._detectC1Count(now.out.notes), 0, 'C1');
      assert.equal(NOW.clearGoldC2(structuredClone(now.out.notes)), 0, 'gold C2');
      const c3 = NOW.clampC3Jumps(structuredClone(now.out.notes), bps);
      assert.equal(c3.clamped, 0, 'a C3 jump survived the final clamp');
    }
    assert.ok(placedN > 0, 'no orbit placed');
    assert.ok(moved <= 0.05 * placedN, `${moved} of ${placedN} orbit notes moved after placement`);
    // Measured at commit time (3 seeds): Master — old 35 spiral pieces, median 0.40 turns / 6 notes,
    // 5 readable (14%); now 8, median 1.29 turns / 14 notes, 6 readable (75%). Hard — old 29 pieces,
    // 0.41 turns, 2 readable; now 6, 1.0 turns, 3 readable. Real songs: see the commit message.
    const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const stats = `now ${readNow}/${turnsNow.length} readable, median ${med(turnsNow)?.toFixed(2)} turns, ${med(nNow)} notes; ` +
                  `old ${readOld}/${turnsOld.length}, ${med(turnsOld)?.toFixed(2)} turns, ${med(nOld)} notes`;
    assert.ok(readNow >= 3, stats);
    assert.ok(readNow >= 0.5 * turnsNow.length, `most circles read: ${stats}`);
    assert.ok(readOld <= 0.3 * turnsOld.length, `premise: the old spiral pieces mostly did not: ${stats}`);
    assert.ok(med(turnsNow) >= 0.95 && med(turnsNow) >= 2 * med(turnsOld), `full turns: ${stats}`);
    assert.ok(med(nNow) >= 2 * med(nOld), `notes per circle: ${stats}`);
  });
}
