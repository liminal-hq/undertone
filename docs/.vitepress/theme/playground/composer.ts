// The composer: a live JS code editor against the real undertone API — write any pattern
// expression (stack, seq, cat, euclid, custom JS logic) and hear it, live, as you type.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { hoverTooltip, keymap } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { basicSetup, EditorView } from 'codemirror';
import * as api from '../../../../src/index';
import { Fraction, Pattern, enableMultichannel } from '../../../../src/index';
import type { ControlPatch, LoopHandle } from '../../../../src/index';
import { findUnregisteredSamples, prepareImportedScript, scriptName } from './importScript';
import type { UnregisteredSample } from './importScript';
import { drawPattern } from './pianoRoll';

const STORAGE_KEY = 'undertone-composer-script';
const SHARE_PREFIX = '#composer=';
const HISTORY_KEY = 'undertone-composer-history';
const HISTORY_LIMIT = 30;
const HISTORY_ENTRY_MAX_CHARS = 100_000;

// Every value export from src/index.ts a script can usefully call, minus a
// few that don't fit this specific surface: setcpm()/resetTempo() would be
// silently inert (the Once/Loop buttons always pass an explicit bpm from the
// tempo slider, and an explicit bpm always wins), and buildImpulseResponse()/
// getOrbitBus() are effects-internals rather than composition primitives.
// Derived from the `api` namespace (rather than hand-listed) so a future
// export is included automatically instead of silently missing from both the
// eval sandbox and autocomplete until someone remembers to add it here too.
const SCOPE_EXCLUDED = new Set(['setcpm', 'resetTempo', 'buildImpulseResponse', 'getOrbitBus']);
const SCOPE: Record<string, unknown> = Object.fromEntries(
  Object.entries(api).filter(([name]) => !SCOPE_EXCLUDED.has(name))
);
const SCOPE_NAMES = Object.keys(SCOPE);
const SCOPE_VALUES = Object.values(SCOPE);

interface ApiDoc {
  signature: string;
  doc: string;
}

