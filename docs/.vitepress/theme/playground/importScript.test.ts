// Unit tests for the lenient .song-style script loader
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { arrange, clearSamples, pure, registerSample, s } from '../../../../src/index';
import { findUnregisteredSamples, prepareImportedScript, scriptName } from './importScript';

// Real leading-comment headers copied verbatim from
// sample-background-songs/*.song (gitignored, not present in CI) — these
// fixtures are what scriptName()'s heuristic has to actually handle: a
// straightforward quoted title on line 1, and a decorative divider line
// that precedes the real title on line 2.
const VELVET_BASEMENT_HEADER = `// "Velvet Basement"
// original cinematic trip-hop / downtempo sketch
//
// 86 BPM
// 80 bars ≈ 3:43

setcpm(86/4)

n('0 2 4').s('triangle')`;

const VELVET_PROCESSION_HEADER = `// ============================================================
// "VELVET PROCESSION II"
// acoustic / orchestral / electronic trip-hop
//
// Rebuilt after analysing the real 3:30 Post-Modern Sleaze mix.

setcpm(72/4)

n('0 2 4').s('triangle')`;

describe('scriptName', () => {
  it('takes the quoted title from a straightforward first comment line', () => {
    expect(scriptName(VELVET_BASEMENT_HEADER)).toBe('Velvet Basement');
  });

  it('skips a decorative divider line and finds the real title on the next line', () => {
    expect(scriptName(VELVET_PROCESSION_HEADER)).toBe('VELVET PROCESSION II');
  });

  it('falls back to an "Untitled ..." name when there is no usable leading comment', () => {
    expect(scriptName(`n('0 2 4').s('triangle')`)).toMatch(/^Untitled /);
  });

  it('ignores a leading comment block that is entirely punctuation', () => {
    expect(scriptName(`// ----\n// ====\nn('0 2 4').s('triangle')`)).toMatch(/^Untitled /);
  });
});

describe('prepareImportedScript', () => {
  it('converts setcpm(...) to a bpm and comments out the original call', () => {
    const result = prepareImportedScript(VELVET_BASEMENT_HEADER);
    expect(result.bpm).toBe(86);
    expect(result.code).toContain('// setcpm(86/4)');
    expect(result.code).not.toMatch(/^setcpm\(86\/4\)/m);
  });

  it('converts a different setcpm value correctly', () => {
    expect(prepareImportedScript(VELVET_PROCESSION_HEADER).bpm).toBe(72);
  });

  it('inserts a return before the final bare expression statement', () => {
    const result = prepareImportedScript(`const x = n('0 2 4')\nx.s('triangle')`);
    expect(result.code).toContain(`return x.s('triangle')`);
  });

  it('does not insert a return when the script already has one', () => {
    const result = prepareImportedScript(`const x = n('0 2 4')\nreturn x.s('triangle')`);
    expect(result.code.match(/return/g)).toHaveLength(1);
  });

  it('does not insert a return when the last statement is not an expression', () => {
    const result = prepareImportedScript(`const x = n('0 2 4')`);
    expect(result.code).not.toContain('return');
  });

  it('derives the name from the leading comment block', () => {
    expect(prepareImportedScript(VELVET_PROCESSION_HEADER).name).toBe('VELVET PROCESSION II');
  });

  it('round-trips a real .song-style header end to end', () => {
    const result = prepareImportedScript(VELVET_BASEMENT_HEADER);
    expect(result.name).toBe('Velvet Basement');
    expect(result.bpm).toBe(86);
    expect(result.code).toContain(`return n('0 2 4').s('triangle')`);
  });
});

describe('findUnregisteredSamples', () => {
  it('reports a sample name with no matching registerSample() call', () => {
    clearSamples();
    const missing = findUnregisteredSamples(s('gm_voice_oohs'), 1);
    expect(missing).toEqual([{ name: 'gm_voice_oohs', bank: undefined }]);
  });

  it('reports nothing once the sample is registered', () => {
    clearSamples();
    registerSample('gm_voice_oohs', { buffer: { getChannelData: () => new Float32Array(4) } });
    expect(findUnregisteredSamples(s('gm_voice_oohs'), 1)).toEqual([]);
  });

  it('ignores events with no sampleName at all', () => {
    clearSamples();
    expect(findUnregisteredSamples(pure({}), 1)).toEqual([]);
  });

  it('deduplicates repeated onsets of the same missing sample', () => {
    clearSamples();
    const missing = findUnregisteredSamples(arrange([2, s('bd sd bd sd')]), 2);
    expect(missing).toEqual([
      { name: 'bd', bank: undefined },
      { name: 'sd', bank: undefined }
    ]);
  });
});
