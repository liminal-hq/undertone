// Tests that the live editor colours JavaScript tokens, and that every colour is readable in both themes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { javascript } from '@codemirror/lang-javascript';
import { highlightTree } from '@lezer/highlight';
import { highlightsAsScript } from './liveEditor';
import { liveHighlightStyle, palette, tokenNames } from './editorTheme';

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The token class applied to each highlighted piece of `code`, keyed by the text it covers. */
function classesFor(code: string): Map<string, string> {
  const tree = javascript({ typescript: true }).language.parser.parse(code);
  const found = new Map<string, string>();
  highlightTree(tree, liveHighlightStyle, (from, to, classes) => {
    found.set(code.slice(from, to), classes);
  });
  return found;
}

describe('live editor colours', () => {
  it.each(['light', 'dark'] as const)(
    'keeps every %s token at WCAG AA contrast (4.5:1) on the code background',
    (mode) => {
      for (const name of tokenNames) {
        const ratio = contrast(palette[mode][name], palette[mode].background);
        expect(ratio, `${mode} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it('colours comments, strings, numbers, keywords and calls differently from plain text', () => {
    const found = classesFor('// a comment\nconst x = f("hi", 0.5, true);\n');
    expect(found.get('// a comment')).toContain('cm-live-comment');
    expect(found.get('"hi"')).toContain('cm-live-string');
    expect(found.get('0.5')).toContain('cm-live-number');
    expect(found.get('true')).toContain('cm-live-number');
    expect(found.get('const')).toContain('cm-live-keyword');
    expect(found.get('x')).toContain('cm-live-variable');
    expect(found.get('f')).toContain('cm-live-function');
  });

  it('colours a method call and the property it is read from', () => {
    const found = classesFor('note("c4").lpf(800);');
    expect(found.get('lpf')).toContain('cm-live-function');
  });

  it('highlights `ts live` and `ts play` as JavaScript but leaves `mini` as plain text', () => {
    expect(highlightsAsScript('live')).toBe(true);
    expect(highlightsAsScript('play')).toBe(true);
    expect(highlightsAsScript('mini')).toBe(false);
  });
});
