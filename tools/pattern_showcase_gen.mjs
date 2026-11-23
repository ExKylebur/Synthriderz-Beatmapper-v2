// Pattern Showcase: generate each pattern's notes with the REAL generator code in
// synthriders-creator.html, and print them as JSON on stdout (tools/build_pattern_showcase.py
// turns that into audio + .synth).
//
//   node tools/pattern_showcase_gen.mjs  >  patterns.json
//
// What runs for real:
//   * rails        -> generateRailArc (module-level function), shape forced via its `motifPlan`
//                     argument (the same hook chorus-motif replay uses), multi-segment via planRailSegments
//   * dance moves  -> the literal text of the [DenseSweep] block of onsetsToNotes, evaluated on a
//                     synthetic note list (the move is forced through motifMemory.replay, which the
//                     block already consults), so the 3-Manhattan step cap, row band, zone clamp
//                     and boundary smoothing are the shipped ones
//   * sparse moves -> applySparseSweep (module-level)
//   * gold shapes  -> the literal text of the [GoldSweep] block of onsetsToNotes (shape forced the same way)
// What is a faithful re-statement, NOT shipped code (the logic is inline in onsetsToNotes and bound
// to its local state, so it cannot be evaluated in isolation): [GoldAccent] cross-field sweep,
// [GreenSweep] path, [Crossover] target columns. Each carries `mirrors` in its info.
// If a marker comment in the HTML moves, this script fails loudly instead of showing stale code.
import { extract, appSource, withSeed, colOf } from '../tests/harness.mjs';

const SRC = appSource();

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
    if (!text) throw new Error('missing declaration for closure root/dep');
    for (const tok of new Set(text.match(/[A-Za-z_$][\w$]*/g)))
      if (decl.has(tok) && !want.has(tok)) { want.add(tok); queue.push(tok); }
  }
  const order = [...want].sort((a, b) => src.indexOf(decl.get(a)) - src.indexOf(decl.get(b)));
  return new Function(`${order.map(n => decl.get(n)).join('\n')}\nreturn { ${roots.join(', ')} };`)();
}

const G = closure(SRC, ['generateRailArc', 'planRailSegments', 'fitRailPlan', 'applySparseSweep',
  'DANCE_MOVES', 'COL_X', 'smoothPatternBoundaries', 'RAIL_SHAPE_TIERS', 'railTierOf']);
const { COL_X, DANCE_MOVES } = G;

