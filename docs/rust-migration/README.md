# Undertone in Rust: start here

## The goal

1. The next version of Undertone is built from Rust: the audio engine is the product, and Rust gets the full API (a new, idiomatic Rust API in the `undertone` crates).
2. The JavaScript API keeps its package name (`@liminal-hq/undertone`) and its names, reimplemented as a bridge over a WebAssembly build of the Rust, so code written for it works as before, with a native core.
3. Undertone renders without Web Audio: natively (offline and real time), in Node, Bun, Deno, and WASI, and optionally in an `AudioWorklet`; a fully WASM Undertone usable without TypeScript or a browser.
4. This repository becomes the Rust workspace. **Nothing is promoted from elsewhere:** `undertone-pattern` and `undertone-engine` are built from the ground up here, against a conformance corpus recorded from the TypeScript. The lab's crates (`undertone-mini`, `undertone-dsp`) are prior art and a possible test oracle, never a dependency. The lab (liminal-hq-labs/undertone-sound) keeps the supporting actors (song and mix formats, compile, OPL chips, OPX and DOS, the director) and may depend on Undertone after the release.
5. The first release, **0.4.0**, is the Rust-built Undertone with everything the merged TypeScript pull requests #39, #42, and #44 contain; consumers adapt after it, on their own schedule.

## How to read this plan

| File                                         | Read it when                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [README.md](README.md)                       | First (this file): the goal, the working model, the current state, and the status table                           |
| [DECISIONS.md](DECISIONS.md)                 | Before asking the person anything, and whenever a decision is answered (append-only)                              |
| [RISKS.md](RISKS.md)                         | At the start of each milestone                                                                                    |
| [ARCHITECTURE.md](ARCHITECTURE.md)           | Before M1, and whenever you add a crate or a CI job                                                               |
| [CONFORMANCE.md](CONFORMANCE.md)             | Before RF-05, and before each package that lands with corpus cases                                                |
| [API-MAPPING.md](API-MAPPING.md)             | In M3 to M6: the checklist of every name                                                                          |
| [HANDOFFS.md](HANDOFFS.md)                   | When you need something from the person, the lab, or the studio, or finish something they wait for                |
| [milestones/](milestones/M0-plan-on-main.md) | One document per milestone, M0 to M8: objective, work packages RF-nn, the planned pull requests, and a status log |
| [results/](results/)                         | Where spike reports (`R<n>.md`), `DESIGN-ADJUSTMENTS.md`, and `RELEASE.md` are written                            |

The work packages RF-01 to RF-33 each live in exactly one milestone document, in order. A package has an owner, a size, its dependencies, an objective, steps, files, acceptance, risks, and a hand-off.

**Owners:** **A** an agent (Claude Sonnet) assigned by the orchestrator, **P** the person. **Sizes:** S is one or two days, M about a week, L two weeks or more, in agent time.

## Working model

- **The orchestrator** (Claude) plans, writes each brief, assigns Sonnet agents (each in its own git worktree, one work package at a time, in parallel only where dependencies allow), reviews every diff and every gate result itself (never a summary), integrates, and keeps the planning board current. Agent assignments in the milestone documents are left as "orchestrator assigns Sonnet agents".
- **One `gh stack` per milestone**, three to six pull requests, each green on the full gate alone. Pull requests are opened and pushed as work proceeds, so the person can watch them.
- **Merging waits for the person.** A stack is merged atomically from the top with `gh stack merge <top-PR> --yes --merge` (merge commits only; the repository allows nothing else), and only when the person says go. Nothing is merged, tagged, published (npm, crates.io), or released without the person. The merges of #39, #42, and #44 (D-01) were authorised once and do not extend to anything else.
- **Branches** are `<type>/<short-description>`; commits are Conventional Commits with a body written to a file and committed with `git commit -F <file>`; pull request titles start with a capital letter and carry no prefix. See `AGENTS.md`.
- **Clean room:** never read Strudel or Tidal source code; no `@strudel` packages. The reference is this repository's TypeScript at `452f782` and its documentation.
- **Behaviour lands with its corpus cases;** fixtures are never edited by hand.
- **Documentation and site work happens in each milestone, not at the end:** Rust API docs (`cargo doc`, `missing_docs` enforced from M1), JS API docs (TypeDoc re-pointed at the package in M6), a Rust guide section, runtime notes, `README.md` API tables, an audit in M1 (RF-06) of `src/index.ts` exports against `docs/guide/*.md`, and the playground on WASM in M8. Each milestone document lists these as explicit steps.
- **Say what was not verified,** and say plainly when nothing was listened to. Automated tests check graphs and numbers, not how it sounds.
- **The gate before saying a package is done:** its acceptance checks pass and the repository's gate passes: `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`, `bun run typecheck:docs` and `bun run docs:build` when the docs or theme change, and from M1 `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace`.
- **Report** at the end of each pull request and milestone: what changed (paths), the acceptance results, what was not verified, disk and memory figures, and the next step.

