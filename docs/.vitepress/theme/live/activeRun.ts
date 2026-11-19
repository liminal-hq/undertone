// Keeps one live example sounding at a time across the whole page
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export interface ActiveRun {
  /** Stops the run and returns its example to idle. */
  stop(): void;
}

let active: ActiveRun | undefined;

/** Makes `run` the one that sounds, first stopping whichever example was playing. */
export function claimActive(run: ActiveRun): void {
  const previous = active;
  active = run;
  if (previous && previous !== run) previous.stop();
}

/** Forgets `run` when it is the active one (it stopped or finished by itself). */
export function releaseActive(run: ActiveRun): void {
  if (active === run) active = undefined;
}

/** Stops whatever example is playing, if any. */
export function stopActive(): void {
  const current = active;
  active = undefined;
  current?.stop();
}
