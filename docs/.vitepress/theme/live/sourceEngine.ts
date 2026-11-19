// Runs a documentation snippet against the library's own source, loaded into the page, and tracks what it starts so it can be stopped
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as lib from '../../../../src/index';
import type { SnippetContext, SnippetEngine, SnippetRun } from './runSnippet';

const IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@liminal-hq\/undertone';?[ \t]*$/gm;

/**
 * Turns a snippet into the body of an async function whose only free names are its own imports. Each
 * `import { a, b } from '@liminal-hq/undertone'` line becomes a destructure of the already-loaded
 * library namespace `__lib`, so the page shows the import a reader would write and the runner supplies
 * the module without a bundler or a network request. Throws, naming the problem, when the snippet
 * imports a name the library does not export or something other than the library.
 */
export function prepareSnippet(code: string, library: Record<string, unknown>): string {
  const stripped = code.replace(IMPORT, (_, names: string) => {
    const wanted = names
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const missing = wanted.filter((name) => !(name in library));
    if (missing.length > 0) {
      throw new Error(`imports ${missing.join(', ')}, which @liminal-hq/undertone does not export`);
    }
    return wanted.length > 0 ? `const { ${wanted.join(', ')} } = __lib;` : '';
  });
  if (/^\s*import\s/m.test(stripped)) {
    throw new Error("imports something other than '@liminal-hq/undertone'");
  }
  return stripped.replace(/^export\s+/gm, '');
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

type Collector = (stop: () => void) => void;
const collectors = new Set<Collector>();
let patched = false;

/**
 * Makes every `.play()` and `.loop()` report its handle to the runs that are listening. Patched once, on
 * the shared prototype, because the library has no global "stop everything"; a score's `play`/`loop`
 * call the pattern's, so they are caught too.
 */
function installCollector(): void {
  if (patched) return;
  patched = true;
  const proto = lib.Pattern.prototype as unknown as Record<
    string,
    (...args: unknown[]) => { stop(options?: unknown): void }
  >;
  const originalPlay = proto.play;
  const originalLoop = proto.loop;
  proto.play = function (this: unknown, ...args) {
    const handle = originalPlay.apply(this, args);
    for (const collect of collectors) collect(() => handle.stop());
    return handle;
  };
  proto.loop = function (this: unknown, ...args) {
    const handle = originalLoop.apply(this, args);
    for (const collect of collectors) collect(() => handle.stop({ voices: 'cut' }));
    return handle;
  };
}

function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/** The default engine: the library source already loaded into the page. */
export const sourceEngine: SnippetEngine = {
  run(code: string, ctx: SnippetContext): SnippetRun {
    installCollector();
    const stops: Array<() => void> = [];
    const collect: Collector = (stop) => stops.push(stop);
    const stop = (): void => {
      collectors.delete(collect);
      for (const fn of stops.splice(0)) fn();
      // A snippet's setcpm() would otherwise change the tempo of every example played after it.
      lib.resetTempo();
    };
    const consoleShadow = {
      log: (...args: unknown[]) => ctx.log(format(args)),
      warn: (...args: unknown[]) => ctx.log(format(args)),
      error: (...args: unknown[]) => ctx.log(format(args))
    };

    lib.resetTempo();
    let done: Promise<void>;
    try {
      const body = prepareSnippet(code, lib as unknown as Record<string, unknown>);
      const fn = new AsyncFunction('__lib', 'console', body);
      collectors.add(collect);
      done = fn(lib, consoleShadow).then(() => undefined);
    } catch (error) {
      done = Promise.reject(error);
    }
    // Whatever a failed run started is silenced, so an error never leaves a loop running.
    done = done.catch((error: unknown) => {
      stop();
      throw error;
    });
    return { stop, done };
  }
};
