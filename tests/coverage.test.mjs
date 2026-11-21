import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const C = load(['isPattern', 'PATTERN_COVERAGE_BAND', 'isCoverageNote', 'patternCoverage',
  'patternRuns', 'enforcePatternCoverage']);

const mk = (beat, tag, extra = {}) => ({ beat, type: beat % 2, _x: 0.5, row: 5,
  ...(tag ? { [tag]: true, _preSweep: { x: -0.25, row: 3 } } : {}), ...extra });

test('coverage counts rails, companions, dense, sparse, goldSweep', () => {
  const notes = [mk(0, '_denseSweep'), mk(1, '_sparseSweep'), mk(2, null, { _goldSweep: true }),
    mk(3, null, { railEndBeat: 5 }), mk(4, null, { _comp: true }), mk(5), mk(6), mk(7), mk(8), mk(9)];
  assert.equal(C.patternCoverage(notes), 0.5);
});

// 80 notes: 40 dense + 4 sparse + 10 sparse + 10 rails + 4 goldSweep = 68 covered (85%), 12 free.
// Target floor(0.8*80)=64 → excess 4 → exactly the short sparse run is demoted.
test('over band: demote sparse first (shortest run first), never rails/goldSweep, restore snapshot', () => {
  const notes = [];
  for (let b = 0; b < 40; b++) notes.push(mk(b, '_denseSweep'));            // one long dense run
  for (let b = 100; b < 104; b++) notes.push(mk(b, '_sparseSweep'));        // short sparse run
  for (let b = 200; b < 210; b++) notes.push(mk(b, '_sparseSweep'));        // longer sparse run
  for (let b = 300; b < 310; b++) notes.push(mk(b, null, { railEndBeat: b + 1 }));
  for (let b = 400; b < 404; b++) notes.push(mk(b, null, { _goldSweep: true }));
  for (let b = 500; b < 512; b++) notes.push(mk(b));                        // free
  const res = C.enforcePatternCoverage(notes);
  assert.ok(res.before > 0.8 && res.after <= 0.8, JSON.stringify(res));
  assert.equal(res.demoted, 4);
  const short = notes.filter(n => n.beat >= 100 && n.beat < 104);
  assert.ok(short.every(n => !n._sparseSweep && n._x === -0.25 && n.row === 3 && !n._preSweep));
  assert.ok(notes.filter(n => n.beat >= 200 && n.beat < 210).every(n => n._sparseSweep), 'longer run kept');
  assert.ok(notes.filter(n => n.railEndBeat !== undefined || n._goldSweep).every(n => n._x === 0.5));
  assert.ok(notes.filter(n => n.beat < 40).every(n => n._denseSweep), 'dense untouched');
});

test('over band: a run whose demotion would undershoot the band floor is skipped', () => {
  const notes = [];
  for (let b = 0; b < 90; b++) notes.push(mk(b, '_denseSweep'));            // 90% in ONE run
  for (let b = 500; b < 510; b++) notes.push(mk(b));
  const res = C.enforcePatternCoverage(notes);
  assert.equal(res.demoted, 0);                                              // 90 → 0% would undershoot 60%
  assert.equal(res.after, 0.9);
});

test('under band: promote() is called once and its tagged count is reported', () => {
  const notes = Array.from({ length: 20 }, (_, b) => mk(b));
  let calls = 0;
  const res = C.enforcePatternCoverage(notes, { promote: () => { calls++; notes.slice(0, 14).forEach(n => { n._sparseSweep = true; }); return { tagged: 14 }; } });
  assert.equal(calls, 1);
  assert.equal(res.promoted, 14);
  assert.equal(res.after, 0.7);
});
