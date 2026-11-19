// Scratch app: the playground's evaluation style, `new Function` over every export of the namespace
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as api from '@liminal-hq/undertone';
import { run, playgroundStyle } from '../../shared/run.js';

run('namespace + new Function', api, playgroundStyle, api.timing.start, api.timing.ready);
