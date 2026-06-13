#!/usr/bin/env py -3.12
"""
validate.py — regression harness for exported SynthRiders .synth maps.

WHY: the generator has regressed 3x on density/detection changes, each caught only
by play-test-and-eyeball. This validates the FINAL playable artifact (beatmap.meta.bin
inside the .synth ZIP) against the same mechanical invariants the in-browser _finalize
checks (C1/C2/C3/C4 + dedup/rail-overlap), plus distribution stats. Run it after any
generator change, or across the whole synthfiles/ corpus, to catch breakage mechanically.

USAGE:
    py -3.12 validate.py <file.synth | folder> [more ...]
    py -3.12 validate.py            # defaults to ../synthfiles + this folder's debug export

Exit code = number of files with HARD violations (0 = all clean). Stats never fail.

COORDINATE NOTES (from server.py /export):
    Position = [x, y, z];  x = _x + 0.002,  y = ROW_Y8[row] + 0.0012,  z = (beat/bps)*20
    => z is the universal clock: seconds = z/20, beat = (z/20)*bps. Notes AND walls share it.
    A note is a RAIL iff it has a non-null "Segments" list; its end-z = last segment's z.
    Type: 0=right(red) 1=left(blue) 2=green(either) 3=gold(both).
"""
import sys, os, zipfile, json, glob
try:
    sys.stdout.reconfigure(encoding='utf-8')  # Windows console is cp1252 — allow ✓/⚠/✗
except Exception:
    pass

# Export's 8-row Y table (server.py ROW_Y) — for recovering row index from Position[1].
ROW_Y8 = [0.6825, 0.4875, 0.2925, 0.0975, -0.0975, -0.2925, -0.4875, -0.6825]
COL_STEP = 0.1365          # one grid column in X (COL_X step)
C1_X_TOL = COL_STEP * 1.1  # off-rail lateral tolerance (mirrors isOffRail's > RAIL_COL_STEP)
GOLD_BEATS = 1.0           # gold/green C2 clearance window (beats)
# Per-difficulty max NPS bands (generator caps: Hard 2.0 / Expert 3.0 / Master 4.0 maxNoteValue
# is a per-beat density, not NPS; these are realized-NPS ceilings observed as "too dense" — a
# soft stat, reported not failed unless egregiously exceeded).
NPS_SOFT = {'Easy': 4, 'Normal': 5, 'Hard': 6, 'Expert': 8, 'Master': 10, 'Custom': 10}

# Playability limits reverse-engineered by synth_mapping_helper (adosikas/analysis.py). Objects
# simultaneously on-screen are capped by the renderer; EXCEEDING the cap despawns them — notes
# literally vanish mid-play. Quest is the strict platform (the user's target is Quest 3).
RENDER_WINDOW_NOTES   = 3.5   # s — how far ahead notes/rails are rendered
QUEST_RENDER_LIMIT    = 500   # combined objects on screen before a hard despawn
QUEST_WIREFRAME_LIMIT = 200   # combined objects before the Quest wireframe fallback
PC_TYPE_DESPAWN       = 80    # per-type objects before that type despawns (PC)
RAIL_NODE_DIST        = 2.0   # beats — max gap between rail nodes before rendering breaks
END_PADDING           = 1.0   # s — minimum object clearance before the song ends


def _load_meta(path):
    z = zipfile.ZipFile(path)
    raw = z.read('beatmap.meta.bin')
    if raw.startswith(b'\xef\xbb\xbf'):
        raw = raw[3:]
    return json.loads(raw.decode('utf-8', errors='replace'))


def _walls_for(meta, diff):
    """Wall object clock-times (seconds) from Crouchs+Slides — for the render-window count.
    Walls share the z clock (Position[2] = seconds*20), same as notes."""
    out = []
    for key in ('Crouchs', 'Slides'):
        wd = meta.get(key, {})
        arr = wd.get(diff, []) if isinstance(wd, dict) else []
        for w in arr:
            pos = w.get('position')
            if pos and len(pos) >= 3:
                out.append(float(pos[2]) / 20.0)
    return out


def _song_duration(path):
    """Song length (seconds) from track.data.json, for the END_PADDING check. None if absent.
    `duration` is stored as a "mm:ss" (or "h:mm:ss") string, not a number."""
    try:
        raw = zipfile.ZipFile(path).read('track.data.json')
        for bom in (b'\xef\xbb\xbf', b'\xff\xfe', b'\xfe\xff'):
            if raw.startswith(bom):
                raw = raw[len(bom):]
                break
        enc = 'utf-16' if b'\x00' in raw[:40] else 'utf-8'
        dur = json.loads(raw.decode(enc, errors='replace')).get('duration')
        if isinstance(dur, str) and ':' in dur:
            sec = 0.0
            for part in dur.split(':'):
                sec = sec * 60 + float(part)
            return sec or None
        return float(dur or 0) or None
    except Exception:
        return None


