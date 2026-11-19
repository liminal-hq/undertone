// Turns a documentation fragment (a pattern expression or a bare mini-notation string) into a snippet the live runner can play
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as lib from '../../../../src/index';

/** How a documentation example is run: as written (`live`), as a pattern fragment (`play`), or as a bare mini-notation string (`mini`). */
export type ExampleKind = 'live' | 'play' | 'mini';

type TokenKind = 'ident' | 'punct' | 'string' | 'comment' | 'number';

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER_PART = /[0-9A-Za-z_.]/;

/** Index just past the closing `quote` of a string that starts at `start` (an unterminated one runs to the end). */
function skipString(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    if (code[i] === '\\') i += 2;
    else if (code[i] === quote) return i + 1;
    else i++;
  }
  return code.length;
}

/** Index just past the closing backtick of a template literal, nested `${ ... }` expressions included. */
function skipTemplate(code: string, start: number): number {
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && code[i + 1] === '{') i = skipBraces(code, i + 1);
    else i++;
  }
  return code.length;
}

/** Index just past the `}` that closes the `{` at `start`, skipping strings and templates inside. */
function skipBraces(code: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"') i = skipString(code, i);
    else if (c === '`') i = skipTemplate(code, i);
    else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i + 1;
      i++;
    }
  }
  return code.length;
}

/**
 * Splits code into identifiers, numbers, punctuation, strings (a template literal is one opaque string,
 * whatever it interpolates) and comments. It is not a parser: it knows only enough to keep names that sit
 * inside strings and comments out of the scan, and to find where a statement ends. A regular-expression
 * literal is not recognised, which the documentation's fragments never use.
 */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && code[i + 1] === '/') {
      let end = code.indexOf('\n', i);
      if (end < 0) end = code.length;
      tokens.push({ kind: 'comment', text: code.slice(i, end), start: i, end });
      i = end;
    } else if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      const end = close < 0 ? code.length : close + 2;
      tokens.push({ kind: 'comment', text: code.slice(i, end), start: i, end });
      i = end;
    } else if (c === "'" || c === '"') {
      const end = skipString(code, i);
      tokens.push({ kind: 'string', text: code.slice(i, end), start: i, end });
      i = end;
    } else if (c === '`') {
      const end = skipTemplate(code, i);
      tokens.push({ kind: 'string', text: code.slice(i, end), start: i, end });
      i = end;
    } else if (IDENT_START.test(c)) {
      let end = i + 1;
      while (end < code.length && IDENT_PART.test(code[end])) end++;
      tokens.push({ kind: 'ident', text: code.slice(i, end), start: i, end });
      i = end;
    } else if (/[0-9]/.test(c)) {
      let end = i + 1;
      while (end < code.length && NUMBER_PART.test(code[end])) end++;
      tokens.push({ kind: 'number', text: code.slice(i, end), start: i, end });
      i = end;
    } else {
      tokens.push({ kind: 'punct', text: c, start: i, end: i + 1 });
      i++;
    }
  }
  return tokens;
}

const CODE_ONLY = (token: Token): boolean => token.kind !== 'comment';

function isOwnExport(library: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(library, name);
}

/** Index of the token that closes the bracket opened at `open`, or the last token when it never closes. */
function matchingClose(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const text = tokens[i].kind === 'punct' ? tokens[i].text : '';
    if (text === '{' || text === '[' || text === '(') depth++;
    else if ((text === '}' || text === ']' || text === ')') && --depth === 0) return i;
  }
  return tokens.length - 1;
}

/**
 * The names a snippet uses that `library` exports and the snippet does not already supply: not imported
 * by its own `import` line, not declared by `const`/`let`/`var`/`function`/`class` (a destructuring
 * pattern counts every name inside it), not the property after a `.`, and not an object key. A name that
 * only shadows an export, such as an arrow function's parameter, is still listed: an unused import is
 * harmless. Sorted, so the generated import line is stable.
 */
export function neededImports(code: string, library: Record<string, unknown>): string[] {
  const tokens = tokenize(code).filter(CODE_ONLY);
  const supplied = new Set<string>();
  const used = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'ident') continue;
    if (token.text === 'import') {
      // `import { a, b } from '...'` and `import type { a } from '...'`: these names are supplied.
      let open = i + 1;
      if (tokens[open]?.text === 'type') open++;
      if (tokens[open]?.text === '{') {
        const close = matchingClose(tokens, open);
        for (let k = open + 1; k < close; k++) {
          if (tokens[k].kind === 'ident') supplied.add(tokens[k].text);
        }
        i = close;
        continue;
      }
    }
    if (['const', 'let', 'var', 'function', 'class'].includes(token.text)) {
      const next = tokens[i + 1];
      if (next?.kind === 'ident') supplied.add(next.text);
      else if (next && (next.text === '{' || next.text === '[')) {
        const close = matchingClose(tokens, i + 1);
        for (let k = i + 2; k < close; k++) {
          if (tokens[k].kind === 'ident') supplied.add(tokens[k].text);
        }
      }
      continue;
    }
    const before = tokens[i - 1];
    const beforeThat = tokens[i - 2];
    const isProperty = before?.text === '.' && beforeThat?.text !== '.';
    const after = tokens[i + 1];
    const isKey = after?.text === ':' && (before?.text === '{' || before?.text === ',');
    if (!isProperty && !isKey && isOwnExport(library, token.text)) used.add(token.text);
  }
  return [...used].filter((name) => !supplied.has(name)).sort();
}

