// Runs the documentation's standalone code blocks against the library, so a missing import, a thrown error or a pattern that is built but never played fails the build
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lib from './index';
import { clearSamples } from './samples';
import { resetTempo } from './scheduler';
import { resetWarnings } from './warn';
import { runSnippet } from '../docs/.vitepress/theme/live/runSnippet';
import { wrapFragment } from '../docs/.vitepress/theme/live/fragment';
import { EXAMPLE_GROUPS } from '../docs/.vitepress/theme/playground/examples';
import { FakeAudioContext, FakeOfflineAudioContext } from './test-utils/fakeAudioContext';

// A fenced block whose info string is `ts standalone` or `ts live` promises that it runs as written: it imports
// everything it uses, defines everything it refers to, and plays or renders what it builds. This
// file executes each one. A `ts play` block or a `mini` block is a fragment the site's player wraps (it adds the
// imports and loops the last expression); this file wraps and plays each of those through the player's own
// runner. A plain `ts` block is a fragment that is not run. See the top of recipes.md.

const ROOT = join(__dirname, '..');
const PAGES = [
  'README.md',
  ...['docs', 'docs/guide']
    .flatMap((dir) => readdirSync(join(ROOT, dir)).map((name) => join(dir, name)))
    .filter((path) => path.endsWith('.md'))
];

interface Snippet {
  page: string;
  line: number;
  code: string;
  /** True for a `ts live` block, which the site also makes editable. */
  live: boolean;
}

interface Fragment {
  page: string;
  line: number;
  code: string;
  kind: 'play' | 'mini';
}

function standaloneSnippets(page: string): Snippet[] {
  const lines = readFileSync(join(ROOT, page), 'utf8').split('\n');
  const found: Snippet[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```ts (standalone|live)\s*$/.exec(lines[i]);
    if (fence) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].startsWith('```')) end++;
      found.push({
        page,
        line: start,
        code: lines.slice(start, end).join('\n'),
        live: fence[1] === 'live'
      });
      i = end;
    }
  }
  return found;
}

function fragmentSnippets(page: string): Fragment[] {
  const lines = readFileSync(join(ROOT, page), 'utf8').split('\n');
  const found: Fragment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(ts play|mini)\s*$/.exec(lines[i]);
    if (fence) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].startsWith('```')) end++;
      found.push({
        page,
        line: start,
        code: lines.slice(start, end).join('\n'),
        kind: fence[1] === 'mini' ? 'mini' : 'play'
      });
      i = end;
    }
  }
  return found;
}

const IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@liminal-hq\/undertone';?[ \t]*$/gm;

/** Turns a snippet into the body of an async function whose only free names are its own imports. */
function compile(code: string): string {
  const library = lib as Record<string, unknown>;
  const stripped = code.replace(IMPORT, (_, names: string) => {
    const wanted = names
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const missing = wanted.filter((name) => !(name in library));
    if (missing.length > 0) {
      throw new Error(`imports ${missing.join(', ')}, which @liminal-hq/undertone does not export`);
    }
    return `const { ${wanted.join(', ')} } = __lib;`;
  });
  if (/^\s*import\s/m.test(stripped)) {
    throw new Error('imports something other than @liminal-hq/undertone');
  }
  return ts.transpileModule(stripped.replace(/^export\s+/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

// Kept across snippets: the scheduler caches its shared context from the first snippet that needs one.
const contexts: FakeAudioContext[] = [];

class RecordingAudioContext extends FakeAudioContext {
  constructor() {
    super();
    contexts.push(this);
  }
}

class RecordingOfflineContext extends FakeOfflineAudioContext {
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    super({ numberOfChannels, length, sampleRate });
    contexts.push(this);
  }
}

/** How many voices any context was told to start: a pattern that is never played starts none. */
function startedVoices(): number {
  return contexts.reduce(
    (total, ctx) =>
      total +
      [...ctx.oscillators, ...ctx.bufferSources].reduce((n, node) => n + node.started.length, 0),
    0
  );
}

/** Lets looping snippets run for a few seconds: each step moves every live context on a tenth of a second and fires the loop timers. */
function runClocks(seconds: number): void {
  for (let step = 0; step < seconds * 10; step++) {
    for (const ctx of contexts) {
      if (!(ctx instanceof FakeOfflineAudioContext)) ctx.currentTime += 0.1;
    }
    vi.advanceTimersByTime(100);
  }
}

const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  for (const name of ['AudioContext', 'OfflineAudioContext', 'fetch']) saved[name] = globals[name];
  globals.AudioContext = RecordingAudioContext;
  globals.OfflineAudioContext = RecordingOfflineContext;
  // Samples are only ever fetched by URL; a tiny body is enough for the fake decoder.
  globals.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  vi.useFakeTimers(); // a loop's timer never fires, and nothing is left running
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of Object.keys(saved)) globals[name] = saved[name];
  clearSamples();
  resetTempo();
  resetWarnings();
  vi.restoreAllMocks();
});

