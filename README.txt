SynthRiders Beatmap Creator
===========================
A browser-based tool to generate and edit custom .synth beatmaps for SynthRiders VR.
Designed for use with the official Synth Riders Beatmap Editor on Windows.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUICK START (Windows — Dell or any PC)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Install Python
  https://python.org → check "Add Python to PATH" during install

STEP 2 — Install ffmpeg
  Open Command Prompt and run:
      winget install ffmpeg
  (or download from https://ffmpeg.org and add to PATH)

STEP 3 — Install the official Beatmap Editor (free)
  https://store.steampowered.com/app/1121930/Synth_Riders_Beatmap_Editor/

STEP 4 — Place these files in a folder and double-click launch.bat
  The tool opens automatically at http://localhost:8080

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW TO GET A SONG ONTO YOUR QUEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. In THIS tool (http://localhost:8080):
   a. Upload your song (MP3, OGG, WAV, FLAC etc.)
   b. BPM auto-detects — or use "Look up BPM online" button
   c. Set difficulty, title, artist
   d. Click Generate Beatmap (uses audio analysis)
   e. Fine-tune notes on the grid if you want
   f. Click "📋 Copy Notes for Official Editor"

2. In the Synth Riders Beatmap Editor (Steam):
   a. File → New / Open
   b. Load the same audio file
   c. Press Ctrl+V to paste all the notes
   d. Review and adjust in the editor
   e. File → Export → saves an encrypted .synth file

3. Copy the .synth to your Quest:
   Quest 3 path: /sdcard/SynthRidersUC/CustomSongs/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHY THE TWO-STEP PROCESS?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The Quest requires .synth files to be AES-encrypted, and only the official
Beatmap Editor (Windows) can produce that encryption. This tool handles all
the creative work — audio analysis, BPM detection, pattern generation, grid
editing — and the official editor handles the final encryption step.

If you find the encryption password via the SynthRiders Mod Discord
(discord.gg/UWQff8C), the Export .synth button will work directly and you
can skip the official editor entirely.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT THIS TOOL DOES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Upload audio in any format (auto-converts to OGG via ffmpeg)
- GPU stem separation (Demucs) — drums / bass / vocals / guitar analysed separately
  (requires Python 3.12 + CUDA torch; falls back to JS analysis otherwise)
- Auto-detect BPM + live web lookup by title/artist
- AI-assisted note generation with an iterative "style critic" quality loop
- Two-hand parallel play, arc-based note flow, rails, gold/green sweeps
- Energy-driven obstacles (crouch/lean/slide) with a mix of quick hits and holds
- Lyric-cue obstacles (fetch lyrics → sync movement to words, incl. "rise/up" → elevating rails)
- Song metadata library (auto-saves title/artist/BPM/genre/cover/lyric cues by audio hash)
- Batch mode — generate a whole folder of songs at a chosen difficulty
- 3D preview, visual grid editor, BPM/difficulty/NJS/offset configurable

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE / UPDATES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GitHub: https://github.com/ExKylebur/Synthriderz-Beatmapper
Run upload_to_github.bat to push the latest local changes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILES IN THIS FOLDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  launch.bat                — double-click to start (Windows)
  server.py                 — local server: ffmpeg convert, Demucs analysis, .synth export
  synthriders-creator.html  — the tool itself (all UI + generation logic)
  style_critic_prompt.md    — AI critic system prompt (fetched at runtime)
  upload_to_github.bat      — push changes to the GitHub repo
  handoff_next_session.md   — developer handoff / current architecture (start here for dev)
  README.txt                — this file

NOTE: Demucs needs Python 3.12 with CUDA torch (cu124) AND the `soundfile` package.
If stem separation fails, see handoff_next_session.md "Environment / Gotchas".
