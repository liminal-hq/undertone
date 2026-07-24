// The pattern lab: live mini-notation editing, transforms, a piano-roll view, and looping
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction, enableMultichannel, hasOnset, note, noteToFrequency, rev } from '../src/index';
import type { ControlPatch, LoopHandle, Pattern, SoundType } from '../src/index';

interface LabState {
  notation: string;
  soundType: SoundType;
  bpm: number;
  gain: number;
  cutoff: number;
  sustain: number;
  fast2: boolean;
  reverse: boolean;
  every2: boolean;
  juxRev: boolean;
  surroundOn: boolean;
  surroundAngle: number;
}

const DEFAULT_STATE: LabState = {
  notation: 'c3 e3 g3 <b3 c4>',
  soundType: 'triangle',
  bpm: 140,
  gain: 0.6,
  cutoff: 2500,
  sustain: 0.35,
  fast2: false,
  reverse: false,
  every2: false,
  juxRev: false,
  surroundOn: false,
  surroundAngle: 0
};

interface LabExample {
  label: string;
  state: Partial<LabState>;
}

const EXAMPLES: LabExample[] = [
  {
    label: 'Arpeggio',
    state: { notation: 'c3 e3 g3 <b3 c4>', soundType: 'triangle', bpm: 140, every2: true }
  },
  {
    label: 'Chorale',
    state: {
      notation: '<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>',
      soundType: 'sine',
      bpm: 80,
      sustain: 0.85,
      cutoff: 1800
    }
  },
  {
    label: 'Euclid groove',
    state: {
      notation: '[c2(3,8), g2(5,8,2), c4(7,16,4)]',
      soundType: 'square',
      bpm: 130,
      sustain: 0.12,
      cutoff: 900
    }
  },
  {
    label: 'Acid line',
    state: {
      notation: 'a1 [a1 a2] c2 <e2 g1>',
      soundType: 'sawtooth',
      bpm: 150,
      sustain: 0.25,
      cutoff: 700,
      juxRev: true
    }
  },
  {
    label: 'Music box',
    state: {
      notation: '<c5 e5 g5 b5 a5 g5>*2 ~',
      soundType: 'sine',
      bpm: 100,
      sustain: 0.5,
      cutoff: 4000,
      juxRev: true
    }
  },
  {
    label: 'Polyrhythm',
    state: { notation: '[c4 e4 g4, c2 f2]', soundType: 'triangle', bpm: 110, sustain: 0.4 }
  },
  {
    label: 'Orbit (7.1)',
    state: {
      notation: 'c4(5,8) e4(3,8,2)',
      soundType: 'triangle',
      bpm: 120,
      sustain: 0.2,
      surroundOn: true,
      surroundAngle: 135
    }
  }
];

const SLIDERS: {
  key: 'bpm' | 'gain' | 'cutoff' | 'sustain' | 'surroundAngle';
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: 'bpm', label: 'Tempo (bpm)', min: 40, max: 240, step: 1 },
  { key: 'gain', label: 'Gain (0-1)', min: 0, max: 1, step: 0.01 },
  { key: 'cutoff', label: 'Filter cutoff (Hz)', min: 100, max: 8000, step: 10 },
  { key: 'sustain', label: 'Sustain / note hold (0-1)', min: 0, max: 1, step: 0.01 },
  { key: 'surroundAngle', label: 'Surround angle (deg)', min: -180, max: 180, step: 5 }
];

const TOGGLES: { key: 'fast2' | 'reverse' | 'every2' | 'juxRev' | 'surroundOn'; label: string }[] =
  [
    { key: 'fast2', label: 'fast(2)' },
    { key: 'reverse', label: 'rev()' },
    { key: 'every2', label: 'every(2, rev)' },
    { key: 'juxRev', label: 'jux(rev)' },
    { key: 'surroundOn', label: 'surround()' }
  ];

function buildPattern(state: LabState): Pattern<ControlPatch> {
  let pat = note(state.notation)
    .sound(state.soundType)
    .attack(0.004)
    .decay(0.12)
    .sustain(state.sustain)
    .release(0.08)
    .gain(state.gain)
    .lpf(state.cutoff);
  if (state.fast2) pat = pat.fast(2);
  if (state.reverse) pat = pat.rev();
  if (state.every2) pat = pat.every(2, rev);
  if (state.juxRev) pat = pat.jux(rev);
  if (state.surroundOn) pat = pat.surround(state.surroundAngle);
  return pat;
}

