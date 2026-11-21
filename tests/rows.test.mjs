// The app designs heights on its 11-row ROW_Y; server.py's /export writes them into the .synth.
// Until 2026-11-21 the exporter kept a stale 8-row table (rows clamped to 0-7), so every map
// shipped lower than designed and rows 7-10 collapsed onto the floor. validate.py copied the
// exporter's table, so it agreed with the bug. These tests run the REAL export function and
// the REAL validator decode against the app's own ROW_Y.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { load, ROOT } from './harness.mjs';

const { ROW_Y } = load(['ROW_Y']);

// Run Python with the project folder importable; returns parsed JSON printed by `code`.
function py(code) {
  const prelude = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)})\n`;
  const out = execFileSync('py', ['-3.12', '-I', '-c', prelude + code], { cwd: ROOT, encoding: 'utf8' });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

test('server.py ROW_Y is the app ROW_Y', () => {
  const srv = py('import server; print(json.dumps(server.ROW_Y))');
  assert.equal(ROW_Y.length, 11);
  assert.deepEqual(srv, ROW_Y);
});

test('export writes every app row at the app height, rails included', () => {
  const bpm = 120;
  const notes = ROW_Y.map((_, r) => ({ beat: r * 2, row: r, type: r % 2, _x: 0.4095 }));
  notes.push({                                     // rail riding down to the floor
    beat: 40, row: 1, type: 0, _x: 0.2,
    railEndBeat: 44, railEndRow: 10, railEnd_x: 0.5,
    railSegments: [{ beat: 41, row: 4.5, _x: 0.3 }, { beat: 42, row: 8, _x: 0.4 }],
  });
  notes.push({ beat: 50, row: 13, type: 1, _x: -0.3 }); // out of range -> clamps to floor
  const track = py(`import server\n` +
    `notes = json.loads(${JSON.stringify(JSON.stringify(notes))})\n` +
    `print(json.dumps(server.build_note_track(notes, ${bpm})))`);
  const y = r => +(ROW_Y[r] + 0.0012).toFixed(6);
  for (let r = 0; r < ROW_Y.length; r++) {
    const [n] = track[String(r * 2 * 64)];
    assert.equal(n.Position[1], y(r), `row ${r}`);
    assert.equal(n.Position[2], +((r * 2) / (bpm / 60) * 20).toFixed(6), `row ${r} z`);
  }
  const rail = track[String(40 * 64)][0];
  assert.equal(rail.Position[1], y(1));
  // 4.5 rounds half up (JS Math.round, as the 3D preview draws it) -> row 5
  assert.deepEqual(rail.Segments.map(s => s[1]), [y(5), y(8), y(10)]);
  assert.equal(track[String(50 * 64)][0].Position[1], y(10));
});

test('validate.py decodes exported heights back to the same rows', () => {
  const res = py(`import validate\n` +
    `ys = [y + validate.Y_OFFSET for y in validate.ROW_Y]\n` +
    `old8 = [0.6825, 0.4875, 0.2925, 0.0975, -0.0975, -0.2925, -0.4875, -0.6825]\n` +
    `print(json.dumps({'rows': [validate._row_of(y) for y in ys],` +
    ` 'off': [validate._off_grid(y) for y in ys],` +
    ` 'old_off': sum(validate._off_grid(y + 0.0012) for y in old8)}))`);
  assert.deepEqual(res.rows, ROW_Y.map((_, r) => r));
  assert.ok(res.off.every(o => o === false));
  assert.equal(res.old_off, 6);  // the stale 8-row heights are caught (only ±0.6825 coincide)
});
