// An interactive single-voice editor: tweak sliders, hear it, copy the generated code
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, sound } from '../src/index';
import type { SoundType } from '../src/index';

interface FieldConfig {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

const FIELDS: FieldConfig[] = [
  { id: 'attack', label: 'Attack (s)', min: 0, max: 1, step: 0.001, default: 0.01 },
  { id: 'decay', label: 'Decay (s)', min: 0, max: 1, step: 0.001, default: 0.1 },
  { id: 'sustain', label: 'Sustain (0-1)', min: 0, max: 1, step: 0.01, default: 0 },
  { id: 'release', label: 'Release (s)', min: 0, max: 1, step: 0.001, default: 0.05 },
  { id: 'gain', label: 'Gain (0-1)', min: 0, max: 1, step: 0.01, default: 0.8 },
  { id: 'lpf', label: 'Filter cutoff (Hz)', min: 50, max: 8000, step: 10, default: 2000 },
  { id: 'lpenv', label: 'Filter env amount (Hz)', min: 0, max: 8000, step: 10, default: 0 },
  { id: 'lpa', label: 'Filter attack (s)', min: 0, max: 1, step: 0.001, default: 0 },
  { id: 'lpd', label: 'Filter decay (s)', min: 0, max: 1, step: 0.001, default: 0 },
  { id: 'lps', label: 'Filter sustain (0-1)', min: 0, max: 1, step: 0.01, default: 1 },
  { id: 'lpr', label: 'Filter release (s)', min: 0, max: 1, step: 0.001, default: 0 },
  { id: 'slide', label: 'Slide (s)', min: 0, max: 1, step: 0.001, default: 0 },
  { id: 'nudge', label: 'Nudge (s)', min: 0, max: 1, step: 0.001, default: 0 }
];

const NOISE_TYPES = new Set<SoundType>(['white', 'pink', 'brown']);

function buildVoice(values: Record<string, number>, soundType: SoundType, pitch: string) {
  const base = NOISE_TYPES.has(soundType) ? sound(soundType) : note(pitch).sound(soundType);
  return base
    .attack(values.attack)
    .decay(values.decay)
    .sustain(values.sustain)
    .release(values.release)
    .gain(values.gain)
    .lpf(values.lpf)
    .lpenv(values.lpenv)
    .lpa(values.lpa)
    .lpd(values.lpd)
    .lps(values.lps)
    .lpr(values.lpr)
    .slide(values.slide)
    .nudge(values.nudge);
}

function generateCode(values: Record<string, number>, soundType: SoundType, pitch: string): string {
  const base = NOISE_TYPES.has(soundType)
    ? `sound('${soundType}')`
    : `note('${pitch}').sound('${soundType}')`;
  const chain = [
    `.attack(${values.attack})`,
    `.decay(${values.decay})`,
    `.sustain(${values.sustain})`,
    `.release(${values.release})`,
    `.gain(${values.gain})`,
    `.lpf(${values.lpf})`,
    `.lpenv(${values.lpenv})`,
    `.lpa(${values.lpa})`,
    `.lpd(${values.lpd})`,
    `.lps(${values.lps})`,
    `.lpr(${values.lpr})`,
    `.slide(${values.slide})`,
    `.nudge(${values.nudge})`
  ].join('\n  ');
  return `${base}\n  ${chain}\n  .play();`;
}

export function initPlayground(): void {
  const controlsContainer = document.querySelector<HTMLDivElement>('#playground-controls');
  const codeOutput = document.querySelector<HTMLPreElement>('#playground-code');
  const soundTypeSelect = document.querySelector<HTMLSelectElement>('#playground-sound-type');
  const pitchInput = document.querySelector<HTMLInputElement>('#playground-pitch');
  const playButton = document.querySelector<HTMLButtonElement>('#playground-play');

  if (!controlsContainer || !codeOutput || !soundTypeSelect || !pitchInput || !playButton) {
    return;
  }

  const values: Record<string, number> = {};
  for (const field of FIELDS) {
    values[field.id] = field.default;
  }

  function updateCode(): void {
    codeOutput!.textContent = generateCode(
      values,
      soundTypeSelect!.value as SoundType,
      pitchInput!.value
    );
  }

  for (const field of FIELDS) {
    const row = document.createElement('label');
    row.className = 'playground-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'playground-label';
    nameSpan.textContent = field.label;

    const rangeInput = document.createElement('input');
    rangeInput.type = 'range';
    rangeInput.min = String(field.min);
    rangeInput.max = String(field.max);
    rangeInput.step = String(field.step);
    rangeInput.value = String(field.default);

    const valueSpan = document.createElement('span');
    valueSpan.className = 'playground-value';
    valueSpan.textContent = String(field.default);

    rangeInput.addEventListener('input', () => {
      values[field.id] = Number(rangeInput.value);
      valueSpan.textContent = rangeInput.value;
      updateCode();
    });

    row.append(nameSpan, rangeInput, valueSpan);
    controlsContainer.appendChild(row);
  }

  soundTypeSelect.addEventListener('change', updateCode);
  pitchInput.addEventListener('input', updateCode);

  playButton.addEventListener('click', () => {
    const voice = buildVoice(values, soundTypeSelect.value as SoundType, pitchInput.value);
    voice.play();
  });

  updateCode();
}