// Hand-authored — the API is small and fixed, so this drives both autocomplete
// and hover docs without needing a full TypeScript language service.
const API_DOCS: Record<string, ApiDoc> = {
  note: {
    signature: 'note(input: string | number) => Pattern<ControlPatch>',
    doc: 'Pattern of pitched voices (default sound: sine). input is a note name ("c2", "f#3"), a raw Hz number, or a mini-notation string of them.'
  },
  sound: {
    signature: 'sound(input: SoundType) => Pattern<ControlPatch>  |  .sound(type)',
    doc: "Pattern of unpitched voices — the entry point for noise ('white' | 'pink' | 'brown'), also accepts mini-notation. Chainable as .sound(type) to set a voice's waveform or noise type."
  },
  n: {
    signature: 'n(input: string | number) => Pattern<ControlPatch>',
    doc: 'Scale-degree pattern — input is an integer or mini-notation string of them, resolved into real pitches by .scale("d5:minor").'
  },
  chord: {
    signature: 'chord(input: string) => Pattern<ControlPatch>',
    doc: 'Chord-symbol pattern (mini-notation string of symbols like "<Dm9 BbM7>"), expanded into simultaneous notes by .voicing().'
  },
  s: {
    signature: 's(input: SoundType | string) => Pattern<ControlPatch>  |  .s(name)',
    doc: "Synth voice or registered sample: any word in input that isn't a synth type becomes a sample name. Chainable as .s(name) to reassign the sound/sample on an existing pattern."
  },
  stack: {
    signature: 'stack(...pats: Pattern<T>[]) => Pattern<T>',
    doc: 'Plays all patterns simultaneously (polyphony: chords, layers).'
  },
  arrange: {
    signature: 'arrange(...sections: [cycles: number, pat: Pattern<T>][]) => Pattern<T>',
    doc: 'Plays each [cycles, pattern] section for its own span of whole cycles, looping the whole arrangement once the total is reached — the backbone of a multi-section song.'
  },
  seq: {
    signature: 'seq(...pats: Pattern<T>[]) => Pattern<T>',
    doc: 'Concatenates patterns within a single cycle, each taking an equal share.'
  },
  cat: {
    signature: 'cat(...pats: Pattern<T>[]) => Pattern<T>',
    doc: "Plays one pattern per cycle, in rotation (Tidal's slowcat)."
  },
  rev: {
    signature: 'rev(pat: Pattern<T>) => Pattern<T>  |  .rev()',
    doc: 'Reverses each cycle in time (cycle-local mirror). Exported standalone for point-free style (pat.jux(rev)) and as the chainable .rev().'
  },
  pure: {
    signature: 'pure(value: T) => Pattern<T>',
    doc: 'A pattern that repeats value once per cycle.'
  },
  silence: {
    signature: 'silence: Pattern<never>',
    doc: 'The empty pattern: querying it never returns events.'
  },
  hasOnset: {
    signature: 'hasOnset(hap: Hap<unknown>) => boolean',
    doc: "True when the hap's part contains the event's onset, i.e. it should actually trigger a voice."
  },
  timecat: {
    signature: 'timecat(pairs: [number, Pattern<T>][]) => Pattern<T>',
    doc: 'Concatenates patterns within a cycle with explicit relative weights — the building block behind seq().'
  },
  mini: {
    signature: 'mini(source: string, leaf: (token: string) => Pattern<T>) => Pattern<T>',
    doc: 'Lower-level mini-notation parser, exported for power users building custom leaf types.'
  },
  Pattern: {
    signature: 'class Pattern<T>',
    doc: 'The pattern core: a query from a cycle timespan to the events overlapping it. Immutable — every combinator returns a new Pattern.'
  },
  Fraction: {
    signature: 'class Fraction',
    doc: 'Exact rational cycle time, used throughout the engine so triplets and euclidean rhythms never drift.'
  },
  noteToFrequency: {
    signature: 'noteToFrequency(pitch: string | number) => number',
    doc: 'Converts a note name ("c3") or raw Hz number to a frequency in Hz.'
  },
  noteToMidi: {
    signature: 'noteToMidi(name: string) => number',
    doc: 'Converts a note name ("c4") to its MIDI note number.'
  },
  midiToFrequency: {
    signature: 'midiToFrequency(midi: number) => number',
    doc: 'Converts a MIDI note number to a frequency in Hz.'
  },
  registerSample: {
    signature: 'registerSample(name: string, source) => void',
    doc: 'Registers a sample under name. source is a URL, ArrayBuffer, AudioBuffer, or { url?, data?, buffer?, baseNote? } — baseNote is the pitch the recording sounds at, for pitched playback via note().s(name).'
  },
  registerSamples: {
    signature: 'registerSamples(map: Record<string, source>) => void',
    doc: 'Registers many samples at once — see registerSample() for the source shape each value takes.'
  },
  loadSamples: {
    signature: 'loadSamples(ctx: AudioContext, names?: string[]) => Promise<void>',
    doc: 'Preloads and decodes registered samples (all, or just names) against ctx. Not required before playback — an undecoded sample is just silently skipped for that one onset.'
  },
  clearSamples: {
    signature: 'clearSamples() => void',
    doc: 'Unregisters every sample — mostly useful for tests or hot-reload cleanup, not typical composing.'
  },
  getSampleBaseNote: {
    signature: 'getSampleBaseNote(name: string) => string | number | undefined',
    doc: 'The baseNote a registered sample was recorded at, used to compute pitched playback rate.'
  },
  getSampleBuffer: {
    signature: 'getSampleBuffer(name: string) => AudioBuffer | undefined',
    doc: 'The decoded AudioBuffer for a registered sample, once loadSamples() (or first playback) has resolved it.'
  },
  isSampleRegistered: {
    signature: 'isSampleRegistered(name: string, bank?: string) => boolean',
    doc: 'Whether a sample name (optionally with a .bank() prefix) is currently registered.'
  },
  CHANNEL_ORDER: {
    signature: 'CHANNEL_ORDER: string[]',
    doc: 'Speaker order used by channels()/surround(): FL, FR, C, LFE, SL, SR, RL, RR.'
  },
  MAX_CHANNELS: {
    signature: 'MAX_CHANNELS: number',
    doc: 'The maximum channel count channels() accepts (7.1 = 8).'
  },
  enableMultichannel: {
    signature: 'enableMultichannel(ctx: AudioContext) => void',
    doc: "Opts the context's destination into its full hardware channel count — call once so surround()/channels() address real speakers instead of folding to stereo."
  },
  foldToStereo: {
    signature: 'foldToStereo(gains: number[]) => [number, number]',
    doc: 'Folds a multichannel gain array down to a stereo [left, right] pair.'
  },
  surroundGains: {
    signature: 'surroundGains(angleDegrees: number) => number[]',
    doc: 'Computes per-speaker gains for an angle on the 7.1 speaker ring — what surround() uses internally.'
  },
  fast: {
    signature: '.fast(factor: number) => Pattern<T>',
    doc: 'Speeds the whole pattern up: fast(2) squeezes two cycles into every one.'
  },
  slow: {
    signature: '.slow(factor: number) => Pattern<T>',
    doc: 'Slows the whole pattern down: slow(2) stretches one cycle over two.'
  },
  every: {
    signature: '.every(n: number, fn: (pat) => pat) => Pattern<T>',
    doc: 'Applies fn to the pattern on every nth cycle (cycles 0, n, 2n, ...).'
  },
  euclid: {
    signature: '.euclid(pulses: number, steps: number, rotation?: number) => Pattern<T>',
    doc: 'Distributes the pattern over a euclidean rhythm: pulses onsets spread evenly across steps slots per cycle.'
  },
  jux: {
    signature: '.jux(fn: (pat) => pat) => Pattern<ControlPatch>',
    doc: 'Juxtaposes the pattern with a transformed copy: original plays hard left, fn(pattern) plays hard right.'
  },
  scale: {
    signature: '.scale(spec: string) => Pattern<ControlPatch>',
    doc: 'Resolves n()\'s scale-degree events into real pitches. spec is "<root><octave>:<name>", e.g. "d5:minor". Events already pitched by note() pass through unchanged.'
  },
  voicing: {
    signature: '.voicing(options?: { anchor? }) => Pattern<ControlPatch>',
    doc: "Expands chord()'s chord symbols into simultaneous notes — a deterministic approximation of voice-leading, anchored near middle C by default."
  },
  bank: {
    signature: '.bank(name: string) => Pattern<ControlPatch>',
    doc: 'A sample-lookup prefix: tries `${name}_${sampleName}` before falling back to the bare sample name.'
  },
  attack: {
    signature: '.attack(seconds: number) => Pattern<ControlPatch>',
    doc: 'Amplitude envelope attack time.'
  },
  decay: {
    signature: '.decay(seconds: number) => Pattern<ControlPatch>',
    doc: 'Amplitude envelope decay time.'
  },
  sustain: {
    signature: '.sustain(level: number) => Pattern<ControlPatch>',
    doc: "Fraction (0-1) of gain the decay stage settles to before release. In loop() (and play({gated: true})), the envelope holds at this level until the event's gate closes."
  },
  release: {
    signature: '.release(seconds: number) => Pattern<ControlPatch>',
    doc: 'Amplitude envelope release time.'
  },
  gain: {
    signature: '.gain(level: number) => Pattern<ControlPatch>',
    doc: 'Peak amplitude (0-1).'
  },
  lpf: {
    signature: '.lpf(hz: number) => Pattern<ControlPatch>',
    doc: 'Base lowpass filter cutoff in Hz. Omit entirely to skip filtering.'
  },
  lpenv: {
    signature: '.lpenv(hzAmount: number) => Pattern<ControlPatch>',
    doc: 'Hz the filter envelope adds on top of lpf() at its peak.'
  },
  lpa: {
    signature: '.lpa(seconds: number) => Pattern<ControlPatch>',
    doc: 'Filter envelope attack time.'
  },
  lpd: {
    signature: '.lpd(seconds: number) => Pattern<ControlPatch>',
    doc: 'Filter envelope decay time.'
  },
  lps: {
    signature: '.lps(level: number) => Pattern<ControlPatch>',
    doc: 'Fraction (0-1) between lpf() and its envelope peak the decay stage settles to.'
  },
  lpr: {
    signature: '.lpr(seconds: number) => Pattern<ControlPatch>',
    doc: 'Filter envelope release time.'
  },
  slide: {
    signature: '.slide(seconds: number) => Pattern<ControlPatch>',
    doc: 'Pitch glide (portamento): starts an octave above the target note and slides down over seconds.'
  },
  hpf: {
    signature: '.hpf(hz: number) => Pattern<ControlPatch>',
    doc: 'Static highpass filter, in series after .lpf(). Omit entirely to skip it.'
  },
  phaser: {
    signature: '.phaser(rateHz: number) => Pattern<ControlPatch>',
    doc: 'A 4-stage allpass phaser at rateHz. Omit entirely to skip it.'
  },
  room: {
    signature: '.room(level: number) => Pattern<ControlPatch>',
    doc: "Reverb send (0-1) to the voice's orbit bus. See roomsize()/orbit()."
  },
  roomsize: {
    signature: '.roomsize(size: number) => Pattern<ControlPatch>',
    doc: "The shared orbit bus's reverb decay character (roughly 1-10) — last-writer-wins across every voice on that orbit."
  },
  delay: {
    signature: '.delay(level: number) => Pattern<ControlPatch>',
    doc: "Delay send (0-1) to the voice's orbit bus. See delaytime()/delayfeedback()/orbit()."
  },
  delaytime: {
    signature: '.delaytime(seconds: number) => Pattern<ControlPatch>',
    doc: "The shared orbit bus's delay time — last-writer-wins across every voice on that orbit."
  },
  delayfeedback: {
    signature: '.delayfeedback(amount: number) => Pattern<ControlPatch>',
    doc: "The shared orbit bus's delay feedback amount."
  },
  orbit: {
    signature: '.orbit(n: number) => Pattern<ControlPatch>',
    doc: "Which shared reverb/delay bus the voice's room()/delay() sends target. Default 0, a non-negative integer, not patternable."
  },
  nudge: {
    signature: '.nudge(seconds: number) => Pattern<ControlPatch>',
    doc: 'Start-time offset in seconds applied to every event. .late()/.early() are signed aliases.'
  },
  late: {
    signature: '.late(seconds: number) => Pattern<ControlPatch>',
    doc: 'Signed alias of .nudge() — delays every event by seconds.'
  },
  early: {
    signature: '.early(seconds: number) => Pattern<ControlPatch>',
    doc: 'Signed alias of .nudge() — moves every event seconds earlier.'
  },
  pan: {
    signature: '.pan(position: number) => Pattern<ControlPatch>',
    doc: 'Stereo position, -1 (hard left) to 1 (hard right).'
  },
  channels: {
    signature: '.channels(gains: number[]) => Pattern<ControlPatch>',
    doc: 'Multichannel (up to 7.1) placement: per-speaker output gains in FL, FR, C, LFE, SL, SR, RL, RR order.'
  },
  surround: {
    signature: '.surround(angleDegrees: number) => Pattern<ControlPatch>',
    doc: 'Places the voice at an angle on the 7.1 speaker ring, equal-power panned between the two nearest speakers.'
  },
  play: {
    signature: '.play(options?: { ctx?, bpm?, when?, gated? }) => void',
    doc: 'Plays one cycle as a one-shot. Percussive by default; gated: true holds each event for its own share of the cycle, like loop().'
  },
  loop: {
    signature: '.loop(options?: { ctx?, bpm?, timer? }) => LoopHandle',
    doc: 'Loops the pattern until stop() is called on the returned handle. Each event is gated to its own share of the cycle.'
  }
};

const METHOD_NAMES = [
  'fast',
  'slow',
  'rev',
  'every',
  'euclid',
  'sound',
  's',
  'scale',
  'voicing',
  'bank',
  'attack',
  'decay',
  'sustain',
  'release',
  'gain',
  'lpf',
  'lpenv',
  'lpa',
  'lpd',
  'lps',
  'lpr',
  'slide',
  'hpf',
  'phaser',
  'room',
  'roomsize',
  'delay',
  'delaytime',
  'delayfeedback',
  'orbit',
  'nudge',
  'late',
  'early',
  'pan',
  'channels',
  'surround',
  'jux',
  'play',
  'loop'
];

function completionType(name: string): string {
  if (name === 'Pattern' || name === 'Fraction') return 'class';
  if (name === 'CHANNEL_ORDER' || name === 'MAX_CHANNELS' || name === 'silence') return 'constant';
  return SCOPE_NAMES.includes(name) ? 'function' : 'method';
}

function toCompletion(name: string): Completion {
  const info = API_DOCS[name];
  return {
    label: name,
    type: completionType(name),
    detail: info?.signature,
    info: info?.doc
  };
}

const TOPLEVEL_COMPLETIONS: Completion[] = SCOPE_NAMES.map(toCompletion);
const METHOD_COMPLETIONS: Completion[] = METHOD_NAMES.map(toCompletion);

