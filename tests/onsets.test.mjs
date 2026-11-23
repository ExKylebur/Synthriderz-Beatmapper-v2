// Per-stem onsets lock to the music (2026-11-21). The old detector (detect_onsets_np on a 10 ms
// RMS envelope, first frame over mean + 1.2σ) was random against the beat on real Demucs stems:
// beat-phase locking 0.02-0.09 on Electric Love / Painkiller / Resist and Disorder. analyse_stems
// now uses stem_onsets (peak-picked SuperFlux, latency-corrected). These tests run the REAL
// server functions and score them with the REAL onset_phase_lock:
//   1. a synthetic 4-stem song on a known grid (always runs): every stem must lock to its
//      grid AND sit on the hits (offset). The legacy detector scores 33-45 ms late here, and its
//      bass lock is 0.37;
//   2. real full mixes from ..\MP3 (skipped when the files are absent), on the folded grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './harness.mjs';

function py(code) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})\n`;
  const out = execFileSync('py', ['-3.12', '-I', '-c', prelude + code],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// ── onset_phase_lock itself ───────────────────────────────────────────────────
const lockStat = py(`
import numpy as np, server
P = 0.5; rng = np.random.default_rng(3)
grid16 = 0.2 + P / 4 * np.arange(400) + rng.normal(0, 0.003, 400)        # 16ths, 3 ms jitter
trip = 0.2 + P / 3 * np.arange(400)                                        # triplets
late = grid16 + 0.020                                                       # 20 ms latency error
rand = rng.uniform(0, 200, 800)
f = lambda t: server.onset_phase_lock(t, 120.0, 0.2)
print(json.dumps({'g16': f(grid16), 'trip': f(trip), 'late': f(late), 'rand': f(rand), 'empty': f([])}))
`);

test('onset_phase_lock: 16ths, triplets, a latency error and random onsets', () => {
  const { g16, trip, late, rand, empty } = lockStat;
  assert.ok(g16.R[3] > 0.95 && g16.lock_k === 4 && Math.abs(g16.offset_ms) < 1, JSON.stringify(g16));
  assert.equal(g16.hist.reduce((a, b) => a + b, 0), 400);
  // every onset in the bin at or just before a 16th (the ±3 ms jitter straddles the bin edge)
  assert.equal(g16.hist.filter((v, i) => i % 4 === 0 || i % 4 === 3).reduce((a, b) => a + b, 0), 400);
  assert.ok(trip.R[2] > 0.99 && trip.lock_k === 3 && trip.R[3] < 0.1, JSON.stringify(trip.R));
  // a constant latency still LOCKS; the offset is what exposes it
  assert.ok(late.lock > 0.9 && Math.abs(late.offset_ms - 20) < 1, JSON.stringify(late));
  assert.ok(rand.lock < 3 * rand.random, `random lock ${rand.lock} vs floor ${rand.random}`);
  assert.equal(empty.n, 0);
});

// ── synthetic 4-stem song: real analyse_stems on Demucs-shaped WAVs ──────────
// 117 BPM, first beat at 0.37 s, 40 s. Drums: kick every beat, snare on 2 & 4, hats on 8ths, plus
// bleed (55 Hz drone + noise). Bass: legato saw with a new pitch on 3 of every 4 8ths, never
// silent, so 10 ms RMS frames wobble. Vocals: vibrato tone, a note on each beat, phrases of 6.
// Other: plucks on 8ths over a sustained pad.
const BPM = 117, PHASE = 0.37;
const synth = py(`
import numpy as np, soundfile as sf, tempfile, os, server
SR = 44100; bpm, phase, dur = ${BPM}, ${PHASE}, 40.0
P = 60 / bpm; n = int(dur * SR); tt = np.arange(n) / SR
rng = np.random.default_rng(7)
burst = lambda d: np.arange(int(d * SR)) / SR
def ad(d, att, dec):
    t = burst(d); return np.minimum(t / att, 1) * np.exp(-np.maximum(t - att, 0) / dec)
