---
title: Stereo & Surround
---

# Stereo and surround placement

`.pan(p)` places a voice in the stereo field, −1 (hard left) to 1 (hard right), and like most controls it takes a number, a mini-notation string or a pattern, so `.pan(sine2)` sweeps the field. For real multichannel rigs, `.channels([...])` sets raw per-speaker gains in FL, FR, C, LFE, SL, SR, RL, RR order, and `.surround(angleDegrees)` is the friendlier form — equal-power placement at an angle on the 7.1 speaker ring (0° front-centre, ±90° sides, ±180° dead behind). `channels`/`surround` take precedence over `pan` when both are set.

By default a destination stays stereo and multichannel placements fold down automatically. To address real surround speakers, opt the context in once:

```ts standalone audio=surround-multichannel
import { enableMultichannel, note } from '@liminal-hq/undertone';

const ctx = new AudioContext();
enableMultichannel(ctx); // widens the destination to the hardware's channel count, up to 8

note('c4(5,8)').sound('triangle').surround(135).loop({ ctx, bpm: 120 });
```

`enableMultichannel` never goes past `MAX_CHANNELS` (8), and it returns the channel count the destination ended up with. On hardware with fewer than eight channels, a placement folds down to what the destination has: on four-channel hardware only the first two outputs sound, and on plain stereo hardware the fold-down is automatic, so surround placement is safe to ship speculatively.

### The gains behind a placement

A surround placement is eight channel gains in a fixed order, exported as `CHANNEL_ORDER` (`FL`, `FR`, `C`, `LFE`, `SL`, `SR`, `RL`, `RR`), and `MAX_CHANNELS` is how many there are (8). `surroundGains(angleDegrees)` returns the gains `.surround()` uses for an angle: 0 is front-centre, positive angles run clockwise, and the LFE channel is always silent. `foldToStereo(gains)` returns the `[left, right]` pair those gains fold down to on a stereo destination, which is what plain hardware plays.

```ts live
import {
  CHANNEL_ORDER,
  MAX_CHANNELS,
  foldToStereo,
  note,
  surroundGains
} from '@liminal-hq/undertone';

const gains = surroundGains(135); // rear right
console.log(
  MAX_CHANNELS,
  CHANNEL_ORDER.map((name, i) => `${name}=${gains[i].toFixed(2)}`)
);
console.log(foldToStereo(gains)); // [left, right]

note('c4(5,8)').sound('triangle').surround(135).loop({ bpm: 120 });
```

## Pan in the Strudel style

There are three layers of pan movement, from the one that follows the music to the one that follows the clock. Pick the lightest that does the job.

1. **A value per event: patternable `.pan`.** Each note gets its own pan, read at its onset. This is what Strudel's `pan(sine)` does, and it is a plain control, so a number, a string or a pattern all work. Pan runs −1 to 1 here, so use the bipolar signals (`sine2`, `saw2`, ...) or `.range(-1, 1)` for a full sweep; a value outside the range is clamped to the side, with one warning.
2. **Named movement inside a note: `autopan` and `panslide`.** An LFO on the panner (`autopan`, shaped by `autopandepth`, `autopanshape` and `autopanphase`) or a slide from a start pan (`panslide`). The rate and the times are in seconds and hertz, on the audio clock, so a held note keeps moving. The numbers of `autopan`, `autopandepth`, `autopanphase` and the start of `panslide` can be patterns too, read at each onset.
3. **Raw data: `panpath` and `pitchsteps`.** An array of pans or `{ time, pan }` points, the same for every note, as plain data. Not patternable.

`.panlaw(db)` is a scalar: it sets the pan law for the whole voice and not per event.

```ts live
import { note, sine2 } from '@liminal-hq/undertone';

// A value per event: each note one step further along a slow sweep of the field.
note('c4*8').sound('triangle').decay(0.2).pan(sine2.slow(2)).loop({ bpm: 120 });
```

## Moving the pan: panpath, panslide and autopan

`.pan()` sets one position per note. To slide, wobble or jump the pan while a note is held, give the voice data a `panPath`: points in time order, each a stereo position. The first point is the pan at the onset (it replaces `pan`), the pan moves linearly from each point to the next, two points at the same time make a jump, and the last value holds through the release. Pans are clamped to −1..1.

On a pattern, `.panpath()` gives every note the same path, as plain data in the same way `.pitchsteps()` gives a pitch curve. An array of pans is frame-stepped: one pan per frame at a rate in Hz (default 140, the frame rate of classic AdLib effects), jumping from frame to frame and holding the last. An array of `{ time, pan }` points, in seconds from the onset, ramps instead:

