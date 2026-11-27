// Lyric movement cues (2026-11-26): vocabulary, syllable timing, vocal-onset alignment, and the
// [Orbit] preference for sung "spin" windows — all on the REAL declarations in the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const L = load(['LYRIC_CUE_VERSION', 'LYRIC_WALL_ACTIONS', 'LYRIC_MOTION_ACTIONS', 'LYRIC_LINE_MAX_SEC',
  'LYRIC_WORD_EST_SEC', 'LYRIC_LINE_SLOP_SEC', 'LYRIC_SNAP_SEC', 'LYRIC_MOTION_DEFAULT_BEATS',
  'LYRIC_RAIL_SHAPE', 'LYRIC_GOLD_SHAPE', 'LYRIC_ACTION_RULES', 'isLyricWallCue', 'isLyricMotionCue',
  'libraryLyricCues', 'lyricSyllables', 'lyricCuesFromLines', 'spaceLyricCues', 'alignLyricCues',
  'lyricMotionAt', 'LYRIC_REPORT_MAX', 'lyricCueReport', 'COL_X', 'LYRIC_LIFT_BEATS', 'LYRIC_LIFT_TOP',
  'applyLyricLift']);
const colOfX = x => Math.round((x + 0.9555) / 0.1365);

const actionOf = text => L.lyricCuesFromLines([{ t: 10, text }, { t: 14, text: 'x' }], 2, 1000).map(c => c.action);

test('vocabulary: circle words become spin; body words keep their walls', () => {
  for (const line of ['Circle with me', 'vultures circling the flame', "I'm spinning out of control",
    'Negative feedback loop', 'round and round we go', 'turn around', 'a spiral of light', 'twirl me'])
    assert.deepEqual(actionOf(line), ['spin'], line);
  assert.deepEqual(actionOf('sway with the tide'), ['wave']);
  assert.deepEqual(actionOf('lightning in my veins'), ['zigzag']);
  assert.deepEqual(actionOf('to infinity'), ['figure8']);
  assert.deepEqual(actionOf('step by step'), ['stairs']);
  assert.deepEqual(actionOf('When I escalate, the fire is cold'), ['elevate']);
  assert.deepEqual(actionOf('Cut down the altar'), ['crouch']);
  // one body AND one motion cue per line
  assert.deepEqual(actionOf('spinning down to the floor').sort(), ['crouch', 'spin']);
  // precision: no motion from unrelated words
  for (const line of ['I could be right', 'giving up', 'hold the flame', 'rock and roll', 'the weight of a martyr'])
    assert.deepEqual(actionOf(line), [], line);
});

test('syllable position: a late word is cued late in its line, not at the line start', () => {
  const [c] = L.lyricCuesFromLines([{ t: 20, text: 'It could all be yours, vultures circling the flame' }, { t: 24, text: 'x' }], 2, 1000);
  assert.equal(c.action, 'spin');
  assert.ok(c.frac > 0.5 && c.frac < 0.8, `frac ${c.frac}`);
  assert.ok(c.t > 22 && c.t < 23.2, `t ${c.t}`);
  assert.equal(c.endT, 24);                                    // window runs to the line end
  assert.equal(L.lyricSyllables('circling'), 2);              // cir-cling
  assert.equal(L.lyricSyllables('the'), 1);
  assert.equal(L.lyricSyllables('altar'), 2);
});

test('spacing: repeated spin lines merge into one window; walls still spaced', () => {
  const lines = [{ t: 100, text: 'Circle with me' }, { t: 104, text: 'Circle with me' },
                 { t: 108, text: 'get down' }, { t: 109, text: 'get down' }, { t: 115, text: 'x' }];
  const kept = L.spaceLyricCues(L.lyricCuesFromLines(lines, 2, 1000));
  const spins = kept.filter(L.isLyricMotionCue);
  assert.equal(spins.length, 1);
  assert.equal(spins[0].beat, 200);
  assert.equal(spins[0].endBeat, 216);                         // through the second line's end
  assert.equal(kept.filter(L.isLyricWallCue).length, 1);       // 2 beats apart → one wall
  assert.ok(kept.every(c => !('strong' in c)));
});

