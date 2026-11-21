#!/usr/bin/env python3
"""
SynthRiders Beatmap Creator — Local Server
==========================================
Run this script to serve the tool with automatic audio conversion.
MP3, WAV, FLAC, M4A and other formats will be converted to OGG via ffmpeg.

Usage (Windows):
    Double-click launch.bat
    — OR —
    python server.py

Usage (Mac/Linux):
    python3 server.py

Then open:  http://localhost:8090  (v2 sandbox port; stable build uses 8080) (opens automatically on Windows)

Requirements: Python 3.8+, ffmpeg
  - Windows: winget install ffmpeg
             OR download from https://ffmpeg.org/download.html and add to PATH
  - macOS:   brew install ffmpeg
  - Linux:   sudo apt install ffmpeg
"""

import http.server
import subprocess
import tempfile
import os
import sys
import re
import struct
import io
import json
import math
import urllib.parse
from pathlib import Path

class _NumpyEncoder(json.JSONEncoder):
    """Serialize numpy scalars/arrays to native Python types for JSON output."""
    def default(self, obj):
        try:
            import numpy as np
            if isinstance(obj, np.integer):
                return int(obj)
            if isinstance(obj, np.floating):
                return float(obj)
            if isinstance(obj, np.ndarray):
                return obj.tolist()
        except ImportError:
            pass
        return super().default(obj)

# Force UTF-8 output on Windows so Unicode characters in print() don't crash.
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = 8090  # v2 sandbox — distinct from the stable build's 8080 so both can run at once (A/B)
# `--port N` overrides, so a second instance (e.g. an agent-driven test server) can run
# alongside one already holding 8090.
if '--port' in sys.argv:
    PORT = int(sys.argv[sys.argv.index('--port') + 1])
SCRIPT_DIR = Path(__file__).parent  # serve from the folder server.py lives in

# ── Server-held Anthropic key + local dev helpers ─────────────────────────────
# Lets a generation run with NO key pasted into the page: the browser posts to
# /anthropic and the server adds the key before forwarding to api.anthropic.com, so the
# key never reaches the page. Source, first match wins:
#   1. env var ANTHROPIC_API_KEY
#   2. file <script_dir>/.anthropic_key (one line; gitignored)
# A key typed into the page still goes direct to Anthropic exactly as before.
#
# SECURITY: this server sends `Access-Control-Allow-Origin: *` and binds every interface,
# so a key-adding proxy would otherwise let any website the user visits — or any device
# on the LAN — spend the key. /anthropic and /dev_song therefore require a loopback
# client AND (when the browser sends one) an Origin of this server itself.
ANTHROPIC_KEY_FILE = SCRIPT_DIR / '.anthropic_key'
SONG_DIR = SCRIPT_DIR.parent / 'MP3'   # where the user's source audio lives
SONG_EXTS = ('.ogg', '.mp3', '.wav', '.flac', '.m4a', '.aac')


def server_anthropic_key() -> str:
    key = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not key and ANTHROPIC_KEY_FILE.exists():
        key = ANTHROPIC_KEY_FILE.read_text(encoding='utf-8').strip()
    return key


def find_song(query: str):
    """Case-insensitive substring match on filenames in SONG_DIR (no path parts allowed).
    Returns the single best Path (shortest name among matches) or None."""
    q = (query or '').strip().lower()
    if not q or '/' in q or '\\' in q or '..' in q or not SONG_DIR.is_dir():
        return None
    hits = [p for p in SONG_DIR.iterdir()
            if p.is_file() and p.suffix.lower() in SONG_EXTS and q in p.name.lower()]
    return min(hits, key=lambda p: len(p.name)) if hits else None

# ── Song metadata library ─────────────────────────────────────────────────────
# Persistent JSON cache so repeated songs don't need API lookups.
# File: <script_dir>/metadata_library.json
META_LIB_PATH = SCRIPT_DIR / 'metadata_library.json'

def load_meta_library() -> dict:
    if META_LIB_PATH.exists():
        try:
            return json.loads(META_LIB_PATH.read_text('utf-8'))
        except Exception:
            return {}
    return {}

def save_meta_library(data: dict) -> None:
    META_LIB_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8'
    )

# ── Generation diagnostics log ────────────────────────────────────────────────
# Appended after every generation run. Keeps the 50 most recent entries.
# File: <script_dir>/generation_diagnostics.json
DIAG_PATH = SCRIPT_DIR / 'generation_diagnostics.json'
DIAG_MAX  = 50

def load_diagnostics() -> list:
    if DIAG_PATH.exists():
        try:
            return json.loads(DIAG_PATH.read_text('utf-8'))
        except Exception:
            return []
    return []

def append_diagnostic(entry: dict) -> None:
    runs = load_diagnostics()
    runs.append(entry)
    if len(runs) > DIAG_MAX:
        runs = runs[-DIAG_MAX:]
    DIAG_PATH.write_text(json.dumps(runs, ensure_ascii=False, indent=2), encoding='utf-8')

# ── YouTube audio download (yt-dlp) ───────────────────────────────────────────
# A pasted YouTube link is fetched with yt-dlp, converted to OGG in a SINGLE encode
# (no MP3 intermediate — YouTube's source is already lossy, so one re-encode keeps
# the most quality), and a copy is saved to YT_DOWNLOAD_DIR. The same OGG is streamed
# back to the browser and loaded directly by the mapper.
# Requires:  py -3.12 -m pip install -U yt-dlp   (reuses the existing ffmpeg).
YT_DOWNLOAD_DIR = SCRIPT_DIR.parent / 'MP3'   # …\Synthriderz mapper\MP3 (beside the app folder)
YT_MAX_DURATION = 900   # seconds — reject videos longer than 15 min (safety / not a playlist)

# ── Demucs stem separation support ───────────────────────────────────────────
# Demucs splits a song into 4 stems: drums, bass, vocals, other.
# Requires:  pip install demucs
# CUDA GPU acceleration is used automatically if torch detects an NVIDIA GPU.
# Falls back gracefully to CPU if CUDA is unavailable.

def check_demucs():
    """Return (available: bool, device: str, message: str)."""
    try:
        import torch
        import demucs  # noqa: F401 — just checking importability
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        if device == 'cuda':
            gpu_name = torch.cuda.get_device_name(0)
            return True, device, f'Demucs ready — GPU: {gpu_name}'
        return True, device, 'Demucs ready — CPU mode (no CUDA GPU detected)'
    except ImportError as e:
        missing = str(e).split("'")[1] if "'" in str(e) else str(e)
        return False, 'none', (
            f"Demucs not installed (missing: {missing}). "
            "Run:  pip install demucs  to enable stem-aware note generation."
        )
    except Exception as e:
        return False, 'none', f'Demucs check failed: {e}'


def separate_stems(audio_bytes: bytes, audio_ext: str, out_dir: str) -> dict:
    """Run Demucs htdemucs model on the supplied audio, write 4 WAV stems.

    Returns a dict:
        { 'drums': '/path/drums.wav', 'bass': '...', 'vocals': '...', 'other': '...' }

    Raises RuntimeError if Demucs is not installed or separation fails.
    """
    import torch

    available, device, msg = check_demucs()
    if not available:
        raise RuntimeError(msg)

    # Write input audio to a temp file so Demucs can read it
    in_path = os.path.join(out_dir, f'input{audio_ext}')
    with open(in_path, 'wb') as f:
        f.write(audio_bytes)

    # If not already WAV/FLAC, convert to WAV first via ffmpeg for best compatibility
    ffmpeg_cmd = find_ffmpeg()
    if audio_ext.lower() not in ('.wav', '.flac') and ffmpeg_cmd:
        wav_path = os.path.join(out_dir, 'input.wav')
        result = subprocess.run(
            [ffmpeg_cmd, '-y', '-i', in_path,
             '-ac', '2', '-ar', '44100', wav_path],
            capture_output=True
        )
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')
            raise RuntimeError(f'ffmpeg pre-conversion failed:\n{err[-1000:]}')
        in_path = wav_path

    # Run Demucs via subprocess so it uses its own process/memory space cleanly.
    # --two-stems is NOT used — we want all 4 stems.
    # --out writes stems to:  out_dir/htdemucs/<input_stem>/{drums,bass,vocals,other}.wav
    demucs_result = subprocess.run(
        [sys.executable, '-m', 'demucs',
         '-n', 'htdemucs',
         '--device', device,
         '--out', out_dir,
         in_path],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace'
    )

    if demucs_result.returncode != 0:
        raise RuntimeError(
            f'Demucs failed (exit {demucs_result.returncode}):\n'
            f'{demucs_result.stderr[-2000:]}'
        )

    # Demucs outputs to: <out_dir>/htdemucs/<basename>/{drums,bass,vocals,other}.wav
    base = Path(in_path).stem
    stem_dir = Path(out_dir) / 'htdemucs' / base
    stems = {}
    for name in ('drums', 'bass', 'vocals', 'other'):
        p = stem_dir / f'{name}.wav'
        if not p.exists():
            raise RuntimeError(f'Expected stem not found: {p}')
        stems[name] = str(p)

    print(f'  Demucs complete — stems in {stem_dir}')
    return stems


# ── Per-stem audio analysis ───────────────────────────────────────────────────
# These functions run after Demucs separation to extract musically meaningful
# events from each stem. numpy/scipy are used (installed as torch dependencies).

def load_wav_mono(wav_path: str, target_sr: int = 44100):
    """Read a WAV file and return (mono float32 array, sample_rate).
    Uses scipy.io.wavfile — always available alongside torch/demucs installs."""
    from scipy.io import wavfile
    import numpy as np
    sr, data = wavfile.read(wav_path)
    # Convert to float32 [-1, 1]
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype != np.float32:
        data = data.astype(np.float32)
    # Mix to mono
    if data.ndim == 2:
        data = data.mean(axis=1)
    # Resample to target_sr if needed (simple decimation — good enough at 44.1k→22.05k)
    if sr != target_sr:
        ratio = sr / target_sr
        new_len = int(len(data) / ratio)
        indices = (np.arange(new_len) * ratio).astype(np.int32)
        data = data[indices]
        sr = target_sr
    return data, sr


def load_wav_stereo(wav_path: str, target_sr: int = 44100):
    """Read a WAV file and return (L float32, R float32, sample_rate).
    Used for panning analysis — required since Demucs stems are stereo."""
    from scipy.io import wavfile
    import numpy as np
    sr, data = wavfile.read(wav_path)
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype != np.float32:
        data = data.astype(np.float32)
    if data.ndim == 1:
        # Mono source — duplicate to both channels
        L = R = data
    else:
        L = data[:, 0]
        R = data[:, 1] if data.shape[1] > 1 else data[:, 0]
    if sr != target_sr:
        ratio = sr / target_sr
        new_len = int(len(L) / ratio)
        indices = (np.arange(new_len) * ratio).astype(np.int32)
        L = L[indices]
        R = R[indices]
        sr = target_sr
    return L, R, sr


def rms_envelope(signal, hop: int):
    """Compute RMS energy in non-overlapping frames of size `hop`."""
    import numpy as np
    n_frames = len(signal) // hop
    frames = signal[:n_frames * hop].reshape(n_frames, hop)
    return np.sqrt((frames ** 2).mean(axis=1))


def _sliding_mean_std(arr, win):
    """Vectorized centered sliding-window mean & population std (±win each side).

    Replaces the previous O(n·win) Python double-loop with an O(n) prefix-sum
    computation. Matches numpy's default population std (ddof=0). Window at index
    i covers [max(0, i-win), min(n, i+win)] — identical bounds to the old loop.
    """
    import numpy as np
    a = np.asarray(arr, dtype=np.float64)
    n = len(a)
    if n == 0:
        return a.copy(), a.copy()
    P = np.concatenate(([0.0], np.cumsum(a)))          # prefix sum,  len n+1
    Q = np.concatenate(([0.0], np.cumsum(a * a)))      # prefix sumsq, len n+1
    idx = np.arange(n)
    lo = np.maximum(0, idx - win)
    hi = np.minimum(n, idx + win)
    count = (hi - lo).astype(np.float64)
    mean   = (P[hi] - P[lo]) / count
    meansq = (Q[hi] - Q[lo]) / count
    std = np.sqrt(np.maximum(0.0, meansq - mean * mean))
    return mean, std


