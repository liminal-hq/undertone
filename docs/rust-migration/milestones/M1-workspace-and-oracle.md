# M1: Workspace and oracle

## Objective

The repository has a Rust workspace with two empty crates, Rust is checked on every pull request the way the TypeScript is, the public surface of the TypeScript reference is committed as an API report (and audited against the guide), and a versioned conformance corpus recorded from the TypeScript at `452f782` is the oracle everything later is held to.

**Depends on:** M0. **Done when:** the Rust CI jobs are green and `bun run conformance:check` passes in CI.

## Work packages

### RF-03. Scaffold the Rust workspace and two empty crates

- **Owner:** A. **Size:** S to M. **Depends on:** RF-02 (D-03, D-05, D-15).
- **Objective:** a root Cargo workspace with two empty crates, `undertone-pattern` and `undertone-engine`, built from nothing: no code, history, or fixtures come from the lab or the studio (D-05). From this commit on, engine work happens only here.
- **Steps:** (1) the root `Cargo.toml` (`resolver = "3"`, `members = ["crates/*"]`, edition 2024, `[workspace.package]` with `license = "MIT OR Apache-2.0"` and the repository URL, `[workspace.lints]` with `unsafe_code = "forbid"` and `missing_docs = "warn"`, and a dev profile with `debug = "line-tables-only"`); (2) `rust-toolchain.toml` pinning a current stable (the lab pins 1.98.0: take the same or newer if installed, with `rustfmt` and `clippy` components); (3) `rustfmt.toml` with `hard_tabs = true`; (4) `deny.toml` allowing only permissive licences (Apache-2.0, MIT, BSD, ISC, Zlib, Unicode-3.0, CC0, 0BSD) and crates.io as the only source; (5) `crates/undertone-pattern` and `crates/undertone-engine`, each with a `Cargo.toml` (`lints.workspace = true`, `publish` left to D-10, `undertone-engine` depending on `undertone-pattern` by path with a version), a `src/lib.rs` holding the licence header from `AGENTS.md` (`MIT OR Apache-2.0`), a crate-level doc comment saying what the crate is for, and one trivial doc-tested item so the test and doc jobs have something to run; (6) `LICENSE-MIT` and `LICENSE-APACHE` at the root (the existing `LICENSE` stays); (7) `target/` added to `.gitignore`, `.prettierignore`, and the ESLint ignores in `eslint.config.js`; (8) `Cargo.lock` committed; (9) a note in `README.md`'s Development section that a Rust toolchain is needed for the crates (the full conventions are RF-04's).
- **Files:** `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `rustfmt.toml`, `deny.toml`, `LICENSE-MIT`, `LICENSE-APACHE`, `crates/undertone-pattern/**`, `crates/undertone-engine/**`, `.gitignore`, `.prettierignore`, `eslint.config.js`.
- **Acceptance:** `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace` (or `cargo test --workspace`), `cargo doc --no-deps`, and `cargo deny check` all pass locally; the TypeScript gate still passes (`bun run test`, `lint`, `format:check`, `build`, `docs:build`), so nothing in the TypeScript line notices the crates; `git ls-files` shows no file from the lab or the studio.
- **Risks:** Prettier or ESLint scanning `target/` (add the ignores and check with `bun run lint` and `bun run format:check` after a Rust build); a shared `CARGO_TARGET_DIR` and the machine's disk (see the resource watch in [README.md](../README.md#resource-watch)).
- **Hand-off:** none.

### RF-04. Rust CI, conventions, and `AGENTS.md`

- **Owner:** A. **Size:** M. **Depends on:** RF-03.
- **Objective:** Rust is checked on every pull request the way the TypeScript is, and the repository's conventions cover Rust.
- **Steps:**
  1. Add jobs to `.github/workflows/ci.yml`, one per check as today: Rust format (`cargo fmt --all -- --check`), Clippy (`cargo clippy --workspace --all-targets --locked -- -D warnings`), tests (`cargo nextest run --workspace --locked`), doc tests, `cargo doc --no-deps` with `RUSTDOCFLAGS=-D warnings` (so `missing_docs` and broken links fail the build), `cargo deny check licenses bans sources advisories`, a `wasm32-unknown-unknown` build of the two crates, and a layering check (`scripts/check-layering.sh`, written new, with its licence header): `undertone-pattern` depends on no other workspace crate, `undertone-engine` only on `undertone-pattern`, and no crate depends on anything outside crates.io (no git or path dependency on the lab or the studio).
  2. Run the Rust jobs in the shared `ghcr.io/liminal-hq/ci-rust` image, pinned by digest (the `liminal-hq/.github` images are public; the pin comes from `docs/reference/recommended-image-pins.md` there, `sha256:0ef31efa...` on 2026-11-10). The image provides Rust 1.98.0 (matching `rust-toolchain.toml`), rustfmt, Clippy, `cargo-nextest`, `cargo-deny`, `git`, and `jq`, but no Node and no `wasm32` target: the wasm job runs `rustup target add wasm32-unknown-unknown`. Pin action versions as the existing workflows do; no Cargo cache to begin with. The existing TypeScript jobs move to the shared `ci-web` image, pinned the same way, with the same commands.
  3. Measure the Rust jobs' wall time on the first CI run (this is spike R13's question, folded in here); if a warm pull request run exceeds 10 minutes, restrict the Rust jobs to paths under `crates/`, `conformance/`, `packages/`, and `Cargo.*` and run everything nightly.
  4. Update `AGENTS.md`: the layout (`crates/`, `conformance/`, later `packages/`), the licence header rule extended to `.rs` (the `//` header with the SPDX identifier `MIT OR Apache-2.0`) and to new `.ts` in `packages/` and `conformance/`, the Rust commands (`cargo fmt`, `clippy`, `nextest`, `doc`), the rule that engine changes need a corpus case, that a change to synthesis needs a recorded-graph or render test, and the resource-watch rules (shared `CARGO_TARGET_DIR`, at most 2 Rust-building agents). Keep it short.
  5. Add a "Development" note for Rust to `README.md`.
  6. **Documentation:** `cargo doc` with `-D warnings` is the Rust API docs gate from here on; every public item in both crates is documented (`missing_docs`).
- **Files:** `.github/workflows/ci.yml`, `scripts/check-layering.sh`, `AGENTS.md`, `README.md`.
- **Acceptance:** CI is green on the pull request with every new job; `AGENTS.md` describes the new layout; a deliberate formatting error in a Rust file fails the format job (try it locally).
- **Risks:** CI cost (see step 3).
- **Hand-off:** none.

### RF-06. The API report of the 0.4.0 reference, and the guide audit

- **Owner:** A. **Size:** S to M. **Depends on:** RF-01. (This is spike R14 folded in, plus the documentation audit of D-20.)
- **Objective:** a committed snapshot of the reference's public TypeScript surface (the merged 0.4.0 TypeScript) that the bridge package is checked against, so every difference is a reviewed diff; and an audit of what the guide leaves undocumented today.
- **Steps:**
  1. Try `@microsoft/api-extractor` on `dist/index.d.ts` (one config file, a dev dependency).
  2. If its output is noisy or heavy, use a normalised declaration snapshot instead (`tsc --emitDeclarationOnly` into a temporary directory, then a small script under `conformance/api/` that prints every exported name with its declaration, sorted).
  3. Commit the report as `conformance/api/undertone.api.md` (or `.d.ts`); add `api:check`, which regenerates and diffs it, to CI.
  4. **Documentation audit:** compare every export of `src/index.ts` against `docs/guide/*.md`, `docs/recipes.md`, and `README.md`'s API tables, and write `docs/rust-migration/results/GUIDE-AUDIT.md`: each export, where it is documented (or "not documented"), and whether it has a `ts standalone` example. Fill small gaps in the guide in the same pull request; list the larger ones for the milestone that touches the area (the Rust guide in M5 and the bridge docs in M6 build on a complete JavaScript guide).
  5. Run `bun run docs:build` if any guide page changes (and `bun run test`, which runs `docSnippets.test.ts` over the `ts standalone` blocks).
- **Files:** `conformance/api/**`, `package.json`, CI, `docs/rust-migration/results/GUIDE-AUDIT.md`, any guide pages the audit fixes.
- **Acceptance:** a one-method change to a scratch copy produces a one-hunk diff; the check runs in under 10 s; `GUIDE-AUDIT.md` lists every export.
- **Risks:** none of note; guide edits stay small and are listed, not silently broad.
- **Hand-off:** none.

### RF-05. Conformance corpus v1: format, recorder, first subset

- **Owner:** A. **Size:** M. **Depends on:** RF-01 (the reference SHA), RF-03 (the workspace and ignores). **No fixtures are imported:** the corpus, regenerated from the TypeScript at `452f782`, is the only oracle.
- **Objective:** a versioned corpus, generated from the TypeScript reference, that Rust and (later) the WASM package are held to byte for byte. The full specification is [CONFORMANCE.md](../CONFORMANCE.md).
- **Steps:**
  1. Write `conformance/README.md` from [CONFORMANCE.md](../CONFORMANCE.md)'s format section.
  2. Write the recorder in TypeScript under `conformance/recorder/` (`programs.ts` for layer 1, `controls.ts` for layer 2, `graph.ts` for layer 3), importing the reference from `../../src/index` (until RF-32) and writing `conformance/cases/<layer>/<group>.json`. Programs are data (see [CONFORMANCE.md](../CONFORMANCE.md#programs-as-data)); the interpreter that turns a program into calls is `conformance/recorder/interpret.ts`.
  3. Write the graph recorder: `src/test-utils/fakeAudioContext.ts` already records node graphs; emit the layer 3 format in [CONFORMANCE.md](../CONFORMANCE.md#prior-art-the-earlier-fixtures-not-imported) (nodes numbered in creation order, params as call strings, buffers, waves; numbers to nine significant digits). Prove the baseline: with the 0.4.0 options off, the recorded graph is the same as `v0.3.0`'s (cross-check against a worktree of the `v0.3.0` tag, once).
  4. Write the first subset: 300 programs for R1 (see RF-07) and 40 graph cases for the 0.4.0 options (see RF-18). Draw them from what the merged pull requests already hold: the reference's tests (`src/*.test.ts`, especially `panPath`, `autopan`, `panLaw`, `masterBus`, `render`, `signal`, `controlSignals`), the recipes (`docs/recipes.md`), the guide's standalone snippets (the blocks `docSnippets.test.ts` runs), and the playground's example groups (`docs/.vitepress/theme/playground/examples/`). Each case records where it came from in its `from` field ([CONFORMANCE.md](../CONFORMANCE.md#where-the-programs-come-from)).
  5. Scripts in `package.json`: `conformance:record` (regenerates everything) and `conformance:check` (regenerates in memory and fails on any difference), and a CI job running `conformance:check`. Running the recorder twice writes identical bytes.
  6. A property check against the reference with `fast-check` (a dev dependency) for window independence, inverses, and signals (properties 1 to 3 in [CONFORMANCE.md](../CONFORMANCE.md#query-window-independence-and-property-tests)), to catch a property that the reference itself breaks.
  7. **Documentation:** `conformance/README.md` is the corpus format document; mention `conformance:record` and `conformance:check` in `AGENTS.md`'s Testing section.
- **Files:** `conformance/**`, `package.json`, `.github/workflows/ci.yml`, `tsconfig.json` or a `conformance/tsconfig.json`, `eslint.config.js` (include `conformance/`), `.prettierignore` if a case file's bytes must not be reformatted (check: the recorder writes the bytes Prettier would, or the cases are ignored).
- **Acceptance:** `bun run conformance:check` passes in CI; running `conformance:record` twice writes identical bytes; the baseline graph equals `v0.3.0`'s with the options off; the format is versioned (`"corpus": 1` in every file).
- **Risks:** the reference's recorded order of haps is internal (sort as the format specifies); JavaScript number formatting (write numbers the way JavaScript prints them; the Rust side needs `js::number_to_string`, written in RF-07); `Math.random` anywhere in the reference would make the corpus unstable (seed everything; the engine's noise is already seeded); a recorder that grows too slow for CI (keep the first subset small, measure).
- **Hand-off:** none.

## Planned stack

Four pull requests, in this order (each green on the full gate alone, merged atomically from the top with `gh stack merge <top-PR> --yes --merge` when the person says go).

| #   | Branch                             | Pull request title                                             | Work package |
| --- | ---------------------------------- | -------------------------------------------------------------- | ------------ |
| 1   | `build/rust-workspace-scaffold`    | Add the Rust workspace with two empty crates                   | RF-03        |
| 2   | `ci/rust-checks`                   | Check Rust in CI and extend the repository conventions to Rust | RF-04        |
| 3   | `docs/api-report-and-guide-audit`  | Snapshot the public API and audit the guide against it         | RF-06        |
| 4   | `test/conformance-corpus-recorder` | Add the conformance corpus recorded from the TypeScript        | RF-05        |

## Documentation in this milestone

- `missing_docs` and `cargo doc -D warnings` enforced from the scaffold (RF-03, RF-04); every public item documented.
- The audit of `src/index.ts` exports against `docs/guide/*.md` (RF-06) and the small gaps it finds fixed.
- `conformance/README.md` (RF-05), the Rust notes in `README.md` and `AGENTS.md`.
- `bun run docs:build` runs when a guide page changes.

## Agent assignments

The orchestrator assigns Sonnet agents. RF-03 first; RF-04 and RF-06 can follow in parallel on separate worktrees (RF-06 is JavaScript only; RF-04 builds Rust, so at most two Rust-building agents at once); RF-05 starts once RF-03's ignores are in.

## Status log

| Date       | Entry                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-18 | Not started                                                                                                                                        |
| 2026-11-18 | RF-04 used the public `ci-rust` image, pinned by digest, in place of `dtolnay/rust-toolchain`; CI behaviour unverified until the pull request runs |
