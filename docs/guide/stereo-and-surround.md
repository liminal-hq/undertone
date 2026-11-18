---
title: Stereo & Surround
---

# Stereo and surround placement

`.pan(p)` places a voice in the stereo field, −1 (hard left) to 1 (hard right), and like most controls it takes a mini-notation string. For real multichannel rigs, `.channels([...])` sets raw per-speaker gains in FL, FR, C, LFE, SL, SR, RL, RR order, and `.surround(angleDegrees)` is the friendlier form — equal-power placement at an angle on the 7.1 speaker ring (0° front-centre, ±90° sides, ±180° dead behind). `channels`/`surround` take precedence over `pan` when both are set.

By default a destination stays stereo and multichannel placements fold down automatically. To address real surround speakers, opt the context in once:

```ts
import { enableMultichannel, note } from '@liminal-hq/undertone';

const ctx = new AudioContext();
enableMultichannel(ctx); // widens the destination to the hardware's channel count

note('c4(5,8)').sound('triangle').surround(135).loop({ ctx, bpm: 120 });
```

On plain stereo hardware the same code still sounds right — the fold-down is automatic — so surround placement is safe to ship speculatively.

## Moving the pan inside a note

`.pan()` sets one position per note. To slide, wobble or jump the pan while a note is held, give the voice data a `panPath`: points in time order, each a stereo position. The first point is the pan at the onset (it replaces `pan`), the pan moves linearly from each point to the next, two points at the same time make a jump, and the last value holds through the release. Pans are clamped to −1..1.

In a `score()` event the points are in whole ticks from the onset:

```ts
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

```ts
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

## Pan law

A pan law says how loud a voice is on each side as it moves across. Undertone's default is the stereo panner's equal-power law: at the centre each side is about 3 dB down (1/√2), so a voice keeps the same power wherever it sits. Some mixes want a louder or quieter centre, and `.panlaw(db)` gives each side's level at the centre, from −6 to 0 dB:

```ts
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