# ── Per-stem onsets: peak-picked SuperFlux (2026-11-21) ──────────────────────
# The old per-stem detector (detect_onsets_np on a 10 ms RMS envelope + spectral_flux_hfc_np,
# both "first frame over local mean + kσ") was RANDOM against the beat: 10 ms RMS frames wobble
# with the waveform (bass periods are 10-20 ms), so it fired every lockout whatever the music
# did. Measured with onset_phase_lock on Demucs stems, on each song's folded grid: Electric Love
# drums R(8th, triplet, 16th) = 0.03/0.05/0.05 (noise floor 0.03). This detector picks PEAKS of
# a spectral-flux onset function instead (same stems: drums 0.39/0.99/0.35 — the song is swung).
# See handoff "2026-11-21 (cont. 5)" for the per-stem table; tests/onsets.test.mjs gates it.
STEM_ONSET_HOP = 128            # 5.8 ms frames at 22050 Hz (same as TEMPO_HOP)
STEM_ONSET_NFFT = 1024          # 46 ms: 2048 smears bass attacks (+35 ms, wide spread)
# librosa SuperFlux settings (lag 2, max filter over 3 mel bands): suppresses vibrato, which
# lifted the vocal/other lock on all 3 test songs; drums and bass are unchanged by it.
STEM_ONSET_LAG = 2
STEM_ONSET_MAX_SIZE = 3
# A peak of this onset function lags the hit by 10 ms (synthetic click/kick/snare/hat:
# +9.8..+12.0 ms). NOT the 14 ms ONSET_ENV_LATENCY: that is the FOLDED, smoothed envelope,
# whose peak sits later. Subtracted so `time` is the hit itself.
STEM_ONSET_LATENCY = 0.010
STEM_ONSET_THRESH = 1.0         # a peak must clear local mean + 1.0σ of the onset function
STEM_ONSET_WINDOW = 15.0        # ±15 s local statistics, so quiet sections still get onsets
STEM_ONSET_PEAK_HALF = 0.05     # a peak is the max within ±50 ms (or ±min_gap/2 if smaller)


def stem_onsets(signal, sr: int, min_gap_sec: float) -> list:
    """Onset times of one stem: peak-picked SuperFlux, latency-corrected.

    1. librosa onset_strength (mel, n_fft 1024, hop 128, lag 2, max_size 3, center=True).
    2. Candidates: local maxima (±STEM_ONSET_PEAK_HALF) above the local mean + STEM_ONSET_THRESH·σ
       over ±STEM_ONSET_WINDOW s.
    3. Non-maximum suppression at `min_gap_sec`, strongest first: the lockout keeps the
       strongest hit in a burst, not the first frame that crossed a threshold.
    4. time = peak frame − STEM_ONSET_LATENCY; energy = peak value / the 99th percentile of the
       stem's peak values, clipped to 1. This puts the per-stem means at 0.19-0.54, close to the
       old detector's 0.17-0.49, which buildStemDominanceMap's weights were tuned on.

    Returns [{ 'time': float (s), 'energy': float (0-1) }] in time order — the same shape as
    detect_onsets_np.
    """
    import numpy as np
    import librosa
    from scipy.ndimage import maximum_filter1d
    sig = np.asarray(signal, dtype=np.float32)
    if len(sig) < STEM_ONSET_NFFT or not np.any(sig):
        return []
    dt = STEM_ONSET_HOP / sr
    env = librosa.onset.onset_strength(y=sig, sr=sr, hop_length=STEM_ONSET_HOP,
                                       n_fft=STEM_ONSET_NFFT, lag=STEM_ONSET_LAG,
                                       max_size=STEM_ONSET_MAX_SIZE)
    mean, std = _sliding_mean_std(env, max(1, int(STEM_ONSET_WINDOW / dt)))
    half = max(1, int(round(min(STEM_ONSET_PEAK_HALF, min_gap_sec / 2) / dt)))
    is_peak = env >= maximum_filter1d(env, size=2 * half + 1, mode='nearest')
    cand = np.flatnonzero(is_peak & (env > mean + STEM_ONSET_THRESH * std) & (env > 0))
    if len(cand) == 0:
        return []
    gap = max(1, int(min_gap_sec / dt))
    taken = np.zeros(len(env) + 2 * gap + 2, dtype=bool)   # taken[j + gap] ↔ frame j kept
    keep = []
    for i in cand[np.argsort(-env[cand], kind='stable')]:
        if not taken[i + 1:i + 2 * gap].any():               # no kept frame within (i−gap, i+gap)
            keep.append(int(i))
            taken[i + gap] = True
    keep = np.sort(np.array(keep, dtype=np.int64))
    vals = env[keep]
    ref = float(np.percentile(vals, 99)) or float(vals.max()) or 1.0
    times = np.maximum(keep * dt - STEM_ONSET_LATENCY, 0.0)
    return [{'time': round(float(t), 4), 'energy': round(float(min(1.0, v / ref)), 4)}
            for t, v in zip(times, vals)]


def detect_onsets_np(env, hop_sec: float, min_gap_sec: float,
                     local_window_sec: float = 30.0):
    """LEGACY (fallback when librosa is missing): onset times from an RMS envelope using local
    flux thresholding. Random against the beat on real stems; see stem_onsets.

    Uses a ±local_window_sec sliding window to normalise threshold so quiet
    sections and loud sections are treated fairly — same approach as the JS version.
    Returns list of dicts: { 'time': float, 'energy': float (0-1 normalised) }
    """
    import numpy as np

    n = len(env)
    # Spectral flux: positive RMS derivative
    flux = np.maximum(0, np.diff(env, prepend=env[0]))

    win = int(local_window_sec / hop_sec)
    local_mean, local_std = _sliding_mean_std(flux, win)

    threshold = local_mean + local_std * 1.2

    min_gap_frames = max(1, int(min_gap_sec / hop_sec))
    peak_energy    = flux.max() if flux.max() > 0 else 1.0

    onsets = []
    last_frame = -min_gap_frames
    for i in range(n):
        if flux[i] > threshold[i] and (i - last_frame) >= min_gap_frames:
            onsets.append({
                'time':   round(float(i * hop_sec), 4),
                'energy': round(float(flux[i] / peak_energy), 4),
            })
            last_frame = i
    return onsets


def spectral_flux_hfc_np(signal, sr: int, hop_sec: float, min_gap_sec: float,
                          n_fft: int = 1024, local_window_sec: float = 30.0):
    """LEGACY (fallback when librosa is missing; superseded by stem_onsets).
    [SUGGESTION-H] HFC-weighted spectral flux onset detection.

    Computes onset strength via positive bin-wise STFT magnitude change between
    consecutive frames, weighted linearly by frequency bin (HFC = High Frequency
    Content). Catches transients the RMS envelope misses:
      • Pinch harmonics and guitar string attacks
      • Vocal consonants ('t', 'k', 's' sounds)
      • Cymbal crashes / hi-hat detail
      • Subtle melodic note onsets in sustained vocal phrases

    Use this in COMPLEMENT to detect_onsets_np (which uses RMS). Then merge with
    merge_onsets() to get a richer combined onset set.

    Returns list of dicts: { 'time': float, 'energy': float (0–1 normalised) }.

    Adjustable: n_fft (1024 default = ~46ms at 22.05kHz; 2048 = more freq detail).
    """
    import numpy as np

    hop = max(1, int(sr * hop_sec))
    n_signal = len(signal)
    if n_signal < n_fft + hop:
        return []
    n_frames = (n_signal - n_fft) // hop + 1
    if n_frames < 4:
        return []

    window = np.hanning(n_fft).astype(np.float32)
    n_bins = n_fft // 2 + 1
    # Linear HFC weight: bin 0 → 0, bin n-1 → 1. Emphasises high-frequency change.
    freq_weight = np.arange(n_bins, dtype=np.float32) / max(n_bins - 1, 1)

    # Vectorized STFT: build all frames as a strided view, window them, then run a
    # single batched rFFT instead of a per-frame Python loop. flux[i] is the
    # HFC-weighted half-wave-rectified magnitude change from frame i-1 → i.
    from numpy.lib.stride_tricks import sliding_window_view
    sig = np.asarray(signal, dtype=np.float32)
    frames = sliding_window_view(sig, n_fft)[::hop][:n_frames] * window  # (n_frames, n_fft)
    mags   = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)       # (n_frames, n_bins)
    diff   = np.maximum(0.0, mags[1:] - mags[:-1])                        # (n_frames-1, n_bins)
    flux = np.zeros(n_frames, dtype=np.float32)
    flux[1:] = (diff * freq_weight).sum(axis=1)                           # frame 0 stays 0

    if flux.max() <= 0:
        return []

    # Local mean + std thresholding (vectorized prefix-sum, same window bounds).
    win = max(1, int(local_window_sec / hop_sec))
    local_mean, local_std = _sliding_mean_std(flux, win)
    # Slightly stricter coefficient (1.5 vs 1.2 in RMS path) since spectral flux is noisier
    threshold = local_mean + local_std * 1.5

    min_gap_frames = max(1, int(min_gap_sec / hop_sec))
    peak = float(flux.max())

    onsets = []
    last_frame = -min_gap_frames
    for i in range(n_frames):
        if flux[i] > threshold[i] and (i - last_frame) >= min_gap_frames:
            onsets.append({
                'time':   round(float(i * hop_sec), 4),
                'energy': round(float(flux[i] / peak), 4),
            })
            last_frame = i
    return onsets


def merge_onsets(onsets_a: list, onsets_b: list, min_gap_sec: float) -> list:
    """[SUGGESTION-H] Merge two onset lists, dedup within min_gap_sec.

    When two onsets fall within min_gap_sec of each other, keep the higher-energy one.
    Used to combine RMS-based and spectral-flux-based onsets without double-counting.
    """
    combined = sorted(list(onsets_a) + list(onsets_b), key=lambda o: o['time'])
    merged = []
    for o in combined:
        if merged and (o['time'] - merged[-1]['time']) < min_gap_sec:
            if o['energy'] > merged[-1]['energy']:
                merged[-1] = o
            continue
        merged.append(o)
    return merged


def detect_sustained_regions_np(env, hop_sec: float, threshold: float,
                                 min_sec: float = 0.3, max_sec: float = 8.0,
                                 gap_sec: float = 0.0):
    """Find time ranges where energy stays above threshold continuously.

    gap_sec: bridge dips below threshold shorter than this duration.
             Vocal consonants/breath pauses (50–200 ms) would otherwise
             fragment one phrase into many discarded micro-regions.

    Returns list of { 'start': float, 'end': float, 'energy': float }.
    """
    regions    = []
    min_frames = int(min_sec / hop_sec)
    max_frames = int(max_sec / hop_sec)
    gap_frames = int(gap_sec / hop_sec)
    peak_energy = env.max() if env.max() > 0 else 1.0
    n = len(env)

    in_region   = False
    start_frame = 0
    gap_start   = -1   # first frame of a below-threshold dip (-1 = not in a gap)

    def _close(end_frame):
        dur = end_frame - start_frame
        if dur < min_frames:
            return
        cs = start_frame
        while cs < end_frame:
            ce     = min(cs + max_frames, end_frame)
            mean_e = float(env[cs:ce].mean()) / peak_energy
            regions.append({
                'start':  round(float(cs * hop_sec), 4),
                'end':    round(float(ce * hop_sec), 4),
                'energy': round(mean_e, 4),
            })
            cs = ce

    for i, val in enumerate(env):
        above = val >= threshold
        if above:
            if not in_region:
                in_region   = True
                start_frame = i
            gap_start = -1          # clear any pending gap
        else:
            if in_region:
                if gap_start == -1:
                    gap_start = i   # start tracking the dip
                elif (i - gap_start) > gap_frames:
                    # Dip exceeded tolerance — close region at dip start
                    _close(gap_start)
                    in_region = False
                    gap_start = -1

    # End of signal
    if in_region:
        _close(gap_start if gap_start != -1 else n)

    return regions


def estimate_pitch_row(signal, sr: int, time_sec: float,
                       window_sec: float = 0.05) -> int:
    """Rough pitch estimate at `time_sec` → row 0 (high) … 7 (low).

    Uses autocorrelation on a short window. Pitch range 80–1200 Hz mapped
    logarithmically to rows 0–7. Returns 3 (mid) on failure."""
    import numpy as np

    start = int(time_sec * sr)
    end   = min(start + int(window_sec * sr), len(signal))
    frame = signal[start:end]
    if len(frame) < 64:
        return 3

    # Zero-mean
    frame = frame - frame.mean()
    # Autocorrelation via FFT
    fft   = np.fft.rfft(frame, n=len(frame) * 2)
    acorr = np.fft.irfft(fft * np.conj(fft))[:len(frame)]
    acorr[0] = 0  # suppress zero-lag peak

    # Search for peak within 80–1200 Hz lag range
    min_lag = max(1, int(sr / 1200))
    max_lag = int(sr / 80)
    if max_lag >= len(acorr):
        return 3
    peak_lag = int(np.argmax(acorr[min_lag:max_lag])) + min_lag
    if peak_lag == 0:
        return 3

    freq = sr / peak_lag
    # Map 80–1200 Hz log-scale to rows 0 (high) … 7 (low)
    import math
    log_min, log_max = math.log(80), math.log(1200)
    log_freq = max(log_min, min(log_max, math.log(freq)))
    # High freq → low row index (row 0 = top of screen = high pitch)
    row = round(7 * (1 - (log_freq - log_min) / (log_max - log_min)))
    return max(0, min(7, row))


