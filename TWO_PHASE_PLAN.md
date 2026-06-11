# Two-Phase Refactor — Plan & Pass Classification

> Goal (from handoff): **Phase 1** locks a *rhythmic skeleton* — which beats get a note, on
> which hand/type; stem-owned, density-shaped; ALL add/remove resolved. **Phase 2** is *purely
> spatial* — rows/cols/`_x`/rail geometry; never adds/removes notes, never flips hands/types.
> History: density/detection big-bang changes regressed 3×. So: one increment per session,
> each verified by `[Phase2Probe]` console data from a real batch before the next lands.

## Current state (Step 1 — DONE, zero behavior change)

- **Phase boundary exists in code**: after `[DedupSameBeat]` (+ the relocated `[DensityThin]`),
  before `[GoldSweep]`. Marked by the `PHASE BOUNDARY — skeleton lock` block in
  `onsetsToNotes`: snapshots the population as a `beat×64|type` multiset (`_skel`) and logs
  `_probe('phase-boundary')`.
- **Skeleton diff at FINAL**: logs `[Phase2Probe] skeleton diff: +A −R (removed R/L/grn/gld …)`.
  Target end-state: `+0 −0 clean` every generation. Until then the diff quantifies exactly
  what the spatial zone still mutates.
- **[DensityThin] moved above the boundary** (it removes notes → Phase-1 pass). No-op today
  (`FAITHFUL_DRUMS=true` skips it), so the move cost nothing.

## Pass classification (verified against code, 2026-06-11)

Phase-1 zone (population — current order):

| Pass | Effect | Phase-correct? |
|---|---|---|
| main placement loop | creates population + initial positions | ✓ (positions are provisional) |
| [GreenSweep] | type→green conversions | ✓ |
| gap-fill | ADDS | ✓ |
| [SoloDensity] | ADDS | ✓ |
| wall gen + [HoldStreak] | walls only | ✓ |
| applyObstacleOcclusion(false) | MOVES only | ✗ stranded spatial |
| [RhythmCoherence] | REMOVES | ✓ |
| [HandBreak] | MOVES only | ✗ stranded spatial |
| [PhraseEcho] | MOVES only (copies row/_x) | ✗ stranded spatial |
| [Anticipate-G] | MOVES only | ✗ stranded spatial (SightLine must stay after it) |
| [SightLine] | MOVES only | ✗ stranded spatial |
| [Overmap-D], [PreChorus-B] | REMOVE | ✓ |
| [Downbeat-A] | ADDS companions | ✓ |
| [ChorusBuildup-C], [EndClimax-E] | type→gold | ✓ |
| mid [GreenRail]/[GreenC2] | REMOVE | ✓ |
| gold accents/exclusion, dedup, definitive snap, [C1Verify] | mixed population | ✓ |
| [GoldCap] | type demotions | ✓ |
| [RailObstacle] | rail-point clamp (MOVES) | ✗ stranded spatial |
| [HandBalance] | HAND FLIPS | ✓ |
| [DedupSameBeat] | REMOVES | ✓ |
| [DensityThin] (moved, gated off) | REMOVES | ✓ |

**═══ PHASE BOUNDARY (skeleton lock + probe) ═══**

Phase-2 zone (spatial — current order):

| Pass | Effect | Phase-correct? |
|---|---|---|
| [GoldSweep] | MOVES | ✓ |
| [DenseSweep] | MOVES | ✓ |
| [FinalSweep] (runFinalSweep) | re-snaps + **REMOVES** (GRC, C1, goldC2, greenC2) | ⚠ violation |
| [Crossover] | MOVES (same hand, opposite side) | ✓ |
| [ObstacleFinal] | MOVES + fixC1 **REMOVES** | ⚠ violation |
| [GreenClamp] | MOVES | ✓ |
| [RowLift] | MOVES (uniform) | ✓ |

Key observation for Step 3: **beats and types never change in the Phase-2 zone**, and the
three C2-family clearers (`clearGreenRailConflicts`, `clearGoldC2`, `clearGreenC2`) are purely
beat/type-domain rules. Therefore the set of C2 violations at the boundary is IDENTICAL to the
set at FinalSweep — pre-running those clearers at the end of Phase 1 is provably
population-neutral. Only `fixC1`'s remove step is genuinely spatial-domain (rail-path
geometry), because Phase-2 passes can move an orb off its same-hand rail path.

