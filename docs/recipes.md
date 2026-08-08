---
title: Recipes
---

# Recipes

Complete patterns to copy, run, and bend into your own. Each one works as written — the synth-only recipes need no assets at all. Two ground rules apply to all of them: the first `play()` or `loop()` in your app must happen inside a user gesture (click, tap, keypress — browser autoplay policy), and every `loop()` returns a handle whose `stop()` ends it.

## A drum machine, no samples required

Kick, snare, and hats synthesized from scratch: the kick is a low sine with a downward pitch `slide` (the classic thump), the snare is highpassed white noise over a short tone, and the hats are eighth-note white noise with a patterned gain for accents.

```ts
import { note, sound, stack } from '@liminal-hq/undertone';

const kick = note('c1 ~ [~ c1] ~')
  .sound('sine')
  .attack(0.001)
  .decay(0.12)
  .release(0.06)
  .gain(0.9)
  .slide(0.09);

const snare = stack(
  sound('~ white ~ white').attack(0.001).decay(0.09).release(0.05).gain(0.5).hpf(1600),
  note('~ e2 ~ e2').sound('triangle').attack(0.001).decay(0.05).gain(0.35)
);

const hats = sound('white*8').attack(0.001).decay(0.03).release(0.01).gain('[.45 .2]*4').hpf(6000);

const drums = stack(kick, snare, hats);
const handle = drums.loop({ bpm: 118 });
// handle.stop() when you've had enough
```

Things to bend: swap the kick's rhythm for a euclidean `note('c1(3,8)')`, push the hats to `'white*16'`, or give the snare a splash of shared reverb with `.room(0.3)`.

### The same groove with your own samples

If you have recordings, register them and let `s()` drive the same rhythms. `.bank('TR808')` makes `bd` look up `TR808_bd` first, so swapping kits is a one-word change.

```ts
import { loadSamples, registerSamples, s, stack } from '@liminal-hq/undertone';

registerSamples({
  TR808_bd: '/audio/808/kick.wav',
  TR808_sd: '/audio/808/snare.wav',
  TR808_hh: '/audio/808/hat.wav'
});

const ctx = new AudioContext();
await loadSamples(ctx); // decode up front so the first cycle isn't missing hits

const kit = stack(s('bd ~ [~ bd] ~'), s('~ sd ~ sd'), s('hh*8').gain('[.6 .3]*4')).bank('TR808');

const handle = kit.loop({ ctx, bpm: 118 });
```

Undertone bundles no samples — see the [samples guide](/guide/samples) for registration details and `baseNote` pitching.

## An ambient pad

Three slow layers on a 4-second cycle (`bpm: 60`): a chord progression voiced into real pitches, a filtered sawtooth drone with a slow phaser, and a sparse pentatonic shimmer echoing through a delay. The pad and drone share reverb on orbit 1; the shimmer gets its own delay bus on orbit 2 so the two effect characters don't fight (see [effects](/guide/effects) for why orbits exist).

```ts
import { chord, n, note, stack } from '@liminal-hq/undertone';

const pad = chord('<Am9 FM7 CM7 G6>')
  .voicing()
  .sound('sine')
  .attack(0.8)
  .decay(0.5)
  .sustain(0.7)
  .release(1.2)
  .gain(0.28)
  .lpf(1400)
  .room(0.6)
  .roomsize(8)
  .orbit(1);

const drone = note('a1')
  .sound('sawtooth')
  .attack(1.5)
  .sustain(0.6)
  .release(2)
  .gain(0.2)
  .lpf(350)
  .phaser(0.4)
  .room(0.4)
  .orbit(1);

const shimmer = n('<0 4 2 7>*2 ~ <4 9> ~')
  .scale('a5:minorPentatonic')
  .sound('triangle')
  .attack(0.05)
  .decay(0.3)
  .sustain(0.2)
  .release(0.4)
  .gain(0.22)
  .pan('<-0.5 0.5 0>')
  .delay(0.4)
  .delaytime(0.45)
  .delayfeedback(0.45)
  .orbit(2);

const handle = stack(pad, drone, shimmer).loop({ bpm: 60 });
```

The long attacks only work because `loop()` gates each envelope by its event's length — a whole-cycle chord at `bpm: 60` has 4 seconds to bloom. The same patterns through `.play()` would clip to percussive blips; slow textures are a looping thing.

## A game-SFX kit

One-shots want the opposite envelope: near-zero attack, short decay, `sustain: 0`. Build the patterns once at module scope, then call `.play()` whenever the game event fires — patterns are immutable, so one object serves unlimited plays. These four are adapted from the demo in `demo/`:

