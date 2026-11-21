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