function generateCode(state: LabState, looping: boolean): string {
  const lines = [
    `note('${state.notation}')`,
    `  .sound('${state.soundType}')`,
    `  .attack(0.004).decay(0.12).sustain(${state.sustain}).release(0.08)`,
    `  .gain(${state.gain})`,
    `  .lpf(${state.cutoff})`
  ];
  if (state.fast2) lines.push('  .fast(2)');
  if (state.reverse) lines.push('  .rev()');
  if (state.every2) lines.push('  .every(2, rev)');
  if (state.juxRev) lines.push('  .jux(rev)');
  if (state.surroundOn) lines.push(`  .surround(${state.surroundAngle})`);
  lines.push(looping ? `  .loop({ bpm: ${state.bpm} });` : `  .play({ bpm: ${state.bpm} });`);
  return lines.join('\n');
}

/** Draws two cycles of the pattern as a small piano roll (noise events get the grey lane at the bottom). */
function drawPattern(canvas: HTMLCanvasElement, pat: Pattern<ControlPatch>): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 640;
  const height = canvas.clientHeight || 140;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  context.scale(dpr, dpr);

  context.fillStyle = '#050507';
  context.fillRect(0, 0, width, height);

  const CYCLES = 2;
  const BEATS = CYCLES * 4;
  for (let beat = 0; beat <= BEATS; beat++) {
    const x = (beat / BEATS) * width;
    context.strokeStyle = beat % 4 === 0 ? '#2e3540' : '#141b2b';
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  const NOISE_TYPES = new Set(['white', 'pink', 'brown']);
  const isNoiseHap = (value: ControlPatch): boolean =>
    value.soundType !== undefined && NOISE_TYPES.has(value.soundType);

  const haps = pat.query({ begin: new Fraction(0), end: new Fraction(CYCLES) }).filter(hasOnset);
  const pitchLogs = haps
    .filter((hap) => !isNoiseHap(hap.value))
    .map((hap) => hap.value.pitch)
    .filter((pitch): pitch is string | number => pitch !== undefined)
    .map((pitch) => Math.log2(noteToFrequency(pitch)));
  const minLog = pitchLogs.length > 0 ? Math.min(...pitchLogs) : 0;
  const maxLog = pitchLogs.length > 0 ? Math.max(...pitchLogs) : 1;
  const span = Math.max(maxLog - minLog, 0.5);

  for (const hap of haps) {
    const begin = hap.part.begin.toNumber() / CYCLES;
    const end = Math.min((hap.whole ?? hap.part).end.toNumber() / CYCLES, 1);
    const x = begin * width;
    const w = Math.max((end - begin) * width - 2, 3);
    const pitch = hap.value.pitch;

    let y: number;
    if (pitch === undefined || isNoiseHap(hap.value)) {
      // Noise voices ignore pitch entirely — draw them in the grey lane.
      context.fillStyle = '#64748b';
      y = height - 16;
    } else {
      const pitchLog = Math.log2(noteToFrequency(pitch));
      const norm = (pitchLog - minLog) / span;
      y = 10 + (1 - norm) * (height - 40);
      const hue = Math.round((pitchLog * 12 * 17) % 360);
      context.fillStyle = `hsl(${hue} 75% 65%)`;
    }

    const panOffset = (hap.value.pan ?? 0) * 4;
    context.globalAlpha = 0.9;
    context.fillRect(x, y + panOffset, w, 9);
  }
  context.globalAlpha = 1;
}