/** Completes SCOPE names at the top level and chainable method names after a `.`. */
function apiCompletionSource(context: CompletionContext): CompletionResult | null {
  const afterDot = context.matchBefore(/\.\w*/);
  if (afterDot) {
    return { from: afterDot.from + 1, options: METHOD_COMPLETIONS, validFor: /^\w*$/ };
  }
  const word = context.matchBefore(/[A-Za-z_]\w*/);
  if (!word || (word.from === word.to && !context.explicit)) {
    return null;
  }
  return { from: word.from, options: TOPLEVEL_COMPLETIONS, validFor: /^[A-Za-z_]\w*$/ };
}

/** Hover tooltip for any identifier the docs table knows about, member or top-level. */
const apiHoverTooltip = hoverTooltip((view, pos): Tooltip | null => {
  const { from, to, text } = view.state.doc.lineAt(pos);
  let start = pos;
  let end = pos;
  while (start > from && /\w/.test(text[start - from - 1])) start--;
  while (end < to && /\w/.test(text[end - from])) end++;
  if (start === end) {
    return null;
  }
  const word = text.slice(start - from, end - from);
  const info = API_DOCS[word];
  if (!info) {
    return null;
  }
  return {
    pos: start,
    end,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-api-hover';
      const sig = document.createElement('div');
      sig.className = 'cm-api-hover-signature';
      sig.textContent = info.signature;
      const doc = document.createElement('div');
      doc.className = 'cm-api-hover-doc';
      doc.textContent = info.doc;
      dom.append(sig, doc);
      return { dom };
    }
  };
});

interface ComposerExample {
  label: string;
  code: string;
  /** Applied to the tempo slider when the example loads; omitted for one-shots, where tempo doesn't really apply. */
  bpm?: number;
}

interface ExampleGroup {
  label: string;
  examples: ComposerExample[];
}