def classify_drum_hit(signal, sr: int, time_sec: float,
                      window_sec: float = 0.04) -> str:
    """Classify a drum onset as 'kick', 'snare', or 'hat' using spectral centroid.

    Kick:  centroid < 200 Hz  (low thud)
    Snare: centroid 200–2000 Hz (mid crack)
    Hat:   centroid > 2000 Hz  (high sizzle)
    """
    import numpy as np

    start = int(time_sec * sr)
    end   = min(start + int(window_sec * sr), len(signal))
    frame = signal[start:end]
    if len(frame) < 16:
        return 'snare'

    spectrum = np.abs(np.fft.rfft(frame))
    freqs    = np.fft.rfftfreq(len(frame), d=1.0 / sr)
    denom    = spectrum.sum()
    centroid = float((spectrum * freqs).sum() / denom) if denom > 0 else 500.0

    if centroid < 200:
        return 'kick'
    elif centroid < 2000:
        return 'snare'
    else:
        return 'hat'


def analyse_stems(stems: dict, bpm: float, enabled_stems: dict | None = None,
                  pad_secs: float = 0.0) -> dict:
    """Run per-stem onset detection and return structured analysis JSON.

    stems:         { 'drums': path, 'bass': path, 'vocals': path, 'other': path }
    bpm:           song BPM (used for minimum gap between onsets)
    enabled_stems: { 'drums': bool, 'bass': bool, 'vocals': bool, 'other': bool }
                   When a stem is False its onset/region detection is skipped
                   (Demucs always produces all 4 stems; this just avoids processing).
    pad_secs:      beat-1 pad (the app's audioPadSecs): this much silence is prepended to every
                   stem signal, so onsets, regions, duration and the per-beat energy/panning
                   curves all come back on the map clock (the same silence /export adds).

    Returns the Phase 2 JSON structure consumed by extractNoteEvents in Phase 4.
    """
    import numpy as np

    if enabled_stems is None:
        enabled_stems = {'drums': True, 'bass': True, 'vocals': True, 'other': True}

    SR       = 22050   # downsample target — half of 44.1k, fast, sufficient
    HOP_SEC  = 0.01    # 10ms frames
    HOP      = int(SR * HOP_SEC)
    beat_sec = 60.0 / bpm
    pad_n    = max(0, int(round(float(pad_secs or 0.0) * SR)))

    def _lead(sig):
        """Prepend the beat-1 pad (zeros) to a signal."""
        return np.concatenate([np.zeros(pad_n, dtype=sig.dtype), sig]) if pad_n else sig

    if pad_n:
        print(f'  Beat-1 pad: {pad_n / SR:.3f}s of silence before every stem')

    # Onsets: peak-picked SuperFlux per stem (stem_onsets). The lockouts are the old ones (in
    # beats), now applied as non-maximum suppression. Without librosa, fall back to the legacy
    # RMS (+HFC) detectors, which are random against the beat.
    try:
        import librosa  # noqa: F401
        legacy = False
    except ImportError:
        legacy = True
        print('  WARNING: librosa missing: legacy RMS onsets (not beat-locked). pip install librosa')

    def _onsets(sig, gap_beats, hfc=False):
        if not legacy:
            return stem_onsets(sig, SR, beat_sec * gap_beats)
        env = rms_envelope(sig, HOP)
        rms = detect_onsets_np(env, HOP_SEC, beat_sec * gap_beats)
        if not hfc:
            return rms
        return merge_onsets(rms, spectral_flux_hfc_np(sig, SR, HOP_SEC, beat_sec * gap_beats),
                            beat_sec * 0.25)

    result_stems = {}

    # ── Drums ────────────────────────────────────────────────────────────────
    drums_sig, _ = load_wav_mono(stems['drums'], SR)
    drums_sig = _lead(drums_sig)
    if enabled_stems.get('drums', True):
        print('  Analysing drums stem…')
        raw_onsets   = _onsets(drums_sig, 0.25)
        drums_onsets = []
        for o in raw_onsets:
            subtype = classify_drum_hit(drums_sig, SR, o['time'])
            drums_onsets.append({**o, 'subtype': subtype})
        result_stems['drums'] = {'onsets': drums_onsets}
    else:
        print('  Skipping drums stem (disabled).')
        result_stems['drums'] = {'onsets': []}

    # ── Bass ─────────────────────────────────────────────────────────────────
    bass_sig, _ = load_wav_mono(stems['bass'], SR)
    bass_sig = _lead(bass_sig)
    if enabled_stems.get('bass', True):
        print('  Analysing bass stem…')
        bass_env     = rms_envelope(bass_sig, HOP)
        bass_thresh  = bass_env.max() * 0.12
        bass_regions = detect_sustained_regions_np(
            bass_env, HOP_SEC, bass_thresh,
            min_sec=beat_sec * 0.5, max_sec=beat_sec * 20)
        bass_onsets  = _onsets(bass_sig, 0.4)
        result_stems['bass'] = {'regions': bass_regions, 'onsets': bass_onsets}
    else:
        print('  Skipping bass stem (disabled).')
        result_stems['bass'] = {'regions': [], 'onsets': []}

    # ── Vocals ───────────────────────────────────────────────────────────────
    # SuperFlux (stem_onsets) catches consonants and soft vocal attacks; it replaced the old
    # RMS + HFC-flux merge ([SUGGESTION-H]), which was random against the beat.
    vox_sig, _ = load_wav_mono(stems['vocals'], SR)
    vox_sig = _lead(vox_sig)
    if enabled_stems.get('vocals', True):
        print('  Analysing vocals stem…')
        vox_onsets_raw  = _onsets(vox_sig, 0.5, hfc=True)
        vox_onsets = []
        for o in vox_onsets_raw:
            pitch_row = estimate_pitch_row(vox_sig, SR, o['time'])
            vox_onsets.append({**o, 'pitch_row': pitch_row})
        result_stems['vocals'] = {'onsets': vox_onsets, 'regions': []}  # regions filled below
    else:
        print('  Skipping vocals stem (disabled).')
        result_stems['vocals'] = {'onsets': [], 'regions': []}

    # ── Other / synth ────────────────────────────────────────────────────────
    # Guitars / synths: SuperFlux catches pinch harmonics and string attacks (it replaced the
    # old RMS + HFC-flux merge).
    other_sig, _ = load_wav_mono(stems['other'], SR)
    other_sig = _lead(other_sig)
    if enabled_stems.get('other', True):
        print('  Analysing other stem…')
        other_onsets      = _onsets(other_sig, 0.4, hfc=True)
        result_stems['other'] = {'onsets': other_onsets, 'regions': []}  # regions filled below
    else:
        print('  Skipping other stem (disabled).')
        result_stems['other'] = {'onsets': [], 'regions': []}
    print('    onsets ' + ('(LEGACY RMS)' if legacy else '(SuperFlux peaks)') + ': '
          + ', '.join(f"{k} {len(v['onsets'])}" for k, v in result_stems.items()))

    # ── Combined melodic sustained-region detection (vocals + other) ─────────
    # Analysing each stem independently fragments phrases: a 200ms consonant gap
    # in vocals breaks what is musically one held phrase into discarded micro-regions.
    # Mixing the two melodic stems before detection raises the combined RMS so more
    # regions clear the threshold, and covers gaps in one stem with the other's energy.
    # gap_sec=0.15 additionally bridges brief dips (consonants, breath pauses).
    #
    # Regions are assigned to VOCALS only (not shared with other).
    # Sharing with other would double-count region energy in buildStemDominanceMap
    # (each stem contributes 0.35 × energy per beat), flipping drum-dominant windows
    # to melodic-dominant and misaligning the critic's stem adherence scoring.
    # Other gets its own individual region detection below with gap_sec bridging applied.
    if enabled_stems.get('vocals', True):
        print('  Detecting combined melodic sustained regions (→ vocals)…')
        mel_len = min(len(vox_sig), len(other_sig))
        melodic_sig = vox_sig[:mel_len] * 0.5 + other_sig[:mel_len] * 0.5
        mel_peak = float(np.abs(melodic_sig).max())
        if mel_peak > 0:
            melodic_sig = melodic_sig / mel_peak * 0.9
        melodic_env    = rms_envelope(melodic_sig, HOP)
        melodic_thresh = melodic_env.max() * 0.12
        melodic_regions = detect_sustained_regions_np(
            melodic_env, HOP_SEC, melodic_thresh,
            min_sec=beat_sec * 0.5, max_sec=beat_sec * 20,
            gap_sec=0.15)
        print(f'    → {len(melodic_regions)} melodic regions detected')
        result_stems['vocals']['regions'] = melodic_regions

    # Other stem: individual region detection with the same gap_sec bridging so
    # guitar/synth phrases aren't fragmented, but using its own signal so it
    # contributes independently to buildStemDominanceMap.
    if enabled_stems.get('other', True):
        other_env_for_regions = rms_envelope(other_sig, HOP)
        other_regions = detect_sustained_regions_np(
            other_env_for_regions, HOP_SEC, other_env_for_regions.max() * 0.15,
            min_sec=beat_sec * 0.5, max_sec=beat_sec * 20,
            gap_sec=0.15)
        result_stems['other']['regions'] = other_regions
        print(f'    → {len(other_regions)} other/guitar regions detected')

    # ── Full-mix energy curve (per beat) ─────────────────────────────────────
    # Equal-weight mix of all 4 stems. A percussion-weighted mix would make the
    # energy curve more percussion-representative, but energyAt() is also used as
    # a gate for rail synthesis (> 0.35 threshold in onsetsToNotes). Percussion
    # weighting would suppress that gate in melodic-only sections, preventing rails
    # from forming precisely where they are most needed.
    print('  Computing energy curve…')
    # Use max_len so the energy curve and duration cover the full audio.
    # Demucs can output stems of slightly different lengths (rounding / conv padding);
    # shorter stems are zero-padded so no audio window is silently dropped.
    stem_lengths = [len(drums_sig), len(bass_sig), len(vox_sig), len(other_sig)]
    max_len = max(stem_lengths)
    min_len = min(stem_lengths)
    if min_len < max_len:
        ratio_pct = round(min_len / max_len * 100, 1)
        print(f'  WARNING: stem length mismatch ({ratio_pct}%) — padding shorter stems to {max_len/SR:.1f}s')
    def _pad(sig, length):
        if len(sig) >= length: return sig[:length]
        return np.pad(sig, (0, length - len(sig)))
    mix     = (_pad(drums_sig, max_len) + _pad(bass_sig, max_len) +
               _pad(vox_sig,  max_len) + _pad(other_sig, max_len)) * 0.25
    duration = max_len / SR

    num_beats    = int(np.ceil(duration / beat_sec))
    energy_curve = []
    for b in range(num_beats):
        # Beat b spans [b, b+1)*beat_sec, rounded per beat. The old fixed int(beat_sec*SR) step
        # lost up to a sample a beat, so late beats' windows slid early.
        s = int(round(b * beat_sec * SR))
        e = min(int(round((b + 1) * beat_sec * SR)), len(mix))
        rms = float(np.sqrt((mix[s:e] ** 2).mean())) if e > s else 0.0
        energy_curve.append(round(rms, 5))
    # Normalise to [0, 1]
    ec_max = max(energy_curve) if energy_curve else 1.0
    if ec_max > 0:
        energy_curve = [round(v / ec_max, 4) for v in energy_curve]

    # ── Per-beat panning curve ────────────────────────────────────────────────
    # Panning [-1 (full left) .. +1 (full right)] per beat, computed from the
    # 'other' stem (guitar/synth) which carries most stereo image information
    # in modern productions. Drums are typically center-panned and don't
    # discriminate hand bias well.
    panning_by_beat = []
    try:
        L, R, _ = load_wav_stereo(stems['other'], SR)
        L, R = _lead(L), _lead(R)
        for b in range(num_beats):
            s = int(round(b * beat_sec * SR))
            e = min(int(round((b + 1) * beat_sec * SR)), min(len(L), len(R)))
            if e <= s:
                panning_by_beat.append(0.0)
                continue
            # Pan = (R_energy - L_energy) / (R_energy + L_energy + epsilon)
            l_rms = float(np.sqrt((L[s:e] ** 2).mean()))
            r_rms = float(np.sqrt((R[s:e] ** 2).mean()))
            pan = (r_rms - l_rms) / (r_rms + l_rms + 1e-6)
            panning_by_beat.append(round(max(-1.0, min(1.0, pan)), 4))
    except Exception as ex:
        print(f"  Panning analysis failed: {ex} — defaulting to 0")
        panning_by_beat = [0.0] * num_beats

    return {
        'duration':        round(duration, 3),
        'stems':           result_stems,
        'energy_curve':    energy_curve,
        'panning_by_beat': panning_by_beat,
    }


