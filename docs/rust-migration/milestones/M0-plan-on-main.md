# M0: Plan on main

## Objective

The plan lives on `main` in `docs/rust-migration/`, one document per milestone, rewritten for D-05 (nothing is promoted), and excluded from the published site. The TypeScript line is closed: #39, #42, and #44 are merged and `main` is the reference.

**Done when:** `bun run docs:build` is green and the plan is excluded from the site (no `rust-migration` page in the build output).

## Work packages

### RF-01. Merge #39, #42, #44 in stack order; do not publish (done)

- **Owner:** A and P. **Size:** S. **Depends on:** nothing. **State: done (D-01, 2026-11-18).**
- **Objective:** the three stacked pull requests, with their review fixes, are merged into `main` as the last TypeScript line. Nothing is released: no version bump, no tag, no npm publish. The merged TypeScript is the **reference implementation**: the 0.4.0 feature specifications the Rust version must implement (pan paths within a note, `.panpath`, `.panslide`, the autopan LFO, the pan law, the master ceiling, windowed booking, signals, patternable controls), and the source of the conformance corpus (its tests, recipes, and documentation examples become corpus programs in RF-05). The first release of the new Undertone is the Rust-built 0.4.0 (RF-33), which contains everything these pull requests contain.
- **What happened:** the three pull requests were merged with `gh stack merge`, as merge commits, in stack order. The repository allows merge commits only and deletes head branches on merge. `main` is now `452f782` ("Let patterns drive any control with signals, in the Strudel style (#44)"): **the TypeScript reference SHA**. `package.json` stays `0.3.0`; there is no tag and nothing was published. The live site redeployed from `main` with #42's and #44's docs and playground (signals, the new playground examples) while npm still has 0.3.0.
- **Steps recorded for the log:** (1) the stack's ancestry and CI were checked; (2) the local gate was run on each head; (3) the person confirmed (D-01); (4) the merges were made in order; (5) the reference SHA was recorded here and in [README.md](../README.md); (6) the stale local `chore/release-v0.4.0` (`5ac4e69`, never pushed, no pull request, lacking #39's review fixes) is dropped when the person next switches the main checkout off it, and its only content, the version bump, is redone in RF-33 on a fresh branch of the same name cut from `main`. `package.json` stays at `0.3.0` until RF-33.
- **Files:** none (GitHub merges only).
- **Acceptance (met):** `main` contains #39, #42, and #44 as merge commits in that order; nothing was tagged or published; the reference SHA is recorded.
- **Risks:** the live site shows 0.4.0 features while npm has 0.3.0, so a reader may try a 0.4.0 feature against the published 0.3.0. Accepted for the weeks until RF-33; the option remains of a one-line homepage note ("the features marked 0.4.0 arrive in the next release") in a small `docs:` pull request, if the person wants it.
- **Hand-off:** G-1 in [HANDOFFS.md](../HANDOFFS.md): tell the lab and the studio the reference SHA and that 0.4.0 will be the Rust-built release.

### RF-02. Confirm the decisions that block the start (done)

- **Owner:** P, prepared by A. **Size:** S. **Depends on:** nothing. **State: done (2026-11-18).**
- **Objective:** the person's answers to the decisions marked "before start": D-02 (the release's version), D-03 (licence), D-05 (the lab: changed to "nothing is promoted"), D-15 (layout), and the superseded D-04 and D-16.
- **Outcome:** answered and recorded in [DECISIONS.md](../DECISIONS.md): D-01 done, D-02 0.4.0, D-03 `MIT OR Apache-2.0` for the crates and `MIT` for the npm package, D-04 and D-16 superseded, D-05 changed, D-15 Option A. D-19 (the working model) and D-20 (documentation in every milestone) were added.
- **Files:** `docs/rust-migration/DECISIONS.md`.
- **Acceptance (met):** every "before start" decision has an answer with a date.
- **Hand-off:** none: the lab has nothing to freeze.

### The plan restructure (this milestone's own work, not an RF package)

- **Objective:** copy the Rust-first plan from the old branch, restructure it into one document per milestone, and rewrite it for D-05.
- **Steps:** (1) branch `docs/rust-migration-plan` from `origin/main` (never from the old plan branch); (2) create `docs/rust-migration/` with `README.md`, `DECISIONS.md`, `RISKS.md`, `ARCHITECTURE.md`, `CONFORMANCE.md`, `API-MAPPING.md`, `HANDOFFS.md`, `milestones/M0` to `M8`, and `results/.gitkeep`; (3) split the old `PLAN.md` by milestone, drop the generic phase prose and the agent prompt, and delete the history-import procedure and its hand-offs; (4) add `srcExclude: ['rust-migration/**']` to `docs/.vitepress/config.mts`; (5) add `docs/rust-migration/` to the Repository Layout list in `AGENTS.md`; (6) check that every RF-01 to RF-33 appears in exactly one milestone document and that no internal link is dead; (7) run the gate.
- **Files:** `docs/rust-migration/**`, `docs/.vitepress/config.mts`, `AGENTS.md`.
- **Acceptance:** `bun run format:check` and `bun run docs:build` are green; the build output holds no `rust-migration` page; the plan renders on GitHub with working links.
- **Not verified here:** how the plan reads on the rendered pull request page (a person's check).

## Planned stack

One pull request (a stack of one: M0 is documentation only).

| #   | Branch                     | Pull request title                                  | Covers                                                          |
| --- | -------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `docs/rust-migration-plan` | Add the Rust migration plan, organised by milestone | The plan restructure, `srcExclude`, the `AGENTS.md` layout line |

The planning board is synced after the pull request is pushed (a board update, not a pull request). Merging is not a `gh stack merge` (a stack of one merges with `gh pr merge --merge`) and waits for the person.

## Documentation in this milestone

The plan itself. `docs:build` proves the site is unaffected.

## Agent assignments

The orchestrator assigns Sonnet agents.

## Status log

| Date       | Entry                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-18 | Merged as #45 (`40b2cbf`). D-01 done: #39, #42, #44 merged, `main` at `452f782`. Decisions D-02 to D-05, D-15, D-16, D-19, D-20 recorded. Plan restructured. |
