# Conformance corpus

This directory holds the conformance corpus: cases recorded from the TypeScript reference in `src/` that every other implementation (the Rust crates, then the WebAssembly-backed package) is held to byte for byte. The specification of the four layers, the groups, and the tolerances is `docs/rust-migration/CONFORMANCE.md`; this file is the format reference and the how-to.

The corpus is the only oracle. Cases are never edited by hand: they are written by `conformance/recorder/`, and `bun run conformance:check` fails when a file differs from what the reference produces now. A case the reference gets wrong is not fixed in the corpus; it is raised with the maintainer, because the reference is the specification until the maintainer says otherwise.

## Scripts

- `bun run conformance:record` regenerates every file under `conformance/cases/` except layer 4 (`cases/4/`, which a browser makes), removing files the recorder no longer writes. Running it twice writes identical bytes.
- `bun run conformance:check` regenerates in memory and exits 1 on any difference (a changed, missing, or extra file), printing the first differing line. It writes nothing. For layer 4 it needs no browser: it checks that each case's program, options, and score still equal what the reference makes and that the browser's summaries have the format below. CI runs this in the `ci-web` image.
- `bun run conformance:browser-render` records layer 4 by hand (below). It is never run in CI.
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
    graph.ts            layer 3: records the node graph; graphData.ts holds the cases (and the groups' own files, such as scoreData.ts and samplesData.ts)
    wavData.ts          the wav group: encodeWav's bytes (not a layer)
    rendersData.ts      layer 4: the render cases (programs and render options)
    renders.ts          layer 4: a case's browser-free part, the file layout, and the format check
    renderSummary.ts    layer 4: what a render is reduced to (RMS, peak, bands, windows)
    browser-render.ts   layer 4: the Playwright script that makes the summaries (by hand); browser-page.ts is the page side
    format.ts           value encoding, number printing, the file layout
    properties.test.ts  fast-check properties 1 to 3 of CONFORMANCE.md, against the reference
  cases/<layer>/<group>.json
  cases/4/renders.json  layer 4: a browser's summaries of the render cases (recorded by hand)
  cases/wav/wav.json    the wav group (not a layer)
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

**Steps the mini, scales, chords, and drift groups added.** `["voicing"]` and `["voicing", {"anchor": "c3"}]` (a method with an options object; `anchor` is a MIDI number or a note name), `["scale", "c4:major"]`, and `["chord", "<Dm9 G7>"]` were already in the language and are now used with every spec and symbol. New: `["drift", {"seed": 1, "timing": 0.01, "level": 0.1, "cents": 10, "pan": 0.2, "push": 0, "cyclesPerPass": 2}]`, a method step that calls the reference's free function `drift(pattern, options)` on the pattern so far (the options object is passed through as written, so a program can also pass values `drift` rejects, to record the error). New leaf rules `pitch` and `drum`.

**Steps the instruments group added.** `["voice", <patch>]` is `.voice(patch)`. A patch is a plain object, or `{"$fmVoice": <definition>}` (`fmVoice(definition)`), or `{"$preset": "glassBell"}` (`fmPresets.glassBell`), and the same forms may stand in any argument. `["layer", [<patch>, ...], <options>]` is a method step that calls the reference's free function `layer(pattern, voices, options)` on the pattern so far. Programs in `mini` are always `[["mini", <source>, <leaf rule>]]`, so the source string is in `program[0][1]` and the Rust runner reports by the id's stem (`mini-<stem>-NN`).

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

A case is **voices** (`score` lines are the input, each booked on a fresh recording context), a **render** (`program` and `render` options are the input, and `score` lists the onsets the renderer booked), or a **score** (a `definition`, the `score()` argument, and `render` options are the input; the score sets its own tempo, so the options never hold `bpm`, `cps`, or `seconds`). A score case records the score's `cps` and `seconds`, the onsets the render booked as `score` lines, and the graph; a score that throws, in `score()` or in the render, records its `definition`, `render`, and `error` and no graph. Optional `output` is `{ "master": true | {...options}, "channels": n, "maxChannels": m, "multichannel": true | false, "monoFold": true }` for a voices case: `channels` is the destination's count (default 2), `maxChannels` the hardware maximum (default `channels`), `multichannel` whether `enableMultichannel` is called (default: `channels` above 2), and `monoFold` plays the voices through `createMonoFold`, which feeds the master bus when there is one. The case's `score` holds the patch as booked, so an instrument merged with `.voice(patch)` or a `surround` angle appears as its fields and its `channelGains`; `"baseline": true` marks a case that records a 0.3.0 behaviour with every 0.4.0 option off (its graph equals 0.3.0's).

