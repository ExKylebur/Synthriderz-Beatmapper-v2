// Map score v2 (2026-11-21). v1 averaged four LLM sub-scores: 43 clean runs sat at 75 ± 2.8
// (68–79), and it scored Electric Love's beat-1 pad fix DOWN (79 → 74) because the critic is
// sent no timing. v2 = measured components (timing, flow, playability, structure, density/
// energy sync) + the LLM sub-scores rescaled against their history. These tests run the REAL
// app helpers on numbers measured from real exports (validate.py + --timing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const S = load(['SCORE_VERSION', 'SCORE_WEIGHTS', 'SCORE_CRIT_CAP', 'LLM_SCORE_HISTORY', 'LLM_SCORE_MIX',
  'SCORE_NPS_SOFT', 'SCORE_OBSTACLE_BAND', 'scoreRamp', 'scoreBand', 'scoreMix', 'timingInputs',
  'timingScore', 'densityEnergyR', 'scoreComponents', 'llmComponent', 'computeMapScore',
  'DNF_GOLD_MIN_PCT', 'DNF_GOLD_OK_PCT', 'stripDoNotFlag', 'bestIterOf',
  'BEAT_PAD_OCTAVE_TOL', 'beatPadSecs']);

// Electric Love as measured live (/detect_bpm) and its export's deterministic stats
// (debug_last_export.synth, 2026-11-21 21:48Z: 787 notes, 0 HARD).
const EL_SRV = { bpm: 119.878, phase: 0.2304, duration: 220.787, confidence: 2.95, drift: [0.004, -0.002, 0.003, 0.001] };
const EL_INPUTS = { difficulty: 'Master', arc: 95, flatMax: 9, maxNps: 12, maxGapSec: 3.5, railPct: 4.1,
  specialPct: 11.1, balancePct: 50, obstaclesPerMin: 11.4, densityEnergyR: 0.16 };
const EL_SUB = { flow: 88, energy: 72, diff: 74, stem: 48 };   // the critic's numbers for that run
const PERFECT = { difficulty: 'Master', arc: 98, flatMax: 4, maxNps: 9, maxGapSec: 2, railPct: 10,
  specialPct: 10, balancePct: 50, obstaclesPerMin: 8, densityEnergyR: 0.8 };
const ON_GRID = { phase: 0, slide: 0, worstQuarter: 0.01, confidence: 2.5 };

