// The generated WebAssembly glue, as one namespace the rest of the package reads after an entry has loaded the module
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The glue's exports are live bindings: they work once an entry (index.ts, index.node.ts, init.ts) has instantiated the
// module, and throw before that. Nothing in the package calls one at module-evaluation time, so importing the package's
// `api.ts` costs no instantiation; the signal constants (`sine`, ...) build their handles on first use for the same reason.

import * as glue from '../wasm/undertone_wasm.js';

export { glue };
export type { PatternList, WasmPattern, WasmRandom } from '../wasm/undertone_wasm.js';