def _row_of(y):
    return min(range(len(ROW_Y8)), key=lambda i: abs(ROW_Y8[i] - (y - 0.0012)))


def _notes_for(meta, diff):
    """Return list of note dicts {t, beat, x, row, type, is_rail, end_t, segs:[(t,x,row)]}."""
    bps = float(meta.get('BPM', 120)) / 60.0
    out = []
    beats = meta.get('Track', {}).get(diff, {})
    for _bk, arr in beats.items():
        for nd in arr:
            pos = nd.get('Position') or [0, 0, 0]
            z = float(pos[2])
            segs_raw = nd.get('Segments')
            segs = []
            end_t = z
            if segs_raw:
                for s in segs_raw:
                    segs.append((float(s[2]), float(s[0]), _row_of(float(s[1]))))
                end_t = segs[-1][0] if segs else z
            out.append({
                't': z, 'beat': (z / 20.0) * bps, 'x': float(pos[0]),
                'row': _row_of(float(pos[1])), 'type': int(nd.get('Type', 0)),
                'is_rail': bool(segs_raw), 'end_t': end_t,
                'end_beat': (end_t / 20.0) * bps, 'segs': segs,
            })
    out.sort(key=lambda n: n['t'])
    return out, bps


def _rail_x_at(note, t):
    """Interpolate a rail's X at clock-time t (start Pos -> segment waypoints)."""
    pts = [(note['t'], note['x'])] + [(s[0], s[1]) for s in note['segs']]
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return x0 if t1 == t0 else x0 + (x1 - x0) * (t - t0) / (t1 - t0)
    return pts[-1][1]


