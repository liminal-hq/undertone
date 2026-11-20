# AGENTS.md

## Coding Standards

- **Spelling:** Use Canadian English for comments, documentation, commit messages, and pull request descriptions unless exact external spelling is required by tooling, APIs, or published identifiers.
- **Unsafe code:** the Rust workspace forbids `unsafe_code`. Only the scheduler's allocation test may use `unsafe`: `crates/undertone-sched/tests/allocation.rs` is a test-only counting global allocator, and `undertone-sched` has its own `[lints]` table that mirrors the workspace's with `unsafe_code = "deny"` (a `forbid` cannot be lowered by an inner `#![allow]`) so that one file can opt in with a safety comment. Nothing under `src/` in any crate may use `unsafe`, and CI enforces it: `scripts/check-layering.sh` fails on `unsafe` blocks, fns, impls, traits, or externs and on `allow(unsafe_code)` or `expect(unsafe_code)` anywhere under `crates/*/src` (comment lines are ignored). Do not add a second exception without recording it here.
- **Naming:** Keep public API names outcome-focused and readable, matching the existing Strudel-flavoured vocabulary (`note`, `sound`, `stack`, `.attack`/`.decay`/`.sustain`/`.release`, `.lpf`/`.lpenv`).

## Repository Layout

- `src/`: library source — pattern query core (`pattern.ts`) with exact rational time (`fraction.ts`), mini-notation parser (`mini.ts`), note()/sound()/n()/chord()/s() constructors (`control.ts`), synth engine (`engine.ts`), playback scheduler (`scheduler.ts`), multichannel placement (`surround.ts`), pan automation inside a note and pan laws (`panPath.ts`), autopan and the pan slide (`autopan.ts`), note-name/MIDI parsing (`pitch.ts`), named scales (`scale.ts`), chord symbols + voicing (`chord.ts`), bring-your-own-assets sample registry (`samples.ts`), per-orbit reverb/delay buses (`effects.ts`), noise generation (`noise.ts`), seeded random sources (`random.ts`), offline rendering (`render.ts`), WAV encoding (`wav.ts`), shared types (`types.ts`), public exports (`index.ts`)
- `crates/`: the Rust workspace (root `Cargo.toml`) — `undertone-pattern` (pattern core), `undertone-engine` (synth engine), `undertone-sched` (windowed booking, clock, and transport), and `undertone` (the facade a Rust user depends on: the prelude, `Error`, `Player`, `render` and `render_to_wav`, one example per guide page under `examples/`, and `tests/corpus_render.rs`, the whole-corpus runner; it may depend on the other three and nothing depends on it); `conformance/` (the corpus and its recorder) and `packages/` (the npm package and the other bindings) arrive in later milestones of the Rust migration
- `scripts/`: repository checks, such as `check-layering.sh` for the crate layering rules
- `src/test-utils/`: hand-written Web Audio fakes shared by the test suite; excluded from the published build
- `.github/workflows/`: CI (`ci.yml`) and GitHub Pages deployment (`gh-pages.yml`)
- `assets/`: authored visual assets (`hero.svg`, `icon.svg`)
- `docs/`: the VitePress documentation site and the deployed playground — homepage (`index.md`), the narrative guide split by topic (`guide/*.md`), `recipes.md`, `coming-from-strudel.md`, the TypeDoc-generated API reference (`api/`, gitignored, rebuilt by `bun run docs:api`), the interactive playground (`playground.md` + its component and logic under `.vitepress/theme/`), and site config (`.vitepress/`); `README.md` stays the quick-reference API tables
- `docs/rust-migration/`: the plan to rebuild Undertone in Rust and WebAssembly — `README.md` (goal and status table), `DECISIONS.md`, `RISKS.md`, `ARCHITECTURE.md`, `CONFORMANCE.md`, `API-MAPPING.md`, `HANDOFFS.md`, one document per milestone under `milestones/`, and `results/` for spike and release reports; excluded from the published site by `srcExclude` in `docs/.vitepress/config.mts`

## Commit Messages

**Requirement:** Use Conventional Commits format (for example: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `ci: ...`, `build: ...`).

- Use `test:` for test-only changes, including fixes to tests themselves.
- Keep each commit focused on the specific unit of work completed in that commit.

Body requirements:

- Explain what changed and why.
- Use markdown where helpful: `code`, **bold**, flat bullets.
- Do not use markdown headings inside commit bodies.

Shell safety:

- Do not pass markdown-heavy commit bodies directly through `git commit -m "..."` when they contain backticks, `$()`, or other shell-sensitive characters.
- Prefer writing the message to a file and committing with `git commit -F <file>`.
- Verify the stored commit message with `git log -1 --pretty=fuller` and amend immediately if shell interpolation altered it.

## Pull Request Titles

- Start with a capital letter.
- Do not use Conventional Commit prefixes in PR titles.
- Describe the outcome or behaviour change, not internal implementation process.

## Pull Request Content

Use this default structure:

