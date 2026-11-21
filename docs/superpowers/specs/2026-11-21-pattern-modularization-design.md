# Pattern modularization — design spec

**Date:** 2026-11-21 · **Status:** draft for approval · **Scope:** `onsetsToNotes` main path only (not the `expandSections` fallback)

## 1. Problem

Patterned material (rails, `[DenseSweep]` runs, `[GoldSweep]` runs) is assembled from fixed libraries, but each piece is used once, in isolation:

- **Rails are single shapes.** A long rail is one `railShape` stretched over its length, so an 8-beat rail and a 16-beat rail read as the same gesture at two speeds.
- **Sparse sections have no choreography.** `[DenseSweep]` fires only on runs with ≤0.5-beat spacing. Anything looser falls back to per-note `naturalX` arcs plus jitter, which is where most "random-feeling" stretches come from.
- **Pattern coverage is accidental.** Painkiller (Master) came out 76% DenseSweep, while Another Life was about 8%. Nothing targets a level of choreographed coverage.
- **Choruses don't rhyme.** Each chorus rolls fresh shape and move choices, so the song's most repeated music produces its least repeated choreography.

## 2. Goals / non-goals

**Goals:** multi-segment rails; choreography for sparse runs; a coverage band; chorus motif memory. Each must keep the C1/C2/C3/ZONE invariants with no new special cases in the shared helpers.

**Non-goals:**
- The `expandSections` fallback.
- New move or shape libraries. This reuses rail shapes, the 14 `MOVES`, and the 5 GoldSweep shapes.
- Motif memory that persists across regenerations. Decided 2026-11-21: memory lives for **one Generate call only**, so every regeneration explores new motifs.

## 3. Components

### 3.1 Multi-segment rails
- A rail of **≥ 6 beats** may chain **2–3 segments**: 2 for 6–12 beats, 3 for 12+. The split is randomised; it is not a fixed 8/4. Each segment is at least 2.5 beats, so every segment reaches the mid tier.
- Segment *k+1* is seeded from segment *k*'s **obstacle-clamped** last waypoint, its `{col,row}` after `clampPt`. It is not seeded from the unclamped `posAt(1)`. Otherwise a wall clamp in segment *k* leaves a gap at the seam.
- Adjacent segments must use different shapes.
- **Implementation:** factor `generateRailArc`'s body into `railSegment(startBeat, endBeat, startCol, rowStart, shape, ctx)` and have `generateRailArc` chain the segments. The returned `{waypoints, xEnd, rowEnd}` contract is unchanged, so every caller and the companion and fixC1 logic are untouched.
- **Waypoints:** the render cap of 12 is shared across segments in proportion to segment length, with at least 3 per segment so corner shapes such as `hook` and `switchback` keep a node on their corner.
- **Zone:** every segment uses `handZoneCols(hand, allowCrossCenter)`, the single source added 2026-11-21. No segment may reach past `CROSS_REACH_COLS`.

### 3.2 `[SparseSweep]`
- A sibling block placed right after `[DenseSweep]`. It reuses the same `MOVES` array, hoisted out of the DenseSweep block to a shared const.
- **Gates:** consecutive free-orb spacing above 0.5 and up to **1.5 beats** (tunable); a run of at least 4 orbs over at least 4 beats. Orbs already tagged `_denseSweep` are excluded.
- **Stepping:** one move step **per onset**, not per beat. Sparse runs have few onsets per beat, and stepping per beat would skip most of the move.
- **Reach cap:** the per-step Manhattan cap scales with the gap: `min(5, 3 + floor(gapBeats))`, because a sparse hand has more time to travel.
- Tag: `_sparseSweep`. Boundary smoothing reuses DenseSweep's block, generalised to "exactly one of the pair is pattern-tagged", where pattern means `_denseSweep || _sparseSweep`.
- **Obstacle occlusion:** `_toBand` clamps `_sparseSweep` the same way it does `_denseSweep`, for the same reason: random per-note relocation breaks the move. Change `_toBand`'s test to an `isPattern(n)` helper.

