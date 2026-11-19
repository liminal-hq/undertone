// Tests how a fragment is wrapped for the live runner: the import scan, the last expression, mini strings and the errors
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lib from '../../../../src/index';
import { FakeAudioContext } from '../../../../src/test-utils/fakeAudioContext';
import { neededImports, tokenize, wrapFragment } from './fragment';
import { runSnippet } from './runSnippet';

const library = lib as unknown as Record<string, unknown>;
const contexts: FakeAudioContext[] = [];

class RecordingContext extends FakeAudioContext {
  constructor() {
    super();
    contexts.push(this);
  }
}

const globals = globalThis as Record<string, unknown>;
let savedContext: unknown;

beforeEach(() => {
  savedContext = globals.AudioContext;
  globals.AudioContext = RecordingContext;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globals.AudioContext = savedContext;
});

function started(): number {
  return contexts.reduce(
    (total, ctx) =>
      total +
      [...ctx.oscillators, ...ctx.bufferSources].reduce((n, node) => n + node.started.length, 0),
    0
  );
}

/** Runs wrapped code through the real runner for a few seconds; returns how many voices started and the run. */
async function play(code: string, kind: 'play' | 'mini') {
  const before = started();
  const run = runSnippet(wrapFragment(code, kind), { log: () => undefined });
  await run.done;
  for (let step = 0; step < 40; step++) {
    for (const ctx of contexts) ctx.currentTime += 0.1;
    vi.advanceTimersByTime(100);
  }
  return { voices: started() - before, run };
}

describe('tokenize', () => {
  it('keeps strings, templates and comments opaque', () => {
    const kinds = tokenize("note('a b') // stack\n`${rev}` /* fast */").map((t) => t.kind);
    expect(kinds).toEqual(['ident', 'punct', 'string', 'punct', 'comment', 'string', 'comment']);
  });
});

describe('neededImports', () => {
  it('finds every library name the code references, sorted', () => {
    expect(neededImports("stack(note('c3'), sound('white')).fast(2)", library)).toEqual([
      'note',
      'sound',
      'stack'
    ]);
  });

  it('ignores names inside strings, comments and templates', () => {
    const code = "// rev and stack\nnote('stack rev c3 e3') /* fast */;\n`${'sine'} rand`";
    expect(neededImports(code, library)).toEqual(['note']);
  });

  it('ignores a property after a dot and an object key, but not a spread or a shorthand', () => {
    expect(neededImports('note.rev.fast({ rev: 1, sine })', library)).toEqual(['note', 'sine']);
    expect(neededImports('x.fast(2).rev().stack', library)).toEqual([]);
  });

  it('leaves out what the code imports or declares itself', () => {
    expect(
      neededImports("import { note } from '@liminal-hq/undertone';\nnote('c3'); stack()", library)
    ).toEqual(['stack']);
    expect(
      neededImports("const rev = 1;\nfunction stack() {}\nnote('c3'); rev; stack()", library)
    ).toEqual(['note']);
    expect(neededImports("const { sine, saw: rand } = x;\nsine; rand; note('c')", library)).toEqual(
      ['note']
    );
  });

  it('does not mistake names every object has for library exports', () => {
    expect(neededImports('toString(); constructor; hasOwnProperty', library)).toEqual([]);
  });
});

