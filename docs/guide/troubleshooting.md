---
title: Troubleshooting
---

# Tips, gotchas, and troubleshooting

- **No sound at all, no errors?** The first `play()`/`loop()` must happen inside a user gesture (click, tap, keypress) — browsers block audio contexts created outside one. Every later call can come from anywhere.
- **A sample layer is silent.** Samples need an explicit `registerSample()`/`registerSamples()` before they make sound — an unregistered name is skipped silently, with a single console warning per name. Check the console.
- **The first beat or two of a loop is missing sample hits.** A registered sample still decoding is skipped (without warning) until the decode lands. `await loadSamples(ctx)` before starting playback fixes it.
- **Notes in a loop are all short blips no matter the pattern.** The default envelope is percussive: `sustain` is 0, so there's nothing to hold through the note length. Add `.sustain(0.3)` (or more) to hear event lengths at all.
- **A sample one-shot cuts off after a fraction of a second.** Only `loop()` gates envelopes by note length; `play()` releases right after the decay. Give one-shot samples an explicit `.decay()` roughly the recording's length.
- **`.sound()` after `.s()` replaces the sample.** Deliberate: `.sound('square')` clears a previously set sample name (and `.s('bd')` clears a synth type), so the two never both apply to one voice.
- **Two layers fight over reverb/delay character.** `roomsize`, `delaytime`, and `delayfeedback` configure the _shared orbit bus_, last-writer-wins across every voice on that orbit. Distinct rooms or delay times need distinct `.orbit(n)` numbers.
- **A `~` in a patterned control isn't zero.** `.gain('1 ~')` leaves the second event's gain at its previous/default value (0.8), not silent. To actually silence steps, put the rest in the _note_ pattern, or write an explicit `0`.
- **Tempo maths.** `bpm` counts four beats per cycle — 120 bpm is a 2-second cycle, so `'a b c d'` lands one step per beat. `setcpm()` is cycles per minute directly (`setcpm(30)` ≡ `bpm: 120`); an explicit `bpm` always wins over it.
- **`stop()` isn't a hard mute.** It stops scheduling new events; voices already handed to the audio clock (up to ~0.3 s of lookahead) finish their envelopes and ring out.
- **Errors surface early by design.** Bad note names, chord symbols, scale specs, out-of-range pans, malformed numbers in control strings — all throw when the pattern is _built_, and a bad `baseNote` throws at `registerSample()` time, so a typo can't lurk until the middle of a song.
- **Patterns are immutable.** `pat.fast(2)` returns a new pattern and leaves `pat` untouched — assign the result. The upside: any half-built pattern is safe to reuse in several stacks or arrangement sections.
