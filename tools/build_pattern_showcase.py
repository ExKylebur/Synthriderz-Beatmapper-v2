#!/usr/bin/env python3
"""Build the "Pattern Showcase" .synth: every pattern/move the generator can make, announced by voice.

    py -3.12 tools/build_pattern_showcase.py [--out DIR]

Pipeline: tools/pattern_showcase_gen.mjs (node; runs the REAL generator code from
synthriders-creator.html and prints each pattern's notes as JSON) -> timeline + audio
(metronome click + soft bass + offline Windows TTS announcements) -> .synth zip laid out like
server.py's _handle_export (server.build_note_track / convert_to_ogg / build_synth_zip are imported,
not copied). Re-run after the generator changes: it reads the HTML each time.

Outputs (default DIR = ~/Downloads): pattern-showcase-custom.synth, pattern-showcase-legend.txt.
"""
import argparse, hashlib, json, math, os, re, subprocess, sys, tempfile, time
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (read-only use: build_note_track, convert_to_ogg, build_synth_zip, ...)

SR = 44100
TITLE, ARTIST, MAPPER, DIFF_NAME = 'Pattern Showcase', 'Synthmapper', 'Synthmapper', 'Master'
INTRO_BEATS = 8
MIN_REST = 4          # beats of rest between patterns (grows when the announcement is longer)


def run_node():
    p = subprocess.run(['node', str(ROOT / 'tools' / 'pattern_showcase_gen.mjs')], cwd=ROOT,
                       capture_output=True, text=True, encoding='utf-8')
    if p.returncode != 0:
        sys.exit('node generator failed:\n' + p.stderr)
    return json.loads(p.stdout)


