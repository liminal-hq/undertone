// Shared piano-roll visualization: draws a couple of cycles of a pattern onto a canvas
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Fraction, hasOnset, noteToFrequency } from '../src/index';
import type { ControlPatch, Pattern } from '../src/index';

const NOISE_TYPES = new Set(['white', 'pink', 'brown']);

function isNoiseHap(value: ControlPatch): boolean {
  return value.soundType !== undefined && NOISE_TYPES.has(value.soundType);
}

/** Draws two cycles of the pattern as a small piano roll (noise events get the grey lane at the bottom). */
export function drawPattern(canvas: HTMLCanvasElement, pat: Pattern<ControlPatch>): void {
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