### Resource watch

Rust builds eat disk and memory, and this machine has only about 48 GB free. Before and after every agent wave, and whenever a build runs, the orchestrator checks `df -h /home /tmp`, `du -sh` on every worktree's `target/` and on the shared target directory, and `free -h`. Controls: one shared `CARGO_TARGET_DIR` (for example `~/.cache/undertone-target`) for every worktree instead of a `target/` per worktree, with `CARGO_INCREMENTAL=0` and `debug = "line-tables-only"` in the dev profile; at most 2 Rust-building agents at once (JavaScript-only and documentation agents are unlimited), with `CARGO_BUILD_JOBS` capped so linking does not exhaust memory; no new work is launched below 20 GB free disk or 4 GB available memory; worktrees are removed as soon as their pull request is pushed; the shared directory is trimmed (`cargo clean -p`, `cargo sweep`) when it passes about 15 GB, and nothing outside this project's worktrees and cache is ever deleted; spike builds and WebAssembly size experiments run one at a time. Disk and memory figures go into each milestone report.

## Current state (2026-11-18)

- **This repository:** `main` is `452f782`, the **TypeScript reference SHA**. The three stacked pull requests #39, #42, and #44 were merged with `gh stack merge` as merge commits and **nothing was released** (D-01, done): `package.json` is still `0.3.0`, no tag, no npm publish. The live site redeploys from `main`, so it shows the 0.4.0 TypeScript features while npm has 0.3.0. There is no Rust, no plan, and no stack spec on `main` before M0 merges. The old local branch `chore/release-v0.4.0` (`5ac4e69`) is stale (it lacks the review fixes) and will be dropped; the version bump is redone in RF-33 on a fresh branch of the same name. The old plan branch `docs/rust-first-plan` is only a source this plan was copied from. Issue #41 ("Rust core") is the exploration this plan answers; #25 proposes `@liminal-hq/undertone-opl` (an OPL companion, which belongs with the lab).
- **The lab** (`liminal-hq-labs/undertone-sound`, `main` at `26bbb05` when last read): prior art. `undertone-mini` (exact `i128` fractions, a node-tree `Pattern`, the whole mini-notation, the JavaScript number rules) and `undertone-dsp` (every 0.3.0 `VoiceParams` field, voice booking on a `Graph` trait matched to the recorded Web Audio graph, orbits, the master bus, `score()`, an in-house renderer), plus the supporting crates. Licence `Apache-2.0 OR MIT`, Rust 1.98.0, edition 2024. It is read for ideas and may serve as a one-off cross-check; nothing is copied or depended on, and the lab does not need to freeze anything.
- **The studio** (Fizz Audio Studio) depends on the lab's two crates and on `@liminal-hq/undertone` `0.3.0`; it moves on its own schedule after the release.
- **Consumers** pin ranges that will not pick up 0.4.0 (City Sim 1000 `^0.1.1`, the Fizz 1 web game `^0.2.0`, the studio `0.3.0`); see [ARCHITECTURE.md](ARCHITECTURE.md#how-others-depend-on-it-after-the-release).
- **Decided:** see [DECISIONS.md](DECISIONS.md). In short: 0.4.0 is the first Rust-built release (D-02); the crates are `MIT OR Apache-2.0` and the npm package `MIT` (D-03); nothing is promoted, everything is built here (D-05); the layout is a root Cargo workspace beside `src/` (D-15).
- **Not yet decided:** D-06 (the bridge's breaks), D-07 (size budgets), D-08 (runtimes), D-09 (browser default backend), D-10 (publishing), D-11 (dependencies), D-12 (retiring the TypeScript), D-13, D-14, D-17, D-18.

## Status

| Milestone                                                         | Stack (branches `<type>/<short-description>`) | PRs                                                | State              |
| ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- | ------------------ |
| [M0: Plan on main](milestones/M0-plan-on-main.md)                 | `docs/rust-migration-plan` (one pull request) | #45                                                | Merged (`40b2cbf`) |
| [M1: Workspace and oracle](milestones/M1-workspace-and-oracle.md) | stack #49                                     | #46, #47, #48, #51, #52                            | Merged (`36943dc`) |
| [M2: Spikes](milestones/M2-spikes.md)                             | stack #56                                     | #54, #55, #57, #58, #59, #60, #61                  | Merged (`8d06540`) |
| [M3: Pattern core](milestones/M3-pattern-core.md)                 | stack #66 (a6511b9)                           | #63, #64, #65, #67, #68, #70, and the design notes | Merged             |
| [M4: Engine](milestones/M4-engine.md)                             | stack #83                                     | #72, #73, #75, #76, #77, #78, #80, #82, #79        | In review          |
| [M5: Scheduler and facade](milestones/M5-scheduler-and-facade.md) | planned in the milestone document             | none yet                                           | In progress        |
| [M6: JS bridge](milestones/M6-js-bridge.md)                       | planned in the milestone document             | none yet                                           | Not started        |
| [M7: Outputs](milestones/M7-outputs.md)                           | planned in the milestone document             | none yet                                           | Not started        |
| [M8: Site and release](milestones/M8-site-and-release.md)         | planned in the milestone document             | none yet                                           | Not started        |

States: Not started, In progress, In review (pull requests open, waiting for the person), Merged. Update this table in the same pull request that changes a milestone's state.

## Milestones at a glance

| #   | Milestone            | Work packages                           | Done when                                                               |
| --- | -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| M0  | Plan on main         | RF-01, RF-02 (done); plan restructure   | `docs:build` is green and the plan is excluded from the site            |
| M1  | Workspace and oracle | RF-03, RF-04, RF-06, RF-05              | Rust CI jobs green and `conformance:check` passes                       |
| M2  | Spikes               | RF-07 to RF-12; `DESIGN-ADJUSTMENTS.md` | Every spike has `results/R<n>.md`                                       |
| M3  | Pattern core         | RF-13 to RF-17                          | Corpus layers 1 and 2 green on Rust                                     |
| M4  | Engine               | RF-18 to RF-21                          | Corpus layers 3 and 4 green on Rust                                     |
| M5  | Scheduler and facade | RF-22, RF-23                            | The Rust API covers every group in [API-MAPPING.md](API-MAPPING.md)     |
| M6  | JS bridge            | RF-24 to RF-27                          | The TypeScript suite and the corpus pass on the WASM package            |
| M7  | Outputs              | RF-28, RF-29, RF-30                     | Each backend meets its acceptance                                       |
| M8  | Site and release     | RF-31, RF-32, RF-33                     | Published (npm, crates.io) only with the person's approval of each step |

**Gates:** M2's R1 and R9 gate M3. R2 to R5 gate M6. Phases overlap where the dependency tables allow: the bridge for an API group can start as soon as that group's Rust is green, and M7's native output can start after RF-22. Nothing waits on a consumer.

## Where results go

`docs/rust-migration/results/`: `R<n>.md` per spike, `DESIGN-ADJUSTMENTS.md` after M2, `GUIDE-AUDIT.md` from RF-06, and `RELEASE.md` for the release checklist. The folder is created with a `.gitkeep`.
