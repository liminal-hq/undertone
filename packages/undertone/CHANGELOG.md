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
- **B8. Size.** The package is larger: the WebAssembly module is about 100 KB after Brotli at this stage, inside the 150 KB budget of D-07.
- **B9. Object identity.** Every query returns new `Hap` and `Fraction` objects. Within one query, haps with equal values share one value object (as the haps of one mini-notation word did).
- **B10. Errors.** Error messages are word for word the reference's, and the class is still `Error`.

#### New with the first bindings

- **A pattern's value cannot be `null` or a class instance.** `pure(null)`, `choose(new Fraction(1, 2))`, or a mini-notation leaf function returning one throws `a pattern value must be a number, a string, a boolean, undefined, an array, or a plain object, got ...`. Numbers (`NaN`, `Infinity`, `-0` included), strings, booleans, `undefined`, arrays, and plain objects (to 64 levels) cross unchanged. Use `undefined` or a plain object where you used `null`.
- **Map keys come back sorted.** A value that is an object has its keys in alphabetical order, where 0.3 kept insertion order.
- **Equal values within one query share one object.** Mutating a value you got from one hap can show in another hap of the same query that holds an equal value; copy before you change one.
- **`free()` and `using`.** `Pattern#free()` and `[Symbol.dispose]()` are new, optional, and safe to call twice; see the README.
- **Overflow.** A pattern whose times overflow 128-bit fractions (`pure(1).fast(2 ** 53).fast(2 ** 53).fast(2 ** 53)`, queried) stops the WebAssembly instance (`RuntimeError: unreachable`) where 0.3 silently lost precision; reload the page or the process.
- **`@liminal-hq/undertone/testing`** is new (D-28): `resetWarnings`, `seedContext`, `playVoice`, and `playVoices`, kept out of the API report.