def add(y, t0, b):
    i = int(round(t0 * SR)); j = min(n, i + len(b)); y[i:j] += b[:j - i]
beats = phase + P * np.arange(int((dur - phase - 1) / P))
eighths = phase + P / 2 * np.arange(int((dur - phase - 1) / (P / 2)))
kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-burst(0.25) / 0.03)) * burst(0.25)) * ad(0.25, 0.002, 0.10)
snare = rng.normal(0, 0.6, int(0.2 * SR)) * ad(0.2, 0.001, 0.06) + 0.4 * np.sin(2 * np.pi * 190 * burst(0.2)) * ad(0.2, 0.001, 0.08)
hat = np.diff(rng.normal(0, 0.5, int(0.05 * SR) + 1)) * ad(0.05, 0.0005, 0.012)
drums = np.zeros(n)
for k, b in enumerate(beats):
    add(drums, b, kick)
    if k % 2 == 1: add(drums, b, snare)
for e in eighths: add(drums, e, 0.5 * hat)
drums += 0.05 * np.sin(2 * np.pi * 55 * tt) + rng.normal(0, 0.003, n)
f = np.full(n, 55.0); amp = np.zeros(n)
notes = [41.2, 55.0, 49.0, 61.7, 46.2, 55.0, 73.4, 65.4]
starts = [e for k, e in enumerate(eighths) if k % 4 != 3]
for k, s in enumerate(starts):
    i = int(round(s * SR)); f[i:] = notes[k % len(notes)]
    amp[i:] = np.minimum((tt[i:] - s) / 0.008, 1) * (0.55 + 0.45 * np.exp(-(tt[i:] - s) / 0.12))
ph = 2 * np.pi * np.cumsum(f) / SR
bass = amp * sum(np.sin(h * ph) / h for h in range(1, 9)) * 0.5
vox = np.zeros(n); vstarts = []
for k, b in enumerate(beats):
    if k % 8 in (6, 7): continue
    vstarts.append(b)
    L = P * 0.95; t = burst(L); f0 = [220, 247, 262, 294, 330, 294][k % 6]
    vph = 2 * np.pi * np.cumsum(f0 * (1 + 0.017 * np.sin(2 * np.pi * 5.5 * t))) / SR
    add(vox, b, sum(np.sin(h * vph) / h ** 1.3 for h in range(1, 10)) * ad(L, 0.03, 0.8) * 0.3)
vox += rng.normal(0, 0.002, n)
other = 0.04 * sum(np.sin(2 * np.pi * fr * tt) for fr in (196, 247, 294))
for k, e in enumerate(eighths):
    fr = [392, 494, 587, 494][k % 4]
    add(other, e, sum(np.sin(2 * np.pi * fr * h * burst(0.3)) / h for h in range(1, 6)) * ad(0.3, 0.002, 0.09) * 0.25)
d = tempfile.mkdtemp(); stems = {}
for name, y in (('drums', drums), ('bass', bass), ('vocals', vox), ('other', other)):
    y = y / np.abs(y).max() * 0.8
    stems[name] = os.path.join(d, name + '.wav'); sf.write(stems[name], np.stack([y, y], 1), SR, subtype='PCM_16')
a0 = server.analyse_stems(stems, bpm, None, 0.0)
a1 = server.analyse_stems(stems, bpm, None, 0.3)
for p in stems.values(): os.remove(p)
os.rmdir(d)
res = {'truth': {'drums': len(eighths), 'bass': len(starts), 'vocals': len(vstarts), 'other': len(eighths)},
       'dur': a0['duration'], 'stems': {}}
for s in ('drums', 'bass', 'vocals', 'other'):
    o0, o1 = a0['stems'][s]['onsets'], a1['stems'][s]['onsets']
    res['stems'][s] = {'lock': server.onset_phase_lock([o['time'] for o in o0], bpm, phase),
                       'pad_lock': server.onset_phase_lock([o['time'] for o in o1], bpm, phase + 0.3),
                       'on': o0, 'on_pad': o1}
