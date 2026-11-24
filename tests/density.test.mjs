// Stem → note density (2026-11-23). The user's VR test: "When there are rapid double bass hits like in
// Painkiller and in Chaos Control the beats don't track as well", and piano-driven songs (Kin, Faith)
// "didn't cover those as comprehensively". Measured causes, all in extractNoteEventsFromStems:
//   1. Rails held the hand for min(region, 4 s), but onsetsToNotes caps a vocal rail at 2 s (a guitar
//      rail at 5 beats) and turns one under 2 beats into an orb. Every drum hit after the REAL rail
//      end became a 'companion' with no rail to ride, and onsetsToNotes dropped it: 199-225 drum hits
//      per song (Chaos Control / Painkiller, Master): whole beats of double bass with no notes.
//   2. MIN_DRUM_GAP (¼ beat of RAW time) on one drums-owned hand dropped every real 16th that landed a
//      few ms early (the drum detector's NMS is 0.8 × ¼ beat).
//   3. Bass was dropped whenever its own hand held a rail, so the free hand sat idle.
//   4. Density caps: bass a flat random 50% at every tier, drums/bass a flat random 1.0/0.80/0.55/0.35/
//      0.20, hats dropped outright below Expert.
//   5. 'other' (htdemucs has no piano stem) only started rails, or became orbs after a beat of drum
//      silence: Kin's drumless piano passages were rails on both hands.
// The fix: Master keeps every hit (physics only: one hand repeats at most every PHYS_SAME_HAND_SEC,
// a faster drum run alternates hands with a two-hand accent on the beat); Expert → Easy taper gently,
// weighted by loudness; rails last what onsetsToNotes makes of them, and a companion that still finds
// no rail becomes a free orb; 'other' plays the drums' role where it is beat-locked and the drums are
// sparse (rhythmOtherMap).
// These tests run the REAL declarations from the HTML (tests/harness.mjs); OLD = 99ee4f3 (main
// before this change).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ROOT, load, loadAt, withSeed, appSource, extract } from './harness.mjs';

const OLD_REV = '99ee4f3';
const X = ['STEM_DENSITY_TIERS', 'stemDensityProfile', 'stemKeepProb', 'PHYS_SAME_HAND_SEC', 'STREAM_GAP_BEATS',
  'DRUM_GAP_JITTER', 'TAPER_MAX_HOLE_SEC', 'RHYTHM_OTHER_WIN', 'RHYTHM_OTHER_MIN', 'RHYTHM_OTHER_LOCK', 'RHYTHM_OTHER_DRUM_FRAC', 'RHYTHM_OTHER_SIG',
  'beatPhaseLock', 'rhythmOtherMap', 'extractNoteEventsFromStems'];
const NEW = load(X);
const OLD = loadAt(OLD_REV, ['PROB_BASS_SKIP_WHEN_OWNER', 'extractNoteEventsFromStems']);
const PHYS = NEW.PHYS_SAME_HAND_SEC;

// ── synthetic stems ────────────────────────────────────────────────────────────────────────
const stems = (o = {}) => ({ drums: { onsets: [], regions: [] }, bass: { onsets: [], regions: [] },
  vocals: { onsets: [], regions: [] }, other: { onsets: [], regions: [] }, ...o });
// A 16th double-bass run with a snare on every beat (Painkiller's "S.K."). Every other hit lands
// 0.04 beat early, as the real detector leaves them (gaps 0.21 / 0.29 beat).
function doubleBass(bpm, beats, from = 0) {
  const bps = bpm / 60, on = [];
  for (let k = 0; k < beats * 4; k++)
    on.push({ time: (from + k / 4 - (k % 2 ? 0.04 : 0)) / bps, energy: k % 4 ? 0.5 : 0.9, subtype: k % 4 ? 'kick' : 'snare' });
  return on;
}
const quietLog = fn => { const s = ['log', 'warn', 'debug', 'info'].map(k => [k, console[k]]); for (const [k] of s) console[k] = () => {}; try { return fn(); } finally { for (const [k, f] of s) console[k] = f; } };
const ext = (lib, st, dur, bpm, diff, seed = 1, hints = {}) =>
  quietLog(() => withSeed(seed, () => lib.extractNoteEventsFromStems(st, dur, bpm, diff, hints)));