def validate_diff(meta, diff, walls=None, song_dur=None):
    notes, bps = _notes_for(meta, diff)
    n = len(notes)
    hard, soft, stats = [], [], {}
    if n == 0:
        return hard, soft, {'notes': 0}
    beat_eps = 0.02
    orbs   = [x for x in notes if not x['is_rail']]
    rails  = [x for x in notes if x['is_rail']]
    golds  = [x for x in orbs if x['type'] == 3]
    greens = [x for x in orbs if x['type'] == 2]

    # ── HARD C-invariants ────────────────────────────────────────────────
    # Dedup: two FREE orbs of the same Type at the same instant (truly redundant —
    # unhittable as two notes). Rail heads are excluded: a rail start legitimately
    # coincides with its combo, and DedupSameBeat keeps the rail over a same-beat orb.
    dup = 0
    by = sorted(orbs, key=lambda x: (x['type'], x['t']))
    for a, b in zip(by, by[1:]):
        if a['type'] == b['type'] and abs(a['beat'] - b['beat']) < beat_eps:
            dup += 1
    if dup: hard.append(f"DEDUP: {dup} same-type same-beat duplicate orb(s)")

    # Same-hand rail overlap (types 0/1/3 pin a hand; two of same type overlapping in time).
    ov = 0
    for ty in (0, 1, 3):
        rs = sorted([r for r in rails if r['type'] == ty], key=lambda r: r['t'])
        for a, b in zip(rs, rs[1:]):
            if b['t'] < a['end_t'] - beat_eps:
                ov += 1
    if ov: hard.append(f"RAIL-OVERLAP: {ov} same-hand rail(s) overlap in time")

    # C2 green-rail: green orb inside (or within 1 beat of) ANY rail window — unreachable.
    grc = 0
    for g in greens:
        for r in rails:
            if g['beat'] >= r['beat'] - GOLD_BEATS and g['beat'] <= r['end_beat'] + GOLD_BEATS:
                grc += 1; break
    if grc: hard.append(f"C2-GREEN-RAIL: {grc} green orb(s) inside an active rail window")

    # C2 gold: single-hand (0/1) orb within 1 beat of a gold orb, or inside a gold-rail window.
    gold_rails = [r for r in rails if r['type'] == 3]
    c2g = 0
    for m in orbs:
        if m['type'] not in (0, 1): continue
        if any(abs(m['beat'] - g['beat']) <= GOLD_BEATS for g in golds):
            c2g += 1; continue
        if any(gr['beat'] - GOLD_BEATS <= m['beat'] <= gr['end_beat'] + GOLD_BEATS for gr in gold_rails):
            c2g += 1
    if c2g: hard.append(f"C2-GOLD: {c2g} single-hand note(s) within 1 beat of gold")

    # C1: same-type orb sitting inside a same-type rail's active window but off its X path.
    c1 = 0
    for m in orbs:
        if m['type'] not in (0, 1): continue
        for r in rails:
            if r['type'] != m['type']: continue
            if r['beat'] - beat_eps <= m['beat'] <= r['end_beat'] + beat_eps:
                if abs(m['x'] - _rail_x_at(r, m['t'])) > C1_X_TOL:
                    c1 += 1; break
    if c1: hard.append(f"C1: {c1} same-hand orb(s) off active rail path")

    # Hand-zone sanity: a note driven DEEP into the opposite field (past the deliberate
    # [Crossover] reach of cols 5-6/8-9 ≈ 2 cols past centre) is genuinely unreachable for
    # its hand. Threshold = 3+ cols past centre, so legitimate crossovers don't trip it.
    ZONE_TOL = 3 * COL_STEP
    zone = sum(1 for x in notes if (x['type'] == 0 and x['x'] < -ZONE_TOL) or
                                     (x['type'] == 1 and x['x'] > ZONE_TOL))
    if zone: hard.append(f"ZONE: {zone} note(s) driven deep into the wrong hand's field")

    # ── SOFT distribution stats ──────────────────────────────────────────
    R = sum(1 for x in notes if x['type'] == 0)
    L = sum(1 for x in notes if x['type'] == 1)
    sh = R + L
    bal = round(100 * min(R, L) / sh) if sh else 0
    gold_pct  = round(100 * len(golds) / n, 1)
    green_pct = round(100 * len(greens) / n, 1)
    # Crossover: orb reaching past centre to the opposite side's inner columns.
    cross = sum(1 for x in orbs if (x['type'] == 0 and x['x'] < -COL_STEP) or
                                    (x['type'] == 1 and x['x'] > COL_STEP))
    cross_pct = round(100 * cross / max(len(orbs), 1), 1)
    # Max NPS over a sliding 1s window.
    ts = sorted(x['t'] / 20.0 for x in notes)
    max_nps, j = 0, 0
    for i in range(len(ts)):
        while ts[i] - ts[j] > 1.0: j += 1
        max_nps = max(max_nps, i - j + 1)
    # Longest noteless gap (seconds), within the mapped span.
    max_gap = max((b - a for a, b in zip(ts, ts[1:])), default=0)
    # Row extremes (ceiling row 0 / floor row 7 in export's 8-row space).
    ceil_pct  = round(100 * sum(1 for x in notes if x['row'] == 0) / n, 1)
    floor_pct = round(100 * sum(1 for x in notes if x['row'] == 7) / n, 1)

    # Render-window object count (synth_mapping_helper limits): peak objects simultaneously
    # on-screen = max in any forward RENDER_WINDOW_NOTES-second window (notes+rails+walls).
    def _max_in_window(times, win):
        ts2 = sorted(times); mx = jj = 0
        for ii in range(len(ts2)):
            while ts2[ii] - ts2[jj] > win:
                jj += 1
            mx = max(mx, ii - jj + 1)
        return mx
    note_times   = [x['t'] / 20.0 for x in notes]
    max_window   = _max_in_window(note_times + (walls or []), RENDER_WINDOW_NOTES)
    max_type_win = max((_max_in_window([x['t'] / 20.0 for x in notes if x['type'] == ty],
                                       RENDER_WINDOW_NOTES) for ty in (0, 1, 2, 3)), default=0)

    stats = {'notes': n, 'rails': len(rails), 'R/L': f"{R}/{L}", 'balance%': bal,
             'gold%': gold_pct, 'green%': green_pct, 'crossover%': cross_pct,
             'maxNPS': max_nps, 'maxWin': max_window, 'maxGap_s': round(max_gap, 1),
             'ceil%': ceil_pct, 'floor%': floor_pct}

    # Pathological gold (≫ favorites' 9-11% and the 8% cap) with no rails is the classic
    # expandSections-fallback signature (the [DensityClip] spread-throw: ~41% gold, 0 rails).
    if gold_pct > 25:
        hard.append(f"GOLD-RUNAWAY: gold {gold_pct}% (≫ cap — likely generator fell back to expandSections)")
    if len(rails) == 0 and n > 200:
        soft.append("0 rails on a dense map (possible expandSections fallback — check [FinalSweep] logged)")
    if bal and bal < 40: soft.append(f"hand balance {bal}% (<40 — lopsided)")
    if 14 < gold_pct <= 25: soft.append(f"gold {gold_pct}% (>14 — high)")
    if max_nps > NPS_SOFT.get(diff, 10): soft.append(f"maxNPS {max_nps} (>{NPS_SOFT.get(diff,10)} for {diff})")
    if max_gap > 6:      soft.append(f"noteless gap {round(max_gap,1)}s (>6 — dead air)")
    if ceil_pct > 4:     soft.append(f"ceiling {ceil_pct}% (>4 — too many top-row)")

    # ── Render/despawn limits (synth_mapping_helper analysis.py) ──────────────────────────
    if max_window > QUEST_RENDER_LIMIT:
        hard.append(f"DESPAWN: {max_window} objects within {RENDER_WINDOW_NOTES}s "
                    f"(> Quest render cap {QUEST_RENDER_LIMIT} — objects vanish in-game)")
    elif max_window > QUEST_WIREFRAME_LIMIT:
        soft.append(f"density {max_window} obj/{RENDER_WINDOW_NOTES}s (> Quest wireframe {QUEST_WIREFRAME_LIMIT})")
    if max_type_win > PC_TYPE_DESPAWN:
        soft.append(f"{max_type_win} same-type obj/{RENDER_WINDOW_NOTES}s (> PC per-type despawn {PC_TYPE_DESPAWN})")

    # Rail node spacing: nodes farther apart than RAIL_NODE_DIST beats can render incorrectly.
    rail_node_bad = 0
    for r in rails:
        bs = [r['beat']] + [(s[0] / 20.0) * bps for s in r['segs']]
        if any(b2 - b1 > RAIL_NODE_DIST + 1e-6 for b1, b2 in zip(bs, bs[1:])):
            rail_node_bad += 1
    if rail_node_bad:
        soft.append(f"{rail_node_bad} rail(s) with a node gap >{RAIL_NODE_DIST} beats (may render wrong)")

    # Endpoint clearance: flag objects scheduled PAST the audio end (unhittable). The
    # track.data.json duration is mm:ss (±1s rounding) and songs legitimately end on the last
    # beat, so a "within 1s of end" check is almost all normal endings — only a clear overrun
    # (> END_PADDING beyond the rounded duration) is a real cut-off defect.
    if song_dur:
        overrun = [x['t'] / 20.0 for x in notes if x['t'] / 20.0 > song_dur + END_PADDING]
        if overrun:
            soft.append(f"{len(overrun)} object(s) past song end ({song_dur:.0f}s, last @ {max(overrun):.0f}s) — unhittable")
    return hard, soft, stats