// Every example is a bare pattern-returning expression, exactly like anything
// you'd type by hand — evaluatePattern() runs them through the identical path,
// so there's no separate "preset" representation that could drift from what's
// actually on screen. Ordered simple to advanced: one-shot SFX, then
// mini-notation patterns, then full multi-layer tracks.
const EXAMPLE_GROUPS: ExampleGroup[] = [
  {
    label: 'Game SFX',
    examples: [
      {
        label: 'Place Building',
        code: `// A low thunk, a high sparkle, and a noise click, landed together.
return stack(
  note('c2')
    .sound('triangle')
    .attack(0.001).decay(0.1).sustain(0).release(0.05)
    .gain(0.9)
    .lpf(220).lpenv(5).lpa(0.001).lpd(0.08).lps(0).lpr(0.05)
    .slide(0.07),
  note('c6')
    .sound('sine')
    .attack(0.001).decay(0.15).sustain(0).release(0.1)
    .gain(0.3)
    .lpf(2000).lpenv(8).lpa(0.001).lpd(0.06).lps(0).lpr(0.1)
    .nudge(0.02),
  sound('white').attack(0).decay(0.02).sustain(0).release(0.01).gain(0.4).lpf(4000).lpenv(0)
);`
      },
      {
        label: 'UI Blip',
        code: `// A short, higher-pitched confirmation blip — menu clicks, toggles.
return stack(
  note('a5').sound('sine').attack(0.001).decay(0.06).sustain(0).release(0.03).gain(0.5).lpf(3000),
  sound('white').attack(0).decay(0.008).sustain(0).release(0.005).gain(0.15).lpf(6000)
);`
      },
      {
        label: 'Error',
        code: `// A denied/error buzz — a descending square-wave slide through a tight filter.
return note('a2')
  .sound('square')
  .attack(0.001).decay(0.12).sustain(0).release(0.08)
  .gain(0.5)
  .lpf(600).lpenv(0)
  .slide(0.15);`
      },
      {
        label: 'Bulldoze',
        code: `// A crunchy demolition sound — brown noise crunch under a descending thunk.
return stack(
  note('a1')
    .sound('sawtooth')
    .attack(0.001).decay(0.14).sustain(0).release(0.08)
    .gain(0.7)
    .lpf(180).lpenv(3).lpa(0.001).lpd(0.1).lps(0).lpr(0.08)
    .slide(0.12),
  sound('brown').attack(0.001).decay(0.1).sustain(0.1).release(0.12).gain(0.5).lpf(900).lpenv(0)
);`
      },
      {
        label: 'Cash In',
        code: `// A bright ascending two-note chime — a sale completed, income received.
return stack(
  note('c5').sound('triangle').attack(0.002).decay(0.12).sustain(0).release(0.08).gain(0.5).lpf(4000),
  note('e5').sound('triangle').attack(0.002).decay(0.16).sustain(0).release(0.1).gain(0.5).lpf(4500).nudge(0.06)
);`
      },
      {
        label: 'Power On',
        code: `// A rising sweep — a plant just connected to the power grid.
return note('a3')
  .sound('sawtooth')
  .attack(0.02).decay(0.14).sustain(0.4).release(0.1)
  .gain(0.35)
  .lpf(300).lpenv(2200).lpa(0.16).lpd(0.05).lps(0.6).lpr(0.1);`
      },
      {
        label: 'Milestone',
        code: `// A short triumphant arpeggio — a population milestone, a new era.
return stack(
  note('c5').sound('triangle').attack(0.002).decay(0.1).sustain(0.2).release(0.08).gain(0.45).lpf(3500),
  note('e5').sound('triangle').attack(0.002).decay(0.1).sustain(0.2).release(0.08).gain(0.45).lpf(3500).nudge(0.09),
  note('g5').sound('triangle').attack(0.002).decay(0.1).sustain(0.2).release(0.08).gain(0.45).lpf(3500).nudge(0.18),
  note('c6').sound('sine').attack(0.002).decay(0.3).sustain(0).release(0.2).gain(0.4).lpf(5000).nudge(0.27)
);`
      },
      {
        label: 'Notification',
        code: `// A soft two-tone chime — a ticker item or advisor alert arrived.
return stack(
  note('e5').sound('sine').attack(0.005).decay(0.1).sustain(0.1).release(0.1).gain(0.35).lpf(3000),
  note('b4').sound('sine').attack(0.005).decay(0.12).sustain(0.1).release(0.12).gain(0.3).lpf(3000).nudge(0.1)
);`
      },
      {
        label: 'Undo',
        code: `// A quick reverse blip — undoing the last action.
return note('a4')
  .sound('square')
  .attack(0.001).decay(0.08).sustain(0).release(0.04)
  .gain(0.35)
  .lpf(2200)
  .slide(0.05);`
      }
    ]
  },
  {
    label: 'Patterns',
    examples: [
      {
        label: 'Arpeggio',
        bpm: 140,
        code: `// A held mini-notation phrase, transformed every 2nd cycle.
return note('c3 e3 g3 <b3 c4>')
  .sound('triangle')
  .attack(0.004).decay(0.12).sustain(0.35).release(0.08)
  .gain(0.6)
  .lpf(2500)
  .every(2, rev);`
      },
      {
        label: 'Chorale',
        bpm: 80,
        code: `// A four-chord progression, one chord per cycle.
return note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>')
  .sound('sine')
  .attack(0.004).decay(0.12).sustain(0.85).release(0.08)
  .gain(0.6)
  .lpf(1800);`
      },
      {
        label: 'Euclid groove',
        bpm: 130,
        code: `// Three layered euclidean rhythms, one string each.
return note('[c2(3,8), g2(5,8,2), c4(7,16,4)]')
  .sound('square')
  .attack(0.004).decay(0.12).sustain(0.12).release(0.08)
  .gain(0.6)
  .lpf(900);`
      },
      {
        label: 'Acid line',
        bpm: 150,
        code: `// A sawtooth bassline, juxtaposed against its own reverse.
return note('a1 [a1 a2] c2 <e2 g1>')
  .sound('sawtooth')
  .attack(0.004).decay(0.12).sustain(0.25).release(0.08)
  .gain(0.6)
  .lpf(700)
  .jux(rev);`
      },
      {
        label: 'Music box',
        bpm: 100,
        code: `// A doubled-up alternating melody with a rest, juxed hard left/right.
return note('<c5 e5 g5 b5 a5 g5>*2 ~')
  .sound('sine')
  .attack(0.004).decay(0.12).sustain(0.5).release(0.08)
  .gain(0.6)
  .lpf(4000)
  .jux(rev);`
      },
      {
        label: 'Polyrhythm',
        bpm: 110,
        code: `// A 3-against-2 layer, written as one parallel step.
return note('[c4 e4 g4, c2 f2]')
  .sound('triangle')
  .attack(0.004).decay(0.12).sustain(0.4).release(0.08)
  .gain(0.6)
  .lpf(2500);`
      },
      {
        label: 'Orbit (7.1)',
        bpm: 120,
        code: `// Two euclidean layers placed on the 7.1 surround ring.
return note('c4(5,8) e4(3,8,2)')
  .sound('triangle')
  .attack(0.004).decay(0.12).sustain(0.2).release(0.08)
  .gain(0.6)
  .lpf(2500)
  .surround(135);`
      }
    ]
  },
  {
    label: 'Full tracks',
    examples: [
      {
        label: 'Layered tune',
        code: `// Chords + a jux'd melody + a euclidean bassline, all stacked together.
return stack(
  note('<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>') // one chord per cycle
    .sound('sine')
    .sustain(0.8),
  note('c5 [e5 g5] <b5 a5> ~').sound('triangle').every(2, rev).jux(rev).gain(0.4),
  note('c2(3,8)').sound('square').lpf(400) // euclidean bassline
);`
      },
      {
        label: 'Generative',
        code: `// Build a pattern from a plain JS array instead of typing mini-notation.
const scale = [0, 2, 4, 7, 9]; // major pentatonic, semitone offsets from c4
const notes = scale.map((semitones) => noteToFrequency('c4') * 2 ** (semitones / 12));

return seq(...notes.map((hz) => note(hz).sound('triangle').sustain(0.3)))
  .fast(2)
  .sound('triangle')
  .gain(0.5)
  .lpf(3000);`
      },
      {
        label: 'Helper functions',
        code: `// It's real JS — define helpers, loop, branch, whatever you need.
const bass = (n) => note(n).sound('square').lpf(500).sustain(0.2).gain(0.6);
const pad = (n) => note(n).sound('sine').sustain(0.9).gain(0.3).lpf(1200);

return stack(
  seq(bass('c2'), bass('c2'), bass('f2'), bass('g2')),
  pad('<[c3,e3,g3] [f3,a3,c4]>')
);`
      },
      {
        label: 'Drums + melody',
        code: `// Euclidean noise hits under a cat()'d melody that alternates cycle to cycle.
return stack(
  sound('white(3,8)').attack(0).decay(0.03).release(0.01).gain(0.5).lpf(6000),
  sound('brown(5,8,2)').attack(0).decay(0.08).gain(0.35).lpf(300),
  cat(
    note('c4 e4 g4 c5').sound('triangle').sustain(0.2),
    note('c4 d4 f4 a4').sound('triangle').sustain(0.2)
  ).gain(0.5)
);`
      },
      {
        label: 'Neon drive (7.1)',
        bpm: 110,
        code: `// An 80s synthwave cruise built for a 7.1 rig: the arp orbits the whole
// speaker ring (surround() isn't patternable, so cat() rotates eight fixed
// copies, one angle per cycle), channels() spotlights exact speakers for the
// side riser and rear zap, and the drums + lead hold the front on pan().

// Front of house — drums on plain stereo.
const kick = note('c1*4').sound('sine')
  .attack(0.001).decay(0.12).sustain(0).release(0.05)
  .gain(0.9).lpf(150).slide(0.05);
const snare = sound('~ white ~ white')
  .attack(0.001).decay(0.1).sustain(0).release(0.08)
  .gain(0.5).hpf(900).lpf(6000);
const hats = sound('white*8')
  .attack(0).decay(0.02).sustain(0).release(0.01)
  .gain(0.25).hpf(7000)
  .pan('-0.6 0.6 -0.3 0.3'); // pan() is patternable — hats tick across the front

const bass = cat(note('a1*8'), note('f1*8'), note('c2*8'), note('g1*8')) // Am F C G roots
  .sound('sawtooth')
  .attack(0.002).decay(0.1).sustain(0.3).release(0.05)
  .gain(0.55).lpf(500);

const pad = note('<[a2,c3,e3] [f2,a2,c3] [c3,e3,g3] [g2,b2,d3]>')
  .sound('sawtooth')
  .attack(0.06).decay(0.2).sustain(0.85).release(0.3)
  .gain(0.25).lpf(1100).phaser(0.4);

// The lead: two saw layers ~10 cents apart (detuned in plain JS), gliding on slide().
const detuned = (line) => stack(
  note(line),
  note(line.split(' ').map((w) => (w === '~' ? w : (noteToFrequency(w) * 1.006).toFixed(1))).join(' '))
);
const lead = cat(detuned('a4 ~ c5 e5 ~ e5 d5 c5'), detuned('b4 ~ d5 ~ c5 ~ a4 ~'))
  .sound('sawtooth')
  .attack(0.01).decay(0.15).sustain(0.5).release(0.15)
  .gain(0.3).lpf(2400)
  .slide(0.09)
  .pan('<-0.3 0.3>')
  .delay(0.3).delaytime(0.41).delayfeedback(0.3); // ~a dotted eighth at 110 bpm

// The showpiece: the arp laps the whole 7.1 ring, one 45° step per cycle.
const arpNotes = note('a3 c4 e4 a4 c5 a4 e4 c4')
  .sound('triangle')
  .attack(0.002).decay(0.1).sustain(0.15).release(0.06)
  .gain(0.4).lpf(2800);
const orbitArp = cat(...[0, 45, 90, 135, 180, 225, 270, 315].map((a) => arpNotes.surround(a)));

// Hand-built channels() spotlights — gains in CHANNEL_ORDER: FL FR C LFE SL SR RL RR.
const sideRiser = sound('white').slow(2) // a 2-cycle swell in the sides (SL+SR) only
  .attack(3.2).decay(0.3).sustain(0.5).release(0.4)
  .gain(0.2).lpf(3500)
  .channels([0, 0, 0, 0, 1, 1, 0, 0]);
const rearZap = note('~ ~ ~ a5').sound('square') // answers beat 4 from dead behind (RL+RR)
  .attack(0.001).decay(0.08).sustain(0).release(0.1)
  .gain(0.3).slide(0.12)
  .channels([0, 0, 0, 0, 0, 0, 0.9, 0.9]);

// Intro -> build -> drop -> outro; each arrange() section restarts its own cycles at 0.
return arrange(
  [2, stack(pad, orbitArp.gain(0.2))],
  [4, stack(pad, bass, hats, orbitArp, sideRiser)],
  [8, stack(kick, snare, hats, bass, pad, lead, orbitArp, rearZap)],
  [2, stack(pad, arpNotes.gain(0.25).surround(180))] // the arp parks dead-behind to close
);`
      }
    ]
  },
  {
    label: 'Songs',
    examples: [
      {
        label: 'Velvet Basement',
        bpm: 86,
        code: `// "Velvet Basement" — cinematic trip-hop/downtempo, 80 bars.
// A full port of a real song sketch onto the real API: chord()/.voicing()
// for the harmonic bed, n()/.scale() for two melody motifs, s()/.bank()
// sample playback over a tiny procedurally-generated placeholder drum kit
// (undertone ships no bundled samples), and arrange() for the structure.

// A decaying noise burst stands in for a real drum sample — the
// AudioBuffer constructor form needs no AudioContext, so this can just
// run inline instead of waiting for a play/loop button.
function decayingNoiseBuffer(length, decay) {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: 44100 });
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-decay * (i / length));
    }
  }
  return buffer;
}

registerSamples({
  RolandTR707_bd: { buffer: decayingNoiseBuffer(4410, 4) },
  RolandTR707_sd: { buffer: decayingNoiseBuffer(3000, 6) },
  RolandTR707_hh: { buffer: decayingNoiseBuffer(800, 10) },
  RolandTR707_rim: { buffer: decayingNoiseBuffer(500, 12) },
  RolandTR909_oh: { buffer: decayingNoiseBuffer(2500, 5) }
});

// ATMOSPHERE — a barely-there filtered noise bed, just enough room tone.
const air = s('pink').lpf(1600).attack(0.4).release(1).gain(0.018);

// HARMONIC BED — chord() + .voicing().
const chords = chord('<Dm9 BbM7 Gm9 A7sus>')
  .voicing()
  .sound('triangle')
  .attack(0.35)
  .release(1.4)
  .lpf(1450)
  .gain(0.16)
  .room(0.55)
  .roomsize(6)
  .orbit(1);

const chordsOpen = chord('<Dm9 BbM7 Gm9 A7sus>')
  .voicing()
  .sound('sawtooth')
  .attack(0.3)
  .release(1.2)
  .lpf(2400)
  .gain(0.11)
  .room(0.65)
  .roomsize(6)
  .orbit(1);

// BASS — patterned gain across the four-note pattern.
const bass = note(
  \`<
    [d2 ~ d2 a1]
    [bb1 ~ f2 a1]
    [g1 ~ d2 f2]
    [a1 ~ e2 g2]
  >\`
)
  .sound('sawtooth')
  .release(0.3)
  .lpf(1050)
  .gain('.68 .5 .6 .55');

// MAIN BREAK — s()/.bank() sample playback.
const breakbeat = stack(
  s('bd ~ [~ bd] ~').bank('RolandTR707').gain(0.72),
  s('~ sd ~ sd').bank('RolandTR707').gain(0.58).room(0.08).orbit(2),
  s('hh [~ hh] hh [hh ~]').bank('RolandTR707').gain(0.19).late(0.008),
  s('~ ~ rim ~').bank('RolandTR707').gain(0.1).late(0.018)
);

const breakbeatOpen = stack(
  s('bd ~ [~ bd] [bd ~]').bank('RolandTR707').gain(0.75),
  s('~ sd ~ sd').bank('RolandTR707').gain(0.61).room(0.1).orbit(2),
  s('hh*8').bank('RolandTR707').gain(0.16).late(0.009),
  s('~ rim [~ rim] ~').bank('RolandTR707').gain(0.09).late(0.02),
  s('~ ~ ~ oh').bank('RolandTR909').gain(0.075)
);

// "FOUND MEMORY" MOTIF — n()/.scale().
const memory = n(
  \`<
    [0 ~ 4 2]
    [~ 3 ~ 1]
    [0 2 ~ 5]
    [~ 1 4 ~]
  >\`
)
  .scale('D5:minor')
  .sound('triangle')
  .decay(0.13)
  .sustain(0)
  .gain(0.15)
  .room(0.78)
  .roomsize(8)
  .delay(0.22)
  .delaytime(0.28)
  .delayfeedback(0.4)
  .orbit(3);

const memoryGhost = n(
  \`<
    [0 ~ ~ 2]
    [~ 3 ~ ~]
    [0 ~ ~ 5]
    [~ ~ 4 ~]
  >\`
)
  .scale('D6:minor')
  .sound('triangle')
  .decay(0.08)
  .sustain(0)
  .gain(0.055)
  .room(0.9)
  .roomsize(9)
  .orbit(3);

// MUTED GUITAR FRAGMENTS — hpf.
const guitar = note(
  \`<
    [d4 ~ ~ a3]
    [~ f4 ~ ~]
    [g3 ~ d4 ~]
    [~ e4 ~ a3]
  >\`
)
  .sound('square')
  .release(0.12)
  .hpf(300)
  .lpf(1900)
  .gain(0.16)
  .room(0.3)
  .delay(0.15)
  .orbit(4);

// COUNTERLINE — n()/.scale() again, plus a phaser for texture.
const counter = n(
  \`<
    [~ 4 ~ 3]
    [2 ~ ~ 4]
    [~ 1 2 ~]
    [3 ~ 1 ~]
  >\`
)
  .scale('D4:minor')
  .sound('sine')
  .attack(0.08)
  .release(0.6)
  .phaser(0.4)
  .gain(0.11)
  .room(0.55)
  .orbit(1);

// SECTIONS
const intro = stack(air, chords, memory);
const bodyA = stack(air, chords, bass, breakbeat, memory);
const lift = stack(air, chords, chordsOpen, bass, breakbeatOpen, memory, memoryGhost, guitar);
const bodyB = stack(air, chords, bass, breakbeat, memory, guitar, counter);
const breakdown = stack(air, chords, memoryGhost, guitar);
const returnFull = stack(
  air,
  chords,
  chordsOpen,
  bass,
  breakbeatOpen,
  memory,
  memoryGhost,
  guitar,
  counter
);
const outro = stack(air, chords, memory);

// ARRANGEMENT — 80 bars, matching the original sketch's structure exactly.
return arrange(
  [8, intro],
  [16, bodyA],
  [8, lift],
  [16, bodyB],
  [8, breakdown],
  [16, returnFull],
  [8, outro]
);`
      },
      {
        label: 'Velvet Procession',
        bpm: 72,
        code: `// "Velvet Procession II" — acoustic/orchestral/electronic trip-hop, 63 bars.
// A full port: dry plucked strings up front, a wobbling string bed and
// piano-synth pulse behind, resonant bass, restrained drums, and distant
// vocal texture — all synthesized (no bundled samples), arranged so the
// opening evolves every 1-2 bars instead of holding a static intro.

function decayingNoiseBuffer(length, decay) {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: 44100 });
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-decay * (i / length));
    }
  }
  return buffer;
}

registerSamples({
  RolandTR707_bd: { buffer: decayingNoiseBuffer(4410, 4) },
  RolandTR707_sd: { buffer: decayingNoiseBuffer(3000, 6) },
  RolandTR707_hh: { buffer: decayingNoiseBuffer(800, 10) },
  RolandTR707_rim: { buffer: decayingNoiseBuffer(500, 12) },
  RolandTR707_oh: { buffer: decayingNoiseBuffer(2500, 5) }
});

// AIR — almost subliminal room tone, not "noise texture".
const air = s('pink').hpf(3400).lpf(7800).gain(0.0045).room(0.48).roomsize(5).orbit(30);

// PLUCKED STRING FRONT — short attack, common tones carried between chords.
const pizz = note(
  \`<
    [a3 e4 a4 c5 e5 c5]
    [a3 e4 a4 c5 e5 a4]
    [g3 e4 g4 c5 e5 g4]
    [g3 d4 g4 a4 d5 a4]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.32)
  .hpf(180)
  .lpf(5000)
  .gain('.155 .12 .145 .12 .16 .115')
  .room(0.15)
  .orbit(1);

// PLUCK TONAL TAIL — the "taaah..." after the pluck's "TAK".
const pizzTail = note(
  \`<
    [a4 e5 c5 e5]
    [a4 e5 c5 e5]
    [g4 e5 c5 e5]
    [g4 d5 a4 d5]
  >\`
)
  .sound('triangle')
  .attack(0.008)
  .release(0.48)
  .hpf(400)
  .lpf(2800)
  .gain(0.032)
  .room(0.46)
  .roomsize(4.5)
  .orbit(31);

// PLUCK ROOM — a few plucks get a separate distant reflection.
const pizzRoom = note(
  \`<
    [~ ~ a5 ~ ~ c5]
    [~ ~ ~ ~ e5 ~]
    [~ e5 ~ ~ ~ g5]
    [~ ~ g5 ~ d5 ~]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.65)
  .hpf(650)
  .lpf(4300)
  .gain(0.027)
  .room(0.86)
  .roomsize(8)
  .delay(0.12)
  .pan('<-0.5 0.44 -0.24 0.34>')
  .orbit(32);

// LOW PLUCK
const pizzLow = note(
  \`<
    [a2 ~ e3 ~]
    [f2 ~ c3 ~]
    [c3 ~ g2 ~]
    [g2 ~ d3 ~]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.38)
  .lpf(2200)
  .gain(0.1)
  .room(0.17)
  .orbit(2);

// WOBBLING VIOLIN BED — a continuously breathing ensemble behind the plucks.
const violins = chord('<Amadd9 Fmaj7 C6 Gsus2>')
  .voicing()
  .sound('sawtooth')
  .attack(0.32)
  .release(1.15)
  .lpf(2600)
  .gain(0.052)
  .phaser(1.6)
  .room(0.54)
  .roomsize(6)
  .orbit(3);

// WOBBLING SHADOW — a slightly delayed second ensemble for motion.
const violinsShadow = chord('<Amadd9 Fmaj7 C6 Gsus2>')
  .voicing()
  .sound('sawtooth')
  .attack(0.42)
  .release(1.2)
  .hpf(420)
  .lpf(3400)
  .gain(0.02)
  .late(0.014)
  .phaser(0.9)
  .room(0.72)
  .roomsize(7.5)
  .pan('<-0.36 0.36>')
  .orbit(4);

// ACOUSTIC GUITAR — human/wooden rhythmic element between the plucks.
const guitar = note(
  \`<
    [a3 ~ e4 ~ c4 e4]
    [f3 ~ c4 ~ a3 c4]
    [c4 ~ g3 ~ e4 g4]
    [g3 ~ d4 ~ b3 d4]
  >\`
)
  .sound('square')
  .attack(0.002)
  .release(0.24)
  .hpf(100)
  .lpf(5400)
  .gain(0.19)
  .room(0.09)
  .orbit(5);

const guitarBody = note(
  \`<
    [a2 ~ ~ e3]
    [f2 ~ ~ c3]
    [c3 ~ ~ g2]
    [g2 ~ d3 ~]
  >\`
)
  .sound('square')
  .attack(0.004)
  .release(0.38)
  .lpf(2300)
  .gain(0.09)
  .room(0.16)
  .orbit(5);

// FAKE PICK NOISE — a tiny physical "tk/sk/chk" under selected notes.
const pickNoise = s(
  \`<
    [white ~ white ~ [white white] ~]
    [white ~ ~ white ~ white]
    [white ~ white ~ ~ white]
    [white ~ [white white] ~ white ~]
  >\`
)
  .attack(0.001)
  .decay(0.009)
  .sustain(0)
  .release(0.012)
  .hpf(4300)
  .lpf(8500)
  .gain('.010 .006 .012 .007')
  .pan('<-0.16 0.16 -0.08 0.08>')
  .orbit(33);

// GUITAR ROOM THROW
const guitarRoom = note(
  \`<
    ~
    [~ ~ ~ ~ c4 ~]
    ~
    [~ d4 ~ ~ ~ ~]
  >\`
)
  .sound('square')
  .attack(0.003)
  .release(0.62)
  .hpf(450)
  .lpf(3900)
  .gain(0.031)
  .room(0.89)
  .roomsize(8)
  .delay(0.15)
  .pan('<-0.46 0.46>')
  .orbit(34);

// PIANO-SYNTH PULSE — the layer pulling the song along.
const pianoPulse = note(
  \`<
    [a3 ~ e4 ~]
    [f3 ~ c4 ~]
    [c4 ~ g3 ~]
    [g3 ~ d4 ~]
  >\`
)
  .sound('sine')
  .attack(0.008)
  .release(0.62)
  .hpf(150)
  .lpf(3500)
  .gain(0.16)
  .phaser(0.7)
  .room(0.3)
  .roomsize(3.8)
  .orbit(6);

// PIANO UPPER SHIMMER — a faint upper component.
const pianoGlow = note(
  \`<
    [e5 ~ c5 ~]
    [e5 ~ c5 ~]
    [e5 ~ g4 ~]
    [d5 ~ a4 ~]
  >\`
)
  .sound('triangle')
  .attack(0.012)
  .release(0.58)
  .hpf(800)
  .lpf(3900)
  .gain(0.025)
  .room(0.68)
  .roomsize(6)
  .delay(0.09)
  .orbit(35);

// ACOUSTIC/UPRIGHT BASS — enters early, pulls the harmony forward.
const bass = note(
  \`<
    [a2 ~ e3 a2]
    [f2 ~ c3 a2]
    [c3 ~ g2 e3]
    [g2 d3 e3 g2]
  >\`
)
  .sound('sawtooth')
  .attack(0.009)
  .release(0.68)
  .lpf(1550)
  .gain('.44 .39 .42 .37')
  .room(0.12)
  .orbit(7);

const bassBody = note('<a1 f1 c2 g1>')
  .sound('sine')
  .attack(0.035)
  .release(1.35)
  .lpf(235)
  .gain(0.105)
  .room(0.23)
  .roomsize(4)
  .orbit(36);

// BASS ROOM HARMONICS — reverb the upper body only, not the sub-bass.
const bassRoom = note(
  \`<
    [a2 ~ ~ e3]
    [f2 ~ ~ c3]
    [c3 ~ ~ g2]
    [g2 ~ d3 ~]
  >\`
)
  .sound('sawtooth')
  .attack(0.01)
  .release(0.82)
  .hpf(170)
  .lpf(1150)
  .gain(0.05)
  .room(0.62)
  .roomsize(6)
  .orbit(37);

const bassTurn = note(
  \`<
    ~
    ~
    ~
    [~ d3 e3 g3]
  >\`
)
  .sound('sawtooth')
  .attack(0.008)
  .release(0.24)
  .lpf(1800)
  .gain(0.18)
  .room(0.14)
  .orbit(7);

// DRUMS — sparse, providing weight and transitions rather than a groove.
const kick = s(
  \`<
    [bd ~ ~ ~]
    [bd ~ ~ bd]
    [bd ~ ~ ~]
    [bd ~ [~ bd] ~]
  >\`
)
  .bank('RolandTR707')
  .gain(0.48)
  .orbit(8);

const snare = s(
  \`<
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ sd]
  >\`
)
  .bank('RolandTR707')
  .gain(0.34)
  .hpf(520)
  .room(0.045)
  .orbit(8);

const snareRoom = s(
  \`<
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ ~]
    [~ sd ~ sd]
  >\`
)
  .bank('RolandTR707')
  .gain(0.05)
  .hpf(850)
  .lpf(6100)
  .room(0.88)
  .roomsize(7.5)
  .orbit(38);

const drumGhost = s(
  \`<
    [~ ~ [sd ~] ~]
    [~ rim ~ ~]
    [~ ~ [sd ~] ~]
    [~ rim [~ sd] ~]
  >\`
)
  .bank('RolandTR707')
  .gain(0.065)
  .hpf(1150)
  .room(0.19)
  .orbit(9);

const hats = s(
  \`<
    ~
    ~
    ~
    [~ hh [hh hh] oh]
  >\`
)
  .bank('RolandTR707')
  .gain('.065 .08 .055 .06')
  .hpf(4800)
  .room(0.19)
  .orbit(10);

const drumTurn = s(
  \`<
    ~
    ~
    ~
    [~ rim [sd rim] [sd sd]]
  >\`
)
  .bank('RolandTR707')
  .gain(0.092)
  .hpf(1050)
  .room(0.25)
  .roomsize(3)
  .orbit(11);

const drums = stack(kick, snare, snareRoom, drumGhost, hats, drumTurn);

const drumsOpen = stack(
  kick,
  snare,
  snareRoom,
  drumGhost,
  hats,
  drumTurn,
  s(
    \`<
      ~
      [~ ~ rim ~]
      ~
      [~ rim ~ rim]
    >\`
  )
    .bank('RolandTR707')
    .gain(0.047)
    .hpf(1900)
    .pan('<-0.44 0.44>')
);

// HIGH PIZZICATO DETAIL — introduced later, makes the orchestration feel larger.
const pizzHigh = note(
  \`<
    [~ e5 ~ c5]
    [~ e5 ~ a4]
    [g5 ~ e5 ~]
    [~ d5 ~ a4]
  >\`
)
  .sound('triangle')
  .attack(0.002)
  .release(0.26)
  .hpf(650)
  .lpf(5800)
  .gain(0.06)
  .room(0.35)
  .pan('<0.4 -0.4 0.26 -0.26>')
  .orbit(12);

// STRING PHRASE LIFT — a brief rise at the transition.
const stringLift = note(
  \`<
    ~
    ~
    ~
    [a4 c5 e5 a5]
  >\`
)
  .sound('sawtooth')
  .attack(0.1)
  .release(0.72)
  .hpf(380)
  .lpf(4100)
  .gain(0.064)
  .room(0.69)
  .roomsize(7)
  .orbit(13);

// DISTANT "LA LA" SUBSTITUTE — human voice as soundscape, not constant.
const ghostVox = note(
  \`<
    ~
    [~ e5 ~ a4]
    ~
    [~ d5 e5 ~]
  >\`
)
  .sound('sine')
  .attack(0.22)
  .release(1.05)
  .hpf(520)
  .lpf(3100)
  .gain(0.029)
  .room(0.93)
  .roomsize(9)
  .delay(0.17)
  .pan('<0.4 -0.4 0.24 -0.24>')
  .orbit(14);

const ghostVoxFar = note(
  \`<
    ~
    ~
    [~ ~ c6 ~]
    ~
  >\`
)
  .sound('sine')
  .attack(0.35)
  .release(1.4)
  .hpf(900)
  .lpf(2900)
  .gain(0.01)
  .late(0.017)
  .room(0.97)
  .roomsize(10)
  .delay(0.29)
  .orbit(15);

// LITTLE ELECTRONIC DETAIL — one small synthetic object wandering the room.
const glassTick = note(
  \`<
    ~
    [~ ~ ~ e6]
    ~
    [~ b5 ~ ~]
  >\`
)
  .sound('triangle')
  .decay(0.038)
  .sustain(0)
  .hpf(1700)
  .lpf(5100)
  .gain(0.022)
  .delay(0.19)
  .room(0.46)
  .pan('<-0.48 0.5>')
  .orbit(16);

// SECTIONS — the opening deliberately evolves every 1-2 bars.
const seed = stack(air, pizz, pizzTail, guitar, pickNoise);

const bloom = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins
);

const pulse = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow
);

// Low end arrives; drums begin quietly.
const foundation = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  drums,
  glassTick
);

const verseA = stack(
  air,
  pizz,
  pizzTail,
  pizzLow,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  pianoPulse,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drums,
  glassTick
);

const liftA = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  glassTick
);

// Pull density back for verse B, but retain memories of the lift.
const verseB = stack(
  air,
  pizz,
  pizzTail,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  pianoPulse,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drums,
  ghostVoxFar,
  glassTick
);

const liftB = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  ghostVoxFar,
  glassTick
);

// Drums vanish but piano/pluck/guitar stay in motion — don't stop the song.
const suspended = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  guitar,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bassBody,
  bassRoom,
  ghostVox,
  ghostVoxFar
);

// Bass attack + drums reappear.
const returnSection = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  glassTick
);

// Biggest soundscape: front (guitar/pluck/drums), middle (piano/bass/tails),
// back (violin wobble/reverb/voices).
const finalLift = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  pizzLow,
  pizzHigh,
  guitar,
  guitarBody,
  pickNoise,
  guitarRoom,
  violins,
  violinsShadow,
  pianoPulse,
  pianoGlow,
  bass,
  bassBody,
  bassRoom,
  bassTurn,
  drumsOpen,
  stringLift,
  ghostVox,
  ghostVoxFar,
  glassTick
);

// Pull the obvious beat away; leave the room ringing.
const outro = stack(
  air,
  pizz,
  pizzTail,
  pizzRoom,
  guitar,
  pickNoise,
  guitarRoom,
  violinsShadow,
  pianoGlow,
  bassBody,
  bassRoom,
  ghostVoxFar
);

// ARRANGEMENT — 63 bars total.
return arrange(
  [1, seed],
  [1, bloom],
  [2, pulse],
  [4, foundation],
  [8, verseA],
  [8, liftA],
  [8, verseB],
  [8, liftB],
  [4, suspended],
  [8, returnSection],
  [8, finalLift],
  [3, outro]
);`
      }
    ]
  }
];