const handGaps = (evs, types = ['orb']) => {
  const g = [];
  for (const h of ['right', 'left']) {
    const t = evs.filter(e => e.hand === h && types.includes(e.type)).map(e => e.time).sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) g.push(t[i] - t[i - 1]);
  }
  return g;
};

// ── units ──────────────────────────────────────────────────────────────────────────────────
test('stemDensityProfile: Master is uncapped, the tiers taper gently and monotonically', () => {
  const m = NEW.stemDensityProfile(9);
  assert.deepEqual([m.keep, m.bass, m.hats, m.stream], [1, 1, 1, true]);
  assert.equal(NEW.stemDensityProfile(10).keep, 1);
  const tiers = [9, 8, 6, 4, 2].map(d => NEW.stemDensityProfile(d));
  for (let i = 1; i < tiers.length; i++) {
    for (const k of ['keep', 'bass']) {
      assert.ok(tiers[i][k] <= tiers[i - 1][k], `${k} rises from tier ${i - 1} to ${i}`);
      assert.ok(tiers[i][k] >= 0.6 * tiers[i - 1][k], `${k} drops by more than 40% from tier ${i - 1} to ${i} (not gentle)`);
    }
  }
  // the old flat keeps were 1.0/0.80/0.55/0.35/0.20 (drums) and half that for bass: never below them
  [1.0, 0.80, 0.55, 0.35, 0.20].forEach((old, i) => assert.ok(tiers[i].keep >= old));
});

