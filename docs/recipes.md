---
title: Recipes
---

# Recipes

Complete patterns to copy, run, and bend into your own. Each one works as written — the synth-only recipes need no assets at all. Two ground rules apply to all of them: the first `play()` or `loop()` in your app must happen inside a user gesture (click, tap, keypress — browser autoplay policy), and every `loop()` returns a handle whose `stop()` ends it.

A code block marked `ts standalone` runs as written: it imports everything it uses, defines everything it refers to, and plays or renders what it builds. The test suite executes every such block against the library on a fake `AudioContext` (`src/docSnippets.test.ts`), on this page, the guides and the README, so a missing import or a pattern that is built but never played fails the build. A plain `ts` block is a fragment that depends on its surroundings, and says so. Most of the blocks on this page are `ts live`, the same promise with a **Play** button: they run the real library in your browser, and you can edit them first (see [live examples](/guide/getting-started#live-examples)). The ones left static need your own sample files, create their own `AudioContext`, or render offline instead of playing. Those carry a player under the code with the audio the code makes, rendered when the site is built by the TypeScript library on `node-web-audio-api` (a Node implementation of Web Audio), with procedural stand-ins where the code names sample files. The audio is illustrative: your browser's own Web Audio can differ from it by a fraction of a decibel, a little more where the limiter is working hard.

## A drum machine, no samples required

Kick, snare, and hats synthesized from scratch: the kick is a low sine with a downward pitch `slide` (the classic thump), the snare is highpassed white noise over a short tone, and the hats are eighth-note white noise with a patterned gain for accents.

```ts live
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

```ts standalone audio=recipes-drum-kit
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

```ts live
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

One-shots want the opposite envelope: near-zero attack, short decay, `sustain: 0`. Build the patterns once at module scope, then call `.play()` whenever the game event fires — patterns are immutable, so one object serves unlimited plays. These four are adapted from the [playground](/playground)'s "Game SFX" examples:

```ts live
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

// Play one from a click, tap or keypress (autoplay policy):
fanfare.play();
```

Wiring it up is just calling `.play()` in your handlers, here on the kit above:

```ts
buyButton.addEventListener('click', () => cashIn.play());
lockedDoor.addEventListener('click', () => error.play());
```

Two one-shot habits worth building: `nudge(seconds)` is how you arpeggiate inside a single onset (a `<a b>` alternation won't help — `.play()` runs cycle zero only, so it always picks the first option), and `slide(seconds)` — a glide down from an octave above — is the fastest route to "thunk" and "whoosh" shapes. More worked one-shots are one click away in the [playground](/playground)'s "Game SFX" examples: `bulldoze`, `powerOn`, `notification`, `undo`.

## An acid bassline

A sawtooth line where the movement comes from patterned parameters: the resting cutoff walks between values per cycle via a `<...>` alternation in `.lpf()`, a filter envelope snaps each note open, and `jux(rev)` plays the reversed line hard right against the original hard left.

```ts live
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

```ts live
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

## Richer voices with the controls you already have

You don't need FM to get most of the way to a rich, FM-flavoured sound. These four techniques use only the controls Undertone already has, and they make a good baseline to compare against when more synthesis options arrive.

### A filter envelope as a stand-in for a decaying modulator

In a two-operator FM voice, a quick-decaying modulator gives a bright attack that mellows as the note settles. A lowpass with a filter envelope does the same job: it opens at the attack and closes as the note sustains. Remember that `.lpenv()` is added on top of `.lpf()`, so the filter peaks at `lpf + lpenv`.

```ts live
import { note } from '@liminal-hq/undertone';

const pluck = note('e4 g4 b4 a4')
  .sound('sawtooth')
  .attack(0.004)
  .decay(0.2)
  .sustain(0.3)
  .release(0.15)
  .lpf(500)
  .lpenv(3500)
  .lpa(0.002)
  .lpd(0.18)
  .lps(0.1)
  .lpr(0.12)
  .gain(0.4);

pluck.loop({ bpm: 100 });
```

### Layering: a pluck over a sustained partner

Two voices on the same notes, with a different waveform, more sustain, a few milliseconds of `.nudge()` and opposite `.pan()` positions, sound much fuller than either alone. The tiny start offset reads as width rather than as an echo.

```ts live
import { note, stack } from '@liminal-hq/undertone';

const melody = 'e5 g5 b5 a5';

const lead = stack(
  note(melody).sound('square').sustain(0.2).decay(0.08).lpf(2400).pan(-0.4).gain(0.3),
  note(melody).sound('triangle').sustain(0.6).decay(0.3).nudge(0.002).pan(0.4).gain(0.25)
);

lead.loop({ bpm: 110 });
```

### Gate versus release

A note's gate (how long the key is held) and its release (how long it rings afterwards) are separate ideas. In a looped pattern each event is held for its own share of the cycle, then released, so a long `.release()` gives a short hit with a ringing body. For drums, use very short notes with a fast decay and a `.slide()`.

```ts live
import { note, stack } from '@liminal-hq/undertone';

// Short notes, long ring-out: a mallet-like tone.
const mallet = note('c5 e5 g5 e5*2')
  .sound('sine')
  .attack(0.002)
  .decay(0.05)
  .sustain(0.3)
  .release(0.6)
  .gain(0.35);

// A tom: a very short note with a quick downward slide.
const tom = note('a2 ~ ~ ~').sound('sine').decay(0.15).release(0.05).slide(0.08).gain(0.7);

stack(mallet, tom).loop({ bpm: 100 });
```

### Dynamics in `.gain()`

Keep one instrument definition and put the expression in the gain pattern, so a ghost note and an accent are the same instrument at different levels rather than two different sounds.

```ts live
import { note } from '@liminal-hq/undertone';

const groove = note('e2 e2 g2 e2').sound('sawtooth').lpf(700).sustain(0.2).gain('.6 .25 .5 .25');

groove.loop({ bpm: 120 });
```

### Keeping a dense mix in range

Undertone writes straight to the speakers, so a busy cue can peak at or above full scale. `createMasterBus()` puts a gain stage and a limiter in front of the destination; pass its `input` as the `output` of everything that should share it.

```ts standalone audio=recipes-master-bus
import { createMasterBus, note, stack } from '@liminal-hq/undertone';

const ctx = new AudioContext();
const bus = createMasterBus(ctx, { gain: 0.9 }); // limiter on by default

const music = stack(
  note('<a2 e2>(3,8)').sound('sawtooth').lpf(600).gain(0.5),
  note('e5 g5 b5 d6').fm(1.2).fmh(3.5).decay(0.4).gain(0.3)
);

music.loop({ ctx, output: bus.input });
```

Browsers' compressors add automatic makeup gain, which would make a limited mix louder and push peaks back up. The bus takes that makeup back out (`limiter: { compensate: false }` keeps it), so the threshold, -2 dB by default, is close to the ceiling. It is a fast compressor rather than a true brick-wall limiter, so brief peaks can still pass the threshold. The bus is an ordinary object you hold, so a game can make one for music and another for effects. The limiter steps aside above two output channels (a compressor would fold surround to stereo), and the gain stage keeps working.

When a file or a stream must never pass a level, add a `ceiling` in dBFS: `createMasterBus(ctx, { ceiling: -0.3 })`, or `render({ master: { ceiling: -0.3 } })`. It is a hard clip after everything else on the bus: samples below the ceiling pass unchanged, and a sample above it is set to the ceiling. A render with `wrap: true` is clamped to it again after the tail is folded onto the start, so the returned file holds the ceiling too. The limiter still does the work of keeping the mix down; the clip only catches what its 3 ms attack lets through, so it should touch a few samples, not the music. It is off by default, and without it the bus is exactly the gain stage and limiter above.

Why a clip and not a look-ahead limiter: a look-ahead limiter delays the signal and turns the gain down before a peak arrives, which needs the level of the signal ahead of the playhead. Web Audio's built-in nodes cannot measure a level and drive a gain from it (the compressor's detector is not exposed), so it would need an `AudioWorklet`, which Undertone does not use. A wave shaper is a built-in node, costs one node per bus and no latency, and guarantees the ceiling for every sample. The price is that an over that does reach it is clipped, which is distortion; keep the limiter's threshold below the ceiling so that is rare. It bounds sample values, not the peaks a DAC reconstructs between samples, so leave a fraction of a dB for those.

## Moving the pan

Four ways to move a sound across the stereo field, from the smallest change to the most control. Each one is an example in the [playground](/playground) under "Moving the pan". The [stereo guide](/guide/stereo-and-surround#moving-the-pan-panpath-panslide-and-autopan) has the full reference.

A pad with a slow autopan: an LFO swings the pan, smoothly, at any rate. `.autopan(0.25)` is one sweep every four seconds (it is in hertz, so it does not follow `bpm`).

```ts live
import { chord } from '@liminal-hq/undertone';

chord('<Dm9 Gm9 Bbmaj7 A7>')
  .voicing()
  .sound('triangle')
  .attack(0.4)
  .sustain(0.8)
  .release(1)
  .lpf(1800)
  .gain(0.25)
  .room(0.4)
  .autopan(0.25)
  .autopandepth(0.7)
  .loop({ bpm: 70 });
```

A lead that flies in from the left: `.panslide(from, seconds)` is `.slide()` for the pan. Each note starts at `from` and moves to its own `.pan()`.

```ts live
import { note } from '@liminal-hq/undertone';

note('e4 g4 b4 a4 g4 e4 d4 ~').sound('square').pan(0.4).panslide(-1, 0.12).loop({ bpm: 100 });
```

A melody with a path inside each note: `{ time, pan }` points ramp, and an array of pans steps frame by frame.

```ts live
import { cat, note } from '@liminal-hq/undertone';

// A sweep from hard right to hard left over half a second, every note.
const sweep = note('a2 e3 a3 c4')
  .sound('sawtooth')
  .legato(1)
  .panpath([
    { time: 0, pan: 1 },
    { time: 0.5, pan: -1 }
  ]);

// A flutter, 30 frames a second, that settles in the centre.
const flutter = note('c4 e4 g4 e4')
  .sound('square')
  .legato(1)
  .panpath([-0.8, 0.8, -0.8, 0.8, -0.4, 0.4, 0], 30);

// One cycle of each, over and over.
cat(sweep, flutter).loop({ bpm: 100 });
```

Hats can drift across the field one hit at a time with a signal, instead of a path inside each note. `.pan(sine2.slow(4))` reads a bipolar sine at each hat's onset, so the field is swept once every four cycles (use `sine2`, not `sine`: pan runs -1 to 1):

```ts live
import { sine2, sound } from '@liminal-hq/undertone';

sound('white*8').attack(0.001).decay(0.03).gain(0.4).pan(sine2.slow(4)).loop({ bpm: 120 });
```

Finally the pan law, which says how loud a voice is in the middle. `.panlaw(db)` gives each side's level at the centre, from -6 to 0 dB; the default is -3, the stereo panner's equal-power law. To hear the difference, play the same notes under each law, one per cycle:

```ts live
import { cat, note } from '@liminal-hq/undertone';

const crossing = note('c3 e3 g3 e3 c4 e4 g4 e4')
  .sound('triangle')
  .pan('-1 -0.5 0 0.5 1 0.5 0 -0.5');

cat(crossing.panlaw(-6), crossing.panlaw(-3), crossing.panlaw(0)).loop({ bpm: 100 });
```

A path, a slide and an autopan can be combined: the path or slide sets the centre of the swing and the LFO adds to it. `.channels()` and `.surround()` take precedence over all of them.

## Signals

A signal is a value that changes through time (see the [Signals guide](/guide/signals)), and any numeric control can read one. Each event reads it once, at its onset.

A bass with a filter that wanders on its own: `perlin` is smooth random motion, and `.range()` puts it between two frequencies.

```ts live
import { note, perlin } from '@liminal-hq/undertone';

note('c2*8')
  .sound('sawtooth')
  .decay(0.2)
  .sustain(0.2)
  .lpf(perlin.range(300, 2400))
  .gain(0.35)
  .loop({ bpm: 110 });
```

Random accents that come out the same every time you play: a random signal is a pure function of its seed and the time, so `.seed(7)` gives the same sequence of velocities on every run and in every render. The sequence does not repeat from one cycle to the next, because each cycle reads its own stretch of time. To repeat one cycle's accents, wrap the signal in `arrange([1, …])`, which makes it live through its first cycle again every cycle. Change the seed for another take.

```ts live
import { arrange, rand, sound } from '@liminal-hq/undertone';

sound('white*16')
  .attack(0.001)
  .decay(0.03)
  .gain(0.35)
  .hpf(6000)
  .velocity(arrange([1, rand.seed(7).range(0.3, 1)]))
  .loop({ bpm: 120 });
```

An autopan whose LFO carries on from where the last note left it, as if one LFO ran under the whole loop. `.autopanphase()` takes a pattern, and the phase a note needs at its onset is `hz × seconds` modulo 1, which is `saw` sped up to turn that many times per pattern cycle. A cycle is four beats, so at 80 BPM it lasts three seconds, and a 0.5 Hz LFO turns 1.5 times in it. `saw.fast(1.5)` then reads 0 at the first chord, 0.5 at the second, 0 at the third, and so on (the saw's own value is the fraction of a turn, and `autopanphase()` is a fraction of a turn too). Change the rate or the tempo and the phase signal follows.

```ts live
import { chord, saw } from '@liminal-hq/undertone';

const bpm = 80;
const lfoHz = 0.5;
// A pattern cycle is four beats: 240 / bpm seconds (3 s at 80 BPM).
const secondsPerCycle = 240 / bpm;
// Turns of the LFO in one pattern cycle: 0.5 Hz x 3 s = 1.5. The saw repeats once a cycle,
// so speeding it up by this many gives the LFO's phase (its fraction of a turn) at any onset.
const turnsPerCycle = lfoHz * secondsPerCycle;

chord('<Am7 Fmaj7>')
  .voicing()
  .sound('triangle')
  .attack(0.2)
  .sustain(0.7)
  .gain(0.25)
  .autopan(lfoHz)
  .autopandepth(0.8)
  .autopanphase(saw.fast(turnsPerCycle))
  .loop({ bpm });
```

## Safe loud mixes

A busy cue can peak above full scale, and a file you render should not clip when somebody plays it. Use the limiter to keep the mix down and the ceiling as the last guarantee. The same options work live, on a master bus, and offline, in `render()`:

```ts standalone audio=recipes-ceiling
import { createMasterBus, encodeWav, note, stack } from '@liminal-hq/undertone';

const loud = stack(
  note('[c3,e3,g3,b3,d4]').sound('sawtooth').gain(0.9),
  note('[c4,e4,g4,b4,d5]').sound('square').gain(0.9),
  note('c2*4').sound('square').gain(0.9)
);

// Offline: the limiter alone can let a sharp transient past full scale.
const limited = await loud.render({ cycles: 4, tail: 1 });

// With a ceiling, no sample is louder than -0.3 dBFS.
const safe = await loud.render({ cycles: 4, tail: 1, master: { ceiling: -0.3 } });
const bytes = encodeWav(safe, { bitDepth: 24 });

// Live, the same ceiling on a bus:
const ctx = new AudioContext();
const bus = createMasterBus(ctx, { ceiling: -0.3 });
loud.loop({ ctx, output: bus.input });
```

The ceiling is a hard clip, so keep the limiter's threshold under it and let the clip catch only a few samples; if it is clipping often, turn the voices down. It bounds sample values, not the peaks a DAC reconstructs between samples, so leave a fraction of a dB. The playground has no export control or level meter, so these are for your own code. See [keeping a dense mix in range](#keeping-a-dense-mix-in-range) for the reasoning.

## Long renders

By default `render()` books every voice on the offline context before it starts. For a short cue that is the simplest thing, but a long score with thousands of notes can be slow on a renderer that processes every node from the moment it is made. `bookingWindow` books the score a window of seconds at a time, pausing the render between windows:

```ts standalone audio=recipes-arrange
import { arrange, encodeWav, note, stack } from '@liminal-hq/undertone';

// Any pattern will do; this is 16 cycles of a bass and a lead.
const song = arrange(
  [8, stack(note('<a1 f1 c2 g1>(3,8)').sound('square').lpf(500), note('a4 c5 e5 c5').fm(1))],
  [8, stack(note('<a1 f1 c2 g1>(3,8)').sound('square').lpf(500), note('e5 g5 b5 g5').fm(1))]
);

// A pattern renders one cycle unless you say how long: 16 cycles at 120 bpm (two seconds a cycle) is 32 s.
const buffer = await song.render({
  cycles: 16,
  bpm: 120,
  tail: 2, // so the last release rings out
  seed: 7, // the same seed, tempo and sample rate give the same samples
  bookingWindow: 1, // book one second of notes at a time
  master: { ceiling: -0.3 }
});
const wav = encodeWav(buffer, { bitDepth: 24 });
```

Say the length with `cycles` (whole cycles) or `seconds`, never both; without either, a pattern renders a single cycle, which is two seconds at the default 120 bpm, whatever its `arrange()` sections add up to. A `score()` is different: its `render()` plays one pass of the whole score, which is its own length (`cue.seconds`) and can be minutes, so a long score is where `bookingWindow` matters most. It takes no `seconds` or tempo, because the score has its own (`cycles` would repeat the pass):

```ts standalone audio=recipes-score
import { encodeWav, fmPresets, score } from '@liminal-hq/undertone';

const cue = score({
  ticksPerSecond: 560,
  lengthTicks: 560 * 60, // a minute; a real score has thousands of events in it
  events: [{ tick: 0, note: 'e4', gate: 560, voice: fmPresets.lead }]
});

// One pass is 60 seconds, so book it in windows.
const buffer = await cue.render({ tail: 2, bookingWindow: 1 });
const wav = encodeWav(buffer, { bitDepth: 24 });
```

The audio is the same as booking up front: same voices, same order, same parameters. The window must be at least two render quanta (about 5 ms); a second or so is a good start. A context without `suspend()` and `resume()` falls back to booking everything up front, with a warning. It was measured on a Rust implementation of Web Audio, where it cut a 75-second score from 85 s to under 12 s; no browser has been measured. The whole render still lives in memory, so very long pieces may need to be rendered in sections. See [Rendering and export](/guide/rendering-and-export#booking-in-windows).
