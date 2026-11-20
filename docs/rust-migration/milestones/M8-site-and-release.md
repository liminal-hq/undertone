# M8: Site and release

## Objective

The site and playground run on the WebAssembly build, the TypeScript source retires, and 0.4.0, the first Rust-built Undertone, is released.

**Depends on:** RF-27 (M6) for the site, RF-27 and RF-31 for retiring the TypeScript, and RF-28 to RF-32 (M7 and this milestone) for the release. **Done when:** the release is published. **Publishing (npm, crates.io) happens only with the person's approval of each step.**

## Work packages

### RF-31. The site and playground on the WASM build

- **Owner:** A. **Size:** M. **Depends on:** RF-27.
- **Objective:** the VitePress site (`docs/`) and the playground run on the bridge package; the guide has Rust examples beside the JavaScript ones; the API reference covers both (TypeDoc for the package, rustdoc for the crates, published with the site since M5).
- **Steps:** (1) the playground imports from `packages/undertone` instead of `../../../../src/index` (`composer.ts`, `importScript.ts`, `pianoRoll.ts`); (2) the docs build runs the WASM build first, and the Pages workflow installs the Rust toolchain and `wasm-bindgen-cli`; (3) a backend switch (Web Audio or worklet) and a stats panel in the playground; (4) `typedoc.json` already points at the package (M6); (5) `bun run typecheck:docs` and `bun run docs:build` green; (6) **documentation:** a final pass over `docs/guide/*.md`, `docs/recipes.md`, and `docs/coming-from-strudel.md` for the Rust and WASM story (loading, runtimes, the Rust crates), and for anything the M1 guide audit left open; (7) before merging, build the site locally and click through every playground group in a real browser, and say whether it was listened to.
- **Acceptance:** `docs:build` green in CI; the playground's examples all evaluate (a test that runs each example's code against the package, extending `importScript.test.ts`).
- **Risks:** the site deploys on every push to `main`; land this only when the bridge passes RF-27, so the live site never runs a half-built bridge. **Rollback:** revert the merge commit; the site builds from `src/` again (possible until RF-32).

### RF-32. Retire the TypeScript source; the release workflow

- **Package names (decided in M6):** the root `package.json` was renamed to the private `@liminal-hq/undertone-reference` so the bridge package in `packages/undertone/` can take `@liminal-hq/undertone`. This package re-points the release workflow (`release.yml` runs `npm pack` and publishes from the repository root today) at `packages/undertone`, and retires or keeps the reference package as the criteria below decide.

- **Owner:** A. **Size:** M. **Depends on:** RF-27, RF-31.
- **Objective:** the TypeScript source is deleted (its history kept; `452f782` is its permanent reference), the corpus stays as committed fixtures, and the release workflow builds the package from Rust.
- **Steps:** (1) confirm the retirement criteria below; (2) **stop (D-12):** tell the person the criteria are met and ask to retire; (3) delete `src/` (moving `src/test-utils/fakeAudioContext.ts` to `packages/undertone/test/`), the root `tsconfig.json`'s library build, and the root `build` script; (4) the recorder keeps working without `src/`: `bun run conformance:record --reference <path>` takes a checkout of the reference, and `scripts/reference-worktree.sh` makes one (`git worktree add <scratch>/undertone-reference 452f782` then `bun install`), since the TypeScript 0.4.0 was never published to npm; (5) the root `package.json` becomes the private workspace root; (6) `release.yml` builds the WASM, builds and packs `packages/undertone`, publishes with the existing manual approval, and (new job) publishes the crates with `cargo publish` in dependency order behind its own environment approval; (7) one version for the crates and the package, bumped together on `chore/release-v<version>`; (8) update `AGENTS.md` (layout, Project Structure, release steps) and `docs/rust-migration/ARCHITECTURE.md` to match.
- **Acceptance:** CI green with no TypeScript library source; `conformance:record --reference` regenerates identical bytes from a reference worktree; `bun pm pack` in `packages/undertone` produces a tarball with the `.wasm`, the JavaScript, and the `.d.ts`; `cargo publish --dry-run` passes for every published crate.
- **Rollback:** revert the deletion commit (history keeps everything).

### RF-33. Release 0.4.0, the first Rust-built Undertone

