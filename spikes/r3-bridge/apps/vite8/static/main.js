// Scratch app: a static import of the bridge, as a user writes it
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, timing } from '@liminal-hq/undertone';
import { run, direct } from '../../shared/run.js';

run('static import', { note, timing }, direct, timing.start, timing.ready);
