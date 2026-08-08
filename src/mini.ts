// Mini-notation parser: rhythm strings like "c3 [e3 g3]*2 <a3 b3> x(3,8)" into patterns
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Pattern, cat, silence, stack, timecat } from './pattern.js';
import { pure } from './pattern.js';

interface Token {
  readonly kind: 'word' | 'symbol';
  readonly text: string;
  readonly pos: number;
}

interface Term<T> {
  readonly pattern: Pattern<T>;
  readonly weight: number;
  readonly replicate: number;
}

const SYMBOLS = new Set(['[', ']', '<', '>', '(', ')', ',', '*', '/', '!', '@', '~']);
// '_' included for sample names (s("gm_acoustic_bass"), the .bank() lookup convention's
// "${bank}_${name}" key) — not needed by any other existing leaf vocabulary.
const WORD_CHAR = /[a-zA-Z0-9#._-]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < source.length) {
    const char = source[pos];
    if (/\s/.test(char)) {
      pos++;
    } else if (SYMBOLS.has(char)) {
      tokens.push({ kind: 'symbol', text: char, pos });
      pos++;
    } else if (WORD_CHAR.test(char)) {
      const start = pos;
      while (pos < source.length && WORD_CHAR.test(source[pos])) {
        pos++;
      }
      tokens.push({ kind: 'word', text: source.slice(start, pos), pos: start });
    } else {
      throw new Error(
        `Mini-notation error at position ${pos} in "${source}": unexpected "${char}"`
      );
    }
  }
  return tokens;
}