```ts
import { note, sound, stack } from '@liminal-hq/undertone';

// Menu click / toggle: a bright sine tick with a tiny noise transient.
export const uiBlip = stack(
  note('a5').sound('sine').attack(0.001).decay(0.06).release(0.03).gain(0.5).lpf(3000),
  sound('white').attack(0).decay(0.008).release(0.005).gain(0.15).lpf(6000)
);

// Success / coins collected: an ascending two-note chime, offset with nudge().
export const cashIn = stack(
  note('c5').sound('triangle').attack(0.002).decay(0.12).release(0.08).gain(0.5).lpf(4000),
  note('e5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.16)
    .release(0.1)
    .gain(0.5)
    .lpf(4500)
    .nudge(0.06)
);

// Denied / error: a square wave sliding down through a tight lowpass.
export const error = note('a2')
  .sound('square')
  .attack(0.001)
  .decay(0.12)
  .release(0.08)
  .gain(0.5)
  .lpf(600)
  .slide(0.15);

// Achievement fanfare: a rising arpeggio — each note nudged later than the last.
export const fanfare = stack(
  note('c5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500),
  note('e5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500)
    .nudge(0.09),
  note('g5')
    .sound('triangle')
    .attack(0.002)
    .decay(0.1)
    .sustain(0.2)
    .release(0.08)
    .gain(0.45)
    .lpf(3500)
    .nudge(0.18),
  note('c6').sound('sine').attack(0.002).decay(0.3).release(0.2).gain(0.4).lpf(5000).nudge(0.27)
);
```

Wiring it up is just calling `.play()` in your handlers:

```ts
buyButton.addEventListener('click', () => cashIn.play());
lockedDoor.addEventListener('click', () => error.play());
```

Two one-shot habits worth building: `nudge(seconds)` is how you arpeggiate inside a single onset (a `<a b>` alternation won't help — `.play()` runs cycle zero only, so it always picks the first option), and `slide(seconds)` — a glide down from an octave above — is the fastest route to "thunk" and "whoosh" shapes. More worked one-shots live in the repo's `demo/` directory: `bulldoze`, `powerOn`, `notification`, `undo`.

## An acid bassline

A sawtooth line where the movement comes from patterned parameters: the resting cutoff walks between values per cycle via a `<...>` alternation in `.lpf()`, a filter envelope snaps each note open, and `jux(rev)` plays the reversed line hard right against the original hard left.

```ts
import { note, rev } from '@liminal-hq/undertone';

const acid = note('a1 [a1 a2] c2 <e2 g1>')
  .sound('sawtooth')
  .attack(0.004)
  .decay(0.12)
  .sustain(0.25)
  .release(0.08)
  .gain(0.6)
  .lpf('<400 700 1100 700>')
  .lpenv(900)
  .lpa(0.01)
  .lpd(0.1)
  .lps(0.2)
  .lpr(0.1)
  .jux(rev);

const handle = acid.loop({ bpm: 150 });
```

Every numeric control takes a mini-notation string like that `.lpf()` — see [patterned parameters](/guide/patterned-parameters).

## A short song with arrange()

`arrange()` plays each `[cycles, pattern]` entry for its span of whole cycles, then loops the whole thing. Build sections from shared parts, then lay them out — this reuses the drum machine from the first recipe:

```ts
import { arrange, chord, n, note, sound, stack } from '@liminal-hq/undertone';

// The drum machine from the first recipe, condensed.
const drums = stack(
  note('c1 ~ [~ c1] ~').sound('sine').attack(0.001).decay(0.12).release(0.06).gain(0.9).slide(0.09),
  sound('~ white ~ white').attack(0.001).decay(0.09).release(0.05).gain(0.5).hpf(1600),
  sound('white*8').attack(0.001).decay(0.03).release(0.01).gain('[.45 .2]*4').hpf(6000)
);

const pads = chord('<Am9 FM7 CM7 G6>')
  .voicing()
  .sound('sine')
  .attack(0.4)
  .sustain(0.7)
  .release(0.6)
  .gain(0.3)
  .room(0.4)
  .roomsize(6)
  .orbit(1);

const bass = note('<a1 f1 c2 g1>(3,8)').sound('square').sustain(0.15).lpf(500).gain(0.5);

const lead = n('<0 2 4 7 4 2>*2 ~')
  .scale('a4:minor')
  .sound('triangle')
  .sustain(0.2)
  .gain(0.35)
  .delay(0.25)
  .delaytime(0.33)
  .delayfeedback(0.35)
  .orbit(2);

// Sections are just stacks of the parts.
const intro = pads;
const groove = stack(pads, bass, drums);
const full = stack(pads, bass, drums, lead);
const outro = stack(pads, bass);

// 2 + 4 + 8 + 2 = 16 cycles per pass, then it rounds again.
const song = arrange([2, intro], [4, groove], [8, full], [2, outro]);
const handle = song.loop({ bpm: 112 });
```

Each section restarts its own cycle count when its span begins, so the `<Am9 FM7 CM7 G6>` alternation always opens on `Am9` no matter where the section sits in the arrangement — you can develop a section standalone with `.loop()` and slot it in unchanged. And since `arrange()` returns an ordinary pattern, it composes: `stack(arrange(...), drums)` keeps drums running under every section, and `.fast(2)` halves the whole song's length. More in [arranging songs](/guide/arranging-songs).