- `## Summary`
- optional `### User-facing changes`
- optional `### Maintainer-facing changes`
- optional `### Documentation`
- optional `### Known limitations`
- `## Test plan`

- Under `## Summary`, use flat bullets with **bold** lead-ins.
- Under `## Test plan`, use checklist bullets (`- [x]` / `- [ ]`) with concrete commands. If a change to synthesis behaviour wasn't manually listened to in a browser, say so plainly — automated tests assert the Web Audio node graph and automation timing, not perceived sound.

## Pull Request Labels

Primary categories: `enhancement`, `bug`, `documentation`, `testing`, `ci`, `chore`.

## Git Workflow

- Do not force-push unless explicitly requested by the user. Pushing a branch and opening its pull request as the work proceeds is expected when the user has asked for it (for example, for a milestone's stack); merging, tagging, and publishing always wait for the user's explicit go.
- **Rebase, never merge `main` in.** When a branch conflicts with `main`, rebase it onto `main`; do not merge `main` into it.
- **Stacked pull requests:** open a stack with `gh stack` (`gh stack init`, then `gh stack submit`). It creates generic draft pull requests, so rewrite each title and body to the patterns in this file, add labels, and take the pull requests out of draft once their checks pass. Merge a stack atomically from the top with `gh stack merge <top-PR> --yes --merge`, only when the user says go. Run `gh pr edit` and similar commands from inside the repository.
- **Shared CI images:** run CI jobs in the shared `ghcr.io/liminal-hq/ci-*` images from `liminal-hq/.github` (public), pinned by digest from its `docs/reference/recommended-image-pins.md`, wherever one fits. If an image is too heavy or lacks something, record the request as an issue in `liminal-hq/.github` instead of working around it silently.
- **Orchestrated work:** when an orchestrating agent assigns other agents, run about two at a time (never more than three), review every diff and gate result itself, and watch disk and memory (use one shared `CARGO_TARGET_DIR`, remove worktrees once their branch is pushed).
- Use focused commits with clear messages describing the change just made, not the whole branch history.
- **Branch naming:** `<type>/<short-description>`, where `<type>` matches the commit-message Conventional Commit type (`feat`, `fix`, `docs`, `test`, `ci`, `build`, `chore`) — for example `feat/composer-live-playground`. Include an issue number when the branch addresses a filed issue: `fix/issue-<number>-<short-description>` (for example, `fix/issue-19-wsl2-deb-runtime`). For release prep, use `chore/release-v<version>` (for example, `chore/release-v0.0.4`).
- Decide the branch name before the first push / PR creation. Do not rename a branch that already has an open pull request — GitHub closes the PR rather than repointing it to the new ref, and the closed PR cannot be reopened without recreating a branch with the exact original name.

## Testing

- Run `bun run test`, `bun run lint`, `bun run format:check`, and `bun run build` before considering work complete.
- Run the Rust checks CI runs, with a shared target directory: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo nextest run --workspace --locked`, `cargo test --doc --workspace --locked`, `scripts/build-rust-docs.sh` (the one place for the `cargo doc` flags: `-D warnings`, the `0.4.0 (pre-release)` crate version label, and the Undertone site bar and theme from `docs/rustdoc/`; CI and the Pages workflow use it, and `scripts/check-rust-docs.sh` fails on a page without the bar), `cargo deny check`, and `scripts/check-layering.sh`.
- The `undertone-pattern` property tests run 10,000 cases per property by default (about 70 seconds in a debug build); set `PROPTEST_CASES` (for example `PROPTEST_CASES=1000`) to run fewer. Pull request CI sets 1,000 and pushes to `main` run the full 10,000.
- CI posts test results to pull requests through `pr-results` (`.github/workflows/publish-test-results.yml`, settings in `.github/pr-results.toml`); nextest uses the `ci` profile from `.config/nextest.toml` and CI runs `bun run test:ci` for vitest JUnit. Locally, plain `bun run test` and `cargo nextest run` are unchanged. Keep the `job` names in the settings in step with the job `name:` fields in `ci.yml`.
- Run `bun run typecheck:docs` and `bun run docs:build` when `docs/.vitepress/theme/` or `docs/playground.md` changes.
- The Rust guide pages play the real output of their examples (`<RustAudio example="..." />`). CI renders it with `scripts/render-rust-audio.sh` and the site build downloads it into `docs/public/rust-audio/` (git-ignored); run the script locally (under a memory cap) to hear it in `bun run docs:dev`. A missing file is not an error: the component says the audio is built by CI.
- A `ts standalone` block that cannot run live (it renders offline, makes its own `AudioContext`, or needs sample files) is marked `ts standalone audio=NAME`, named in `docs/audio/manifest.json`, and gets a `<TsAudio name="NAME" />` player under it. CI renders the audio with `scripts/render-ts-audio.ts` (`bun run docs:audio`, which needs `libasound.so.2` on Linux) and the site build downloads it into `docs/public/ts-audio/` (git-ignored); `scripts/check-ts-audio.sh` keeps the markers, the manifest and the files in step. It is illustrative, not a conformance reference (D-39).
- Run `bun run conformance:check` after any change to `src/` that could alter patterns, controls, or the recorded graph: it regenerates the conformance corpus in memory and fails on any difference. Regenerate with `bun run conformance:record` and review the diff of `conformance/cases/` (see `conformance/README.md`); never edit a case by hand.
- Engine/synthesis changes need a test against the fake `AudioContext` in `src/test-utils/fakeAudioContext.ts` asserting the resulting node graph and automation calls — not just that the code runs.
- Engine changes in the Rust crates need a conformance corpus case (once `conformance/` exists); a change to synthesis needs a recorded-graph or render test.
- Rust builds are heavy: export one shared `CARGO_TARGET_DIR` (and `CARGO_INCREMENTAL=0`) instead of a `target/` per worktree, run one cargo build at a time, and have at most two Rust-building agents at once (see the resource watch in `docs/rust-migration/README.md`).
- State explicitly when a change hasn't been listened to in a real browser; automated tests cannot verify perceived sound quality.

## Documentation

- When the public API changes, update `README.md`'s Usage/API sections in the same change.
- Mark a documentation code block that runs as written (its own imports, everything defined, something played or rendered) with ` ```ts standalone `. `src/docSnippets.test.ts` executes every such block in `README.md` and `docs/` against the fake `AudioContext`; a block that is only a fragment stays a plain `ts` block. It also checks that a playground example returning a `score()` pattern sets the `bpm` that matches the score's `cps` (`bpm = 240 × cps`).
- A fenced block tagged `ts live` renders on the site as an editable example with Play, Stop and Reset buttons (`docs/.vitepress/theme/live/`, `LiveExample.vue`); it is opt-in, and `src/docSnippets.test.ts` runs it exactly like a `ts standalone` block (imports what it uses, plays something), plus through the site's runner. Use it only for short, audible blocks that need no samples, hardware or offline render, and keep them free of TypeScript-only syntax because the browser runner has no compiler. Two more fences give a fragment the same player: `ts play` (an expression or a few lines that build a pattern; the player adds the imports it uses, evaluates the last expression and loops it) and `mini` (a bare mini-notation string, played as `note()` pitches or else `sound()` sounds); the page shows the code as written, and the test suite wraps and plays each one. Every example that makes sound should have one of the three; leave a block static when it needs samples or files, creates its own `AudioContext`, renders offline, or only prints.
- Do not manually hard-wrap markdown prose — write each paragraph as one line and let the renderer/editor soft-wrap.

## Project Structure

- TypeScript library, zero runtime dependencies, built on the Web Audio API.
- The Rust crates in `crates/` are checked by `cargo` (pinned in `rust-toolchain.toml`), with hard tabs from `rustfmt.toml`.
- Package manager: `bun`. Tests: `vitest`. Lint/format: `eslint` + `prettier`. Build: `tsc` (emits `dist/`, declarations included).
- **Package names:** the TypeScript library in `src/` (the root `package.json`) is the internal, private reference `@liminal-hq/undertone-reference`: the conformance corpus is recorded from it, the docs and playground run on it until the bridge replaces it, and it is never published. `@liminal-hq/undertone` is the public name; it belongs to the WebAssembly bridge package in `packages/undertone/` (M6, RF-25), which takes the name when it is switched in. The release workflow below still describes the TypeScript release path and is re-pointed at the bridge package in RF-32.
- Releases (until RF-32 re-points them): to release: bump `version` in `package.json` on a `chore/release-v<version>` branch, merge to `main`, then push a matching `vX.Y.Z` tag (or run the "Release" workflow via `workflow_dispatch`). CI verifies the build, attaches the npm tarball to a GitHub release, and publishes to npm — the npm publish step waits for manual approval on the `npm-publish` environment in the Actions UI before it runs.

## Licence and Copyright

- **Requirement:** New source files (and substantially rewritten source files) should include a short header as the first content in the file.
- **Applies to:** `.ts` files in `src/`, `docs/.vitepress/theme/`, and (as they arrive) `packages/` and `conformance/`, and `.rs` files in `crates/`.
- **Do not add headers to:** generated files (`dist/`), lockfiles, config files (`.json`, `.yml`), markdown docs, or the SVG asset.
- **Licence by area:** the TypeScript package (`src/`, `docs/.vitepress/theme/`, `packages/`, `conformance/`) is `MIT`; the Rust crates are `MIT OR Apache-2.0` (D-03), and so are the few configuration files that carry a header (`.config/nextest.toml`, `.github/pr-results.toml`, `.github/workflows/publish-test-results.yml`, and `scripts/`).

Preferred header format for TypeScript:

```ts
// Brief one-line summary of what this file does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
```

Rust files use the same shape with the crates' licence, `MIT OR Apache-2.0`:

```rust
// Brief one-line summary of what this file does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0
```

- Keep the summary to one concise sentence.
- Place the header before `import` (or `use`) statements.
- Leave one blank line between the header and the first code line.
- Preserve existing valid licence headers when already present.