test('stemKeepProb: base at median loudness, 1 at the loudest beat, base² at the quietest', () => {
  assert.equal(NEW.stemKeepProb(1, 0), 1);
  assert.equal(NEW.stemKeepProb(0.5, 1), 1);
  assert.ok(Math.abs(NEW.stemKeepProb(0.5, 0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(NEW.stemKeepProb(0.5, 0) - 0.25) < 1e-12);
  assert.equal(NEW.stemKeepProb(0, 0.7), 0);
  assert.equal(NEW.stemKeepProb(0.6, NaN), 0.6);
  let prev = -1;
  for (let r = 0; r <= 1; r += 0.1) { const p = NEW.stemKeepProb(0.4, r); assert.ok(p >= prev); prev = p; }
});

test('beatPhaseLock: grid onsets lock, random ones do not', () => {
  assert.ok(NEW.beatPhaseLock([0, 1, 2, 3, 4, 5]) > 0.999);
  assert.ok(NEW.beatPhaseLock([0, 0.5, 1, 1.5, 2.5, 3]) > 0.999);            // 8ths lock at k = 2
  assert.ok(NEW.beatPhaseLock([0, 1 / 3, 2 / 3, 1, 4 / 3]) > 0.999);         // triplets at k = 3
  let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const rnd = Array.from({ length: 200 }, () => r() * 100);
  assert.ok(NEW.beatPhaseLock(rnd) < 0.25, `random lock ${NEW.beatPhaseLock(rnd)}`);
  assert.equal(NEW.beatPhaseLock([]), 0);
});

test('rhythmOtherMap: beat-locked piano with sparse drums is the rhythm; with dense drums or off-grid it is not', () => {
  const bpm = 138, bps = bpm / 60;
  const piano = Array.from({ length: 64 }, (_, b) => ({ time: b / bps, energy: 0.5 }));
  const f1 = NEW.rhythmOtherMap(stems({ other: { onsets: piano, regions: [] } }), bps, 64);
  assert.ok(f1.slice(4, 60).every(v => v === 1), 'drumless piano quarters not flagged');
  const f2 = NEW.rhythmOtherMap(stems({ other: { onsets: piano, regions: [] }, drums: { onsets: doubleBass(bpm, 64), regions: [] } }), bps, 64);
  assert.ok(f2.every(v => v === 0), 'flagged under a 16th drum run');
  let s = 3; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const loose = Array.from({ length: 64 }, (_, b) => ({ time: (b + r()) / bps, energy: 0.5 }));
  const f3 = NEW.rhythmOtherMap(stems({ other: { onsets: loose, regions: [] } }), bps, 64);
  assert.ok(f3.filter(v => v).length < 8, `${f3.filter(v => v).length} beats flagged for off-grid onsets`);
});

// ── extractNoteEventsFromStems ─────────────────────────────────────────────────────────────
test('Master double bass: every hit becomes an event, alternating hands; OLD dropped the early ones', () => {
  const bpm = 103, beats = 32, on = doubleBass(bpm, beats), dur = (beats + 1) / (bpm / 60);
  for (const seed of [1, 2, 3]) {
    const evs = ext(NEW, stems({ drums: { onsets: on, regions: [] } }), dur, bpm, 9, seed);
    assert.equal(evs.length, on.length, `seed ${seed}: ${evs.length} events for ${on.length} hits`);
    assert.ok(evs.slice(1).every(e => e.stream), 'run hits not marked stream');
    let alt = 0; for (let i = 1; i < evs.length; i++) if (evs[i].hand !== evs[i - 1].hand) alt++;
    assert.equal(alt, evs.length - 1, 'hands do not alternate L-R');
    assert.ok(Math.min(...handGaps(evs)) >= PHYS - 1e-9);
    const old = ext(OLD, stems({ drums: { onsets: on, regions: [] } }), dur, bpm, 9, seed);
    assert.ok(old.length <= 0.8 * on.length, `seed ${seed}: OLD kept ${old.length}/${on.length} — no longer a baseline?`);
  }
});

test('fast tempo (170 BPM 16ths, 88 ms): no hand repeats faster than PHYS_SAME_HAND_SEC; OLD did', () => {
  const bpm = 170, beats = 32, on = doubleBass(bpm, beats).map((o, k) => ({ ...o, time: k / 4 / (bpm / 60) }));
  const dur = (beats + 1) / (bpm / 60);
  const evs = ext(NEW, stems({ drums: { onsets: on, regions: [] } }), dur, bpm, 9);
  assert.ok(evs.length >= 0.95 * on.length, `${evs.length}/${on.length}`);
  assert.ok(Math.min(...handGaps(evs)) >= PHYS - 1e-9, `min same-hand gap ${Math.min(...handGaps(evs))}`);
  const old = ext(OLD, stems({ drums: { onsets: on, regions: [] } }), dur, bpm, 9);
  assert.ok(Math.min(...handGaps(old)) < PHYS, 'OLD already respected the physical gap: no longer a baseline?');
});

test('a vocal rail holds the hand for 2 s, as onsetsToNotes makes it — not the 4 s that orphaned drum hits', () => {
  const bpm = 103, bps = bpm / 60, beats = 16, dur = beats / bps;
  const drums = Array.from({ length: beats * 2 }, (_, k) => ({ time: (0.25 + k / 2) / bps, energy: 0.7, subtype: 'kick' }));
  const st = stems({ drums: { onsets: drums, regions: [] },
    vocals: { onsets: [{ time: 0, energy: 0.6, pitch_row: 4 }], regions: [{ start: 0, end: 5.0, energy: 0.6 }] } });
  const evs = ext(NEW, st, dur, bpm, 9);
  const rail = evs.find(e => e.type === 'rail');
  assert.ok(rail && Math.abs(rail.duration - 2.0) < 1e-9, `rail ${JSON.stringify(rail)}`);
  assert.ok(evs.filter(e => e.type === 'companion').every(e => e.time < 2.0), 'companion after the 2 s rail end');
  assert.ok(evs.filter(e => e.type === 'orb' && e.time >= 2.0 && e.time < 4.0).length >= 3, 'no free orbs after the rail end');
  const old = ext(OLD, st, dur, bpm, 9);
  assert.ok(old.some(e => e.type === 'companion' && e.time >= 2.0), 'OLD had no orphaned companions: no longer a baseline?');
});

test('a sustained region too short for a 2-beat rail is an orb event, not a hand-blocking rail', () => {
  const bpm = 60, dur = 20;                                  // 2.0 s vocal cap = 2 beats at 60 BPM;
  const st = stems({ vocals: { onsets: [{ time: 1, energy: 0.6, pitch_row: 4 }], regions: [{ start: 1, end: 2.6, energy: 0.6 }] } });
  const evs = ext(NEW, st, dur, bpm, 9);                     // 1.6 s = 1.6 beats → orb
  assert.deepEqual(evs.map(e => e.type), ['orb']);
});

test('bass during a rail on the bass hand moves to the free hand (OLD dropped it)', () => {
  const bpm = 100, bps = bpm / 60, dur = 8;
  const bass = Array.from({ length: 6 }, (_, k) => ({ time: 0.3 + k * 0.3, energy: 0.6 }));
  const st = stems({ bass: { onsets: bass, regions: [] },
    vocals: { onsets: [{ time: 0, energy: 0.6, pitch_row: 4 }], regions: [{ start: 0, end: 3, energy: 0.6 }] } });
  let oldLost = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const evs = ext(NEW, st, dur, bpm, 9, seed);
    const rail = evs.find(e => e.type === 'rail');
    const b = evs.filter(e => e.stemSource === 'bass');
    assert.ok(b.length >= 4, `seed ${seed}: ${b.length} bass events`);
    assert.ok(b.every(e => e.hand !== rail.hand || e.time >= rail.time + rail.duration), `seed ${seed}: bass on the rail hand`);
    if (ext(OLD, st, dur, bpm, 9, seed).filter(e => e.stemSource === 'bass').length === 0) oldLost++;
  }
  assert.ok(oldLost > 0, 'OLD never lost the bass: no longer a baseline?');
  void bps;
});

test('drumless piano (beat-locked "other" under a sustain pedal) becomes orbs, not rails on both hands', () => {
  const bpm = 138, bps = bpm / 60, beats = 32, dur = beats / bps;
  const piano = Array.from({ length: beats }, (_, b) => ({ time: b / bps, energy: 0.5 }));
  // the pedal makes every 2-bar phrase one sustained region (in 'other', and in the vocal/melodic mix)
  const pedal = Array.from({ length: beats / 8 }, (_, i) => ({ start: i * 8 / bps, end: (i * 8 + 7.5) / bps, energy: 0.5 }));
  const st = stems({ other: { onsets: piano, regions: pedal }, vocals: { onsets: [], regions: pedal.map(r => ({ ...r })) } });
  const evs = ext(NEW, st, dur, bpm, 9);
  const hits = evs.filter(e => e.stemSource === 'other' && e.type !== 'rail');
  assert.ok(hits.length >= 0.9 * piano.length, `${hits.length}/${piano.length} piano hits are notes`);
  // (the first and last few beats have too few onsets in the ±4-beat window for a significant lock)
  assert.ok(hits.filter(e => e.rhythm).length >= 0.75 * piano.length, 'rhythm-source hits not tagged');
  const old = ext(OLD, st, dur, bpm, 9);
  assert.ok(old.filter(e => e.type !== 'rail').length <= 0.2 * piano.length, `OLD already made ${old.length} events: no longer a baseline?`);
});

test('piano under a full drum groove keeps its old role (no rhythm tag, no extra orbs)', () => {
  const bpm = 138, bps = bpm / 60, beats = 32, dur = beats / bps;
  const piano = Array.from({ length: beats }, (_, b) => ({ time: (b + 0.5) / bps, energy: 0.5 }));
  const drums = Array.from({ length: beats * 2 }, (_, k) => ({ time: k / 2 / bps, energy: 0.7, subtype: k % 2 ? 'snare' : 'kick' }));
  const evs = ext(NEW, stems({ drums: { onsets: drums, regions: [] }, other: { onsets: piano, regions: [] } }), dur, bpm, 9);
  assert.ok(!evs.some(e => e.rhythm));
  assert.equal(evs.filter(e => e.stemSource === 'other').length, 0);
});

test('taper: Master keeps all, the tiers below keep fewer, and quiet beats give theirs up first', () => {
  const bpm = 100, bps = bpm / 60, beats = 128, dur = beats / bps;
  const drums = Array.from({ length: beats }, (_, b) => ({ time: (b + 0.02) / bps, energy: 0.7, subtype: b % 2 ? 'snare' : 'kick' }));
  const energyCurve = Array.from({ length: beats }, (_, b) => (b < beats / 2 ? 0.2 : 0.9) + (b % 7) * 0.001);
  const kept = {};
  for (const diff of [9, 8, 6, 4, 2]) {
    let q = 0, l = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const evs = ext(NEW, stems({ drums: { onsets: drums, regions: [] } }), dur, bpm, diff, seed, { _energyCurve: energyCurve });
      q += evs.filter(e => e.time * bps < beats / 2).length; l += evs.filter(e => e.time * bps >= beats / 2).length;
    }
    kept[diff] = { quiet: q / 20 / (beats / 2), loud: l / 20 / (beats / 2) };
  }
  assert.deepEqual(kept[9], { quiet: 1, loud: 1 });
  const all = d => (kept[d].quiet + kept[d].loud) / 2;
  assert.ok(all(8) > all(6) && all(6) > all(4) && all(4) > all(2), JSON.stringify(kept));
  for (const d of [8, 6, 4, 2]) assert.ok(kept[d].loud > kept[d].quiet + (d >= 8 ? 0.03 : 0.1), `diff ${d}: ${JSON.stringify(kept[d])}`);
});