def make_ntfs_extra() -> bytes:
    """Build a 36-byte NTFS extra field (tag 0x000a) with current timestamps.
    Required by the Quest SynthRiders audio loader."""
    import time as _t
    # Windows FILETIME: 100-ns intervals since 1601-01-01
    ft = int(_t.time() * 10_000_000) + 116_444_736_000_000_000
    ft_bytes = struct.pack('<Q', ft)
    # tag(2) + data_size(2) + reserved(4) + attr_tag(2) + attr_size(2) + mtime+atime+ctime(24)
    return struct.pack('<HHI', 0x000a, 32, 0) + struct.pack('<HH', 1, 24) + ft_bytes * 3


def build_synth_zip(entries: list) -> bytes:
    """Build a .synth ZIP file manually, avoiding Python zipfile quirks.

    entries: list of (filename: str, data: bytes)
    Produces compress_type=8 (DEFLATE), flag_bits=0x0800, mtime=0, mdate=0,
    and a 36-byte NTFS extra field on every entry — matching the Quest loader
    requirements confirmed by binary testing.
    """
    import zlib as _zlib
    ntfs = make_ntfs_extra()

    def deflate(raw: bytes) -> bytes:
        return _zlib.compress(raw, 6)[2:-4]  # strip zlib header/trailer → raw DEFLATE

    buf = bytearray()
    central_dir = []

    for fname, raw_data in entries:
        fname_bytes  = fname.encode('utf-8')
        cdata        = deflate(raw_data)
        crc          = _zlib.crc32(raw_data) & 0xFFFFFFFF
        local_offset = len(buf)

        # Local file header (30 bytes fixed)
        buf += b'PK\x03\x04'
        buf += struct.pack('<H', 20)        # version needed
        buf += struct.pack('<H', 0x0800)    # flag: UTF-8
        buf += struct.pack('<H', 8)         # compression: DEFLATE
        buf += struct.pack('<H', 0)         # mod time
        buf += struct.pack('<H', 0)         # mod date
        buf += struct.pack('<I', crc)
        buf += struct.pack('<I', len(cdata))
        buf += struct.pack('<I', len(raw_data))
        buf += struct.pack('<H', len(fname_bytes))
        buf += struct.pack('<H', len(ntfs))
        buf += fname_bytes
        buf += ntfs
        buf += cdata

        # Central directory entry (46 bytes fixed)
        cd = bytearray()
        cd += b'PK\x01\x02'
        cd += struct.pack('<H', 20)         # version made by
        cd += struct.pack('<H', 20)         # version needed
        cd += struct.pack('<H', 0x0800)     # flag: UTF-8
        cd += struct.pack('<H', 8)          # compression: DEFLATE
        cd += struct.pack('<H', 0)          # mod time
        cd += struct.pack('<H', 0)          # mod date
        cd += struct.pack('<I', crc)
        cd += struct.pack('<I', len(cdata))
        cd += struct.pack('<I', len(raw_data))
        cd += struct.pack('<H', len(fname_bytes))
        cd += struct.pack('<H', len(ntfs))  # extra len
        cd += struct.pack('<H', 0)          # comment len
        cd += struct.pack('<H', 0)          # disk start
        cd += struct.pack('<H', 0)          # internal attrs
        cd += struct.pack('<I', 0)          # external attrs
        cd += struct.pack('<i', local_offset)
        cd += fname_bytes
        cd += ntfs
        central_dir.append(bytes(cd))

    # Central directory + EOCD
    cd_offset = len(buf)
    for cd in central_dir:
        buf += cd
    cd_size = len(buf) - cd_offset

    buf += b'PK\x05\x06'
    buf += struct.pack('<H', 0)             # disk number
    buf += struct.pack('<H', 0)             # disk with CD start
    buf += struct.pack('<H', len(central_dir))
    buf += struct.pack('<H', len(central_dir))
    buf += struct.pack('<I', cd_size)
    buf += struct.pack('<I', cd_offset)
    buf += struct.pack('<H', 0)             # comment len

    return bytes(buf)


def find_ffmpeg():
    """Return the ffmpeg command to use, checking common Windows locations."""
    import shutil
    # First try PATH (works on all platforms)
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    # Common Windows locations
    windows_paths = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
    ]
    for path in windows_paths:
        if os.path.exists(path):
            return path
    return None

def check_ffmpeg():
    return find_ffmpeg() is not None


# Seconds of silence prepended to every exported / converted audio file.
# Must match the value used by the HTML client when computing Offset.
INTRO_SILENCE_SECS = 0.0  # silence feature removed — kept as zero for convert_to_ogg call sites


def ogg_vorbis_duration(data: bytes) -> float:
    """Parse OGG Vorbis duration directly from raw bytes — no external tools needed."""
    # Read sample rate from Vorbis identification header (\x01vorbis)
    sample_rate = 0
    idx = data.find(b'\x01vorbis')
    if idx >= 0 and idx + 16 < len(data):
        # Vorbis ID header: \x01(1) + "vorbis"(6) + version(4) + channels(1) + sample_rate(4)
        # sample_rate starts at idx+12, not idx+11 (idx+11 is the channels byte)
        sample_rate = struct.unpack_from('<I', data, idx + 12)[0]
    if not sample_rate:
        return 0.0
    # Scan last 65 KB for the final OggS page and read its granule position
    search = data[max(0, len(data) - 65536):]
    last_granule = 0
    pos = len(search) - 4
    while pos >= 0:
        if search[pos:pos + 4] == b'OggS' and pos + 14 <= len(search):
            granule = struct.unpack_from('<q', search, pos + 6)[0]
            if granule > 0:
                last_granule = granule
                break
        pos -= 1
    return last_granule / sample_rate if last_granule > 0 else 0.0


def convert_to_ogg(input_bytes: bytes, input_ext: str, silence_secs: float = 0.0,
                   clip_start: float = 0.0, clip_end: float = 0.0) -> bytes:
    """Convert audio bytes to OGG Vorbis using ffmpeg.

    silence_secs: if > 0, prepend that many seconds of silence before the audio.
                  Uses ffmpeg concat (not adelay) so output duration is extended correctly.
    clip_start:   if > 0, trim this many seconds from the start of the source audio.
    clip_end:     if > 0, stop at this many seconds from the start of the source audio.
                  0 means keep to end of file.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        in_path  = os.path.join(tmpdir, f"input{input_ext}")
        out_path = os.path.join(tmpdir, "output.ogg")

        with open(in_path, "wb") as f:
            f.write(input_bytes)

        ffmpeg_cmd = find_ffmpeg() or "ffmpeg"

        # Input seek args for clipping (applied to the audio input, not the silence source)
        seek_args = []
        if clip_start > 0:
            seek_args += ["-ss", str(round(clip_start, 3))]
        if clip_end > 0:
            seek_args += ["-to", str(round(clip_end, 3))]

        if silence_secs > 0:
            # Prepend silence using concat with anullsrc.
            # NOTE: adelay does NOT extend output duration — it shifts samples within the
            # existing time window, truncating the tail. concat is the correct approach.
            pad_samples = int(round(silence_secs * 44100))
            cmd = [
                ffmpeg_cmd, "-y",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                *seek_args, "-i", in_path,
                # exact pad length in samples; music resampled to the silence's format first
                "-filter_complex",
                f"[0:a]atrim=end_sample={pad_samples},aformat=sample_fmts=fltp:channel_layouts=stereo[pad];"
                "[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[mus];"
                "[pad][mus]concat=n=2:v=0:a=1[out]",
                "-map", "[out]",
                "-c:a", "libvorbis",
                "-q:a", "4",
                "-ar", "44100",
                "-ac", "2",
                out_path,
            ]
        else:
            cmd = [
                ffmpeg_cmd, "-y",
                *seek_args, "-i", in_path,
                "-c:a", "libvorbis",
                "-q:a", "4",
                "-ar", "44100",
                "-ac", "2",
                out_path,
            ]

        result = subprocess.run(cmd, capture_output=True)

        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"ffmpeg failed:\n{err[-2000:]}")

        with open(out_path, "rb") as f:
            return f.read()


def check_ytdlp():
    """Return (available: bool, message: str) for yt-dlp importability."""
    try:
        import yt_dlp  # noqa: F401
        return True, f'yt-dlp ready (v{yt_dlp.version.__version__})'
    except Exception:
        return False, ('yt-dlp not installed — YouTube import disabled. '
                       'Run:  py -3.12 -m pip install -U yt-dlp')


def _safe_filename(name: str) -> str:
    """Strip characters illegal in Windows filenames; cap length."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', name or '').strip().strip('.')
    return (name or 'youtube_audio')[:120]


def _ensure_deno_on_path() -> bool:
    """Make sure a Deno JS runtime is reachable for yt-dlp.

    yt-dlp needs a JS runtime + the EJS solver to solve YouTube's signature / n
    challenges reliably (without it some videos are slow or missing formats). winget
    installs Deno but only updates the *user* PATH — a server process that was already
    running won't have picked that up. So if 'deno' isn't resolvable, glob the winget
    package dir (its name is version-independent) and prepend it to THIS process's PATH.
    Returns True if deno is now resolvable."""
    import shutil, glob as _glob
    if shutil.which('deno'):
        return True
    local = os.environ.get('LOCALAPPDATA', '')
    if local:
        hits = _glob.glob(os.path.join(local, 'Microsoft', 'WinGet', 'Packages',
                                       'DenoLand.Deno_*', 'deno.exe'))
        if hits:
            os.environ['PATH'] = os.path.dirname(hits[0]) + os.pathsep + os.environ.get('PATH', '')
            return True
    return False


def download_youtube_audio(url: str):
    """Fetch the best audio track for a YouTube (or yt-dlp-supported) URL, convert to
    OGG once via convert_to_ogg (the SAME tested encoder /convert uses), and save a
    copy to YT_DOWNLOAD_DIR.

    yt-dlp downloads the raw bestaudio stream (no re-encode); convert_to_ogg does the
    single encode to OGG Vorbis (q4 / 44.1k / stereo) — so the file is byte-identical in
    format to an uploaded-and-converted song, and the rest of the pipeline / Quest loader
    sees exactly what they already handle.

    Returns (ogg_bytes: bytes, title: str, artist: str, saved_path: str).
    Raises RuntimeError on any download/convert failure.
    """
    import glob as _glob
    _ensure_deno_on_path()  # let yt-dlp find Deno for reliable challenge solving
    with tempfile.TemporaryDirectory() as tmpdir:
        out_tmpl = os.path.join(tmpdir, 'dl.%(ext)s')
        cmd = [
            sys.executable, '-m', 'yt_dlp',
            '--no-playlist', '--no-progress',
            # EJS challenge solver (needs a JS runtime, i.e. Deno) — clears YouTube's
            # signature/n-challenge warnings so no audio formats go missing. Downloaded
            # once from the yt-dlp GitHub then cached. Harmless if Deno is absent.
            '--remote-components', 'ejs:github',
            '-f', 'bestaudio/best',
            '--write-info-json',
            '-o', out_tmpl,
            url,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding='utf-8', errors='replace')
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or '')[-1500:]
            raise RuntimeError(
                f'yt-dlp failed:\n{tail}\n\n'
                'If this is a format/"video unavailable" error, YouTube may have changed '
                '— update yt-dlp:  py -3.12 -m pip install -U yt-dlp')

        # Read the info JSON (metadata) and locate the downloaded audio file.
        info = {}
        info_path = os.path.join(tmpdir, 'dl.info.json')
        if os.path.exists(info_path):
            try:
                info = json.loads(Path(info_path).read_text('utf-8'))
            except Exception:
                info = {}

        audio_files = [p for p in _glob.glob(os.path.join(tmpdir, 'dl.*'))
                       if not p.endswith('.info.json')]
        if not audio_files:
            raise RuntimeError('yt-dlp produced no audio file (unexpected).')
        src     = audio_files[0]
        src_ext = os.path.splitext(src)[1].lower() or '.webm'

        duration = float(info.get('duration') or 0)
        if duration and duration > YT_MAX_DURATION:
            raise RuntimeError(
                f'Video is {int(duration // 60)}m {int(duration % 60)}s — exceeds the '
                f'{YT_MAX_DURATION // 60}-minute limit. Trim it or raise YT_MAX_DURATION in server.py.')

        # Single encode: raw stream → OGG Vorbis (same path as an uploaded file).
        raw = Path(src).read_bytes()
        ogg_bytes = convert_to_ogg(raw, src_ext)

        # Metadata — prefer YouTube Music's structured track/artist, fall back to
        # title/uploader. Strip the " - Topic" suffix YT auto-channels append.
        title  = (info.get('track') or info.get('title') or 'YouTube Audio').strip()
        artist = (info.get('artist') or info.get('uploader') or '').strip()
        artist = re.sub(r'\s*-\s*Topic$', '', artist).strip()

        # Save a copy to the user's archive folder (created if missing), avoiding overwrite.
        YT_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        base  = _safe_filename(f'{artist} - {title}' if artist else title)
        saved = YT_DOWNLOAD_DIR / f'{base}.ogg'
        n = 1
        while saved.exists():
            saved = YT_DOWNLOAD_DIR / f'{base} ({n}).ogg'
            n += 1
        saved.write_bytes(ogg_bytes)

        return ogg_bytes, title, artist, str(saved)