- **Owner:** A prepares; P approves every outward step. **Size:** S. **Depends on:** RF-28 to RF-32.
- **Objective:** publish the first release of the new Undertone: Rust and WebAssembly inside, the same JavaScript API outside, and everything the merged #39, #42, and #44 added. Its version is **0.4.0** (D-02): it was never published from TypeScript, so the Rust build takes it and the changelog has no phantom release.
- **Release checklist** (all must hold; the orchestrator writes `docs/rust-migration/results/RELEASE.md` with each marked):
  1. Corpus layers 1 to 4 green on Rust and on the package; the property tests pass.
  2. Every public-API and Web Audio test of the reference suite passes on the package, or is changed for a break accepted in D-06.
  3. The API report matches the reference's, except the accepted breaks.
  4. The size budgets (D-07) pass.
  5. The Rust API: every group in [API-MAPPING.md](../API-MAPPING.md) done; `cargo doc` clean; examples run.
  6. Native real-time (RF-28), the worklet backend (RF-29, opt-in), and no-browser rendering (RF-30) meet their acceptance, or their shortfalls are written in the release notes.
  7. The site and playground run on the package (RF-31).
  8. `CHANGELOG.md` has one 0.4.0 entry telling the whole story: "Undertone is now built from Rust and runs its engine in WebAssembly, with a new Rust API (the `undertone` crates); the JavaScript API keeps its names." Then the features (pan paths within a note, `.panpath`, `.panslide`, autopan, the pan law, the master ceiling, windowed booking, signals, patternable controls, the playground and docs), then the breaks D-06 accepted, then "Moving from 0.3" (loading, the minimum runtimes of D-08, anything dropped). The 0.4.0 features are not described as a separate TypeScript release, because there was none.
  9. A release candidate (`0.4.0-rc.1`) was published to npm's `next` tag and tried in a fresh Vite app and a Node script (a smoke test, not a consumer gate).
  10. The person listened to the playground's examples in a real browser and to a native render, and says so.
- **Steps:** (1) **stop (D-10):** the person approves publishing the release candidate to `next` (and whether crates are published at the candidate or only at the release); (2) the checklist; (3) cut a fresh `chore/release-v0.4.0` from `main` (the stale local branch of that name was dropped), bump `package.json`, `packages/undertone/package.json`, and every crate to `0.4.0`, commit `chore: release v0.4.0`; (4) **stop:** the person approves the release pull request, its merge, the tag `v0.4.0`, the npm gate, and the crates.io publish.
- **Acceptance:** `@liminal-hq/undertone@0.4.0` on npm `latest`; the crates on crates.io (if D-10 says so); a GitHub release with the notes.
- **Rollback:** `npm dist-tag add @liminal-hq/undertone@0.3.0 latest` puts 0.3.0 back as `latest` within minutes; a fix goes out as 0.4.1. Never `npm unpublish` without the person.
- **Hand-off:** G-3 in [HANDOFFS.md](../HANDOFFS.md): tell the lab, the studio, and the person (for City Sim 1000, the Fizz web game, and `imf-transcription-lab`, which uses `latest`) that 0.4.0 is out, with the "Moving from 0.3" notes.

## When the TypeScript source retires

The TypeScript in `src/` stays in the tree, unchanged except for reference fixes, until **all** of these hold (RF-32):

1. Every test classified **public API** or **Web Audio** in `conformance/test-classes.json` passes against the bridge (RF-27), or was changed for a break accepted in D-06.
2. Every **internal** test has a named Rust test covering the same behaviour.
3. Corpus layers 1 to 4 are green on Rust and on the package.
4. The API report matches the reference's, except accepted breaks.
5. The site and playground run on the bridge (RF-31).
6. The person says yes (D-12).

Then `src/` is deleted in one commit (history keeps it; `452f782` is the permanent pointer), the fake context moves to `packages/undertone/test/`, and the recorder regenerates from a worktree of the reference SHA when needed.

**How the TypeScript tests are reused against the bridge:** R5 (RF-12) classifies every test; RF-27 copies the public-API and Web Audio test files into `packages/undertone/test/` changing only their imports (`../src/index` to the package entry, the fake context's path), and runs them with Vitest against the built package. Internal tests (of private functions such as the mini-notation tokeniser or the impulse-response builder) are not moved: each is replaced by a Rust unit test, and the classification file names it. The `docSnippets.test.ts` runner moves too and runs every standalone documentation block against the package.

## Planned stack

Three pull requests, one work package each. The release pull request itself (`chore/release-v0.4.0`, the version bump) is cut from `main` after this stack merges and is the person's to approve; it is not part of the stack.

| #   | Branch                                 | Pull request title                                        | Work package |
| --- | -------------------------------------- | --------------------------------------------------------- | ------------ |
| 1   | `feat/site-on-wasm`                    | Run the site and playground on the WebAssembly build      | RF-31        |
| 2   | `chore/retire-typescript-source`       | Retire the TypeScript source and build releases from Rust | RF-32        |
| 3   | `docs/release-checklist-and-changelog` | Prepare the 0.4.0 changelog and release checklist         | RF-33        |

## Documentation in this milestone

- The playground on the WASM build with a backend switch and a stats panel (RF-31).
- The final guide, recipes, and Strudel-comparison pass; Rust examples beside the JavaScript ones; the "Moving from 0.3" notes and the single 0.4.0 changelog entry (RF-33).
- `README.md`, `AGENTS.md`, and [ARCHITECTURE.md](../ARCHITECTURE.md) updated for the retired TypeScript.
- `bun run typecheck:docs` and `bun run docs:build` for every theme, playground, and guide change.

## Agent assignments

The orchestrator assigns Sonnet agents. RF-31 and RF-32 are sequential. The person's steps are marked **stop** above and in [HANDOFFS.md](../HANDOFFS.md).

## Status log

| Date       | Entry       |
| ---------- | ----------- |
| 2026-11-18 | Not started |
