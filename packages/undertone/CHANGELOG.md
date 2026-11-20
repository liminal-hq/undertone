# Changelog

## 0.4.0 (unreleased)

### Moving from 0.3

The package is rebuilt over a Rust core compiled to WebAssembly (the Rust migration, `docs/rust-migration/`). The JavaScript names and behaviour are 0.3's. These are the changes, the ten accepted as D-06 (decision D-40) and the ones the first bindings add.

#### Accepted breaks (D-40)

- **B1. Loading.** The package instantiates a WebAssembly module, so the default entry uses top-level `await` (Node, Bun, and Deno load it synchronously through the `node` condition). Where top-level `await` is not available, import `@liminal-hq/undertone/init` and `await init()` once. Vite 5 needs `build.target: 'esnext'`; see the README.
- **B2. Runtimes.** Node 22 or later, Bun 1.2 or later (D-42), and browsers with WebAssembly, top-level `await`, and `FinalizationRegistry`; 0.3's Node 20 floor is gone.
- **B3. Time beyond 2^53.** `Fraction` arithmetic is exact beyond 2^53 (as the Rust core's 128-bit fractions are) where 0.3 silently lost precision. `n` and `d` are then the nearest numbers, and `toString()` is exact. `Fraction.fromText('n/d')` is new.
- **B4. JavaScript queries.** `new Pattern(query, sample)` still works, as a foreign leaf, but a pattern that holds one runs only on the thread that made it: the AudioWorklet backend refuses it with a diagnostic naming the leaf.
- **B5. JavaScript functions in patterns.** `fmap(fn)` and `signal(fn)` follow B4. `fmap` calls `fn` once per value, and the batch crosses to WebAssembly once per query.
- **B6. Rendering.** `renderToBuffer` and `.render` render in the WebAssembly engine instead of an `OfflineAudioContext`, so the samples equal the browser's only within the render tolerances; passing `context` keeps the browser path. _(Arrives with the engine bindings.)_
- **B7. Internals.** Members of `Pattern` beyond `.query`, `.sample`, and the documented methods (the private fields and helpers) are not present.
- **B8. Size.** The package is larger: the WebAssembly module is 127 KB after Brotli at this stage (the control bindings are in, the engine is not), inside the 150 KB budget of D-07; the glue is 10 KB and the wrapper's JavaScript 13 KB after Brotli, and the packed tarball is 230 KB.
- **B9. Object identity.** Every query returns new `Hap` and `Fraction` objects. Within one query, haps with equal values share one value object (as the haps of one mini-notation word did).
- **B10. Errors.** Error messages are word for word the reference's, and the class is still `Error`.

#### New with the first bindings

- **A pattern's value cannot be `null` or a class instance.** `pure(null)`, `choose(new Fraction(1, 2))`, or a mini-notation leaf function returning one throws `a pattern value must be a number, a string, a boolean, undefined, an array, or a plain object, got ...`. Numbers (`NaN`, `Infinity`, `-0` included), strings, booleans, `undefined`, arrays, and plain objects (to 64 levels) cross unchanged. Use `undefined` or a plain object where you used `null`.
- **Map keys come back sorted.** A value that is an object has its keys in alphabetical order, where 0.3 kept insertion order.
- **Equal values within one query share one object.** Mutating a value you got from one hap can show in another hap of the same query that holds an equal value; copy before you change one.
- **`free()` and `using`.** `Pattern#free()` and `[Symbol.dispose]()` are new, optional, and safe to call twice; see the README.
- **Overflow.** A pattern whose times overflow 128-bit fractions (`pure(1).fast(2 ** 53).fast(2 ** 53).fast(2 ** 53)`, queried) stops the WebAssembly instance (`RuntimeError: unreachable`) where 0.3 silently lost precision; reload the page or the process.
- **`@liminal-hq/undertone/testing`** is new (D-28): `resetWarnings`, `seedContext`, `playVoice`, and `playVoices`, kept out of the API report.
- **The control methods, notes, and instruments** (the second bindings). `Pattern` has all 56 control methods, `note`/`sound`/`s`/`n`/`chord`, `drift`, `fmVoice`/`fmPresets`/`layer`, `score`, `resolveParams`, and the channel helpers, with the reference's messages word for word. `Pattern.play`, `.loop`, and `.render`, `playParams`, and the rest of the engine are still to come (README: _What is pending_).
- **`score().play()`, `.loop()`, and `.render()` throw** `score().play() is not available until the engine exports land` until the engine bindings arrive; `score().pattern`, `.cps`, and `.seconds` work.
- **`fmPresets` keys are in alphabetical order** (`glassBell`, `lead`, `pluck`, `roundBass`, `softPad`), where 0.3 listed them in the order they were written. The presets are frozen, as before.
- **Constants and presets are read from the module.** `CHANNEL_ORDER`, `MAX_CHANNELS`, `SHAPED_WAVE_TYPES`, and `fmPresets` are live bindings set when an entry loads the module; with `./init` they are `undefined` before `await init()`.
- **Odd inputs the reference accepted by accident are refused or read differently.** A patternable control given `undefined` or `null` throws `gain() needs a number, a mini-notation string, or a pattern, got undefined` (0.3 threw a `TypeError` from inside its parser); a numeric string as the rate of `pitchsteps()` or `panpath()` is refused (0.3 stored the string); a string `push` in `drift()` is read as a number (0.3 added it to the nudge as text); a field of `fmVoice()` that is not a number is refused (0.3 copied it); a number field of `score()` that is not a number reports `NaN` where 0.3 printed the value as given; and `true` or an object given to a patternable control is read as `String(value)`.
- **`./testing`'s `resetWarnings`** clears the module's once-only set. The warnings themselves are printed by the module with `console.warn`, once per key per instance of the module.
- **Some of the reference's own tests are not ported yet:** 190 of the 374 public tests in the ported files book voices on a fake `AudioContext`, play, loop, or render, so they wait for the engine bindings. The corpus (layers 1 and 2, 1,456 cases) runs through the package in the meantime.
