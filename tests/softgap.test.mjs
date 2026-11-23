// [FEAT-4] gap-fill in soft passages. User VR test of "Echolokators" (2026-11-22): 7.9 s of dead air
// in a quiet middle section. Cause: that section is energy 0.15-0.20 (a 'sparse' section thins events
// 40-70% in the main loop) and the gap-fill floor was 0.25, so gap-fill refused every candidate.
// The "before" build is the SAME source with the old constants patched back in, so this test
// stays meaningful and cannot drift from a pinned commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appSource, extract, withSeed } from './harness.mjs';

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
const SRC = appSource();
const OLD = SRC.replace('const GAPFILL_MIN_ENERGY  = 0.10', 'const GAPFILL_MIN_ENERGY  = 0.25')
               .replace('const GAPFILL_SOFT_SCALE  = 4;', 'const GAPFILL_SOFT_SCALE  = 1;');
assert.notEqual(OLD, SRC, 'constants moved: update the "before" patch in this test');
const NOW = closure(SRC, ['onsetsToNotes']);
const BEFORE = closure(OLD, ['onsetsToNotes']);

// 120 BPM, 288 beats (144 s). Loud verse/chorus around a quiet breakdown at beats 96-192 (48-96 s):
// energy 0.17, no drums/bass/vocals, a guitar onset every half-beat at energy 0.1 (all audible).
const BPM = 120, BPS = BPM / 60, BEATS = 288, SOFT = [96, 192];
function song({ soft = true, softEnergy = 0.17 } = {}) {
  const T = b => b / BPS;
  const drums = [], bass = [], other = [], vocals = [];
  for (let b = 0; b < BEATS; b++) {
    const inSoft = soft && b >= SOFT[0] && b < SOFT[1];
    if (inSoft) { other.push({ time: T(b), energy: 0.1 }); other.push({ time: T(b + 0.5), energy: 0.1 }); continue; }
    drums.push({ time: T(b), energy: 0.9, subtype: b % 2 ? 'snare' : 'kick' });
    drums.push({ time: T(b + 0.5), energy: 0.4, subtype: 'hat' });
    bass.push({ time: T(b), energy: 0.7 });
    other.push({ time: T(b + 0.25), energy: 0.5 });
  }
  const energyCurve = Array.from({ length: BEATS }, (_, b) => (soft && b >= SOFT[0] && b < SOFT[1]) ? softEnergy : 0.8);
  const analysis = {
    bassOnsets: [], midOnsets: [], highOnsets: [], sustainedRegions: [], energyCurve,
    duration: T(BEATS), panningByBeat: null,
    stemData: { drums: { onsets: drums, regions: [] }, bass: { onsets: bass, regions: [] },
                other: { onsets: other, regions: [] }, vocals: { onsets: vocals, regions: [] } },
  };
  const mk = (name, a, e, noteStyle) => ({ name, startBeat: a, endBeat: e, avgRow: 5, rowVariance: 2, rowContour: 'plateau',
    noteStyle, handMode: 'alternating', density: noteStyle === 'sparse' ? 0.3 : 0.7, climax: false });
  const sections = [mk('verse', 0, 96, 'alternating-flow'), mk('break', 96, 192, soft ? 'sparse' : 'alternating-flow'),
    mk('chorus', 192, 288, 'alternating-flow')];
  return { analysis, sections };
}
function run(lib, s, diff, seed) {
  const quiet = ['log', 'warn', 'debug', 'error', 'info'].map(k => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  globalThis.window = {};
  try { return withSeed(seed, () => lib.onsetsToNotes(structuredClone(s.analysis), BPM, diff, structuredClone(s.sections), {})); }
  finally { for (const [k, f] of quiet) console[k] = f; delete globalThis.window; }
}
// Longest stretch (seconds) with nothing to hit AND nothing held: rails count as activity.
function deadAir(notes, dur) {
  const sp = notes.map(n => [n.beat / BPS, (n.railEndBeat != null ? n.railEndBeat : n.beat) / BPS]).sort((a, b) => a[0] - b[0]);
  let end = 0, worst = 0;
  for (const [s, e] of sp) { worst = Math.max(worst, s - end); end = Math.max(end, e); }
  return Math.max(worst, dur - end);
}

for (const diff of [9, 5]) {
  test(`diff ${diff}: a soft sparse passage keeps notes (no dead air over 4 s) where the old floor left a hole`, () => {
    const s = song();
    const dur = s.analysis.duration;
    let oldWorst = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const now = deadAir(run(NOW, s, diff, seed).notes, dur);
      assert.ok(now < 4, `seed ${seed}: ${now.toFixed(1)} s of dead air with the fix`);
      oldWorst = Math.max(oldWorst, deadAir(run(BEFORE, s, diff, seed).notes, dur));
    }
    assert.ok(oldWorst > 4, `scenario no longer reproduces the bug (old worst ${oldWorst.toFixed(1)} s) - tighten it`);
  });
}

test('soft passage stays sparse: far fewer notes there than in the loud verse', () => {
  const s = song();
  const notes = run(NOW, s, 9, 3).notes;
  const inR = (n, a, b) => n.beat >= a && n.beat < b;
  const soft = notes.filter(n => inR(n, SOFT[0], SOFT[1])).length;
  const loud = notes.filter(n => inR(n, 0, 96)).length;
  assert.ok(soft >= 10, `only ${soft} notes in the soft passage`);
  assert.ok(soft < loud * 0.5, `soft passage not sparse: ${soft} vs ${loud}`);
});

test('a song with no soft passage is byte-identical to the old behaviour (dense songs do not change)', () => {
  const s = song({ soft: false });
  for (const diff of [9, 6]) for (const seed of [1, 2, 3]) {
    const a = run(NOW, s, diff, seed).notes, b = run(BEFORE, s, diff, seed).notes;
    assert.ok(a.length > 100);
    assert.equal(JSON.stringify(a), JSON.stringify(b), `diff ${diff} seed ${seed}`);
  }
});
