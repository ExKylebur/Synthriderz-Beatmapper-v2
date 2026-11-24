// Swing detection + section-aware (triplet) snapping, on the REAL declarations in the app.
// The equivalence tests load onsetsToNotes with its whole dependency closure from the pre-triplet commit (BASE) and
// the working copy and run them under one seed: on straight input (and on swung input with the
// swing snap switched off) the output must be identical, so straight songs are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { ROOT, appSource, extract, load, withSeed } from './harness.mjs';

const S = load(['SWING_STEMS', 'SWING_WINDOW_BEATS', 'SWING_MIN_ONSETS', 'SWING_MARGIN', 'SWING_MIN_LOCK',
  'SWING_SONG_SHARE', 'SWING_SIXTH_SHARE', 'phaseLockR', 'offThirdsShare', 'swingStats', 'swingOnsetBeats',
  'detectSwing', 'snapDivsFor', 'makeSnapLattice', 'planSnapLattice']);

// ── deterministic synthetic onsets ──────────────────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const jit = (r, sd) => (r() + r() + r() - 1.5) * sd * 2;   // ~N(0, sd)
// Beat positions inside each beat, per feel.
const FEEL = {
  straight: [0, 0.25, 0.5, 0.75],
  swung:    [0, 1 / 3, 2 / 3],
};
function onsetBeats(feel, a, e, { seed = 1, keep = 0.8, sd = 0.015 } = {}) {
  const r = rng(seed), out = [];
  for (let b = a; b < e; b++) for (const p of FEEL[feel]) if (p === 0 || r() < keep) out.push(b + p + jit(r, sd));
  return out;
}
const isOnThirds = b => Math.abs(b * 3 - Math.round(b * 3)) < 1e-9;
const isOnSixths = b => Math.abs(b * 6 - Math.round(b * 6)) < 1e-9;

// ── phase lock ──────────────────────────────────────────────────────────────────────────
test('phaseLockR: on-beat locks at every k; thirds lock at k=3 only; quarters at k=4 only', () => {
  const beats = [0, 1, 2, 3, 4, 5];
  for (const k of [1, 2, 3, 4]) assert.ok(Math.abs(S.phaseLockR(beats, k) - 1) < 1e-12);
  const thirds = [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3];
  assert.ok(S.phaseLockR(thirds, 3) > 0.999 && S.phaseLockR(thirds, 4) < 1e-9);
  const quarters = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75];
  assert.ok(S.phaseLockR(quarters, 4) > 0.999 && S.phaseLockR(quarters, 3) < 1e-9);
  assert.equal(S.phaseLockR([], 3), 0);
});

test('offThirdsShare: 0 on thirds, 1 on odd sixths, ~1/2 on straight 16ths', () => {
  assert.equal(S.offThirdsShare([0, 1 / 3, 2 / 3, 5, 5 + 1 / 3]), 0);
  assert.equal(S.offThirdsShare([1 / 6, 0.5, 5 / 6]), 1);
  const st = onsetBeats('straight', 0, 200, { keep: 1, sd: 0.01 });
  const s = S.offThirdsShare(st);
  assert.ok(s > 0.3 && s < 0.7, `straight 16ths: ${s}`);
});

// ── detection ───────────────────────────────────────────────────────────────────────────
test('detectSwing: swung song → every 8-bar window votes thirds; straight 16ths → straight', () => {
  const sw = S.detectSwing(onsetBeats('swung', 0, 256, { seed: 3 }), 256);
  assert.equal(sw.swung, true);
  assert.equal(sw.voting, 8);
  assert.equal(sw.swungWindows, 8);
  assert.ok(sw.R3 > 0.8 && sw.R4 < 0.3, `R3 ${sw.R3} R4 ${sw.R4}`);
  const st = S.detectSwing(onsetBeats('straight', 0, 256, { seed: 4 }), 256);
  assert.equal(st.swung, false);
  assert.equal(st.swungWindows, 0);
  // straight 8ths (0, 0.5) also stay straight: 0.5 cancels R3
  const eighths = []; for (let b = 0; b < 256; b++) eighths.push(b, b + 0.5);
  assert.equal(S.detectSwing(eighths, 256).swung, false);
});

