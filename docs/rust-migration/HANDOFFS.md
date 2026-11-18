# Hand-offs

What this repository's agents need from the person, the lab (liminal-hq-labs/undertone-sound), and the studio (Fizz Audio Studio), what they give, and who tells whom. The plan stands alone: everything an agent needs to start is in this directory. Messages between agents go **through the person** by default (the person relays, or opens a session in the other repository).

Nothing is promoted from the lab or the studio (D-05), so there is no snapshot to wait for, no freeze, and no import hand-off. The lab and the studio are **later users** of Undertone: they may depend on this repository's crates after the release, on their own schedule.

## Needed from others

| #   | Artefact                                                                                                                                       | From | When needed                      | Exact form                                                                                                     | Blocks                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| N-1 | Optional: score JSON for two heavier golden renders (First Light, Colossus Showdown), made by the studio's recorder, as extra layer 4 material | S    | M4, for layer 4 (RF-20)          | Two score files with the studio's commit SHA, offered to the person, who decides whether they enter the corpus | Nothing (the playground's examples and recorded scores suffice) |
| N-2 | The person's decisions                                                                                                                         | P    | See [DECISIONS.md](DECISIONS.md) | Answers recorded in its log                                                                                    | Stop points                                                     |
| N-3 | Device checks for the worklet backend (a mid-range phone, a Steam Deck) and listening passes                                                   | P    | RF-29, RF-33                     | The harness page's numbers pasted into `results/`; "listened, sounds right" or what was wrong                  | RF-29's default (D-09), RF-33's checklist item 10               |
| N-4 | Go for each stack merge (`gh stack merge <top-PR> --yes --merge`), and every outward step: tags, npm and crates.io publishing, the release     | P    | The end of each milestone        | "Go" in a message, naming the stack                                                                            | Merging the stack; the next milestone's base                    |

## Given to others

| #   | Artefact                                                                                                                  | To      | When                      | Exact form                                                                      | What they do with it                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| G-1 | The reference SHA `452f782` and "0.4.0 will be the Rust-built release; there is no TypeScript 0.4.0"                      | L, S, P | M0 (this plan merges)     | A message with the SHA                                                          | The studio can stop expecting a TypeScript 0.4.0 on npm |
| G-2 | Notice of each breaking Rust API change in the crates (renames, moved modules) once anything depends on a git rev of them | L, S    | As each lands in M3 to M5 | One line per change in the pull request body, under "Maintainer-facing changes" | They bump at their own pace                             |
| G-3 | The release: version, npm and crates.io links, the "Moving from 0.3" notes                                                | L, S, P | After RF-33               | A message with the links and the notes                                          | Each consumer moves its pin when its owner chooses      |

## Work outside this repository

These belong to the other repositories' agents and are listed so the whole picture is in one place. This repository's agents do not do them, and none of them blocks a work package here.

| ID     | Owner | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | When                       | Acceptance                                               |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| LAB-01 | L     | Optionally, after the release (G-3): depend on this repository's `undertone-pattern` and `undertone-engine` (by git rev, later by crates.io version) in place of the lab's own `undertone-mini` and `undertone-dsp`; allow this repository as a source in its `deny.toml`; reverse its layering check so nothing here may depend on the lab; and rename its own demo `undertone-wasm` crate if the name confuses (its demo bindings are not Undertone's WebAssembly core) | After G-3, on its schedule | The lab's CI green on Undertone's crates; its demo plays |
| STU-01 | S     | Switch the studio's Rust dependencies (its `Cargo.toml` lines for the lab's two crates, `rev = 18c6756…`) to this repository's crates and rename `use` paths in `crates/fizz-audio-undertone`; later, move the TypeScript pin from `0.3.0` to `0.4.0`                                                                                                                                                                                                                     | After G-3, on its schedule | The studio's own gate green                              |

## The lab today (read on 2026-11-18)

- **State:** `main` is `26bbb05`. It holds `undertone-mini` and `undertone-dsp` as workspace crates, with the supporting crates (`undertone-sound`, `undertone-opl`, the demo bindings `undertone-wasm`, and the OPX and DOS pieces). These are prior art for this repository's crates (see [ARCHITECTURE.md](ARCHITECTURE.md#crates-and-their-dependency-rules)); the lab is not asked to freeze, rename, or delete anything.
- **Conventions worth matching:** workspace edition 2024, Rust 1.98.0, permissive licences only, `unsafe_code = forbid`, `missing_docs = warn`, hard tabs, `scripts/check-layering.sh` as a CI job. This repository's scaffold (RF-03, RF-04) makes the same choices independently.
- **New engine work** (the 0.4.0 features, signals, the scheduler) happens only here. The lab's roadmap items for the engine move to this plan.

## Who messages whom

| Event                                     | Sender | Receiver                                     |
| ----------------------------------------- | ------ | -------------------------------------------- |
| This plan merges (G-1)                    | O      | P (relays to L and S)                        |
| Each pull request pushed in a stack       | O      | P (one line with the link and gate results)  |
| A stack is ready to merge (N-4)           | O      | P, who answers "go" or asks for changes      |
| Each spike result                         | O      | P (a one-paragraph summary with the verdict) |
| M2 done (`results/DESIGN-ADJUSTMENTS.md`) | O      | P                                            |
| A stop point                              | O      | P                                            |
| Release (G-3)                             | O      | P (relays to L, S, and the game projects)    |

**O** is the orchestrator (Claude), who speaks for the agents it assigns.