def validate_file(path):
    name = os.path.basename(path)
    try:
        meta = _load_meta(path)
    except Exception as e:
        print(f"✗ {name}: OPEN/PARSE FAIL — {e}")
        return 1
    tr = meta.get('Track', {})
    populated = {d: b for d, b in tr.items() if isinstance(b, dict) and b}
    if not populated:
        print(f"· {name}: no populated difficulty (skipped)")
        return 0
    file_bad = 0
    song_dur = _song_duration(path)
    for diff in sorted(populated, key=lambda d: -len(populated[d])):
        hard, soft, stats = validate_diff(meta, diff, _walls_for(meta, diff), song_dur)
        mark = "✗" if hard else ("⚠" if soft else "✓")
        statline = " ".join(f"{k}={v}" for k, v in stats.items())
        print(f"{mark} {name} [{diff}]  {statline}")
        for h in hard: print(f"    HARD  {h}")
        for s in soft: print(f"    soft  {s}")
        if hard: file_bad = 1
    return file_bad


def main(argv):
    targets = argv[1:]
    if not targets:
        here = os.path.dirname(os.path.abspath(__file__))
        targets = [os.path.join(here, '..', 'synthfiles'),
                   os.path.join(here, 'debug_last_export.synth')]
    files = []
    for t in targets:
        if os.path.isdir(t):
            files += sorted(glob.glob(os.path.join(t, '*.synth')))
        elif os.path.isfile(t):
            files.append(t)
        else:
            print(f"(skip, not found: {t})")
    if not files:
        print("No .synth files to validate."); return 0
    bad = 0
    for f in files:
        bad += validate_file(f)
    print(f"\n{'='*60}\n{len(files)} file(s) checked — {bad} with HARD violation(s).")
    return bad


if __name__ == '__main__':
    sys.exit(main(sys.argv))