test('detectSwing: per-section override needs clear evidence; thin sections inherit the song', () => {
  const secs = [{ name: 'a', startBeat: 0, endBeat: 64 }, { name: 'b', startBeat: 64, endBeat: 128 },
                { name: 'c', startBeat: 128, endBeat: 192 }, { name: 'd', startBeat: 192, endBeat: 256 }];
  // straight song with one swung section → that section alone flips to thirds
  const mix = [...onsetBeats('straight', 0, 128, { seed: 5 }), ...onsetBeats('swung', 128, 192, { seed: 6 }),
               ...onsetBeats('straight', 192, 256, { seed: 7 })];
  const d = S.detectSwing(mix, 256, secs);
  assert.equal(d.swung, false);
  assert.deepEqual(d.sections.map(s => s.swung), [false, false, true, false]);
  assert.deepEqual(d.sections.map(s => s.override), [false, false, true, false]);
  // swung song with one straight section → that section alone flips to straight
  const mix2 = [...onsetBeats('swung', 0, 64, { seed: 8 }), ...onsetBeats('straight', 64, 128, { seed: 9 }),
                ...onsetBeats('swung', 128, 256, { seed: 10 })];
  const d2 = S.detectSwing(mix2, 256, secs);
  assert.equal(d2.swung, true);
  assert.deepEqual(d2.sections.map(s => s.swung), [true, false, true, true]);
  // a section with too few onsets to vote inherits the song decision
  const sparse = [...onsetBeats('swung', 0, 192, { seed: 11 }), 200, 200.25, 200.5, 200.75];
  const d3 = S.detectSwing(sparse, 256, secs);
  assert.equal(d3.sections[3].n < S.SWING_MIN_ONSETS, true);
  assert.equal(d3.sections[3].swung, true);
  assert.equal(d3.sections[3].override, false);
  // random onsets lock at neither k → straight, no override
  const r = rng(12), rnd = Array.from({ length: 800 }, () => r() * 256);
  const d4 = S.detectSwing(rnd, 256, secs);
  assert.equal(d4.swung, false);
  assert.ok(d4.sections.every(s => !s.override));
});

test('swingOnsetBeats: pools drums+bass+other on the map clock (vocals excluded), JS fallback too', () => {
  const sd = { drums: { onsets: [{ time: 1 }] }, bass: { onsets: [{ time: 0.5 }] },
               other: { onsets: [{ time: 2 }] }, vocals: { onsets: [{ time: 0.25 }] } };
  assert.deepEqual(S.swingOnsetBeats({ stemData: sd }, 2), [1, 2, 4]);
  assert.deepEqual(S.swingOnsetBeats({ bassOnsets: [1], midOnsets: [0.5], highOnsets: [] }, 2), [1, 2]);
  assert.deepEqual(S.swingOnsetBeats({}, 2), []);
});

// ── grid choice + lattice ───────────────────────────────────────────────────────────────
test('snapDivsFor: thirds at Hard+, sixths only at Master with off-thirds content, Easy/Normal on the beat', () => {
  const sw = { swung: true, offThirds: 0.05, n: 100 }, sw6 = { swung: true, offThirds: 0.4, n: 100 }, st = { swung: false };
  // too few onsets to judge sub-triplet content (live: a 6-beat outro, 5 onsets, 40% off) → thirds
  assert.equal(S.snapDivsFor(0.25, 9, { swung: true, offThirds: 0.4, n: S.SWING_MIN_ONSETS - 1 }), 3);
  assert.equal(S.snapDivsFor(0.25, 9, st), 4);
  assert.equal(S.snapDivsFor(0.5, 6, st), 2);
  assert.equal(S.snapDivsFor(1.0, 2, sw), 1);    // Easy / Normal: beats only, swung or not
  assert.equal(S.snapDivsFor(0.5, 6, sw), 3);    // Hard
  assert.equal(S.snapDivsFor(0.25, 8, sw), 3);   // Expert
  assert.equal(S.snapDivsFor(0.25, 8, sw6), 3);  // Expert never gets sixths
  assert.equal(S.snapDivsFor(0.25, 9, sw), 3);   // Master, triplet-locked
  assert.equal(S.snapDivsFor(0.25, 9, sw6), 6);  // Master with sub-triplet hits
});

