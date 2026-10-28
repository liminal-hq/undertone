// Seeded random sources that stay independent of Math.random and of the rest of a host game
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

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

/** FNV-1a: a stable string hash that does not depend on the platform. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
