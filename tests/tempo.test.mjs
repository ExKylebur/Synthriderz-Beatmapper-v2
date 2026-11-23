// Tempo precision (2026-11-21). librosa's beat_track tempo is a lag bin, 60·22050/(512·lag):
// 4-5% steps near 100-120 BPM, so a 120-BPM song read 117.45 and the snap grid slid ~9 beats
// over the song. server.fold_tempo refines it by epoch-folding the onset envelope, and
// reconcileBpm lets a lookup / library value pick only the OCTAVE of that measurement.
// These tests run the REAL server functions on a synthetic click track with a known tempo and
// phase, and the REAL reconcileBpm from the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { load, ROOT } from './harness.mjs';

const { reconcileBpm, pickBpmCandidate, isLagBinBpm } = load(['BPM_REF_AGREE', 'BPM_BIN_AGREE',
  'isLagBinBpm', 'reconcileBpm', 'pickBpmCandidate']);

function py(code) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})\n`;
  const out = execFileSync('py', ['-3.12', '-I', '-c', prelude + code],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// ── reconcileBpm (app) ───────────────────────────────────────────────────────
// Electric Love: listed 120, stored as the 117.45 bin; the file measures 119.88.
const ELECTRIC = { raw_bpm: 117.45, bpm: 119.878, phase: 0.235, candidates: [59.94, 119.88] };

test('measured tempo wins over a lookup that agrees within 2%', () => {
  const r = reconcileBpm(ELECTRIC, 120);
  assert.deepEqual([r.bpm, r.source, r.agree], [119.88, 'measured', true]);
  assert.deepEqual([reconcileBpm(ELECTRIC, 60).bpm, reconcileBpm(ELECTRIC, 60).agree], [59.94, true]);
});

// Caught live 2026-11-21: the library's 117.45 is 2.07% from 119.88, so a flat 2% window
// kept the stale bin when the "Load from library" banner was clicked.
test('a stored lag-bin value agrees over half a bin (5%), so the measurement replaces it', () => {
  assert.equal(isLagBinBpm(117.45), true);
  assert.equal(isLagBinBpm(58.73), true);      // half of 117.45, as the octave family stores it
  assert.equal(isLagBinBpm(184.57), true);     // Another Life's stored double-time bin
  assert.equal(isLagBinBpm(120), false);
  assert.equal(isLagBinBpm(119.88), false);
  const r = reconcileBpm(ELECTRIC, 117.45);
  assert.deepEqual([r.bpm, r.source, r.agree], [119.88, 'measured', true]);
  // ...while a human value at the same distance is still a conflict
  assert.equal(reconcileBpm(ELECTRIC, 117.4).agree, false);
});

test('the lookup still picks the octave of the measurement', () => {
  const life = { raw_bpm: 92.29, bpm: 93.066, candidates: [93.07, 186.13] };
  const r = reconcileBpm(life, 186.9);
  assert.deepEqual([r.bpm, r.agree], [186.13, true]);
  // unrounded octave: 2 x 93.066 = 186.132 -> 186.13, not 2 x the rounded 93.07 = 186.14
  assert.equal(reconcileBpm(life, 93).bpm, 93.07);
});

test('a non-octave lookup is a conflict, not a snap', () => {
  const r = reconcileBpm({ bpm: 102.857, candidates: [102.86, 205.71] }, 144);
  assert.equal(r.agree, false);
  // 2-3%: no longer "agree" (the old rule snapped anything within 5%)
  assert.equal(reconcileBpm(ELECTRIC, 123.5).agree, false);
});

test('bin-only response (old server): the reference wins within 5%', () => {
  const bins = { raw_bpm: 117.45, candidates: [58.73, 117.45] };
  assert.deepEqual(Object.values(reconcileBpm(bins, 120)).slice(0, 3), [120, 'reference', true]);
  assert.equal(reconcileBpm(bins, 150).agree, false);
  // what the old inline reconcile did: snap the precise lookup back onto the bin
  assert.equal(pickBpmCandidate(bins.candidates, 120), 117.45);
});

test('no reference or no candidates -> null', () => {
  assert.equal(reconcileBpm(ELECTRIC, null), null);
  assert.equal(reconcileBpm(null, 120), null);
  assert.equal(reconcileBpm({ candidates: [] }, 120), null);
});

// ── server.fold_tempo / detect_bpm_librosa on a synthetic click track ────────
// 123.45 BPM, first beat at 0.200 s, 90 s. Every 7th beat missing, quieter off-beat ghost
// clicks, a little noise. 123.45 sits between the 123.05 and 129.2 lag bins.
const TRUE_BPM = 123.45, TRUE_PHASE = 0.2;
const srv = py(`
import numpy as np, librosa, soundfile as sf, tempfile, os, server
SR = 22050; bpm, phase, dur = ${TRUE_BPM}, ${TRUE_PHASE}, 90.0
P = 60 / bpm
beats = np.arange(phase, dur - 0.2, P)
on = beats[np.arange(len(beats)) % 7 != 3]
y = librosa.clicks(times=on, sr=SR, length=int(dur * SR), click_duration=0.03)
y += 0.35 * librosa.clicks(times=beats[:-1] + P / 2, sr=SR, length=int(dur * SR), click_duration=0.03)
y += np.random.default_rng(1).normal(0, 0.003, len(y))
env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=server.TEMPO_HOP)
bin_guess = 60 * SR / (512 * round(60 * SR / (512 * bpm)))
fit = server.fold_tempo(env, server.TEMPO_HOP / SR, bin_guess)
d = tempfile.mkdtemp(); p = os.path.join(d, 'clicks.wav'); sf.write(p, y, SR)
det = server.detect_bpm_librosa(p)
os.remove(p); os.rmdir(d)
print(json.dumps({'bin_guess': bin_guess, 'fit': fit, 'det': det}))
`);

test('fold_tempo recovers tempo and phase from a lag-bin guess', () => {
  const { fit, bin_guess } = srv;
  assert.ok(Math.abs(bin_guess - TRUE_BPM) > 0.3, `guess ${bin_guess} should be a bin, not the answer`);
  assert.ok(Math.abs(fit.bpm - TRUE_BPM) < 0.02, `bpm ${fit.bpm}`);
  // phase: the click onset, latency-corrected (ONSET_ENV_LATENCY). Error budget 6 ms (measured ±3.4 ms at 89-172 BPM).
  assert.ok(Math.abs(fit.phase - TRUE_PHASE) < 0.006, `phase ${fit.phase}`);
  assert.ok(fit.confidence > 2, `confidence ${fit.confidence}`);
  assert.equal(fit.drift.length, 4);
  assert.ok(fit.drift.every(q => Math.abs(q) < 0.03), `drift ${fit.drift}`);
});

test('detect_bpm_librosa returns the refined bpm, phase and its octave family', () => {
  const { det } = srv;
  assert.ok(Math.abs(det.bpm - TRUE_BPM) < 0.02, `bpm ${det.bpm} (raw ${det.raw_bpm})`);
  assert.ok(Math.abs(det.phase - TRUE_PHASE) < 0.006, `phase ${det.phase}`);
  assert.ok(det.candidates.some(c => Math.abs(c - det.bpm) < 0.006), `cands ${det.candidates}`);
  for (const c of det.candidates) {
    const m = c / det.bpm;
    assert.ok([0.25, 0.5, 1, 2, 4].some(k => Math.abs(m - k) < 1e-3), `${c} not an octave`);
  }
  assert.ok(Math.abs(det.duration - 90) < 0.05);
  // one folded phase per candidate, keyed by its 2-dp string
  assert.deepEqual(Object.keys(det.phases).sort(), det.candidates.map(c => c.toFixed(2)).sort());
});

// Half-time phase (2026-11-22, Echolokators: measured 152, mapped at 76, +0.5 beat off). A 150-BPM
// click track whose even beats are loud and odd beats soft: at 75 BPM the strong beats (0.25 s +
// k·0.8 s) must be beat 1, whichever octave the tracker measures.
const halfTime = py(`
import numpy as np, librosa, soundfile as sf, tempfile, os, server
SR = 22050; dur = 60.0; P = 60 / 150
beats = np.arange(0.25, dur - 0.2, P)
strong, weak = beats[0::2], beats[1::2]
y = librosa.clicks(times=strong, sr=SR, length=int(dur * SR), click_duration=0.03)
y += 0.35 * librosa.clicks(times=weak, sr=SR, length=int(dur * SR), click_duration=0.03)
y += np.random.default_rng(2).normal(0, 0.003, len(y))
d = tempfile.mkdtemp(); p = os.path.join(d, 'half.wav'); sf.write(p, y, SR)
det = server.detect_bpm_librosa(p)
os.remove(p); os.rmdir(d)
print(json.dumps(det))
`);

test('detect_bpm_librosa: the half-time candidate gets the STRONG beat phase', () => {
  const key = Object.keys(halfTime.phases).find(k => Math.abs(+k - 75) < 0.1);
  assert.ok(key, `no ~75 candidate in ${JSON.stringify(halfTime.phases)} (measured ${halfTime.bpm})`);
  const P = 60 / +key, ph = halfTime.phases[key];
  const d = Math.abs(((ph - 0.25) / P + 0.5) % 1 - 0.5) * P;        // seconds from the strong clicks
  assert.ok(d < 0.006, `75-BPM phase ${ph}s is ${(d * 1000).toFixed(1)} ms from the strong beats`);
});