const DEFAULT_EXAMPLE = EXAMPLE_GROUPS[2].examples[0];

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

interface HistoryEntry {
  id: number;
  name: string;
  code: string;
  savedAt: number;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch (err) {
    // Drop the oldest entry and retry once on quota pressure; otherwise fail
    // silently, same posture as rebuild()'s persist().
    if (err instanceof DOMException && err.name === 'QuotaExceededError' && entries.length > 1) {
      saveHistory(entries.slice(0, -1));
    }
  }
}

/** Records an explicit snapshot — never called from the keystroke debounce, only Save/Open. */
function pushHistoryEntry(name: string, code: string): void {
  if (code.length > HISTORY_ENTRY_MAX_CHARS) {
    return;
  }
  const entries = loadHistory();
  if (entries[0]?.code === code) {
    return;
  }
  const savedAt = Date.now();
  // Guards against two same-millisecond pushes (Open pushes current-then-imported
  // back to back) colliding on id.
  const id = entries[0] && entries[0].id >= savedAt ? entries[0].id + 1 : savedAt;
  entries.unshift({ id, name, code, savedAt });
  saveHistory(entries.slice(0, HISTORY_LIMIT));
}

function deleteHistoryEntry(id: number): void {
  saveHistory(loadHistory().filter((entry) => entry.id !== id));
}