```ts live
import { cat, note } from '@liminal-hq/undertone';

// Stepped: a fast left-right flutter, 30 frames a second, settling in the centre.
const stepped = note('c4 e4')
  .sound('square')
  .sustain(0.5)
  .panpath([-0.8, 0.8, -0.8, 0.8, -0.4, 0.4, 0], 30);

// Ramped: each note sweeps from right to left over half a second.
const ramped = note('a2')
  .sound('sawtooth')
  .sustain(0.6)
  .panpath([
    { time: 0, pan: 1 },
    { time: 0.5, pan: -1 }
  ]);

cat(stepped, ramped).loop({ bpm: 120 }); // one cycle of each, over and over
```

Pans must be from −1 to 1 and point times must not go backwards; a rate is only taken with an array of pans. `.panpath()` is plain data, not patternable, and it replaces `.pan()`.

In a `score()` event the points are in whole ticks from the onset:

```ts live
import { score } from '@liminal-hq/undertone';

score({
  ticksPerSecond: 100,
  lengthTicks: 200,
  events: [
    {
      tick: 0,
      note: 'e3',
      gate: 160,
      voice: { soundType: 'triangle', sustain: 0.8 },
      // A wobble: left, right, left, then a jump to the centre for the release.
      panPath: [
        { tick: 0, pan: -0.6 },
        { tick: 40, pan: 0.6 },
        { tick: 80, pan: -0.6 },
        { tick: 120, pan: 0.6 },
        { tick: 160, pan: 0.6 },
        { tick: 160, pan: 0 }
      ]
    }
  ]
}).loop();
```

In plain voice data, such as `playParams()` takes, the points are in seconds from the voice's start:

```ts standalone audio=surround-play-params
import { playParams } from '@liminal-hq/undertone';

const ctx = new AudioContext();
playParams(ctx, [
  {
    soundType: 'sawtooth',
    pitch: 'a2',
    sustain: 0.6,
    duration: 1,
    panPath: [
      { time: 0, pan: 1 },
      { time: 1, pan: -1 } // a one-second sweep from right to left
    ]
  }
]);
```

