// Scratch app: the explicit init() alternative. No top-level await in this file or in the bridge entry.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { init, note } from '@liminal-hq/undertone/init';
import { run, direct } from '../../shared/run.js';

const startedAt = performance.now();
init().then(() => run('explicit init()', { note }, direct, startedAt, performance.now()));