/** The operators that mean a statement carries on over a line break when one starts or ends the line. */
const STARTS_CONTINUATION = new Set([
  '.',
  '?',
  ':',
  '&',
  '|',
  '+',
  '*',
  '/',
  '%',
  '=',
  ',',
  '<',
  '>'
]);
const ENDS_CONTINUATION = new Set([
  ',',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '?',
  ':',
  '.',
  '!',
  '<',
  '>'
]);

/** The code tokens that make up the last top-level statement, split at `;` and at line breaks that end a statement. */
function lastStatement(code: string, tokens: Token[]): Token[] {
  let statement: Token[] = [];
  let finished: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    const previous = statement[statement.length - 1];
    if (previous && depth === 0) {
      const lineBreak = code.slice(previous.end, token.start).includes('\n');
      const continues =
        STARTS_CONTINUATION.has(token.text) ||
        (previous.kind === 'punct' && ENDS_CONTINUATION.has(previous.text)) ||
        token.text === 'else';
      if (lineBreak && !continues) statement = [];
    }
    if (token.kind === 'punct') {
      if (token.text === ';' && depth === 0) {
        if (statement.length > 0) finished = statement;
        statement = [];
        continue;
      }
      if (token.text === '{' || token.text === '[' || token.text === '(') depth++;
      else if (token.text === '}' || token.text === ']' || token.text === ')') depth--;
    }
    statement.push(token);
  }
  return statement.length > 0 ? statement : finished;
}

const NOT_EXPRESSION = new Set([
  'function',
  'class',
  'if',
  'for',
  'while',
  'do',
  'switch',
  'try',
  'return',
  'throw',
  'break',
  'continue',
  'import'
]);

/** Ends the generated code: loops a pattern (or a score), accepts something already playing, and otherwise says what it got. */
const FINISH = `
if (__value && typeof __value.loop === 'function') __value.loop();
else if (!(__value && typeof __value.stop === 'function')) {
  throw new Error(
    'The last expression is ' + (__value === null ? 'null' : typeof __value) +
      ', not a pattern, so there is nothing to play. End the block with a pattern such as note("c3 e3 g3").sound("triangle").'
  );
}
`;

function wrapPattern(code: string, library: Record<string, unknown>): string {
  const source = code.replace(/^export\s+/gm, '');
  const tokens = tokenize(source).filter(CODE_ONLY);
  const statement = lastStatement(source, tokens);
  if (statement.length === 0) throw new Error('The example is empty, so there is nothing to play.');
  const first = statement[0];
  const prefix = source.slice(0, first.start);
  const text = source.slice(first.start, statement[statement.length - 1].end);
  const imports = neededImports(source, library);
  const importLine =
    imports.length > 0 ? `import { ${imports.join(', ')} } from '@liminal-hq/undertone';\n` : '';

  let body: string;
  if (first.text === 'const' || first.text === 'let' || first.text === 'var') {
    const name = statement[1];
    if (name?.kind !== 'ident' || statement[2]?.text !== '=') {
      throw new Error(
        `The example ends with a ${first.text} that destructures; end it with a pattern expression, or a name that holds one.`
      );
    }
    body = `${prefix}${text};\nconst __value = ${name.text};`;
  } else if (
    NOT_EXPRESSION.has(first.text) ||
    (first.text === 'async' && statement[1]?.text === 'function')
  ) {
    throw new Error(
      `The example ends with a ${first.text} statement, not a pattern expression, so there is nothing to play.`
    );
  } else {
    body = `${prefix}const __value = (${text}\n);`;
  }
  return `${importLine}${body}\n${FINISH}`;
}

function wrapMini(code: string): string {
  const source = code.trim();
  if (source === '') throw new Error('The example is empty, so there is nothing to play.');
  return `import { note, sound } from '@liminal-hq/undertone';
const __mini = ${JSON.stringify(source)};
let __value;
try {
  __value = note(__mini);
} catch (pitchError) {
  try {
    __value = sound(__mini);
  } catch (soundError) {
    throw new Error(
      'It is not a sequence of pitches (' + pitchError.message + ') or of built-in sounds (' + soundError.message + ').'
    );
  }
}
__value.loop();
`;
}

/**
 * The runnable snippet for an example's source. A `live` example runs as written. A `play` fragment gets
 * the imports it uses from '@liminal-hq/undertone' and its last expression (or the name its last
 * `const` declares) is evaluated; a pattern (or score) is looped, so a one-bar fragment keeps sounding
 * until Stop, and something already playing (a `.play()` or `.loop()` handle) is left alone. A `mini`
 * example is a bare mini-notation string: played as pitches through `note()` when it parses as them,
 * otherwise as built-in sounds through `sound()`. Throws a message for the reader when there is nothing
 * to play.
 */
export function wrapFragment(
  code: string,
  kind: ExampleKind,
  library: Record<string, unknown> = lib as unknown as Record<string, unknown>
): string {
  if (kind === 'live') return code;
  return kind === 'mini' ? wrapMini(code) : wrapPattern(code, library);
}
