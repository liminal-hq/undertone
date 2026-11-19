// Records or checks the field list of `VoiceParams` read from src/types.ts with the TypeScript compiler API
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const typesPath = join(root, 'src', 'types.ts');
const snapshotPath = join(root, 'conformance', 'api', 'voice-params.json');

interface Field {
  name: string;
  optional: boolean;
  type: string;
}

/** Reads every property of the `VoiceParams` interface, in declaration order. */
export function readFields(): Field[] {
  const text = readFileSync(typesPath, 'utf8');
  const source = ts.createSourceFile(typesPath, text, ts.ScriptTarget.ES2022, true);
  const fields: Field[] = [];
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'VoiceParams') return;
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) {
        throw new Error('VoiceParams has a member that is not a typed property');
      }
      fields.push({
        name: member.name.getText(source),
        optional: member.questionToken !== undefined,
        // Collapse whitespace so a reformat of the declaration does not change the snapshot.
        type: member.type.getText(source).replace(/\s+/g, ' ')
      });
    }
  });
  if (fields.length === 0) throw new Error('Cannot find the VoiceParams interface in src/types.ts');
  return fields;
}

/** The snapshot text: the field list as indented JSON with a trailing newline. */
export function generate(): string {
  return `${JSON.stringify({ interface: 'VoiceParams', source: 'src/types.ts', fields: readFields() }, null, 2)}\n`;
}

const mode = process.argv[2];
if (mode === 'record') {
  writeFileSync(snapshotPath, generate());
  console.log(`Wrote ${snapshotPath}`);
} else if (mode === 'check') {
  if (generate() === readFileSync(snapshotPath, 'utf8')) {
    console.log('VoiceParams field list is up to date.');
  } else {
    console.error(
      'The VoiceParams fields in src/types.ts changed. Update params.rs, then run `bun run voice-params:record`.'
    );
    process.exit(1);
  }
} else {
  console.error('Usage: voice-params.ts record|check');
  process.exit(2);
}
