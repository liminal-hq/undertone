# M5: Scheduler and facade

## Objective

A new `undertone-sched` crate books and plays patterns against a clock, and the `undertone` crate is the Rust API a user depends on: one idiomatic facade over the pattern, engine, and scheduler crates, with a guide section and published API docs.

**Depends on:** M4 (RF-20 for the scheduler, RF-15 to RF-22 for the facade). **Done when:** the Rust API covers every group in [API-MAPPING.md](../API-MAPPING.md) and the corpus is green on Rust in full.

## Work packages

### RF-22. The scheduler: windowed booking, clock, transport, stats

- **Owner:** A. **Size:** M. **Depends on:** RF-20.
- **Objective:** a new crate `undertone-sched`: the pure part (book every voice that starts in `[t0, t1)` of a pattern at a tempo) and a clock-driven part behind a `Clock` trait (`now()`, frames played, latency); `play`, `loop` (Rust: `play_loop`), `setcpm`, `resetTempo`, handles with `stop(when, fade)`, cut groups' 5 ms fade, seek (`from`, `when`), and statistics (callback time, underruns, late voices); pooled voices so the audio thread never allocates (the engine gains adding and retiring nodes after `Engine::new`).
- **Steps:** (1) read `src/scheduler.ts` (look-ahead 0.3 s, tick 100 ms) and `src/render.ts`'s windowed booking at `452f782`; (2) the pure `book_window`; (3) `Transport`, `Clock`, and handles; (4) the voice pool; (5) property tests for window independence of booking; (6) **documentation:** rustdoc with a runnable example per entry point.
- **Files:** `crates/undertone-sched/**`, changes in `crates/undertone-engine/` for node retirement, `crates/undertone-sched/tests/properties.rs`.
- **Acceptance:** booking a window equals booking its halves (property test); the TypeScript's scheduler tests classified "public API" in R5 pass against the Rust through the bridge later (RF-27); an allocation-counting test over the audio-thread path (a test-only `unsafe` counting allocator, behind `#[cfg(test)]` and allowed by a crate-level exception noted in `AGENTS.md`).

### RF-23. The `undertone` facade: the Rust API

- **Owner:** A. **Size:** M. **Depends on:** RF-15 to RF-22.
- **Objective:** the crate a Rust user depends on: re-exports of the pattern, engine, and scheduler crates under one idiomatic API (a prelude, builders, errors as `Result<_, undertone::Error>`), `render` and `play` entry points, and a guide in rustdoc with runnable examples matching the TypeScript guide's examples.
- **Steps:** (1) `crates/undertone/src/lib.rs` with `pub mod prelude`; (2) one example per guide page under `crates/undertone/examples/` that renders to a WAV; (3) `cargo doc` clean, every public item documented; (4) the layer 4 runner `crates/undertone/tests/corpus_render.rs` over the whole corpus.
- **Acceptance:** every group in [API-MAPPING.md](../API-MAPPING.md) marked done; `cargo run --example getting_started` writes a WAV; corpus green on Rust in full.

### The Rust documentation (this milestone's documentation package, per D-20)

- **Owner:** A. **Size:** S to M. **Depends on:** RF-23.
- **Objective:** the Rust API is documented where the JavaScript API is: a guide section, the API reference, and the README tables.
- **Steps:** (1) a Rust guide section in `docs/guide/rust-*.md`, one page per existing guide page that has a Rust equivalent (start with `rust-getting-started.md`), each with code blocks marked `rust` (not `ts standalone`, which `src/docSnippets.test.ts` executes) and a link to the matching example under `crates/undertone/examples/`; (2) add the pages to `guideSidebar` in `docs/.vitepress/config.mts`; (3) publish `cargo doc` with the site: the Pages workflow builds `cargo doc --no-deps` into `docs/public/rust/` (or a build step beside the site) and the nav links to it; (4) `README.md`'s Usage and API sections gain the Rust API tables (AGENTS.md: update the README when the public API changes); (5) `bun run docs:build` and, if the theme changes, `bun run typecheck:docs`.
- **Files:** `docs/guide/rust-*.md`, `docs/.vitepress/config.mts`, `.github/workflows/gh-pages.yml`, `README.md`.
- **Acceptance:** `bun run docs:build` is green with the new pages and the rustdoc link; no page documents a Rust name that does not exist.
- **Risks:** the live site would show Rust documentation before any crate is published (accepted; the pages say the crates ship with 0.4.0); a Pages workflow change is outward-facing once merged.

## Planned stack

Three pull requests.

| #   | Branch                    | Pull request title                                         | Work package           |
| --- | ------------------------- | ---------------------------------------------------------- | ---------------------- |
| 1   | `feat/scheduler-crate`    | Add the scheduler crate with windowed booking and a clock  | RF-22                  |
| 2   | `feat/undertone-facade`   | Add the `undertone` crate as the Rust API                  | RF-23                  |
| 3   | `docs/rust-guide-and-api` | Document the Rust API in the guide and publish its rustdoc | The Rust documentation |

## Documentation in this milestone

This is the milestone where the Rust documentation lands in full (see the third work package). The rustdoc gate (`missing_docs`, `cargo doc -D warnings`) has applied since M1.

## Agent assignments

The orchestrator assigns Sonnet agents. RF-22 and RF-23 are sequential (the facade re-exports the scheduler); the documentation package can start once the facade's names are stable, and is JavaScript and Markdown work apart from the example checks (not Rust-building beyond `cargo doc`).

## Status log

| Date       | Entry       |
| ---------- | ----------- |
| 2026-11-18 | Not started |
