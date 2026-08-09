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
import { EXAMPLE_GROUPS } from './examples/index';
import type { ComposerExample } from './exampleTypes';
import { drawPattern } from './pianoRoll';

const STORAGE_KEY = 'undertone-composer-script';
const SHARE_PREFIX = '#composer=';
const HISTORY_KEY = 'undertone-composer-history';
const HISTORY_LIMIT = 30;
const HISTORY_ENTRY_MAX_CHARS = 100_000;

// Torn down at the start of the *next* initComposer() call — see the
// bottom of that function for why this needs to survive across calls.
let teardownPreviousComposer: (() => void) | undefined;

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

  // If initComposer() runs again against this same DOM without a full page
  // reload (a hot-reloaded module during development, or a future
  // non-SPA remount), stop the previous invocation's loop/timer/listeners/
  // AudioContext first — otherwise they keep running invisibly alongside
  // this new, independent set, which looks like "the loop can't be
  // stopped" since the visible Stop button only ever reaches the newest
  // invocation's handle.
  teardownPreviousComposer?.();

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

  // A single wrapper around everything this call appends to examplesPanel
  // (which also holds the template's static "Examples" <h2>) — lets
  // teardown() below remove exactly what this invocation added, without
  // touching that heading, if the component ever initializes twice.
  const examplesListContainer = document.createElement('div');

  let activeButton: HTMLButtonElement | undefined;
  for (const group of EXAMPLE_GROUPS) {
    const heading = document.createElement('h3');
    heading.textContent = group.label;
    examplesListContainer.appendChild(heading);

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
    examplesListContainer.appendChild(list);
  }
  examplesPanel.appendChild(examplesListContainer);

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

  function closeHistoryOnOutsideClick(event: MouseEvent): void {
    if (historyPanel!.hidden) {
      return;
    }
    const target = event.target as Node;
    if (
      target !== historyButton &&
      !historyButton!.contains(target) &&
      !historyPanel!.contains(target)
    ) {
      historyPanel!.hidden = true;
    }
  }
  document.addEventListener('click', closeHistoryOnOutsideClick);

  // Registers this instance's own cleanup so the *next* initComposer() call
  // (see the top of this function) can tear it down first.
  teardownPreviousComposer = () => {
    loopHandle?.stop();
    if (rebuildTimer !== undefined) {
      window.clearTimeout(rebuildTimer);
    }
    document.removeEventListener('click', closeHistoryOnOutsideClick);
    view.destroy();
    examplesListContainer.remove();
    controlsBox.innerHTML = '';
    void audioContext?.close().catch(() => {});
  };

  rebuild(false);
}