**Samples.** A voices or render case may carry a `registry`: the decoded samples registered in the reference before booking, one per line, each `{"name", "sampleRate", "channels", "baseNote"?, "before"?}` (`channels` is one array of numbers per channel, the values the 32-bit floats are rounded from; `before` is the index of the voice a voices case registers the sample before, 0 by default; a render case registers them all up front). A voices case may also carry `clearBefore`, the voice indices `clearSamples()` is called before, ahead of that voice's registrations. The registry is empty at the start of every case. A runner registers the same PCM in its own registry and books the score; the recorded buffers (`kind` `audio`, with the registered `sampleRate`) are the samples' summaries.

`score` lines are `v<k> @<seconds> <json>`: the voice's name, its start time, and its patch (a partial `VoiceParams`, resolved with the engine's defaults) as compact JSON with sorted keys. `graph` is:

- `sampleRate`, `length` (`null` for a realtime context), `channels` (the destination's), and `counts` (nodes per kind, and `total`).
- `nodes`, numbered in creation order, `n0` being the destination. Each has `id`, `kind`, `fields` (only values that differ from a fresh node of the same class: `type`, `numberOfInputs`, `curve` and `buffer` as buffer ids, `wave` as a wave id), `params` (per parameter, the automation calls as strings: `set <v> @<t>`, `lin <v> @<t>`, `exp <v> @<t>`, `target <v> @<t> tau <c>`, `cancel @<t>`), `start` and `stop` (seconds), `heard` (a convolver's impulse response by time: `["first", "b0"]`, then `[<seconds>, "b1"]`), and `to` (its connections, `n3`, or `n3.gain` for a parameter, with ` out <o> in <i>` only when the output or input is not 0).
- `buffers`, in order of first use: `id`, `kind` (`audio` or `curve`), `length`, `sampleRate` for audio, and per channel `rms`, `peak`, and `head` (the first four samples). The root mean square sums the squares in order in double precision, then divides and takes the square root.
- `waves`: `id`, `real`, `imag`, and `disableNormalization`.

Every number in a call string, `start`, `stop`, a buffer summary, and a wave is rounded to nine significant digits and printed as JavaScript prints it. The reference's trigonometry is JavaScriptCore's on Linux (`bun` here); an implementation's maths must match it (R9 in `docs/rust-migration/RISKS.md`).

### The `wav` group: bytes

`encodeWav` writes bytes, not a graph, so the `wav` group is not a layer: its one file is `conformance/cases/wav/wav.json`, with `"format": "wav"` in place of `layer`, written one case per line. A case is `id`, `from`, `sampleRate`, `channels` (the samples of each channel, as the 32-bit floats the reference gets: the doubles they convert to, with `NaN`, the infinities, and negative zero in the `{"$num": ...}` form above), `options` (`bitDepth`, `dither`, `seed`, `channelMask`, as `encodeWav` takes them; `{}` for the defaults), and either `bytes`, the whole file as lowercase hex, or `error`, the message. The inputs are a few dozen samples at most, so the expected output is the file itself rather than a digest: a runner compares byte for byte, and a difference can be read off the hex. The recorder is `wavData.ts`; `conformance:check` covers the file with the layers.

### Layer 4: browser renders

`conformance/cases/4/renders.json` holds renders of the reference made with a real `OfflineAudioContext` in headless Chromium and reduced to summaries (never samples). It is the one file the recorder does not write: a person runs the Playwright script on their own machine, and the result is committed.

```sh
PLAYWRIGHT_CORE=<dir of playwright-core> bun run conformance:browser-render
# options: --out <dir> writes <dir>/4/renders.json instead (to compare two runs), --only <case id> (needs --out)
```

Playwright's core library and a Chromium are not dependencies of the package. `PLAYWRIGHT_CORE` names an installed `playwright-core` directory (when unset, `playwright-core` is resolved normally), and `CHROMIUM_PATH` a Chromium or Chrome executable (default: the newest `chromium-*` of `~/.cache/ms-playwright`, then `/usr/bin/chromium`). The script bundles `src/` with `bun build` into the page, interprets each case's program there, calls `renderToBuffer` with the case's options, and summarises the buffer in the page. It takes about two seconds in all.

A case is `id`, `from`, `program`, `render` (the options, JSON), `score` (the onsets the reference books, `v<k> @<seconds> <json>` as in layer 3, made by the reference without a browser), and `browser`:

- `chromium`: the browser's version, as Playwright reports it (`149.0.7827.55`), so a change of browser is visible in the diff.
- `sampleRate` and `frames`: the render's, which the options fix (`round((cycles * cycleSeconds + tail) * sampleRate)`).
- `channels`: one object per output channel with `rms` and `peak` (linear amplitude, full scale 1), `bands` (eight RMS values) and `windows` (RMS of each consecutive 100 ms window, `round(0.1 * sampleRate)` frames, the last one shorter when the render is not a whole number of windows).

The bands come from one FFT of the whole channel, zero-padded to a power of two `M` with no window function: the power of bins `1` to `M/2 - 1` is summed by the bin's frequency `k * sampleRate / M` into eight bands (below 125 Hz; 125 to 250; 250 to 500; 500 Hz to 1 kHz; 1 to 2 kHz; 2 to 4 kHz; 4 to 8 kHz; 8 kHz and up, each lower edge included), and a band's RMS is `sqrt(2 * sum / (frames * M))`, so the bands' mean squares add up to the channel's (less DC and the Nyquist bin). The definition is in `conformance/recorder/renderSummary.ts`; a Rust comparison implements the same. Numbers are written to nine significant digits.

`conformance:check` validates the committed file and nothing more: the header, that each case of `rendersData.ts` is present with the program, options, and score the reference makes now, and that each browser record has a version, the expected sample rate and frame count, the expected channels, and eight bands and the expected number of windows of finite non-negative numbers (a peak at least the RMS). A browser is not asked for anything, so the summaries cannot be checked against the reference; the Rust comparison does that (`crates/undertone-engine/tests/layer4.rs`).

Rendering is deterministic to within float noise on one machine and browser (`docs/rust-migration/results/R-layer4.md` reports two runs), but not byte for byte across browser versions, so the file is regenerated only when a case changes or the browser is deliberately updated, and the summaries are compared with tolerances, not exactly. Nothing in the file was listened to.

## Determinism

Everything is seeded. The recorder never reads the clock or `Math.random`: a voices case seeds its context (`seedContext(ctx, 0)`) the way a render does, which fixes the noise and reverb buffers; renders use their default seed. Reference warnings (a clamped control, say) are silenced while recording, because the corpus records values, not logs.

## What the corpus holds

| Layer | Group         | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `core`        | `pure`, `silence`, mini-notation forms, `stack`, `seq`, `cat`, `timecat`, `fast`, `slow`, `euclid`, and their errors                                                                                                                                                                                                                                                                                                                                                                       |
| 1     | `combinators` | `rev`, `every`, `jux`, `arrange`, `fmap` with named maps                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1, 2  | `notes`       | `note`, `sound`, `s`, `bank`, `n`, `scale`, `chord`, `voicing`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1, 2  | `controls`    | `gain`, `lpf`, `pan`, `attack` with a number, a string, a rest, an alternation, a signal, a pattern, and edge values; `n` with strings and signals; scalar-only controls given a pattern                                                                                                                                                                                                                                                                                                   |
| 1, 2  | `signals`     | every periodic and random signal with the shaping methods, negative time, mixed compositions (layer 1); signals sampled into controls (layer 2)                                                                                                                                                                                                                                                                                                                                            |
| 1     | `mini`        | every construct of the parser (sequences, rests, `@`, `!`, `*`, `/`, groups, `<>`, `,`, euclid) over six spans, the leaf rules `word`, `number`, `pitch`, and `drum`, odd whitespace, and every error with its UTF-16 position                                                                                                                                                                                                                                                             |
| 1     | `scales`      | every named scale over degrees from -15 to 25, roots with sharps, flats, and octaves from -1 to 10, name spellings, extreme degrees, and the scale errors                                                                                                                                                                                                                                                                                                                                  |
| 1, 2  | `chords`      | every chord quality over four roots, every root spelling, the `anchor` option as a number and a note name, chords in mini-notation, and the chord errors (layer 2 books the qualities and anchors)                                                                                                                                                                                                                                                                                         |
| 1     | `random`      | the first 64 values of `seededRandom` for numeric seeds (including fractions, negatives, 2^32 wraps, NaN, and the infinities) and string seeds (including the empty string, unicode, and lone surrogates)                                                                                                                                                                                                                                                                                  |
| 1, 2  | `drift`       | `drift(pattern, options)`: each option alone and together, many seeds, passes, positions, pitches, patches already on the events, queries at negative time, and the option errors (layer 2 books most of them)                                                                                                                                                                                                                                                                             |
| 3     | `placement`   | `panLaw`, `panPath`, the pan slide, `autopan` with its shape, depth, and phase, the master `ceiling`, `bookingWindow`, the playground's `movingPan` examples, and the options-off baselines                                                                                                                                                                                                                                                                                                |
| 3     | `voices`      | 75 baseline cases for the 0.3.0 booking: waveforms and shaped waves, noise, envelopes, filters, the phaser, pitch curves, FM, cut groups, orbit buses, placement on 1 to 6 channels, and the master bus, all with the 0.4.0 options off                                                                                                                                                                                                                                                    |
| 3     | `options`     | 33 cases for the 0.4.0 options at their corners: `panLaw` (including the custom law's mono sum), the master `ceiling`, `panPath`, the pan slide, `autopan`, and `bookingWindow` renders, with the rejected values recorded as errors                                                                                                                                                                                                                                                       |
| 2, 3  | `instruments` | `fmVoice` with every field and its two errors, the five `fmPresets`, `.voice(patch)` (with controls before and after it), `layer` (stagger, levels, pans, nudges, velocity, drift, and its errors), and the shaped waves they select (layer 2: 31 cases; layer 3: 28, all baseline)                                                                                                                                                                                                        |
| 2, 3  | `channels`    | `.channels(gains)` and `.surround(angle)` (every ring angle, wrapped angles, the errors), placement on 1, 2, 4, 6, and 8 channel destinations, `enableMultichannel` on 2 to 16 channel hardware or not at all, the fold-downs, and `createMonoFold` (layer 2: 31 cases; layer 3: 42, all baseline)                                                                                                                                                                                         |
| 3     | `score`       | 46 cases of `score()` compiled and rendered offline at its own tempo: note names, MIDI, and Hz, gates, unsorted and uneven ticks, level and pan, voice controls, the `cut` and `ring` seams, the score's `panLaw`, `panPath` and `autopan` in ticks, cycles, tail and `wrap`, ungated, no master, four channels, a booking window, and 22 errors (29 baseline)                                                                                                                             |
| 3     | `samples`     | 63 cases of sample voices booked from registered PCM (59 baseline): playback rate from the default and a custom `baseNote` (note names and frequencies, above and below), controls a sample keeps or ignores (gate, envelope, filters, pan, sends, cut groups, pitch curves), mono, stereo, and three-channel buffers at rates different from the context's, shared buffers, unregistered names and banks, `clearSamples`, multichannel output, and renders of `s()` patterns with windows |
| wav   | `wav`         | 34 cases of `encodeWav`'s bytes (hex) and errors: 16, 24, and 32 bit, dither seeds, edge samples (clipping, `NaN`, -0, the infinities), empty files, 1 to 8 channels with the masks and the 7.1 reordering, sample rates                                                                                                                                                                                                                                                                   |

The `mini` cases are recorded over six spans each (cycles 0 to 4, then 0 to 1, 1 to 2, 2 to 3, 3 to 4, and `1/3` to `7/4`); `scales`, `chords`, and `drift` over two or four cycles and a span that starts inside a cycle, to keep the files small. The `mini` group's ids carry the sub-area (`mini-seq-`, `mini-rest-`, `mini-weight-`, `mini-repeat-`, `mini-fast-`, `mini-slow-`, `mini-group-`, `mini-alt-`, `mini-stack-`, `mini-euclid-`, `mini-mix-`, `mini-leaf-number-`, `mini-leaf-pitch-`, `mini-leaf-drum-`, `mini-space-`, and `mini-err-empty-`, `-token-`, `-astral-`, `-parse-`, `-leaf-`), so a runner can report by the stem. Two reference behaviours a port has to match, found while recording: the "Unknown chord quality" message lists the qualities in JavaScript's property order (integer-like keys `6`, `7`, `9` first, then the rest in table order), and a non-BMP character in mini-notation is reported as its lone high surrogate at its UTF-16 position.

The mini-notation leaf rules cover the three families the reference's constructors use (`word`, `pitch`, `drum`) plus `number`.

## Known differences by design

Layer 4 compares a render of the Rust engine with a browser's `OfflineAudioContext` render of the reference (`docs/rust-migration/CONFORMANCE.md`). The in-house renderer (`undertone_engine::render_graph::RenderGraph`) follows the Web Audio specification and does not copy a browser's code, so these differences are expected, and the tolerances there allow for them. A difference that shows up outside this list is a finding, not a tolerance to widen. Nothing here has been listened to.

- **Oscillators are band-limited by wave tables of this crate's own making.** Browsers also use band-limited tables, but the table size, the band edges, and so the partials kept near Nyquist differ (here: 4096 samples, one table per third of an octave, partials up to Nyquist for the band's top frequency, linear interpolation). The built-in types and a custom periodic wave are normalised (a custom one unless it disables normalisation), as Chromium's are: its square and sawtooth measure 0.848 of the ideal wave (one over the Gibbs overshoot of the partial sum), and layer 4 found the Rust levels 1.5 dB high before the built-ins were normalised.
- **The dynamics compressor (the master limiter) differs in its look-ahead details.** It has the shared algorithm's structure (soft-knee saturation curve, 6 ms pre-delay with the detector on the undelayed signal, a 2.5 ms detector release, a quarter-decibel attack, automatic makeup of the reciprocal full-scale gain to the 0.6 power) but a constant-rate release in place of the browsers' adaptive release curve, so gain recovery after a loud passage differs, and with it the peaks the limiter lets through. Renders with the limiter on are compared with the looser tolerances, and the master `ceiling` is the backstop that holds exactly.
- **Low-pass and high-pass resonance follows the browsers, not the specification text.** The dB `Q` is the height of the resonant peak, as in the browsers; the specification's formula (`Q` as a linear quality factor of `10^(Q/20)`) gives a slightly different peak. The other filter types use the specification's forms.
- **The convolver convolves exactly** (partitioned FFT) with the specification's normalisation, so it can differ from a browser's by the browser's own approximations, and a new impulse response drops the old tail where a browser may cross-fade.
- **A `setTarget` followed by a ramp** starts the ramp from the target's start value, not from the point the curve has reached (the specification leaves this to the implementation).
- **A wave shaper with oversampling** has 16 frames of latency from its anti-aliasing filters.
- **A cycle without a delay is muted** at one node, where a browser mutes the cycle's nodes.
- **Render options are bounded.** The reference accepts an infinite `cps` or `bpm` (a zero-length cycle and an infinite cycle count, so its loop never ends), a `defaultCyclesPerMinute` that is not positive, and any length or sample rate (a context too large fails to allocate). `RenderPlan::new` returns an error instead: an infinite `cps`, `bpm`, or `default_cpm`, a `default_cpm` that is not positive, a sample rate above 1,000,000 Hz, more than 1,048,576 cycles, or more than 268,435,456 frames (tail included). Every option the reference accepts and renders within those bounds renders the same.
- **Samples are `f32`; filter, compressor, and convolver state is `f64`**, so last-bit differences against a browser's all-`f32` chain are expected everywhere; they are far below the tolerances.

## Properties

`conformance/recorder/properties.test.ts` runs properties 1 to 3 of `CONFORMANCE.md` against the reference with `fast-check`, with a fixed seed so a failure repeats: window independence (discrete programs of depth at most 5, and signals given structure or used as controls, over random `a < b < c` with denominators up to 12), the inverses (`fast(n).slow(n)`, `rev().rev()`, `every(1, f)`), and signals (the sampler agrees with a query starting at the instant, except for a reversed signal, where the reference's query route reads the mirrored end by design; `seed(s)` is reproducible). Fragments are joined before comparing, counting how many fragments cover each stretch of an event, so an event cut at a cycle boundary or repeated by a stack of equal layers compares equal to the whole. A failure is a finding about the reference, not a Rust bug.
