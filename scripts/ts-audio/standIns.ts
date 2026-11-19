// Procedural stand-ins for the sample files the documentation's examples name, made at render time and never committed
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { encodeWav } from '../../src/wav';
import { seededRandom } from '../../src/random';

const RATE = 48000;

function make(seconds: number, voice: (t: number) => number): Float32Array {
  const data = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < data.length; i++) data[i] = voice(i / RATE);
  return data;
}

/** A kick: a sine that falls from 140 Hz to 45 Hz and dies away over about a third of a second. */
function kick(): Float32Array {
  let phase = 0;
  return make(0.4, (t) => {
    phase += (2 * Math.PI * (45 + 95 * Math.exp(-t * 28))) / RATE;
    return 0.9 * Math.sin(phase) * Math.exp(-t * 11);
  });
}

/** A snare: a short noise burst over a 190 Hz body. */
function snare(): Float32Array {
  const random = seededRandom('stand-in-snare');
  return make(0.3, (t) => {
    const noise = (random() * 2 - 1) * Math.exp(-t * 20);
    return 0.5 * noise + 0.4 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30);
  });
}

/** A closed hat: a very short burst of differentiated noise, which keeps the top of the spectrum. */
function hat(): Float32Array {
  const random = seededRandom('stand-in-hat');
  let previous = 0;
  return make(0.1, (t) => {
    const noise = random() * 2 - 1;
    const sample = (noise - previous) * Math.exp(-t * 55);
    previous = noise;
    return 0.45 * sample;
  });
}

/** A pluck on E1 (41.2 Hz, the base note the guide registers it with): the first eight harmonics, the upper ones dying faster. */
function pluck(): Float32Array {
  const fundamental = 41.2035;
  return make(1.5, (t) =>
    Array.from({ length: 8 }, (_, h) => {
      const n = h + 1;
      return (Math.sin(2 * Math.PI * fundamental * n * t) / n) * Math.exp(-t * (2 + n * 1.5));
    }).reduce((sum, value) => sum + value, 0)
  );
}

const MAKERS: Record<string, () => Float32Array> = { kick, snare, hat, pluck };

/** Which stand-in a sample URL gets, by the file's name (`/audio/808/kick.wav` is a kick, `/audio/pluck-e1.wav` a pluck), or undefined. */
export function standInFor(url: string): string | undefined {
  const name = /\/([a-z]+)[^/]*\.wav$/i.exec(url)?.[1]?.toLowerCase();
  return name && name in MAKERS ? name : undefined;
}

/** A 16-bit mono WAV file of the stand-in for a sample URL, or undefined when the URL names no known sample. */
export function standInWav(url: string): Uint8Array | undefined {
  const name = standInFor(url);
  if (!name) return undefined;
  return encodeWav({ sampleRate: RATE, channels: [MAKERS[name]()] }, { bitDepth: 16 });
}