test('makeSnapLattice: straight grid is bit-identical to the old round(b/s)*s', () => {
  const r = rng(21);
  for (const s of [0.25, 0.5, 1.0]) {
    const L = S.makeSnapLattice(s);
    for (let i = 0; i < 20000; i++) {
      const b = r() * 600;
      assert.equal(Object.is(L.snap(b), Math.round(b / s) * s), true, `s=${s} b=${b}`);
    }
    assert.equal(L.swungAt(10), false);
    assert.equal(L.sizeAt(10), s);
    assert.equal(L.stepAt(10, Math.max(s, 0.25)), Math.max(s, 0.25));
  }
});

test('makeSnapLattice: swung spans snap to thirds/sixths, edges round to whole beats, snap is idempotent', () => {
  const L = S.makeSnapLattice(0.25, [{ startBeat: 16.4, endBeat: 31.6, divs: 3 }, { startBeat: 40, endBeat: 48, divs: 6 }]);
  assert.deepEqual(L.spans.map(s => [s.a, s.e, s.d]), [[16, 32, 3], [40, 48, 6]]);
  assert.equal(L.snap(15.9), 16);                  // straight side of the edge → a whole beat
  assert.equal(L.snap(20.3), 61 / 3);
  assert.equal(L.snap(20.6), 62 / 3);
  assert.equal(L.snap(20.75), 62 / 3);             // a 1/16 position lands on the third
  assert.equal(L.snap(41.2), 41 + 1 / 6);
  assert.equal(L.snap(33.3), 33.25);               // between spans: straight
  assert.equal(L.swungAt(20), true); assert.equal(L.swungAt(33), false); assert.equal(L.swungAt(44), true);
  assert.equal(L.stepAt(20, 0.25), 1 / 3);         // whole cells, never below the minimum
  assert.equal(L.stepAt(44, 0.25), 1 / 3);         // two sixths
  const r = rng(22);
  for (let i = 0; i < 20000; i++) {
    const b = r() * 60, x = L.snap(b);
    assert.equal(L.snap(x), x, `not idempotent at ${b}`);
    assert.ok(Math.abs(x - b) <= 1 / (2 * L.divsAt(b)) + 1e-9, `moved too far at ${b}`);
  }
  // the song-level default applies outside every span
  const D = S.makeSnapLattice(0.25, [{ startBeat: 0, endBeat: 8, divs: 4 }], 3);
  assert.equal(D.snap(2.3), 2.25);
  assert.equal(D.snap(20.3), 61 / 3);
});

test('planSnapLattice: off = the straight grid; auto follows detection; on = thirds everywhere', () => {
  const bps = 2, tb = 256;
  const times = onsetBeats('swung', 0, tb, { seed: 30 }).map(b => b / bps);
  const analysis = { stemData: { drums: { onsets: times.map(time => ({ time })) } } };
  const secs = [{ startBeat: 0, endBeat: 128 }, { startBeat: 128, endBeat: 256 }];
  const off = S.planSnapLattice(analysis, bps, tb, secs, 9, 0.25, 'off');
  assert.equal(off.swing, null); assert.equal(off.lattice.snap(10.3), 10.25);
  const auto = S.planSnapLattice(analysis, bps, tb, secs, 9, 0.25, 'auto');
  assert.equal(auto.swing.swung, true); assert.equal(auto.lattice.snap(10.3), 31 / 3);
  const st = { stemData: { drums: { onsets: onsetBeats('straight', 0, tb, { seed: 31 }).map(b => ({ time: b / bps })) } } };
  assert.equal(S.planSnapLattice(st, bps, tb, secs, 9, 0.25, 'auto').lattice.snap(10.3), 10.25);
  assert.equal(S.planSnapLattice(st, bps, tb, secs, 9, 0.25, 'on').lattice.snap(10.3), 31 / 3);
  // no sections at all: the song-level grid still applies
  assert.equal(S.planSnapLattice(analysis, bps, tb, [], 9, 0.25, 'auto').lattice.snap(10.3), 31 / 3);
});

// ── generateRailArc on a thirds grid ────────────────────────────────────────────────────
import { RAIL_DEPS } from './harness.mjs';
const G = load([...RAIL_DEPS, 'RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE',
  'fitShapeToLength', 'RAIL_SEG_MIN_BEATS', 'RAIL_MULTISEG_MIN_BEATS', 'assignSegmentShapes',
  'planRailSegments', 'fitRailPlan', 'buildRailPath', 'railWaypointCount', 'railCornerTs', 'generateRailArc']);