// ── onsetsToNotes (closure-loaded) ─────────────────────────────────────────────────────────
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
const ROOTS = ['onsetsToNotes', 'detectSectionsFromAudio'];
const GEN_NEW = closure(appSource(), ROOTS);
const GEN_OLD = closure(execSync(`git show ${OLD_REV}:synthriders-creator.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString(), ROOTS);
function gen(lib, analysis, bpm, diff, sections, seed, hints = {}) {
  const q = ['log', 'warn', 'debug', 'error', 'info'].map(k => [k, console[k]]);
  for (const [k] of q) console[k] = () => {};
  globalThis.window = {};
  try { return withSeed(seed, () => lib.onsetsToNotes(structuredClone(analysis), bpm, diff, structuredClone(sections), { ...hints })).notes; }
  finally { for (const [k, f] of q) console[k] = f; delete globalThis.window; }
}
const coverage = (notes, beats, tol = 0.13) => {
  const nb = notes.map(n => n.beat).sort((a, b) => a - b);
  return beats.filter(b => nb.some(x => Math.abs(x - b) <= tol)).length / beats.length;
};

// 96 beats at 103 BPM: double bass under a snare on every beat, a 4 s vocal phrase every 8 beats.
function metalSong() {
  const bpm = 103, bps = bpm / 60, beats = 96;
  const drums = doubleBass(bpm, beats);
  const vocals = [], vreg = [];
  for (let b = 2; b < beats - 8; b += 8) { vocals.push({ time: b / bps, energy: 0.6, pitch_row: 4 }); vreg.push({ start: b / bps, end: b / bps + 4, energy: 0.6 }); }
  const analysis = { bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [],
    energyCurve: Array.from({ length: beats }, (_, b) => 0.8 + 0.1 * Math.sin(b / 5)), duration: beats / bps, panningByBeat: null,
    stemData: stems({ drums: { onsets: drums, regions: [] }, vocals: { onsets: vocals, regions: vreg } }) };
  const sections = [0, 32, 64].map((s, i) => ({ name: ['verse', 'chorus', 'verse 2'][i], startBeat: s, endBeat: s + 32,
    avgRow: 5, rowVariance: 2, rowContour: 'plateau', noteStyle: 'alternating-flow', handMode: 'both-hands', density: 2, climax: false }));
  return { analysis, sections, bpm, hits: drums.map(o => o.time * bps) };
}

test('onsetsToNotes, Master double bass: the hits are tracked, alternating, accents paired on the beat', () => {
  const s = metalSong();
  let covNew = 0, covOld = 0;
  for (const seed of [1, 2, 3]) {
    const nw = gen(GEN_NEW, s.analysis, s.bpm, 9, s.sections, seed), od = gen(GEN_OLD, s.analysis, s.bpm, 9, s.sections, seed);
    covNew += coverage(nw, s.hits) / 3; covOld += coverage(od, s.hits) / 3;
    // off-beat 16ths are single notes (alternation), not two-hand mirrors
    const at = new Map(); for (const n of nw) if (n.type <= 1) { const k = Math.round(n.beat * 4); at.set(k, (at.get(k) || 0) + 1); }
    const odd = [...at].filter(([k]) => k % 2), pairs = odd.filter(([, c]) => c >= 2).length;
    assert.ok(pairs <= 0.15 * odd.length, `seed ${seed}: ${pairs}/${odd.length} off-beat 16ths are two-hand pairs`);
  }
  assert.ok(covNew >= 0.75, `NEW covers ${(100 * covNew).toFixed(0)}% of the hits`);
  assert.ok(covNew >= covOld + 0.1, `NEW ${(100 * covNew).toFixed(0)}% vs OLD ${(100 * covOld).toFixed(0)}%`);
});

// ── real songs (Demucs; skipped without ..\MP3 or Demucs) ─────────────────────────────────
// Chaos Control 150-180 s (86 BPM, 16th double bass under a snare backbeat): drum-hit coverage.
// Kin, the WHOLE song (138 BPM; 352-415 beats etc. are drumless staccato piano): coverage of the
// 'other' hits where the drums are silent. Whole song because the drum detector's loudness gate is
// relative to the song's median: on a drumless 28 s excerpt the piano passage IS the loud half, and
// bleed came out as 57 drum "hits" that the full song does not have.
// analyse_stems with the clip's own beat-1 pad, then onsetsToNotes NEW vs OLD at Master on
// audio-derived sections, 3 seeds. noGold for both: on a 30 s clip the map can end up with no gold
// at all, and then onsetsToNotes' "guarantee gold" block throws (it reads goldRails /
// goldRailActiveAt / singleRailActiveAt, which are scoped inside the earlier scatter block; seen
// on OLD, 2026-11-23). In the app that throw drops the whole map to the expandSections fallback.
function py(code) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})\n`;
  const out = execFileSync('py', ['-3.12', '-I', '-c', prelude + code], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 900000 });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}
