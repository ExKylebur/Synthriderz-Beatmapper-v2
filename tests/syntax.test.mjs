import test from 'node:test';
import assert from 'node:assert/strict';
import { appSource } from './harness.mjs';

test('every inline <script> block parses', () => {
  const re = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(appSource()))) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
});
