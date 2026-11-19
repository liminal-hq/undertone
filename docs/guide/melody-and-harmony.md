---
title: Melody & Harmony
---

# Melody and harmony

Writing every pitch out as note names works, but scale degrees and chord symbols are usually what you're actually thinking in. Both are patterns like everything else, so they mix freely with `note()` in a `stack()`.

**Scale degrees.** `n()` takes integers (or a mini-notation string of them) and `.scale('D5:minor')` resolves them against a named scale — root note + octave, colon, scale name (`major`, `minor`, `dorian`, `mixolydian`, `harmonicMinor`, `majorPentatonic`, and friends — [`Pattern.scale()`](/api/classes/Pattern#scale) has the full list). Degrees past the scale's length wrap up an octave (`7` in a 7-note scale is the root an octave up), and negative degrees descend the same way, so runs and octave jumps are just arithmetic:

```ts live
import { n } from '@liminal-hq/undertone';

n('0 2 4 <7 -3>').scale('d5:minor').sound('triangle').sustain(0.3).loop({ bpm: 130 });
```

**Chord symbols.** `chord()` takes symbols like `Dm9`, `BbM7`, `A7sus` and `.voicing()` expands each one into simultaneous pitched notes, exactly as if you'd written a `[d3,f3,a3,c4,e4]` chord in mini-notation. Voicing is deterministic and anchored around middle C by default (`.voicing({ anchor: 'g4' })` to taste), and same-root changes share common tones so progressions don't leap around. Case matters in qualities: `M7` is a major seventh, `m7` a minor seventh — see [`chord()`](/api/functions/chord) for the supported vocabulary.

**Putting them together.** Since already-pitched events pass through `.scale()` and `.voicing()` untouched, a progression, a bassline, and a melody are three patterns stacked:

```ts live
import { chord, n, note, stack } from '@liminal-hq/undertone';

const progression = chord('<Dm9 BbM7 Gm9 A7sus>').voicing().sound('sine').sustain(0.8).gain(0.35);

const bass = note('<d2 bb1 g1 a1>(3,8)').sound('square').sustain(0.2).lpf(500).gain(0.5);

const melody = n('<0 2 4 5 4 2 1 0>*2 ~')
  .scale('d5:minor')
  .sound('triangle')
  .sustain(0.25)
  .gain(0.3);

const handle = stack(progression, bass, melody).loop({ bpm: 96 });
```

The alternations line up because they all cycle at the same rate: each cycle gets one chord, the matching bass root, and the next two melody degrees.

## Note names, MIDI numbers, and frequencies

Three small helpers convert between the ways of naming a pitch. `noteToMidi('c4')` gives the MIDI number (60, with `a4` at 69), `noteToFrequency()` gives hertz from a note name or a MIDI number (`noteToFrequency('a4')` is 440), and `midiToFrequency()` does the same from a number alone. They are handy for anything that wants a frequency in hertz rather than a note, such as a filter cutoff that follows the key:

```ts live
import { midiToFrequency, note, noteToFrequency, noteToMidi } from '@liminal-hq/undertone';

const root = noteToMidi('a2'); // 45
const cutoff = midiToFrequency(root + 24); // two octaves above the root, in hertz

// A bass line whose filter sits at the pitch of a4 (440 Hz) rather than a magic number.
note('a2 a2 c3 e3').sound('sawtooth').sustain(0.3).lpf(noteToFrequency('a4')).loop({ bpm: 110 });
note('a4').sound('sine').lpf(cutoff).play();
```