const MP3 = path.resolve(ROOT, '..', 'MP3');
const EXCERPTS = [
  { key: 'cc', file: "Deckard 'Dex' Voltaire - Chaos Control.ogg", bpm: 86.001, offset: 150, duration: 30 },
  { key: 'kin', file: "PROF - Kin (I'm Outside) [feat. Pete & Bas and JonRay].ogg", bpm: 138.0, offset: 0, duration: null },
].filter(e => fs.existsSync(path.join(MP3, e.file)));
const demucs = EXCERPTS.length ? py(`import server; print(json.dumps(server.check_demucs()[0]))`) : false;
const skipReal = !EXCERPTS.length ? 'no songs in ..\\MP3' : !demucs ? 'Demucs not installed' : false;

test('real songs: Chaos Control double bass and Kin piano are tracked better than before', { skip: skipReal }, () => {
  const res = py(`
import os, tempfile, shutil, librosa, soundfile as sf, server
out = {}
for e in json.loads(${JSON.stringify(JSON.stringify(EXCERPTS))}):
    y, sr = librosa.load(os.path.join(${JSON.stringify(MP3)}, e['file']), sr=44100, mono=False, offset=e['offset'], duration=e['duration'])
    ym = librosa.resample(librosa.to_mono(y), orig_sr=sr, target_sr=22050)
    env = librosa.onset.onset_strength(y=ym, sr=22050, hop_length=server.TEMPO_HOP)
    P = 60 / e['bpm']; ph = server.lattice_phase(env, server.TEMPO_HOP / 22050, e['bpm'])['phase']
    pad = (P - ph % P) % P
    d = tempfile.mkdtemp()
    try:
        wav = os.path.join(d, 'excerpt.wav'); sf.write(wav, y.T, sr, subtype='PCM_16')
        st = server.separate_stems(open(wav, 'rb').read(), '.wav', d)
        out[e['key']] = server.analyse_stems(st, e['bpm'], None, pad)
    finally:
        shutil.rmtree(d, ignore_errors=True)
print(json.dumps(out, cls=server._NumpyEncoder))
`);
  for (const e of EXCERPTS) {
    const a = res[e.key], bps = e.bpm / 60;
    const analysis = { bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [], energyCurve: a.energy_curve,
      duration: a.duration, panningByBeat: a.panning_by_beat, stemData: a.stems };
    const sections = quietLog(() => GEN_NEW.detectSectionsFromAudio(a.stems, e.bpm, a.duration))
      || [{ name: 'all', startBeat: 0, endBeat: Math.ceil(a.duration * bps), avgRow: 5, rowVariance: 2 }];
    const stem = e.key === 'cc' ? 'drums' : 'other';
    const drumBeats = a.stems.drums.onsets.map(o => o.time * bps);
    const hits = a.stems[stem].onsets.map(o => o.time * bps)
      .filter(b => stem === 'drums' || drumBeats.filter(d => Math.abs(d - b) < 4).length <= 2);
    let cn = 0, co = 0;
    for (const seed of [1, 2, 3]) {
      cn += coverage(gen(GEN_NEW, analysis, e.bpm, 9, sections, seed, { noGold: true }), hits) / 3;
      co += coverage(gen(GEN_OLD, analysis, e.bpm, 9, sections, seed, { noGold: true }), hits) / 3;
    }
    const label = `${e.key}: ${stem} coverage NEW ${(100 * cn).toFixed(0)}% vs OLD ${(100 * co).toFixed(0)}% (${hits.length} hits)`;
    console.log(label);
    assert.ok(hits.length >= 40, label);
    assert.ok(cn >= co + 0.1, label);
  }
});
