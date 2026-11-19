---
title: Tempo & Note Length
---

# Looping, note length, and tempo

`.play()` and `.loop()` differ in more than repetition — they treat the envelope differently, and this is the detail that makes looped patterns sound like music instead of a stream of clicks.

The amplitude envelope is a standard ADSR: `.attack(s)` ramps to peak, `.decay(s)` falls to `sustain × peak`, `.release(s)` ramps back to silence. In a one-shot, release starts as soon as decay lands — percussive, no hold, which is exactly right for SFX and is why the default `sustain` is `0`. In a loop, each event knows its _length_ (its share of the cycle at the current tempo), and the envelope **holds at the sustain level until that length is up** before releasing — the event is "gated" by its note length. A whole note and a sixteenth note built from the same voice sound different in a loop; in a one-shot they'd be identical blips.

The practical consequence: **a held sound in a loop needs a non-zero sustain**. With the default `sustain: 0` there is nothing to hold (the engine doesn't even bother gating — the voice is silent after its decay regardless), so a chorale patch wants something like `.sustain(0.8)` while a plucky bassline might want `.sustain(0.1)` or none at all.

```ts live
import { note, rev, stack } from '@liminal-hq/undertone';

const music = stack(
  note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>').sound('sine').sustain(0.8),
  note('c5 [e5 g5] <b5 a5> ~').sound('triangle').every(2, rev).jux(rev).gain(0.4),
  note('c2(3,8)').sound('square').lpf(400)
);

const handle = music.loop({ bpm: 110 });
// handle.stop() when you've had enough (the Stop button does that here)
```

Tempo: `bpm` counts four beats per cycle, so the default 120 bpm means 2-second cycles and a 4-step sequence lands one step per beat. If you'd rather set tempo once instead of passing `{ bpm }` everywhere, `setcpm(cyclesPerMinute)` sets a default in cycles per minute (`setcpm(30)` is the same speed as `bpm: 120`); an explicit `bpm` or `cps` on any call still wins, and `resetTempo()` clears the override.

A running loop **follows** the default tempo: a `.loop()` started without `bpm` or `cps` re-reads the `setcpm()` value on every scheduler tick, so calling `setcpm()` (or `resetTempo()`) while it plays changes its speed from the next scheduling window, with no gap, overlap or restart — voices already booked keep their times, and the loop carries on from the end of them at the new tempo. A loop started with an explicit `{ bpm }` or `{ cps }` keeps that tempo and ignores later changes. `.play()` reads the tempo once, when it is called.

```ts
import { note, setcpm } from '@liminal-hq/undertone';

setcpm(30);
const handle = note('c3 e3 g3 b3').loop(); // 2-second cycles
// ... later, the running loop speeds up to 1-second cycles:
setcpm(60);
handle.stop();
```

`stop()` stops _scheduling_ — voices already handed to the audio clock (the scheduler looks ahead about a third of a second) finish their envelopes and ring out rather than being cut off mid-note.

Pattern-level transforms are worth experimenting with here, since they only reveal themselves over multiple cycles: `.fast(n)`/`.slow(n)` rescale time, `.rev()` mirrors each cycle, `.every(n, fn)` applies a transform every nth cycle (`pat.every(4, rev)`), `.euclid(pulses, steps)` redistributes any pattern onto a euclidean grid, and `.jux(fn)` plays the original hard left with a transformed copy hard right — `pat.jux(rev)` is the classic stereo shimmer.