# ── Tempo refinement (epoch folding) ──────────────────────────────────────────
# librosa's beat_track tempo is a LAG BIN, 60·sr/(hop·lag): near 100-120 BPM neighbouring
# bins are 4-5% apart, so a 120-BPM song reads 117.45 and the snap grid slides ~9 beats over
# the song. A line fit through the tracked beats (tried 2026-11-21) is still pulled toward
# the tracker's starting bin: Nobody Speak fitted 161.56 where the music is 160.01.
# Epoch folding is what works. Fold the onset envelope modulo each candidate period and keep
# the period whose folded profile has the tallest peak. That uses every frame of the song,
# so the period is good to ~0.01 BPM on a studio track. Each quarter of the song, folded on
# its own, then lands on the same phase to within ±0.04 beat (it drifts a full beat at the
# old values).
TEMPO_HOP = 128                 # onset-envelope hop at 22050 Hz → 5.8 ms frames
TEMPO_FOLD_BINS = 48            # phase bins per period for the period search
TEMPO_PHASE_BINS = 96           # finer bins for the final phase / per-quarter drift
# Folded onset_strength(center=True, hop 128) peaks ~14 ms AFTER a click onset (synthetic
# click tracks at 89-172 BPM, 2026-11-21: 14.2 ± 0.3 ms; tests/tempo.test.mjs guards it).
# Subtracted so `phase` is the beat onset itself.
ONSET_ENV_LATENCY = 0.014


def _fold_profile(env, t, period: float, nbins: int = TEMPO_FOLD_BINS):
    """Mean onset strength per phase bin when `env` (sampled at times `t`) is folded
    modulo `period`."""
    import numpy as np
    b = np.floor((t % period) * (nbins / period)).astype(np.int64) % nbins
    s = np.bincount(b, weights=env, minlength=nbins)
    c = np.bincount(b, minlength=nbins)
    return s / np.maximum(c, 1)


def _profile_peak_phase(prof, period: float) -> float:
    """Phase (s, in [0, period)) of the folded profile's peak, with parabolic sub-bin
    interpolation (circular neighbours)."""
    import numpy as np
    n = len(prof)
    j = int(np.argmax(prof))
    y0, y1, y2 = prof[(j - 1) % n], prof[j], prof[(j + 1) % n]
    den = y0 - 2 * y1 + y2
    d = 0.5 * (y0 - y2) / den if den < 0 else 0.0
    return float(((j + 0.5 + d) / n * period) % period)


def _smooth_env(env):
    """~9 ms Gaussian smoothing so a folded onset peak is not split across bins."""
    import numpy as np
    from scipy.ndimage import gaussian_filter1d
    return gaussian_filter1d(np.asarray(env, dtype=float), 1.5)


def _lattice_fit(env_s, t, period: float) -> dict:
    """Phase (latency-corrected), per-quarter drift and confidence of a FIXED beat period."""
    import numpy as np
    prof = _fold_profile(env_s, t, period, TEMPO_PHASE_BINS)
    phase = _profile_peak_phase(prof, period)
    drift = []
    for idx in np.array_split(np.arange(len(env_s)), 4):
        if len(idx) < 8:
            continue
        q = _profile_peak_phase(_fold_profile(env_s[idx], t[idx], period, TEMPO_PHASE_BINS), period)
        drift.append(round(float(((q - phase) / period + 0.5) % 1.0 - 0.5), 3))
    mean = float(env_s.mean()) or 1.0
    return {'phase': (phase - ONSET_ENV_LATENCY) % period, 'drift': drift,
            'confidence': float(prof.max()) / mean}


def lattice_phase(env, dt: float, bpm: float) -> dict:
    """Where the music's beats sit on a GIVEN tempo's lattice (no tempo search).

    Returns {phase, drift, confidence} as fold_tempo does, for `bpm` as given. Used by
    validate.py --timing to measure an exported map's grid against its own audio: phase ≈ 0
    means the map's integer beats are the music's beats, and a drift trend means its BPM is off.
    """
    import numpy as np
    env_s = _smooth_env(env)
    return _lattice_fit(env_s, np.arange(len(env_s)) * dt, 60.0 / bpm)


def fold_tempo(env, dt: float, bpm_guess: float, span: float = 0.05) -> dict:
    """Refine a tempo estimate by epoch-folding an onset envelope.

    env:       onset-strength envelope (any positive onset function), one value per frame
    dt:        frame period (s)
    bpm_guess: the octave to search (e.g. librosa's lag-bin tempo); the search covers
               ±span (default ±5% = more than half a lag bin up to ~200 BPM)

    Returns {bpm, phase, confidence, drift}:
      bpm        refined tempo (BPM)
      phase      time (s) of the first beat-lattice point, in [0, 60/bpm): beats sit at
                 phase + k·60/bpm. Latency-corrected (ONSET_ENV_LATENCY).
      confidence folded-profile peak / mean onset strength. A steady studio beat scores
                 ~2.5-3; ~1.0-1.1 means no lattice fits (a wrong period scores that too).
      drift      each quarter of the song folded on its own: its phase minus the global
                 phase, in beats, in [-0.5, 0.5). Flat ≈ steady tempo; a trend = the song
                 speeds up or slows down (live recordings); a lone ±0.5 = that quarter's
                 accents sit on the off-beats (Painkiller's drum intro).
    """
    import numpy as np
    env = _smooth_env(env)
    t = np.arange(len(env)) * dt
    dur = max(len(env) * dt, 1.0)
    mean = float(env.mean()) or 1.0

    def score(bpm):
        return float(_fold_profile(env, t, 60.0 / bpm).max()) / mean

    # The comb peak's half-width is ~0.1 beat of total drift: Δbpm ≈ 6/dur. Step at half of it.
    step = 3.0 / max(dur, 30.0)
    grid = np.arange(bpm_guess * (1 - span), bpm_guess * (1 + span), step)
    coarse = np.array([score(b) for b in grid])
    b0 = float(grid[int(np.argmax(coarse))])
    fine = np.arange(b0 - 2 * step, b0 + 2 * step, step / 10)
    fscore = np.array([score(b) for b in fine])
    bpm = float(fine[int(np.argmax(fscore))])
    fit = _lattice_fit(env, t, 60.0 / bpm)
    return {'bpm': bpm, 'phase': fit['phase'], 'confidence': float(fscore.max()),
            'drift': fit['drift']}


def detect_bpm_librosa(audio_path: str, lo: float = 60, hi: float = 200) -> dict:
    """Tempo, beat phase and octave candidates for one audio file.

    1. librosa's beat tracker on the FULL clip picks the octave (`raw_bpm`, a lag bin).
    2. fold_tempo refines it at that octave to a precise `bpm` plus the beat `phase`.
    3. `candidates` is the octave family of the refined bpm (x0.25..x4 inside a musical
       range). Octave error (x2 / x0.5) is every tracker's failure mode, so the browser
       still lets the online lookup / library choose the octave. The refined value then
       wins over a lookup that agrees within ~2% (pickBpmCandidate / reconcileBpm).

    Lazy imports so the server still starts if librosa is absent (the endpoint returns 503
    and the browser falls back to its JS detector).

    Returns {duration, raw_bpm, bpm, phase, confidence, drift, candidates}. Candidates
    and raw_bpm are 2 dp; bpm 3 dp; phase 4 dp (seconds).
    """
    import numpy as np
    import librosa
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    duration = float(len(y) / sr) if sr else 0.0
    raw = float(np.atleast_1d(librosa.beat.beat_track(y=y, sr=sr)[0])[0])
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=TEMPO_HOP)
    fit = fold_tempo(env, TEMPO_HOP / sr, raw)
    bpm = fit['bpm']
    cands = sorted({round(bpm * m, 2) for m in (0.25, 0.5, 1, 2, 4)
                    if lo * 0.95 <= bpm * m <= hi * 1.05})
    if not cands:
        cands = [round(bpm, 2)]
    return {'duration': round(duration, 3), 'raw_bpm': round(raw, 2),
            'bpm': round(bpm, 3), 'phase': round(fit['phase'], 4),
            'confidence': round(fit['confidence'], 3), 'drift': fit['drift'],
            'candidates': cands}


def onset_phase_lock(times, bpm: float, phase: float = 0.0, bins: int = 16) -> dict:
    """How tightly onset times lock to a beat grid: beats at phase + k·60/bpm (s).

    Measures an onset detector against a VERIFIED grid (fold_tempo's bpm/phase on the same
    audio). Each onset's beat phase x = ((t − phase)/P) mod 1 goes into a `bins`-bin histogram,
    and for subdivision k the phase-locking value is the mean resultant length
    R_k = |mean(exp(2πi·k·x))|: 1 = every onset on the 1/k-beat grid, ~sqrt(π/4N) = random.
      k=1 beats, k=2 8ths (the 2026-11-21 measurement: server detector 0.023 vs librosa 0.32 on
      Electric Love), k=3 triplets (swing), k=4 16ths (the Master snap).
    `lock` = max R_k: a straight song locks at k=2/4, a swung one at k=3, a random detector at
    none. `offset_ms` is where the cluster of that best grid sits (R_k's mean angle, in ms):
    ≈0 means the detector's times ARE the hits; a constant offset means a latency error, not
    randomness. `random` is the expected R for N uniform onsets (the noise floor).
    """
    import numpy as np
    t = np.asarray(times, dtype=float)
    P = 60.0 / bpm
    n = int(len(t))
    if n == 0:
        return {'n': 0, 'hist': [0] * bins, 'R': [0.0] * 4, 'lock': 0.0, 'lock_k': 0,
                'offset_ms': 0.0, 'random': 1.0}
    x = ((t - phase) / P) % 1.0
    hist = np.bincount(np.minimum((x * bins).astype(np.int64), bins - 1), minlength=bins)
    R = [float(np.abs(np.exp(2j * np.pi * k * x).mean())) for k in (1, 2, 3, 4)]
    k_best = int(np.argmax(R)) + 1
    ang = float(np.angle(np.exp(2j * np.pi * k_best * x).mean()))
    return {'n': n, 'hist': [int(v) for v in hist], 'R': [round(r, 3) for r in R],
            'lock': round(max(R), 3), 'lock_k': k_best,
            'offset_ms': round(ang / (2 * np.pi * k_best) * P * 1000, 1),
            'random': round(float(np.sqrt(np.pi / (4 * n))), 3)}


# ── .synth coordinate constants (match the official editor) ──────────────────
# ROW_Y must equal `const ROW_Y` in synthriders-creator.html, which is what the generator,
# the 3D preview and the clipboard copy all use: 11 rows, step 0.1365, row 0 = ceiling,
# row 10 = floor. tests/rows.test.mjs fails if the two tables ever differ.
# (Until 2026-11-21 this was an older 8-row table, step 0.195, with rows clamped to 0-7:
# every exported map sat lower than designed and rows 7-10 all landed on the floor.)
ROW_Y = [
     0.6825,  0.5460,  0.4095,  0.2730,  0.1365,
     0.0,
    -0.1365, -0.2730, -0.4095, -0.5460, -0.6825,
]
X_OFFSET   = 0.002
Y_OFFSET   = 0.0012
TIME_SCALE = 20.0
NOTE_TYPES = ('RightHanded', 'LeftHanded', 'OneHandSpecial', 'BothHandsSpecial')


def row_y(row) -> float:
    """World Y for an app row (0 = ceiling … 10 = floor), clamped to the grid.
    Rounds half up like JS Math.round, so a fractional rail row lands where the
    3D preview draws it."""
    r = math.floor(float(row) + 0.5)
    return ROW_Y[max(0, min(len(ROW_Y) - 1, r))]


