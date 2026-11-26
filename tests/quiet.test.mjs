// Quiet passages (2026-11-26, Live It Up play-test: a sparse-guitar intro mapped at 5-6.5 notes/s
// against 2.7 in the full-band song). Two causes, two fixes:
//   gateStemBleed  — Demucs bleed into a stem that is not playing made onsets (drums 1.8/s at
//                    strength 0.015 vs 0.63 in the song);
//   quietKeepProb  — Master never thinned by loudness, and the two-hand mirror doubled every note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { ROOT, load, loadAt, withSeed, appSource, extract } from './harness.mjs';

const X = ['STEM_DENSITY_TIERS', 'stemDensityProfile', 'stemKeepProb', 'PHYS_SAME_HAND_SEC', 'STREAM_GAP_BEATS',
  'DRUM_GAP_JITTER', 'TAPER_MAX_HOLE_SEC', 'RHYTHM_OTHER_WIN', 'RHYTHM_OTHER_MIN', 'RHYTHM_OTHER_LOCK', 'RHYTHM_OTHER_DRUM_FRAC',
  'RHYTHM_OTHER_SIG', 'beatPhaseLock', 'rhythmOtherMap'];
const NEW = load([...X, 'STEM_PRESENCE_FRAC', 'STEM_PRESENCE_WIN_BEATS', 'gateStemBleed', 'QUIET_REL_REF', 'QUIET_EXP',
  'quietKeepProb', 'extractNoteEventsFromStems']);
const OLD = loadAt('a75a480', [...X, 'extractNoteEventsFromStems']);   // main before this change
const stems = o => ({ drums: { onsets: [], regions: [] }, bass: { onsets: [], regions: [] },
  vocals: { onsets: [], regions: [] }, other: { onsets: [], regions: [] }, ...o });
const quietly = f => { const q = ['log', 'warn'].map(k => [k, console[k]]); for (const [k] of q) console[k] = () => {};
  try { return f(); } finally { for (const [k, fn] of q) console[k] = fn; } };
const ext = (lib, sd, dur, bpm, diff, seed = 1, hints = {}) =>
  quietly(() => withSeed(seed, () => lib.extractNoteEventsFromStems(structuredClone(sd), dur, bpm, diff, hints)));

test('gateStemBleed: a stem\'s faint leak where it is not playing goes, its real soft hits stay', () => {
  const bps = 2;                                         // 120 BPM
  const drums = [];
  for (let b = 0; b < 64; b++) drums.push({ time: b / bps, energy: 0.012 + 0.004 * (b % 3), subtype: 'snare' });   // bleed: 0-31 s
  for (let b = 64; b < 192; b++) {
    drums.push({ time: b / bps, energy: 0.7, subtype: b % 2 ? 'snare' : 'kick' });
    drums.push({ time: (b + 0.5) / bps, energy: 0.08, subtype: 'hat' });       // ghost hats beside loud hits
  }
  const out = NEW.gateStemBleed(stems({ drums: { onsets: drums, regions: [] } }), bps);
  const kept = out.drums.onsets;
  assert.equal(kept.filter(o => o.time < 30).length, 0, 'bleed in the drumless intro survived');
  assert.equal(kept.filter(o => o.time >= 34).length, drums.filter(o => o.time >= 34).length, 'a real hit was dropped');
  assert.ok(kept.some(o => o.energy === 0.08), 'ghost hats next to the groove must stay');
  // onsets with no energy, or too few to judge, are left alone
  const bare = [{ time: 1 }, { time: 2 }, { time: 3 }];
  assert.equal(NEW.gateStemBleed(stems({ other: { onsets: bare, regions: [] } }), bps).other.onsets.length, 3);
});

test('quietKeepProb: 1 at or above -6 dB against the median beat, then (rel/0.5)^2', () => {
  assert.equal(NEW.quietKeepProb(1), 1);
  assert.equal(NEW.quietKeepProb(0.5), 1);
  assert.ok(Math.abs(NEW.quietKeepProb(10 ** (-10 / 20)) - 0.4) < 0.01);      // -10 dB -> 0.40
  assert.ok(Math.abs(NEW.quietKeepProb(0.25) - 0.25) < 1e-9);                 // -12 dB -> 0.25
  assert.equal(NEW.quietKeepProb(0), 0);
  for (let r = 0.01; r < 0.5; r += 0.01) assert.ok(NEW.quietKeepProb(r) <= NEW.quietKeepProb(r + 0.01) + 1e-12);
});

