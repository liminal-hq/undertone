---
title: Samples
---

# Samples

Undertone bundles no samples and fetches nothing by default — sample playback is strictly bring-your-own-assets. The flow is: register names, optionally preload, then play them with `s()` exactly like synth voices.

```ts
import {
  loadSamples,
  note,
  registerSample,
  registerSamples,
  s,
  stack
} from '@liminal-hq/undertone';

registerSamples({
  bd: '/audio/kick.wav',
  sd: '/audio/snare.wav',
  hh: '/audio/hat.wav'
});
registerSample('bass', { url: '/audio/pluck-e1.wav', baseNote: 'e1' });

// Optional but recommended: decode everything up front so the first
// cycle isn't missing voices while decoding is still in flight.
const ctx = new AudioContext();
await loadSamples(ctx);

const kit = stack(
  s('bd ~ [bd bd] sd'),
  s('hh*8').gain(0.4),
  note('e1 ~ g1 a1').s('bass').sustain(0.5)
);
const handle = kit.loop({ ctx, bpm: 100 });
```

The pieces:

- `registerSample(name, source)` points a name at a URL (fetched with plain `fetch()` when first needed), an already-downloaded `ArrayBuffer`, an already-decoded `AudioBuffer`, or a `{ url?, data?, buffer?, baseNote? }` object. `registerSamples({ ... })` registers many at once. Registration is cheap and synchronous — nothing is fetched or decoded yet.
- `baseNote` declares the pitch the recording actually sounds at (default `'c4'`). When a sample plays a pitched event — `note('e1 g1').s('bass')` — the playback rate is the ratio of the event's frequency to the base note's, so one recording covers a melody. A typo'd `baseNote` throws immediately at `registerSample()` time rather than surfacing later mid-playback.
- `loadSamples(ctx, names?)` preloads and decodes — everything registered, or just the given names. It's optional: playback also decodes on demand, but an onset whose sample is still decoding is _skipped for that one onset_ and picked up by later onsets once decoding finishes. For a loop that's a missing beat or two at the start; for a one-shot it can mean silence, so preload anything you'll `play()`.
- `s('bd sd hh')` is the constructor, and `.s(name)` the chainable equivalent for putting a sample on an already-built pattern. Any word that matches one of the seven synth types (`sine`, `white`, ...) behaves exactly like `sound()`; anything else is a sample name, validated against the registry at play time (since you might register after building the pattern).
- `.bank(name)` is a lookup convention, not a loader: it tries `${bank}_${sampleName}` before the bare name, so after `registerSample('TR707_bd', ...)`, `s('bd').bank('TR707')` finds it — handy for swapping kits by changing one call.

Two behaviours worth knowing. First, an _unregistered_ name never throws during playback — the voice is skipped silently with a once-per-name console warning (`undertone: sample "xyz" is not registered`), because a hard throw inside the loop scheduler would take the whole pattern down. Check the console when a layer is mysteriously absent. Second, sample voices default to `sustain: 1` (hold, not the percussive synth default), so a gated loop event lets the recording ring for its full note length — but a one-shot `.play()` has no gate, so its envelope releases right after the decay (about 0.16 s on defaults). To hear a sample ring out in a one-shot, give it room explicitly, e.g. `.decay(1)` for a second of full-level playback before the release.

You are responsible for the legal status of whatever you register — undertone deliberately points at no sample library, Strudel's CDN included.
