// Lyric movement cues (2026-11-26): vocabulary, syllable timing, vocal-onset alignment, and the
// [Orbit] preference for sung "spin" windows — all on the REAL declarations in the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const L = load(['LYRIC_CUE_VERSION', 'LYRIC_WALL_ACTIONS', 'LYRIC_MOTION_ACTIONS', 'LYRIC_LINE_MAX_SEC',
  'LYRIC_WORD_EST_SEC', 'LYRIC_LINE_SLOP_SEC', 'LYRIC_SNAP_SEC', 'LYRIC_MOTION_DEFAULT_BEATS',
  'LYRIC_RAIL_SHAPE', 'LYRIC_GOLD_SHAPE', 'LYRIC_ACTION_RULES', 'isLyricWallCue', 'isLyricMotionCue',
  'libraryLyricCues', 'lyricSyllables', 'lyricCuesFromLines', 'spaceLyricCues', 'alignLyricCues',
  'lyricMotionAt']);

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

// ── [Orbit] prefers a sung spin window ─────────────────────────────────────────────────────
const O = load(['COL_X', 'OBSTACLE_BUFFER_BEATS', 'OBSTACLE_LEAD_BEATS', 'CROSS_REACH_COLS', 'handZoneCols',
  'OBS_AEROBIC_REACH', 'OBS_REACH', 'obstacleSide', 'obstacleReachBand',
  'isPattern', 'smoothPatternBoundaries', 'ORBIT_VARIANTS', 'ORBIT_GEOM', 'ORBIT_PERIODS', 'ORBIT_NPR',
  'ORBIT_NPR_MIN', 'ORBIT_NPR_MAX', 'ORBIT_TURN_SEC_MIN', 'ORBIT_TURN_SEC_MAX', 'ORBIT_MIN_TURNS',
  'ORBIT_MAX_TURNS', 'ORBIT_MIN_NOTES', 'ORBIT_JOIN_GAP', 'ORBIT_SPACING', 'ORBIT_MAX_SHARE',
  'railPosAt', '_htCol', 'handTrajectory', 'C3_MIN_GAP_SEC', 'c3TooFast', 'buildRailsByHand', 'c3Pos', 'c3Movable', 'c3Jump',
  'orbitPoint', 'orbitPeriods', 'applyOrbitPhrases']);

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
