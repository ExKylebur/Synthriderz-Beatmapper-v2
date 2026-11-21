// Beat-1 pad (2026-11-21). The map grid is anchored at t=0, but a song's beats sit at
// phase + k·P (Electric Love: +0.465 beat off the map's integer beats). The app prepends
// beatPadSecs of silence to the analysed stems, playback and the exported OGG, so integer map
// beats become the music's beats. These tests run the REAL app helpers and the REAL server
// functions (analyse_stems pad, convert_to_ogg silence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { load, ROOT } from './harness.mjs';

const { beatPadSecs, padAudioBuffer } = load(['BEAT_PAD_OCTAVE_TOL', 'beatPadSecs', 'padAudioBuffer']);

function py(code) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})\n`;
  const out = execFileSync('py', ['-3.12', '-I', '-c', prelude + code],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// signed distance (in beats) of time t from the nearest map beat k·60/bpm
const offBeat = (t, bpm) => { const x = t * bpm / 60; return x - Math.round(x); };

test('pad puts the measured beats on integer map beats', () => {
  const srv = { bpm: 120, phase: 0.2, duration: 200 };
  const pad = beatPadSecs(120, srv);
  assert.equal(pad, 0.3);
  for (const k of [0, 1, 100, 399]) assert.ok(Math.abs(offBeat(0.2 + k * 0.5 + pad, 120)) < 1e-6);
});

test('octaves: double-time and half-time land on musical beats', () => {
  const srv = { bpm: 120, phase: 0.2, duration: 200 };
  const dbl = beatPadSecs(240, srv);
  assert.ok(Math.abs(dbl - 0.05) < 1e-9, `double ${dbl}`);
  const half = beatPadSecs(60, srv);
  // either beat phase is fine at half time (both are music beats); it must be one of them
  assert.ok([0.3, 0.8].some(p => Math.abs(half - p) < 1e-9), `half ${half}`);
  assert.ok(Math.abs(offBeat(0.2 + half, 120)) < 1e-6);
});

test('no measurement, a bin-only response or a non-octave BPM -> no pad', () => {
  assert.equal(beatPadSecs(120, null), 0);
  assert.equal(beatPadSecs(117.45, { candidates: [117.45] }), 0);           // old server: no phase
  assert.equal(beatPadSecs(130, { bpm: 120, phase: 0.2, duration: 200 }), 0);
  assert.equal(beatPadSecs(117.45, { bpm: 119.878, phase: 0.2304, duration: 220.787 }), 0);
  assert.equal(beatPadSecs(120, { bpm: 120, phase: 0, duration: 200 }), 0);   // already on the grid
});

test('the 2-dp BPM field: anchored mid-song, the residual stays tiny over the whole song', () => {
  // Electric Love as measured live: 119.878 BPM, phase 0.2304 s, 220.8 s; the BPM field says 119.88.
  const srv = { bpm: 119.878, phase: 0.2304, duration: 220.787 };
  const pad = beatPadSecs(119.88, srv);
  assert.ok(pad > 0 && pad < 60 / 119.88, `pad ${pad}`);
  let worst = 0;
  for (let t = srv.phase; t < srv.duration; t += 60 / srv.bpm) worst = Math.max(worst, Math.abs(offBeat(t + pad, 119.88)));
  assert.ok(worst < 0.005, `worst ${worst} beat`);
  // anchoring at t=0 instead would double the end error; mid-song keeps it split
});

test('padAudioBuffer prepends silence to every channel', () => {
  const ctx = { createBuffer: (ch, len, sr) => {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: c => data[c] };
  } };
  const src = ctx.createBuffer(2, 4, 1000);
  src.getChannelData(0).set([1, 2, 3, 4]); src.getChannelData(1).set([5, 6, 7, 8]);
  const out = padAudioBuffer(ctx, src, 0.003);
  assert.equal(out.length, 7);
  assert.deepEqual([...out.getChannelData(0)], [0, 0, 0, 1, 2, 3, 4]);
  assert.deepEqual([...out.getChannelData(1)], [0, 0, 0, 5, 6, 7, 8]);
  assert.equal(padAudioBuffer(ctx, src, 0), src);
});

// ── server: the same pad on the analysis side and the export side ─────────────
const srv = py(`
import numpy as np, soundfile as sf, tempfile, os, io, server
SR = 44100
d = tempfile.mkdtemp()
hits = np.arange(0.5, 9.5, 0.5)                        # a kick every 0.5 s
y = np.zeros(SR * 10, dtype=np.float32)
for h in hits:
    i = int(h * SR); y[i:i + 400] = np.hanning(800)[400:] * 0.9
st = np.stack([y, y], axis=1)
paths = {}
for name in ('drums', 'bass', 'vocals', 'other'):
    paths[name] = os.path.join(d, name + '.wav')
    sf.write(paths[name], st if name == 'drums' else st * 0.0 + 1e-4, SR, subtype='PCM_16')
on = {'drums': True, 'bass': False, 'vocals': False, 'other': False}
a0 = server.analyse_stems(paths, 120.0, on, 0.0)
a1 = server.analyse_stems(paths, 120.0, on, 0.3)
t0 = [o['time'] for o in a0['stems']['drums']['onsets']]
t1 = [o['time'] for o in a1['stems']['drums']['onsets']]
for p in paths.values(): os.remove(p)
os.rmdir(d)
buf = io.BytesIO(); sf.write(buf, y[:SR * 3], SR, format='WAV'); wav = buf.getvalue()
z, zsr = sf.read(io.BytesIO(server.convert_to_ogg(wav, '.wav', silence_secs=0.3141)))
z = z.mean(axis=1)
print(json.dumps({'t0': t0, 't1': t1, 'dur0': a0['duration'], 'dur1': a1['duration'],
                  'ec0': len(a0['energy_curve']), 'ec1': len(a1['energy_curve']),
                  'ogg_len': len(z) / zsr, 'ogg_first': float(np.argmax(np.abs(z) > 0.3) / zsr)}))
`);

test('analyse_stems(pad) shifts every onset and the duration by exactly the pad', () => {
  assert.ok(srv.t0.length >= 15, `onsets ${srv.t0.length}`);
  assert.equal(srv.t1.length, srv.t0.length);
  srv.t1.forEach((t, i) => assert.ok(Math.abs(t - srv.t0[i] - 0.3) < 0.011, `onset ${i}: ${srv.t0[i]} -> ${t}`));
  assert.ok(Math.abs(srv.dur1 - srv.dur0 - 0.3) < 0.001);
  assert.equal(srv.ec1, Math.ceil(srv.dur1 / 0.5));         // per-beat curve covers the padded song
});

test('convert_to_ogg(silence_secs) pads sample-accurately', () => {
  assert.ok(Math.abs(srv.ogg_len - (3 + 0.3141)) < 1e-4, `len ${srv.ogg_len}`);
  assert.ok(Math.abs(srv.ogg_first - (0.5 + 0.3141)) < 0.001, `first hit ${srv.ogg_first}`);
});
