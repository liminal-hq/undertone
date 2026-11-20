// What an entry does once the WebAssembly module is instantiated: the control methods and the constants read from the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { installControls } from './controlsWiring.js';
import { loadInstruments } from './instruments.js';
import { loadSurround } from './surround.js';
import { loadWaves } from './waves.js';

/** Installs the control methods and reads the constants from the module. Safe to call again. */
export function install(): void {
  installControls();
  loadSurround();
  loadWaves();
  loadInstruments();
}
