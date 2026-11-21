# Plan: Pattern modularization (multi-segment rails, SparseSweep, coverage band, chorus motif memory)

**Spec:** `docs/superpowers/specs/2026-11-21-pattern-modularization-design.md` (approved 2026-11-21)

**Architecture:** every new piece is a **module-level pure-ish function** in `synthriders-creator.html`. Each declaration starts at column 0 and ends with `}` / `};` / `];` at column 0, so the Node harness can extract it. `onsetsToNotes` only gains thin call sites. Rail planning (`planRailSegments` / `fitRailPlan`) is split from rail drawing (`buildRailPath`), so motif replay can hand `generateRailArc` a recorded plan. `[DenseSweep]` and `[SparseSweep]` share one move library (`DANCE_MOVES`) and one boundary smoother (`smoothPatternBoundaries`). Pattern membership is one predicate, `isPattern(n)`.

**Tech stack:** vanilla JS in the single HTML file; Node 24 built-in test runner (`node --test`) with a harness that extracts real declarations from the HTML (no copies); the live app on the :8092 agent server (`synthmapper-v2-agent`) plus `validate.py` for end-to-end checks.

**Ground rules for the implementer:**
- Run `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails) after every task. All tests must pass before you commit.
- After any edit to `synthriders-creator.html`, also run the syntax check (Task 0 adds it as a test).
- **Never** read or print `.anthropic_key`.
- Commit messages end with the repo's `Co-Authored-By` line.

## File Map

| File | Change | Purpose |
|---|---|---|
| `tests/harness.mjs` | **create** | Extracts named declarations from the HTML (working tree or a git rev); seeded `Math.random` |
| `tests/syntax.test.mjs` | **create** | Every inline `<script>` parses |
| `tests/rail-shapes.test.mjs` | **create** | Tier helpers, segment planning, multi-segment `generateRailArc`, golden regression vs `acd1853` |
| `tests/motif.test.mjs` | **create** | `chorusRootKey`, `createMotifMemory` |
| `tests/sweeps.test.mjs` | **create** | `DANCE_MOVES`, `isPattern`, `smoothPatternBoundaries`, `applySparseSweep` |
| `tests/coverage.test.mjs` | **create** | `patternCoverage`, `enforcePatternCoverage` |
| `synthriders-creator.html` | modify | New module-level helpers after `handZoneCols` (~line 1441); refactor `generateRailArc`; call sites in `onsetsToNotes`; pattern-aware C3 / occlusion / critic tags |
| `style_critic_prompt.md` | modify | Describe multi-segment rails and `pattern:"sparse"` |
| `handoff_next_session.md` | modify (gitignored) | Session log |

---

## Tasks

### Task 0: Test harness + syntax test

- [x] **Create `tests/harness.mjs`:**

```js
// Loads REAL declarations out of synthriders-creator.html so tests exercise shipped code,
// never a copy. A declaration must start at column 0 (`function x(` / `const x =`) and end
// at the first following line that starts with `}` or `]` (or be a single line ending in `;`).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP = path.join(ROOT, 'synthriders-creator.html');

export function extract(src, name) {
  const lines = src.split(/\r?\n/);
  const re = new RegExp(`^(?:async\\s+)?function ${name}\\(|^(?:const|let) ${name}\\s*=`);
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) throw new Error(`declaration not found: ${name}`);
  const isFn = /^(?:async\s+)?function/.test(lines[i]);
  if (!isFn && /;\s*(\/\/.*)?$/.test(lines[i])) return lines[i];
  for (let j = i + 1; j < lines.length; j++)
    if (/^[}\]]/.test(lines[j])) return lines.slice(i, j + 1).join('\n');
  throw new Error(`no end found for: ${name}`);
}

export function loadFrom(src, names) {
  const code = names.map(n => extract(src, n)).join('\n');
  return new Function(`${code}\nreturn { ${names.join(', ')} };`)();
}

export const appSource = () => fs.readFileSync(APP, 'utf8');
export const load = names => loadFrom(appSource(), names);
export const loadAt = (rev, names) => loadFrom(
  execSync(`git show ${rev}:synthriders-creator.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString(),
  names);

// Seeded Math.random (mulberry32) for the duration of fn.
export function withSeed(seed, fn) {
  const orig = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return fn(); } finally { Math.random = orig; }
}

// Declarations generateRailArc needs (geometry + zone).
export const RAIL_DEPS = ['ROW_Y', 'P3D', 'COL_X', 'OBS_BOX', 'OBS_CLEAR', 'OBSTACLE_BUFFER_BEATS',
  'OBSTACLE_LEAD_BEATS', 'obstacleSide', 'obstacleColLimit', 'obstacleBandAt',
  'CROSS_REACH_COLS', 'handZoneCols'];
export const colOf = x => Math.round((x + 0.9555) / 0.1365);
```

- [x] **Create `tests/syntax.test.mjs`:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { appSource } from './harness.mjs';

test('every inline <script> block parses', () => {
  const re = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(appSource()))) { n++; assert.doesNotThrow(() => new Function(m[1])); }
  assert.ok(n >= 1);
});
```

- [x] **Run:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: `ℹ pass 1`, `ℹ fail 0`.
- [x] **Commit:** `git add tests && git commit -m "tests: Node harness extracting real declarations from the app + syntax test"`

---

### Task 1: Rail shape tier helpers (single source for the palette)

- [x] **Write the failing test.** Create `tests/rail-shapes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './harness.mjs';

const T = load(['RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE', 'fitShapeToLength']);

test('railTierOf boundaries', () => {
  assert.equal(T.railTierOf(2.49), 'short');
  assert.equal(T.railTierOf(2.5), 'mid');
  assert.equal(T.railTierOf(7.99), 'mid');
  assert.equal(T.railTierOf(8), 'long');
});

test('pickRailShape matches the legacy weighted roll', () => {
  assert.equal(T.pickRailShape(2, 0.49), 'ellipse');
  assert.equal(T.pickRailShape(2, 0.77), 'hook');
  assert.equal(T.pickRailShape(2, 0.99), 'flick');
  assert.equal(T.pickRailShape(5, 0.60), 'zigzag');
  assert.equal(T.pickRailShape(5, 0.95), 'ramp');
  assert.equal(T.pickRailShape(9, 0.50), 'spiral');
  assert.equal(T.pickRailShape(9, 0.95), 'staircase');
});

test('every picked shape belongs to its tier', () => {
  for (const len of [1, 3, 6, 9, 14])
    for (let r = 0; r < 1; r += 0.01)
      assert.ok(T.RAIL_SHAPE_TIERS[T.railTierOf(len)].includes(T.pickRailShape(len, r)));
});

