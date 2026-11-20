// Resolving a voice patch to the complete parameters the engine plays
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch, VoiceParams } from './types.js';
import { glue } from './wasm.js';

/**
 * The complete voice parameters for a patch: every missing field takes its default, and a patch that names a sample
 * gets the sample rule. A plain object, as `{ ...DEFAULT_PARAMS, ...patch }` is.
 */
export function resolveParams(patch: ControlPatch): VoiceParams {
  return glue.resolveParams(patch) as VoiceParams;
}