// ── slice a block of onsetsToNotes by its marker comments ──────────────────────────────
function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker), b = SRC.indexOf(endMarker, a + 1);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${a < 0 ? startMarker : endMarker}`);
  const lineStart = SRC.lastIndexOf('\n', a) + 1;
  return SRC.slice(lineStart, SRC.lastIndexOf('\n', b));
}
const GOLD_SRC  = slice('// ── [GoldSweep] choreograph clustered gold runs', '// ── [DenseSweep] flowing groups for dense runs (v2)');
const DENSE_SRC = slice('// ── [DenseSweep] flowing groups for dense runs (v2)', '// ── [SparseSweep] choreograph loose runs');
const CTX = ['result', 'hints', 'diffRowMin', 'diffRowMax', 'sectionAt', 'motifMemory', 'swungAt',
             'DENSE_SWEEP', 'DANCE_MOVES', 'smoothPatternBoundaries', 'COL_X', 'console'];
const goldBlock  = new Function(...CTX, GOLD_SRC);
const denseBlock = new Function(...CTX, DENSE_SRC);
const DIFF = 9;                                               // Master
const diffRowMin = 0, diffRowMax = 10;                        // onsetsToNotes: diff>=8
const quiet = { log() {}, warn() {}, error() {} };
function runBlock(fn, result, forced) {
  const motifMemory = { replay: (_s, kind) => forced[kind] ?? null, record() {} };
  fn(result, {}, diffRowMin, diffRowMax, () => ({ name: 'showcase' }), motifMemory, () => false,
     true, DANCE_MOVES, G.smoothPatternBoundaries, COL_X, quiet);
}

const rowsOf = n => n.row;
const pt = (n) => ({ col: colOf(n._x), row: n.row });

// ── pattern builders (beat 0 = pattern start; every pattern is self-contained) ─────────────
const patterns = [];
const add = (p) => patterns.push(p);

// Rails ----------------------------------------------------------------------------------
const RAIL_LEN = { short: 2, mid: 4, long: 8 };
function railPattern(shape, tier, hand, label, say) {
  const len = RAIL_LEN[tier];
  const xStart = COL_X[hand === 0 ? 10 : 3];      // zone centres (right 7-14, left 0-7)
  const arc = withSeed(11, () => G.generateRailArc(0, 5, len, 5, 0.25, xStart, hand, false, 1.0, 100, null, null,
                                                  [{ frac: 1, shape }]));
  const note = { beat: 0, row: 5, type: hand, _x: xStart, railEndBeat: len, railEndRow: arc.rowEnd,
                 railEnd_x: arc.xEnd, railSegments: arc.waypoints };
  const path = [{ col: colOf(xStart), row: 5 }, ...arc.waypoints.map(w => ({ col: colOf(w._x), row: w.row })),
                { col: colOf(arc.xEnd), row: arc.rowEnd }];
  return { group: 'Rails (generateRailArc)', name: label, say, beats: len, notes: [note], walls: [],
           info: { fn: 'generateRailArc', shape, tier, hand: hand === 0 ? 'right' : 'left', path } };
}
{
  let h = 0;
  const R = (shape, tier, label, say) => add(railPattern(shape, tier, (h++) % 2, label, say));
  R('hook', 'short', 'Rail: hook (short)', 'Rail, hook');
  R('flick', 'short', 'Rail: flick (short)', 'Rail, flick');
  R('ellipse', 'short', 'Rail: ellipse (short)', 'Rail, short ellipse');
  R('ellipse', 'mid', 'Rail: ellipse (mid)', 'Rail, ellipse');
  R('wave', 'mid', 'Rail: wave', 'Rail, wave');
  R('zigzag', 'mid', 'Rail: zigzag', 'Rail, zigzag');
  R('pendulum', 'mid', 'Rail: pendulum', 'Rail, pendulum');
  R('switchback', 'mid', 'Rail: switchback', 'Rail, switchback');
  R('ramp', 'mid', 'Rail: ramp', 'Rail, ramp');
  R('spiral', 'long', 'Rail: spiral (long)', 'Rail, spiral');
  R('figure8', 'long', 'Rail: figure eight (long)', 'Rail, figure eight');
  R('staircase', 'long', 'Rail: staircase (long)', 'Rail, staircase');
  R('ellipse', 'long', 'Rail: ellipse (long)', 'Rail, long ellipse');
}
// Multi-segment rail, then the motif-replay of the same plan (chorus 2 replays chorus 1).
{
  const len = 12, hand = 0, xStart = COL_X[10];
  let rs = 5; const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
  const plan = G.planRailSegments(len, rnd);
  for (const [k, lbl] of [[0, 'Rail: three shapes in one rail'], [1, 'Motif replay: the same rail shapes again']]) {
    const arc = withSeed(23 + k, () => G.generateRailArc(0, 5, len, 5, 0.25, xStart, hand, false, 1.0, 100, null, null,
                                                       k === 0 ? null : plan));
    // k=0 uses the generator's own planner; to replay the SAME plan, plan came from planRailSegments(seeded)
    const used = arc.plan;
    const note = { beat: 0, row: 5, type: hand, _x: xStart, railEndBeat: len, railEndRow: arc.rowEnd,
                   railEnd_x: arc.xEnd, railSegments: arc.waypoints };
    add({ group: 'Rails (generateRailArc)', name: lbl,
          say: k === 0 ? 'Long rail with several shapes' : 'Motif replay, same shapes again',
          beats: len, notes: [note], walls: [],
          info: { fn: k === 0 ? 'generateRailArc (planRailSegments internal)' : 'generateRailArc(motifPlan = recorded plan)',
                  plan: used.map(s => `${s.shape}@${s.frac.toFixed(2)}`),
                  path: [{ col: colOf(xStart), row: 5 }, ...arc.waypoints.map(w => ({ col: colOf(w._x), row: w.row })),
                         { col: colOf(arc.xEnd), row: arc.rowEnd }] } });
  }
  // make replay truly the same plan as the first rail: regenerate rail 0 with `plan` too
  const first = patterns[patterns.length - 2];
  const arc0 = withSeed(23, () => G.generateRailArc(0, 5, len, 5, 0.25, xStart, hand, false, 1.0, 100, null, null, plan));
  first.notes[0].railEndRow = arc0.rowEnd; first.notes[0].railEnd_x = arc0.xEnd; first.notes[0].railSegments = arc0.waypoints;
  first.info.fn = 'generateRailArc(motifPlan = planRailSegments)';
  first.info.plan = arc0.plan.map(s => `${s.shape}@${s.frac.toFixed(2)}`);
  first.info.path = [{ col: colOf(xStart), row: 5 }, ...arc0.waypoints.map(w => ({ col: colOf(w._x), row: w.row })),
                     { col: colOf(arc0.xEnd), row: arc0.rowEnd }];
}

// Dance moves via the real [DenseSweep] block ---------------------------------------------
// signed area of a closed-ish path in the player's view (x right, y up): >0 = counter-clockwise
function turning(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    a += p.col * (-q.row) - q.col * (-p.row);
  }
  return a / 2;
}
function pathStats(points) {
  if (points.length < 3) return {};
  const cx = points.reduce((s, p) => s + p.col, 0) / points.length, cy = points.reduce((s, p) => s + p.row, 0) / points.length;
  const rr = points.map(p => Math.hypot(p.col - cx, p.row - cy));
  const area = turning(points);
  return { centre: [+cx.toFixed(1), +cy.toFixed(1)], radiusMin: +Math.min(...rr).toFixed(2), radiusMax: +Math.max(...rr).toFixed(2),
           colSpan: Math.max(...points.map(p => p.col)) - Math.min(...points.map(p => p.col)),
           rowSpan: Math.max(...points.map(p => p.row)) - Math.min(...points.map(p => p.row)),
           turn: area > 0.5 ? 'counter-clockwise' : area < -0.5 ? 'clockwise' : 'none' };
}
const MOVE_SAY = {
  parallelSpiral: 'Spiral, both hands the same way',
  mirrorSpiral: 'Spiral, mirrored hands',
  scissors: 'Scissors, hands up and down in opposite directions',
  doublePunch: 'Double punch, out and in',
  altJabs: 'Alternating jabs',
  parallelStairs: 'Stairs, both hands climbing',
  accordion: 'Accordion, hands in and out',
  mirrorWings: 'Wings, flapping up and down',
  crossReturn: 'Cross over and return',
  dnaHelix: 'Helix, hands weaving',
  pendulum: 'Pendulum, swing side to side',
  outwardBloom: 'Fan out and in, up and down',
  boxStep: 'Box step',
  heartbeat: 'Heartbeat, both hands up and down together',
};
const STEP = 0.5;                                           // dense-run spacing (DSW_MAXGAP)
function denseNotes(mv, beat0) {
  const out = [];
  mv.steps.forEach((st, k) => {
    if (st.r) out.push({ beat: beat0 + k * STEP, row: 5, type: 0, _x: 0 });
    if (st.l) out.push({ beat: beat0 + k * STEP, row: 5, type: 1, _x: 0 });
  });
  return out;
}
DANCE_MOVES.forEach((mv, idx) => {
  const len1 = mv.steps.length * STEP;
  const result = [...denseNotes(mv, 0), ...denseNotes(mv, len1 + 1.0)];   // twice, 1 beat apart (separate regions)
  runBlock(denseBlock, result, { dense: idx });
  const tagged = result.filter(n => n._denseSweep).length;
  const first = result.filter(n => n.beat < len1 + 0.01);
  const perHand = h => first.filter(n => n.type === h).sort((a, b) => a.beat - b.beat).map(pt);
  const R = perHand(0), L = perHand(1);
  add({ group: 'Dance moves (DenseSweep, 1/2-beat steps)', name: `Move: ${mv.name}`, say: MOVE_SAY[mv.name] || mv.name,
        beats: len1 * 2 + 1, notes: result.map(({ beat, row, type, _x, _crossover }) => ({ beat, row, type, _x, _crossover })), walls: [],
        info: { fn: '[DenseSweep] block (real text)', move: mv.name, steps: mv.steps.length, taggedNotes: tagged, of: result.length,
                right: R, left: L, rightStats: pathStats(R), leftStats: pathStats(L) } });
});
// SparseSweep (1-beat spacing) for two moves, real applySparseSweep
for (const [name, idx] of [['parallelSpiral', 0], ['crossReturn', 8]]) {
  const mv = DANCE_MOVES[idx];
  const result = [];
  mv.steps.forEach((st, k) => { if (st.r) result.push({ beat: k, row: 5, type: 0, _x: 0 }); if (st.l) result.push({ beat: k, row: 5, type: 1, _x: 0 }); });
  const out = G.applySparseSweep(result, { pickMove: () => idx });
  const R = result.filter(n => n.type === 0).map(pt), L = result.filter(n => n.type === 1).map(pt);
  add({ group: 'Dance moves (SparseSweep, 1-beat steps)', name: `Sparse move: ${name}`, say: `Sparse ${MOVE_SAY[name].split(',')[0]}, one beat apart`,
        beats: mv.steps.length, notes: result.map(({ beat, row, type, _x, _crossover }) => ({ beat, row, type, _x, _crossover })), walls: [],
        info: { fn: 'applySparseSweep', move: name, tagged: out.tagged, right: R, left: L, rightStats: pathStats(R), leftStats: pathStats(L) } });
}

// Gold shapes via the real [GoldSweep] block ------------------------------------------------
const GOLD_NAME = ['diagonal bounce', 'circle', 'pendulum', 'wave', 'valley'];
GOLD_NAME.forEach((nm, shape) => {
  const result = Array.from({ length: 12 }, (_, k) => ({ beat: k * 0.5, row: 5, type: 3, _x: 0 }));
  runBlock(goldBlock, result, { gold: shape });
  const path = result.map(pt);
  add({ group: 'Gold orbs (GoldSweep, both hands)', name: `Gold: ${nm}`, say: `Gold, ${nm}`, beats: 5.5,
        notes: result.map(({ beat, row, type, _x }) => ({ beat, row, type, _x })), walls: [],
        info: { fn: '[GoldSweep] block (real text)', shape, path, stats: pathStats(path) } });
});
{ // [GoldAccent]: cross-field sweep, 2 cols per 1/16th, re-stated (inline in onsetsToNotes)
  const mk = (goLeft) => { const notes = []; let col = goLeft ? 3 : 11, b = 0;
    while (goLeft ? col <= 11 : col >= 3) { notes.push({ beat: b, row: 5, type: 3, _x: COL_X[col] }); col += goLeft ? 2 : -2; b += 0.25; }
    return notes; };
  const a = mk(true), b2 = mk(false).map(n => ({ ...n, beat: n.beat + 2 }));
  add({ group: 'Gold orbs (GoldSweep, both hands)', name: 'Gold accent: fast cross-field sweep', say: 'Gold accent, fast sweep across',
        beats: 3, notes: [...a, ...b2], walls: [],
        info: { fn: '[GoldAccent] (re-stated, not shipped text)', mirrors: 'onsetsToNotes GoldAccent: col 3->11, 2 cols per 1/16th' } });
}

// Green (one-hand special) sweep: re-statement of [GreenSweep] path -------------------------
for (const dirSign of [1, -1]) {
  const notes = []; const take = 8, baseRow = 4, rowAmp = 2;
  let col = dirSign > 0 ? 2 : 12;
  for (let k = 0; k < take; k++) {
    const t = k / (take - 1);
    notes.push({ beat: k * 0.5, row: Math.round(baseRow + Math.sin(t * Math.PI) * rowAmp), type: 2, _x: COL_X[Math.max(0, Math.min(14, col))] });
    col += 2 * dirSign;                                   // the shipped sweep steps 1-3 cols, 60% of the time 2
    col = Math.max(1, Math.min(13, col));
  }
  add({ group: 'Green orbs (GreenSweep, either hand)', name: `Green sweep ${dirSign > 0 ? 'left to right' : 'right to left'}`,
        say: `Green sweep, ${dirSign > 0 ? 'left to right' : 'right to left'}`, beats: 4, notes, walls: [],
        info: { fn: '[GreenSweep] (re-stated, not shipped text)', mirrors: 'onsetsToNotes GreenSweep: 1-3 col steps (mostly 2), sine row arc', path: notes.map(pt) } });
}

// Crossover accents: re-statement of the [Crossover] targets ----------------------------------
{
  const notes = [
    { beat: 0, row: 5, type: 0, _x: COL_X[11] }, { beat: 1, row: 5, type: 0, _x: COL_X[10] },
    { beat: 2, row: 6, type: 0, _x: COL_X[5], _crossover: true }, { beat: 3, row: 5, type: 0, _x: COL_X[10] },
    { beat: 4, row: 5, type: 1, _x: COL_X[3] }, { beat: 5, row: 5, type: 1, _x: COL_X[4] },
    { beat: 6, row: 6, type: 1, _x: COL_X[9], _crossover: true }, { beat: 7, row: 5, type: 1, _x: COL_X[4] },
  ];
  add({ group: 'Crossovers', name: 'Crossover accents (right hand then left hand)', say: 'Crossover. Right hand reaches left, then left hand reaches right',
        beats: 8, notes, walls: [],
        info: { fn: '[Crossover] (re-stated, not shipped text)', mirrors: 'targets: right hand cols 5-6, left hand cols 8-9; Master only; ~90% of eligible orbs' } });
}

// Walls -----------------------------------------------------------------------------------------
const WALLS = [
  ['crouch', null, 'Crouch wall', 'Crouch wall, duck down'],
  ['slide', 0, 'Slide wall, type 0 (blocks the high columns)', 'Slide wall, type zero, right side blocked'],
  ['slide', 4, 'Slide wall, type 4 (blocks the low columns)', 'Slide wall, type four, left side blocked'],
  ['leanLeft', 1, 'Lean left wall (blocks the high columns)', 'Lean left'],
  ['leanRight', 2, 'Lean right wall (blocks the low columns)', 'Lean right'],
];
for (const [wallType, slideType, name, say] of WALLS)
  add({ group: 'Walls', name, say, beats: 4, notes: [],
        walls: [{ beat: 0, duration: 2, wallType, ...(slideType === null ? {} : { slideType }) }],
        info: { fn: 'walls array (app wall types)', wallType, slideType } });

process.stdout.write(JSON.stringify({ bpm: 100, diff: DIFF, patterns }));
