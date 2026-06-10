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

Then open:  http://localhost:8080  (opens automatically on Windows)

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

PORT = 8080
SCRIPT_DIR = Path(__file__).parent  # serve from the folder server.py lives in

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


def detect_onsets_np(env, hop_sec: float, min_gap_sec: float,
                     local_window_sec: float = 30.0):
    """Detect onset times (seconds) from an RMS envelope using local flux thresholding.

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
    """[SUGGESTION-H] HFC-weighted spectral flux onset detection.

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


def analyse_stems(stems: dict, bpm: float, enabled_stems: dict | None = None) -> dict:
    """Run per-stem onset detection and return structured analysis JSON.

    stems:         { 'drums': path, 'bass': path, 'vocals': path, 'other': path }
    bpm:           song BPM (used for minimum gap between onsets)
    enabled_stems: { 'drums': bool, 'bass': bool, 'vocals': bool, 'other': bool }
                   When a stem is False its onset/region detection is skipped
                   (Demucs always produces all 4 stems; this just avoids processing).

    Returns the Phase 2 JSON structure consumed by extractNoteEvents in Phase 4.
    """
    import numpy as np

    if enabled_stems is None:
        enabled_stems = {'drums': True, 'bass': True, 'vocals': True, 'other': True}

    SR       = 22050   # downsample target — half of 44.1k, fast, sufficient
    HOP_SEC  = 0.01    # 10ms frames
    HOP      = int(SR * HOP_SEC)
    beat_sec = 60.0 / bpm

    result_stems = {}

    # ── Drums ────────────────────────────────────────────────────────────────
    drums_sig, _ = load_wav_mono(stems['drums'], SR)
    if enabled_stems.get('drums', True):
        print('  Analysing drums stem…')
        drums_env    = rms_envelope(drums_sig, HOP)
        raw_onsets   = detect_onsets_np(drums_env, HOP_SEC, beat_sec * 0.25)
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
    if enabled_stems.get('bass', True):
        print('  Analysing bass stem…')
        bass_env     = rms_envelope(bass_sig, HOP)
        bass_thresh  = bass_env.max() * 0.12
        bass_regions = detect_sustained_regions_np(
            bass_env, HOP_SEC, bass_thresh,
            min_sec=beat_sec * 0.5, max_sec=beat_sec * 20)
        bass_onsets  = detect_onsets_np(bass_env, HOP_SEC, beat_sec * 0.4)
        result_stems['bass'] = {'regions': bass_regions, 'onsets': bass_onsets}
    else:
        print('  Skipping bass stem (disabled).')
        result_stems['bass'] = {'regions': [], 'onsets': []}

    # ── Vocals ───────────────────────────────────────────────────────────────
    # [SUGGESTION-H] Combine RMS-based onsets with HFC-weighted spectral flux to
    # catch consonants and subtle vocal attacks that don't show in RMS envelope.
    vox_sig, _ = load_wav_mono(stems['vocals'], SR)
    if enabled_stems.get('vocals', True):
        print('  Analysing vocals stem (RMS + spectral flux)…')
        vox_env         = rms_envelope(vox_sig, HOP)
        vox_onsets_rms  = detect_onsets_np(vox_env, HOP_SEC, beat_sec * 0.5)
        vox_onsets_flux = spectral_flux_hfc_np(vox_sig, SR, HOP_SEC, beat_sec * 0.5)
        vox_onsets_raw  = merge_onsets(vox_onsets_rms, vox_onsets_flux, beat_sec * 0.25)
        print(f'    vocals: {len(vox_onsets_rms)} RMS + {len(vox_onsets_flux)} flux → {len(vox_onsets_raw)} merged')
        vox_onsets = []
        for o in vox_onsets_raw:
            pitch_row = estimate_pitch_row(vox_sig, SR, o['time'])
            vox_onsets.append({**o, 'pitch_row': pitch_row})
        result_stems['vocals'] = {'onsets': vox_onsets, 'regions': []}  # regions filled below
    else:
        print('  Skipping vocals stem (disabled).')
        result_stems['vocals'] = {'onsets': [], 'regions': []}

    # ── Other / synth ────────────────────────────────────────────────────────
    # [SUGGESTION-H] Combine RMS + spectral flux for guitars / synths — catches
    # pinch harmonics and string attacks the RMS envelope misses.
    other_sig, _ = load_wav_mono(stems['other'], SR)
    if enabled_stems.get('other', True):
        print('  Analysing other stem (RMS + spectral flux)…')
        other_env         = rms_envelope(other_sig, HOP)
        other_onsets_rms  = detect_onsets_np(other_env, HOP_SEC, beat_sec * 0.4)
        other_onsets_flux = spectral_flux_hfc_np(other_sig, SR, HOP_SEC, beat_sec * 0.4)
        other_onsets      = merge_onsets(other_onsets_rms, other_onsets_flux, beat_sec * 0.25)
        print(f'    other:  {len(other_onsets_rms)} RMS + {len(other_onsets_flux)} flux → {len(other_onsets)} merged')
        result_stems['other'] = {'onsets': other_onsets, 'regions': []}  # regions filled below
    else:
        print('  Skipping other stem (disabled).')
        result_stems['other'] = {'onsets': [], 'regions': []}

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

    beat_frames  = int(beat_sec * SR)
    num_beats    = int(np.ceil(duration / beat_sec))
    energy_curve = []
    for b in range(num_beats):
        s = b * beat_frames
        e = min(s + beat_frames, len(mix))
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
        beat_frames_pan = int(beat_sec * SR)
        for b in range(num_beats):
            s = b * beat_frames_pan
            e = min(s + beat_frames_pan, min(len(L), len(R)))
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
            cmd = [
                ffmpeg_cmd, "-y",
                "-f", "lavfi", "-t", str(round(silence_secs, 3)),
                "-i", "anullsrc=r=44100:cl=stereo",
                *seek_args, "-i", in_path,
                "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
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

    def do_GET(self):
        path = self.path.split("?")[0]

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
                fn_match = re.search(r'filename=["\']?([^"\';\r\n]+)', headers)
                if fn_match:
                    filename = fn_match.group(1).strip()
                part_body = re.sub(rb'\r?\n$', b'', part_body)
                if part_body:
                    file_bytes = part_body

            if file_bytes is None:
                raise ValueError("No file data found in request")

            ext = os.path.splitext(filename)[1].lower() or ".mp3"

            if ext == ".ogg":
                ogg_bytes = file_bytes
            else:
                print(f"  Converting {filename} ({len(file_bytes)//1024} KB) → OGG…")
                ogg_bytes = convert_to_ogg(file_bytes, ext, silence_secs=0.0)
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
                  f' bpm={bpm} device={device}'
                  + (f' disabled={disabled}' if disabled else ''))

            with tempfile.TemporaryDirectory() as tmpdir:
                print('  Running Demucs separation…')
                stems = separate_stems(audio_bytes, audio_ext, tmpdir)
                print('  Running per-stem analysis…')
                analysis = analyse_stems(stems, bpm, enabled_stems)

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
            notes      = track_obj.get('notes', [])

            # Deterministic UUID v5 from title+artist — game uses this as the map's unique key
            map_id = str(_uuid.uuid5(_uuid.NAMESPACE_URL, f'synthriders:{title}|{artist}'))

            DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'Master', 'Custom']
            diff_name = track_obj.get('DifficultyName', 'Expert')
            if diff_name not in DIFFICULTIES:
                diff_name = 'Expert'

            # ── coordinate constants (match official editor) ───────────────
            X_OFFSET   = 0.002
            Y_OFFSET   = 0.0012
            TIME_SCALE = 20.0
            bps        = bpm / 60.0
            ROW_Y      = [0.6825, 0.4875, 0.2925, 0.0975, -0.0975, -0.2925, -0.4875, -0.6825]
            NOTE_TYPES = ('RightHanded','LeftHanded','OneHandSpecial','BothHandsSpecial')

            # ── convert notes to new format ────────────────────────────────
            # Track[diff] = { beat_index: [note_dict, ...] }
            # beat_index  = beat * 64  (int when whole, float otherwise)
            # Position    = [x, y, z]  where z = time_seconds * TIME_SCALE
            new_notes = {}
            for note in notes:
                beat  = float(note['beat'])
                row   = max(0, min(7, int(note.get('row', 4))))
                ntype = int(note.get('type', 0))
                nx    = float(note.get('_x', 0.0))
                ny    = ROW_Y[row]

                pos = [
                    round(nx + X_OFFSET, 6),
                    round(ny + Y_OFFSET, 6),
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
                        wp_row  = max(0, min(7, int(wp['row'])))
                        wp_x    = float(wp['_x']) if '_x' in wp else nx
                        segments.append([  # float[,] → [[x,y,z], ...]
                            round(wp_x + X_OFFSET, 6),
                            round(ROW_Y[wp_row] + Y_OFFSET, 6),
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

            sorted_track = dict(sorted(new_notes.items(), key=lambda kv: float(kv[0])))

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
                print(f"  Re-encoding audio ({audio_ext}) → OGG Vorbis{clip_desc}…")
                audio_bytes = convert_to_ogg(audio_bytes, audio_ext,
                                             silence_secs=0.0,
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
            print(f"  Title={title!r}  Artist={artist!r}  Diff={diff_name}  Notes={len(new_notes)}  Audio={audio_info}")

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
    if platform.system() in ("Windows", "Darwin"):
        threading.Thread(target=_open_browser, daemon=True).start()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")


if __name__ == "__main__":
    main()
