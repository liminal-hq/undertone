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
import {
  CHANNEL_ORDER,
  Fraction,
  MAX_CHANNELS,
  Pattern,
  cat,
  enableMultichannel,
  foldToStereo,
  hasOnset,
  mini,
  note,
  noteToFrequency,
  pure,
  rev,
  seq,
  silence,
  sound,
  stack,
  surroundGains,
  timecat
} from '../src/index';
import type { ControlPatch, LoopHandle } from '../src/index';
import { drawPattern } from './pianoRoll';

const STORAGE_KEY = 'undertone-composer-script';
const SHARE_PREFIX = '#composer=';

// Every value export from src/index.ts — the full API surface a script can reach.
const SCOPE: Record<string, unknown> = {
  note,
  sound,
  mini,
  Pattern,
  cat,
  hasOnset,
  pure,
  rev,
  seq,
  silence,
  stack,
  timecat,
  Fraction,
  noteToFrequency,
  CHANNEL_ORDER,
  MAX_CHANNELS,
  enableMultichannel,
  foldToStereo,
  surroundGains
};
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
  stack: {
    signature: 'stack(...pats: Pattern<T>[]) => Pattern<T>',
    doc: 'Plays all patterns simultaneously (polyphony: chords, layers).'
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
  nudge: {
    signature: '.nudge(seconds: number) => Pattern<ControlPatch>',
    doc: 'Start-time offset in seconds applied to every event.'
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
  'nudge',
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
}

const EXAMPLES: ComposerExample[] = [
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
  }
];

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
  const examplesRow = document.querySelector<HTMLDivElement>('#composer-examples');
  const controlsBox = document.querySelector<HTMLDivElement>('#composer-controls');
  const errorBox = document.querySelector<HTMLDivElement>('#composer-error');
  const canvas = document.querySelector<HTMLCanvasElement>('#composer-viz');
  const playButton = document.querySelector<HTMLButtonElement>('#composer-play');
  const loopButton = document.querySelector<HTMLButtonElement>('#composer-loop');
  const shareButton = document.querySelector<HTMLButtonElement>('#composer-share');

  if (
    !editorMount ||
    !examplesRow ||
    !controlsBox ||
    !errorBox ||
    !canvas ||
    !playButton ||
    !loopButton ||
    !shareButton
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

  function loadScript(source: string, autoLoop: boolean): void {
    if (rebuildTimer !== undefined) {
      window.clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
    loopHandle?.stop();
    loopHandle = undefined;
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
    return EXAMPLES[0].code;
  }

  const view = new EditorView({
    doc: initialScript(),
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
    bpm = Number(bpmRange.value);
    bpmValue.textContent = bpmRange.value;
  });
  bpmRange.addEventListener('change', () => {
    if (loopHandle && currentPattern) {
      loopHandle.stop();
      loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm });
    }
  });
  bpmRow.append(bpmLabel, bpmRange, bpmValue);
  controlsBox.appendChild(bpmRow);

  for (const example of EXAMPLES) {
    const button = document.createElement('button');
    button.textContent = `♪ ${example.label}`;
    button.addEventListener('click', () => loadScript(example.code, true));
    examplesRow.appendChild(button);
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

  rebuild(false);
}
