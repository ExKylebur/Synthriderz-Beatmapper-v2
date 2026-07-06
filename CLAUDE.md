# SynthRiders Beatmap Creator — Claude Code Guide

## Model strategy

Based on lessons learned building this program, use models strategically:

- **Haiku (haiku-4-5)** — docs, analysis, writing, simple refactoring, cost-saving tasks
- **Sonnet (sonnet-5)** — new feature implementation (once architecture is set), straightforward bug fixes, code generation in known patterns
- **Opus (opus-4-8)** — bug hunting in complex/coupled systems, architectural decisions, constraint verification, multi-layer reasoning

**Why this split:** This codebase has subtle multi-layer invariants (C1/C2/C3 spatial constraints across 20+ passes, critic loop interactions). Sonnet excels at isolated tasks but misses edge cases where changes in one pass break assumptions elsewhere. Opus catches interaction bugs that Sonnet would leave as lingering issues.

**Example:** The C3 gold/green jump bug required understanding both the spatial clamp logic AND how the critic detector worked, plus how they interacted. Sonnet could implement either one in isolation; Opus caught they had the same blind spot and proposed the unified fix.

## Cost optimization

- **Generator prompt caching:** Not practical (prompt is song-specific, only helps on same-map regen within 5 min). Critic prompt is already cached.
- **API key:** Consider BYOK (users plug in their own key) for shared/public versions to zero your per-generation cost.
- **Critic model:** Already on Haiku (cheapest viable).

## Code principles

- **Shared geometry helpers:** C1/C2/C3 logic lives in module-level helpers (`fixC1`, `clearGoldC2`, `clampC3Jumps`, etc.). Never re-duplicate this logic across passes.
- **Invariant testing:** Post-passes run in a specific order (documented in the handoff). Changes to the order or to pass logic need to be verified against the full constraint set, not just that individual pass.
- **Prompt caching:** System prompts (critic) are cached with `cache_control: { type: 'ephemeral' }`. Generator prompts are song-specific and not cached.

## Testing & verification

- **validate.py:** Regression harness for exported `.synth` files. Run before claiming a generation fix is complete.
- **Console logs:** Watch for `[C3Clamp]`, `[FinalSweep]`, `[GreenClamp]`, `[Crossover]`, `[FlowProbe]` — these are instrumentation for the complex passes.
- **Real play-test:** After spatial/flow changes, test in VR or the 3D preview. Console logs prove the code ran; play-test proves it feels right.