test('a song with no quiet passage and no bleed is mapped EXACTLY as before, every difficulty', () => {
  const bpm = 120, bps = 2, beats = 96, dur = beats / bps;
  const drums = [], bass = [];
  for (let b = 0; b < beats; b++) {
    drums.push({ time: b / bps, energy: 0.6 + 0.1 * (b % 2), subtype: b % 2 ? 'snare' : 'kick' });
    if (b % 4 !== 3) drums.push({ time: (b + 0.5) / bps, energy: 0.3, subtype: 'hat' });
    bass.push({ time: (b + 0.02) / bps, energy: 0.5 });
  }
  const energyCurve = Array.from({ length: beats }, (_, b) => 0.6 + 0.3 * Math.abs(Math.sin(b / 9)));   // all > -6 dB
  const sd = stems({ drums: { onsets: drums, regions: [] }, bass: { onsets: bass, regions: [] } });
  for (const diff of [9, 8, 6, 4, 2])
    for (const seed of [1, 2, 3])
      assert.deepEqual(ext(NEW, sd, dur, bpm, diff, seed, { _energyCurve: energyCurve }),
                       ext(OLD, sd, dur, bpm, diff, seed, { _energyCurve: energyCurve }), `diff ${diff} seed ${seed}`);
});

// ── onsetsToNotes on a quiet-intro song: the shape of Live It Up ─────────────────────────────
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
const GEN_NEW = closure(appSource(), ['onsetsToNotes']);
const GEN_OLD = closure(execSync('git show a75a480:synthriders-creator.html', { cwd: ROOT, maxBuffer: 64 << 20 }).toString(), ['onsetsToNotes']);
// 143 BPM: a 32-beat intro of sparse guitar (one pluck a beat) ~10 dB under the song, with Demucs
// bleed in drums, bass and vocals; then 96 beats of the full band.
function liveItUpShape() {
  const bpm = 143, bps = bpm / 60, intro = 32, beats = 128;
  const T = b => b / bps, drums = [], bass = [], vocals = [], other = [];
  for (let b = 0; b < intro; b++) {
    other.push({ time: T(b + 0.01), energy: 0.45 });
    drums.push({ time: T(b + 0.27), energy: 0.015, subtype: 'snare' });
    bass.push({ time: T(b + 0.52), energy: 0.03 });
    vocals.push({ time: T(b + 0.76), energy: 0.03, pitch_row: 4 });
  }
  for (let b = intro; b < beats; b++) {
    drums.push({ time: T(b), energy: 0.75, subtype: b % 2 ? 'snare' : 'kick' });
    drums.push({ time: T(b + 0.5), energy: 0.35, subtype: 'hat' });
    bass.push({ time: T(b + 0.02), energy: 0.5 });
    other.push({ time: T(b + 0.25), energy: 0.2 });
    if (b % 8 === 0) vocals.push({ time: T(b), energy: 0.6, pitch_row: 4 });
  }
  const energyCurve = Array.from({ length: beats }, (_, b) => (b < intro ? 0.25 : 0.8) + 0.02 * Math.sin(b));
  const analysis = { bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [], energyCurve, duration: T(beats),
    panningByBeat: null, stemData: stems({ drums: { onsets: drums, regions: [] }, bass: { onsets: bass, regions: [] },
      vocals: { onsets: vocals, regions: [] }, other: { onsets: other, regions: [] } }) };
  const sections = [['intro', 0, intro], ['verse', intro, 64], ['chorus', 64, 96], ['chorus 2', 96, beats]].map(([name, s, e]) =>
    ({ name, startBeat: s, endBeat: e, avgRow: 5, rowVariance: 2, rowContour: 'plateau', noteStyle: 'alternating-flow',
       handMode: 'both-hands', density: 2, climax: false }));
  return { analysis, sections, bpm, intro, beats };
}
const gen = (lib, s, diff, seed) => quietly(() => { globalThis.window = {};
  try { return withSeed(seed, () => lib.onsetsToNotes(structuredClone(s.analysis), s.bpm, diff, structuredClone(s.sections), {})).notes; }
  finally { delete globalThis.window; } });

test('onsetsToNotes, Master: a quiet intro is mapped well under half as densely as the band (OLD: about as dense)', () => {
  const s = liveItUpShape(), bps = s.bpm / 60;
  const rate = notes => {
    const intro = notes.filter(n => n.beat >= 2 && n.beat < s.intro).length / ((s.intro - 2) / bps);
    const body  = notes.filter(n => n.beat >= s.intro && n.beat < s.beats).length / ((s.beats - s.intro) / bps);
    return intro / body;
  };
  let rn = 0, ro = 0;
  for (const seed of [1, 2, 3, 4, 5]) { rn += rate(gen(GEN_NEW, s, 9, seed)) / 5; ro += rate(gen(GEN_OLD, s, 9, seed)) / 5; }
  assert.ok(rn <= 0.45, `NEW intro/body density ${rn.toFixed(2)}`);
  assert.ok(ro >= rn + 0.2, `OLD ${ro.toFixed(2)} vs NEW ${rn.toFixed(2)}: the baseline no longer shows the problem`);
  // no drum or bass note in the drumless intro: those onsets were bleed (the last 4 beats see the
  // band's hits inside their presence window, so they are judged with the band)
  for (const seed of [1, 2, 3]) {
    const intro = gen(GEN_NEW, s, 9, seed).filter(n => n.beat < s.intro - 5);
    assert.equal(intro.filter(n => n.stemSource === 'drums' || n.stemSource === 'bass').length, 0, `seed ${seed}`);
  }
});
