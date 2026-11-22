// Drum hits get plausible kick / snare / hat labels (2026-11-22). The old classify_drum_hit (the
// spectral centroid of 40 ms, kick < 200 Hz) returned 0 kicks on every Demucs drum stem measured
// (Electric Love, Painkiller, Resist and Disorder + 4 more): hat and snare bleed lift any kick's
// centroid over 200 Hz. The app maps kick → bassOnsets, snare → midOnsets, hat → highOnsets and
// drops hats below Expert, so Hard-and-below maps lost almost every drum orb. classify_drum_hits
// labels by per-band attack levels plus a per-song kick/snare split, with a decay-tail fallback for
// a clap layered on the kick. These tests run the REAL server code (analyse_stems → stem_onsets →
// classify_drum_hits):
//   1. _otsu_split's bimodality statistics (the split gate) and _rank_corr (the decay gate);
//   2. synthetic drum stems with known truth (always runs): a hats-only intro over low-frequency
//      bleed, a rock beat, the same beat 9 dB quieter, 16th double bass under a snare on every
//      beat; a four-on-the-floor song whose kicks must NOT be split into two drums; and a bright
//      kick on every beat with a ringing clap on 2 & 4 that only the decay tail can see.
//      The old centroid classifier finds 0 kicks in all three;
//   3. Demucs on excerpts of real songs from ..\MP3 (skipped when absent or without Demucs):
//      Electric Love's backbeat (tilt split) and Resist and Disorder's kick + clap backbeat
//      (decay fallback) with off-beat hats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './harness.mjs';

function py(code) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})\n`;
  const out = execFileSync('py', ['-3.12', '-I', '-c', prelude + code],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 600000 });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// The pre-2026-11-22 classifier, verbatim, as the baseline the new one must beat.
const OLD_CLASSIFIER = `
def old_classify(signal, sr, time_sec, window_sec=0.04):
    import numpy as np
    start = int(time_sec * sr); end = min(start + int(window_sec * sr), len(signal)); frame = signal[start:end]
    if len(frame) < 16: return 'snare'
    spectrum = np.abs(np.fft.rfft(frame)); freqs = np.fft.rfftfreq(len(frame), d=1.0 / sr)
    denom = spectrum.sum(); centroid = float((spectrum * freqs).sum() / denom) if denom > 0 else 500.0
    return 'kick' if centroid < 200 else 'snare' if centroid < 2000 else 'hat'
`;

// ── the split gate ────────────────────────────────────────────────────────────
const otsu = py(`
import numpy as np, server
rng = np.random.default_rng(5)
two = np.concatenate([rng.normal(-6, 2, 300), rng.normal(5, 2, 300)])     # kick vs snare+kick tilts
a = rng.normal(0, 1, 500)
print(json.dumps({'two': server._otsu_split(two), 'normal': server._otsu_split(rng.normal(0, 2, 2000)),
                  'uniform': server._otsu_split(rng.uniform(-3, 3, 2000)), 'tiny': server._otsu_split([1, 2, 3]),
                  'empty': server.classify_drum_hits(np.zeros(22050, np.float32), 22050, []),
                  'r_mono': server._rank_corr(a, np.exp(a)), 'r_neg': server._rank_corr(a, -a),
                  'r_none': server._rank_corr(a, rng.normal(0, 1, 500))}))
