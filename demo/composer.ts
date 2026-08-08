// The composer: a live JS code editor against the real undertone API — write any pattern
// expression (stack, seq, cat, euclid, custom JS logic) and hear it, live, as you type.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
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
