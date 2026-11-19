# Conformance corpus

This directory holds the conformance corpus: cases recorded from the TypeScript reference in `src/` that every other implementation (the Rust crates, then the WebAssembly-backed package) is held to byte for byte. The specification of the four layers, the groups, and the tolerances is `docs/rust-migration/CONFORMANCE.md`; this file is the format reference and the how-to.

The corpus is the only oracle. Cases are never edited by hand: they are written by `conformance/recorder/`, and `bun run conformance:check` fails when a file differs from what the reference produces now. A case the reference gets wrong is not fixed in the corpus; it is raised with the maintainer, because the reference is the specification until the maintainer says otherwise.

## Scripts

- `bun run conformance:record` regenerates every file under `conformance/cases/`, removing files the recorder no longer writes. Running it twice writes identical bytes.
- `bun run conformance:check` regenerates in memory and exits 1 on any difference (a changed, missing, or extra file), printing the first differing line. It writes nothing. CI runs this in the `ci-web` image.
- `bun run test` also runs `conformance/recorder/properties.test.ts`, the `fast-check` properties (below).
- `bun run typecheck:conformance` type-checks the recorder (`conformance/tsconfig.json`).
- `bun conformance/recorder/record.ts record --reference <worktree>` records from another checkout of the reference (a worktree of the reference SHA), the way regeneration works once `src/` is gone (RF-32).
- `bun conformance/recorder/record.ts cross-check --reference <worktree>` is a one-off: it records the cases marked `baseline` against another worktree (for example the `v0.3.0` tag) and compares each score and graph with this checkout's. Nothing is written.

## Layout

```
conformance/
  README.md             this file
  tsconfig.json         type-checks the recorder and the reference it imports
  api/                  the public API report (separate, see api:check)
  recorder/
    record.ts           the command line: record, check, cross-check
    reference.ts        loads the reference (src/, or a worktree's src/)
    interpret.ts        programs as data to patterns
    programs.ts         layer 1: records haps; programData.ts holds the programs
    caseMaker.ts        numbered case ids for the data files below
    miniData.ts         the `mini` group's programs
    notesData.ts        the `scales`, `chords`, and `drift` groups' programs
    randomCases.ts      the `random` group: seeds, and how a case is recorded
    controls.ts         layer 2: records score events and resolved voice parameters
    graph.ts            layer 3: records the node graph; graphData.ts holds the cases
    format.ts           value encoding, number printing, the file layout
    properties.test.ts  fast-check properties 1 to 3 of CONFORMANCE.md, against the reference
  cases/<layer>/<group>.json
```

`conformance/cases/` is excluded from Prettier (`.prettierignore`): the recorder writes its own stable layout, and a formatter would only rewrite it. The recorder's TypeScript is formatted and linted like the rest of the repository.

## File format

Every file is one JSON object with `"corpus": 1` (the format version; a format change bumps it and regenerates every file in the same commit, with the reason in the commit body), `layer`, `group`, and `cases`. The file carries the version once; individual cases do not repeat it. The layout is stable: each case's fields are on their own lines, and haps, events, score lines, and graph nodes are one per line, so a difference reads as a one-line diff.

Every case has `id` (unique in the corpus), `group`, and `from`, naming where the program came from: a reference test (`src/pattern.test.ts: <test title>`), a guide or recipe page, a playground example, or `generated: <what>`. A program that throws records `"error": "<message>"` word for word (the message already carries a UTF-16 position when mini-notation raises it) in place of its results.

### Encoding

