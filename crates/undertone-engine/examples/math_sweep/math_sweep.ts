// Dumps the reference's maths over the same sweeps as sets.rs, from the TypeScript run by bun (JavaScriptCore)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

// Run from the repository root: bun crates/undertone-engine/examples/math_sweep/math_sweep.ts <file>
// The set order and the arithmetic mirror sets.rs; the wave tables, pan-law gains, and surround
// gains come from the real src/ functions (the autopan table through connectAutopan on a stub).

import { writeFileSync } from 'node:fs';
import { shapedWaveTable } from '../../../../src/waves.ts';
import { panLawGains } from '../../../../src/panPath.ts';
import { surroundGains } from '../../../../src/surround.ts';
import { connectAutopan } from '../../../../src/autopan.ts';

const out: string[] = [];
const text = (x: number): string => (Object.is(x, -0) ? '-0' : String(x));
const push = (values: number[]): void => {
  for (const x of values) out.push(text(x));
};
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const waveArgs = range(1, 64).flatMap((k) =>
  range(0, 4095).map((n) => (2 * Math.PI * k * n) / 4096)
);
push(waveArgs.map(Math.sin));
push(waveArgs.map(Math.cos));
const uniform = range(-100000, 100000).map((i) => i * 0.001);
push(uniform.map(Math.sin));
push(uniform.map(Math.cos));
const panArgs = range(-1000, 1000).map((i) => ((i / 1000 + 1) * Math.PI) / 4);
push(panArgs.map(Math.sin));
push(panArgs.map(Math.cos));
const phaseArgs = range(1, 64).flatMap((k) =>
  range(0, 999).map((j) => 2 * Math.PI * k * (j / 1000))
);
push(phaseArgs.map(Math.sin));
push(phaseArgs.map(Math.cos));
push(range(1, 64).map((k) => Math.sin((k * Math.PI) / 2)));
push(range(0, 10000).map((i) => Math.acos(i / 10000)));
push(range(-20000, 20000).map((i) => Math.exp(i / 1000)));
const decayRate = -Math.log(0.001);
push(range(0, 132299).map((i) => Math.exp(-decayRate * (i / 132300))));
push(range(1, 10000).map((i) => Math.log(i / 1000)));
push(range(0, 6000).map((i) => 10 ** (-i / 1000 / 20)));
push(range(0, 12000).map((i) => 10 ** (-i / 100 / 20)));
push(range(0, 12800).map((i) => 2 ** ((i / 100 - 69) / 12)));
push(range(-6000, 6000).map((i) => 2 ** (i / 10 / 1200)));
push(range(1, 64).map((k) => (Math.PI * k) ** 2));
push(range(1, 64).map((k) => (-1) ** k));

for (const type of ['halfsine', 'abssine', 'pulsesine'] as const) {
  const { real, imag } = shapedWaveTable(type);
  push([...real, ...imag]);
}
for (const shape of ['sine', 'triangle', 'square'] as const) {
  for (const phase of [0.125, 0.25, 0.3, 0.5, 0.7]) {
    let wave: { real: Float32Array; imag: Float32Array } | undefined;
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {} };
    const node = { connect() {}, gain: param, frequency: param, type: 'sine', setPeriodicWave() {} };
    const ctx = {
      createOscillator: () => node,
      createGain: () => node,
      createPeriodicWave: (real: Float32Array, imag: Float32Array) => (wave = { real, imag })
    };
    connectAutopan(ctx as never, param as never, { rate: 1, depth: 1, shape, phase }, 0);
    if (!wave) throw new Error('no wave');
    push([...(wave as { real: Float32Array; imag: Float32Array }).real, ...(wave as { real: Float32Array; imag: Float32Array }).imag]);
  }
}

for (const law of [-6, -4.5, -3, -1, 0]) {
  for (let i = -100; i <= 100; i++) {
    const gains = panLawGains(i / 100, law);
    push([gains.left, gains.right]);
  }
}
push(range(0, 600).map((i) => Math.SQRT2 * 10 ** (-i / 100 / 20)));
for (let i = -720; i <= 720; i++) push(surroundGains(i * 0.5));

writeFileSync(process.argv[2], out.join('\n') + '\n');