print(json.dumps(res))
`);

// Error budgets: drums/bass/other are fast attacks (measured +2.7..+3.3 ms after the latency
// correction). The vocal note has a 30 ms attack ramp, so its flux peaks at the ramp start
// (measured -13 ms); anywhere inside ±20 ms of the note start is on the hit.
const OFFSET_MS = { drums: 6, bass: 6, other: 6, vocals: 20 };

for (const s of ['drums', 'bass', 'vocals', 'other']) {
  test(`synthetic ${s} stem: onsets lock to the grid and sit on the hits`, () => {
    const { lock } = synth.stems[s];
    assert.ok(lock.lock >= 0.9, `${s} lock ${lock.lock} R=${lock.R} hist ${lock.hist}`);
    assert.ok(Math.abs(lock.offset_ms) <= OFFSET_MS[s], `${s} offset ${lock.offset_ms} ms`);
    // density: one onset per distinct hit (drums: kick/snare coincide with a hat 8th)
    const truth = synth.truth[s];
    const lo = s === 'vocals' ? 1.0 : 0.9, hi = s === 'vocals' ? 1.35 : 1.1;
    assert.ok(lock.n >= lo * truth && lock.n <= hi * truth, `${s} ${lock.n} onsets for ${truth} hits`);
  });
}

test('output shape: time order, energy 0-1, drum subtype, vocal pitch_row', () => {
  for (const [s, { on }] of Object.entries(synth.stems)) {
    on.forEach((o, i) => {
      assert.ok(o.time >= 0 && o.time < synth.dur, `${s} time ${o.time}`);
      assert.ok(o.energy >= 0 && o.energy <= 1, `${s} energy ${o.energy}`);
      if (i) assert.ok(o.time > on[i - 1].time, `${s} not in time order at ${i}`);
    });
  }
  assert.ok(synth.stems.drums.on.every(o => ['kick', 'snare', 'hat'].includes(o.subtype)));
  assert.ok(synth.stems.vocals.on.every(o => Number.isInteger(o.pitch_row) && o.pitch_row >= 0 && o.pitch_row <= 7));
  assert.ok(Object.values(synth.stems).every(({ on }) => Math.max(...on.map(o => o.energy)) === 1));
});

test('beat-1 pad: every stem\'s onsets shift by the pad and stay locked', () => {
  for (const [s, { on, on_pad, lock, pad_lock }] of Object.entries(synth.stems)) {
    assert.ok(Math.abs(on_pad.length - on.length) <= 2, `${s} ${on.length} -> ${on_pad.length}`);
    const shifts = on.map(o => {
      const m = on_pad.reduce((b, p) => Math.abs(p.time - o.time - 0.3) < Math.abs(b - o.time - 0.3) ? p.time : b, Infinity);
      return m - o.time - 0.3;
    });
    // ≥90% move by exactly the pad (±1 frame). The pad also shifts the frame sampling by a
    // fraction of a hop, so a slow vocal attack with two near-equal flux peaks (+15 / -21 ms
    // round its note, measured) can flip between them; nothing may move further than that.
    // The stem's first sample (noise starting at t=0) is an edge and is left out.
    const inner = shifts.filter((d, i) => on[i].time > 0.05);
    const off = inner.filter(d => Math.abs(d) > 0.006).length;
    assert.ok(off <= 0.1 * on.length, `${s}: ${off} of ${on.length} onsets moved by more than one frame`);
    assert.ok(inner.every(d => Math.abs(d) <= 0.04), `${s}: an onset moved by ${Math.max(...inner.map(Math.abs))} s`);
    assert.ok(Math.abs(pad_lock.lock - lock.lock) < 0.02, `${s} lock ${lock.lock} -> ${pad_lock.lock}`);
  }
});

// ── dense loud passage vs quiet passage (drum gate, 2026-11-22) ──────────────
// Painkiller at Master lost ~20% of its notes to the SuperFlux detector: in a continuous double-kick
// passage the hits raise the ±15 s mean and σ, so the weaker 16ths fell under the 1σ gate, and a
// lockout of exactly one 16th dropped 16ths that land a few ms early. The drum stem now uses an NMS
// gap of 0.8 x the lockout and z > 0.5 where the MIX is in its louder half; quiet passages keep 1σ.
// 103 BPM, 48 s, three levels so the quiet part sits clearly in the song's quieter half (the gate is
// RELATIVE to the song: a two-level 50/50 song puts its median inside the quiet level).
// 0-24 s LOUD (loud chord + bass in the other stems): a kick on every 16th, the off-16ths at 0.42 and
// 8 ms early, a snare on 2 & 4. 24-36 s medium, 36-48 s quiet: a soft hat on each 8th; the quiet
// part also has ghost hits (0.016) on the "e", z 0.70-0.86 (measured): a flat z > 0.5 gate catches
// 100% of them, the 1σ gate none.
const dense = py(`
import numpy as np, soundfile as sf, tempfile, os, server
SR = 44100; bpm, phase, dur, split = 103.0, 0.30, 48.0, 24.0
P = 60 / bpm; n = int(dur * SR); tt = np.arange(n) / SR; rng = np.random.default_rng(11)
burst = lambda d: np.arange(int(d * SR)) / SR
def ad(d, att, dec):
    t = burst(d); return np.minimum(t / att, 1) * np.exp(-np.maximum(t - att, 0) / dec)