test('weights sum to 1 and the critical cap sits below the pass mark', () => {
  const sum = Object.values(S.SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum ${sum}`);
  assert.equal(S.SCORE_CRIT_CAP, 59);
  assert.equal(S.SCORE_VERSION, 2);
});

test('ramps: clamped, either direction, null for missing inputs', () => {
  assert.equal(S.scoreRamp(90, 80, 96), 0.625);
  assert.equal(S.scoreRamp(70, 80, 96), 0);
  assert.equal(S.scoreRamp(5, 12, 5), 1);           // lower is better
  assert.equal(S.scoreRamp(undefined, 0, 1), null);
  assert.equal(S.scoreBand(10, 1, 5, 20, 30), 1);
  assert.equal(S.scoreBand(25, 1, 5, 20, 30), 0.5);
  assert.equal(S.scoreBand(3, 1, 5, 20, 30), 0.5);
  // an unmeasured input drops out and its weight is shared, it doesn't count as 0
  assert.equal(S.scoreMix([[1, 0.5], [null, 0.5]]), 1);
  assert.equal(S.scoreMix([[null, 1]]), null);
});

test('perfect measured inputs score 100; a CRITICAL caps it at 59', () => {
  const sub = { flow: 97, energy: 82, diff: 85, stem: 72 };   // ~+2 sd on every LLM dim
  const r = S.computeMapScore({ inputs: PERFECT, timing: ON_GRID, sub });
  assert.equal(r.score, 100);
  assert.deepEqual(Object.keys(r.components), Object.keys(S.SCORE_WEIGHTS));
  assert.equal(S.computeMapScore({ inputs: PERFECT, timing: ON_GRID, sub, hasCritical: true }).score, 59);
  // below the cap a critical map keeps its own (lower) score, so critical maps still rank
  const awful = { difficulty: 'Master', arc: 70, flatMax: 20, maxNps: 20, maxGapSec: 10, railPct: 0,
    specialPct: 0, balancePct: 30, obstaclesPerMin: 0, densityEnergyR: -0.2 };
  const bad = S.computeMapScore({ inputs: awful, timing: null, sub: null, hasCritical: true });
  const worse = S.computeMapScore({ inputs: { ...awful, arc: 60 }, timing: null, sub: null, hasCritical: true });
  assert.equal(bad.score, 0);
  const midCrit = S.computeMapScore({ inputs: { ...awful, arc: 96, flatMax: 5 }, timing: null, sub: null, hasCritical: true });
  assert.ok(midCrit.score > worse.score && midCrit.score < 59, `critical maps rank ${worse.score} < ${midCrit.score}`);
});

test('Electric Love: the measured +0.465-beat grid offset is reproduced, and the pad fix now scores HIGHER', () => {
  const before = S.timingInputs(119.88, EL_SRV, 0);                       // map before the beat-1 pad
  assert.ok(Math.abs(before.phase - 0.465) < 0.01, `phase ${before.phase} (validate --timing said +0.465)`);
  const pad = S.beatPadSecs(119.88, EL_SRV);
  const after = S.timingInputs(119.88, EL_SRV, pad);
  assert.ok(Math.abs(after.phase) < 0.01, `phase after pad ${after.phase}`);
  assert.ok(Math.abs(after.slide) < 0.25, `slide ${after.slide}`);
  const v2Before = S.computeMapScore({ inputs: EL_INPUTS, timing: before, sub: { flow: 94, energy: 78, diff: 68, stem: 62 } });
  const v2After = S.computeMapScore({ inputs: EL_INPUTS, timing: after, sub: EL_SUB });
  // v1 for the same two runs: 79 → 74 (the critic liked the off-beat map better)
  assert.ok(v2After.score >= v2Before.score + 8, `v2 ${v2Before.score} → ${v2After.score}`);
  assert.equal(v2After.components.timing, 100);
});

test('a library bin BPM (117.45 vs measured 119.878) slides ~9 beats: timing 0 although mid-song lines up', () => {
  const t = S.timingInputs(117.45, EL_SRV, 0);
  assert.ok(t.slide < -8 && t.slide > -10, `slide ${t.slide}`);
  assert.ok(Math.abs(t.phase) < 0.1, `mid-song phase ${t.phase} happens to line up`);
  assert.equal(S.timingScore(t), 0);
  // the 2-dp BPM field (119.88 vs 119.878) is not a slide
  assert.ok(S.timingScore(S.timingInputs(119.88, EL_SRV, S.beatPadSecs(119.88, EL_SRV))) > 0.99);
});

test('no tempo measurement drops timing out instead of penalising', () => {
  assert.equal(S.timingInputs(120, null, 0), null);
  assert.equal(S.timingInputs(120, { candidates: [117.45] }, 0), null);   // old server: no phase
  const r = S.computeMapScore({ inputs: PERFECT, timing: null, sub: null });
  assert.equal(r.components.timing, null);
  assert.equal(r.components.llm, null);
  assert.equal(r.score, 100);
});

test('passScore: timing can lift a map over the pass mark but never hold it under', () => {
  // timing is fixed per song, so regenerating can't change it: the loop gates on passScore
  const offBeat = S.computeMapScore({ inputs: EL_INPUTS, timing: { phase: 0.45, slide: 9, worstQuarter: 0.48, confidence: 2.9 }, sub: EL_SUB });
  const noTiming = S.computeMapScore({ inputs: EL_INPUTS, timing: null, sub: EL_SUB });
  assert.ok(offBeat.score < noTiming.score, `${offBeat.score} < ${noTiming.score}`);
  assert.equal(offBeat.passScore, noTiming.score);
  const onBeat = S.computeMapScore({ inputs: EL_INPUTS, timing: ON_GRID, sub: EL_SUB });
  assert.equal(onBeat.passScore, onBeat.score);
  assert.ok(onBeat.score > noTiming.score);
  const crit = S.computeMapScore({ inputs: PERFECT, timing: ON_GRID, sub: null, hasCritical: true });
  assert.equal(crit.passScore, 59);
});

test('a weak beat (live recording) shrinks timing toward 0.6 either way', () => {
  const good = S.timingScore({ ...ON_GRID, confidence: 1.1 });
  const bad = S.timingScore({ phase: 0.4, slide: 3, worstQuarter: 0.45, confidence: 1.1 });
  assert.ok(Math.abs(good - 0.8) < 1e-9 && Math.abs(bad - 0.3) < 1e-9, `${good} ${bad}`);
});

test('measured flow drives the score: Painkiller arc 91 -> 98 (the C3 "new fix") scores higher', () => {
  const pk = { ...EL_INPUTS, arc: 91, flatMax: 9 };
  const a = S.computeMapScore({ inputs: pk, timing: ON_GRID, sub: EL_SUB });
  const b = S.computeMapScore({ inputs: { ...pk, arc: 98 }, timing: ON_GRID, sub: EL_SUB });
  assert.ok(b.score > a.score, `${a.score} → ${b.score}`);
  assert.ok(b.components.flow > a.components.flow);
});

test('LLM sub-scores are rescaled against their own palette and can move the score by at most 15', () => {
  const mean = Object.fromEntries(Object.entries(S.LLM_SCORE_HISTORY).map(([k, [mu]]) => [k, mu]));
  assert.ok(Math.abs(S.llmComponent(mean) - 0.5) < 1e-9);
  // the palette's favourite numbers read as roughly typical, not as "good"
  assert.ok(Math.abs(S.llmComponent(EL_SUB) - 0.5) < 0.1, `palette ${S.llmComponent(EL_SUB)}`);
  const lo = S.computeMapScore({ inputs: EL_INPUTS, timing: ON_GRID, sub: { flow: 0, energy: 0, diff: 0, stem: 0 } });
  const hi = S.computeMapScore({ inputs: EL_INPUTS, timing: ON_GRID, sub: { flow: 100, energy: 100, diff: 100, stem: 100 } });
  assert.ok(hi.score - lo.score <= 15, `LLM swing ${lo.score} → ${hi.score}`);
  assert.equal(S.llmComponent(null), null);
});

test('density/energy correlation: follows, opposes, skips silence, null when too short', () => {
  const bps = 2, wb = 8;                    // 4 s windows = 8 beats at 120 BPM
  const energy = [], beats = [];
  for (let k = 0; k < 10; k++) {
    const e = k === 0 ? 0 : (k % 3) + 1;    // window 0 is silent
    for (let i = 0; i < wb; i++) energy.push(e / 3);
    for (let n = 0; n < e * 4; n++) beats.push(k * wb + n * wb / (e * 4 + 1));
  }
  assert.ok(S.densityEnergyR(beats, energy, bps) > 0.99);
  const inverse = beats.filter(b => b >= wb).map(b => b);   // same counts, inverted energy below
  const invEnergy = energy.map((e, i) => (i < wb ? 0 : 1.4 - e));
  assert.ok(S.densityEnergyR(inverse, invEnergy, bps) < -0.9);
  assert.equal(S.densityEnergyR(beats, energy.slice(0, 20), bps), null);
  assert.equal(S.densityEnergyR(beats, [], bps), null);
});

test('scoreComponents scales the density cap and obstacle band by tier', () => {
  const easy = S.scoreComponents({ difficulty: 'Easy', maxNps: 7, maxGapSec: 2 }, null);
  const master = S.scoreComponents({ difficulty: 'Master', maxNps: 7, maxGapSec: 2 }, null);
  assert.ok(easy.play < master.play, `${easy.play} vs ${master.play}`);
  const unknown = S.scoreComponents({ difficulty: 'Custom', maxNps: 7, maxGapSec: 2 }, null);
  assert.equal(unknown.play, master.play);                          // unknown tier → Master bands
  assert.equal(S.scoreComponents({}, null).struct, null);
});

test('DO-NOT-FLAG strip: real critic lines about squat underrails and 8–9% gold are dropped', () => {
  const lines = [
    'CRITICAL: C4 — Ceiling (row 0) is 3% of notes (limit 2%)',
    'Squat coverage 67% vs 100% target — 33% of squats lack underrails; reachability risk during crouch obstacles.',
    'squats_with_underrail_pct 25% — target 100% (mechanically enforced); 9 of 12 squats lack underrails.',
    'Gold 9% vs 5% target — 80% over-concentration; review gold placement for C2 clearance and pattern coherence.',
    'gold_pct: reduce from 9% to 5% — consolidate gold runs into 3–5 dedicated sweeps per chorus; verify C2 clearance',
    'Rail% 2% vs 5-20% target — verses/pre-chorus severely under-railed; vocals stem 69% rail but only 16 notes (2%) of map.',
    'Flat runs: right hand 7 consecutive, left hand 8 consecutive — introduce row variation.',
  ];
  const r = S.stripDoNotFlag(lines, 8.6);
  assert.deepEqual(r.kept, [lines[0], lines[5], lines[6]]);
  assert.equal(r.dropped.length, 4);
  // gold complaints stand when gold really is high, or when the line asks for MORE gold
  assert.equal(S.stripDoNotFlag([lines[3]], 20).kept.length, 1);
  assert.equal(S.stripDoNotFlag(['gold_pct: increase from 3% to 6% in chorus2'], 3).kept.length, 1);
  assert.equal(S.stripDoNotFlag(['gold_pct: increase gold from 5% to 8%'], 5).kept.length, 1);
  assert.equal(S.stripDoNotFlag(['CRITICAL: squat 3 note unreachable during crouch'], 8).kept.length, 1);
  assert.deepEqual(S.stripDoNotFlag(undefined, 8), { kept: [], dropped: [] });
});

test('bestIterOf reports the LAST isBest iteration (find() always said 1)', () => {
  const log = [{ iter: 1, isBest: true }, { iter: 2, isBest: false }, { iter: 3, isBest: true }, { iter: 4, isBest: false }];
  assert.equal(S.bestIterOf(log), 3);
  assert.equal(S.bestIterOf([{ iter: 1, isBest: false }]), null);
  assert.equal(S.bestIterOf([]), null);
});
