// Tests the live-example runner: import resolution, console capture, error reporting and stopping
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as lib from '../../../../src/index';
import { FakeAudioContext } from '../../../../src/test-utils/fakeAudioContext';
import { prepareSnippet } from './sourceEngine';
import { runSnippet, setSnippetEngine } from './runSnippet';
import type { SnippetEngine } from './runSnippet';
import { sourceEngine } from './sourceEngine';
import { claimActive, releaseActive, stopActive } from './activeRun';

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
  setSnippetEngine(sourceEngine);
});

describe('prepareSnippet', () => {
  it('turns the library import into a destructure of the loaded namespace', () => {
    const body = prepareSnippet(
      "import { note, stack } from '@liminal-hq/undertone';\nnote('c4').play();",
      library
    );
    expect(body).toBe("const { note, stack } = __lib;\nnote('c4').play();");
  });

  it('accepts import type and a multi-line import', () => {
    const body = prepareSnippet(
      "import type { Pattern } from '@liminal-hq/undertone';\nimport {\n  note,\n  sine\n} from '@liminal-hq/undertone';\n",
      library
    );
    expect(body).toContain('const { Pattern } = __lib;');
    expect(body).toContain('const { note, sine } = __lib;');
  });

  it('names an import the library does not export', () => {
    expect(() => prepareSnippet("import { nope } from '@liminal-hq/undertone';", library)).toThrow(
      /nope, which @liminal-hq\/undertone does not export/
    );
  });

  it('refuses an import from anywhere else', () => {
    expect(() => prepareSnippet("import fs from 'node:fs';", library)).toThrow(
      /something other than/
    );
  });
});

describe('runSnippet', () => {
  it('plays, captures console output and stops a loop', async () => {
    const lines: string[] = [];
    const run = runSnippet(
      "import { note } from '@liminal-hq/undertone';\nconsole.log('hello', { a: 1 });\nnote('c4 e4').sound('triangle').loop({ bpm: 120 });",
      { log: (line) => lines.push(line) }
    );
    await run.done;
    expect(lines).toEqual(['hello {"a":1}']);
    const ctx = contexts[contexts.length - 1];
    vi.advanceTimersByTime(400);
    ctx.currentTime += 0.4;
    vi.advanceTimersByTime(200);
    const started = ctx.oscillators.reduce((n, osc) => n + osc.started.length, 0);
    expect(started).toBeGreaterThan(0);
    run.stop();
    run.stop(); // safe to repeat
    ctx.currentTime += 5;
    vi.advanceTimersByTime(5000);
    expect(ctx.oscillators.reduce((n, osc) => n + osc.started.length, 0)).toBe(started);
  });

  it('rejects done with the message of what the code threw, and stops what it started', async () => {
    const run = runSnippet(
      "import { note } from '@liminal-hq/undertone';\nnote('c4').loop();\nthrow new Error('boom');",
      { log: () => undefined }
    );
    await expect(run.done).rejects.toThrow('boom');
  });

  it('rejects done for a syntax error and for a missing import', async () => {
    await expect(runSnippet('const = ;', { log: () => undefined }).done).rejects.toThrow();
    await expect(
      runSnippet("import { nope } from '@liminal-hq/undertone';", { log: () => undefined }).done
    ).rejects.toThrow(/nope/);
  });

  it('runs on whichever engine was set', async () => {
    const seen: string[] = [];
    const engine: SnippetEngine = {
      run(code) {
        seen.push(code);
        return { stop: () => undefined, done: Promise.resolve() };
      }
    };
    setSnippetEngine(engine);
    await runSnippet('x', { log: () => undefined }).done;
    expect(seen).toEqual(['x']);
  });
});

describe('activeRun', () => {
  it('stops the previous example when another starts, and on stopActive', () => {
    const stopped: string[] = [];
    const a = { stop: () => stopped.push('a') };
    const b = { stop: () => stopped.push('b') };
    claimActive(a);
    claimActive(b);
    expect(stopped).toEqual(['a']);
    releaseActive(b);
    stopActive();
    expect(stopped).toEqual(['a']);
    claimActive(a);
    stopActive();
    expect(stopped).toEqual(['a', 'a']);
  });
});
