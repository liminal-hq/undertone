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