The path drives one stereo panner per voice, and the room and delay sends are taken after it, so the wet signal moves with the dry one. Stopping a voice early (a handle's `stop()`, a cut group or `loop().stop({ voices: 'cut' })`) holds the pan where the path had got to while it fades out. Like `pan`, a path is ignored when `.channels()` or `.surround()` is set.

### Pan slide

`.panslide(from, seconds?)` is `.slide()` for the pan: each note starts at pan `from` and moves linearly to its own pan (the centre without one) over `seconds`, or over the note's attack when you leave it out. It is a two-point pan path underneath, so it stops early the same way, and a `.panpath()` takes precedence over it (with a warning). `from` takes a number, a string or a pattern (clamped to −1..1); the time is a plain number. In voice data it is `panSlideFrom` and `panSlideTime`.

```ts live
import { note } from '@liminal-hq/undertone';

// Every hit flies in from the left to where it sits.
note('c3*4').sound('square').decay(0.3).pan(0.4).panslide(-1, 0.15).loop({ bpm: 120 });
```

### Autopan

`.autopan(hz)` swings the pan with a low-frequency oscillator, as `.phaser()` sweeps its filters: a real `OscillatorNode` in the voice's graph, not booked points, so the movement is smooth at any rate and costs two nodes per voice. Shape it with:

- `.autopandepth(d)`: how far it swings either side of the pan, 0 to 1. Default 1.
- `.autopanshape(s)`: `'sine'` (default), `'triangle'` or `'square'` (a square jumps between the two sides).
- `.autopanphase(p)`: where in its cycle it starts, 0 to 1. Default 0: a sine or triangle starts at the pan moving right, a square on the right; 0.5 starts the other way.

```ts live
import { note } from '@liminal-hq/undertone';

// A pad that drifts slowly from side to side around the centre.
note('<c3 a2>').sound('triangle').sustain(0.8).autopan(0.25).autopandepth(0.7).loop({ bpm: 60 });
```

The voice's pan is the centre of the swing. With a `panPath` or a pan slide too, the path sets the centre and the LFO adds to it; the panner clamps the sum to −1..1, so a deep swing off-centre flattens at the side. `autopan`, `autopandepth` and `autopanphase` take numbers, strings or patterns; the shape is a plain value. In voice data the controls are `autopan` (Hz), `autopanDepth`, `autopanShape` and `autopanPhase`, and a `score()` event takes `autopan: { periodTicks, depth, shape?, phase? }`, with the period in whole ticks:

```ts live
import { score } from '@liminal-hq/undertone';

score({
  ticksPerSecond: 100,
  lengthTicks: 400,
  events: [{ tick: 0, note: 'e3', gate: 400, pan: 0.2, autopan: { periodTicks: 50, depth: 0.5 } }]
}).loop();
```

How it is built, for anyone matching the graph:

- An `OscillatorNode` of the shape's type, its `frequency` set to the rate at the voice's start (`setValueAtTime`). For a phase other than 0 it gets a periodic wave instead: the built-in wave's Fourier series (up to 64 harmonics for a triangle or square), each harmonic k turned by k · 2π · phase, normalized as the built-in waves are. A context without `createPeriodicWave` drops the phase, with a warning.
- A `GainNode` at the depth (`setValueAtTime` at the voice's start), fed by the oscillator, connected to the panner's `pan` param, which adds it to the pan booked there.
- The oscillator starts at the voice's start and stops with the voice's source, after the release, or after the fade of an early stop.
- The sends are taken after the panner as before, so the wet signal swings too. `.channels()` and `.surround()` take precedence, and then no LFO is made.
- Under a pan law the voice keeps its stereo panner, so the LFO has a `pan` to drive. A law below −3 dB is the panner's curve scaled down, so one gain after the panner (√2 · 10^(law/20)) gives it exactly. A law above −3 dB cannot follow a moving pan with the nodes Undertone uses, so an autopanned voice keeps the −3 dB law there, with a warning.

## Pan law

A pan law says how loud a voice is on each side as it moves across. Undertone's default is the stereo panner's equal-power law: at the centre each side is about 3 dB down (1/√2), so a voice keeps the same power wherever it sits. Some mixes want a louder or quieter centre, and `.panlaw(db)` gives each side's level at the centre, from −6 to 0 dB:

```ts live
import { note } from '@liminal-hq/undertone';

// A balance-control feel: the centre stays full on both sides.
note('c3 e3 g3 b3').sound('triangle').pan('-1 -0.5 0.5 1').panlaw(0).loop();
```

The same control is `panLaw` in plain voice data, and `score({ panLaw })` gives it to every event (an event whose `voice` sets its own keeps it). With a law other than −3, each side's gain is

min(1, √2 · 10^(law/20) · cos θ) on the left and min(1, √2 · 10^(law/20) · sin θ) on the right, with θ = (pan + 1) · π/4.

The equal-power curve is scaled so the centre lands on the law, and each side stops at full. Each side's level in dB:

| Law                             | Hard left (left side) | Centre (each side) | Hard right (right side) |
| ------------------------------- | --------------------- | ------------------ | ----------------------- |
| −3 (default, the stereo panner) | 0                     | −3.01              | 0                       |
| 0                               | 0                     | 0                  | 0                       |
| −1.5                            | 0                     | −1.5               | 0                       |
| −4.5                            | −1.49                 | −4.5               | −1.49                   |
| −6                              | −2.99                 | −6                 | −2.99                   |

The far side is silent at a hard pan under every law. In general the centre is the law and a hard pan is min(0, law + 3.01) dB.

How it is built: with the default law nothing changes, and the voice goes through a `StereoPannerNode` as before. With any other law the voice goes through one gain per side into a two-input channel merger (the nodes `.channels()` uses), each booked with the law's gain. A `panPath` is booked on both gains: each ramp of the path becomes linear gain ramps no more than 1/32 of a pan apart, with a break where a side reaches full, so the levels land on the law at every point of the path and stay within 0.001 dB of it in between (wherever the side is above −20 dB). Stopping a voice early holds both gains where the path had got to. The room and delay sends are taken after the merger, so the wet signal is placed too.

A few things to know:

- `.panlaw()` only shapes voices that are panned (`.pan()` or a `panPath`); an unpanned voice still plays at full on both sides, as it always has.
- `.channels()` and `.surround()` take precedence over the pan law, as they do over `pan`.
- Under a custom law a stereo sample is summed to mono before it is placed, as it is under `.channels()`; the stereo panner places a stereo sample's two sides instead.
- The −3 setting is the stereo panner itself, whose centre is 1/√2 (−3.0103 dB). The formula at exactly −3 would give 0.0103 dB more; the panner is used so that the default graph never changes.
