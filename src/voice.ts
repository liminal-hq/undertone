// The chainable, immutable one-shot synth voice builder (note/sound entry points)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { SoundType, VoiceParams } from './types';

const DEFAULT_PARAMS: VoiceParams = {
  soundType: 'sine',
  pitch: undefined,
  gainLevel: 0.8,
  attack: 0.01,
  decay: 0.1,
  sustain: 0,
  release: 0.05,
  filterCutoff: undefined,
  filterEnvAmount: 0,
  filterAttack: 0,
  filterDecay: 0,
  filterSustain: 1,
  filterRelease: 0,
  slideTime: 0,
  nudgeTime: 0
};

/**
 * A chainable, immutable one-shot synth voice builder. Every method returns a
 * new Voice, so a partially-built voice is always safe to branch or reuse.
 */
export class Voice {
  private readonly params: Readonly<VoiceParams>;

  constructor(params: Partial<VoiceParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  private with(patch: Partial<VoiceParams>): Voice {
    return new Voice({ ...this.params, ...patch });
  }

  sound(type: SoundType): Voice {
    return this.with({ soundType: type });
  }

  attack(seconds: number): Voice {
    return this.with({ attack: seconds });
  }

  decay(seconds: number): Voice {
    return this.with({ decay: seconds });
  }

  /** Fraction (0-1) of gain the decay stage settles to before release. */
  sustain(level: number): Voice {
    return this.with({ sustain: level });
  }

  release(seconds: number): Voice {
    return this.with({ release: seconds });
  }

  gain(level: number): Voice {
    return this.with({ gainLevel: level });
  }

  /** Base lowpass cutoff in Hz. Creates a filter stage; omit to skip filtering entirely. */
  lpf(hz: number): Voice {
    return this.with({ filterCutoff: hz });
  }

  /** Hz the filter envelope adds on top of lpf() at its peak. */
  lpenv(hzAmount: number): Voice {
    return this.with({ filterEnvAmount: hzAmount });
  }

  lpa(seconds: number): Voice {
    return this.with({ filterAttack: seconds });
  }

  lpd(seconds: number): Voice {
    return this.with({ filterDecay: seconds });
  }

  /** Fraction (0-1) between lpf() and its envelope peak the decay stage settles to. */
  lps(level: number): Voice {
    return this.with({ filterSustain: level });
  }

  lpr(seconds: number): Voice {
    return this.with({ filterRelease: seconds });
  }

  /** Pitch glide (portamento): starts an octave above the target note and slides down. */
  slide(seconds: number): Voice {
    return this.with({ slideTime: seconds });
  }

  /** Start-time offset in seconds, relative to a stack()'s shared start time. */
  nudge(seconds: number): Voice {
    return this.with({ nudgeTime: seconds });
  }

  getParams(): Readonly<VoiceParams> {
    return this.params;
  }
}

/** Starts a pitched voice (default sound: sine). Pitch is a note name ("c2") or raw Hz. */
export function note(pitch: string | number): Voice {
  return new Voice({ pitch });
}

/** Starts a voice with no pitch — the natural entry point for noise-type voices (clicks, hits). */
export function sound(type: SoundType): Voice {
  return new Voice({ soundType: type });
}