def add(y, t0, b):
    i = int(round(t0 * SR)); j = min(n, i + len(b)); y[i:j] += b[:j - i]
kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-burst(0.2) / 0.03)) * burst(0.2)) * ad(0.2, 0.002, 0.06)
snare = rng.normal(0, 0.6, int(0.2 * SR)) * ad(0.2, 0.001, 0.05) + 0.4 * np.sin(2 * np.pi * 190 * burst(0.2)) * ad(0.2, 0.001, 0.07)
hat = np.diff(rng.normal(0, 0.5, int(0.05 * SR) + 1)) * ad(0.05, 0.0005, 0.012)
drums = np.zeros(n); slots, early, quiet, ghosts = [], [], [], []
for k, s in enumerate(phase + P / 4 * np.arange(int((dur - phase - 0.5) / (P / 4)))):
    if s < split - 0.3:
        t0 = s if k % 2 == 0 else s - 0.008
        add(drums, t0, kick * (1.0 if k % 2 == 0 else 0.42))
        if k % 8 == 4: add(drums, s, 0.8 * snare)
        slots.append(s)
        if k % 2: early.append(t0)
    elif s > split + 0.3:
        if k % 2 == 0: add(drums, s, 0.35 * hat); quiet.append(s)
        elif k % 4 == 1 and s > 37.0: add(drums, s, 0.016 * hat); ghosts.append(s)
drums += rng.normal(0, 0.002, n)
level = np.where(tt < split, 1.0, np.where(tt < 36.0, 0.4, 0.1))
other = 0.5 * level * sum(np.sin(2 * np.pi * f * tt) for f in (196, 247, 294)) / 3
bass = 0.4 * level * np.sin(2 * np.pi * 55 * tt)
d = tempfile.mkdtemp(); stems = {}
for name, y in (('drums', drums), ('bass', bass), ('vocals', rng.normal(0, 0.001, n)), ('other', other)):
    y = y / np.abs(y).max() * 0.8
    stems[name] = os.path.join(d, name + '.wav'); sf.write(stems[name], np.stack([y, y], 1), SR, subtype='PCM_16')
