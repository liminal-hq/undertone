// The wrapper's own once-only warnings, for the fallbacks it applies itself on a context that lacks an optional factory
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The module prints its warnings itself and keeps its own set (M6-BOUNDARY section 8). The few the wrapper gives (a context
// without `createPeriodicWave`, `createWaveShaper`, `createDynamicsCompressor`, or `suspend()`) use keys the module never uses,
// so the two sets never overlap; `./testing`'s `resetWarnings` clears both.

const warned = new Set<string>();

/** Prints `message` with `console.warn` the first time `key` is seen. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Forgets the wrapper's warnings. */
export function resetWrapperWarnings(): void {
  warned.clear();
}
