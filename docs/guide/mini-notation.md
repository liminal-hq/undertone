---
title: Mini-Notation
---

# Mini-notation, one step at a time

Writing one event per pattern gets old fast. `note()`, `sound()`, `n()`, `chord()`, and `s()` all accept a mini-notation string that describes a whole cycle of events. Here's the syntax, in the order it's worth learning; the examples use `.loop()` so you can hear the cycle repeat — call `handle.stop()` when you've heard enough.

**Sequence.** Space-separated steps divide the cycle equally. Four steps at the default 120 bpm (a 2-second cycle) means one note every half second:

```ts
const handle = note('c4 e4 g4 b4').sound('triangle').loop({ bpm: 120 });
```

**Rests.** `~` is a step of silence, taking up its share of the cycle like any other step:

```ts
note('c4 ~ e4 ~').sound('triangle').loop({ bpm: 120 });
```

**Subdivision.** Square brackets nest a sequence inside one step — the bracketed group splits its parent step's time, so rhythms subdivide naturally:

```ts
note('c4 [e4 g4] c4 [e4 g4 b4]').sound('triangle').loop({ bpm: 120 });
```

**Alternation.** Angle brackets play a _different child each cycle_ — `<b3 c4>` is `b3` on the first pass, `c4` on the next, and so on. This is the cheapest way to make a short pattern feel longer than one cycle:

```ts
note('c3 e3 g3 <b3 c4>').sound('triangle').loop({ bpm: 140 });
```

One nuance worth knowing early: `.play()` plays cycle zero only, so an alternation in a one-shot always plays its first option. Alternation is a looping construct.

**Chords and layers.** A comma means "at the same time" — inside brackets it's a chord; at the top level it layers independent sequences (a polyrhythm, since each side divides the cycle its own way):

```ts
note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>').sound('sine').sustain(0.8).loop({ bpm: 80 });
note('[c4 e4 g4, c2 f2]').sound('triangle').loop({ bpm: 110 }); // 3 against 2
```

**Speed, replication, elongation.** `a*2` squeezes two repeats of a step into its slot, `a/2` stretches it over two cycles, `a!3` writes the step three times, and `a@3` gives it three shares of the cycle instead of one:

```ts
note('c4@3 g4').sound('triangle').loop({ bpm: 120 }); // long c, short g
```

**Euclidean rhythms.** `a(3,8)` distributes 3 onsets as evenly as possible over 8 slots (the tresillo `x..x..x.`); a third argument rotates the result. Layered euclideans with different pulse counts are an instant groove:

```ts
note('[c2(3,8), g2(5,8,2), c4(7,16,4)]').sound('square').sustain(0.12).lpf(900).loop({ bpm: 130 });
```

Everything composes: `<c5 e5 g5 b5 a5 g5>*2 ~` alternates _and_ doubles _and_ rests, and the same string syntax works inside `n()`, `chord()`, `s()`, and — see [patterned parameters](/guide/patterned-parameters) — every numeric control.