t = np.array([o['time'] for o in server.analyse_stems(stems, bpm, None, 0.0)['stems']['drums']['onsets']])
sig, _ = server.load_wav_mono(stems['drums'], 22050)
old = np.array([o['time'] for o in server.stem_onsets(sig, 22050, 0.25 * P)])          # 1σ gate, gap 1.0
flat = np.array([o['time'] for o in server.stem_onsets(sig, 22050, 0.25 * P, thresh=0.5, gap_tol=0.8)])
for p in stems.values(): os.remove(p)
os.rmdir(d)
hit = lambda on, ref, tol=0.02: float(np.mean([np.min(np.abs(on - s)) < tol for s in ref])) if len(on) else 0.0
A, B = t[t < split], t[t > split]
print(json.dumps({'dense': hit(A, slots), 'early': hit(A, early, 0.015), 'quiet': hit(B, quiet), 'ghost': hit(B, ghosts),
                  'old_dense': hit(old[old < split], slots), 'old_early': hit(old[old < split], early, 0.015),
                  'flat_ghost': hit(flat[flat > split], ghosts), 'n_quiet': int(len(B)), 'quiet_hits': len(quiet),
                  'n_ghosts': len(ghosts), 'lock': server.onset_phase_lock(t, bpm, phase)}))
`);

test('drum gate: a loud dense passage keeps its weaker and early 16ths', () => {
  assert.ok(dense.dense >= 0.8, `dense-passage 16ths found ${dense.dense} (1σ gate: ${dense.old_dense})`);
  assert.ok(dense.early >= 0.6, `early off-16ths found ${dense.early} (gap 1.0: ${dense.old_early})`);
  // the old settings really miss them: otherwise this test proves nothing
  assert.ok(dense.old_dense <= 0.6 && dense.old_early <= 0.1, `old ${dense.old_dense} / ${dense.old_early}`);
  assert.ok(dense.lock.R[3] >= 0.95 && Math.abs(dense.lock.offset_ms) <= 6, JSON.stringify(dense.lock));
});

test('drum gate: a quiet passage still needs a clear hit (no ghost notes)', () => {
  assert.equal(dense.quiet, 1, `quiet hats found ${dense.quiet}`);
  assert.ok(dense.ghost <= 0.15, `${dense.ghost} of ${dense.n_ghosts} ghost hits picked up in the quiet passage`);
  assert.ok(dense.flat_ghost >= 0.8, `a flat z > 0.5 gate caught only ${dense.flat_ghost} ghosts: weak test`);
});

// ── real full mixes (skipped when ..\MP3 is absent) ──────────────────────────
// stem_onsets at the drum lockout on the full mix, against the folded grid. Measured 2026-11-21:
// Resist and Disorder 0.907 (legacy 0.049), Electric Love 0.938 at k=3 (swung; legacy 0.093).
const MP3 = path.resolve(ROOT, '..', 'MP3');
const SONGS = ['Cyberpunk 2077 _ Resist and Disorder.mp3', 'BØRNS _ Electric Love.mp3']
  .map(f => path.join(MP3, f));
const present = SONGS.filter(f => fs.existsSync(f));

test('real mixes: onsets lock to the folded beat grid, the legacy detector does not', { skip: present.length ? false : 'no songs in ..\\MP3' }, () => {
  const res = py(`
import librosa, server
out = []
for p in ${JSON.stringify(present)}:
    det = server.detect_bpm_librosa(p)
    y, sr = librosa.load(p, sr=22050, mono=True)
    gap = 0.25 * 60 / det['bpm']
    new = server.stem_onsets(y, sr, gap)
    old = server.detect_onsets_np(server.rms_envelope(y, 220), 0.01, gap)
    out.append({'song': p, 'conf': det['confidence'],
                'new': server.onset_phase_lock([o['time'] for o in new], det['bpm'], det['phase']),
                'old': server.onset_phase_lock([o['time'] for o in old], det['bpm'], det['phase'])})
print(json.dumps(out))
`);
  for (const r of res) {
    const name = path.basename(r.song);
    assert.ok(r.conf > 2, `${name}: weak beat (conf ${r.conf}), not a fair test song`);
    assert.ok(r.new.lock >= 0.5, `${name} lock ${r.new.lock} R=${r.new.R}`);
    assert.ok(Math.abs(r.new.offset_ms) <= 15, `${name} offset ${r.new.offset_ms} ms`);
    assert.ok(r.old.lock < 0.15, `${name} legacy lock ${r.old.lock}: no longer a baseline?`);
  }
});