test('generateRailArc: on a thirds grid every waypoint is EXACTLY the third the notes use, none before its head', () => {
  // round(b / (1/3)) * (1/3) (the old rounding) left 800 of 2371 waypoints a few ulp off
  // round(b*3)/3, the value snapToGrid gives the notes on the same rail.
  let n = 0;
  for (let k = 0; k < 300; k++) withSeed(100 + k, () => {
    const head = 30 + Math.round(Math.random() * 60) / 3, len = 2 + Math.round(Math.random() * 30) / 3;
    const arc = G.generateRailArc(head, 5, head + len, 5, 1 / 3, 0.4, k % 2, false, 1, 120);
    for (const wp of arc.waypoints) {
      assert.equal(wp.beat, Math.round(wp.beat * 3) / 3, `waypoint ${wp.beat} not on the exact third`);
      assert.ok(wp.beat >= head, `waypoint ${wp.beat} before head ${head}`);
      n++;
    }
  });
  assert.ok(n > 300);
});

// ── onsetsToNotes: HEAD vs working copy, and the swung output's invariants ─────────────
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
// BASE = the last commit before the triplet snap. Pinned (not HEAD) so the check stays meaningful
// after this work is committed. If a later change MEANS to alter straight-song output, re-pin
// BASE to that commit and say so in its message (as tests/rail-shapes does with acd1853).
// Re-pinned 999514c -> 9998da6 ([Orbit] circles): that commit moves notes onto circles on purpose
// and is otherwise the triplet-snap code, so straight output must still match it exactly.
// Re-pinned 9998da6 -> 3d387b1 (stem density, 2026-11-23): Master uncapped, drum streams alternate
// hands, rails no longer orphan their drum hits, the lower tiers taper by loudness. That commit is
// the density work merged with the orbit circles, before the comfort-reach rule (aerobic mode here).
// Re-pinned 3d387b1 -> 39de456 (rail shape fidelity, 2026-11-24): 3d387b1 plus the 1f535b0 rail
// geometry (bigger swings, corner waypoints, real staircase steps), nothing else.
const BASE = '39de456';
const ROOTS = ['onsetsToNotes', '_detectC1Count', 'clampC3Jumps', 'clearGoldC2'];
const NOW  = closure(appSource(), ROOTS);
const HEAD = closure(execSync(`git show ${BASE}:synthriders-creator.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString(), ROOTS);

// A 4-stem song: kick on beats, snare on 2/4, hats/bass/plucks on the feel's sub-beat slots,
// vocal regions for rails. Times on the map clock (beat 0 = t 0).
function song(feel, { bpm = 120, beats = 192, seed = 40 } = {}) {
  const r = rng(seed), bps = bpm / 60, T = b => b / bps;
  const sub = FEEL[feel].slice(1);
  const drums = [], bass = [], other = [], vocals = [], oreg = [], vreg = [];
  for (let b = 0; b < beats; b++) {
    drums.push({ time: T(b + jit(r, 0.01)), energy: 0.9, subtype: b % 2 ? 'snare' : 'kick' });
    for (const p of sub) if (r() < 0.7) drums.push({ time: T(b + p + jit(r, 0.01)), energy: 0.4, subtype: 'hat' });
    if (r() < 0.8) bass.push({ time: T(b + jit(r, 0.01)), energy: 0.7 });
    if (r() < 0.6) bass.push({ time: T(b + sub[sub.length - 1] + jit(r, 0.01)), energy: 0.5 });
    if (r() < 0.5) other.push({ time: T(b + sub[0] + jit(r, 0.01)), energy: 0.5 });
    if (b % 8 === 0) { vocals.push({ time: T(b + jit(r, 0.02)), energy: 0.6, pitch_row: 3 + (b % 5) });
                       vreg.push({ start: T(b), end: T(b + 3), energy: 0.6 }); }
    if (b % 16 === 4) { other.push({ time: T(b), energy: 0.6 }); oreg.push({ start: T(b), end: T(b + 5), energy: 0.5 }); }
  }
  const energyCurve = Array.from({ length: beats }, (_, b) => 0.45 + 0.4 * Math.abs(Math.sin(b / 23)));
  const analysis = {
    bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [], energyCurve,
    duration: T(beats), panningByBeat: null,
    stemData: { drums: { onsets: drums, regions: [] }, bass: { onsets: bass, regions: [] },
                other: { onsets: other, regions: oreg }, vocals: { onsets: vocals, regions: vreg } },
  };
  const names = ['intro', 'verse', 'chorus', 'verse 2', 'chorus 2', 'outro'];
  const sections = names.map((name, i) => ({ name, startBeat: i * 32, endBeat: (i + 1) * 32, avgRow: 5,
    rowVariance: 2, rowContour: 'plateau', noteStyle: 'alternating-flow', handMode: 'alternating',
    density: 0.7, climax: name.startsWith('chorus') }));
  return { analysis, sections, bpm };
}
function run(lib, s, diff, hints = {}, seed = 7, sink = null) {
  const quiet = ['log', 'warn', 'debug', 'error', 'info'].map(k => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  if (sink) console.log = (...a) => sink.push(a.join(' '));
  globalThis.window = {};                                  // onsetsToNotes exposes _lastPlacementLog
  try {
    return withSeed(seed, () => lib.onsetsToNotes(structuredClone(s.analysis), s.bpm, diff,
      structuredClone(s.sections), structuredClone(hints)));
  } finally { for (const [k, f] of quiet) console[k] = f; delete globalThis.window; }
}

// The obstacle comfort-reach rule (2026-11-22) deliberately moves notes during walls. Its
// aerobicReach mode is the pre-rule placement (tests/obstacles pins that against the commit
// before it), so running NOW in that mode keeps these checks isolating the triplet change.
// The mode tags each wall `aerobic: true`; drop the tag before comparing.
const LEGACY_REACH = { aerobicReach: true };
const untag = r => ({ ...r, walls: r.walls.map(({ aerobic, ...w }) => w) });
for (const diff of [9, 8, 6, 2]) {
  test(`onsetsToNotes diff ${diff}: straight song is identical to the pre-triplet baseline`, () => {
    const s = song('straight', { seed: 50 + diff });
    const a = untag(run(NOW, s, diff, LEGACY_REACH)), b = run(HEAD, s, diff);
    assert.ok(a.notes.length > 50, `only ${a.notes.length} notes`);
    assert.deepEqual(a, b);
  });
}

test('onsetsToNotes: a swung song with the swing snap switched off is identical to the pre-triplet baseline', () => {
  const s = song('swung', { seed: 61 });
  // BASE has had the snap since the 9998da6 re-pin, so it too runs with the switch off.
  assert.deepEqual(untag(run(NOW, s, 9, { swingMode: 'off', ...LEGACY_REACH })), run(HEAD, s, 9, { swingMode: 'off' }));
});

for (const diff of [9, 8, 6]) {
  test(`onsetsToNotes diff ${diff}: swung song lands on thirds and keeps the C1/C2/C3 invariants`, () => {
    const s = song('swung', { seed: 70 + diff });
    const bps = s.bpm / 60;
    const out = run(NOW, s, diff);
    const off = run(NOW, s, diff, { swingMode: 'off' });
    assert.ok(out.notes.length > 50);
    // every hit (orbs, rail heads) sits on a third; the straight run put them on quarters
    const heads = out.notes.map(n => n.beat);
    const offGrid = heads.filter(b => !isOnThirds(b));
    assert.deepEqual(offGrid, [], `off the thirds lattice: ${offGrid.slice(0, 8)}`);
    assert.ok(heads.some(b => !Number.isInteger(b)), 'no sub-beat notes at all');
    assert.ok(off.notes.some(n => !isOnThirds(n.beat)), 'control run (straight grid) never left the thirds');
    // rail waypoints on thirds and never before their head
    for (const n of out.notes) for (const wp of n.railSegments || []) {
      assert.ok(wp.beat >= n.beat - 1e-9, `waypoint ${wp.beat} before head ${n.beat}`);
    }
    // one note per hand per beat
    const seen = new Set();
    for (const n of out.notes) {
      const k = `${n.type}:${Math.round(n.beat * 300)}`;
      assert.ok(!seen.has(k), `two type-${n.type} notes at beat ${n.beat}`); seen.add(k);
    }
    // the fixers find nothing left to fix, exactly as on the straight grid
    const c1 = NOW._detectC1Count(out.notes), c1off = NOW._detectC1Count(off.notes);
    assert.equal(c1, 0, `C1 ${c1} (straight control ${c1off})`);
    const g = structuredClone(out.notes);
    assert.equal(NOW.clearGoldC2(g), 0, 'gold C2 clearance violated');
    // validate.py's C2 checks on the EXPORTED clock (z rounded to 6 dp, inclusive 1 beat)
    const ex = n => Math.round(n.beat / bps * 20 * 1e6) / 1e6 / 20 * bps;
    const orbs = out.notes.filter(n => n.railEndBeat == null), rails = out.notes.filter(n => n.railEndBeat != null);
    const golds = orbs.filter(n => n.type === 3), goldRails = rails.filter(n => n.type === 3);
    const c2g = orbs.filter(m => (m.type === 0 || m.type === 1) && (golds.some(gd => Math.abs(ex(m) - ex(gd)) <= 1.0)
      || goldRails.some(gr => ex(gr) - 1 <= ex(m) && ex(m) <= gr.railEndBeat + 1))).length;
    assert.equal(c2g, 0, `validate would report HARD C2-GOLD ×${c2g}`);
    const grc = orbs.filter(gn => gn.type === 2 && rails.some(r => ex(gn) >= ex(r) - 1 && ex(gn) <= r.railEndBeat + 1)).length;
    assert.equal(grc, 0, `validate would report HARD C2-GREEN-RAIL ×${grc}`);
    const c3 = NOW.clampC3Jumps(structuredClone(out.notes), bps), c3off = NOW.clampC3Jumps(structuredClone(off.notes), bps);
    assert.ok(c3.clamped <= c3off.clamped && c3.stuck <= c3off.stuck,
      `C3 clamped ${c3.clamped}/stuck ${c3.stuck} vs straight ${c3off.clamped}/${c3off.stuck}`);
  });
}

test('C2 clearance is inclusive at exactly 1 beat on thirds too (float slack C2_BEAT_EPS)', () => {
  const C = load(['C2_BEAT_EPS', 'clearGoldC2', 'clearGreenRailConflicts']);
  assert.ok(50 / 3 - 47 / 3 > 1.0, 'premise: the thirds difference is not exactly 1 in binary');
  const gold = { beat: 47 / 3, type: 3, _x: 0, row: 5 };
  const at1 = { beat: 50 / 3, type: 0, _x: 0.4, row: 5 }, past = { beat: 51 / 3, type: 1, _x: -0.4, row: 5 };
  const notes = [gold, at1, past];
  assert.equal(C.clearGoldC2(notes), 1);
  assert.deepEqual(notes, [gold, past]);
  // straight grid: same inclusive edge, unchanged
  const sg = [{ beat: 15.75, type: 3 }, { beat: 16.75, type: 0 }, { beat: 17, type: 1 }];
  assert.equal(C.clearGoldC2(sg), 1);
  assert.deepEqual(sg.map(n => n.beat), [15.75, 17]);
  // green exactly 1 beat after a rail ends (thirds) is a green-rail conflict
  const rail = { beat: 40 / 3, type: 0, railEndBeat: 47 / 3 };
  const gr = [rail, { beat: 50 / 3, type: 2 }, { beat: 51 / 3, type: 2 }];
  assert.equal(C.clearGreenRailConflicts(gr), 1);
  assert.deepEqual(gr.map(n => n.beat), [40 / 3, 51 / 3]);
});

test('C1 window covers a note 0.004 beat past an off-grid rail end (validate beat_eps)', () => {
  const C = load(['COL_X', 'RAIL_COL_STEP', 'railPosAt', 'C1_EDGE_SLACK', 'isOffRail', 'fixC1']);
  // live case (Electric Love, seed 3): left rail 236 → 239.996 (head + 2 s), a _dbComp mirror at 240
  const rail = { beat: 236, type: 1, row: 5, _x: C.COL_X[7], railEndBeat: 239.996, railEndRow: 5, railEnd_x: C.COL_X[7], railSegments: [] };
  const mirror = { beat: 240, type: 1, row: 5, _x: C.COL_X[2], _dbComp: true };
  const later = { beat: 240.25, type: 1, row: 5, _x: C.COL_X[2] };        // a real gap: not this rail's business
  assert.equal(C.isOffRail(mirror, rail), true);
  assert.equal(C.isOffRail(later, rail), false);
  const notes = [rail, mirror, later];
  const r = C.fixC1(notes);
  assert.equal(r.snapped, 1);
  assert.equal(mirror._x, C.COL_X[7]);                                     // onto the rail's end
  assert.equal(later._x, C.COL_X[2]);
});

// The pass fixes, gated by loading the real source with ONE fix reverted and comparing.
function reverted(find, repl) {
  const src = appSource();
  assert.ok(src.includes(find), `fix not found (renamed?): ${find}`);
  return closure(src.replace(find, repl), ['onsetsToNotes']);
}
function runLogged(lib, s, diff) {
  const logs = [];
  return { out: run(lib, s, diff, {}, 7, logs), logs };
}
const sumLog = (logs, re) => logs.reduce((t, l) => t + +(l.match(re)?.[1] ?? 0), 0);

test('RhythmCoherence: swung windows read a 1/3 (or swung-8th) drum pulse, not a 0.25 one', () => {
  const back = reverted('const _subdivs = _rcSwung ? SUBDIVS_SWUNG : SUBDIVS;', 'const _subdivs = SUBDIVS;');
  let fixed = 0, old = 0;
  for (const seed of [71, 72, 73]) {
    const s = song('swung', { seed, beats: 256 });
    fixed += sumLog(runLogged(NOW, s, 9).logs, /\[RhythmCoherence\] Removed (\d+)/);
    old   += sumLog(runLogged(back, s, 9).logs, /\[RhythmCoherence\] Removed (\d+)/);
  }
  assert.ok(old > 0 && fixed < 0.7 * old, `culled ${fixed} with the fix vs ${old} without`);
});

test('DenseSweep: a swung-8th run (2/3 + 1/3 gaps) counts as dense', () => {
  const back = reverted('const _dswGap = b => swungAt(b) ? DSW_MAXGAP_SWUNG : DSW_MAXGAP;', 'const _dswGap = b => DSW_MAXGAP;');
  let fixed = 0, old = 0;
  for (const seed of [71, 72, 73]) {
    const s = song('swung', { seed, beats: 256 });
    // Swung 8ths only (the beat + its ⅔ "a"): drop the hits on the first third. With the triplet
    // hats in, the drum line itself fills the ⅔ gaps since the 2026-11-23 density work (drum hits
    // that rode a rail onsetsToNotes never placed are no longer dropped), so the gate couldn't show.
    const bps = s.bpm / 60, onFirstThird = o => Math.abs((((o.time * bps) % 1) + 1) % 1 - 1 / 3) < 0.1;
    for (const k of ['drums', 'bass', 'other']) s.analysis.stemData[k].onsets = s.analysis.stemData[k].onsets.filter(o => !onFirstThird(o));
    fixed += run(NOW, s, 9).notes.filter(n => n._denseSweep).length;
    old   += run(back, s, 9).notes.filter(n => n._denseSweep).length;
  }
  assert.ok(fixed > 1.2 * old, `dense-swept ${fixed} with the fix vs ${old} without`);
});

test('GoldAccent sweep step: whole grid cells, so no two golds share a beat on thirds', () => {
  // the sweep walks b += step from a snapped start and re-snaps every step
  const walk = (L, start, step) => Array.from({ length: 5 }, (_, k) => L.snap(start + k * step));
  const L = S.makeSnapLattice(0.25, [{ startBeat: 0, endBeat: 64, divs: 3 }]);
  const old = walk(L, 20, Math.max(0.25, 0.25));
  assert.notEqual(new Set(old).size, old.length, 'the old 0.25 step should collide on thirds');
  const now = walk(L, 20, L.stepAt(20, 0.25));
  assert.equal(new Set(now).size, now.length);
  assert.ok(now.every(isOnThirds));
  const st = S.makeSnapLattice(0.25);
  assert.deepEqual(walk(st, 20, st.stepAt(20, 0.25)), [20, 20.25, 20.5, 20.75, 21]);   // straight: unchanged
});

test('onsetsToNotes: snapping goes through the lattice only (no parallel snap helpers)', () => {
  const body = extract(appSource(), 'onsetsToNotes');
  assert.equal((body.match(/function snapBeat\(/g) || []).length, 1);
  assert.equal((body.match(/function snapToGrid\(/g) || []).length, 1);
  assert.ok(body.includes('function snapBeat(t)    { return _lattice.snap(t * bps); }'));
  assert.ok(body.includes('function snapToGrid(b)  { return _lattice.snap(b); }'));
  assert.ok(!/\/ snapSize\) \* snapSize/.test(body), 'a hand-rolled straight snap is back');
  assert.ok(!/generateRailArc\([^)]*,\s*snapSize,/.test(body), 'generateRailArc given the straight grid');
});
