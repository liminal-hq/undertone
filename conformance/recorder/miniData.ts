// Layer 1 `mini` group: the mini-notation parser's constructs, its leaf rules, and its errors
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { caseMaker } from './caseMaker';
import type { ProgramCase, SpanText } from './programs';

/** Six spans per case: cycles 0 to 4, then 0 to 1, 1 to 2, 2 to 3, 3 to 4, then 1/3 to 7/4. */
export const MINI_SPANS: readonly SpanText[] = [
  ['0', '4'],
  ['0', '1'],
  ['1', '2'],
  ['2', '3'],
  ['3', '4'],
  ['1/3', '7/4']
];

type Entry = [source: string, from: string];

const T = 'src/mini.test.ts';
const P = 'src/pattern.test.ts';
const G = (family: string) => `generated: ${family}`;

/**
 * Every case is `["mini", source, leafRule]`, recorded over `MINI_SPANS`. A source that the parser
 * rejects records the reference's message word for word (position in UTF-16 code units, source quoted).
 * Stems name the sub-area so a runner can report by it: seq, rest, weight, repeat, fast, slow, group,
 * alt, stack, euclid, mix, leaf-number, leaf-pitch, leaf-drum, space, and err-* for the errors.
 */
export function miniCases(): ProgramCase[] {
  const make = caseMaker('mini');
  const out: ProgramCase[] = [];
  const add = (stem: string, rule: string, entries: readonly Entry[]) => {
    for (const [source, from] of entries) {
      out.push(make(stem, from, [['mini', source, rule]], MINI_SPANS));
    }
  };

  // generated: sequences of one to nine words, so every slot width from 1 to 1/9 is exercised.
  add(
    'seq',
    'word',
    [
      'a',
      'a b',
      'a b c',
      'a b c d',
      'a b c d e',
      'a b c d e f',
      'a b c d e f g',
      'a b c d e f g h',
      'a b c d e f g h i'
    ].map((source): Entry => [
      source,
      source === 'a b c' ? `${P}: divides the cycle equally` : G('sequences of one to nine words')
    ])
  );
  add('seq', 'word', [
    ['a  b\tc\nd', G('any run of whitespace separates words')],
    ['  a b  ', G('leading and trailing whitespace')],
    ['a-b a_b a.b a#', G('word characters: hyphen, underscore, dot, hash')],
    ['a . b', G('a lone dot is a word')],
    ['~a', G('a rest touching a word makes two steps')],
    ['a~b', G('a rest inside a run of letters splits it')],
    ['A B C', G('case is kept')]
  ]);

  add('rest', 'word', [
    ['~', G('a lone rest')],
    ['~ ~', G('two rests')],
    ['a ~ b', `${T}: treats ~ as a rest`],
    ['~ a', G('rest first')],
    ['a ~', G('rest last')],
    ['[~ a]*2', G('rest inside a group')],
    ['~*2 a', G('a rest with a speed')],
    ['~@3 a', G('a rest with a weight')],
    ['~!2 a', G('a rest repeated')],
    ['<~ a>', G('a rest inside an alternation')],
    ['~(3,8)', G('a rest with euclid')],
    ['[~ ~] a', G('an all-rest group')]
  ]);

  add('weight', 'word', [
    ['a@3 b', `${T}: replicates with ! and elongates with @`],
    ['a b@2 c', P + ': divides the cycle by weight'],
    ['a@1.5 b', G('a fractional weight')],
    ['a@0.5 b', G('a weight below one')],
    ['a@2 b@2', G('equal weights')],
    ['a@3', G('a weight on its own does not change the cycle')],
    ['[a b]@2 c', G('a weight on a group')],
    ['a@10 b', G('a large weight')],
    ['a@0.25 b@0.75', G('weights that sum to one')],
    ['a@2@3 b', G('the last weight wins')],
    ['a@2!2 b', G('a weight and a repeat')],
    ['a@2*2 b', G('a weight and a speed')],
    ['a@0.1 b@0.2 c@0.3', G('weights with thirds')]
  ]);

  add('repeat', 'word', [
    ['a!3 b', `${T}: replicates with ! and elongates with @`],
    ['a!1 b', G('a repeat of one')],
    ['a!2 b!2', G('two repeats')],
    ['[a b]!2', G('a repeated group')],
    ['<a b>!2', G('a repeated alternation')],
    ['a*2!2', G('a speed then a repeat')],
    ['a!2!3', G('the last count wins')],
    ['a!10', G('ten copies fill the cycle')],
    ['a!2 ~ b!3', G('repeats around a rest')],
    ['a!3@2 b', G('a repeat then a weight')]
  ]);

  add('fast', 'word', [
    ['a*2', `${T}: speeds up with * and slows down with /`],
    ['a*2 b', `${T}: speeds up with * and slows down with /`],
    ['a*3 b', G('speed three')],
    ['a*1.5', G('a fractional speed')],
    ['a*0.5', G('a speed below one is a slowdown')],
    ['a*2.25', G('a decimal speed')],
    ['a*4*2', G('two speeds')],
    ['a*1', G('a speed of one')],
    ['a*100', G('a large speed')],
    ['[a b]*2', G('a group sped up')],
    ['[a b c]*1.5', G('a group sped up by a fraction')],
    ['<a b>*2', `${T}: applies postfix modifiers to a whole <> group`],
    ['<a b c>*3', G('an alternation sped up by its length')],
    ['a*2/3', G('a speed then a slowdown')],
    ['a*3.0', G('a trailing zero decimal')],
    ['a*007', G('leading zeros')]
  ]);

  add('slow', 'word', [
    ['a/2', `${T}: speeds up with * and slows down with /`],
    ['a/2 b', `${T}: speeds up with * and slows down with /`],
    ['a/3 b', G('slow three')],
    ['a/1.5', G('a fractional slowdown')],
    ['a/0.5', G('a slowdown below one is a speed-up')],
    ['a/4', G('slow four')],
    ['[a b]/2', G('a group slowed down')],
    ['[a b c d]/2 e', G('a group slowed down beside a step')],
    ['<a b>/2', G('an alternation slowed down')],
    ['a/2*2', G('a slowdown then a speed')],
    ['a/1', G('a slowdown of one')],
    ['a/16', G('a long slowdown')],
    ['a b/2', G('a slowdown on the second step')]
  ]);

  add('group', 'word', [
    ['[a]', G('a one-step group')],
    ['[a b]', G('a two-step group')],
    ['a [b c]', P + ': nests, subdividing the parent slot'],
    ['[a b] c', G('a group first')],
    ['[a [b c]]', G('a group inside a group')],
    ['[[a b] c]', G('a group at the start of a group')],
    ['[[[a]]]', G('deep nesting')],
    ['[a b] [c d e]', G('two groups')],
    ['[a [b [c d]]]', G('right-nested groups')],
    ['[a b c] [d e]', G('unequal groups')],
    ['[a ~] [~ b]', G('groups with rests')],
    ['a [b [c [d e]]] f', G('nesting in a sequence')]
  ]);

  add('alt', 'word', [
    ['<a>', G('a one-child alternation')],
    ['<a b>', P + ': plays one pattern per cycle in rotation'],
    ['<a b c>', P + ': plays one pattern per cycle in rotation'],
    ['a <b c>', P + ': unfolds nested alternations one step per visit (a b a c)'],
    ['<a b> c', G('an alternation then a step')],
    ['<a [b c]>', G('a group inside an alternation')],
    ['<a ~>', G('a rest inside an alternation')],
    ['<a <b c>>', G('an alternation inside an alternation')],
    ['<a b c d e>', G('five children across five cycles')],
    ['<a b>*2', `${T}: applies postfix modifiers to a whole <> group`],
    ['<a b>/2', G('a slow alternation')],
    ['<a!2 b>', G('a repeat inside an alternation')],
    ['<a*2 b>', G('a speed on a child')],
    ['<a b>(3,8)', G('euclid on an alternation')],
    ['<[a b] c>', G('a group first')],
    ['<a b> <c d e>', G('two alternations of different lengths')],
    ['<a b>@3 c', G('a weight on an alternation')],
    ['<<a b> c>', G('nested alternations')],
    ['<a b c>!2', G('a repeated alternation')],
    ['<a b>!2 c', G('a repeated alternation beside a step')]
  ]);

  add('stack', 'word', [
    ['a,b', G('two layers without spaces')],
    ['a b, c', P + ': plays all patterns at once'],
    ['a, b c, d e f', P + ': plays all patterns at once'],
    ['[a,b] c', G('a stack in a group')],
    ['[a b, c]', G('a stack of unequal layers in a group')],
    ['[a,b]*2', G('a stack sped up')],
    ['[a, b, c]', G('three layers')],
    ['a b, [c d]', G('a layer with a group')],
    ['[a,b] [c,d]', G('two stacks')],
    ['<a b>, c', G('an alternation layer')],
    ['a ~, ~ b', G('rests in layers')],
    ['a,b,c,d', G('four layers')]
  ]);

  add('euclid', 'word', [
    ['a(3,8)', 'src/pattern.test.ts: produces the canonical euclidean necklaces'],
    ['a(3,8,2)', `${T}: parses euclidean shorthand with optional rotation`],
    ['a(5,8)', G('five of eight')],
    ['a(0,8)', G('no pulses')],
    ['a(8,8)', G('every step')],
    ['a(1,4)', G('one of four')],
    ['a(2,5)', G('two of five')],
    ['a(7,16)', G('seven of sixteen')],
    ['a(3,4,1)', G('a rotation of one')],
    ['a(3,8,-1)', G('a negative rotation')],
    ['a(3,8,10)', G('a rotation beyond the steps')],
    ['a(9,8)', G('more pulses than steps')],
    ['a(3,0)', G('no steps')],
    ['a(-1,8)', G('a negative pulse count')],
    ['a(3,-8)', G('a negative step count')],
    ['a(3,8)*2', G('euclid then a speed')],
    ['a(3,8)/2', G('euclid then a slowdown')],
    ['a(3,8) b', G('euclid beside a step')],
    ['[a b](3,8)', G('euclid on a group')],
    ['a(3,8)(2,4)', G('chained euclid')],
    ['a(3,8)@2 b', G('euclid with a weight')],
    ['a(3,8)!2', G('euclid with a repeat')],
    ['a(03,008)', G('leading zeros in the arguments')],
    ['a(4,8) b(3,8)', G('euclid on two steps')],
    ['a(4,12,3)', G('twelve steps rotated')],
    ['a(13,24)', G('a long necklace')]
  ]);

  add('mix', 'word', [
    ['a [b c]*2 <d e> f(3,8)', 'src/mini.ts: the documented example shape'],
    ['a b@2 [c d]!2 <e f>', G('every kind of step')],
    ['[a b, c d e]*2 f', G('a stack of unequal layers with a speed')],
    ['<a b>*2 c(3,8)', G('an alternation and euclid')],
    ['a*2 b/2 c@3 d!2', G('every postfix once')],
    ['<[a b]*2 c>(3,8)', G('modifiers on children and the group')],
    ['[a b]*2/3', G('speed then slowdown on a group')],
    ['a(3,8)*2@2 b', G('euclid, speed, and weight')],
    ['<a b>!2 <c d e>', G('two alternations with a repeat')],
    ['[a [b c]!2]@3 d', G('nested repeat with a weight')],
    ['a(3,8,2)!2 b', G('euclid with a rotation and a repeat')],
    ['[<a b> c]*2', G('an alternation inside a sped-up group')],
    ['<a b>*1.5', G('a fractional speed on an alternation')],
    ['a b c d e f g h i j k l', G('a long sequence')],
    ['[a b c]*5 [d e]*3', G('odd speeds')]
  ]);

  add('leaf-number', 'number', [
    ['1 2 3', G('integers')],
    ['-1 0 1', G('negatives')],
    ['0.5 .5 1.', G('decimals: Number() accepts a leading or trailing dot')],
    ['1e3 0x10 0b11', G('Number() accepts exponent, hex and binary words')],
    ['abc', G('a word that is not a number is NaN')],
    ['-', G('a lone hyphen is NaN')],
    ['--1', G('a double hyphen is NaN')],
    ['1_000', G('an underscore makes NaN')],
    ['<0 1>*2 ~', G('numbers in an alternation')],
    ['0.1 0.2 0.3', G('floats print as JavaScript prints them')],
    ['1.0 1.50', G('trailing zeros')],
    ['00 01', G('leading zeros')],
    ['9007199254740993 123456789012345678901', G('integers beyond 2^53')],
    ['0.1*3 0.7', G('a number with a speed')]
  ]);

  add('leaf-pitch', 'pitch', [
    ['c3 e3 g3', `src/control.test.ts: parses mini-notation into multiple pitched events`],
    ['C3 Eb3 F#3 Bb2', G('case, flats, and sharps')],
    ['c-1 c0 c10', G('octaves at the edges')],
    ['440 220.5 1', G('raw Hz numbers')],
    ['00440 0.5', G('Hz with leading zeros and a fraction below one')],
    ['c3*2 [e3 g3]', G('pitches with modifiers')],
    ['cb3 e#3 b#3', G('enharmonic spellings')],
    ['a1 [a1 a2] c2 <e2 g1>', 'docs/recipes.md: acid'],
    ['<a1 f1 c2 g1>(3,8)', 'docs/recipes.md: bass'],
    ['c4,e4,g4', G('a chord of pitches')],
    ['a4 a4 a4 a4 a4 a4 a4 a4', G('A4 is exactly 440')],
    ['c#-1', G('a sharp in octave minus one')]
  ]);

  add('leaf-drum', 'drum', [
    ['bd sd hh', G('sample names')],
    ['bd*2 sd', G('sample names with speed')],
    ['white ~ pink(3,8)', 'src/control.test.ts: parses mini-notation of sound types'],
    ['sine bd', G('a synth type beside a sample name')],
    ['gm_acoustic_bass', G('a long sample name with underscores')],
    ['bd sd:2', G('a colon is not a word character')],
    ['bd . sd', G('a lone dot is a sample name')],
    ['<bd sd>(3,8) [hh hh]', G('sample names with groups')],
    ['sine triangle square sawtooth halfsine abssine', G('synth types')],
    ['bd:3', G('a sample number after a colon')]
  ]);

  add('space', 'word', [
    ['a b', G('a no-break space separates words (\\s)')],
    ['a　b', G('an ideographic space separates words')],
    ['﻿a b', G('a byte order mark counts as whitespace in JavaScript')],
    ['a b c', G('line and paragraph separators')],
    ['a b c', G('em and thin spaces')],
    ['a​b', G('a zero-width space is not whitespace')],
    ['a᠎b', G('the Mongolian vowel separator is not whitespace')],
    ['a\u0085b', G('next line (U+0085) is not whitespace to \\s')],
    ['  a', G('leading no-break spaces')]
  ]);

  // Errors: the message and the position are the reference's, recorded word for word.
  add('err-empty', 'word', [
    ['', `${T}: reports errors with their position in the source`],
    ['   ', G('only whitespace')],
    ['\n\t', G('only whitespace of other kinds')],
    [' ', G('only a no-break space')]
  ]);
  add('err-token', 'word', [
    ['a?', G('? is not mini-notation here')],
    ['a? b', G('? degradation is not supported')],
    ['a|b', G('| is not a symbol')],
    ['a:b', G('a colon')],
    ['a$', G('a dollar sign')],
    ['"a"', G('double quotes')],
    ["a'b", G('an apostrophe')],
    ['{a b}', G('curly braces')],
    ['a %4', G('a percent sign')],
    ['a + b', G('a plus sign')],
    ['a=b', G('an equals sign')],
    ['a\\b', G('a backslash')],
    ['a;b', G('a semicolon')],
    ['a&b', G('an ampersand')],
    ['a^b', G('a caret')],
    ['a`b', G('a backtick')],
    ['a b c d e @', G('a late stray symbol: still a parse error, not a token error')],
    ['a  "', G('a quote after extra spaces')],
    ['é', G('a precomposed accent is not a word character')],
    ['café', G('a combining acute accent after ASCII letters')],
    ['é a', G('a combining mark: the error is at the mark, position 1')],
    ['a ́', G('a combining mark after a space')],
    ['à́̂', G('stacked combining marks: only the first is reported')],
    ['ａ', G('a fullwidth letter')],
    ['١ ٢', G('Arabic-Indic digits')],
    ['a\u0000b', G('a NUL character')],
    ['a\u007fb', G('a DEL character')],
    [' 　é', G('the position counts the unicode spaces before it')],
    ['a️b', G('a variation selector')],
    ['日本語', G('CJK ideographs')],
    ['a/½', G('a vulgar fraction after a slash')]
  ]);
  add('err-astral', 'word', [
    [
      'a 😀',
      G(
        'an emoji: the position is a UTF-16 code unit offset (2), and the message holds a lone high surrogate'
      )
    ],
    ['😀 a', G('an emoji first: position 0')],
    ['a😀b', G('an emoji inside a word')],
    ['  😀', G('two no-break spaces before an emoji: position 2')],
    ['a b c 🥁', G('a drum emoji after three words: position 6')],
    ['[a b] 🎵', G('a note emoji after a group')],
    ['𝒜 b', G('a mathematical script capital A (non-BMP letter)')],
    ['\ud800 a', G('a lone high surrogate in the source')],
    ['a \udc00', G('a lone low surrogate in the source')],
    ['a\ud83d', G('a trailing lone high surrogate')],
    ['👨‍👩‍👧', G('a family emoji with joiners')],
    ['a 🇫🇷', G('a flag: two regional indicators')],
    ['a　　😀😀', G('two emoji: only the first is reported, position 3')],
    ['😀', G('an emoji alone')],
    ['\u{10ffff}', G('the last code point')]
  ]);
  add('err-parse', 'word', [
    ['[a', G('an unclosed group')],
    ['a]', G('a stray closing bracket')],
    ['[]', G('an empty group')],
    ['[ ]', G('an empty group with a space')],
    ['<>', G('an empty alternation')],
    ['<a b', G('an unclosed alternation')],
    ['a b>', G('a stray closing angle')],
    ['<a b]', G('mismatched closers')],
    ['[a b>', G('mismatched closers the other way')],
    ['<a, b>', G('a comma inside an alternation')],
    ['<a b, c d>', G('a stack inside an alternation')],
    ['a,', G('a trailing comma')],
    [',a', G('a leading comma')],
    ['a,,b', G('a double comma')],
    ['[a,]', G('a trailing comma in a group')],
    ['*2', G('a modifier first')],
    ['a **2', G('a double star')],
    ['a*', G('a star with nothing after')],
    ['a* 2', G('a star then a space then a number is still a number')],
    ['a*b', G('a star then a word')],
    ['a*[b]', G('a star then a group')],
    ['a*<2 3>', G('a patterned speed is not supported')],
    ['a/', G('a slash with nothing after')],
    ['a/x', G('a slash then a word')],
    ['a!', G('a bang with nothing after')],
    ['a!0', G('a count of zero')],
    ['a!-1', G('a negative count')],
    ['a!1.5', G('a fractional count')],
    ['a!x', G('a count that is a word')],
    ['a@', G('an at with nothing after')],
    ['a@0', G('a zero weight')],
    ['a@-1', G('a negative weight')],
    ['a@x', G('a weight that is a word')],
    ['<a@2 b>', G('a weight inside an alternation')],
    ['<a b@3>', G('a weight on a later child')],
    ['a*0', `${T}: wraps combinator errors with the modifier position`],
    ['a*-1', G('a negative speed')],
    ['a/0', G('a zero slowdown')],
    ['a/-2', G('a negative slowdown')],
    ['a b*0', G('a zero speed on a later step: the position is the star')],
    ['a*1e3', `${T}: rejects hex/exponent notation instead of silently coercing it`],
    ['a*0x10', `${T}: rejects hex/exponent notation instead of silently coercing it`],
    ['a*.5', G('a leading dot is not strict decimal syntax')],
    ['a*5.', G('a trailing dot is not strict decimal syntax')],
    ['a*+2', G('a plus sign')],
    ['a*1_0', G('an underscore in a number')],
    ['a*Infinity', G('the word Infinity')],
    ['a*NaN', G('the word NaN')],
    ['a*-', G('a lone hyphen')],
    ['a*2.2.2', G('two dots')],
    ['a(3)', G('euclid with one argument')],
    ['a(3,8', G('euclid without a closing paren')],
    ['a(3,8,)', G('euclid with an empty rotation')],
    ['a()', G('empty euclid')],
    ['a(,8)', G('euclid with an empty pulse count')],
    ['a(3.5,8)', G('a fractional pulse count')],
    ['a(3,8.5)', G('a fractional step count')],
    ['a(3,8,1.5)', G('a fractional rotation')],
    ['a(x,8)', G('a word as the pulse count')],
    ['a(<3 5>,8)', G('patterned euclid arguments are not supported')],
    ['a(3,[4 8])', G('a group as the step count')],
    ['a(3 8)', G('euclid arguments separated by a space')],
    ['a(3,8,2,1)', G('four euclid arguments')],
    ['a(3,8))', G('a doubled closing paren')],
    ['(3,8)', G('euclid with no step')],
    ['a)', G('a stray closing paren')],
    ['a(', G('an open paren at the end')],
    ['(', G('a lone open paren')],
    ['[', G('a lone open bracket')],
    ['<', G('a lone open angle')],
    ['@', G('a lone at')],
    ['!', G('a lone bang')],
    ['/', G('a lone slash')],
    [',', G('a lone comma')],
    ['a b c d (3,8)', G('euclid after a space has nothing to apply to')],
    ['a ~*', G('a rest with a bare star')],
    ['a [b c', G('an unclosed group after steps')],
    ['[a [b c]', G('an unclosed outer group')],
    ['<a <b c>', G('an unclosed outer alternation')],
    ['a b c, ', G('a trailing comma with a space')]
  ]);
  add('err-leaf', 'pitch', [
    ['h3', 'src/control.test.ts: rejects invalid notes eagerly, at build time'],
    ['c4 h9', 'src/control.test.ts: rejects invalid notes eagerly, at build time'],
    ['c3 e3 zz', G('a bad pitch after two good ones: the position is the word')],
    ['[c3 e3] [g3 h3]', G('a bad pitch inside a second group')],
    ['c', G('a note name without an octave')],
    ['c3 e', G('a note name without an octave, later')],
    ['0', G('zero Hz')],
    ['440 0.0', G('zero Hz as a decimal')],
    ['1e3', G('an exponent is not a note and not Hz')],
    ['-5', G('a negative number is not Hz')],
    ['c##3', G('a double sharp')],
    ['cbb3', G('a double flat')],
    ['c3 é', G('a non-ASCII letter is a token error before any leaf error')],
    ['  h3', G('a bad pitch after no-break spaces: position 2')],
    ['c3*h', G('a bad speed beats nothing: the speed is a number error')],
    ['h3*2', G('a bad pitch with a modifier after')],
    ['x(3,8)', G('a bad pitch with euclid')],
    ['H3', G('an uppercase letter outside A to G')],
    ['c3.5', G('a dot makes a bad note name')]
  ]);
  return out;
}