class Parser<T> {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
    private readonly leaf: (word: string) => T
  ) {}

  private fail(message: string, pos?: number): never {
    const at = pos ?? this.tokens[this.index]?.pos ?? this.source.length;
    throw new Error(`Mini-notation error at position ${at} in "${this.source}": ${message}`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) {
      this.fail('unexpected end of pattern');
    }
    this.index++;
    return token;
  }

  private peekSymbol(text: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'symbol' && token.text === text;
  }

  private expectSymbol(text: string): void {
    const token = this.next();
    if (token.kind !== 'symbol' || token.text !== text) {
      this.fail(`expected "${text}" but found "${token.text}"`, token.pos);
    }
  }

  expectEnd(): void {
    const token = this.peek();
    if (token) {
      this.fail(`unexpected "${token.text}"`, token.pos);
    }
  }

  /** A comma-separated list of sequences played simultaneously (chords/layers). */
  parseStack(closer?: string): Pattern<T> {
    const sequences = [this.parseSequence(closer)];
    while (this.peekSymbol(',')) {
      this.next();
      sequences.push(this.parseSequence(closer));
    }
    return sequences.length === 1 ? sequences[0] : stack(...sequences);
  }

  private atSequenceEnd(closer?: string): boolean {
    const token = this.peek();
    if (!token) {
      return true;
    }
    return token.kind === 'symbol' && (token.text === ',' || token.text === closer);
  }

  private parseSequence(closer?: string): Pattern<T> {
    const terms: Term<T>[] = [];
    while (!this.atSequenceEnd(closer)) {
      terms.push(this.parseTerm());
    }
    if (terms.length === 0) {
      this.fail('expected at least one element');
    }
    const expanded = terms.flatMap((term) =>
      Array.from(
        { length: term.replicate },
        () => [term.weight, term.pattern] as [number, Pattern<T>]
      )
    );
    return expanded.length === 1 ? expanded[0][1] : timecat(expanded);
  }

  /** Runs a combinator, rewrapping its error with the modifier's source position. */
  private guarded<R>(pos: number, fn: () => R): R {
    try {
      return fn();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error), pos);
    }
  }

  private parseTerm(): Term<T> {
    let pattern = this.parseAtom();
    let weight = 1;
    let replicate = 1;
    for (;;) {
      if (this.peekSymbol('*')) {
        const symbol = this.next();
        const factor = this.parseNumber('*');
        pattern = this.guarded(symbol.pos, () => pattern.fast(factor));
      } else if (this.peekSymbol('/')) {
        const symbol = this.next();
        const factor = this.parseNumber('/');
        pattern = this.guarded(symbol.pos, () => pattern.slow(factor));
      } else if (this.peekSymbol('!')) {
        this.next();
        replicate = this.parseNumber('!', { integer: true });
        if (replicate < 1) {
          this.fail('"!" count must be at least 1');
        }
      } else if (this.peekSymbol('@')) {
        this.next();
        weight = this.parseNumber('@');
        if (weight <= 0) {
          this.fail('"@" weight must be positive');
        }
      } else if (this.peekSymbol('(')) {
        const symbol = this.next();
        const pulses = this.parseNumber('euclid pulses', { integer: true });
        this.expectSymbol(',');
        const steps = this.parseNumber('euclid steps', { integer: true });
        let rotation = 0;
        if (this.peekSymbol(',')) {
          this.next();
          rotation = this.parseNumber('euclid rotation', { integer: true });
        }
        this.expectSymbol(')');
        pattern = this.guarded(symbol.pos, () => pattern.euclid(pulses, steps, rotation));
      } else {
        return { pattern, weight, replicate };
      }
    }
  }

  private parseAtom(): Pattern<T> {
    const token = this.next();
    if (token.kind === 'word') {
      try {
        return pure(this.leaf(token.text));
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error), token.pos);
      }
    }
    if (token.text === '~') {
      return silence as Pattern<T>;
    }
    if (token.text === '[') {
      const inner = this.parseStack(']');
      this.expectSymbol(']');
      return inner;
    }
    if (token.text === '<') {
      const inner = this.parseAlternation();
      this.expectSymbol('>');
      return inner;
    }
    this.fail(`unexpected "${token.text}"`, token.pos);
  }

  /** The children of <...>: one per cycle, in rotation. */
  private parseAlternation(): Pattern<T> {
    const terms: Term<T>[] = [];
    while (!this.peekSymbol('>') && this.peek()) {
      const term = this.parseTerm();
      if (term.weight !== 1) {
        this.fail('"@" weights are not supported inside <>');
      }
      terms.push(term);
    }
    if (terms.length === 0) {
      this.fail('expected at least one element inside <>');
    }
    const expanded = terms.flatMap((term) =>
      Array.from({ length: term.replicate }, () => term.pattern)
    );
    return cat(...expanded);
  }

  private parseNumber(context: string, opts: { integer?: boolean } = {}): number {
    const token = this.next();
    // Strict decimal syntax only — Number() alone would accept "0x10" or "1e3".
    const value =
      token.kind === 'word' && /^-?\d+(\.\d+)?$/.test(token.text) ? Number(token.text) : NaN;
    if (!Number.isFinite(value)) {
      this.fail(`expected a number after "${context}" but found "${token.text}"`, token.pos);
    }
    if (opts.integer && !Number.isInteger(value)) {
      this.fail(`expected an integer for "${context}" but found "${token.text}"`, token.pos);
    }
    return value;
  }
}

/**
 * Parses a mini-notation string into a Pattern, transforming each leaf word
 * with `leaf` (which should throw on invalid words — errors are reported with
 * their position in the source string).
 *
 * Supported notation: whitespace sequences, `~` rests, `[a b]` subdivision,
 * `<a b>` per-cycle alternation, `a*2` / `a/2` speed, `a!3` replication,
 * `a@3` elongation, `[a,b]` parallel stacking, and `a(3,8,rot)` euclidean
 * rhythms.
 */
export function mini<T>(source: string, leaf: (word: string) => T): Pattern<T> {
  const tokens = tokenize(source);
  if (tokens.length === 0) {
    throw new Error(`Empty mini-notation pattern: "${source}"`);
  }
  const parser = new Parser(tokens, source, leaf);
  const pattern = parser.parseStack();
  parser.expectEnd();
  return pattern;
}