export function initPatternLab(): void {
  const notationInput = document.querySelector<HTMLInputElement>('#lab-notation');
  const soundSelect = document.querySelector<HTMLSelectElement>('#lab-sound');
  const examplesRow = document.querySelector<HTMLDivElement>('#lab-examples');
  const togglesRow = document.querySelector<HTMLDivElement>('#lab-toggles');
  const controlsBox = document.querySelector<HTMLDivElement>('#lab-controls');
  const errorBox = document.querySelector<HTMLDivElement>('#lab-error');
  const canvas = document.querySelector<HTMLCanvasElement>('#lab-viz');
  const codeOutput = document.querySelector<HTMLPreElement>('#lab-code');
  const playButton = document.querySelector<HTMLButtonElement>('#lab-play');
  const loopButton = document.querySelector<HTMLButtonElement>('#lab-loop');

  if (
    !notationInput ||
    !soundSelect ||
    !examplesRow ||
    !togglesRow ||
    !controlsBox ||
    !errorBox ||
    !canvas ||
    !codeOutput ||
    !playButton ||
    !loopButton
  ) {
    return;
  }

  const state: LabState = { ...DEFAULT_STATE };
  let currentPattern: Pattern<ControlPatch> | undefined;
  let loopHandle: LoopHandle | undefined;

  // One AudioContext for the lab, opted into the hardware's full channel
  // count so surround() addresses real speakers on 5.1/7.1 rigs (and folds
  // to stereo everywhere else). Created lazily on the first click.
  let audioContext: AudioContext | undefined;
  function getAudioContext(): AudioContext {
    if (!audioContext) {
      audioContext = new AudioContext();
      enableMultichannel(audioContext);
    }
    return audioContext;
  }

  const rangeInputs = new Map<string, { range: HTMLInputElement; value: HTMLSpanElement }>();
  const toggleInputs = new Map<string, HTMLInputElement>();

  function updateCode(): void {
    codeOutput!.textContent = generateCode(state, loopHandle !== undefined);
  }

  function setLoopButton(): void {
    loopButton!.textContent = loopHandle ? '■ Stop' : '⟳ Loop';
  }

  function rebuild(restartLoop: boolean): void {
    try {
      currentPattern = buildPattern(state);
      errorBox!.hidden = true;
      drawPattern(canvas!, currentPattern);
      if (restartLoop && loopHandle) {
        loopHandle.stop();
        loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm: state.bpm });
      }
      updateCode();
    } catch (err) {
      // Invalidate so Play/Loop can't fire a stale pattern that no longer
      // matches the notation box; a running loop keeps its last good pattern.
      currentPattern = undefined;
      errorBox!.hidden = false;
      errorBox!.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function syncControls(): void {
    notationInput!.value = state.notation;
    soundSelect!.value = state.soundType;
    for (const config of SLIDERS) {
      const refs = rangeInputs.get(config.key);
      if (refs) {
        refs.range.value = String(state[config.key]);
        refs.value.textContent = String(state[config.key]);
      }
    }
    for (const config of TOGGLES) {
      const checkbox = toggleInputs.get(config.key);
      if (checkbox) {
        checkbox.checked = state[config.key];
      }
    }
  }

  for (const config of TOGGLES) {
    const chip = document.createElement('label');
    chip.className = 'lab-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      state[config.key] = checkbox.checked;
      rebuild(true);
    });
    chip.append(checkbox, document.createTextNode(` ${config.label}`));
    togglesRow.appendChild(chip);
    toggleInputs.set(config.key, checkbox);
  }

  for (const config of SLIDERS) {
    const row = document.createElement('label');
    row.className = 'playground-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'playground-label';
    nameSpan.textContent = config.label;

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(config.min);
    range.max = String(config.max);
    range.step = String(config.step);
    range.value = String(state[config.key]);

    const valueSpan = document.createElement('span');
    valueSpan.className = 'playground-value';
    valueSpan.textContent = String(state[config.key]);

    range.addEventListener('input', () => {
      state[config.key] = Number(range.value);
      valueSpan.textContent = range.value;
      rebuild(false);
    });
    // Restart a running loop only when the drag lands, not on every pixel.
    range.addEventListener('change', () => rebuild(true));

    row.append(nameSpan, range, valueSpan);
    controlsBox.appendChild(row);
    rangeInputs.set(config.key, { range, value: valueSpan });
  }

  let notationDebounce: number | undefined;
  notationInput.addEventListener('input', () => {
    state.notation = notationInput!.value;
    if (notationDebounce !== undefined) {
      window.clearTimeout(notationDebounce);
    }
    notationDebounce = window.setTimeout(() => rebuild(true), 250);
  });

  soundSelect.addEventListener('change', () => {
    state.soundType = soundSelect!.value as SoundType;
    rebuild(true);
  });

  playButton.addEventListener('click', () => {
    rebuild(false);
    currentPattern?.play({ ctx: getAudioContext(), bpm: state.bpm });
  });

  loopButton.addEventListener('click', () => {
    if (loopHandle) {
      loopHandle.stop();
      loopHandle = undefined;
    } else {
      rebuild(false);
      if (currentPattern) {
        loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm: state.bpm });
      }
    }
    setLoopButton();
    updateCode();
  });

  for (const example of EXAMPLES) {
    const button = document.createElement('button');
    button.textContent = `♪ ${example.label}`;
    button.addEventListener('click', () => {
      // A pending notation edit must not fire after the example takes over.
      if (notationDebounce !== undefined) {
        window.clearTimeout(notationDebounce);
        notationDebounce = undefined;
      }
      Object.assign(state, DEFAULT_STATE, example.state);
      syncControls();
      loopHandle?.stop();
      loopHandle = undefined;
      rebuild(false);
      if (currentPattern) {
        loopHandle = currentPattern.loop({ ctx: getAudioContext(), bpm: state.bpm });
      }
      setLoopButton();
      updateCode();
    });
    examplesRow.appendChild(button);
  }

  syncControls();
  rebuild(false);
}
