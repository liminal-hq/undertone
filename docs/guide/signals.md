---
title: Signals
---

# Signals

A signal is a pattern with no rhythm of its own: a value that changes smoothly (or randomly) through cycle time, such as a sine wave or a stream of random numbers. Signals come from Strudel and TidalCycles, where they are called continuous patterns or oscillators. You read a signal by giving it a rhythm: `segment(n)` cuts it into `n` events per cycle, and any event of a structured pattern can read it at its onset.

Almost every numeric control takes a signal: `.pan(sine2)` pans each note by the sine at its onset, and `.lpf(sine.range(400, 4000))` walks a filter. [Signals as control values](#signals-as-control-values) says how.

## The signals

Each periodic signal repeats once per cycle and runs from 0 to 1. The phase is the position inside the cycle, read exactly from Undertone's rational cycle time, so the value at cycle 3¼ is the value at ¼.

| Signal   | At 0 | At ¼ | At ½ | At ¾ | Shape                                                    |
| -------- | ---- | ---- | ---- | ---- | -------------------------------------------------------- |
| `saw`    | 0    | 0.25 | 0.5  | 0.75 | Rises linearly from 0 to 1, then jumps back to 0.        |
| `isaw`   | 1    | 0.75 | 0.5  | 0.25 | Falls linearly from 1 to 0, then jumps back to 1.        |
| `sine`   | 0.5  | 1    | 0.5  | 0    | `0.5 + 0.5·sin(2π·phase)`.                               |
| `cosine` | 1    | 0.5  | 0    | 0.5  | `0.5 + 0.5·cos(2π·phase)`: `sine` a quarter cycle ahead. |
| `tri`    | 0    | 0.5  | 1    | 0.5  | Rises from 0 to 1 by the half, then falls back to 0.     |
| `square` | 0    | 0    | 1    | 1    | 0 for the first half of the cycle, 1 for the second.     |

Every one has a bipolar form running from -1 to 1, `2v - 1` of the unipolar value: `saw2`, `isaw2`, `sine2`, `cosine2`, `tri2` and `square2`. (`isaw2` is Undertone's own addition, for symmetry.)

`signal(fn)` makes your own: `fn` receives the cycle time as a number (3.25 at cycle 3¼, not its phase) and returns the value, so `signal((t) => t % 1)` is `saw`.

The random signals are described under [Randomness](#randomness-and-seeds) below: `rand`, `rand2`, `irand(n)`, `choose(...values)`, `brand`, `brandBy(p)` and `perlin`.

## Reading a signal at an onset

A signal is read at the **onset** of the event that reads it: the start of the event's whole (or of its part, for the rare event with no whole). It is never averaged over the event, and never read at the event's middle. One event, one value.

```ts
import { saw, sine } from '@liminal-hq/undertone';

sine.segment(4); // four events per cycle: 0.5, 1, 0.5, 0 (read at 0, ¼, ½ and ¾)
saw.range(0, 8).segment(8); // 0, 1, 2, 3, 4, 5, 6, 7
```

To hear a segmented signal, give it to `n()`, which takes a pattern that has events and floors each value to a scale degree:

```ts standalone
import { n, saw } from '@liminal-hq/undertone';

// Eight notes a cycle climbing the scale: degrees 0 to 7.
n(saw.range(0, 8).segment(8)).scale('C4:major').sound('triangle').loop({ bpm: 100 });
```

These are the values Strudel's public REPL gives for the same code, so the phase conventions and the sampling point match Strudel's published behaviour (see [Sources](#sources)).

**Events at the same instant read the same value.** Two notes of a chord, or two stacked patterns with an onset at the same moment, get the same sine value and the same random number. To make them differ, read different signals, or the same random signal with different seeds.

### Structure comes from the left

When a structured pattern and a signal meet, the structured pattern supplies the events and the signal supplies values. A signal never adds or removes events. This holds for arithmetic (`segment(4).add(sine)` keeps four events per cycle) and for controls (`s('hh*8').pan(sine2)` is eight hats, each panned by the sine at its onset).

## segment(n)

`pattern.segment(n)` gives the pattern `n` evenly spaced events per cycle, each holding the pattern's value at that event's onset. `n` is a positive number (`segment(2.5)` is allowed, as for `fast()`); anything else throws `segment() count must be positive, got 0`. An onset where the pattern has no value (a rest) gives no event.

`segment()` works on any pattern, but it is how a signal becomes something you can hear on its own: `n(sine.segment(8).range(0, 7))`.

## Ranges

| Call              | Expects input | Gives                                                                                                                                                                                                                                                       |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.range(lo, hi)`  | 0 to 1        | `lo + v·(hi - lo)`, linear.                                                                                                                                                                                                                                 |
| `.range2(lo, hi)` | -1 to 1       | `lo + (v + 1)/2·(hi - lo)`, linear.                                                                                                                                                                                                                         |
| `.rangex(lo, hi)` | 0 to 1        | `lo·(hi/lo)^v`, exponential, the right curve for frequencies (`rand.rangex(200, 2000)` spends as long between 200 and 632 Hz as between 632 and 2000). Both bounds must be above 0, otherwise it throws `rangex() bounds must be positive, got 0 and 2000`. |

A range does not clamp: a value outside the expected input maps outside `lo..hi`, on the same line. `lo` may be above `hi`, which turns the signal upside down.

## Arithmetic

`.add(x)`, `.sub(x)`, `.mul(x)` and `.div(x)` take a number or a pattern of numbers. A number applies to every value. A pattern on the right is read at each onset of the left side, the same rule as everywhere else, so structure comes from the left: `sine.segment(4).add(saw)` has four events, each `sine(t) + saw(t)` at its onset. Where the right side has no value at an onset (a rest), the event is dropped. `.round()` rounds to the nearest whole number (halves round up) and `.floor()` rounds down (-4.2 becomes -5). A signal stays a signal through all of these: `sine.add(saw)` has no events until you segment it or a control reads it.

Division by zero gives JavaScript's `Infinity`, which a control later treats as a rest.

## Signals as control values

Every numeric control takes a number, a mini-notation string or a pattern, and a signal is a pattern. The control is read at the onset of each event, and the structure stays the left side's: `s('hh*8').pan(sine2)` is eight hats, each panned by the sine at its onset, and `s('hh*8').pan(0.5)` and `.pan(pure(0.5))` give exactly the same events and the same sound.

```ts standalone
import { sine, sine2, sound } from '@liminal-hq/undertone';

// Eight hats a cycle, each one place further along a slow sweep of the stereo field,
// with the filter opening and closing once a cycle.
sound('white*8')
  .attack(0.001)
  .decay(0.03)
  .pan(sine2.slow(4))
  .lpf(sine.range(2000, 9000))
  .gain(0.4)
  .loop({ bpm: 120 });
```

The controls that take a pattern: `attack`, `decay`, `sustain`, `release`, `gain`, `lpf`, `lpenv`, `lpa`, `lpd`, `lps`, `lpr`, `hpf`, `phaser`, `room`, `roomsize`, `delay`, `delaytime`, `delayfeedback`, `slide`, `fm`/`fmi`, `fmh`, `fmattack`, `fmdecay`, `fmsustain`, `fmrelease`, `penv`, `pattack`, `pdecay`, `nudge`/`late`/`early`, `duration`, `legato`, `velocity`, `pan`, the start of `panslide`, `autopan`, `autopandepth` and `autopanphase`. `n()` takes a pattern that has events, as shown above; `note()` does not, because its numbers are frequencies in hertz.

Some controls stay plain values and throw `cut() takes a plain value, not a pattern; it cannot change from event to event` when given a pattern: `fmenv`, `fmwave`, `autopanshape`, `cut`, `orbit`, `panlaw`, `channels`, `surround`, the time of `panslide`, and the data controls `panpath(points)` and `pitchsteps()`.

Signals combine with everything else in the usual way. A signal inside `fast`, `slow`, `rev`, `every`, `cat`, `euclid` or `jux` moves as the combinator says, and a signal read by a control inside a `jux` transform reads the same cycle time as the event:

```ts standalone
import { note, sine } from '@liminal-hq/undertone';

// The right-hand copy has a filter that opens and closes once a cycle; the left-hand copy has none.
note('c3 e3 g3 b3 g3 e3')
  .sound('sawtooth')
  .gain(0.3)
  .jux((pat) => pat.lpf(sine.range(300, 3000)))
  .loop({ bpm: 90 });
```

### What a control does with a bad value

A signal can give a value a control cannot use: `sine.range(0, 2)` goes past what `pan` accepts, and `1 / 0` is not a number at all. Reading a signal must never throw, because a throw would end a loop's tick and the music would stop. So the control deals with it, and warns once (per control, however many notes) in the console, for example `undertone: pan() got 1.4 from a pattern; clamped to 1.`

| Control and what it gets                                                           | What happens                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pan` and the start of `panslide` outside -1 to 1                                  | Clamped to -1 or 1.                                        |
| `autopandepth` and `autopanphase` outside 0 to 1                                   | Clamped to 0 or 1.                                         |
| `autopan` or `fmh` at or below 0; `fm`, `duration`, `legato` or `velocity` below 0 | The key is left unset, as for a rest: the default applies. |
| NaN, Infinity, -Infinity, or something that is not a number (for any control)      | Left unset.                                                |
| No value at the onset (a rest, or a function that returns `undefined`)             | Left unset, with no warning.                               |

A value left unset leaves whatever an earlier call set. The other controls have no range rule beyond that, as for a plain number. The same checks do not apply to a number or string you write directly: `.pan(2)` and `.pan('<-.6 1.2>')` still throw when the pattern is built, so a typo fails early.

## Combinators on signals

The pattern combinators work on signals and move the signal in time the way they move events:

- `fast(f)` reads the signal at `t·f`, `slow(f)` at `t/f`.
- `rev()` mirrors each cycle: at `c + x` it reads `c + 1 - x`. So `sine.rev().segment(4)` reads at 1, ¾, ½ and ¼ of the cycle and gives 0.5, 0, 0.5, 1.
- `every(n, fn)` picks the transformed signal on cycles 0, n, 2n, and the plain one otherwise.
- `cat(...)` and `arrange(...)` play one signal per cycle (or per section), each experiencing its own consecutive cycles, exactly as for events.
- `seq(...)` and `timecat(...)` squeeze each signal into its share of the cycle: `seq(saw, sine)` runs a whole `saw` in the first half of each cycle and a whole `sine` in the second.
- `stack(...)` of signals reads the first signal when sampled at a point; stacking is mostly useful once each layer has its own rhythm.
- `euclid(pulses, steps, rotation)` on a signal gives the events of the rhythm, each holding the signal's value at its onset (a structure, like Strudel's `struct`). On an ordinary pattern it still squeezes the pattern into each pulse.

Undertone reads a signal at an exact point through a small sampler that each combinator carries along, rather than by querying a span and taking the first value. That is what keeps `rev()` exact: a query over a mirrored span starts at the mirrored end, which is the wrong point.

## Randomness and seeds

| Signal              | Gives                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `rand`              | A random number from 0 up to (not including) 1 at each point in time.    |
| `rand2`             | `2·rand - 1`: -1 up to 1.                                                |
| `irand(n)`          | A random whole number from 0 to `n - 1`. `n` must be a positive integer. |
| `choose(...values)` | One of the values, picked at random: `choose(-1, 0, 1)`.                 |
| `brandBy(p)`        | 1 with probability `p` (0 to 1), otherwise 0.                            |
| `brand`             | `brandBy(0.5)`.                                                          |
| `perlin`            | Smooth random motion from 0 to 1: Perlin-style value noise.              |

Random signals are **deterministic**. Each value is a pure function of three things: the seed, the kind of signal, and the exact rational time at which it is read. Reading the same signal at the same time always gives the same value, however the pattern is queried, in whatever order, in whatever window sizes, on whatever device. A loop sounds the same on every pass that reads the same times, and a render is repeatable.

`rand`, `rand2`, `irand`, `choose`, `brand` and `brandBy` share one random stream per seed, so at the same seed and the same instant `irand(8)` is `floor(rand·8)`. `perlin` has its own stream: it picks a random value at each whole cycle and glides between neighbours with Perlin's smootherstep curve `6x⁵ - 15x⁴ + 10x³`, so it passes exactly through those values at whole cycles and has no corners.

The default seed is 0. Choose another with `.seed(n)` **directly on the random signal**, before anything else is chained:

```ts
rand.seed(7).range(200, 2000); // right
rand.range(200, 2000).seed(7); // throws
```

`seed()` on anything other than `rand`, `rand2`, `perlin`, `irand()`, `choose()` and `brand`/`brandBy()` throws `seed() works directly on rand, rand2, perlin, irand(), choose() and brand — call it before range() or segment()`. Signal randomness is independent of `render()`'s seed and of a context's noise seed, so the same pattern gives the same values everywhere, with or without an audio context.

The scheme is stable from 0.4.0: the value of a random signal at time `t` (a fraction `n/d` in lowest terms) is the first output of `seededRandom('seed|kind|n/d')`, the same FNV-1a string hash and mulberry32 generator `drift()` uses, where `kind` is `rand` or `perlin`. Values are Undertone's own and never match Strudel's.

## Differences from Strudel

- **Pan runs -1 to 1.** `.pan(x)` means exactly pan `x`, so a sine from 0 to 1 only moves a sound from the centre to the right. Use the bipolar form for a full sweep: `.pan(sine2)`, or `.pan(sine.range(-1, 1))`. A pan outside -1 to 1 is clamped, with one warning.
- **Events are never fragmented.** A signal never splits an event in two, and an event reads one value at its onset.
- **`.late()` and `.early()` stay in seconds**, as for every Undertone pattern. Shift a signal in cycle time by composing it instead, for example `cat()` or `signal((t) => …)`.
- **`euclid` on a signal acts as a structure**, giving the rhythm's events each read at its onset.
- **Random values are Undertone's own**, from a published, frozen scheme; the same seed never gives Strudel's numbers. Seeds go directly on the random signal with `.seed(n)`.

## Sources

Undertone is a clean-room implementation. The semantics on this page come only from published documentation and observed behaviour, never from Strudel's or Tidal's source code:

- Strudel's documentation: the [Signals](https://strudel.cc/learn/signals/) page (the signals, their 0..1 ranges and the bipolar `*2` forms), [Value modifiers](https://strudel.cc/functions/value-modifiers/) (`range`, `rangex`, `range2`, the arithmetic, structure from the left) and [Random modifiers](https://strudel.cc/learn/random-modifiers/) (`choose`).
- The public Strudel REPL, watched with `.log()`: `sine.segment(4)` gives 0.5, 1, 0.5, 0; `square.segment(4)` 0, 0, 1, 1; `tri.segment(4)` 0, 0.5, 1, 0.5; `saw.segment(4)` 0, 0.25, 0.5, 0.75; `isaw.segment(4)` 1, 0.75, 0.5, 0.25; `n(saw.range(0,8).segment(8))` 0 to 7; `sine.segment(4).rev()` 0, 0.5, 1, 0.5. These settle the phases and that a segment reads its value at its onset.
- The TidalCycles [oscillators](https://tidalcycles.org/docs/reference/oscillators) reference: the shapes of `sine`, `cosine`, `square`, `tri`, `saw` and `isaw`, and that oscillators have no structure of their own.
- Ken Perlin, "Improving Noise" (SIGGRAPH 2002): the smootherstep curve `6t⁵ - 15t⁴ + 10t³`.
- Background on patterns as functions of time, continuous patterns and structure from the left: Alex McLean, "Making Programming Languages to Dance to: Live Coding with Tidal" (FARM 2014); McLean, "Algorithmic Pattern" (NIME 2020); Felix Roos and Alex McLean, "Strudel: Live Coding Patterns on the Web" (ICLC 2023).

Undertone's own choices: `isaw2`, onset sampling for every reader (not only `segment()`), the exact-phase read on rational time, the random scheme and its seeds, and `perlin` as one-dimensional value noise between per-cycle random values.
