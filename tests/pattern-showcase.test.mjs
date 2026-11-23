// The Pattern Showcase generator (tools/pattern_showcase_gen.mjs) must keep working as the app changes:
// it slices real blocks out of onsetsToNotes by marker comment, so a moved marker should fail HERE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, load } from './harness.mjs';

const out = JSON.parse(execFileSync('node', [path.join(ROOT, 'tools', 'pattern_showcase_gen.mjs')],
  { cwd: ROOT, maxBuffer: 64 << 20 }).toString());
const { COL_X, DANCE_MOVES } = load(['COL_X', 'buildDanceMoves', 'DANCE_MOVES']);
const colOf = x => COL_X.findIndex(c => Math.abs(c - x) < 1e-9);

test('showcase: every dance move, rail shape tier and gold shape is present', () => {
  const names = out.patterns.map(p => p.name);
  for (const m of DANCE_MOVES) assert.ok(names.includes(`Move: ${m.name}`), m.name);
  for (const s of ['spiral', 'figure eight', 'staircase', 'zigzag', 'wave', 'pendulum', 'switchback', 'ramp', 'hook', 'flick'])
    assert.ok(names.some(n => n.startsWith('Rail:') && n.toLowerCase().includes(s)), s);
  assert.equal(names.filter(n => n.startsWith('Gold:')).length, 5);
});

test('showcase: notes are valid (rows 0-10, columns 0-14, known types, rails end after they start)', () => {
  for (const p of out.patterns) for (const n of p.notes) {
    assert.ok(n.row >= 0 && n.row <= 10, `${p.name} row ${n.row}`);
    assert.ok(colOf(n._x) >= 0, `${p.name} off-grid x`);
    assert.ok([0, 1, 2, 3].includes(n.type));
    if (n.railEndBeat != null) assert.ok(n.railEndBeat > n.beat && n.railSegments.length >= 1, p.name);
  }
});

test('showcase: every DenseSweep move note was actually shaped by the real block', () => {
  for (const p of out.patterns.filter(p => p.name.startsWith('Move:')))
    assert.equal(p.info.taggedNotes, p.info.of, p.name);
});

test('showcase: parallel spiral turns one way on both hands, mirrored spiral turns opposite ways', () => {
  const get = n => out.patterns.find(p => p.name === n).info;
  const par = get('Move: parallelSpiral'), mir = get('Move: mirrorSpiral');
  assert.equal(par.rightStats.turn, par.leftStats.turn);
  assert.notEqual(mir.rightStats.turn, mir.leftStats.turn);
});
