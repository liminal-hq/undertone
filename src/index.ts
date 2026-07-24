// Public API: note/sound/stack entry points and the SoundEffect that plays them
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { AudioContextLike } from './types.js';
import { Voice, note, sound } from './voice.js';
import { playVoices } from './engine.js';

export { note, sound, Voice };
export type { AudioContextLike, NoiseType, OscType, SoundType, VoiceParams } from './types';

let sharedContext: AudioContextLike | undefined;

function getSharedContext(): AudioContextLike {
  if (!sharedContext) {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/** A group of voices that play together as one sound effect. */
export class SoundEffect {
  private readonly voices: Voice[];

  constructor(voices: Voice[]) {
    this.voices = voices;
  }

  /**
   * Schedules every voice to start at `when` (defaults to "now"). Creates and
   * reuses a single lazily-created AudioContext when none is passed — pass
   * your own to share one context across many sound effects.
   */
  play(ctx?: AudioContextLike, when?: number): void {
    const audioCtx = ctx ?? getSharedContext();
    const startTime = when ?? audioCtx.currentTime;
    playVoices(
      audioCtx,
      this.voices.map((voice) => voice.getParams()),
      startTime
    );
  }
}

/** Layers multiple voices into a single SoundEffect that plays them together. */
export function stack(...voices: Voice[]): SoundEffect {
  return new SoundEffect(voices);
}
