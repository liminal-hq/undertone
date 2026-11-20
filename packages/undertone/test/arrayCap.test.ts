// Tests that a sparse array of 2^32 - 1 holes is refused with an ordinary error by every export that takes a list, in both modules
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { note } from '@liminal-hq/undertone';
import * as wasm from '@liminal-hq/undertone/wasm';
import { handleOfPattern } from '../dist/pattern.js';
import * as render from '../wasm/render/undertone_wasm_render.js';

render.initSync({
  module: readFileSync(new URL('../wasm/render/undertone_wasm_render_bg.wasm', import.meta.url))
});

// A sparse array's length is a number alone, so it costs nothing in JavaScript. A parameter the generated glue reads as a
// vector (`Vec<String>`, `Vec<Float32Array>`) is walked and given `length * 4` bytes before Rust runs, so these must be plain
// values that the module reads through its capped conversion.
const sparse = () => new Array(0xffffffff);
const wide = /at most 4194304 items wide, got 4294967295/;

describe('the main module', () => {
  it('refuses registerSamples() names that are far too wide, and stays alive', () => {
    expect(() => wasm.registerSamples(sparse() as never, [])).toThrow(wide);
    expect(() => wasm.registerSamples(['a'], sparse())).toThrow(wide);
    expect(wasm.isSampleRegistered('a')).toBe(false);
  });

  it('still registers names with their sources, and refuses names that are not strings', () => {
    const pcm = { sampleRate: 8000, channels: [new Float32Array([0.5, -0.5])] };
    wasm.registerSamples(['cap_bd', 'cap_sd'], [pcm, { ...pcm, baseNote: 'a3' }]);
    expect(wasm.isSampleRegistered('cap_sd')).toBe(true);
    expect(wasm.getSampleBaseNote('cap_sd')).toBe('a3');
    expect(() => wasm.registerSamples([1] as never, [pcm])).toThrow(
      /registerSamples\(\) names must be strings/
    );
    wasm.clearSamples();
  });
});

describe('the render module', () => {
  const numbers = new Float64Array();

  it('refuses renderVoices() strings that are far too wide', () => {
    expect(() => render.renderVoices(numbers, sparse() as never, {})).toThrow(wide);
  });

  it('refuses ContextRender strings that are far too wide', () => {
    expect(() => new render.ContextRender(numbers, sparse() as never, {})).toThrow(wide);
  });

  it('refuses encodeWav() channels that are far too wide, and still encodes a normal list', () => {
    expect(() => render.encodeWav(8000, sparse() as never, {})).toThrow(wide);
    const bytes = render.encodeWav(8000, [new Float32Array([0, 0.5])], {});
    expect(bytes.length).toBe(44 + 4);
    expect(() => render.encodeWav(8000, [[0, 1]] as never, {})).toThrow(
      /encodeWav\(\) channels must be Float32Arrays/
    );
  });

  it('refuses finish() channels that are far too wide, and folds a normal list as before', () => {
    const options = { sampleRate: 8000, cycles: 1, master: false };
    const voices = wasm.collectVoices(handleOfPattern(note('c4')), options);
    const [flat, strings] = voices.encoded() as [Float64Array, string[]];
    voices.free();
    const plan = new render.ContextRender(flat, strings, options);
    expect(() => plan.finish(sparse() as never)).toThrow(wide);
    const channels = [new Float32Array(plan.length)];
    expect(plan.finish(channels as never)).toHaveLength(1);
    plan.free();
  });
});
