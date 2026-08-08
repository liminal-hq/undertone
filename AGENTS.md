# AGENTS.md

## Coding Standards

- **Spelling:** Use Canadian English for comments, documentation, commit messages, and pull request descriptions unless exact external spelling is required by tooling, APIs, or published identifiers.
- **Naming:** Keep public API names outcome-focused and readable, matching the existing Strudel-flavoured vocabulary (`note`, `sound`, `stack`, `.attack`/`.decay`/`.sustain`/`.release`, `.lpf`/`.lpenv`).

## Repository Layout

- `src/`: library source — pattern query core (`pattern.ts`) with exact rational time (`fraction.ts`), mini-notation parser (`mini.ts`), note()/sound()/n()/chord()/s() constructors (`control.ts`), synth engine (`engine.ts`), playback scheduler (`scheduler.ts`), multichannel placement (`surround.ts`), note-name/MIDI parsing (`pitch.ts`), named scales (`scale.ts`), chord symbols + voicing (`chord.ts`), bring-your-own-assets sample registry (`samples.ts`), per-orbit reverb/delay buses (`effects.ts`), noise generation (`noise.ts`), shared types (`types.ts`), public exports (`index.ts`)
- `src/test-utils/`: hand-written Web Audio fakes shared by the test suite; excluded from the published build
- `demo/`: the local dev server and deployed GitHub Pages playground; not part of the published package
- `.github/workflows/`: CI (`ci.yml`) and GitHub Pages deployment (`gh-pages.yml`)
- `assets/`: authored visual assets (`hero.svg`)

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

- Do not push or force-push unless explicitly requested by the user.
- Use focused commits with clear messages describing the change just made, not the whole branch history.

## Testing

- Run `bun run test`, `bun run lint`, `bun run format:check`, and `bun run build` before considering work complete.
- Run `bun run typecheck:demo` and `bun run build:demo` when `demo/` changes.
- Engine/synthesis changes need a test against the fake `AudioContext` in `src/test-utils/fakeAudioContext.ts` asserting the resulting node graph and automation calls — not just that the code runs.
- State explicitly when a change hasn't been listened to in a real browser; automated tests cannot verify perceived sound quality.

## Documentation

- When the public API changes, update `README.md`'s Usage/API sections in the same change.
- Do not manually hard-wrap markdown prose — write each paragraph as one line and let the renderer/editor soft-wrap.

## Project Structure

- TypeScript library, zero runtime dependencies, built on the Web Audio API.
- Package manager: `bun`. Tests: `vitest`. Lint/format: `eslint` + `prettier`. Build: `tsc` (emits `dist/`, declarations included).
- Published to npm as `@liminal-hq/undertone`. Bump `version` in `package.json` and `npm publish --access public` (requires an authenticator OTP) to release.

## Licence and Copyright

- **Requirement:** New source files (and substantially rewritten source files) should include a short header as the first content in the file.
- **Applies to:** `.ts` files in `src/` and `demo/`.
- **Do not add headers to:** generated files (`dist/`), lockfiles, config files (`.json`, `.yml`), markdown docs, or the SVG asset.

Preferred header format for TypeScript:

```ts
// Brief one-line summary of what this file does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
```

- Keep the summary to one concise sentence.
- Place the header before `import` statements.
- Leave one blank line between the header and the first code line.
- Preserve existing valid licence headers when already present.