test('alignment: a cue moves onto its syllable among the line\'s vocal onsets', () => {
  // A trigger word 3/8 of the way through its line's syllables.
  const cue = { beat: 0, t: 21.1, action: 'spin', lineT: 20, lineEnd: 24, frac: 3 / 8, endT: 24 };
  const onsets = [19.0, 20.05, 20.4, 20.8, 21.6, 21.9, 22.2, 22.6, 23.0, 30];   // 8 in the line
  const [a] = L.alignLyricCues([cue], onsets.map(time => ({ time })), 2);
  assert.equal(a.t, 21.6);                                     // onset round(3/8·8) = 3 within the line
  assert.equal(a.beat, 43.25);                                 // quarter-beat precision
  assert.equal(a.endBeat, 48);
  assert.equal(a._aligned, true);
  // no line info: nearest onset within the snap window, else unchanged
  const [b] = L.alignLyricCues([{ beat: 20, t: 10.1, action: 'crouch' }], [{ time: 10.3 }], 2);
  assert.equal(b.beat, 20.5);
  const [c] = L.alignLyricCues([{ beat: 20, t: 10.1, action: 'crouch' }], [{ time: 11 }], 2);
  assert.equal(c.beat, 20);
  // no stems at all (audio-free / tests): beats untouched, motion cues still get a window
  const [d] = L.alignLyricCues([{ beat: 40, action: 'wave' }], undefined, 2);
  assert.equal(d.endBeat, 40 + L.LYRIC_MOTION_DEFAULT_BEATS);
});

test('lyricMotionAt finds the overlapping window', () => {
  const cues = [{ beat: 100, endBeat: 110, action: 'spin' }, { beat: 120, endBeat: 124, action: 'wave' },
                { beat: 105, action: 'crouch' }];
  assert.equal(L.lyricMotionAt(cues, 104, 108), 'spin');
  assert.equal(L.lyricMotionAt(cues, 111, 118), null);
  assert.equal(L.lyricMotionAt(cues, 118, 121), 'wave');
  assert.equal(L.lyricMotionAt(cues, 50), null);
});

test('library caches from the old vocabulary are re-fetched', () => {
  assert.equal(L.libraryLyricCues({ lyricCues: [{ beat: 1, action: 'crouch' }] }), null);
  assert.equal(L.libraryLyricCues({ lyricCues: null }), null);
  const cur = [{ beat: 1, action: 'spin', endBeat: 9 }];
  assert.equal(L.libraryLyricCues({ lyricCues: cur, lyricCuesVer: L.LYRIC_CUE_VERSION }), cur);
});

test('critic report: honored flags come from the full map', () => {
  const bps = 2;
  const cues = [
    { beat: 20, action: 'crouch', lyric: 'Cut down the altar' },
    { beat: 60, action: 'leanLeft', lyric: 'to the left' },
    { beat: 80, action: 'elevate', lyric: 'I climb the altar and I claim my place' },
    { beat: 100, endBeat: 110, action: 'spin', lyric: 'Circle with me' },
    { beat: 130, endBeat: 136, action: 'wave', lyric: 'sway' },
  ];
  const walls = [{ beat: 20.5, wallType: 'crouch', duration: 2 }, { beat: 64, wallType: 'leanLeft', duration: 1 }];
  const notes = [
    { beat: 79, type: 0, row: 5, railEndBeat: 84, railEndRow: 2 },               // high rail → elevate honored
    { beat: 102, type: 0, row: 5, _orbit: 'parallel', _lyricMotion: 'spin', _lyricBy: 'orbit' },
    { beat: 97, type: 1, row: 4, railEndBeat: 101, _lyricMotion: 'spin', _lyricBy: 'rail' },   // overlaps the window
    { beat: 131, type: 1, row: 4, _lyricMotion: 'spin', _lyricBy: 'orbit' },      // wrong action for the wave cue
  ];
  const r = L.lyricCueReport(cues, notes, walls, bps);
  assert.equal(r.total, 5);
  assert.equal(r.honored, 3);
  assert.deepEqual(r.missed_sec, [30, 65]);                     // lean wall 2 s late; wave never drawn
  const spin = r.cues.find(c => c.action === 'spin');
  assert.equal(spin.kind, 'motion');
  assert.equal(spin.endSec, 55);
  assert.equal(spin.by, 'orbit+rail');
  assert.equal(r.cues.find(c => c.action === 'elevate').lyric, 'I climb the altar and…');
  assert.equal(L.lyricCueReport([], notes, walls, bps).total, 0);
  // the cue's own injected wall, slot-shifted 2 beats, counts; an auto wall that far does not
  const shifted = [{ beat: 40, action: 'crouch', lyric: 'get down' }];
  assert.equal(L.lyricCueReport(shifted, [], [{ beat: 42, wallType: 'crouch', fromLyric: 'get down' }], bps).honored, 1);
  assert.equal(L.lyricCueReport(shifted, [], [{ beat: 42, wallType: 'crouch' }], bps).honored, 0);
});