function clearHistory(): void {
  try {
    window.localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Compiles source into a callable. Tries it as a bare expression first (so pasting
 * `stack(...)` just works), then falls back to statement mode for scripts that need
 * `const`/helpers/a trailing `return`.
 */
function compileScript(source: string): (...args: unknown[]) => unknown {
  try {
    return new Function(...SCOPE_NAMES, `"use strict";\nreturn (\n${source}\n);`) as (
      ...args: unknown[]
    ) => unknown;
  } catch {
    return new Function(...SCOPE_NAMES, `"use strict";\n${source}`) as (
      ...args: unknown[]
    ) => unknown;
  }
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined — did you forget a `return`?';
  if (value === null) return 'null';
  if (typeof value === 'object') return value.constructor?.name ?? 'an object';
  return typeof value;
}

function evaluatePattern(source: string): Pattern<ControlPatch> {
  const run = compileScript(source);

  // Playback is owned by the Composer's own buttons — a script calling .play()/.loop()
  // itself would fire on every debounced keystroke and leak an unstoppable loop handle.
  const originalPlay = Pattern.prototype.play;
  const originalLoop = Pattern.prototype.loop;
  const blocked = (): never => {
    throw new Error(
      "Return the pattern instead of calling .play()/.loop() — the Composer's buttons control playback."
    );
  };
  Pattern.prototype.play = blocked as typeof Pattern.prototype.play;
  Pattern.prototype.loop = blocked as typeof Pattern.prototype.loop;

  let result: unknown;
  try {
    result = run(...SCOPE_VALUES);
  } finally {
    Pattern.prototype.play = originalPlay;
    Pattern.prototype.loop = originalLoop;
  }

  if (!(result instanceof Pattern)) {
    throw new Error(`Script must return a Pattern (got ${describeValue(result)}).`);
  }

  // Combinator callbacks (e.g. every(n, fn)) run lazily at query time, so a broken one
  // needs a probe query here rather than surfacing later inside the scheduler tick.
  result.query({ begin: new Fraction(0), end: new Fraction(1) });

  return result;
}

export function initComposer(): void {
  const editorMount = document.querySelector<HTMLDivElement>('#composer-editor');
  const examplesPanel = document.querySelector<HTMLDivElement>('#composer-examples');
  const controlsBox = document.querySelector<HTMLDivElement>('#composer-controls');
  const errorBox = document.querySelector<HTMLDivElement>('#composer-error');
  const sampleWarningBox = document.querySelector<HTMLDivElement>('#composer-sample-warning');
  const canvas = document.querySelector<HTMLCanvasElement>('#composer-viz');
  const playButton = document.querySelector<HTMLButtonElement>('#composer-play');
  const loopButton = document.querySelector<HTMLButtonElement>('#composer-loop');
  const openButton = document.querySelector<HTMLButtonElement>('#composer-open');
  const saveButton = document.querySelector<HTMLButtonElement>('#composer-save');
  const historyButton = document.querySelector<HTMLButtonElement>('#composer-history');
  const shareButton = document.querySelector<HTMLButtonElement>('#composer-share');
  const fileInput = document.querySelector<HTMLInputElement>('#composer-file-input');
  const historyPanel = document.querySelector<HTMLDivElement>('#composer-history-panel');

  if (
    !editorMount ||
    !examplesPanel ||
    !controlsBox ||
    !errorBox ||
    !sampleWarningBox ||
    !canvas ||
    !playButton ||
    !loopButton ||
    !openButton ||
    !saveButton ||
    !historyButton ||
    !shareButton ||
    !fileInput ||
    !historyPanel
  ) {
    return;
  }

  let bpm = 120;
  let currentPattern: Pattern<ControlPatch> | undefined;
  let loopHandle: LoopHandle | undefined;
  let rebuildTimer: number | undefined;

  let audioContext: AudioContext | undefined;
  function getAudioContext(): AudioContext {
    if (!audioContext) {
      audioContext = new AudioContext();
      enableMultichannel(audioContext);
    }
    return audioContext;
  }

  function setLoopButton(): void {
    loopButton!.textContent = loopHandle ? '■ Stop' : '⟳ Loop';
  }

  function persist(source: string): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, source);
    } catch {
      // Storage can be unavailable (private browsing, quota) — not worth surfacing.
    }
  }

  function rebuild(restartLoop: boolean): void {
    const source = view.state.doc.toString();
    persist(source);
    try {
      currentPattern = evaluatePattern(source);
      errorBox!.hidden = true;
      drawPattern(canvas!, currentPattern);
      if (restartLoop && loopHandle) {
        loopHandle.stop();
        loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm });
      }
    } catch (err) {
      // Invalidate so Play/Loop can't fire a stale pattern; a running loop keeps
      // playing its last-good pattern rather than stopping on a typo.
      currentPattern = undefined;
      errorBox!.hidden = false;
      errorBox!.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function scheduleRebuild(): void {
    if (rebuildTimer !== undefined) {
      window.clearTimeout(rebuildTimer);
    }
    rebuildTimer = window.setTimeout(() => rebuild(true), 300);
  }

  function setBpm(newBpm: number): void {
    bpm = newBpm;
    bpmRange.value = String(bpm);
    bpmValue.textContent = String(bpm);
    if (loopHandle && currentPattern) {
      loopHandle.stop();
      loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm });
    }
  }

  function showSampleWarning(missing: UnregisteredSample[]): void {
    sampleWarningBox!.innerHTML = '';
    if (missing.length === 0) {
      sampleWarningBox!.hidden = true;
      return;
    }
    const names = missing.map((m) => (m.bank ? `${m.bank}_${m.name}` : m.name)).join(', ');
    const text = document.createElement('span');
    text.textContent = `Unregistered sample${missing.length > 1 ? 's' : ''}: ${names} — ${
      missing.length > 1 ? 'these voices' : 'this voice'
    } will play silent until you registerSample() ${missing.length > 1 ? 'them' : 'it'}.`;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'lab-warning-dismiss';
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => {
      sampleWarningBox!.hidden = true;
    });
    sampleWarningBox!.append(text, dismiss);
    sampleWarningBox!.hidden = false;
  }

  function loadScript(example: ComposerExample, autoLoop: boolean): void {
    showSampleWarning([]);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: example.code } });
    // dispatch() above triggers the updateListener below, which schedules its
    // own debounced rebuild via scheduleRebuild() — clear it or it fires
    // ~300ms later and restarts the loop we're about to start ourselves,
    // sounding like every example (worst on short one-shots) plays twice.
    if (rebuildTimer !== undefined) {
      window.clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }
    loopHandle?.stop();
    loopHandle = undefined;
    if (example.bpm !== undefined) {
      setBpm(example.bpm);
    }
    rebuild(false);
    if (autoLoop && currentPattern) {
      loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm });
    }
    setLoopButton();
  }

  function initialScript(): string {
    if (location.hash.startsWith(SHARE_PREFIX)) {
      try {
        return base64UrlDecode(location.hash.slice(SHARE_PREFIX.length));
      } catch {
        // Malformed hash — fall through to localStorage / default.
      }
    }
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) return saved;
    } catch {
      // Storage unavailable — fall through to default.
    }
    return DEFAULT_EXAMPLE.code;
  }

  const initialDoc = initialScript();
  const view = new EditorView({
    doc: initialDoc,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      javascript(),
      javascriptLanguage.data.of({ autocomplete: apiCompletionSource }),
      apiHoverTooltip,
      oneDark,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleRebuild();
      })
    ],
    parent: editorMount
  });

  const bpmRow = document.createElement('label');
  bpmRow.className = 'playground-row';
  const bpmLabel = document.createElement('span');
  bpmLabel.className = 'playground-label';
  bpmLabel.textContent = 'Tempo (bpm)';
  const bpmRange = document.createElement('input');
  bpmRange.type = 'range';
  bpmRange.min = '40';
  bpmRange.max = '240';
  bpmRange.step = '1';
  bpmRange.value = String(bpm);
  const bpmValue = document.createElement('span');
  bpmValue.className = 'playground-value';
  bpmValue.textContent = String(bpm);
  bpmRange.addEventListener('input', () => {
    // Live-updates the readout while dragging; the loop only restarts once
    // the drag lands (the 'change' listener below), not on every pixel.
    bpm = Number(bpmRange.value);
    bpmValue.textContent = bpmRange.value;
  });
  bpmRange.addEventListener('change', () => setBpm(Number(bpmRange.value)));
  bpmRow.append(bpmLabel, bpmRange, bpmValue);
  controlsBox.appendChild(bpmRow);

  let activeButton: HTMLButtonElement | undefined;
  for (const group of EXAMPLE_GROUPS) {
    const heading = document.createElement('h3');
    heading.textContent = group.label;
    examplesPanel.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'example-group';
    for (const example of group.examples) {
      const button = document.createElement('button');
      button.textContent = example.label;
      button.addEventListener('click', () => {
        activeButton?.classList.remove('is-active');
        button.classList.add('is-active');
        activeButton = button;
        loadScript(example, true);
      });
      if (example.code === initialDoc) {
        button.classList.add('is-active');
        activeButton = button;
      }
      list.appendChild(button);
    }
    examplesPanel.appendChild(list);
  }

  playButton.addEventListener('click', () => {
    rebuild(false);
    // Gated so "Once" previews exactly what one Loop cycle sounds like,
    // rather than the percussive SFX-style envelope play() defaults to.
    currentPattern?.play({ ctx: getAudioContext(), bpm, gated: true });
  });

  loopButton.addEventListener('click', () => {
    if (loopHandle) {
      loopHandle.stop();
      loopHandle = undefined;
    } else {
      rebuild(false);
      if (currentPattern) {
        loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm });
      }
    }
    setLoopButton();
  });

  shareButton.addEventListener('click', () => {
    const encoded = base64UrlEncode(view.state.doc.toString());
    const url = `${location.origin}${location.pathname}${SHARE_PREFIX}${encoded}`;
    history.replaceState(null, '', `${SHARE_PREFIX}${encoded}`);
    navigator.clipboard.writeText(url).then(
      () => {
        const original = shareButton.textContent;
        shareButton.textContent = 'Copied!';
        window.setTimeout(() => {
          shareButton.textContent = original;
        }, 1500);
      },
      () => {
        shareButton.textContent = 'Copy failed';
      }
    );
  });

  function setActiveExampleButton(button: HTMLButtonElement | undefined): void {
    activeButton?.classList.remove('is-active');
    activeButton = button;
    button?.classList.add('is-active');
  }

  openButton.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // allow re-selecting the same file later
    if (!file) {
      return;
    }
    void file.text().then((source) => {
      pushHistoryEntry(scriptName(view.state.doc.toString()), view.state.doc.toString());
      const prepared = prepareImportedScript(source);
      setActiveExampleButton(undefined);
      // Opening a file loads it for editing, not playback — clicking an example
      // is a "play it" intent, opening a file is an "edit it" intent.
      loadScript(
        { label: prepared.name ?? 'Imported', code: prepared.code, bpm: prepared.bpm },
        false
      );
      pushHistoryEntry(prepared.name ?? scriptName(prepared.code), prepared.code);
      showSampleWarning(currentPattern ? findUnregisteredSamples(currentPattern) : []);
    });
  });

  saveButton.addEventListener('click', () => {
    const code = view.state.doc.toString();
    const name = scriptName(code);
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slugify(name)}.js`;
    // Some browsers (notably Firefox) only honour the download attribute — and
    // its filename — for an anchor that's actually in the document; otherwise
    // they fall back to naming the file after the blob URL's own UUID.
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    pushHistoryEntry(name, code);
  });

  function renderHistoryPanel(): void {
    historyPanel!.innerHTML = '';
    const entries = loadHistory();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No saved versions yet — Open or Save adds one.';
      historyPanel!.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'history-list';
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'history-entry';

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'history-entry-restore';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'history-entry-name';
      nameSpan.textContent = entry.name;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'history-entry-time';
      timeSpan.textContent = relativeTime(entry.savedAt);
      restore.append(nameSpan, timeSpan);
      restore.addEventListener('click', () => {
        setActiveExampleButton(undefined);
        loadScript({ label: entry.name, code: entry.code }, false);
        historyPanel!.hidden = true;
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'history-entry-delete';
      del.textContent = '✕';
      del.title = 'Delete this version';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteHistoryEntry(entry.id);
        renderHistoryPanel();
      });

      row.append(restore, del);
      list.appendChild(row);
    }
    historyPanel!.appendChild(list);

    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'history-clear';
    clearAll.textContent = 'Clear all';
    clearAll.addEventListener('click', (event) => {
      // Without this, the click bubbles to the document-level "close on
      // outside click" listener after renderHistoryPanel() has already
      // detached this button — its target no longer reads as "inside the
      // panel", so the panel would immediately close again.
      event.stopPropagation();
      clearHistory();
      renderHistoryPanel();
    });
    historyPanel!.appendChild(clearAll);
  }

  historyButton.addEventListener('click', () => {
    const opening = historyPanel.hidden;
    if (opening) {
      renderHistoryPanel();
    }
    historyPanel.hidden = !opening;
  });

  document.addEventListener('click', (event) => {
    if (historyPanel.hidden) {
      return;
    }
    const target = event.target as Node;
    if (
      target !== historyButton &&
      !historyButton.contains(target) &&
      !historyPanel.contains(target)
    ) {
      historyPanel.hidden = true;
    }
  });

  rebuild(false);
}
