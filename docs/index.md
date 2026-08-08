---
layout: home
title: undertone

hero:
  name: undertone
  text: Procedural sound for games and music
  tagline: A TypeScript synth engine built directly on the Web Audio API — one-shot sound effects, looped grooves, and whole multi-section songs, all from the same pattern. Zero required runtime dependencies. MIT licensed.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Recipes
      link: /recipes
    - theme: alt
      text: Coming from Strudel
      link: /coming-from-strudel
    - theme: alt
      text: API Reference
      link: /api/

features:
  - icon: '🧩'
    title: Everything is a pattern
    details: A UI blip, a bassline, and an entire song are the same kind of object. Fire it once with play() for game SFX, or run it forever with loop() — held notes, grooves, and arrangements fall out of the same machinery.
  - icon: '🎼'
    title: Mini-notation
    details: Sequences, subdivision, per-cycle alternation, rests, chords, replication, elongation, and euclidean rhythms — a whole cycle of events in one string, with exact rational timing underneath so triplets never drift.
  - icon: '🎹'
    title: Scales and chords
    details: Scale-degree melodies resolved against named scales, and chord symbols like Dm9 or BbM7 expanded into real pitches — no bundled music-theory data, just the maths.
  - icon: '🎛️'
    title: Patterned parameters
    details: Every numeric control — gain, filter cutoff, pan, envelope stages, effect sends — accepts a mini-notation string instead of a scalar, sampled per event. Accents, filter walks, and stereo motion cost one string each.
  - icon: '📦'
    title: Bring-your-own samples
    details: Sample playback works exactly like synth voices, but nothing is bundled or fetched by default. Register your own assets by URL or buffer; synthesis alone needs no assets at all.
  - icon: '🔊'
    title: Stereo to 7.1 surround
    details: Per-voice pan, raw per-speaker gains, or equal-power placement at an angle on the speaker ring — with automatic stereo fold-down on plain hardware, so surround code is safe to ship speculatively.
---

## Sixty seconds of undertone

```bash
bun add @liminal-hq/undertone
# or: npm install @liminal-hq/undertone
```

A one-shot game sound effect and a looped, polyphonic track, from the same API:

```ts
import { note, rev, stack } from '@liminal-hq/undertone';

// One-shot SFX — call it from a click handler (autoplay policy):
note('c5').sound('triangle').decay(0.1).gain(0.5).play();

// Looped music — chords, a melody with a stereo shimmer, a euclidean bassline:
const handle = stack(
  note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>').sound('sine').sustain(0.8),
  note('c5 [e5 g5] <b5 a5> ~').sound('triangle').every(2, rev).jux(rev).gain(0.4),
  note('c2(3,8)').sound('square').lpf(400)
).loop({ bpm: 110 });

// ...later:
handle.stop();
```

Every constructor returns an immutable `Pattern`; every chained call returns a new one. Nothing touches audio until `.play()` or `.loop()` — patterns are cheap to build, branch, and reuse.

## Where to go from here

- **[Getting started](/guide/getting-started)** — the mental model and your first sounds, building up through [mini-notation](/guide/mini-notation), [scales and chords](/guide/melody-and-harmony), [samples](/guide/samples), [effects](/guide/effects), and [full arrangements](/guide/arranging-songs).
- **[Recipes](/recipes)** — complete, runnable patterns to copy and adapt: a drum machine, an ambient pad, a game-SFX kit, a multi-section song.
- **[Coming from Strudel](/coming-from-strudel)** — already write Strudel? The vocabulary transfers; here are the differences that actually matter.
- **[API reference](/api/)** — every exported function, class, and type, generated from the source.

Undertone's vocabulary is Strudel-flavoured, but it's a clean-room, MIT-licensed implementation built from the published TidalCycles papers, standard music theory, and Strudel's public documentation — never from its AGPL source or data. Ship it in anything.
