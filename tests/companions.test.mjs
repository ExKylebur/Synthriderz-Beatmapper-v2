// Companions of a rail that a pass deletes (releaseRailCompanions), on the REAL declarations.
// Found offline 2026-11-24 (Faith, Expert, seed 1, density branch): onsetsToNotes' same-hand rail
// dedup dropped a left rail (301 -> 306) that overlapped a new squat underrail (305.5 -> 312.5).
// Its companions kept _comp and the dead rail's columns; one sat at col 10, which an earlier pass
// had dragged it to, and validate.py failed the map (HARD ZONE). Nothing re-snaps or clamps a
// _comp note without a rail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, appSource, extract, colOf } from './harness.mjs';

const K = load(['COL_X', 'CROSS_REACH_COLS', 'handZoneCols', '_htCol', 'releaseRailCompanions']);
const at = (beat, type, col, extra = {}) => ({ beat, type, _x: K.COL_X[col], row: 4, ...extra });

test('a removed rail\'s companions become free orbs in their own zone; a surviving rail keeps its own', () => {
  const removed = at(301, 1, 7, { railEndBeat: 306, railEndRow: 4, railEnd_x: K.COL_X[4] });
  const squat = at(305.5, 1, 4, { railEndBeat: 312.5, railEndRow: 7, _underSquatRail: true });
  const notes = [
    squat,
    at(296, 1, 9, { _comp: true }),        // before the removed rail: another rail's business
    at(301.5, 1, 10, { _comp: true }),     // the HARD ZONE note: back to the left zone (col 7)
    at(302, 1, 8, { _comp: true }),        // just past centre: col 7
    at(304, 1, 4, { _comp: true }),        // in zone: only the tag goes
    at(306, 1, 5, { _comp: true }),        // inside the squat rail too: keeps its tag
    at(302, 0, 6, { _comp: true }),        // the other hand: untouched
  ];
  const before = structuredClone(notes);
  assert.equal(K.releaseRailCompanions(notes, [removed]), 3);
  const col = n => colOf(n._x);
  assert.deepEqual(notes.slice(2, 5).map(n => [n.beat, col(n), !!n._comp]), [[301.5, 7, false], [302, 7, false], [304, 4, false]]);
  for (const i of [0, 1, 5, 6]) assert.deepEqual(notes[i], before[i], `note ${i} untouched`);
});

test('a gold rail over the companion also keeps it; no removed rails is a no-op', () => {
  const removed = at(10, 0, 10, { railEndBeat: 14 });
  const notes = [at(11, 3, 7, { railEndBeat: 13 }), at(12, 0, 3, { _comp: true })];
  assert.equal(K.releaseRailCompanions(notes, [removed]), 0);
  assert.equal(notes[1]._comp, true);
  assert.equal(K.releaseRailCompanions(notes, []), 0);
});

test('onsetsToNotes\' same-hand rail dedup releases the removed rails\' companions', () => {
  const body = extract(appSource(), 'onsetsToNotes');
  const i = body.indexOf('same-hand rail overlap(s) in post-gen dedup');
  assert.ok(i > 0);
  assert.match(body.slice(i, i + 600), /releaseRailCompanions\(result, toRemove\)/);
  assert.ok(i < body.indexOf('// ── Definitive snap pass'), 'released before the snap pass re-snaps the surviving rails');
});