- **Fractions** are `"n/d"` strings in lowest terms, integers included (`"4/1"`, never `"4"`), in `part`, `whole`, and `queries` of the recorded output. In a case's `queries` and `samples` as input, `"4"` and `"1/3"` both parse.
- **Numbers** are the numbers JavaScript prints. JSON cannot hold `NaN`, the infinities, or negative zero, so they are `{"$num": "NaN"}`, `{"$num": "Infinity"}`, `{"$num": "-Infinity"}`, and `{"$num": "-0"}`. An `undefined` field is omitted; an `undefined` value elsewhere is `{"$undefined": true}`.
- **Objects** (a hap's value, resolved voice parameters) have their keys sorted by code unit, so key order never depends on how the reference built them.

### Programs

A program is a list of steps, as in `CONFORMANCE.md`. The first step is a constructor (`note`, `sound`, `s`, `n`, `chord`, `mini`, `pure`, `silence`, `stack`, `seq`, `cat`, `timecat`, `arrange`, `irand`, `choose`, `brandBy`, or a signal name such as `sine`), and each later step is a method with its arguments. `["mini", "a b", "word"]` takes a leaf rule (below). `fmap` takes a named map (`add`, `sub`, `mul`, `div`, `neg`, `abs`, `round`, `floor`) and its argument. A nested program (an array of steps) is a pattern argument, except for the transform of `every` (second argument) and `jux` (first), where it is a list of methods applied to the pattern. Any other array or object is passed through element by element, so `["timecat", [[1, [["note", "c3"]]], [2, [["note", "e3"]]]]]` works as written. Methods that leave the data model (`query`, `play`, `loop`, `render`) are refused. Closures, `signal(fn)`, and `new Pattern(query)` are not in the corpus.

**Leaf rules** (the third element of a `mini` step) decide what each word becomes:

- `word` keeps the word, and `number` is `Number(word)` (`"abc"` gives `NaN`, `"0x10"` gives 16).
- `pitch` is the leaf `note()` uses: `{ "pitch": <Hz number> }` for a word of digits (with an optional fraction), otherwise `{ "pitch": "<note name>" }`, and a word that is neither a note name nor a positive frequency is an error.
- `drum` is the leaf `s()` uses: `{ "soundType": word }` when the word is one of the ten synth sound types, otherwise `{ "sampleName": word }`. It never throws.

**Steps the mini, scales, chords, and drift groups added.** `["voicing"]` and `["voicing", {"anchor": "c3"}]` (a method with an options object; `anchor` is a MIDI number or a note name), `["scale", "c4:major"]`, and `["chord", "<Dm9 G7>"]` were already in the language and are now used with every spec and symbol. New: `["drift", {"seed": 1, "timing": 0.01, "level": 0.1, "cents": 10, "pan": 0.2, "push": 0, "cyclesPerPass": 2}]`, a method step that calls the reference's free function `drift(pattern, options)` on the pattern so far (the options object is passed through as written, so a program can also pass values `drift` rejects, to record the error). New leaf rules `pitch` and `drum`. Programs in `mini` are always `[["mini", <source>, <leaf rule>]]`, so the source string is in `program[0][1]` and the Rust runner reports by the id's stem (`mini-<stem>-NN`).

### Layer 1: haps

```json
{
  "id": "core-euclid-01",
  "group": "core",
  "from": "src/pattern.test.ts: produces the canonical euclidean necklaces",
  "program": [
    ["pure", "x"],
    ["euclid", 3, 8]
  ],
  "queries": [
    ["0", "4"],
    ["0", "1"],
    ["2", "3"],
    ["1/3", "7/4"]
  ],
  "haps": [[{ "whole": ["0/1", "1/8"], "part": ["0/1", "1/8"], "value": "x" }]]
}
```

`queries` are the spans, `haps` has one list per query in the same order. Each hap is `whole` (`null` for a signal), `part`, and `value`, sorted by `part` begin, `part` end, `whole` begin, `whole` end (`null` first), then the value's compact JSON text. A query that throws gives `{"error": "<message>"}` in its place. Signals also carry `samples`, a list of `[time, value]` read with `sampleAt` (`null` where the pattern has no value at that instant), which includes negative time. The default queries are cycles 0 to 4, 0 to 1, 2 to 3, and `1/3` to `7/4`; a case may name its own.

### Layer 1: `random`

The `random` group is the one layer 1 group whose cases are not programs. A case is `id`, `group`, `from`, `seed`, and `values`: the first 64 numbers `seededRandom(seed)` returns, written as JavaScript prints them (shortest round-trip form). `seed` is a number or a string as the reference takes it. A numeric seed that JSON cannot hold is `{"$num": "NaN"}`, `{"$num": "Infinity"}`, `{"$num": "-Infinity"}`, or `{"$num": "-0"}`. A string seed may hold lone surrogates, which the file writes as `\ud83d` escapes, so a Rust runner has to build the seed from UTF-16 code units (a lone surrogate is not a Rust `char`). A numeric seed goes through JavaScript's `seed >>> 0` (a fraction truncates, a negative wraps, NaN and the infinities become 0) and a string seed through FNV-1a over its UTF-16 code units. The cases cover both families and the key shapes the reference builds for its own random sources (`song|rand|1/3`, `1|0|1/3|261.6255653005986`).

### Layer 2: score events and resolved voices

A case adds `cycles` (the whole cycles booked, `[0, 2]`), `cps`, and `gated`, and records `events`: one line per onset, `{"at": <seconds>, "params": <resolved VoiceParams>}`, in booking order (cycle by cycle, as the scheduler's `collectOnsets` returns them, with a gated event's `duration` filled in). `params` is the complete `VoiceParams` after `resolveParams`.

### Layer 3: the recorded graph

A case is either **voices** (`score` lines are the input, each booked on a fresh recording context) or a **render** (`program` and `render` options are the input, and `score` lists the onsets the renderer booked). Optional `output` is `{ "master": true | {...options}, "channels": n }` for a voices case; `"baseline": true` marks a case that records a 0.3.0 behaviour with every 0.4.0 option off (its graph equals 0.3.0's).

`score` lines are `v<k> @<seconds> <json>`: the voice's name, its start time, and its patch (a partial `VoiceParams`, resolved with the engine's defaults) as compact JSON with sorted keys. `graph` is:

- `sampleRate`, `length` (`null` for a realtime context), `channels` (the destination's), and `counts` (nodes per kind, and `total`).
- `nodes`, numbered in creation order, `n0` being the destination. Each has `id`, `kind`, `fields` (only values that differ from a fresh node of the same class: `type`, `numberOfInputs`, `curve` and `buffer` as buffer ids, `wave` as a wave id), `params` (per parameter, the automation calls as strings: `set <v> @<t>`, `lin <v> @<t>`, `exp <v> @<t>`, `target <v> @<t> tau <c>`, `cancel @<t>`), `start` and `stop` (seconds), `heard` (a convolver's impulse response by time: `["first", "b0"]`, then `[<seconds>, "b1"]`), and `to` (its connections, `n3`, or `n3.gain` for a parameter, with ` out <o> in <i>` only when the output or input is not 0).
- `buffers`, in order of first use: `id`, `kind` (`audio` or `curve`), `length`, `sampleRate` for audio, and per channel `rms`, `peak`, and `head` (the first four samples). The root mean square sums the squares in order in double precision, then divides and takes the square root.
- `waves`: `id`, `real`, `imag`, and `disableNormalization`.

Every number in a call string, `start`, `stop`, a buffer summary, and a wave is rounded to nine significant digits and printed as JavaScript prints it. The reference's trigonometry is JavaScriptCore's on Linux (`bun` here); an implementation's maths must match it (R9 in `docs/rust-migration/RISKS.md`).

## Determinism

Everything is seeded. The recorder never reads the clock or `Math.random`: a voices case seeds its context (`seedContext(ctx, 0)`) the way a render does, which fixes the noise and reverb buffers; renders use their default seed. Reference warnings (a clamped control, say) are silenced while recording, because the corpus records values, not logs.

## What the corpus holds

| Layer | Group         | Holds                                                                                                                                                                                                                          |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `core`        | `pure`, `silence`, mini-notation forms, `stack`, `seq`, `cat`, `timecat`, `fast`, `slow`, `euclid`, and their errors                                                                                                           |
| 1     | `combinators` | `rev`, `every`, `jux`, `arrange`, `fmap` with named maps                                                                                                                                                                       |
| 1, 2  | `notes`       | `note`, `sound`, `s`, `bank`, `n`, `scale`, `chord`, `voicing`                                                                                                                                                                 |
| 1, 2  | `controls`    | `gain`, `lpf`, `pan`, `attack` with a number, a string, a rest, an alternation, a signal, a pattern, and edge values; `n` with strings and signals; scalar-only controls given a pattern                                       |
| 1, 2  | `signals`     | every periodic and random signal with the shaping methods, negative time, mixed compositions (layer 1); signals sampled into controls (layer 2)                                                                                |
| 1     | `mini`        | every construct of the parser (sequences, rests, `@`, `!`, `*`, `/`, groups, `<>`, `,`, euclid) over six spans, the leaf rules `word`, `number`, `pitch`, and `drum`, odd whitespace, and every error with its UTF-16 position |
| 1     | `scales`      | every named scale over degrees from -15 to 25, roots with sharps, flats, and octaves from -1 to 10, name spellings, extreme degrees, and the scale errors                                                                      |
| 1, 2  | `chords`      | every chord quality over four roots, every root spelling, the `anchor` option as a number and a note name, chords in mini-notation, and the chord errors (layer 2 books the qualities and anchors)                             |
| 1     | `random`      | the first 64 values of `seededRandom` for numeric seeds (including fractions, negatives, 2^32 wraps, NaN, and the infinities) and string seeds (including the empty string, unicode, and lone surrogates)                      |
| 1, 2  | `drift`       | `drift(pattern, options)`: each option alone and together, many seeds, passes, positions, pitches, patches already on the events, queries at negative time, and the option errors (layer 2 books most of them)                 |
| 3     | `placement`   | `panLaw`, `panPath`, the pan slide, `autopan` with its shape, depth, and phase, the master `ceiling`, `bookingWindow`, the playground's `movingPan` examples, and the options-off baselines                                    |

The `mini` cases are recorded over six spans each (cycles 0 to 4, then 0 to 1, 1 to 2, 2 to 3, 3 to 4, and `1/3` to `7/4`); `scales`, `chords`, and `drift` over two or four cycles and a span that starts inside a cycle, to keep the files small. The `mini` group's ids carry the sub-area (`mini-seq-`, `mini-rest-`, `mini-weight-`, `mini-repeat-`, `mini-fast-`, `mini-slow-`, `mini-group-`, `mini-alt-`, `mini-stack-`, `mini-euclid-`, `mini-mix-`, `mini-leaf-number-`, `mini-leaf-pitch-`, `mini-leaf-drum-`, `mini-space-`, and `mini-err-empty-`, `-token-`, `-astral-`, `-parse-`, `-leaf-`), so a runner can report by the stem. Two reference behaviours a port has to match, found while recording: the "Unknown chord quality" message lists the qualities in JavaScript's property order (integer-like keys `6`, `7`, `9` first, then the rest in table order), and a non-BMP character in mini-notation is reported as its lone high surrogate at its UTF-16 position.

Not in the corpus yet: `voices`, `instruments`, `channels`, `score`, `wav`, `samples`, and layer 4 renders. The mini-notation leaf rules cover the three families the reference's constructors use (`word`, `pitch`, `drum`) plus `number`.

## Properties

`conformance/recorder/properties.test.ts` runs properties 1 to 3 of `CONFORMANCE.md` against the reference with `fast-check`, with a fixed seed so a failure repeats: window independence (discrete programs of depth at most 5, and signals given structure or used as controls, over random `a < b < c` with denominators up to 12), the inverses (`fast(n).slow(n)`, `rev().rev()`, `every(1, f)`), and signals (the sampler agrees with a query starting at the instant, except for a reversed signal, where the reference's query route reads the mirrored end by design; `seed(s)` is reproducible). Fragments are joined before comparing, counting how many fragments cover each stretch of an event, so an event cut at a cycle boundary or repeated by a stack of equal layers compares equal to the whole. A failure is a finding about the reference, not a Rust bug.