test('lift: a sung rise with no rising rail ramps each hand up to the top row', () => {
  const mk = () => [
    ...[100, 101, 102, 103].map(beat => ({ beat, type: 0, row: 7, _x: L.COL_X[8], _denseSweep: true })),
    ...[100.5, 101.5, 102.5].map(beat => ({ beat, type: 1, row: 6, _x: L.COL_X[3] })),
    { beat: 101, type: 1, row: 6, _x: L.COL_X[3], _orbit: 'parallel' },          // circles are never moved
    { beat: 106, type: 0, row: 7, _x: L.COL_X[10] },                             // outside the window
  ];
  const notes = mk();
  const r = L.applyLyricLift(notes, [{ beat: 100, action: 'elevate' }]);
  assert.equal(r.lifted, 1);
  const right = notes.filter(n => n.type === 0 && n.beat <= 103).map(n => n.row);
  assert.deepEqual(right, [6, 5, 3, 2]);                                         // monotone rise to LYRIC_LIFT_TOP
  assert.ok(notes.filter(n => n._lyricBy === 'lift').every(n => !n._denseSweep));
  assert.equal(colOfX(notes[3]._x), 9);                                         // face zone: stepped out to the right
  assert.equal(notes.find(n => n._orbit).row, 6);
  assert.equal(notes.find(n => n.beat === 106).row, 7);
  const rep = L.lyricCueReport([{ beat: 100, action: 'elevate', lyric: 'rise' }], notes, [], 2);
  assert.equal(rep.cues[0].by, 'lift');
  // a rising rail already answers the cue: nothing moves
  const withRail = [...mk(), { beat: 101, type: 1, row: 5, railEndBeat: 104, railEndRow: 2 }];
  assert.equal(L.applyLyricLift(withRail, [{ beat: 100, action: 'elevate' }]).lifted, 0);
  assert.ok(withRail.every(n => !n._lyricMotion));
});

test('generator: lyric walls survive spacing dedup and hold-merge (source checks)', async () => {
  const { appSource, extract } = await import('./harness.mjs');
  const src = extract(appSource(), 'onsetsToNotes');
  assert.match(src, /autoWalls\.splice\(cur\.fromLyric \? i - 1 : i, 1\)/);
  assert.match(src, /if \(next\.fromLyric && cur\.beat \+ cap < next\.beat \+ 1\) \{ i\+\+; continue; \}/);
  assert.match(src, /avoid: elevateCues\.map/);
});

// ── [Orbit] prefers a sung spin window ─────────────────────────────────────────────────────
const O = load(['COL_X', 'OBSTACLE_BUFFER_BEATS', 'OBSTACLE_LEAD_BEATS', 'CROSS_REACH_COLS', 'handZoneCols',
  'OBS_AEROBIC_REACH', 'OBS_REACH', 'obstacleSide', 'obstacleReachBand',
  'isPattern', 'smoothPatternBoundaries', 'ORBIT_VARIANTS', 'ORBIT_GEOM', 'ORBIT_PERIODS', 'ORBIT_NPR',
  'ORBIT_NPR_MIN', 'ORBIT_NPR_MAX', 'ORBIT_TURN_SEC_MIN', 'ORBIT_TURN_SEC_MAX', 'ORBIT_MIN_TURNS',
  'ORBIT_MAX_TURNS', 'ORBIT_MIN_NOTES', 'ORBIT_JOIN_GAP', 'ORBIT_SPACING', 'ORBIT_MAX_SHARE', 'ORBIT_PREF_EXTRA',
  'railPosAt', '_htCol', 'handTrajectory', 'C3_MIN_GAP_SEC', 'c3TooFast', 'buildRailsByHand', 'c3Pos', 'c3Movable', 'c3Jump',
  'orbitPoint', 'orbitPeriods', 'applyOrbitPhrases', 'SPIN_FILL_MIN_SEC', 'SPIN_FILL_MIN_BEATS', 'SPIN_FILL_MAX_NPS',
  'fillSpinWindows', 'restoreSpinFill']);