describe('standalone documentation snippets', () => {
  it('finds the marked blocks on the recipes page', () => {
    expect(standaloneSnippets(join('docs', 'recipes.md')).length).toBeGreaterThanOrEqual(10);
  });

  for (const page of PAGES) {
    for (const snippet of standaloneSnippets(page)) {
      it(`${snippet.page}:${snippet.line} runs as written and plays something`, async () => {
        const body = compile(snippet.code);
        const before = startedVoices();
        await new AsyncFunction('__lib', body)(lib);
        runClocks(6);
        expect(
          startedVoices() - before,
          'it builds sound but never plays or renders it'
        ).toBeGreaterThan(0);
        expect(console.warn, 'it makes the library warn').not.toHaveBeenCalled();
      });

      if (snippet.live) {
        it(`${snippet.page}:${snippet.line} runs through the live runner and stops`, async () => {
          const before = startedVoices();
          const lines: string[] = [];
          const run = runSnippet(snippet.code, { log: (line) => lines.push(line) });
          await run.done;
          runClocks(6);
          expect(startedVoices() - before, 'the live runner played nothing').toBeGreaterThan(0);
          run.stop();
          const afterStop = startedVoices();
          runClocks(6);
          expect(startedVoices(), 'a loop kept sounding after stop()').toBe(afterStop);
        });
      }
    }
  }
});

describe('fragment documentation snippets', () => {
  it('finds the ts play and mini blocks on the mini-notation page', () => {
    expect(
      fragmentSnippets(join('docs', 'guide', 'mini-notation.md')).length
    ).toBeGreaterThanOrEqual(7);
  });

  for (const page of PAGES) {
    for (const fragment of fragmentSnippets(page)) {
      it(`${fragment.page}:${fragment.line} (${fragment.kind}) wraps, plays something and stops`, async () => {
        const before = startedVoices();
        const run = runSnippet(wrapFragment(fragment.code, fragment.kind), {
          log: () => undefined
        });
        await run.done;
        runClocks(6);
        expect(startedVoices() - before, 'the player played nothing').toBeGreaterThan(0);
        expect(console.warn, 'it makes the library warn').not.toHaveBeenCalled();
        run.stop();
        const afterStop = startedVoices();
        runClocks(6);
        expect(startedVoices(), 'a loop kept sounding after stop()').toBe(afterStop);
      });
    }
  }
});

describe('score() playground examples', () => {
  // The playground plays the pattern an example returns at the tempo slider, not at the score's own
  // `cps`, so an example that returns `.pattern` must set the bpm that gives the same cycle length.
  for (const group of EXAMPLE_GROUPS) {
    for (const example of group.examples) {
      if (!example.code.includes('score(')) continue;
      it(`${example.label} sets the bpm its score needs`, async () => {
        const cpsSeen: number[] = [];
        const scope = {
          ...lib,
          score: (definition: Parameters<typeof lib.score>[0]) => {
            const compiled = lib.score(definition);
            cpsSeen.push(compiled.cps);
            return compiled;
          }
        } as Record<string, unknown>;
        const run = new Function(...Object.keys(scope), `"use strict";\n${example.code}`);
        run(...Object.values(scope));
        expect(cpsSeen.length).toBe(1);
        // One cycle is four beats, 240 / bpm seconds; the score's cycle is 1 / cps seconds.
        expect(example.bpm).toBeCloseTo(240 * cpsSeen[0], 6);
      });
    }
  }
});