## Roadmap (one step per session, play-test gated)

1. **DONE** — boundary + skeleton lock + FINAL diff instrumentation; [DensityThin] relocated.
2. **DONE (2026-06-11)** — baseline collected, 4 generations of one song:
   `adds = 0 in all four` (pass map is complete — nothing creates notes in the spatial zone);
   removals −75/−50/−62/−73 (~7–10% of population!), ALL R/L singles + a few rails
   (rail 24→20 etc.), grn/gld = 0. Fingerprint: **gold C2 clearance** — gold accents are added
   in Phase 1 (gld 21→59 by the boundary) but the single-hand orbs around them were only
   cleared in [FinalSweep]. Side-finding: [DenseSweep]/[GoldSweep] were shaping groups around
   notes FinalSweep then deleted → holes in the flowing groups.
3. **DONE (2026-06-11) — pending play-test verification**: `[Phase1Clear]` runs GRC + goldC2 +
   greenC2 at the end of Phase 1 (just before the skeleton lock), same relative order as
   runFinalSweep minus fixC1 (spatial-domain, stays in the spatial zone). Verified before
   landing: clearers are pure beat/type-domain + idempotent; NOTHING between the boundary and
   [FinalSweep] reads `beatOccupied`; baseline adds=0 ⇒ population-equivalent. Known edge
   (rule-consistent, documented in code): a rail demoted to an orb by goldC2 can be removed by
   the FinalSweep re-run if within ±1 beat of a gold — that was a latent C2 violation before.
   **Verify on next batch**: `[Phase1Clear]` prints ~50–75; `[FinalSweep]` GRC/C2 read 0;
   skeleton diff drops to fixC1-only (expect single digits); flow FEEL of dense sections equal
   or better (groups no longer get holes punched in them).
4. **Make fixC1's remove step unnecessary**: constrain Phase-2 movers ([GoldSweep],
   [DenseSweep], [Crossover], [ObstacleFinal], [GreenClamp]) to keep same-hand orbs on the
   rail path during rail windows (they mostly already skip rail windows — audit each). fixC1's
   re-snap stays (spatial), its REMOVE count should hit 0; then the skeleton diff reads clean.
5. **Corral the stranded spatial passes** into Phase 2 one at a time ([RailObstacle] first —
   easiest; then HandBreak / PhraseEcho / Anticipate-G+SightLine as an ordered block). NOTE:
   later Phase-1 passes currently READ positions ([HandBalance] mirrors across centre,
   [Downbeat-A] places companions relative to primaries), so each move is a real behavior
   change → one per session, play-tested via [FlowProbe] + feel.
6. **Hard interface**: skeleton becomes an explicit structure (`{beat, hand, type, role, stem,
   railWindow}`); Phase 2 consumes it and asserts purity instead of logging a diff.

## The parallel-vs-stem-hand tension — proposed resolution (decide before Step 6)

Can't fully have both "each hand = one instrument" and "90% two-hand parallel" (companions are
by definition on the other hand). Resolution: **restate goal (a) as applying to PRIMARY notes
only.** Skeleton entries carry `role: primary | companion | gapfill`. Companions are
accompaniment — stemless by design (already true: `_dbComp` doesn't inherit `stemSource`), so
they cannot "smear" a stem. The actual smear bug to fix in Phase 1 is the 8-beat
`STEM_HAND_WINDOW` ownership flip on PRIMARY notes — make a stem's primary onsets stick to one
hand per SECTION (flip only at section boundaries, logged), which avoids the failed
`STABLE_STEM_HAND` whole-song pin (drums ≈75% of notes would overload one hand) while killing
mid-phrase hand switches.

## Verification protocol (every step)

- Brace-lexer `0/0/0` after every edit (no JS engine on this machine).
- Console per generation: `[Phase2Probe] raw-placement / phase-boundary / FINAL` + `skeleton
  diff` line; `[FinalSweep]` MUST print (its absence = a pass threw → silent expandSections
  fallback, the [DensityClip] failure mode).
- No `fn(...largeArray)` / `push(...largeArray)` — V8 arg-stack overflow inside the try/catch
  masks the throw as a generator fallback.
