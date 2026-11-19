// Loads the TypeScript reference (this checkout's src/, or another worktree's) for the recorder
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as Library from '../../src/index';
import type * as Engine from '../../src/engine';
import type * as Random from '../../src/random';
import type * as Scheduler from '../../src/scheduler';

/** The reference's public surface plus the two internals the recorder reads (booking and tempo). */
export interface Reference {
  /** The directory the reference was loaded from. */
  root: string;
  lib: typeof Library;
  engine: typeof Engine;
  scheduler: typeof Scheduler;
  random: typeof Random;
}

/** The repository root: the directory above `conformance/`. */
export const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');

/**
 * Imports the reference from `root`/src. The default is this checkout; after the Rust takes over
 * (RF-32) a worktree of the reference SHA is passed with `--reference`.
 */
export async function loadReference(root: string = repoRoot): Promise<Reference> {
  const load = (file: string) => import(pathToFileURL(join(root, 'src', file)).href);
  const [lib, engine, scheduler, random] = await Promise.all([
    load('index.ts'),
    load('engine.ts'),
    load('scheduler.ts'),
    load('random.ts')
  ]);
  return { root, lib, engine, scheduler, random };
}