def tts(phrases, workdir):
    """Offline Windows TTS (System.Speech) -> {phrase: float32 mono array @ SR}."""
    jf = workdir / 'phrases.json'
    jf.write_text(json.dumps(phrases), encoding='utf-8')
    ps1 = workdir / 'tts.ps1'
    ps1.write_text(r'''
param([string]$Json, [string]$OutDir)
Add-Type -AssemblyName System.Speech
$phrases = Get-Content -Raw -Encoding UTF8 $Json | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
for ($i = 0; $i -lt $phrases.Count; $i++) {
  $s.SetOutputToWaveFile((Join-Path $OutDir ("p{0}.wav" -f $i)))
  $s.Speak($phrases[$i])
  $s.SetOutputToNull()
}
$s.Dispose()
''', encoding='utf-8')
    r = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ps1),
                        str(jf), str(workdir)], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('TTS failed:\n' + r.stderr)
    out = {}
    for i, ph in enumerate(phrases):
        y, sr = sf.read(str(workdir / f'p{i}.wav'), dtype='float32', always_2d=True)
        y = y.mean(axis=1)
        if sr != SR:
            g = gcd(sr, SR)
            y = resample_poly(y, SR // g, sr // g).astype(np.float32)
        y = np.trim_zeros(np.where(np.abs(y) < 1e-4, 0, y))
        out[ph] = y / max(1e-6, float(np.abs(y).max()))
    return out


def mmss(t):
    return f'{int(t // 60)}:{t % 60:04.1f}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(Path.home() / 'Downloads'))
    args = ap.parse_args()
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    data = run_node()
    bpm = float(data['bpm'])
    bps = bpm / 60.0
    patterns = data['patterns']
    T = lambda beat: beat / bps                       # beat -> seconds (map clock)

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        phrases = ['Pattern showcase. A voice announces each pattern a few beats before it starts.'] + \
                  [p['say'] for p in patterns] + ['That is every pattern. End of showcase.']
        voice = tts(phrases, work)

    # ── timeline ─────────────────────────────────────────────────────────────────────────
    ceil4 = lambda x: int(math.ceil(x / 4.0 - 1e-9)) * 4
    cur_end = float(INTRO_BEATS)
    intro_say = phrases[0]
    timeline = []                                      # (start_beat, ann_beat, pattern)
    for p in patterns:
        dur_b = len(voice[p['say']]) / SR * bps
        start = ceil4(max(cur_end + MIN_REST, cur_end + 0.5 + dur_b + 1.0))
        ann = start - dur_b - 1.0
        timeline.append((start, ann, p))
        cur_end = start + p['beats']
    end_b = cur_end + 3
    end_say_b = len(voice[phrases[-1]]) / SR * bps
    total_beats = ceil4(end_b + end_say_b + 2)

    # ── notes / walls on the absolute clock ──────────────────────────────────────────────────
    q = lambda b: round(b * 64) / 64.0
    notes, crouchs, slides = [], [], []
    legend = []
    for start, ann, p in timeline:
        for n in p['notes']:
            m = {'beat': q(n['beat'] + start), 'row': n['row'], 'type': n['type'], '_x': n['_x'],
                 'railEndBeat': None, 'railEndRow': None, 'railEnd_x': None, 'railSegments': None}
            if n.get('railEndBeat') is not None:
                m['railEndBeat'] = q(n['railEndBeat'] + start)
                m['railEndRow'] = n['railEndRow']
                m['railEnd_x'] = n['railEnd_x']
                m['railSegments'] = [{'beat': q(w['beat'] + start), 'row': w['row'], '_x': w['_x']}
                                     for w in n['railSegments']]
            notes.append(m)
        for w in p['walls']:
            if w['wallType'] == 'crouch':
                crouchs.append({'beat': start + w['beat'], 'duration': w['duration']})
            else:
                # Same mapping as the app's export (exportBtn): leanLeft = 1, leanRight = 2, else the
                # slide's own type. Defaulting every lean to 0 exported them as slide BOXES (fixed
                # 2026-11-26: the 11-24 showcase's 'Obstacle moves' lean demos, which carry no slideType,
                # played as slides in game; the 'Walls' group passes 1 / 2 explicitly and was right).
                st = w.get('slideType')
                if st is None:
                    st = {'leanLeft': 1, 'leanRight': 2}.get(w['wallType'], 0)
                slides.append({'beat': start + w['beat'], 'duration': w['duration'], 'wallType': w['wallType'],
                               'slideType': st})
        legend.append((T(start), T(ann), start, p))
    notes.sort(key=lambda n: n['beat'])

    # ── audio: click + soft bass + voice ───────────────────────────────────────────────────────
    n_samp = int(T(total_beats) * SR)
    mix = np.zeros(n_samp, dtype=np.float32)

    def put(sig, t, gain=1.0):
        i = int(round(t * SR))
        if i < 0 or i >= n_samp:
            return
        j = min(n_samp, i + len(sig))
        mix[i:j] += (sig[:j - i] * gain).astype(np.float32)

    tt = np.arange(int(0.05 * SR)) / SR
    click = (np.sin(2 * np.pi * 1000 * tt) * np.exp(-tt / 0.008)).astype(np.float32)
    click_hi = (np.sin(2 * np.pi * 1600 * tt) * np.exp(-tt / 0.010)).astype(np.float32)
    tb = np.arange(int(0.45 * SR)) / SR
    bass = lambda f: (np.sin(2 * np.pi * f * tb) * np.exp(-tb / 0.18)).astype(np.float32)
    bass_a, bass_b = bass(55.0), bass(82.4)
    ping_t = np.arange(int(0.18 * SR)) / SR
    ping = ((np.sin(2 * np.pi * 1320 * ping_t) + 0.5 * np.sin(2 * np.pi * 1980 * ping_t)) * np.exp(-ping_t / 0.05)).astype(np.float32)
    starts = {int(s) for s, _, _ in timeline}
    for b in range(int(total_beats)):
        down = b % 4 == 0
        put(click_hi if down else click, T(b), 0.45 if down else 0.25)
        put(bass_a if b % 4 in (0, 1) else bass_b, T(b), 0.30)
        if b in starts:
            put(ping, T(b), 0.35)                       # pattern-start cue
    put(voice[phrases[0]], T(0.5), 0.9)
    for _, ann, p in timeline:
        put(voice[p['say']], T(ann), 0.9)
    put(voice[phrases[-1]], T(end_b), 0.9)
    peak = float(np.abs(mix).max())
    mix = mix / peak * 0.85
    with tempfile.TemporaryDirectory() as td:
        wp = Path(td) / 'pattern-showcase.wav'
        sf.write(str(wp), np.stack([mix, mix], axis=1), SR, subtype='PCM_16')
        audio_bytes = server.convert_to_ogg(wp.read_bytes(), '.wav')

    # ── .synth, same layout as server._handle_export ──────────────────────────────────────────
    title, artist, mapper = TITLE.title(), ARTIST.title(), MAPPER.title()
    track = server.build_note_track(notes, bpm)

    def wall_z(b): return round((b / bps) * server.TIME_SCALE, 6)
    def tiles(beat, dur):
        if dur <= 1.0:
            return [beat]
        ts, t = [], beat
        while t < beat + dur - 0.01:
            ts.append(t); t += 0.5
        return ts
    crouchs_list = sorted(({'time': round(t * 64), 'position': [0.0, 0.0, wall_z(t)], 'initialized': True}
                           for w in crouchs for t in tiles(w['beat'], w['duration'])), key=lambda x: x['time'])
    slides_list = sorted(({'time': round(t * 64), 'slideType': int(w['slideType']), 'position': [0.0, 0.0, wall_z(t)],
                           'zRotation': 0.0, 'initialized': True}
                          for w in slides for t in tiles(w['beat'], w['duration'])), key=lambda x: x['time'])

    audio_stem = 'pattern-showcase'
    safe_audio_name = f'{audio_stem[:16]}_{hashlib.sha256(audio_bytes).hexdigest()[:8]}.ogg'
    dur_secs = server.ogg_vorbis_duration(audio_bytes)
    duration_str = f'{int(dur_secs // 60):02d}:{int(dur_secs % 60):02d}'
    DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'Master', 'Custom']
    beatmap = {
        'Name': title, 'Author': artist, 'Artwork': 'Default Image', 'ArtworkBytes': None,
        'AudioName': safe_audio_name, 'AudioData': None, 'AudioFrecuency': 44100, 'AudioChannels': 2,
        'BPM': bpm, 'Offset': 0.0,
        'Track': {d: (track if d == DIFF_NAME else {}) for d in DIFFICULTIES},
        'Effects': {d: [] for d in DIFFICULTIES},
        'Bookmarks': {'BookmarksList': []},
        'Jumps': {d: [] for d in DIFFICULTIES},
        'Crouchs': {d: (crouchs_list if d == DIFF_NAME else []) for d in DIFFICULTIES},
        'Slides': {d: (slides_list if d == DIFF_NAME else []) for d in DIFFICULTIES},
        'Lights': {d: [] for d in DIFFICULTIES},
        'DrumSamples': None, 'FilePath': 'Redacted', 'IsAdminOnly': False,
        'EditorVersion': 'SynthRiders Beatmap Creator', 'Beatmapper': mapper,
        'CustomDifficultyName': 'Custom', 'CustomDifficultySpeed': 1.0, 'UsingBeatMeasure': True,
        'UpdatedWithMovementPositions': True, 'ProductionMode': False, 'Tags': [], 'BeatConverted': False,
        'ModifiedTime': int(time.time()),
    }
    beatmap_bytes = b'\xef\xbb\xbf' + json.dumps(beatmap, indent=2).encode('utf-8').replace(b'\n', b'\r\n')
    meta = {'name': title, 'artist': artist, 'duration': duration_str, 'coverImage': 'Default Image',
            'audioFile': safe_audio_name, 'supportedDifficulties': [d if d == DIFF_NAME else '' for d in DIFFICULTIES],
            'bpm': bpm, 'mapper': mapper}
    meta_bytes = b'\xff\xfe' + json.dumps(meta, indent=4).encode('utf-16-le')
    synth = server.build_synth_zip([('beatmap.meta.bin', beatmap_bytes), (safe_audio_name, audio_bytes),
                                    ('track.data.json', meta_bytes)])
    synth_path = outdir / 'pattern-showcase-custom.synth'
    synth_path.write_bytes(synth)

    # ── legend ────────────────────────────────────────────────────────────────────────────────
    L = [f'Pattern Showcase  -  {bpm:g} BPM, Master, {len(notes)} notes, {mmss(dur_secs)} long',
         'time = when the pattern STARTS (a bar line; a ping marks it). The voice speaks a few beats earlier.',
         'Hands: right = red/type 0, left = blue/type 1. Columns 0-14 (7 = centre), rows 0-10 (0 = top).',
         '']
    grp = None
    for t, ta, beat, p in legend:
        if p['group'] != grp:
            grp = p['group']; L += ['', f'== {grp} ==']
        info = p['info']
        extra = ''
        if 'path' in info and p['group'].startswith(('Rails', 'Gold')) and 'stats' not in info:
            extra = '  path(col,row): ' + ' '.join(f"{c['col']},{c['row']}" for c in info['path'])
        elif 'rightStats' in info:
            rs, ls = info['rightStats'], info['leftStats']
            spiral = any(k in info.get('move', '').lower() for k in ('spiral', 'orbit'))   # turn direction: loops only
            extra = f"  R{' ' + rs.get('turn', '') if spiral else ''} r={rs.get('radiusMin')}-{rs.get('radiusMax')} span {rs.get('colSpan')}c x {rs.get('rowSpan')}r"
            if info.get('left') and spiral:
                extra += f" | L {ls.get('turn', '')}"
        elif 'choreo' in info:
            st = info['choreo']
            extra = (f"  moved {info.get('moved')}/{info.get('of')}: swoop {st['swoop']}, tilt {st['tilt']}, "
                     f"sway {st['sway']} in the window, {st['ramp']} on the approach/release")
        elif 'stats' in info:
            st = info['stats']; extra = f"  span {st.get('colSpan')}c x {st.get('rowSpan')}r"
        if info.get('plan'):
            extra += '  plan: ' + ', '.join(info['plan'])
        L.append(f'{mmss(t):>7}  beat {beat:>4}  {p["name"]}  [{info["fn"]}]{extra}')
    legend_path = outdir / 'pattern-showcase-legend.txt'
    legend_path.write_text('\n'.join(L) + '\n', encoding='utf-8')
    print('\n'.join(L))
    print(f'\nwrote {synth_path}  ({len(synth) // 1024} KB)\nwrote {legend_path}')


if __name__ == '__main__':
    main()