def build_note_track(notes: list, bpm: float) -> dict:
    """Convert the page's raw notes into a beatmap.meta.bin Track dict.

    Track = { beat_index: [note_dict, ...] }, beat_index = beat * 64 (int when whole).
    Position = [x, y, z] with z = time_seconds * TIME_SCALE. Rails carry Segments
    (waypoints + end point), each [x, y, z] with its own _x.
    """
    bps = bpm / 60.0
    new_notes = {}
    for note in notes:
        beat  = float(note['beat'])
        ntype = int(note.get('type', 0))
        nx    = float(note.get('_x', 0.0))

        pos = [
            round(nx + X_OFFSET, 6),
            round(row_y(note.get('row', 5)) + Y_OFFSET, 6),
            round((beat / bps) * TIME_SCALE, 6),
        ]

        beat_idx = beat * 64
        beat_key = int(beat_idx) if beat_idx == int(beat_idx) else round(beat_idx, 6)

        # Build Segments for rail notes (waypoints + end point)
        # Each waypoint carries its own _x (column sweep); fall back to start nx if missing.
        segments = None
        rail_end_beat = note.get('railEndBeat')
        rail_end_row  = note.get('railEndRow')
        if rail_end_beat is not None and rail_end_row is not None:
            raw_waypoints = note.get('railSegments') or []
            rail_end_x = note.get('railEnd_x')  # true end column (different from start)
            tail_wp = {'beat': rail_end_beat, 'row': rail_end_row}
            if rail_end_x is not None:
                tail_wp['_x'] = rail_end_x
            elif raw_waypoints:
                tail_wp['_x'] = raw_waypoints[-1].get('_x', nx)
            all_wp = list(raw_waypoints) + [tail_wp]
            segments = []
            for wp in all_wp:
                wp_beat = float(wp['beat'])
                wp_x    = float(wp['_x']) if '_x' in wp else nx
                segments.append([  # float[,] → [[x,y,z], ...]
                    round(wp_x + X_OFFSET, 6),
                    round(row_y(wp['row']) + Y_OFFSET, 6),
                    round((wp_beat / bps) * TIME_SCALE, 6),
                ])

        type_str = NOTE_TYPES[ntype] if 0 <= ntype < 4 else 'RightHanded'
        bucket   = new_notes.setdefault(beat_key, [])
        bucket.append({
            'Id':       f'Note_{beat_key}{type_str}{len(bucket)}',
            'ComboId':  -1 if segments else (0 if ntype == 2 else (1 if ntype == 3 else -1)),
            'Position': pos,
            'Segments': segments,
            'Type':     ntype,
            'Direction': 0,  # NoteDirection.None = 0
        })

    return dict(sorted(new_notes.items(), key=lambda kv: float(kv[0])))


