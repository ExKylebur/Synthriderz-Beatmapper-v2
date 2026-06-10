@echo off
setlocal EnableDelayedExpansion
title Upload to GitHub - Synthriderz-Beatmapper

REM ===========================================================================
REM  upload_to_github.bat
REM  Re-runnable sync script for https://github.com/ExKylebur/Synthriderz-Beatmapper
REM
REM  First run:   initializes repo, sets remote, makes initial commit, pushes.
REM  Subsequent:  stages changes, commits with timestamp, pushes.
REM
REM  Optional commit message: pass as argument, e.g.
REM    upload_to_github.bat "fix rail head zone enforcement"
REM ===========================================================================

set REPO_URL=https://github.com/ExKylebur/Synthriderz-Beatmapper.git
set BRANCH=main

echo ============================================================
echo   Uploading to %REPO_URL%
echo ============================================================
echo.

REM ── Move to the folder containing this .bat file ──────────────────────────
cd /d "%~dp0"

REM ── Sanity check: git installed? ──────────────────────────────────────────
git --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: git is not installed or not in PATH.
    echo   Install Git for Windows from https://git-scm.com/download/win
    pause
    exit /b 1
)

REM ── Sanity check: we're in the right folder? ──────────────────────────────
if not exist "synthriders-creator.html" (
    echo   ERROR: synthriders-creator.html not found in current folder.
    echo   This script must live in the extracted/ folder next to the app.
    pause
    exit /b 1
)

REM ── Initialise the repo on first run ──────────────────────────────────────
if not exist ".git" (
    echo   Initialising new git repository...
    git init -b %BRANCH%
    if errorlevel 1 (
        REM Older git versions don't support -b; fall back and rename
        git init
        git checkout -b %BRANCH% 2>nul
    )
    echo.
)

REM ── Set or update the remote ──────────────────────────────────────────────
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo   Adding remote origin -^> %REPO_URL%
    git remote add origin %REPO_URL%
) else (
    REM Remote exists; make sure it points at the right URL
    for /f "delims=" %%U in ('git remote get-url origin') do set CURRENT_URL=%%U
    if /i not "!CURRENT_URL!"=="%REPO_URL%" (
        echo   Updating remote origin URL from !CURRENT_URL! to %REPO_URL%
        git remote set-url origin %REPO_URL%
    )
)

REM ── Make sure we're on the right branch ──────────────────────────────────
git rev-parse --abbrev-ref HEAD >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%B
    if /i not "!CURRENT_BRANCH!"=="%BRANCH%" (
        echo   Switching to branch %BRANCH% ^(was !CURRENT_BRANCH!^)
        git branch -M %BRANCH%
    )
)

REM ── Stage everything (respects .gitignore) ────────────────────────────────
echo.
echo   Staging changes...
git add -A

REM ── Exit cleanly if nothing changed ───────────────────────────────────────
git diff --cached --quiet
if not errorlevel 1 (
    echo.
    echo   No changes to commit. Repository is already up to date.
    echo.
    pause
    exit /b 0
)

REM ── Show what is about to be committed ────────────────────────────────────
echo.
echo   Files staged for this commit:
git diff --cached --name-status
echo.

REM ── Build commit message (use arg if provided, else timestamp) ────────────
set "COMMIT_MSG=%~1"
if "%COMMIT_MSG%"=="" (
    for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul ^| find "="') do set DTS=%%I
    set "STAMP=!DTS:~0,4!-!DTS:~4,2!-!DTS:~6,2! !DTS:~8,2!:!DTS:~10,2!"
    set "COMMIT_MSG=Sync update !STAMP!"
)
echo   Commit message: "%COMMIT_MSG%"
echo.

REM ── Commit ────────────────────────────────────────────────────────────────
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
    echo.
    echo   ERROR: commit failed. See message above.
    pause
    exit /b 1
)

REM ── Push (set upstream on first push) ─────────────────────────────────────
echo.
echo   Pushing to %BRANCH% on origin...
git push -u origin %BRANCH%
if errorlevel 1 (
    echo.
    echo   ERROR: push failed.
    echo   - If this is the first push to a non-empty remote, you may need:
    echo       git pull --rebase origin %BRANCH%
    echo     then re-run this script.
    echo   - If auth failed, check that Git Credential Manager is signed in
    echo     ^(or run: gh auth login^).
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Upload complete.
echo   View at: https://github.com/ExKylebur/Synthriderz-Beatmapper
echo ============================================================
echo.
pause
endlocal