`);

test('_otsu_split: two clusters pass the gate; unimodal normal and uniform samples do not', () => {
  const { two, normal, uniform, tiny, empty, r_mono, r_neg, r_none } = otsu;
  assert.ok(Math.abs(r_mono - 1) < 1e-9 && Math.abs(r_neg + 1) < 1e-9 && Math.abs(r_none) < 0.12,
    `rank corr ${r_mono} ${r_neg} ${r_none}`);
  assert.ok(two.eta > 0.85 && two.sep > 9 && Math.abs(two.frac_hi - 0.5) < 0.05 && Math.abs(two.thr + 0.5) < 2,
    JSON.stringify(two));
  // η is 2/π ≈ 0.64 for a normal sample and 0.75 for a uniform one, so η alone cannot call a split:
  // the gap (6 dB) is what rejects ±3 dB velocity spread on a single drum.
  assert.ok(Math.abs(normal.eta - 2 / Math.PI) < 0.03, `normal η ${normal.eta}`);
  assert.ok(Math.abs(uniform.eta - 0.75) < 0.03 && uniform.sep < 6, JSON.stringify(uniform));
  assert.equal(tiny, null);
  assert.deepEqual(empty, []);
});

// ── synthetic drum stems with known truth ────────────────────────────────────
// 120 BPM, beat 1 at 0.31 s. Every hit's velocity varies ±3 dB. Kick: a 48 Hz sine with a 138 Hz
// pitch drop and a beater click. Snare: 150 Hz-12 kHz noise + a 185 Hz tone. Hats: 6-16 kHz noise
// (band-limited like an MP3: analyse_stems decimates 44.1 → 22.05 kHz with no anti-alias filter, so
// energy near 20 kHz would fold into the mid band). Bleed: a 55 Hz drone + noise (as Demucs leaves).
// Truth at a time with several drums: snare > kick > hat (the label is the most salient drum).
const synth = py(`
import numpy as np, soundfile as sf, tempfile, os, server
${OLD_CLASSIFIER}
SR = 44100; BPM = 120.0; PHASE = 0.31; P = 60 / BPM
rng = np.random.default_rng(11)
burst = lambda d: np.arange(int(d * SR)) / SR
def ad(d, att, dec):
    t = burst(d); return np.minimum(t / att, 1) * np.exp(-np.maximum(t - att, 0) / dec)