test('fitShapeToLength downgrades gracefully and always lands in tier', () => {
  assert.equal(T.fitShapeToLength('spiral', 5), 'ellipse');
  assert.equal(T.fitShapeToLength('staircase', 5), 'switchback');
  assert.equal(T.fitShapeToLength('staircase', 2), 'hook');
  assert.equal(T.fitShapeToLength('wave', 2), 'flick');
  assert.equal(T.fitShapeToLength('hook', 10), 'ellipse');   // short-only shape in a long slot
  for (const tier of Object.values(T.RAIL_SHAPE_TIERS))
    for (const s of tier) for (const len of [1, 4, 10])
      assert.ok(T.RAIL_SHAPE_TIERS[T.railTierOf(len)].includes(T.fitShapeToLength(s, len)));
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: `declaration not found: RAIL_SHAPE_TIERS`.
- [x] **Implement.** In `synthriders-creator.html`, insert directly after the closing `}` of `function handZoneCols` (~line 1441):

```js

// ── Rail shape palette — length tiers ────────────────────────────────────────
// Single source for generateRailArc's roll AND for chorus-motif replay, which must fit a
// recorded shape into a slot of a different length. A rail's beat length sets its waypoint
// budget and therefore which shapes can read (see generateRailArc's palette comment).
const RAIL_SHAPE_TIERS = {
  short: ['ellipse', 'hook', 'flick'],
  mid:   ['ellipse', 'wave', 'zigzag', 'pendulum', 'switchback', 'ramp'],
  long:  ['ellipse', 'spiral', 'figure8', 'staircase'],
};
function railTierOf(len) { return len < 2.5 ? 'short' : len < 8.0 ? 'mid' : 'long'; }
// Weighted roll — thresholds identical to the pre-2026-11-21 inline roll, so single-shape
// rails keep their exact distribution (tests/rail-shapes pins seeded output vs acd1853).
function pickRailShape(len, roll) {
  if (len < 2.5) return roll < 0.50 ? 'ellipse' : roll < 0.78 ? 'hook' : 'flick';
  if (len < 8.0) return roll < 0.34 ? 'ellipse' : roll < 0.52 ? 'wave' : roll < 0.66 ? 'zigzag'
                      : roll < 0.78 ? 'pendulum' : roll < 0.90 ? 'switchback' : 'ramp';
  return roll < 0.34 ? 'ellipse' : roll < 0.58 ? 'spiral' : roll < 0.80 ? 'figure8' : 'staircase';
}
// One tier down, nearest in feel: long → mid analogue, mid → short analogue.
const RAIL_SHAPE_DOWNGRADE = {
  spiral: 'ellipse', figure8: 'pendulum', staircase: 'switchback',
  wave: 'flick', zigzag: 'flick', ramp: 'flick', pendulum: 'hook', switchback: 'hook',
};
function fitShapeToLength(shape, len) {
  const ok = RAIL_SHAPE_TIERS[railTierOf(len)];
  let s = shape;
  while (!ok.includes(s)) {
    s = RAIL_SHAPE_DOWNGRADE[s];
    if (!s) return 'ellipse';            // e.g. hook/flick in a long slot — ellipse is in every tier
  }
  return s;
}
```

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: all pass.
- [x] **Commit:** `git commit -am "Rail shapes: module-level tier helpers (pickRailShape, fitShapeToLength)"`

---

### Task 2: Extract `buildRailPath` + `railWaypointCount` from `generateRailArc` (pure refactor, golden-tested)

- [x] **Write the failing test.** Append to `tests/rail-shapes.test.mjs`:

```js
import { loadAt, withSeed, RAIL_DEPS, colOf } from './harness.mjs';

const RAIL_NEW = ['RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE',
  'fitShapeToLength', 'buildRailPath', 'railWaypointCount', 'generateRailArc'];
const OLD = loadAt('acd1853', [...RAIL_DEPS, 'generateRailArc']);
const NEW = load([...RAIL_DEPS, ...RAIL_NEW]);

// Same seed → identical rail. Lengths < 6 stay on the single-shape path forever (Task 4 keeps it).
const goldenCase = (k, maxLen) => {
  const len = 1 + (k * 0.37) % (maxLen - 1);
  const hand = k % 2, cross = k % 3 === 0;
  const start = hand === 0 ? 7 + (k % 6) : 1 + (k % 6);
  return [10, 1 + (k % 7), 10 + len, 4, 0.25, OLD.COL_X[start], hand, cross, 1.0, 120, null, null];
};
const strip = r => JSON.stringify({ w: r.waypoints, x: r.xEnd, r: r.rowEnd });

test('golden: single-shape rails identical to acd1853 (len < 6)', () => {
  for (let k = 0; k < 400; k++) {
    const args = goldenCase(k, 5.99);
    const a = withSeed(k + 1, () => OLD.generateRailArc(...args));
    const b = withSeed(k + 1, () => NEW.generateRailArc(...args));
    assert.equal(strip(b), strip(a), `case ${k}`);
  }
});

test('railWaypointCount: corners get exact counts, cap 12', () => {
  assert.equal(NEW.railWaypointCount('hook', 2, 0), 3);
  assert.equal(NEW.railWaypointCount('switchback', 5, 0), 4);
  assert.equal(NEW.railWaypointCount('staircase', 10, 4), 8);
  assert.equal(NEW.railWaypointCount('ellipse', 20, 0), 12);
});
```

  (Task 2 runs this golden test over all lengths up to 16 as well. Add this test now and delete it in Task 4, where multi-segment rails change long-rail output on purpose:)

```js
test('golden (Task 2 only): ALL lengths identical to acd1853', () => {
  for (let k = 0; k < 400; k++) {
    const args = goldenCase(k, 16);
    const a = withSeed(k + 1, () => OLD.generateRailArc(...args));
    const b = withSeed(k + 1, () => NEW.generateRailArc(...args));
    assert.equal(strip(b), strip(a), `case ${k}`);
  }
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: `declaration not found: buildRailPath`.
- [x] **Implement.** Insert these two module-level functions directly **above** `function generateRailArc(`:

```js
// Rail path for ONE shape: t in [0,1] -> { col, row } (unclamped), anchored at (startCol,
// rowStart) at t=0. `rng` is the caller's pre-drawn random (legacy order: rng, then shape
// roll, then any Math.random() calls inside the branch). Extracted from generateRailArc so
// multi-segment rails can draw several shapes back to back.
function buildRailPath(railShape, len, startCol, rowStart, colMin, colMax, swayBoost, rng) {
  const triS = u => { const ph = ((u % 1) + 1) % 1;
    return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4; };
  const zoneMid  = (colMin + colMax) / 2;
  const farSide  = startCol < zoneMid ? colMax - 1 : colMin + 1;
  const zoneHalf = (colMax - colMin) / 2;
  let stairSteps = 0;
  let posAt;
  if (railShape === 'ellipse') {
    let totalRotation;
    if      (len < 2.5)  totalRotation = Math.PI * (0.75 + rng * 0.75);
    else if (len < 5)    totalRotation = Math.PI * (1.00 + rng * 0.75);
    else if (len < 8)    totalRotation = Math.PI * (1.25 + rng * 0.75);
    else if (len < 12)   totalRotation = Math.PI * (1.75 + rng * 0.25);
    else                 totalRotation = Math.PI * (2.00 + rng * 0.50);
    if (Math.random() < 0.5) totalRotation = -totalRotation;
    const radiusCol = Math.min(zoneHalf * 0.55, Math.max(1, (1 + Math.floor(rng * 3)) * swayBoost));
    const radiusRow = Math.min(4, Math.max(1, (1 + Math.floor(Math.random() * 3)) * swayBoost));
    const startAngle = Math.random() * 2 * Math.PI;
    const centerCol = startCol - radiusCol * Math.cos(startAngle);
    const centerRow = Math.max(1 + radiusRow, Math.min(8 - radiusRow,
                        rowStart - radiusRow * Math.sin(startAngle)));
    posAt = t => {
      const a = startAngle + t * totalRotation;
      return { col: centerCol + radiusCol * Math.cos(a), row: centerRow + radiusRow * Math.sin(a) };
    };
  } else if (railShape === 'wave' || railShape === 'zigzag' || railShape === 'ramp') {
    const amp = Math.min(3, Math.max(1.5, 1.5 * swayBoost));
    if (railShape === 'wave') {
      const cyc = Math.max(1, Math.round(len / 4));
      posAt = t => ({ col: startCol + (farSide - startCol) * t,
                      row: rowStart + amp * Math.sin(t * cyc * 2 * Math.PI) });
    } else if (railShape === 'zigzag') {
      const zigs = Math.max(2, Math.round(len / 1.5));
      posAt = t => ({ col: startCol + (farSide - startCol) * t,
                      row: rowStart + amp * triS(t * zigs / 2) });
    } else {
      const zigs = Math.max(2, Math.round(len / 2));
      posAt = t => ({ col: startCol + (farSide - startCol) * t,
                      row: rowStart + (0.35 + 0.95 * t) * amp * triS(t * zigs / 2) });
    }
  } else if (railShape === 'pendulum') {
    const swing = Math.min(zoneHalf * 0.8, 2 + 2 * swayBoost);
    const cyc   = Math.max(1, Math.round(len / 5));
    posAt = t => {
      const s = Math.sin(t * cyc * 2 * Math.PI);
      return { col: startCol + swing * s, row: rowStart + 2 * Math.abs(s) };
    };
  } else if (railShape === 'hook') {
    const dir   = startCol < zoneMid ? 1 : -1;
    const reach = Math.max(2, Math.min(4, zoneHalf * 0.7));
    const midCol = startCol + dir * reach, endCol = midCol - dir * reach * 0.4;
    const midRow = rowStart - 2.2,         endRow = rowStart + 2.4;
    posAt = t => t < 0.5
      ? { col: startCol + (midCol - startCol) * (t / 0.5), row: rowStart + (midRow - rowStart) * (t / 0.5) }
      : { col: midCol + (endCol - midCol) * ((t - 0.5) / 0.5), row: midRow + (endRow - midRow) * ((t - 0.5) / 0.5) };
  } else if (railShape === 'flick') {
    const dir   = startCol < zoneMid ? 1 : -1;
    const reach = Math.max(2, Math.min(4, zoneHalf * 0.7));
    const peakCol = startCol + dir * reach;
    posAt = t => t < 0.65
      ? { col: startCol + (peakCol - startCol) * (t / 0.65), row: rowStart - 1.2 * (t / 0.65) }
      : { col: peakCol - dir * reach * 0.28 * ((t - 0.65) / 0.35), row: rowStart - 1.2 + 3.0 * ((t - 0.65) / 0.35) };
  } else if (railShape === 'switchback') {
    const amp   = Math.min(3.2, Math.max(1.8, 1.8 * swayBoost));
    const knots = [[0, 0], [0.34, 1], [0.67, -1], [1, 0.35]];
    posAt = t => {
      let s = 0;
      while (s < knots.length - 2 && t > knots[s + 1][0]) s++;
      const [t0, v0] = knots[s], [t1, v1] = knots[s + 1];
      const u = (t - t0) / (t1 - t0 || 1);
      return { col: startCol + (farSide - startCol) * t, row: rowStart + amp * (v0 + (v1 - v0) * u) };
    };
  } else if (railShape === 'spiral') {
    const rot = Math.PI * 2 * (2 + rng * 1.5) * (Math.random() < 0.5 ? -1 : 1);
    const rc0 = Math.min(zoneHalf * 0.75, Math.max(1.5, 2.5 * swayBoost));
    const rr0 = Math.min(3.4, Math.max(1.5, 2.4 * swayBoost));
    const a0  = Math.random() * 2 * Math.PI;
    const cCol = startCol - rc0 * Math.cos(a0);
    const cRow = Math.max(1 + rr0, Math.min(8 - rr0, rowStart - rr0 * Math.sin(a0)));
    posAt = t => {
      const a = a0 + t * rot, k = 1 - 0.75 * t;
      return { col: cCol + rc0 * k * Math.cos(a), row: cRow + rr0 * k * Math.sin(a) };
    };
  } else if (railShape === 'figure8') {
    const w8 = Math.min(zoneHalf * 0.8, Math.max(2, 3 * swayBoost));
    const h8 = Math.min(3.2, Math.max(1.5, 2.2 * swayBoost));
    posAt = t => {
      const u = t * 2 * Math.PI;
      return { col: startCol + w8 * Math.sin(2 * u), row: rowStart + h8 * Math.sin(u) };
    };
  } else {
    stairSteps = Math.max(3, Math.min(6, Math.round(len / 2.5)));
    const rowDir = rowStart > 4 ? -1 : 1;
    const colAt = j => startCol + (farSide - startCol) * (j / stairSteps);
    const rowAt = j => rowStart + rowDir * Math.min(3, j * 0.9);
    posAt = t => {
      const k = Math.min(stairSteps - 1e-6, t * stairSteps);
      const i = Math.floor(k), f = k - i;
      return f < 0.5
        ? { col: colAt(i) + (colAt(i + 1) - colAt(i)) * (f / 0.5), row: rowAt(i) }
        : { col: colAt(i + 1), row: rowAt(i) + (rowAt(i + 1) - rowAt(i)) * ((f - 0.5) / 0.5) };
    };
  }
  return { posAt, stairSteps };
}

// Waypoints for one shape: corners need a node ON each corner; cap 12 (render limit).
function railWaypointCount(railShape, len, stairSteps) {
  return Math.min(12, Math.max(2,
      railShape === 'zigzag'     ? Math.max(Math.round(len / 1.5) * 2, Math.round(len))
    : railShape === 'staircase'  ? stairSteps * 2
    : railShape === 'hook'       ? 3
    : railShape === 'flick'      ? 3
    : railShape === 'switchback' ? 4
    : len < 3                    ? Math.round(len * 3)
                                 : Math.round(len * 1.2)
  ));
}
```

  Then, inside `generateRailArc`, **replace** everything from `const rng = Math.random();` down to and including the closing `));` of the `const numWP = Math.min(12, …` expression with the block below. Keep the long palette comment above `const rng` as it is.

```js
  const rng = Math.random();
  const _shapeRoll = Math.random();
  const railShape = pickRailShape(len, _shapeRoll);
  const { posAt, stairSteps } = buildRailPath(railShape, len, startCol, rowStart, colMin, colMax, swayBoost, rng);
  const numWP = railWaypointCount(railShape, len, stairSteps);
```

  Leave `clampPt`, the waypoint loop and the `return` exactly as they are.

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: both golden tests pass, all 400 cases.
- [x] **Commit:** `git commit -am "generateRailArc: extract buildRailPath/railWaypointCount (golden-identical to acd1853)"`

---

### Task 3: Segment planning — `planRailSegments`, `assignSegmentShapes`, `fitRailPlan`

- [x] **Write the failing test.** Append to `tests/rail-shapes.test.mjs`:

```js
const P = load(['RAIL_SHAPE_TIERS', 'railTierOf', 'pickRailShape', 'RAIL_SHAPE_DOWNGRADE',
  'fitShapeToLength', 'RAIL_SEG_MIN_BEATS', 'RAIL_MULTISEG_MIN_BEATS',
  'assignSegmentShapes', 'planRailSegments', 'fitRailPlan']);
const sum = a => a.reduce((x, y) => x + y, 0);

test('planRailSegments: null below 6 beats, 2 segs for 6-12, 3 for 12+', () => {
  assert.equal(P.planRailSegments(5.9), null);
  for (let k = 0; k < 300; k++) {
    const len = 6 + (k * 0.11) % 12;
    const plan = withSeed(k + 7, () => P.planRailSegments(len));
    assert.equal(plan.length, len >= 12 ? 3 : 2);
    assert.ok(Math.abs(sum(plan.map(s => s.frac)) - 1) < 1e-9);
    for (let i = 0; i < plan.length; i++) {
      assert.ok(plan[i].frac * len >= 2.5 - 1e-9, `seg ${i} too short`);
      assert.ok(P.RAIL_SHAPE_TIERS[P.railTierOf(plan[i].frac * len)].includes(plan[i].shape));
      if (i) assert.notEqual(plan[i].shape, plan[i - 1].shape, 'adjacent shapes must differ');
    }
  }
});

test('fitRailPlan: replays shapes + proportions, downgrades, keeps invariants', () => {
  const rec = [{ frac: 0.25, shape: 'spiral' }, { frac: 0.5, shape: 'staircase' }, { frac: 0.25, shape: 'wave' }];
  const p = withSeed(3, () => P.fitRailPlan(rec, 14));
  assert.equal(p.length, 3);
  assert.ok(p[1].frac > p[0].frac);                          // proportions survive
  assert.ok(Math.abs(sum(p.map(s => s.frac)) - 1) < 1e-9);
  for (const s of p) assert.ok(s.frac * 14 >= 2.5 - 1e-9);
  const p2 = withSeed(3, () => P.fitRailPlan(rec, 8));       // 3 recorded → 2 slots
  assert.equal(p2.length, 2);
  const p3 = P.fitRailPlan(rec, 4);                          // short rail → single fitted shape
  assert.deepEqual(p3, [{ frac: 1, shape: 'ellipse' }]);     // spiral downgrades to ellipse at 4 beats
  assert.equal(P.fitRailPlan(null, 10), null);
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: `declaration not found: RAIL_SEG_MIN_BEATS`.
- [x] **Implement.** Insert directly after `function fitShapeToLength` (from Task 1):

```js

// ── Multi-segment rail plans ─────────────────────────────────────────────────
// A plan is [{ frac, shape }] (fracs sum to 1). Rails >= 6 beats chain 2 (6-12) or 3 (12+)
// shapes; every segment is >= 2.5 beats so it reaches the mid tier; adjacent shapes differ.
const RAIL_SEG_MIN_BEATS = 2.5;
const RAIL_MULTISEG_MIN_BEATS = 6;
function assignSegmentShapes(plan, len, rnd = Math.random) {
  for (let k = 0; k < plan.length; k++) {
    const segLen = plan[k].frac * len;
    const prev = k > 0 ? plan[k - 1].shape : null;
    let s = plan[k].shape ? fitShapeToLength(plan[k].shape, segLen) : pickRailShape(segLen, rnd());
    for (let tries = 0; s === prev && tries < 6; tries++) s = pickRailShape(segLen, rnd());
    if (s === prev) s = RAIL_SHAPE_TIERS[railTierOf(segLen)].find(x => x !== prev);
    plan[k] = { frac: plan[k].frac, shape: s };
  }
  return plan;
}
// Affine map w -> minF + spare*w keeps every segment >= minF AND the sum exactly 1.
function planRailSegments(len, rnd = Math.random) {
  if (len < RAIL_MULTISEG_MIN_BEATS) return null;           // single-shape rail (legacy path)
  const n = len >= 12 ? 3 : 2;
  const minF = RAIL_SEG_MIN_BEATS / len, spare = 1 - n * minF;
  const w = Array.from({ length: n }, () => 0.5 + rnd());
  const wSum = w.reduce((a, b) => a + b, 0);
  return assignSegmentShapes(w.map(x => ({ frac: minF + spare * x / wSum, shape: null })), len, rnd);
}
// Chorus-motif replay: a recorded plan's shapes + proportions on a rail of a new length.
function fitRailPlan(recorded, len, rnd = Math.random) {
  if (!recorded || !recorded.length) return null;
  if (len < RAIL_MULTISEG_MIN_BEATS || recorded.length === 1)
    return [{ frac: 1, shape: fitShapeToLength(recorded[0].shape, len) }];
  const n = Math.min(recorded.length, len >= 12 ? 3 : 2);
  const raw = recorded.slice(0, n).map(s => s.frac);
  const rSum = raw.reduce((a, b) => a + b, 0);
  const minF = RAIL_SEG_MIN_BEATS / len, spare = 1 - n * minF;
  return assignSegmentShapes(
    raw.map((f, k) => ({ frac: minF + spare * f / rSum, shape: recorded[k].shape })), len, rnd);
}
```

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Commit:** `git commit -am "Rails: segment planning + motif plan fitting"`

---

### Task 4: Multi-segment `generateRailArc`

- [x] **Edit the tests.** Delete the `golden (Task 2 only): ALL lengths …` test. Add `'RAIL_SEG_MIN_BEATS', 'RAIL_MULTISEG_MIN_BEATS', 'assignSegmentShapes', 'planRailSegments', 'fitRailPlan'` to the `RAIL_NEW` array (before `'generateRailArc'`). Then append:

```js
const randRail = (k, cross) => {
  const hand = k % 2, len = 1 + ((k * 0.613) % 15);
  const start = hand === 0 ? 7 + (k % 7) : (k % 8);
  return { hand, len, args: [0, 1 + (k % 8), len, 4, 0.25, NEW.COL_X[start], hand, cross, 1.0, 120, null, null] };
};

test('multi-seg: zone, rows, waypoint cap, plan shape over 20k rails', () => {
  for (let k = 0; k < 20000; k++) {
    const cross = k % 3 === 0;
    const { hand, len, args } = randRail(k, cross);
    const r = withSeed(k + 11, () => NEW.generateRailArc(...args));
    const z = NEW.handZoneCols(hand, cross);
    for (const p of [...r.waypoints.map(w => ({ c: colOf(w._x), row: w.row })), { c: colOf(r.xEnd), row: r.rowEnd }]) {
      assert.ok(p.c >= z.colMin && p.c <= z.colMax, `zone k=${k}`);
      assert.ok(p.row >= 1 && p.row <= 8, `row k=${k}`);
    }
    assert.ok(r.waypoints.length <= 12);
    assert.equal(r.plan.length, len >= 12 ? 3 : len >= 6 ? 2 : 1);
  }
});

// Only SEAM steps are checked: inside one shape, consecutive waypoints of an ellipse/zigzag
// may legitimately be far apart (the rail is continuous; C3 never applies within a rail).
test('multi-seg: each segment seeds from the previous clamped endpoint; seam step within C3 caps', () => {
  for (let k = 0; k < 3000; k++) {
    const { args } = randRail(k, k % 2 === 0);
    if (args[2] < 6) continue;
    const r = withSeed(k + 5, () => NEW.generateRailArc(...args));
    const pts = [...r.waypoints.map(w => [colOf(w._x), w.row]), [colOf(r.xEnd), r.rowEnd]];
    let idx = 0;
    for (let i = 0; i < r.segments.length; i++) {
      if (i > 0) {
        assert.equal(r.segments[i].startCol, r.segments[i - 1].endCol);
        assert.equal(r.segments[i].startRow, r.segments[i - 1].endRow);
        const seam = pts[idx - 1], next = pts[idx];               // seam point → first point of segment i
        assert.ok(Math.abs(next[0] - seam[0]) <= 7, `seam col step k=${k}`);
        assert.ok(Math.abs(next[1] - seam[1]) <= 5, `seam row step k=${k}`);
      }
      idx += r.segments[i].count;
    }
  }
});

test('motifPlan replay: recorded shapes come back on a different length', () => {
  const rec = [{ frac: 0.6, shape: 'wave' }, { frac: 0.4, shape: 'pendulum' }];
  const r = withSeed(9, () => NEW.generateRailArc(0, 4, 9, 4, 0.25, NEW.COL_X[10], 0, false, 1, 120, null, null, rec));
  assert.deepEqual(r.plan.map(s => s.shape), ['wave', 'pendulum']);
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: failures on `r.plan` undefined.
- [x] **Implement.** Change the signature to add a 13th parameter:

```js
function generateRailArc(startBeat, rowStart, endBeat, rowEnd, snapSz, xStart = 0, hand = 0, allowCrossCenter = false, swayBoost = 1.0, bpm = 120, obstacleConstraints = null, walls = null, motifPlan = null) {
```

  Move the existing `const clampPt = (col, row, beat) => { … };` block so it sits **immediately after** `const startCol = colIdxOf(xStart);`. It makes no random calls, so moving it is safe. Then replace everything from `const rng = Math.random();` to the end of the function with:

```js
  const rng = Math.random();
  const _shapeRoll = Math.random();
  // Multi-segment plan for rails >= 6 beats (or a replayed chorus motif). Below 6 beats with
  // no motif this is null and the legacy single-shape path runs with an identical RNG
  // sequence (golden test vs acd1853).
  const plan = motifPlan ? fitRailPlan(motifPlan, len) : planRailSegments(len);

  if (!plan || plan.length === 1) {
    const railShape = plan ? plan[0].shape : pickRailShape(len, _shapeRoll);
    const { posAt, stairSteps } = buildRailPath(railShape, len, startCol, rowStart, colMin, colMax, swayBoost, rng);
    const numWP = railWaypointCount(railShape, len, stairSteps);
    const waypoints = [];
    for (let i = 1; i <= numWP; i++) {
      const t    = i / (numWP + 1);
      const p    = posAt(t);
      const beat = Math.round((startBeat + len * t) / snapSz) * snapSz;
      const wp   = clampPt(p.col, p.row, beat);
      waypoints.push({ beat, row: wp.row, _x: COL_X[wp.col] });
    }
    const pEnd = posAt(1);
    const end  = clampPt(pEnd.col, pEnd.row, endBeat);
    return { waypoints, xEnd: COL_X[end.col], rowEnd: end.row,
             plan: [{ frac: 1, shape: railShape }],
             segments: [{ shape: railShape, startCol, startRow: rowStart, endCol: end.col, endRow: end.row, count: numWP + 1 }] };
  }

  // Multi-segment: share the 12-waypoint render cap in proportion to segment length, >= 3 per
  // segment so corner shapes keep a node on their corner. Each segment's LAST waypoint lands
  // exactly on its end (t=1) and the next segment seeds from that CLAMPED point — seeding
  // from the unclamped posAt(1) would leave a gap at the seam whenever a wall clamped it.
  const nSeg   = plan.length;
  const budget = Math.min(12, Math.max(3 * nSeg, Math.round(len * 1.2)));
  const counts = plan.map(s => Math.max(3, Math.round(budget * s.frac)));
  while (counts.reduce((a, b) => a + b, 0) > 12) counts[counts.indexOf(Math.max(...counts))]--;
  const waypoints = [], segments = [];
  let segStart = startBeat, curCol = startCol, curRow = rowStart;
  for (let k = 0; k < nSeg; k++) {
    const segLen = len * plan[k].frac;
    const { posAt } = buildRailPath(plan[k].shape, segLen, curCol, curRow, colMin, colMax, swayBoost, Math.random());
    let last = null;
    for (let i = 1; i <= counts[k]; i++) {
      const t    = i / counts[k];
      const p    = posAt(t);
      const beat = k === nSeg - 1 && i === counts[k] ? endBeat
                 : Math.round((segStart + segLen * t) / snapSz) * snapSz;
      last = clampPt(p.col, p.row, beat);
      waypoints.push({ beat, row: last.row, _x: COL_X[last.col] });
    }
    segments.push({ shape: plan[k].shape, startCol: curCol, startRow: curRow, endCol: last.col, endRow: last.row, count: counts[k] });
    curCol = last.col; curRow = last.row;
    segStart += segLen;
  }
  const endWp = waypoints.pop();             // the final point IS the rail end, not a waypoint
  return { waypoints, xEnd: endWp._x, rowEnd: endWp.row, plan, segments };
}
```

  Also update the palette comment above `const rng` with one line: `// Rails >= 6 beats chain 2-3 of these shapes (planRailSegments); see the multi-segment block below.`

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). If the seam-step test fails, print the failing `r.plan` / `r.segments` and check whether a `buildRailPath` branch can move more than 7 cols in the first `1/counts[k]` of its length. If one can, raise that segment's waypoint count rather than loosening the assertion.
- **Executed 2026-11-21 — deviation:** the seam test caught a real bug. The ellipse/spiral clamp their centre row, so a
  segment seeded near row 8 began its loop ~6 rows away. Each segment's path is now anchored with a fading offset
  `posAt(t) = rawAt(t) + (seed - rawAt(0)) * (1 - t)` (see the code comment in the multi-segment loop).
- [x] **Commit:** `git commit -am "Rails: multi-segment generateRailArc (2-3 shapes seeded from clamped seams, motifPlan replay)"`

---

### Task 5: Chorus motif memory helpers

- [x] **Write the failing test.** Create `tests/motif.test.mjs`:

```js
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
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). Expected: `declaration not found: CHORUS_RE`.
- [x] **Implement.** Insert after `function fitRailPlan` (Task 3):

```js

// ── Chorus motif memory (per Generate call — created inside onsetsToNotes) ──────────────
// The first occurrence of a chorus-like section records its choreography choices (rail
// plans, sweep move indices, gold shapes); later occurrences with the same root replay them
// in order, so repeated music gets recognisably repeated choreography. CHORUS_RE is shared
// with the "Progressive chorus variation" pass.
const CHORUS_RE = /chorus|drop|climax|hook|refrain/i;
function chorusRootKey(name) {
  const s = String(name || '').toLowerCase();
  if (!CHORUS_RE.test(s) || /pre/.test(s)) return null;
  return s.replace(/\(.*?\)/g, '').replace(/\bx\d+\b/g, '').replace(/[\s_-]*\d+\s*$/, '').trim();
}
function createMotifMemory(sections) {
  const owner = new Map();                                     // root -> first section (by startBeat)
  for (const s of [...(sections || [])].sort((a, b) => a.startBeat - b.startBeat)) {
    const k = chorusRootKey(s.name);
    if (k && !owner.has(k)) owner.set(k, s);
  }
  const store = new Map();                                     // root -> { kind: [values] }
  const cursor = new Map();                                    // section -> { kind: index }
  let recorded = 0, replayed = 0;
  return {
    replay(sec, kind) {
      const k = chorusRootKey(sec?.name);
      if (!k || owner.get(k) === sec) return null;
      const list = store.get(k)?.[kind];
      if (!list || !list.length) return null;
      if (!cursor.has(sec)) cursor.set(sec, {});
      const c = cursor.get(sec);
      c[kind] = (c[kind] ?? -1) + 1;
      replayed++;
      return list[c[kind] % list.length];
    },
    record(sec, kind, value) {
      const k = chorusRootKey(sec?.name);
      if (!k || owner.get(k) !== sec || value == null) return;
      if (!store.has(k)) store.set(k, {});
      (store.get(k)[kind] ??= []).push(value);
      recorded++;
    },
    stats() { return { roots: owner.size, recorded, replayed }; },
  };
}
```

  Then in `onsetsToNotes`'s "Progressive chorus variation" pass, replace
  `/chorus|drop|climax|hook|refrain/i.test(s.name || '') && !/pre/i.test(s.name || '')` with
  `CHORUS_RE.test(s.name || '') && !/pre/i.test(s.name || '')`.

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). The test's `roots: 1` holds because only `chorus1`/`chorus2` share a root in that fixture.
- [x] **Commit:** `git commit -am "Motif memory: chorusRootKey + createMotifMemory; shared CHORUS_RE"`

---

### Task 6: Hoist the move library (`DANCE_MOVES`) + `isPattern` + `smoothPatternBoundaries`

- [x] **Write the failing test.** Create `tests/sweeps.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, colOf } from './harness.mjs';

const S = load(['COL_X', 'CROSS_REACH_COLS', 'handZoneCols', 'buildDanceMoves', 'DANCE_MOVES',
  'isPattern', 'smoothPatternBoundaries']);

test('DANCE_MOVES: the 14 named moves, in-range steps, non-cross moves stay home', () => {
  assert.deepEqual(S.DANCE_MOVES.map(m => m.name), ['parallelSpiral', 'mirrorSpiral', 'scissors',
    'doublePunch', 'altJabs', 'parallelStairs', 'accordion', 'mirrorWings', 'crossReturn',
    'dnaHelix', 'pendulum', 'outwardBloom', 'boxStep', 'heartbeat']);
  for (const m of S.DANCE_MOVES) for (const st of m.steps) {
    if (st.l) { assert.ok(st.l[1] >= 1 && st.l[1] <= 9); if (!m.cross) assert.ok(st.l[0] <= 7); }
    if (st.r) { assert.ok(st.r[1] >= 1 && st.r[1] <= 9); if (!m.cross) assert.ok(st.r[0] >= 7); }
  }
});

test('isPattern covers dense + sparse only', () => {
  assert.equal(S.isPattern({ _denseSweep: true }), true);
  assert.equal(S.isPattern({ _sparseSweep: true }), true);
  assert.equal(S.isPattern({ _goldSweep: true }), false);
  assert.equal(S.isPattern(null), false);
});

test('smoothPatternBoundaries nudges only the loose side, to exactly the C3 limit', () => {
  const anchor = { type: 1, beat: 10, _x: S.COL_X[0], row: 5, _sparseSweep: true };
  const loose  = { type: 1, beat: 10.5, _x: S.COL_X[7], row: 5 };                 // 7 cols: ok
  const far    = { type: 1, beat: 11, _x: S.COL_X[0], row: 0, _denseSweep: true };
  const loose2 = { type: 1, beat: 11.5, _x: S.COL_X[7], row: 9 };                 // 9 rows: too far
  const n = S.smoothPatternBoundaries([anchor, loose, far, loose2]);
  assert.equal(n, 1);
  assert.equal(colOf(loose._x), 7);
  assert.equal(loose2.row, 5);
  assert.equal(colOf(anchor._x), 0);
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Implement (module level).** Insert after `function createMotifMemory` (Task 5). The `addMove` lines are moved verbatim from `[DenseSweep]`:

```js

// ── Two-hand move library — shared by [DenseSweep] and [SparseSweep] ─────────────────────
// Each move is a fixed sequence of { l:[col,row]|null, r:[col,row]|null } steps (col 0-14,
// row 1-9). `cross` lets a move reach across the centre line. Previewed in move_playbook.html.
function buildDanceMoves() {
  const cc = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
  const MOVES = [];
  const addMove = (name, cross, steps) => MOVES.push({ name, cross, steps });
  { let s = []; const N = 8, Lc = 3.5, Rc = 10.5, cy = 5, rc = 2.6, rr = 3; for (let k = 0; k < N; k++) { const a = k / N * 2 * Math.PI, dx = Math.cos(a), dy = Math.sin(a); s.push({ l: [cc(Lc + rc * dx, 0, 7), cc(cy - rr * dy, 1, 9)], r: [cc(Rc + rc * dx, 7, 14), cc(cy - rr * dy, 1, 9)] }); } addMove('parallelSpiral', false, s); }
  { let s = []; const N = 8, Lc = 3.5, Rc = 10.5, cy = 5, rc = 2.8, rr = 3; for (let k = 0; k < N; k++) { const a = k / N * 2 * Math.PI; s.push({ l: [cc(Lc - rc * Math.cos(a), 0, 7), cc(cy - rr * Math.sin(a), 1, 9)], r: [cc(Rc + rc * Math.cos(a), 7, 14), cc(cy - rr * Math.sin(a), 1, 9)] }); } addMove('mirrorSpiral', false, s); }
  { const Lr = [9, 7, 5, 3, 1, 3, 5, 7], Rr = [1, 3, 5, 7, 9, 7, 5, 3]; addMove('scissors', false, Lr.map((v, k) => ({ l: [4, v], r: [10, Rr[k]] }))); }
  { const a = [5, 1, 5, 1, 5, 1], b = [9, 13, 9, 13, 9, 13], rw = [5, 5, 3, 3, 7, 7]; addMove('doublePunch', false, a.map((v, k) => ({ l: [v, rw[k]], r: [b[k], rw[k]] }))); }
  { addMove('altJabs', false, [{ l: [2, 5], r: null }, { l: null, r: [12, 5] }, { l: [3, 4], r: null }, { l: null, r: [11, 4] }, { l: [1, 6], r: null }, { l: null, r: [13, 6] }]); }
  { let s = []; for (let k = 0; k < 6; k++) s.push({ l: [1 + k, 9 - k], r: [8 + k, 9 - k] }); addMove('parallelStairs', false, s); }
  { const a = [1, 3, 5, 6, 5, 3, 1], b = [13, 11, 9, 8, 9, 11, 13]; addMove('accordion', false, a.map((v, k) => ({ l: [v, 5], r: [b[k], 5] }))); }
  { let s = []; const N = 8; for (let k = 0; k < N; k++) { const t = k / (N - 1), row = cc(5 - 3 * Math.sin(t * 2 * Math.PI), 1, 9); s.push({ l: [cc(1 + 5 * t, 0, 7), row], r: [cc(13 - 5 * t, 7, 14), row] }); } addMove('mirrorWings', false, s); }
  { const a = [3, 5, 7, 9, 7, 5, 3], b = [11, 9, 7, 5, 7, 9, 11]; addMove('crossReturn', true, a.map((v, k) => ({ l: [v, 4], r: [b[k], 6] }))); }
  { let s = []; const N = 8; for (let k = 0; k < N; k++) { const a = k / (N - 1) * 2 * Math.PI, t = k / (N - 1); s.push({ l: [cc(2 + 4 * t, 0, 7), cc(5 - 3 * Math.sin(a), 1, 9)], r: [cc(8 + 4 * t, 7, 14), cc(5 - 3 * Math.sin(a + Math.PI), 1, 9)] }); } addMove('dnaHelix', false, s); }
  { let s = []; const N = 8; for (let k = 0; k < N; k++) { const p = Math.sin(k / (N - 1) * 2 * Math.PI), sh = Math.round(3 * p), row = cc(4 + 1.8 * Math.abs(p), 1, 9); s.push({ l: [cc(4 + sh, 0, 7), row], r: [cc(10 + sh, 7, 14), row] }); } addMove('pendulum', false, s); }
  { addMove('outwardBloom', false, [{ l: [6, 5], r: [8, 5] }, { l: [3, 3], r: [11, 3] }, { l: [1, 1], r: [13, 1] }, { l: [3, 3], r: [11, 3] }, { l: [6, 5], r: [8, 5] }, { l: [3, 7], r: [11, 7] }, { l: [1, 9], r: [13, 9] }, { l: [3, 7], r: [11, 7] }]); }
  { const Ls = [[2, 3], [5, 3], [5, 6], [2, 6]], Rs = [[9, 3], [12, 3], [12, 6], [9, 6]]; let s = []; for (let k = 0; k < 8; k++) { const ix = k % 4; s.push({ l: Ls[ix], r: Rs[ix] }); } addMove('boxStep', false, s); }
  { const rw = [8, 2, 8, 2, 7, 3]; addMove('heartbeat', false, rw.map(v => ({ l: [4, v], r: [10, v] }))); }
  return MOVES;
}
const DANCE_MOVES = buildDanceMoves();

// Notes whose position is owned by a two-hand choreography move. Obstacle occlusion clamps
// them instead of re-scattering (_toBand), C3 prefers to move loose notes over them, and
// boundary smoothing treats them as anchors. GoldSweep is NOT included: it is gold-only and
// has its own handling everywhere it matters.
function isPattern(n) { return !!(n && (n._denseSweep || n._sparseSweep)); }

// Pattern-edge smoothing. Where exactly one of a consecutive same-hand pair is
// pattern-tagged and the jump exceeds C3 (>7 cols or >5 rows), nudge the LOOSE note to
// exactly the limit — minimal displacement, choreography untouched. `orbs` = beat-sorted
// free orbs. Returns the number of notes nudged.
function smoothPatternBoundaries(orbs) {
  const xCol = x => Math.round((parseFloat(x ?? 0) + 0.9555) / 0.1365);
  let clamped = 0;
  for (let h = 0; h <= 1; h++) {
    const hn = orbs.filter(n => n.type === h);
    for (let k = 1; k < hn.length; k++) {
      const a = hn[k - 1], b = hn[k];
      if (isPattern(a) === isPattern(b)) continue;
      const loose = isPattern(a) ? b : a, anchor = isPattern(a) ? a : b;
      const dC = xCol(loose._x) - xCol(anchor._x), dR = (loose.row || 0) - (anchor.row || 0);
      if (Math.abs(dC) <= 7 && Math.abs(dR) <= 5) continue;
      let nc = xCol(anchor._x) + Math.max(-7, Math.min(7, dC));
      const nr = (anchor.row || 0) + Math.max(-5, Math.min(5, dR));
      nc = h === 0 ? Math.max(7, Math.min(14, nc)) : Math.max(0, Math.min(7, nc));
      loose._x = COL_X[nc];
      loose.row = Math.max(0, Math.min(10, nr));
      clamped++;
    }
  }
  return clamped;
}
```

  **In `[DenseSweep]` (inside `onsetsToNotes`):**
  1. Delete the `const cc = …` line, the `const MOVES = []; const addMove = …` lines and all 14 `{ … addMove(…) }` lines. Put `const MOVES = DANCE_MOVES;` in their place.
  2. In the region loop, replace these three lines
     ```js
          o._x = COL_X[col];
          o.row = rowv;
          o._denseSweep = true;
     ```
     with these four. The snapshot has to be taken **before** the position is overwritten:
     ```js
          o._preSweep = o._preSweep || { x: o._x, row: o.row };   // demotion snapshot ([PatternCoverage])
          o._x = COL_X[col];
          o.row = rowv;
          o._denseSweep = true;
     ```
  3. Replace the whole `// ── [DenseSweep] boundary smoothing ──` block (its `{ … }`) with:
     ```js
    {
      const _dswClamped = smoothPatternBoundaries(orbs);
      if (_dswClamped) console.log(`[DenseSweep] Boundary-clamped ${_dswClamped} loose neighbour(s) at region edges`);
    }
     ```

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Commit:** `git commit -am "Sweeps: hoist DANCE_MOVES, isPattern, shared smoothPatternBoundaries"`

---

### Task 7: Make the pattern-aware sites use `isPattern` (occlusion, C3, critic tags, Crossover)

- [x] **Write the failing test.** Append to `tests/sweeps.test.mjs`. It's a source-level guard that no `_denseSweep`-only pattern checks are left:

```js
import { appSource } from './harness.mjs';
test('pattern checks go through isPattern (no stray _denseSweep-only gates)', () => {
  const src = appSource();
  for (const bad of ['n._denseSweep ? Math.max(lo', 'n._denseSweep ? 4 :',
    "!b._denseSweep && _movable(b, h)", "!a._denseSweep && _movable(a, h)",
    '(a._denseSweep || a._goldSweep) && (b._denseSweep || b._goldSweep)'])
    assert.ok(!src.includes(bad), `still present: ${bad}`);
  assert.ok(src.includes("n._sparseSweep ? { pattern: 'sparse' }"));
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Implement** (exact replacements in `synthriders-creator.html`; in this table `\|` is markdown escaping, so type a plain `|`):

| Find | Replace with |
|---|---|
| `n._x = COL_X[n._denseSweep ? Math.max(lo, Math.min(hi, col))` | `n._x = COL_X[isPattern(n) ? Math.max(lo, Math.min(hi, col))` |
| `n.row = n._denseSweep ? 4 : 4 + Math.floor` | `n.row = isPattern(n) ? 4 : 4 + Math.floor` |
| `!n._comp && !n._denseSweep && !n._goldSweep &&` (in `_movableLastResort`) | `!n._comp && !isPattern(n) && !n._goldSweep &&` |
| `if      (!b._denseSweep && _movable(b, h)) mv = b;` | `if      (!isPattern(b) && _movable(b, h)) mv = b;` |
| `else if (!a._denseSweep && _movable(a, h)) mv = a;` | `else if (!isPattern(a) && _movable(a, h)) mv = a;` |
| `if ((a._denseSweep \|\| a._goldSweep) && (b._denseSweep \|\| b._goldSweep)) continue;` | `if ((isPattern(a) \|\| a._goldSweep) && (isPattern(b) \|\| b._goldSweep)) continue;` |
| `...(n._denseSweep ? { pattern: 'dense' } : n._goldSweep ? { pattern: 'gold' } : {}),` | `...(n._denseSweep ? { pattern: 'dense' } : n._sparseSweep ? { pattern: 'sparse' } : n._goldSweep ? { pattern: 'gold' } : {}),` |
| `n._denseSweep && 'dsw', n._goldSweep && 'gsw',` (`[C3Detail]` tags) | `n._denseSweep && 'dsw', n._sparseSweep && 'ssw', n._goldSweep && 'gsw',` |
| In `[Crossover]`: `.filter(n => n.type === hand && n.railEndBeat == null && !n._comp && !n._gapFill && !n._underSquatRail)` | `.filter(n => n.type === hand && n.railEndBeat == null && !n._comp && !n._gapFill && !n._underSquatRail && !n._sparseSweep)` |

  Also update the `_toBand` comment's first sentence to say "Pattern notes (`isPattern`: DenseSweep/SparseSweep)…".

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Commit:** `git commit -am "Pattern-aware sites use isPattern (occlusion, C3 clamp, critic tags, Crossover)"`

---

### Task 8: `applySparseSweep`

- [x] **Write the failing test.** Append to `tests/sweeps.test.mjs`:

```js
const W = load(['COL_X', 'CROSS_REACH_COLS', 'handZoneCols', 'buildDanceMoves', 'DANCE_MOVES',
  'isPattern', 'smoothPatternBoundaries', 'SSW_MAXGAP', 'SSW_MINRUN', 'SSW_MINSPAN', 'applySparseSweep']);

const orb = (beat, type, col = type === 0 ? 10 : 4, row = 5, extra = {}) =>
  ({ beat, type, _x: W.COL_X[col], row, ...extra });

test('sparse run (1-beat alternating) is choreographed; others untouched', () => {
  const run = Array.from({ length: 12 }, (_, i) => orb(20 + i, i % 2));
  const dense = [orb(40, 0, 10, 5, { _denseSweep: true }), orb(40.25, 1, 4, 5, { _denseSweep: true })];
  const rail = orb(50, 0, 11, 5, { railEndBeat: 54 });
  const gold = { beat: 60, type: 3, _x: 0, row: 5 };
  const sparseGap = [orb(70, 0), orb(72, 0), orb(74, 0), orb(76, 0), orb(78, 0)];   // 2-beat gaps: no run
  const all = [...run, ...dense, rail, gold, ...sparseGap];
  const res = W.applySparseSweep(all, {});
  assert.equal(res.runs, 1);
  assert.equal(res.tagged, 12);
  for (const n of run) {
    assert.ok(n._sparseSweep && n._preSweep);
    assert.ok(n.row >= 2 && n.row <= 8);
    const z = W.handZoneCols(n.type, true);
    assert.ok(colOf(n._x) >= z.colMin && colOf(n._x) <= z.colMax);
  }
  for (const n of [...dense, rail, gold, ...sparseGap]) assert.ok(!n._sparseSweep);
});

test('per-hand step cap scales with the gap (max 5)', () => {
  const run = Array.from({ length: 16 }, (_, i) => orb(i * 1.0, i % 2));
  W.applySparseSweep(run, {});
  for (const h of [0, 1]) {
    const hn = run.filter(n => n.type === h);
    for (let i = 1; i < hn.length; i++) {
      const cap = Math.min(5, 3 + Math.floor(hn[i].beat - hn[i - 1].beat));
      const m = Math.abs(colOf(hn[i]._x) - colOf(hn[i - 1]._x)) + Math.abs(hn[i].row - hn[i - 1].row);
      assert.ok(m <= cap + 1, `hand ${h} step ${i}: ${m} > ${cap}`);   // +1: row clamp after cap
    }
  }
});

test('pickMove hook receives section + region index', () => {
  const run = Array.from({ length: 8 }, (_, i) => orb(i, i % 2));
  const seen = [];
  W.applySparseSweep(run, { sectionAt: b => ({ name: 'chorus', b }), pickMove: (sec, reg) => { seen.push([sec.name, reg]); return 2; } });
  assert.deepEqual(seen, [['chorus', 0]]);
});
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Implement.** Insert after `function smoothPatternBoundaries` (Task 6):

```js

// ── [SparseSweep] choreograph LOOSE runs with the same move library ─────────────────────
// [DenseSweep] only takes runs at <=0.5-beat spacing; looser runs fell back to per-note
// naturalX arcs + jitter, the source of most "random-feeling" stretches. A sparse run is
// consecutive untagged free orbs with every gap <= maxGap, >= minRun orbs over >= minSpan
// beats. One move step per onset (new beat). A sparse hand has more time between notes, so
// the per-step Manhattan cap scales with the gap: min(5, 3 + floor(gapBeats)). Zone via
// handZoneCols (cross moves reach <= CROSS_REACH_COLS past centre), rows clamped to
// [rowLo,rowHi]. Records a _preSweep snapshot so [PatternCoverage] can demote the run.
const SSW_MAXGAP = 1.5;   // max beats between consecutive orbs in a sparse run
const SSW_MINRUN = 4;     // min orbs
const SSW_MINSPAN = 4;    // min beats spanned
function applySparseSweep(result, { rowLo = 2, rowHi = 8, maxGap = SSW_MAXGAP, minRun = SSW_MINRUN,
                                    minSpan = SSW_MINSPAN, sectionAt = () => null,
                                    pickMove = (_sec, reg) => reg % DANCE_MOVES.length } = {}) {
  const orbs = result
    .filter(n => (n.type === 0 || n.type === 1) && n.railEndBeat === undefined && !n._comp && !n._underSquatRail)
    .sort((a, b) => a.beat - b.beat);
  let runs = 0, tagged = 0, reg = 0, i = 0;
  while (i < orbs.length) {
    if (isPattern(orbs[i])) { i++; continue; }
    let j = i;
    while (j + 1 < orbs.length && !isPattern(orbs[j + 1]) && orbs[j + 1].beat - orbs[j].beat <= maxGap) j++;
    const run = orbs.slice(i, j + 1);
    if (run.length >= minRun && run[run.length - 1].beat - run[0].beat >= minSpan) {
      let mvIdx = pickMove(sectionAt(run[0].beat), reg) % DANCE_MOVES.length;
      let mv = DANCE_MOVES[mvIdx], k = 0, lastBk = null, prevL = null, prevR = null;
      for (const o of run) {
        const bk = Math.round(o.beat * 64);
        if (lastBk !== null && bk !== lastBk) {
          k++;
          if (k >= mv.steps.length) { mvIdx = (mvIdx + 1) % DANCE_MOVES.length; mv = DANCE_MOVES[mvIdx]; k = 0; }
        }
        lastBk = bk;
        const isR = o.type === 0, st = mv.steps[k];
        const want = (isR ? st.r : st.l) || (isR ? (prevR || [10, 5]) : (prevL || [4, 5]));
        let col = want[0], row = want[1];
        const prev = isR ? prevR : prevL;
        if (prev) {
          const cap = Math.min(5, 3 + Math.floor(o.beat - prev[2]));
          const dC = col - prev[0], dR = row - prev[1], manh = Math.abs(dC) + Math.abs(dR);
          if (manh > cap) { const sc = cap / manh; col = Math.round(prev[0] + dC * sc); row = Math.round(prev[1] + dR * sc); }
        }
        row = Math.max(rowLo, Math.min(rowHi, Math.round(row)));
        const z = handZoneCols(isR ? 0 : 1, mv.cross);
        col = Math.max(z.colMin, Math.min(z.colMax, col));
        o._preSweep = o._preSweep || { x: o._x, row: o.row };
        o._x = COL_X[col];
        o.row = row;
        o._sparseSweep = true;
        if (mv.cross && ((isR && col < 7) || (!isR && col > 7))) o._crossover = true;
        if (isR) prevR = [col, row, o.beat]; else prevL = [col, row, o.beat];
        tagged++;
      }
      runs++; reg++;
    }
    i = j + 1;
  }
  return { runs, tagged, smoothed: smoothPatternBoundaries(orbs) };
}
```

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Commit:** `git commit -am "SparseSweep: choreograph loose runs from DANCE_MOVES"`

---

### Task 9: `[PatternCoverage]` band

- [x] **Write the failing test.** Create `tests/coverage.test.mjs`:

```js
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
```

- [x] **Verify failure:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Implement.** Insert after `function applySparseSweep` (Task 8):

```js

// ── [PatternCoverage] keep choreographed coverage in band ─────────────────────────────
// Coverage = share of ALL notes owned by a shape: rails (heads + companions), DenseSweep,
// SparseSweep, GoldSweep. Under the band: one promotion attempt (caller passes a relaxed
// SparseSweep). Over the band: demote SparseSweep runs (shortest first), then DenseSweep,
// restoring each note's pre-sweep position. Rails and GoldSweep are never touched.
const PATTERN_COVERAGE_BAND = { lo: 0.60, hi: 0.80 };
function isCoverageNote(n) { return n.railEndBeat !== undefined || !!n._comp || isPattern(n) || !!n._goldSweep; }
function patternCoverage(notes) { return notes.length ? notes.filter(isCoverageNote).length / notes.length : 0; }
// Runs of `tag`-tagged notes split at gaps > 2 beats.
function patternRuns(notes, tag) {
  const tagged = notes.filter(n => n[tag]).sort((a, b) => a.beat - b.beat);
  const runs = [];
  for (const n of tagged) {
    const cur = runs[runs.length - 1];
    if (cur && n.beat - cur[cur.length - 1].beat <= 2) cur.push(n); else runs.push([n]);
  }
  return runs;
}
function enforcePatternCoverage(result, { band = PATTERN_COVERAGE_BAND, promote = () => ({ tagged: 0 }) } = {}) {
  const before = patternCoverage(result);
  let promoted = 0, demoted = 0;
  if (before < band.lo) promoted = promote().tagged || 0;
  const floorCount = Math.ceil(band.lo * result.length);
  let covered = result.filter(isCoverageNote).length;
  let excess = covered - Math.floor(band.hi * result.length);
  for (const tag of ['_sparseSweep', '_denseSweep']) {
    if (excess <= 0) break;
    for (const run of patternRuns(result, tag).sort((a, b) => a.length - b.length)) {
      if (excess <= 0) break;
      if (covered - run.length < floorCount) continue;        // would overshoot BELOW the band — skip
      covered -= run.length;
      for (const n of run) {
        if (n._preSweep) { n._x = n._preSweep.x; n.row = n._preSweep.row; }
        delete n[tag]; delete n._preSweep; delete n._crossover;
        if (!isCoverageNote(n)) { excess--; demoted++; }
      }
    }
  }
  return { before, after: patternCoverage(result), promoted, demoted };
}
```

- [x] **Verify pass:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails).
- [x] **Commit:** `git commit -am "PatternCoverage: 60-80% band with promote/demote"`

---

### Task 10: Wire everything into `onsetsToNotes`

There's no unit test for this task; Task 12's live run verifies it. Make these edits:

- [x] **Motif memory instance.** Directly after `function sectionAt(beat) { … }` inside `onsetsToNotes`, add:
```js
  const motifMemory = createMotifMemory(sections);   // per Generate call (spec decision 2026-11-21)
```
- [x] **Main-loop rails.** Replace
```js
      const _arc = generateRailArc(beat, arcRowStart, endBeat, arcRowEnd, snapSize, xStart, hand, isOtherHandResting, swayBoost, bpm, obsConstraint);
```
with
```js
      const _motifSec = sectionAt(beat);
      const _arc = generateRailArc(beat, arcRowStart, endBeat, arcRowEnd, snapSize, xStart, hand, isOtherHandResting, swayBoost, bpm, obsConstraint, null, motifMemory.replay(_motifSec, 'rails'));
      motifMemory.record(_motifSec, 'rails', _arc.plan);
```
- [x] **GoldSweep.** Replace `const shape = gReshaped % GOLD_SHAPES;` with
```js
        const _gSec = sectionAt(run[0].beat);
        const shape = motifMemory.replay(_gSec, 'gold') ?? (gReshaped % GOLD_SHAPES);
        motifMemory.record(_gSec, 'gold', shape);
```
- [x] **DenseSweep.** Replace `let mvIdx = _reg % MOVES.length, mv = MOVES[mvIdx], k = 0, lastBk = null;` with
```js
        const _dSec = sectionAt(region[0].beat);
        let mvIdx = motifMemory.replay(_dSec, 'dense') ?? (_reg % MOVES.length);
        motifMemory.record(_dSec, 'dense', mvIdx);
        let mv = MOVES[mvIdx], k = 0, lastBk = null;
```
- [x] **SparseSweep + PatternCoverage.** Insert right after the closing `}` of `if (DENSE_SWEEP) { … }`, before `// ── FINAL C1/C2 SWEEP`:
```js
  // ── [SparseSweep] choreograph loose runs (0.5-1.5-beat spacing) — see applySparseSweep ──
  const _sswOpts = {
    rowLo: Math.max(diffRowMin, 2), rowHi: Math.min(diffRowMax, 8), sectionAt,
    pickMove: (sec, reg) => {
      const v = motifMemory.replay(sec, 'sparse') ?? (reg % DANCE_MOVES.length);
      motifMemory.record(sec, 'sparse', v);
      return v;
    },
  };
  {
    const _ssw = applySparseSweep(result, _sswOpts);
    if (_ssw.runs) console.log(`[SparseSweep] Choreographed ${_ssw.runs} sparse run(s) (${_ssw.tagged} orbs), boundary-smoothed ${_ssw.smoothed}`);
  }
  // ── [PatternCoverage] keep choreographed coverage in 60-80% — see enforcePatternCoverage ──
  {
    const _pc = enforcePatternCoverage(result, {
      promote: () => applySparseSweep(result, { ..._sswOpts, minRun: 3, minSpan: 3, maxGap: 2.0 }),
    });
    console.log(`[PatternCoverage] before=${(100 * _pc.before).toFixed(0)}% after=${(100 * _pc.after).toFixed(0)}% promoted=${_pc.promoted} demoted=${_pc.demoted}`);
  }
```
- [x] **Motif log.** Directly after the `[RowLift]` block's `console.log(…)` closing `}`, add:
```js
  { const _ms = motifMemory.stats(); if (_ms.roots) console.log(`[MotifMemory] roots=${_ms.roots} recorded=${_ms.recorded} replayed=${_ms.replayed}`); }
```
- [x] **Run:** `node --test` (auto-discovers `tests/*.test.mjs`; on Windows a directory argument fails). All tests pass, including syntax.
- [x] **Commit:** `git commit -am "Wire motif memory, SparseSweep and PatternCoverage into onsetsToNotes"`

---

### Task 11: Critic prompt

- [x] In `style_critic_prompt.md`, section "Choreographed patterns", change the intro sentence to `… carry \`pattern: "dense"\`, \`pattern: "sparse"\` or \`pattern: "gold"\` …`. Add after the DenseSweep bullet:
```md
- **[SparseSweep] `pattern:"sparse"`** — LOOSE runs (0.5–1.5-beat spacing) choreographed from the SAME 14-move library, ≤3–5 Manhattan step/hand (cap grows with the gap). Treat like `dense`: intended shape, judge only its entry/exit via `nonpattern_big_jumps`.
- **Chorus motifs** — later choruses deliberately REPLAY the first chorus's rail shapes / sweep moves / gold shapes (intensity still escalates). Repetition across choruses is intended; do not flag it as "repetitive".
```
  and append to the `[RailShapes]` bullet: `Rails ≥6 beats chain 2–3 of these shapes back to back (e.g. wave→hook); a mid-rail change of character is intentional.`
- [x] **Commit:** `git commit -am "Critic prompt: sparse pattern, multi-segment rails, chorus motifs"`

---

### Task 12: Live verification (agent server, no user involvement)

- [x] `preview_start synthmapper-v2-agent` (:8092). Confirm the key: `curl -s localhost:8092/api_key_status` should return `{"server_key": true}`.
- [x] For each song (`painkiller`, then `another%20life`), at Master:
  1. Navigate to `http://localhost:8092/?song=<q>`.
  2. Install the `window.__log` console hook.
  3. Wait 8 s, set the Master `<select>`, and click "Generate Beatmap".
  4. Poll `window.__log` for `Committed best result`, in calls of at most 40 s.
  5. Click `#exportBtn`, wait about 8 s, then run `python validate.py debug_last_export.synth`.
- [x] **Pass criteria (record the actual numbers in the handoff):**
  - `validate.py`: **0 HARD** for both songs.
  - `[PatternCoverage] after=` within 60–80%, or the reason it isn't (for example `promoted=0` because no eligible loose runs exist). Tune `SSW_*` or the band only on evidence from these logs.
  - `[SparseSweep]` fires on Another Life (the less dense song).
  - `[MotifMemory] replayed > 0` on any song with ≥ 2 chorus-named sections.
  - No `unresolvable` in the final-iteration `[C3Clamp]`. No `CRITICAL` in the committed result.
  - Dense/sparse step-cap breaks inside wall windows are no worse than the 2026-11-21 baseline of 5.9%. Measure them in-page over `isPattern` notes, with the same script as the handoff (`inWall`, Manhattan > cap).
- [x] If a criterion fails, diagnose it from the source tags in the in-page `notes` (they keep `_sparseSweep`, `_preSweep` and the rest) before changing any threshold.

---

### Task 13: Handoff + commit

- [x] Add a session-log entry at the top of `handoff_next_session.md` (gitignored; edit only). Include the numbers from Task 12, any thresholds you tuned and why, and the open items (VR play-test of sparse choreography and multi-segment rails).
- [x] `git status` should be clean apart from the handoff. Ask the user before pushing.

---

## Self-review

| Spec requirement | Task |
|---|---|
| Multi-segment rails, 2–3 segments, ≥2.5 beats each, seeded from clamped endpoint, adjacent differ | 3, 4 |
| `railSegment` factoring, unchanged return contract | 2 (`buildRailPath`), 4 (superset `{waypoints,xEnd,rowEnd,plan,segments}`) |
| Waypoint cap shared proportionally, ≥3 per segment | 4 |
| `handZoneCols` for every segment | 4 (zone test over 20k rails) |
| SparseSweep: shared MOVES, ≤1.5-beat gates, per-onset stepping, gap-scaled cap, `_sparseSweep`, generalised boundary smoothing, `_toBand` via `isPattern` | 6, 7, 8 |
| Coverage band 60–80%, promote under / demote sparse→dense over, never rails/GoldSweep, `[PatternCoverage]` log | 9, 10 |
| Motif memory per Generate call, keyed by chorus root with the shared regex, replay with proportion scaling + tier downgrade | 1 (`fitShapeToLength`), 3 (`fitRailPlan`), 5, 10 |
| Pass order (§4) | 10 |
| Invariants (§5): C3 loose-first preference and last-resort guard, critic pattern tags, C4 band rows 2–8 | 7, 8 (`rowLo`/`rowHi`), 12 |
| Critic prompt | 11 |
| Live testing (§6) | 12 |

**Deliberate deviation from the spec:** promotion under the band uses a relaxed SparseSweep only. DenseSweep has already swept every run that meets its own gates, so re-running it would find nothing new.