### 3.3 Coverage band — `[PatternCoverage]`
- Coverage is the share of all notes that are rails (heads plus companions), `_denseSweep`, `_sparseSweep` or `_goldSweep`.
- **Target band:** 60–80%, centred on 70%. Tune it during testing.
- The pass runs after SparseSweep and before the FinalSweep, and is modelled on `HARD GOLD CAP`:
  - **Under the band:** promote the longest untagged free-orb runs. Try SparseSweep with relaxed gates first (≥ 3 orbs), then DenseSweep.
  - **Over the band:** demote `_sparseSweep` runs first (shortest first), then `_denseSweep`. Demoting means restoring the pre-sweep `{_x,row}` snapshot taken at tag time. Never touch rails or GoldSweep.
- Log: `[PatternCoverage] before=X% after=Y% promoted=a demoted=b`.

### 3.4 Chorus motif memory
- `const motifMemory = new Map()`, created at the top of `onsetsToNotes`. It is session-local by construction.
- **Key:** section root, using the same regex the "Progressive chorus variation" pass uses, so "Chorus 2" and "chorus (x2)" share a key.
- **First occurrence** records, in order: rail segment shapes and proportions, DenseSweep/SparseSweep move indices, and GoldSweep shape ids.
- **Later occurrences** replay that sequence, with segment proportions scaled to the new length. If a replayed shape doesn't fit its slot's length tier, it gracefully downgrades one tier (long → mid → short). Progressive chorus variation still escalates intensity on top of the replay.

## 4. Placement in the pass order

```
… [GoldSweep] → [DenseSweep] (+boundary) → [SparseSweep] (+boundary, NEW)
  → [PatternCoverage] (NEW) → FINAL C1/C2 SWEEP (runFinalSweep) → [Crossover]
  → ObstacleFinal (applyObstacleOcclusion(true)) → [GreenClamp] → [C3Clamp] → [RowLift]
```
Multi-segment rails and motif memory live inside rail generation and the sweep blocks, so they add no passes of their own.

## 5. Invariant impact

| Invariant | Risk | Mitigation |
|---|---|---|
| C1 (companions on path) | Seams between segments | Seed from clamped endpoint; fixC1 in runFinalSweep re-snaps |
| C2 (gold/green clearance) | None new | SparseSweep excludes gold/green like DenseSweep |
| C3 (reachable jumps) | Sparse runs and seams add endpoint variety | Per-step reach cap; boundary smoothing; clampC3Jumps unchanged as the backstop; monitor `unresolvable` |
| ZONE (≤2 cols past centre) | New lateral travel | `handZoneCols` for every segment; SparseSweep hand-zone clamp like DenseSweep |
| C4 (ceiling ≤2%) | Moves visit row 1 → RowLift → row 0 | Use DenseSweep's `clRow` band (rows 2–8) |
| Obstacles | Random relocation scrambles moves | `_toBand` clamps all pattern-tagged notes |

## 6. Testing
- **Unit:** extend the Node harness that loads the real functions out of the HTML (scratch `harness.js`, 2026-11-21). Check segment continuity at seams, `handZoneCols` compliance across 20k random rails, and that motif replay is deterministic for a given memory.
- **Live:** drive the app headlessly with `?song=` plus the server-held key on :8092 (`synthmapper-v2-agent` launch config). Run Painkiller (dense) and Another Life (mixed) at Master. Check:
  - `[PatternCoverage]` lands in band;
  - `validate.py` reports 0 HARD;
  - the dense-step break rate inside walls is no worse than the 2026-11-21 baseline (7.9%);
  - no new `unresolvable`.
- **Critic prompt:** describe multi-segment rails and SparseSweep, and accept `pattern:"sparse"` in `note_sample`.

## 7. Open questions
- SparseSweep's per-onset stepping on very sparse runs (2-beat gaps) may read as "random" anyway. A minimum-onsets-per-move-step gate may be needed; decide from the first live run.
