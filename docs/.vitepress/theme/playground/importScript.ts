// Lenient script loader: turns a pasted/opened .song-style REPL sketch into
// something the Composer's compileScript() will actually accept — inserting a
// missing `return`, converting a top-level setcpm() call to a bpm, and
// deriving a human name from the script's own leading comment.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { Fraction, hasOnset, isSampleRegistered } from '../../../../src/index';
import type { ControlPatch, Hap, TimeSpan } from '../../../../src/index';

export interface ImportedScript {
  code: string;
  bpm?: number;
  name?: string;
}

export interface UnregisteredSample {
  name: string;
  bank?: string;
}

interface QueryablePattern {
  query(span: TimeSpan): Hap<ControlPatch>[];
}

const COMMENT_TYPES = new Set(['LineComment', 'BlockComment']);

function topLevelChildren(source: string): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  let child = parser.parse(source).topNode.firstChild;
  while (child) {
    nodes.push(child);
    child = child.nextSibling;
  }
  return nodes;
}

function findLastMeaningfulNode(nodes: SyntaxNode[]): SyntaxNode | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!COMMENT_TYPES.has(nodes[i].type.name)) {
      return nodes[i];
    }
  }
  return undefined;
}

/** Evaluates a constant arithmetic expression: digits, +, -, *, /, (), whitespace only. */
function evalArithmetic(expr: string): number | undefined {
  if (!/^[\d\s.+\-*/()]+$/.test(expr)) {
    return undefined;
  }
  try {
    // Safe: the regex above only admits numerals and arithmetic operators.
    const value = new Function(`"use strict"; return (${expr});`)() as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** If `node` is a top-level `setcpm(<arithmetic>)` call, returns its cycles-per-minute value. */
function readSetcpmCall(node: SyntaxNode, source: string): number | undefined {
  if (node.type.name !== 'ExpressionStatement') {
    return undefined;
  }
  const call = node.firstChild;
  if (!call || call.type.name !== 'CallExpression') {
    return undefined;
  }
  const callee = call.firstChild;
  if (
    !callee ||
    callee.type.name !== 'VariableName' ||
    source.slice(callee.from, callee.to) !== 'setcpm'
  ) {
    return undefined;
  }
  const argList = callee.nextSibling;
  if (!argList || argList.type.name !== 'ArgList') {
    return undefined;
  }
  return evalArithmetic(source.slice(argList.from + 1, argList.to - 1));
}

function cleanCommentLine(raw: string): string {
  return raw
    .trim()
    .replace(/^\/\*+/, '')
    .replace(/\*+\/\s*$/, '')
    .replace(/^\*+/, '')
    .replace(/^\/\/+/, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

/**
 * Derives a display name from the script's leading comment block (the
 * contiguous run of comment nodes before the first real statement), scanning
 * every line in that block — not just the first — since a decorative divider
 * (`// ====`) often precedes the real title line. Falls back to a timestamp.
 */
export function scriptName(source: string): string {
  const nodes = topLevelChildren(source);
  const leadingComments: string[] = [];
  for (const node of nodes) {
    if (!COMMENT_TYPES.has(node.type.name)) {
      break;
    }
    leadingComments.push(source.slice(node.from, node.to));
  }

  const name = leadingComments
    .flatMap((block) => block.split('\n'))
    .map(cleanCommentLine)
    .find((line) => /[A-Za-z]{3,}/.test(line));

  return name ?? `Untitled ${new Date().toLocaleString()}`;
}

/**
 * Prepares a lenient, .song-style script for the Composer: comments out a
 * top-level `setcpm()` call (it isn't in the Composer's SCOPE — a live call
 * would throw on every keystroke) and returns its cycles-per-minute converted
 * to bpm, and inserts a missing `return` before the final top-level
 * expression statement so a bare trailing pattern expression (Strudel's own
 * "last expression auto-plays" convention) works the same way here.
 */
export function prepareImportedScript(source: string): ImportedScript {
  const nodes = topLevelChildren(source);
  const edits: { from: number; to: number; replacement: string }[] = [];
  let bpm: number | undefined;

  for (const node of nodes) {
    const cpm = readSetcpmCall(node, source);
    if (cpm !== undefined) {
      bpm = cpm * 4;
      edits.push({
        from: node.from,
        to: node.to,
        replacement: `// ${source.slice(node.from, node.to)}`
      });
    }
  }

  const last = findLastMeaningfulNode(nodes);
  if (last?.type.name === 'ExpressionStatement' && !edits.some((edit) => edit.from === last.from)) {
    edits.push({ from: last.from, to: last.from, replacement: 'return ' });
  }

  edits.sort((a, b) => b.from - a.from);
  let code = source;
  for (const edit of edits) {
    code = code.slice(0, edit.from) + edit.replacement + code.slice(edit.to);
  }

  return { code, bpm, name: scriptName(source) };
}

/**
 * Scans a compiled pattern over a capped cycle window and reports every
 * distinct (sampleName, bank) an event references that isn't currently
 * registered — getSampleBuffer()'s own failure mode is a console warning and
 * silence, so an imported script missing its samples would otherwise just
 * play quiet with no visible explanation.
 */
export function findUnregisteredSamples(
  pattern: QueryablePattern,
  cycles = 16
): UnregisteredSample[] {
  const seen = new Set<string>();
  const missing: UnregisteredSample[] = [];

  for (let cycle = 0; cycle < cycles; cycle++) {
    const span = { begin: new Fraction(cycle), end: new Fraction(cycle + 1) };
    for (const hap of pattern.query(span).filter(hasOnset)) {
      const { sampleName, sampleBank: bank } = hap.value;
      if (!sampleName) {
        continue;
      }
      const key = bank ? `${bank}_${sampleName}` : sampleName;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (!isSampleRegistered(sampleName, bank)) {
        missing.push({ name: sampleName, bank });
      }
    }
  }

  return missing;
}
