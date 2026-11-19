// The one interface a live documentation example uses to run its code, so the engine behind it can change without touching a page
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { sourceEngine } from './sourceEngine';

/** What a running snippet can reach in the page that hosts it. */
export interface SnippetContext {
  /** Receives each line a snippet writes with `console.log` (and `warn`/`error`), so the page can show it. */
  log(line: string): void;
}

/** One execution of a snippet. */
export interface SnippetRun {
  /** Silences everything the run started: loops stop scheduling and sounding voices are cut. Safe to call more than once. */
  stop(): void;
  /** Settles when the snippet's own code has finished (not when its sound has); rejects with the error the code threw. */
  done: Promise<void>;
}

/** Something that can run a snippet's text. The library source is the only engine today; a WebAssembly bridge can be another. */
export interface SnippetEngine {
  /** Starts the code synchronously, inside the caller's user gesture, so the first audio start is allowed. */
  run(code: string, ctx: SnippetContext): SnippetRun;
}

let engine: SnippetEngine = sourceEngine;

/** Points every live example at another engine, for instance one backed by the WebAssembly build. */
export function setSnippetEngine(next: SnippetEngine): void {
  engine = next;
}

/**
 * Runs a documentation snippet exactly as the guide shows it, including its
 * `import ... from '@liminal-hq/undertone'` line, and returns a handle to stop it.
 */
export function runSnippet(code: string, ctx: SnippetContext): SnippetRun {
  return engine.run(code, ctx);
}