class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Clean up default logging
        print(f"  {self.address_string()} — {format % args}")

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Request-Private-Network")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def _is_local_request(self) -> bool:
        """Loopback client, and if the browser sent an Origin, it is this server's own page."""
        if self.client_address[0] not in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
            return False
        origin = self.headers.get('Origin')
        if origin is None:
            return True
        return origin in (f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}')

    def _send_json(self, code, obj):
        payload = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(payload))
        self.end_headers()
        self.wfile.write(payload)

    def _handle_anthropic_proxy(self):
        import urllib.request, urllib.error
        if not self._is_local_request():
            self._send_json(403, {'error': {'type': 'forbidden', 'message': 'proxy is local-only'}})
            return
        key = server_anthropic_key()
        if not key:
            self._send_json(400, {'error': {'type': 'no_server_key',
                'message': 'No server key: set ANTHROPIC_API_KEY or create .anthropic_key next to server.py'}})
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
        req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=body, method='POST',
            headers={'Content-Type': 'application/json', 'x-api-key': key,
                     'anthropic-version': self.headers.get('anthropic-version', '2023-06-01')})
        try:
            resp = urllib.request.urlopen(req, timeout=600)
            code, hdrs, data = resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            code, hdrs, data = e.code, e.headers, e.read()
        except Exception as e:
            self._send_json(502, {'error': {'type': 'proxy_error', 'message': str(e)}})
            return
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(data))
        # Pass rate-limit headers through — callAnthropic logs them on a 429.
        for h, v in hdrs.items():
            if h.lower().startswith('anthropic-ratelimit-') or h.lower() == 'retry-after':
                self.send_header(h, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]

        # ── /api_key_status — does the server hold a key? (never returns the key) ──
        if path == "/api_key_status":
            self._send_json(200, {'server_key': bool(server_anthropic_key()) and self._is_local_request()})
            return

        # ── /dev_song?q=<substring> — stream a song from ../MP3 (local-only) ──
        if path == "/dev_song":
            if not self._is_local_request():
                self._send_json(403, {'error': 'local-only'})
                return
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('q', [''])[0]
            song = find_song(q)
            if not song:
                self._send_json(404, {'error': f'no song matching {q!r} in {SONG_DIR}'})
                return
            data = song.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", len(data))
            self.send_header("X-Song-Name", urllib.parse.quote(song.name))
            self.end_headers()
            self.wfile.write(data)
            return

        # ── /favicon.ico — silence browser auto-requests ─────────────────
        if path == "/favicon.ico":
            self.send_response(204)
            self.send_cors()
            self.end_headers()
            return

        # ── /meta_library — return the full song metadata cache ──────────
        if path == "/meta_library":
            lib = load_meta_library()
            payload = json.dumps(lib, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        # ── /diagnostics — return all generation diagnostic runs ────────────
        if path == "/diagnostics":
            runs = load_diagnostics()
            payload = json.dumps(runs, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        # ── /check_demucs — probe Demucs + CUDA availability ─────────────
        if path == "/check_demucs":
            available, device, message = check_demucs()
            payload = json.dumps({
                'available': available,
                'device':    device,
                'message':   message,
            }).encode('utf-8')
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        # Fall through to file serving (original do_GET logic follows below)
        if path in ("/", "/index.html"):
            path = "/synthriders-creator.html"

        file_path = SCRIPT_DIR / path.lstrip("/")
        if file_path.exists() and file_path.is_file():
            ext = file_path.suffix.lower()
            content_types = {
                ".html": "text/html; charset=utf-8",
                ".js":   "application/javascript",
                ".css":  "text/css",
                ".json": "application/json",
                ".md":   "text/plain; charset=utf-8",
            }
            content_type = content_types.get(ext, "application/octet-stream")
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(data))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_cors()
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")

    def do_POST(self):
        path = self.path.split('?')[0].rstrip('/')
        if path == "/export":
            self._handle_export()
            return
        if path == "/anthropic":
            self._handle_anthropic_proxy()
            return
        if path == "/meta_library":
            self._handle_meta_library()
            return
        if path == "/diagnostics":
            self._handle_diagnostics_post()
            return
        if path == "/separate":
            self._handle_separate()
            return
        if path == "/analyse_stems":
            self._handle_analyse_stems()
            return
        if path == "/detect_bpm":
            self._handle_detect_bpm()
            return
        if path == "/youtube":
            self._handle_youtube()
            return
        if path != "/convert":
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(f"Unknown endpoint: {self.path}".encode())
            return

        # Parse multipart form data
        content_type = self.headers.get("Content-Type", "")
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            # Parse multipart manually — no deprecated cgi module needed
            # Extract boundary from Content-Type header
            boundary_match = re.search(r'boundary=([^;\r\n]+)', content_type)
            if not boundary_match:
                raise ValueError("No boundary in Content-Type")
            boundary = boundary_match.group(1).strip().encode()

            # Split body on boundary
            parts = body.split(b'--' + boundary)
            filename = "audio.mp3"
            file_bytes = None
            silence = 0.0   # optional 'silence_secs' field: prepend a beat-1 pad

            for part in parts[1:]:
                if part.strip() in (b'', b'--', b'--\r\n'):
                    continue
                # Separate headers from body
                if b'\r\n\r\n' in part:
                    header_block, _, part_body = part.partition(b'\r\n\r\n')
                elif b'\n\n' in part:
                    header_block, _, part_body = part.partition(b'\n\n')
                else:
                    continue

                headers = header_block.decode('utf-8', errors='replace')
                part_body = re.sub(rb'\r?\n$', b'', part_body)
                field = re.search(r'name=["\']([^"\']+)["\']', headers)
                if field and field.group(1) == 'silence_secs':
                    try:
                        silence = min(max(float(part_body.decode('utf-8', 'replace').strip()), 0.0), 2.0)
                    except ValueError:
                        pass
                    continue
                fn_match = re.search(r'filename=["\']?([^"\';\r\n]+)', headers)
                if fn_match:
                    filename = fn_match.group(1).strip()
                if part_body:
                    file_bytes = part_body

            if file_bytes is None:
                raise ValueError("No file data found in request")

            ext = os.path.splitext(filename)[1].lower() or ".mp3"

            if ext == ".ogg" and silence <= 0:
                ogg_bytes = file_bytes
            else:
                pad_desc = f" with a {silence:.3f}s beat-1 pad" if silence > 0 else ""
                print(f"  Converting {filename} ({len(file_bytes)//1024} KB) → OGG{pad_desc}…")
                ogg_bytes = convert_to_ogg(file_bytes, ext, silence_secs=silence)
                print(f"  Done — {len(ogg_bytes)//1024} KB OGG")

            self.send_response(200)
            self.send_header("Content-Type", "audio/ogg")
            self.send_header("Content-Length", len(ogg_bytes))
            self.send_header("Content-Disposition", f'attachment; filename="{Path(filename).stem}.ogg"')
            self.send_cors()
            self.end_headers()
            self.wfile.write(ogg_bytes)

        except Exception as ex:
            msg = str(ex).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", len(msg))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg)
            print(f"  ERROR: {ex}")


    def _handle_meta_library(self):
        """POST /meta_library — JSON body with one of:
          { action:'save',   entry:{ key, title, artist, bpm, genre,
                                     coverDataB64, coverFileName, savedAt } }
          { action:'delete', key: '...' }
        """
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            payload = json.loads(body.decode('utf-8'))
            action  = payload.get('action', 'save')
            lib     = load_meta_library()

            if action == 'delete':
                key = payload.get('key', '')
                lib.pop(key, None)
                save_meta_library(lib)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_cors()
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            else:  # save / upsert
                entry = payload.get('entry', payload)  # also accept flat payload
                key   = entry.get('key', '')
                if not key:
                    raise ValueError('entry.key is required')
                lib[key] = entry
                save_meta_library(lib)
                resp = json.dumps({'ok': True, 'total': len(lib)}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', len(resp))
                self.send_cors()
                self.end_headers()
                self.wfile.write(resp)

        except Exception as ex:
            msg = json.dumps({'error': str(ex)}).encode('utf-8')
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg)

    def _handle_diagnostics_post(self):
        """POST /diagnostics — JSON body with one generation run; appended to log file."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            entry  = json.loads(body.decode('utf-8'))
            append_diagnostic(entry)
            msg = b'{"ok":true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(msg))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg)
        except Exception as e:
            err = json.dumps({'error': str(e)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(err))
            self.send_cors()
            self.end_headers()
            self.wfile.write(err)

    def _handle_separate(self):
        """POST /separate  — multipart with 'audio' file field.

        Runs Demucs htdemucs on the uploaded audio and returns JSON:
        {
          "drums":  "<base64-encoded WAV>",
          "bass":   "<base64-encoded WAV>",
          "vocals": "<base64-encoded WAV>",
          "other":  "<base64-encoded WAV>",
          "device": "cuda"|"cpu",
          "model":  "htdemucs"
        }

        Returns 503 with { "error": "..." } if Demucs is not installed.
        Returns 500 with { "error": "..." } on processing failure.
        """
        import base64

        # Quick availability check before reading the (potentially large) body
        available, device, msg = check_demucs()
        if not available:
            payload = json.dumps({'error': msg}).encode('utf-8')
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        content_type   = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            boundary_match = re.search(r'boundary=([^;\r\n]+)', content_type)
            if not boundary_match:
                raise ValueError('No multipart boundary in Content-Type')
            boundary = boundary_match.group(1).strip().encode()

            parts = body.split(b'--' + boundary)
            audio_bytes = None
            audio_ext   = '.mp3'

            for part in parts[1:]:
                if part.strip() in (b'', b'--', b'--\r\n'):
                    continue
                sep = b'\r\n\r\n' if b'\r\n\r\n' in part else b'\n\n'
                if sep not in part:
                    continue
                header_block, _, part_body = part.partition(sep)
                headers = header_block.decode('utf-8', errors='replace')
                fn_match = re.search(r'filename=["\']?([^"\';\r\n]+)', headers)
                name_match = re.search(r'name=["\']([^"\']+)["\']', headers)
                field_name = name_match.group(1) if name_match else ''
                part_body = re.sub(rb'\r?\n$', b'', part_body)
                if field_name == 'audio' and part_body:
                    audio_bytes = part_body
                    if fn_match:
                        audio_ext = os.path.splitext(fn_match.group(1).strip())[1].lower() or '.mp3'

            if audio_bytes is None:
                raise ValueError("No 'audio' field found in multipart body")

            print(f'  /separate — {len(audio_bytes)//1024} KB {audio_ext} — device={device}')

            with tempfile.TemporaryDirectory() as tmpdir:
                stems = separate_stems(audio_bytes, audio_ext, tmpdir)

                # Encode each stem WAV as base64 for transport
                encoded = {}
                for name, path in stems.items():
                    with open(path, 'rb') as f:
                        encoded[name] = base64.b64encode(f.read()).decode('ascii')

            payload = json.dumps({
                **encoded,
                'device': device,
                'model':  'htdemucs',
            }).encode('utf-8')

            print(f'  /separate — done, returning {len(payload)//1024} KB JSON')

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)

        except Exception as ex:
            msg = json.dumps({'error': str(ex)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(msg))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg)
            print(f'  /separate ERROR: {ex}')

    def _handle_analyse_stems(self):
        """POST /analyse_stems  — multipart with 'audio' file + optional 'bpm' field.

        Runs Demucs then per-stem onset/region detection.
        Returns the Phase 2 JSON structure:
        {
          "duration": 198.4,
          "stems": {
            "drums":  { "onsets": [{ "time", "energy", "subtype" }] },
            "bass":   { "regions": [{ "start", "end", "energy" }],
                        "onsets":  [{ "time", "energy" }] },
            "vocals": { "onsets": [{ "time", "energy", "pitch_row" }] },
            "other":  { "onsets": [{ "time", "energy" }],
                        "regions": [{ "start", "end", "energy" }] }
          },
          "energy_curve": [0.3, 0.5, ...]
        }

        Returns 503 if Demucs not available, 500 on processing failure.
        """
        available, device, msg = check_demucs()
        if not available:
            payload = json.dumps({'error': msg}).encode('utf-8')
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        content_type   = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            boundary_match = re.search(r'boundary=([^;\r\n]+)', content_type)
            if not boundary_match:
                raise ValueError('No multipart boundary in Content-Type')
            boundary = boundary_match.group(1).strip().encode()

            parts = body.split(b'--' + boundary)
            audio_bytes   = None
            audio_ext     = '.mp3'
            bpm           = 120.0
            pad_secs      = 0.0   # beat-1 pad from the app (audioPadSecs)
            enabled_stems = None  # None → all enabled (default)

            for part in parts[1:]:
                if part.strip() in (b'', b'--', b'--\r\n'):
                    continue
                sep = b'\r\n\r\n' if b'\r\n\r\n' in part else b'\n\n'
                if sep not in part:
                    continue
                header_block, _, part_body = part.partition(sep)
                headers    = header_block.decode('utf-8', errors='replace')
                fn_match   = re.search(r'filename=["\']?([^"\';\r\n]+)', headers)
                name_match = re.search(r'name=["\']([^"\']+)["\']', headers)
                field_name = name_match.group(1) if name_match else ''
                part_body  = re.sub(rb'\r?\n$', b'', part_body)

                if field_name == 'audio' and part_body:
                    audio_bytes = part_body
                    if fn_match:
                        audio_ext = os.path.splitext(
                            fn_match.group(1).strip())[1].lower() or '.mp3'
                elif field_name == 'bpm' and part_body:
                    try:
                        bpm = float(part_body.decode('utf-8', errors='replace').strip())
                    except ValueError:
                        pass
                elif field_name == 'pad' and part_body:
                    try:
                        pad_secs = min(max(float(part_body.decode('utf-8', errors='replace').strip()), 0.0), 2.0)
                    except ValueError:
                        pass
                elif field_name == 'enabled_stems' and part_body:
                    try:
                        parsed = json.loads(part_body.decode('utf-8', errors='replace').strip())
                        if isinstance(parsed, dict):
                            enabled_stems = parsed
                    except (json.JSONDecodeError, ValueError):
                        pass

            if audio_bytes is None:
                raise ValueError("No 'audio' field found in multipart body")

            disabled = [] if enabled_stems is None else [k for k, v in enabled_stems.items() if not v]
            print(f'  /analyse_stems — {len(audio_bytes)//1024} KB {audio_ext}'
                  f' bpm={bpm} pad={pad_secs:.3f}s device={device}'
                  + (f' disabled={disabled}' if disabled else ''))

            with tempfile.TemporaryDirectory() as tmpdir:
                print('  Running Demucs separation…')
                stems = separate_stems(audio_bytes, audio_ext, tmpdir)
                print('  Running per-stem analysis…')
                analysis = analyse_stems(stems, bpm, enabled_stems, pad_secs)

            payload = json.dumps(analysis, cls=_NumpyEncoder, separators=(',', ':')).encode('utf-8')
            print(f'  /analyse_stems — done, {len(payload)//1024} KB')

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)

        except Exception as ex:
            import traceback
            traceback.print_exc()
            msg_bytes = json.dumps({'error': str(ex)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(msg_bytes))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg_bytes)
            print(f'  /analyse_stems ERROR: {ex}')

    def _handle_detect_bpm(self):
        """POST /detect_bpm — multipart with an 'audio' file.

        Robust tempo estimate via librosa (the MIR-standard beat tracker) on the FULL clip —
        replaces the browser's first-20s JS autocorrelation, which produced octave errors
        (e.g. a 144-BPM song stored as 103). Returns the raw estimate PLUS an octave-candidate
        family so the browser can reconcile against the online lookup (snap to the candidate
        nearest the looked-up value); with no lookup it picks the in-band candidate near 120.
        Returns 503 if librosa isn't installed (browser then falls back to its JS detector)."""
        try:
            bpm_info = None  # set after we know librosa is importable
            import librosa  # noqa: F401  (presence check; real work in detect_bpm_librosa)
        except Exception as ex:
            payload = json.dumps({'error': f'librosa unavailable: {ex}'}).encode('utf-8')
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        content_type   = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            boundary_match = re.search(r'boundary=([^;\r\n]+)', content_type)
            if not boundary_match:
                raise ValueError('No multipart boundary in Content-Type')
            boundary = boundary_match.group(1).strip().encode()
            audio_bytes, audio_ext = None, '.mp3'
            for part in body.split(b'--' + boundary)[1:]:
                if part.strip() in (b'', b'--', b'--\r\n'):
                    continue
                sep = b'\r\n\r\n' if b'\r\n\r\n' in part else b'\n\n'
                if sep not in part:
                    continue
                header_block, _, part_body = part.partition(sep)
                headers  = header_block.decode('utf-8', errors='replace')
                fn_match = re.search(r'filename=["\']?([^"\';\r\n]+)', headers)
                name     = re.search(r'name=["\']([^"\']+)["\']', headers)
                part_body = re.sub(rb'\r?\n$', b'', part_body)
                if name and name.group(1) == 'audio' and part_body:
                    audio_bytes = part_body
                    if fn_match:
                        audio_ext = os.path.splitext(fn_match.group(1).strip())[1].lower() or '.mp3'
            if audio_bytes is None:
                raise ValueError("No 'audio' field found in multipart body")

            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = os.path.join(tmpdir, 'clip' + audio_ext)
                with open(tmp, 'wb') as f:
                    f.write(audio_bytes)
                bpm_info = detect_bpm_librosa(tmp)
            print(f"  /detect_bpm — {len(audio_bytes)//1024} KB {audio_ext} → "
                  f"raw={bpm_info['raw_bpm']} refined={bpm_info['bpm']} "
                  f"phase={bpm_info['phase']}s conf={bpm_info['confidence']} "
                  f"drift={bpm_info['drift']} cands={bpm_info['candidates']}")

            payload = json.dumps(bpm_info, separators=(',', ':')).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
        except Exception as ex:
            import traceback
            traceback.print_exc()
            msg_bytes = json.dumps({'error': str(ex)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(msg_bytes))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg_bytes)
            print(f'  /detect_bpm ERROR: {ex}')

    def _handle_youtube(self):
        """POST /youtube — JSON body { "url": "..." }.

        Downloads the best audio via yt-dlp, converts to OGG once (same encoder as
        /convert), saves a copy to YT_DOWNLOAD_DIR, and streams the OGG back so the
        browser can load it through the normal upload path. Title/artist are returned
        in X-Video-Title / X-Video-Artist headers (percent-encoded for non-ASCII).

        Returns 503 if yt-dlp isn't installed, 500 on any download/convert failure.
        """
        available, yt_msg = check_ytdlp()
        if not available:
            payload = json.dumps({'error': yt_msg}).encode('utf-8')
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(payload))
            self.send_cors()
            self.end_headers()
            self.wfile.write(payload)
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            req    = json.loads(body.decode('utf-8')) if body else {}
            url    = (req.get('url') or '').strip()
            if not re.match(r'^https?://', url, re.I):
                raise ValueError('A valid http(s) URL is required.')

            print(f'  /youtube — downloading {url}')
            ogg_bytes, title, artist, saved = download_youtube_audio(url)
            print(f'  /youtube — "{title}" by "{artist or "?"}" — '
                  f'saved {saved} ({len(ogg_bytes)//1024} KB OGG)')

            out_name = _safe_filename(f'{artist} - {title}' if artist else title) + '.ogg'
            self.send_response(200)
            self.send_header('Content-Type', 'audio/ogg')
            self.send_header('Content-Length', len(ogg_bytes))
            self.send_header('Content-Disposition', f'attachment; filename="{out_name}"')
            self.send_header('X-Video-Title',  urllib.parse.quote(title))
            self.send_header('X-Video-Artist', urllib.parse.quote(artist))
            self.send_header('Access-Control-Expose-Headers',
                             'X-Video-Title, X-Video-Artist, Content-Disposition')
            self.send_cors()
            self.end_headers()
            self.wfile.write(ogg_bytes)

        except Exception as ex:
            msg = json.dumps({'error': str(ex)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(msg))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg)
            print(f'  /youtube ERROR: {ex}')

    def _handle_export(self):
        """Receive multipart form with track JSON + audio file, return .synth ZIP.

        Generates the current SynthRiders format:
          beatmap.meta.bin  — UTF-8 BOM + JSON (CRLF) containing all beatmap data
          track.data.json   — UTF-16-LE BOM + JSON metadata sidecar (editor UI only)
          <audio>_<hash>.ogg
          cover image (optional)
        """
        import zipfile, io, hashlib, base64, time as _time, uuid as _uuid
        content_type   = self.headers.get("Content-Type", "")
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            boundary_match = re.search(r'boundary=([^;\r\n]+)', content_type)
            if not boundary_match:
                raise ValueError("No multipart boundary — wrong content type: " + content_type[:80])
            boundary = boundary_match.group(1).strip().encode()

            parts_data = {}
            for part in body.split(b'--' + boundary)[1:]:
                if part.strip() in (b'', b'--', b'--\r\n'):
                    continue
                sep = b'\r\n\r\n' if b'\r\n\r\n' in part else b'\n\n'
                header_block, _, part_body = part.partition(sep)
                headers_str = header_block.decode('utf-8', errors='replace')
                name_match  = re.search(r'name=["\']?([^"\'\s;]+)', headers_str)
                fn_match    = re.search(r'filename=["\']?([^"\'\s;\r\n]+)', headers_str)
                if name_match:
                    key = name_match.group(1)
                    val = re.sub(rb'\r?\n$', b'', part_body)
                    parts_data[key] = (fn_match.group(1) if fn_match else None, val)

            if 'track' not in parts_data:
                raise ValueError("Missing track field")

            track_obj = json.loads(parts_data['track'][1].decode('utf-8'))

            # ── metadata ──────────────────────────────────────────────────
            title      = track_obj.get('Title', 'Untitled').title()
            artist     = track_obj.get('Artist', 'Unknown').title()
            mapper     = track_obj.get('Mapper', 'Custom').title()
            bpm        = float(track_obj.get('BPM', 120))
            offset     = float(track_obj.get('Offset', 0))
            clip_start = float(track_obj.get('clipStart', 0))
            clip_end   = float(track_obj.get('clipEnd',   0))
            # Beat-1 pad the map was generated with (app audioPadSecs): prepended as silence so
            # the audio matches the map clock. Clamped: a pad is under one beat period.
            audio_pad  = min(max(float(track_obj.get('AudioPad', 0) or 0), 0.0), 2.0)
            notes      = track_obj.get('notes', [])

            # Deterministic UUID v5 from title+artist — game uses this as the map's unique key
            map_id = str(_uuid.uuid5(_uuid.NAMESPACE_URL, f'synthriders:{title}|{artist}'))

            DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'Master', 'Custom']
            diff_name = track_obj.get('DifficultyName', 'Expert')
            if diff_name not in DIFFICULTIES:
                diff_name = 'Expert'

            # Coordinate constants (ROW_Y, X/Y_OFFSET, TIME_SCALE) and the note conversion
            # live at module level (build_note_track) so tests exercise the real export.
            bps          = bpm / 60.0
            sorted_track = build_note_track(notes, bpm)

            # ── convert walls ───────────────────────────────────────────────
            raw_crouchs = track_obj.get('crouchs', [])
            raw_slides  = track_obj.get('slides',  [])
            def wall_z(beat): return round((beat / bps) * TIME_SCALE, 6)

            # SynthRiders does NOT support a Duration field in Crouchs/Slides —
            # each entry is a single-tile event. Sustained HOLDS are created by
            # emitting multiple tiles in rapid succession; a SINGLE quick obstacle
            # is exactly one tile.
            #   duration <= 1  → 1 tile (single quick obstacle)
            #   duration  > 1  → tiles every OBSTACLE_STEP beats across the duration
            # OBSTACLE_STEP: spacing of hold tiles (0.5 = 8th-note). Density of a hold
            # doesn't materially change the feel (it's a continuous hold either way).
            OBSTACLE_STEP = 0.5

            def expand_wall_tiles(beat, dur):
                if dur <= 1.0:
                    return [beat]                       # single tile — not a hold
                ts = []
                t = beat
                while t < beat + dur - 0.01:            # epsilon guards float overshoot
                    ts.append(t)
                    t += OBSTACLE_STEP
                return ts

            crouchs_list = []
            for w in raw_crouchs:
                beat = float(w['beat'])
                dur  = float(w.get('duration', 1))
                for t in expand_wall_tiles(beat, dur):
                    crouchs_list.append({
                        'time': round(t * 64),
                        'position': [0.0, 0.0, wall_z(t)],
                        'initialized': True,
                    })
            crouchs_list.sort(key=lambda x: x['time'])

            slides_list = []
            for w in raw_slides:
                beat     = float(w['beat'])
                dur      = float(w.get('duration', 1))
                stype    = int(w.get('slideType', 0))
                for t in expand_wall_tiles(beat, dur):
                    slides_list.append({
                        'time': round(t * 64),
                        'slideType': stype,
                        'position': [0.0, 0.0, wall_z(t)],
                        'zRotation': 0.0,
                        'initialized': True,
                    })
            slides_list.sort(key=lambda x: x['time'])

            # ── audio ──────────────────────────────────────────────────────
            audio_bytes = b''
            audio_stem  = 'song'
            if 'audio' in parts_data:
                audio_filename, audio_bytes = parts_data['audio']
                if audio_filename:
                    bare = re.sub(r'\.[^.]+$', '', audio_filename)
                    audio_stem = re.sub(r'[^a-z0-9]+', '-', bare.lower())
                    audio_stem = re.sub(r'^-+|-+$', '', audio_stem) or 'song'

            # Always re-encode through ffmpeg → guarantees OGG Vorbis (not Opus).
            # Unity 2018 only supports Vorbis; OGG files from modern tools may use Opus.
            if audio_bytes:
                audio_ext = os.path.splitext(audio_filename)[1].lower() if audio_filename else '.ogg'
                clip_desc = f", clip {clip_start:.1f}s–{clip_end:.1f}s" if (clip_start or clip_end) else ""
                pad_desc  = f", beat-1 pad {audio_pad:.3f}s" if audio_pad > 0 else ""
                print(f"  Re-encoding audio ({audio_ext}) → OGG Vorbis{clip_desc}{pad_desc}…")
                audio_bytes = convert_to_ogg(audio_bytes, audio_ext,
                                             silence_secs=audio_pad,
                                             clip_start=clip_start, clip_end=clip_end)
                print(f"  Done — {len(audio_bytes)//1024} KB")

            # Hash-based filename — matches how the official editor names audio
            audio_hash      = hashlib.sha256(audio_bytes).hexdigest()[:8] if audio_bytes else '00000000'
            safe_audio_name = f'{audio_stem[:16]}_{audio_hash}.ogg'

            # ── cover ──────────────────────────────────────────────────────
            cover_bytes = b''
            cover_name  = 'cover.png'
            if 'cover' in parts_data:
                cover_filename, cover_bytes = parts_data['cover']
                cover_name = cover_filename or 'cover.png'

            # ── audio duration ──────────────────────────────────────────────
            duration_str = '00:00'
            if audio_bytes:
                # Primary: pure-Python OGG Vorbis header parse — no external tools
                dur_secs = ogg_vorbis_duration(audio_bytes)
                if dur_secs > 0:
                    duration_str = f'{int(dur_secs // 60):02d}:{int(dur_secs % 60):02d}'
                    print(f"  Duration (OGG parse): {duration_str}")
                else:
                    # Fallback: ffprobe / ffmpeg
                    try:
                        ffmpeg_cmd  = find_ffmpeg() or 'ffmpeg'
                        ffprobe_cmd = ffmpeg_cmd.replace('ffmpeg', 'ffprobe')
                        with tempfile.TemporaryDirectory() as tmpdir:
                            tmp_audio = os.path.join(tmpdir, 'audio.ogg')
                            with open(tmp_audio, 'wb') as f:
                                f.write(audio_bytes)
                            result = subprocess.run(
                                [ffprobe_cmd, '-v', 'quiet',
                                 '-show_entries', 'format=duration',
                                 '-of', 'default=noprint_wrappers=1:nokey=1',
                                 tmp_audio],
                                capture_output=True, text=True
                            )
                            if result.returncode == 0 and result.stdout.strip():
                                dur = float(result.stdout.strip())
                                duration_str = f'{int(dur // 60):02d}:{int(dur % 60):02d}'
                                print(f"  Duration (ffprobe): {duration_str}")
                            else:
                                r2 = subprocess.run(
                                    [ffmpeg_cmd, '-i', tmp_audio],
                                    capture_output=True, text=True
                                )
                                m = re.search(r'Duration:\s*(\d+):(\d+):(\d+)', r2.stderr)
                                if m:
                                    h, mn, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
                                    total = h * 3600 + mn * 60 + s
                                    duration_str = f'{int(total // 60):02d}:{int(total % 60):02d}'
                                    print(f"  Duration (ffmpeg): {duration_str}")
                                else:
                                    print(f"  WARNING: Could not detect audio duration")
                    except Exception as e:
                        print(f"  Duration detection error: {e}")

            # ── beatmap.meta.bin ───────────────────────────────────────────
            # Field order and set matches official editor exactly (extra fields
            # cause MissingMemberHandling.Error in the game's deserializer)
            artwork_b64 = base64.b64encode(cover_bytes).decode('ascii') if cover_bytes else None

            beatmap_data = {
                'Name':           title,
                'Author':         artist,
                'Artwork':        cover_name if cover_bytes else 'Default Image',
                'ArtworkBytes':   artwork_b64,
                'AudioName':      safe_audio_name,
                'AudioData':      None,
                'AudioFrecuency': 44100,
                'AudioChannels':  2,
                'BPM':            bpm,
                'Offset':         round(offset, 6),
                'Track':   {d: (sorted_track if d == diff_name else {}) for d in DIFFICULTIES},
                'Effects': {d: [] for d in DIFFICULTIES},
                'Bookmarks': {'BookmarksList': []},
                'Jumps':     {d: [] for d in DIFFICULTIES},
                'Crouchs':   {d: (crouchs_list if d == diff_name else []) for d in DIFFICULTIES},
                'Slides':    {d: (slides_list  if d == diff_name else []) for d in DIFFICULTIES},
                'Lights':    {d: [] for d in DIFFICULTIES},
                'DrumSamples':                None,
                'FilePath':                   'Redacted',
                'IsAdminOnly':                False,
                'EditorVersion':              'SynthRiders Beatmap Creator',
                'Beatmapper':                 mapper,
                'CustomDifficultyName':       'Custom',
                'CustomDifficultySpeed':      1.0,
                'UsingBeatMeasure':           True,
                'UpdatedWithMovementPositions': True,
                'ProductionMode':             False,
                'Tags':           [],
                'BeatConverted':  False,
                'ModifiedTime':   int(_time.time()),
            }
            # UTF-8 BOM + CRLF (matches official editor output)
            beatmap_json  = json.dumps(beatmap_data, indent=2)
            beatmap_bytes = b'\xef\xbb\xbf' + beatmap_json.encode('utf-8').replace(b'\n', b'\r\n')

            # ── track.data.json (metadata sidecar — editor UI only) ────────
            meta_data = {
                'name':                  title,
                'artist':                artist,
                'duration':              duration_str,
                'coverImage':            cover_name if cover_bytes else 'Default Image',
                'audioFile':             safe_audio_name,
                'supportedDifficulties': [d if d == diff_name else '' for d in DIFFICULTIES],
                'bpm':                   bpm,
                'mapper':                mapper,
            }
            # UTF-16-LE BOM (matches official editor output)
            meta_json  = json.dumps(meta_data, indent=4)
            meta_bytes = b'\xff\xfe' + meta_json.encode('utf-16-le')

            # ── assemble ZIP ───────────────────────────────────────────────
            safe_title = re.sub(r'[^a-z0-9]+', '-', title.lower())
            safe_title = re.sub(r'^-+|-+$', '', safe_title) or 'song'

            # build_synth_zip produces flag=0x0800, mtime=0, mdate=0, NTFS extra
            # on every entry — exactly matching the Quest audio loader requirements.
            entries = [('beatmap.meta.bin', beatmap_bytes)]
            if audio_bytes:
                entries.append((safe_audio_name, audio_bytes))
            entries.append(('track.data.json', meta_bytes))
            if cover_bytes:
                entries.append((cover_name, cover_bytes))

            synth_bytes = build_synth_zip(entries)
            dl_name     = safe_title + '-custom.synth'

            # Debug: save a copy locally so it can be inspected
            debug_path = SCRIPT_DIR / 'debug_last_export.synth'
            try:
                debug_path.write_bytes(synth_bytes)
            except Exception:
                pass

            audio_info = f'{len(audio_bytes)//1024} KB' if audio_bytes else 'MISSING — no audio in ZIP!'
            print(f"  Title={title!r}  Artist={artist!r}  Diff={diff_name}  Notes={len(sorted_track)}  Audio={audio_info}")

            # ── Batch mode: save to disk instead of streaming back ─────────────
            # When the client sends a save_path field, write the synth file to that
            # directory and return JSON {"saved": filename} rather than the raw bytes.
            save_path_raw = parts_data.get('save_path')
            if save_path_raw:
                import pathlib as _pl
                out_dir = _pl.Path(save_path_raw[1].decode('utf-8').strip())
                out_dir.mkdir(parents=True, exist_ok=True)
                out_file = out_dir / dl_name
                out_file.write_bytes(synth_bytes)
                print(f"  Batch saved → {out_file}")
                payload = json.dumps({"saved": dl_name, "path": str(out_file)}).encode('utf-8')
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(payload))
                self.send_cors()
                self.end_headers()
                self.wfile.write(payload)
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", len(synth_bytes))
            self.send_header("Content-Disposition", f'attachment; filename="{dl_name}"')
            self.send_cors()
            self.end_headers()
            self.wfile.write(synth_bytes)
            print(f"  Exported {dl_name} ({len(synth_bytes)//1024} KB)")

        except Exception as ex:
            import traceback
            msg = (str(ex) + "\n" + traceback.format_exc()).encode()
            self.send_response(500)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", len(msg))
            self.send_cors()
            self.end_headers()
            self.wfile.write(msg)
            print(f"  Export ERROR: {ex}")


