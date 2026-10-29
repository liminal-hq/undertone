// Console warnings that fire once per distinct message key, for engine fallbacks
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

const warned = new Set<string>();

/** Logs `message` the first time `key` is seen, so a fallback inside a hot loop does not flood the console. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(message);
}

/** Forgets which warnings have fired — test hygiene, not needed in normal use. */
export function resetWarnings(): void {
  warned.clear();
}
