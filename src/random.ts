// Seeded random sources that stay independent of Math.random and of the rest of a host game
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioContextLike } from './types.js';

/**
 * A small, fast seeded random generator (mulberry32). The same seed always
 * produces the same sequence on every device, and it is independent of
 * `Math.random` and of anything else in a host game, so audio variation never
 * disturbs a game's own seeded simulation. A string seed is hashed first.
 */
export function seededRandom(seed: number | string): () => number {
  let state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A function returning uniform numbers in [0, 1), like `Math.random`. */
export type RandomSource = () => number;

interface ContextSeed {
  seed: number | string;
  occurrences: Map<string, number>;
}

const seedsByContext = new WeakMap<AudioContextLike, ContextSeed>();

/** Seeds a context's noise and reverb randomness; resets the per-key occurrence counters. */
export function seedContext(ctx: AudioContextLike, seed: number | string): void {
  seedsByContext.set(ctx, { seed, occurrences: new Map() });
}

/**
 * A random source for one piece of generated audio data. Unseeded contexts get
 * `Math.random`. Seeded contexts get a generator derived from the seed and
 * `key`, plus a count of earlier calls with the same key on that context, so
 * two voices with an identical key still differ, deterministically. Use this
 * for data whose identity is "the nth thing generated for this key".
 */
export function contextRandom(ctx: AudioContextLike, key: string): RandomSource {
  const entry = seedsByContext.get(ctx);
  if (!entry) {
    return Math.random;
  }
  const n = entry.occurrences.get(key) ?? 0;
  entry.occurrences.set(key, n + 1);
  return seededRandom(`${entry.seed}|${key}#${n}`);
}

/**
 * Like `contextRandom` but without the occurrence counter: the same key always
 * yields the same sequence. Used for reverb impulse responses, whose content
 * must depend only on seed, orbit, room size and sample rate, never on the
 * order in which impulse responses happen to be built or rebuilt.
 */
export function keyedRandom(ctx: AudioContextLike, key: string): RandomSource {
  const entry = seedsByContext.get(ctx);
  return entry ? seededRandom(`${entry.seed}|${key}`) : Math.random;
}

/** FNV-1a: a stable string hash that does not depend on the platform. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