def main():
    import socketserver
    print("=" * 52)
    print("  SynthRiders Beatmap Creator — Local Server")
    print("=" * 52)
    print()

    if check_ffmpeg():
        print("  \u2713  ffmpeg found")
    else:
        print("  \u2717  ffmpeg NOT found \u2014 audio conversion disabled")

    demucs_ok, demucs_device, demucs_msg = check_demucs()
    if demucs_ok:
        print(f"  \u2713  {demucs_msg}")
    else:
        print(f"  \u2717  {demucs_msg}")

    yt_ok, yt_msg = check_ytdlp()
    print(f"  {'\u2713' if yt_ok else '\u2717'}  {yt_msg}")
    if yt_ok:
        import shutil
        deno = _ensure_deno_on_path()
        print(f"     {'\u2713' if deno else '\u00b7'}  JS runtime: "
              + ("Deno found \u2014 reliable YouTube extraction"
                 if deno else "no Deno (downloads still work; some videos may be slow/miss formats)"))

    print(f"  \u2713  Serving from: {SCRIPT_DIR}")
    print()
    print("  Open in your browser:")
    print(f"  → http://localhost:{PORT}")
    print()
    print("  Supported formats: OGG, MP3, WAV, FLAC, M4A, AAC")
    print("  Non-OGG files will be auto-converted via ffmpeg")
    print()
    print("  Press Ctrl+C to stop")
    print("-" * 52)

    # Auto-open browser (Windows / Mac only — Linux may not have a default)
    import platform, threading, webbrowser, time
    def _open_browser():
        time.sleep(1.2)  # wait for server to be ready
        webbrowser.open(f"http://localhost:{PORT}")
    if platform.system() in ("Windows", "Darwin") and '--no-browser' not in sys.argv:
        threading.Thread(target=_open_browser, daemon=True).start()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")


if __name__ == "__main__":
    main()