def band(x, lo, hi):
    X = np.fft.rfft(x); fr = np.fft.rfftfreq(len(x), 1 / SR); X[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(X, len(x))
def kick(dec=0.10):
    f = 48 + rng.uniform(-3, 3) + 90 * np.exp(-burst(0.3) / 0.025)
    click = np.diff(rng.normal(0, 1, int(0.3 * SR)), prepend=0.0) * ad(0.3, 0.0005, 0.004) * 0.15
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * ad(0.3, 0.002, dec) + click
def snare():
    return (band(rng.normal(0, 1.3, int(0.25 * SR)), 150, 12000) * ad(0.25, 0.001, 0.07)
            + 0.8 * np.sin(2 * np.pi * (185 + rng.uniform(-5, 5)) * burst(0.25)) * ad(0.25, 0.001, 0.06))
def hat(dec=0.012):
    return band(rng.normal(0, 1.5, int(0.2 * SR)), 6000, 16000) * ad(0.2, 0.0005, dec)
def bright_kick():   # industrial kick: distorted body + a 1.5-6 kHz click, so a clap adds no tilt
    body = np.tanh(3 * kick(0.12)) * 0.8
    return body + band(rng.normal(0, 1.0, int(0.3 * SR)), 1500, 6000) * ad(0.3, 0.0005, 0.006) * 0.5
def clap():          # 1-5 kHz noise: 3 quick bursts, then a 150 ms ring
    t = burst(0.35)
    env = sum(np.exp(-np.maximum(t - d, 0) / 0.004) * (t >= d) for d in (0.0, 0.008, 0.016)) * 0.5 + np.exp(-t / 0.15) * 0.25
    return band(rng.normal(0, 1.0, int(0.35 * SR)), 1000, 5000) * env * 0.6
def song(sections):
    nb = sum(b for _, b, _ in sections) + 2
    n = int((PHASE + nb * 4 * P + 1) * SR); y = np.zeros(n); truth = []
    def add(t0, b, g):
        i = int(round(t0 * SR)); j = min(n, i + len(b)); y[i:j] += g * b[:j - i]
    bar0 = 1
    for kind, bars, gain in sections:
        for bar in range(bar0, bar0 + bars):
            for s16 in range(16):
                t = PHASE + (bar * 4 + s16 / 4) * P; v = gain * 10 ** (rng.uniform(-3, 3) / 20); hits = []
                if kind == 'hats':                 # hats-only intro: closed hats on 8ths
                    if s16 % 2 == 0: hits.append(('hat', hat()))
                elif kind == 'rock':               # kick 1, 3 + the "and" of 3; snare 2, 4; 8th hats
                    if s16 in (0, 8, 10): hits.append(('kick', kick()))
                    if s16 in (4, 12): hits.append(('snare', snare()))
                    if s16 % 2 == 0: hits.append(('hat', 0.6 * hat()))
                elif kind == 'metal':              # 16th double bass, a snare on every beat
                    hits.append(('kick', kick(0.05)))
                    if s16 % 4 == 0: hits.append(('snare', snare()))
                elif kind == 'fourclap':           # bright kick every beat, clap on 2 & 4, open hat on the "and"
                    if s16 % 4 == 0: hits.append(('kick', bright_kick()))
                    if s16 in (4, 12): hits.append(('snare', clap()))
                    if s16 % 4 == 2: hits.append(('hat', 0.7 * hat(0.08)))
                elif kind == 'four':               # kick on every beat, open hat on the "and"
                    if s16 % 4 == 0: hits.append(('kick', kick()))
                    if s16 % 4 == 2: hits.append(('hat', 0.7 * hat(0.08)))
                for _, b in hits: add(t, b, v)
                if hits:
                    labs = {h for h, _ in hits}
                    truth.append((t, 'snare' if 'snare' in labs else 'kick' if 'kick' in labs else 'hat',
                                  kind + ('' if gain == 1.0 else '-quiet')))
        bar0 += bars
    y += 0.05 * np.sin(2 * np.pi * 55 * np.arange(n) / SR) + rng.normal(0, 0.003, n)
    return y / np.abs(y).max() * 0.8, truth
def run(y, truth):
    d = tempfile.mkdtemp(); stems = {}
    for name in ('drums', 'bass', 'vocals', 'other'):
        stems[name] = os.path.join(d, name + '.wav')
        sig = y if name == 'drums' else np.full_like(y, 1e-4)
        sf.write(stems[name], np.stack([sig, sig], 1), SR, subtype='PCM_16')
    a = server.analyse_stems(stems, BPM, {'drums': True, 'bass': False, 'vocals': False, 'other': False}, 0.0)
    drum, sr = server.load_wav_mono(stems['drums'], 22050)
    info = {}; server.classify_drum_hits(drum, sr, [o['time'] for o in a['stems']['drums']['onsets']], info)
    for p in stems.values(): os.remove(p)
    os.rmdir(d)
    ons = a['stems']['drums']['onsets']; tt = np.array([x[0] for x in truth]); rows = []
    for o in ons:
        j = int(np.argmin(np.abs(tt - o['time'])))
        ok = abs(tt[j] - o['time']) <= 0.03
        rows.append({'sec': truth[j][2] if ok else None, 'truth': truth[j][1] if ok else None, 'pred': o['subtype'],
                     'old': old_classify(drum, sr, o['time'])})
    return {'rows': rows, 'n_truth': len(truth), 'split': info['split'], 'split_used': info['split_used'],
            'decay': info['decay'], 'decay_used': info['decay_used']}
print(json.dumps({'mixed': run(*song([('hats', 4, 1.0), ('rock', 8, 1.0), ('rock', 8, 0.35), ('metal', 8, 1.0)])),
                  'four': run(*song([('four', 16, 1.0)])), 'fourclap': run(*song([('fourclap', 16, 1.0)]))}))
`);

const acc = (rows, pred) => {
  const m = rows.filter(pred);
  return { n: m.length, ok: m.filter(r => r.pred === r.truth).length, share: m.length ? m.filter(r => r.pred === r.truth).length / m.length : NaN };
};
const tally = (xs, k = 'pred') => xs.reduce((c, x) => ({ ...c, [x[k]]: (c[x[k]] || 0) + 1 }), {});

test('synthetic mixed song: kick / snare / hat labels match the truth in every section', () => {
  const { rows, split, split_used } = synth.mixed;
  const matched = rows.filter(r => r.truth);
  assert.ok(matched.length >= 0.95 * rows.length, `${rows.length - matched.length} of ${rows.length} onsets off any hit`);
  assert.ok(split_used, `kick/snare split not used: ${JSON.stringify(split)}`);
  for (const [drum, min] of [['kick', 0.95], ['snare', 0.9], ['hat', 0.9]]) {
    const a = acc(matched, r => r.truth === drum);
    assert.ok(a.n >= 20 && a.share >= min, `${drum}: ${a.ok}/${a.n} right (${JSON.stringify(tally(matched.filter(r => r.truth === drum)))})`);
  }
  // hats-only intro over a 55 Hz drone: the bleed must not become kicks
  const intro = matched.filter(r => r.sec === 'hats');
  assert.ok(intro.length >= 20 && intro.every(r => r.pred === 'hat'), `intro: ${JSON.stringify(tally(intro))}`);
  // the snare over 16th double bass is the hit's label; the double bass between is kick
  for (const drum of ['kick', 'snare']) {
    const a = acc(matched, r => r.sec === 'metal' && r.truth === drum);
    assert.ok(a.n >= 20 && a.share >= 0.95, `metal ${drum}: ${a.ok}/${a.n}`);
  }
  // 9 dB quieter section: the per-band references are local, so it still labels
  const quiet = acc(matched, r => r.sec === 'rock-quiet');
  assert.ok(quiet.n >= 30 && quiet.share >= 0.85, `quiet rock: ${quiet.ok}/${quiet.n}`);
});

test('synthetic four-on-the-floor song: one kick drum is not split into kick + snare', () => {
  const { rows, split, split_used, decay, decay_used } = synth.four;
  assert.ok(!split_used, `split used on a single kick drum: ${JSON.stringify(split)}`);
  assert.ok(split.sep < 6, `gap ${split.sep} dB`);
  assert.ok(!decay_used && decay.r < 0.25, `decay fallback fired on a single kick drum: ${JSON.stringify(decay)}`);
  for (const drum of ['kick', 'hat']) {
    const a = acc(rows, r => r.truth === drum);
    assert.ok(a.n >= 50 && a.share >= 0.98, `${drum}: ${a.ok}/${a.n} (${JSON.stringify(tally(rows.filter(r => r.truth === drum)))})`);
  }
});

// Resist and Disorder in miniature: its clap on 2 & 4 matches the kick's peak spectrum (so the tilt is
// unimodal) and differs only in its ring. The decay fallback must find it: crack and tail correlate.
test('synthetic kick + clap song: the decay fallback labels the clap beats snare', () => {
  const { rows, split, split_used, decay, decay_used } = synth.fourclap;
  assert.ok(!split_used, `the tilt split saw the clap (this case should need the decay path): ${JSON.stringify(split)}`);
  assert.ok(decay_used && decay.r >= 0.25, `decay fallback not used: ${JSON.stringify(decay)}`);
  const matched = rows.filter(r => r.truth);
  for (const [drum, min] of [['kick', 0.95], ['snare', 0.95], ['hat', 0.9]]) {
    const a = acc(matched, r => r.truth === drum);
    assert.ok(a.n >= 25 && a.share >= min, `${drum}: ${a.ok}/${a.n} (${JSON.stringify(tally(matched.filter(r => r.truth === drum)))})`);
  }
});

test('synthetic songs: the old centroid classifier finds no kicks (the bug this replaces)', () => {
  for (const [name, { rows }] of Object.entries(synth)) {
    const oldKicks = rows.filter(r => r.old === 'kick').length;
    const newKicks = rows.filter(r => r.pred === 'kick').length;
    assert.ok(oldKicks <= 0.02 * rows.length, `${name}: old classifier found ${oldKicks} kicks: no longer a baseline?`);
    assert.ok(newKicks >= 0.2 * rows.length, `${name}: ${newKicks} kicks of ${rows.length}`);
  }
});

// ── real songs: Demucs on excerpts (skipped when ..\MP3 or Demucs is absent) ──────────────
// Excerpts from sections with a steady groove; the grid is each song's folded BPM (handoff cont. 4)
// with the phase measured on the excerpt itself (lattice_phase). Measured 2026-11-22 (excerpt):
//   Electric Love 72-102 s: kick 88 / snare 31 / hat 1; on-beat kicks 100% on one beat parity,
//     snares 100% on the other (the backbeat); tilt split η 0.83, gap 11.3 dB. Old: 0 kicks.
//   Resist and Disorder 60-120 s: kick 40 / snare 56 / hat 60; tilt split NOT bimodal (gap 1.3 dB),
//     decay fallback r 0.35: on-beat kicks 95% on one parity, snares 84% on the other, 98% of "&"
//     hits hat. Old: 0 kicks. (Its 150-195 s stretch has no clap: r 0.02, all kick.)
const MP3 = path.resolve(ROOT, '..', 'MP3');
const EXCERPTS = [
  { file: 'BØRNS _ Electric Love.mp3', bpm: 119.878, offset: 72, duration: 30, via: 'tilt' },
  { file: 'Cyberpunk 2077 _ Resist and Disorder.mp3', bpm: 96.0, offset: 60, duration: 60, via: 'decay' },
].filter(e => fs.existsSync(path.join(MP3, e.file)));
const demucs = EXCERPTS.length ? py(`import server; print(json.dumps(server.check_demucs()[0]))`) : false;
const skipReal = !EXCERPTS.length ? 'no songs in ..\MP3' : !demucs ? 'Demucs not installed' : false;

test('real songs (Demucs drum stems): kick / snare / hat follow the groove', { skip: skipReal }, () => {
  const res = py(`
import os, tempfile, shutil, numpy as np, librosa, soundfile as sf, server
${OLD_CLASSIFIER}
out = []
for e in ${JSON.stringify(EXCERPTS)}:
    y, sr = librosa.load(os.path.join(${JSON.stringify(MP3)}, e['file']), sr=44100, mono=False, offset=e['offset'], duration=e['duration'])
    d = tempfile.mkdtemp()
    try:
        wav = os.path.join(d, 'excerpt.wav'); sf.write(wav, y.T, sr, subtype='PCM_16')
        st = server.separate_stems(open(wav, 'rb').read(), '.wav', d)
        a = server.analyse_stems(st, e['bpm'], {'drums': True, 'bass': False, 'vocals': False, 'other': False}, 0.0)
        drum, dsr = server.load_wav_mono(st['drums'], 22050)
        ons = a['stems']['drums']['onsets']
        info = {}; server.classify_drum_hits(drum, dsr, [o['time'] for o in ons], info)
        old = [old_classify(drum, dsr, o['time']) for o in ons]
    finally:
        shutil.rmtree(d, ignore_errors=True)
    ym = librosa.resample(librosa.to_mono(y), orig_sr=sr, target_sr=22050)
    env = librosa.onset.onset_strength(y=ym, sr=22050, hop_length=server.TEMPO_HOP)
    phase = server.lattice_phase(env, server.TEMPO_HOP / 22050, e['bpm'])['phase']
    out.append({**e, 'phase': phase, 'old_kicks': old.count('kick'), 'split_used': info['split_used'],
                'split': info['split'], 'decay': info['decay'], 'decay_used': info['decay_used'],
                'hits': [[o['time'], o['subtype']] for o in ons]})
print(json.dumps(out))
`);
  for (const r of res) {
    const P = 60 / r.bpm;
    const hits = r.hits.map(([t, s]) => { const b = (t - r.phase) / P; return { s, b, onBeat: Math.abs(b - Math.round(b)) < 0.125, par: ((Math.round(b) % 2) + 2) % 2, slot: ((Math.round(b * 4) % 4) + 4) % 4 }; });
    const count = s => hits.filter(h => h.s === s).length;
    const label = `${r.file}: kick ${count('kick')} / snare ${count('snare')} / hat ${count('hat')}`;
    assert.ok(hits.length >= 50, `${label}: only ${hits.length} hits`);
    assert.equal(r.old_kicks, 0, `${label}: the old classifier found ${r.old_kicks} kicks: no longer a baseline?`);
    if (r.via === 'tilt') assert.ok(r.split_used, `${label}: kick/snare split not used ${JSON.stringify(r.split)}`);
    else assert.ok(!r.split_used && r.decay_used, `${label}: expected the decay fallback: split ${JSON.stringify(r.split)} decay ${JSON.stringify(r.decay)}`);
    assert.ok(count('kick') >= 0.2 * hits.length && count('snare') >= 0.15 * hits.length, label);
    // the backbeat: on-beat kicks on one beat parity, on-beat snares on the other
    const parity = s => { const on = hits.filter(h => h.onBeat && h.s === s); const p1 = on.filter(h => h.par === 1).length / on.length; return { n: on.length, par: p1 >= 0.5 ? 1 : 0, share: Math.max(p1, 1 - p1) }; };
    const k = parity('kick'), s = parity('snare');
    assert.ok(k.n >= 10 && k.share >= 0.8, `${label}: on-beat kicks ${JSON.stringify(k)}`);
    assert.ok(s.n >= 10 && s.share >= 0.75, `${label}: on-beat snares ${JSON.stringify(s)}`);
    assert.notEqual(k.par, s.par, `${label}: kicks and snares on the same beats (no backbeat)`);
    if (r.via === 'decay') {
      const and = hits.filter(h => !h.onBeat && h.slot === 2);
      assert.ok(and.length >= 8 && and.filter(h => h.s === 'hat').length >= 0.8 * and.length, `${label}: "&" ${JSON.stringify(tally(and, 's'))}`);
    }
  }
});