describe('wrapFragment', () => {
  it('leaves a live example unchanged', () => {
    expect(wrapFragment('anything at all', 'live')).toBe('anything at all');
  });

  it('adds the imports a pattern expression needs and evaluates the whole block as its value', () => {
    const wrapped = wrapFragment("note('c4 e4')\n  .sound('triangle')\n  .fast(2);", 'play');
    expect(wrapped.startsWith("import { note } from '@liminal-hq/undertone';\n")).toBe(true);
    expect(wrapped).toContain(
      "const __value = (note('c4 e4')\n  .sound('triangle')\n  .fast(2)\n);"
    );
  });

  it('evaluates only the last statement, with the earlier ones kept as written', () => {
    const wrapped = wrapFragment(
      "const pad = note('c3');\nconst lead = note('e4');\nstack(pad, lead)\n  .sound('sine')",
      'play'
    );
    expect(wrapped).toContain("import { note, stack } from '@liminal-hq/undertone';");
    expect(wrapped).toContain(
      "const pad = note('c3');\nconst lead = note('e4');\nconst __value = (stack(pad, lead)\n  .sound('sine')\n);"
    );
  });

  it('uses the name a last const declares, and strips export', () => {
    const wrapped = wrapFragment("export const riff = note('c3 e3');", 'play');
    expect(wrapped).toContain("const riff = note('c3 e3');\nconst __value = riff;");
    expect(wrapped).not.toContain('export');
  });

  it('keeps an import line the block already has', () => {
    const wrapped = wrapFragment(
      "import { note } from '@liminal-hq/undertone';\nnote('c3')",
      'play'
    );
    expect(wrapped.match(/import /g)).toHaveLength(1);
  });

  it('refuses a block that ends with a statement or is empty', () => {
    expect(() => wrapFragment("note('c3');\nif (true) { note('e3'); }", 'play')).toThrow(
      /if statement/
    );
    expect(() => wrapFragment('// nothing here', 'play')).toThrow(/empty/);
    expect(() => wrapFragment('const { a } = b;', 'play')).toThrow(/destructures/);
  });

  it('wraps a mini block as a note and sound attempt over the trimmed string', () => {
    const wrapped = wrapFragment('  c3 e3 "g3"  \n', 'mini');
    expect(wrapped).toContain('const __mini = "c3 e3 \\"g3\\"";');
    expect(() => wrapFragment('  \n', 'mini')).toThrow(/empty/);
  });
});

describe('playing a fragment', () => {
  it('loops a pattern until stopped', async () => {
    const { voices, run } = await play("note('c3 e3 g3').sound('triangle')", 'play');
    expect(voices).toBeGreaterThan(3);
    run.stop();
    const after = started();
    for (const ctx of contexts) ctx.currentTime += 5;
    vi.advanceTimersByTime(5000);
    expect(started()).toBe(after);
  });

  it('plays what a multi-line chain with comments and no semicolons builds', async () => {
    const code = [
      "const bass = note('a1 a2')",
      "  .sound('sawtooth') // a bass",
      '  .lpf(400)',
      '',
      "const hats = sound('white*4').decay(0.02)",
      '',
      '// layered',
      'stack(bass, hats)',
      '  .gain(0.5)',
      '  // slow it down',
      '  .slow(2)'
    ].join('\n');
    const { voices } = await play(code, 'play');
    expect(voices).toBeGreaterThan(2);
  });

  it('leaves a pattern that is already playing alone, and stops it', async () => {
    const { voices, run } = await play("note('c3 e3').sound('triangle').loop({ bpm: 90 })", 'play');
    expect(voices).toBeGreaterThan(0);
    run.stop();
  });

  it('plays a const that holds a pattern and a one-shot', async () => {
    expect(
      (await play("const hit = note('c4').sound('triangle').play();", 'play')).voices
    ).toBeGreaterThan(0);
  });

  it('names a value that is not a pattern', async () => {
    await expect(play("'c3 e3 g3'", 'play')).rejects.toThrow(
      /last expression is string, not a pattern/
    );
    await expect(play('42', 'play')).rejects.toThrow(/is number, not a pattern/);
    await expect(play('const x = undefined;', 'play')).rejects.toThrow(
      /is undefined, not a pattern/
    );
  });

  it('plays a mini string as pitches, or else as built-in sounds', async () => {
    const pitched = await play('c3 [e3 g3] <b3 c4>', 'mini');
    expect(pitched.voices).toBeGreaterThan(0);
    pitched.run.stop();
    const noise = await play('white*4 ~ pink', 'mini');
    expect(noise.voices).toBeGreaterThan(0);
    noise.run.stop();
  });

  it('explains a mini string that is neither, and one that does not parse', async () => {
    await expect(play('bd*2 sd', 'mini')).rejects.toThrow(
      /not a sequence of pitches \(.*\) or of built-in sounds \(.*Invalid sound type: "bd"/
    );
    await expect(play('c3 [e3', 'mini')).rejects.toThrow(/not a sequence of pitches/);
  });
});