// Two phrases: a long one at beats 0-15.5 and a shorter one at 40-47.5. With a budget that fits
// only one, the fuller phrase wins — unless the singer is circling over the shorter one.
function stream() {
  const notes = [];
  const add = (b0, b1) => { for (let b = b0; b <= b1 + 1e-9; b += 0.5) notes.push({ beat: b, type: (b * 2) % 2, row: 5, _x: 0 }); };
  add(0, 15.5); add(40, 47.5);
  return notes;
}
test('orbit: a phrase on a sung spin line is chosen before a fuller one', () => {
  const share = 33 / 48;                                       // room for the 32-note phrase only
  const plain = stream();
  const r0 = O.applyOrbitPhrases(plain, { bps: 2, maxShare: share });
  assert.equal(r0.phrases, 1);
  assert.equal(r0.preferred, 0);
  assert.ok(plain.filter(n => n._orbit).every(n => n.beat < 20));
  const sung = stream();
  const r1 = O.applyOrbitPhrases(sung, { bps: 2, maxShare: share, prefer: [[41, 46]] });
  assert.equal(r1.preferred, 1);
  assert.ok(sung.filter(n => n._orbit && n.beat >= 40).length >= 12, 'the sung window is a circle');
});
test('orbit: no circle covers an avoided (sung rise) span', () => {
  const notes = stream();
  O.applyOrbitPhrases(notes, { bps: 2, maxShare: 1, avoid: [[4, 8]] });
  assert.ok(notes.filter(n => n._orbit).every(n => n.beat < 4 || n.beat > 8));
});

// ── [SpinFill] ───────────────────────────────────────────────────────────────────────────
test('spin fill: a sparse sung line gets a steady stream, the circle takes it, a lone gold becomes a pair', () => {
  // 3 notes + a lone gold in a 6-beat sung window at 1.7 bps (half-beat step = 0.29 s >= 0.25 s)
  const notes = [{ beat: 100, type: 0, row: 5, _x: O.COL_X[10] }, { beat: 101.5, type: 1, row: 5, _x: O.COL_X[4] },
                 { beat: 103, type: 0, row: 5, _x: O.COL_X[10] }, { beat: 104, type: 3, row: 5, _x: 0 }];
  const fill = O.fillSpinWindows(notes, [{ beat: 100, endBeat: 106, action: 'spin' }], { bps: 1.7 });
  assert.equal(fill.demoted.length, 1);
  assert.ok(!notes.some(n => n.type === 3));
  for (const h of [0, 1]) {
    const hb = notes.filter(n => n.type === h).map(n => n.beat).sort((a, b) => a - b);
    for (let i = 1; i < hb.length; i++) assert.ok(hb[i] - hb[i - 1] <= 0.5 + 1e-9, `hand ${h} gap at ${hb[i]}`);
  }
  const orb = O.applyOrbitPhrases(notes, { bps: 1.7, maxShare: 1, prefer: [[100, 106]] });
  assert.equal(orb.preferred, 1);
  const r = O.restoreSpinFill(notes, fill);
  assert.ok(r.kept > 10);
  assert.ok(notes.every(n => !n._spinFill || n._orbit), 'no stray fill notes');
  assert.equal(r.demoted + r.restored, 1);
});

test('spin fill: nothing is left behind when no circle forms; the gold comes back', () => {
  const notes = [{ beat: 100, type: 0, row: 5, _x: O.COL_X[10] }, { beat: 104, type: 3, row: 4, _x: 0 }];
  const before = JSON.stringify(notes);
  const fill = O.fillSpinWindows(notes, [{ beat: 100, endBeat: 106, action: 'spin' }], { bps: 1.7 });
  assert.ok(fill.added.length > 0);
  O.restoreSpinFill(notes, fill);                                // [Orbit] never ran: nothing on a circle
  assert.equal(JSON.stringify(notes.sort((a, b) => a.beat - b.beat)), before);
  // a rail or a side wall in the window: no fill at all
  const railed = [{ beat: 99.5, type: 0, row: 5, railEndBeat: 102 }];
  assert.equal(O.fillSpinWindows(railed, [{ beat: 100, endBeat: 106, action: 'spin' }], { bps: 1.7 }).added.length, 0);
  assert.equal(O.fillSpinWindows([], [{ beat: 100, endBeat: 106, action: 'spin' }],
    { bps: 1.7, walls: [{ beat: 102, duration: 1, wallType: 'leanLeft' }] }).added.length, 0);
  // fast songs step a whole beat (half a beat would be < 0.25 s apart)
  const fast = O.fillSpinWindows([], [{ beat: 0, endBeat: 6, action: 'spin' }], { bps: 2.9 });
  assert.deepEqual([...new Set(fast.added.map(n => n.beat))], [0, 1, 2, 3, 4, 5, 6]);
});
