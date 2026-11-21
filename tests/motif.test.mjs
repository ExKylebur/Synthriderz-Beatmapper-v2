import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const M = load(['CHORUS_RE', 'chorusRootKey', 'createMotifMemory']);

test('chorusRootKey groups repeated choruses, ignores non-chorus + pre-chorus', () => {
  assert.equal(M.chorusRootKey('Chorus 2'), 'chorus');
  assert.equal(M.chorusRootKey('chorus (x2)'), 'chorus');
  assert.equal(M.chorusRootKey('chorus1'), 'chorus');
  assert.equal(M.chorusRootKey('Final Chorus'), 'final chorus');
  assert.equal(M.chorusRootKey('Drop 3'), 'drop');
  assert.equal(M.chorusRootKey('pre-chorus'), null);
  assert.equal(M.chorusRootKey('verse1'), null);
  assert.equal(M.chorusRootKey(undefined), null);
});

test('memory: first occurrence records, later ones replay in order, per kind', () => {
  const c1 = { name: 'chorus1', startBeat: 64 }, c2 = { name: 'chorus2', startBeat: 160 };
  const v = { name: 'verse1', startBeat: 0 };
  const mem = M.createMotifMemory([c2, v, c1]);                 // unsorted on purpose
  assert.equal(mem.replay(c1, 'rails'), null);                  // owner never replays
  mem.record(c1, 'rails', 'A'); mem.record(c1, 'rails', 'B'); mem.record(c1, 'dense', 7);
  mem.record(c2, 'rails', 'X');                                 // non-owner records are ignored
  mem.record(v, 'rails', 'Y');                                  // non-chorus ignored
  assert.equal(mem.replay(c2, 'rails'), 'A');
  assert.equal(mem.replay(c2, 'rails'), 'B');
  assert.equal(mem.replay(c2, 'rails'), 'A');                   // cycles
  assert.equal(mem.replay(c2, 'dense'), 7);
  assert.equal(mem.replay(c2, 'gold'), null);                   // nothing recorded for that kind
  assert.equal(mem.replay(v, 'rails'), null);
  assert.deepEqual(mem.stats(), { roots: 1, recorded: 3, replayed: 4 });
});
