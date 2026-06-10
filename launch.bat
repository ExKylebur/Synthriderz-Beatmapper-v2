@echo off
title SynthRiders Beatmap Creator
echo ================================================
echo   SynthRiders Beatmap Creator
echo ================================================
echo.

REM ── Python version selection ─────────────────────────────────────────────
REM Prefer Python 3.12 (best PyTorch/Demucs/CUDA compatibility on Windows).
REM Falls back to 3.11, then 3.13, then the system default 'python'.
REM This allows running alongside Python 3.14 without conflict.

set PYTHON_CMD=

py -3.12 --version >nul 2>&1
if not errorlevel 1 (
    set PYTHON_CMD=py -3.12
    echo   Using Python 3.12 (recommended for Demucs + CUDA^)
    goto python_found
)

py -3.11 --version >nul 2>&1
if not errorlevel 1 (
    set PYTHON_CMD=py -3.11
    echo   Using Python 3.11
    goto python_found
)

py -3.13 --version >nul 2>&1
if not errorlevel 1 (
    set PYTHON_CMD=py -3.13
    echo   Using Python 3.13
    goto python_found
)

python --version >nul 2>&1
if not errorlevel 1 (
    set PYTHON_CMD=python
    echo   Using system Python (Demucs/CUDA may not work^)
    goto python_found
)

echo   ERROR: No Python installation found.
echo   Download Python 3.12 from https://python.org/downloads
echo   and check "Add Python to PATH" during install.
echo.
pause
exit /b 1

:python_found
echo.

REM ── ffmpeg check ─────────────────────────────────────────────────────────
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo   WARNING: ffmpeg not found.
    echo   MP3/WAV/FLAC conversion will be unavailable.
    echo   Install with:  winget install ffmpeg
    echo   or download from https://ffmpeg.org/download.html
    echo.
)

REM ── Move to the folder containing this .bat file ──────────────────────────
cd /d "%~dp0"

REM ── Start the server (browser opens automatically) ────────────────────────
REM Uses server.py from this folder (cd above ensured we're in the right place).
%PYTHON_CMD% "%~dp0server.py"

pause
