// Prints a table of the JSON lines the browser runner wrote
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from 'node:fs';
const want = '40f4b4acc4e1e8a5,13cd5d4d397dd743,dab46198aec746e1,3eb40beba45213cf,4421f1774cd05924';
for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line);
    const m = r.medians ?? {};
    const f = (x) => (x === undefined ? '-' : x.toFixed(1));
    console.log(
      [
        r.browser.split(' ')[0],
        r.app,
        `${r.ran}/${r.runs}`,
        r.onTime ? 'on time' : 'LATE',
        (r.hashes ?? []).join() === want ? 'hashes=node' : 'HASH DIFF/none',
        `inst ${f(m.instantiateMs)}`,
        `play ${f(m.playMs)}`,
        `total ${f(m.loadStartToBookedMs)}`,
        r.dynamicImportMs ? `import() ${f(m.dynamicImportMs)}` : '',
        (r.errors ?? []).join(' | ').slice(0, 60)
      ].join(' | ')
    );
  }
}
