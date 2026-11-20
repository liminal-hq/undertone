// The syntax colours and editor chrome for a live example's CodeMirror editor, light and dark
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** The kinds of token the editor colours; each one is a `cm-live-<name>` class. */
export const tokenNames = [
  'comment',
  'string',
  'number',
  'keyword',
  'function',
  'property',
  'variable',
  'type'
] as const;
export type TokenName = (typeof tokenNames)[number];

/**
 * The token colours for each VitePress theme, taken from the GitHub Light and Dark palettes the guide's
 * ordinary Shiki blocks use, so a block keeps its colours when it becomes an editor. `background` is the
 * code-block background VitePress paints behind the editor (`--vp-code-block-bg`, which is `--vp-c-bg-alt`),
 * kept here so the tests can check each colour's contrast against it.
 */
export const palette = {
  light: {
    background: '#f6f6f7',
    comment: '#59636e',
    string: '#0a3069',
    number: '#0550ae',
    keyword: '#cf222e',
    function: '#6639ba',
    property: '#0550ae',
    variable: '#953800',
    type: '#953800'
  },
  dark: {
    background: '#161618',
    comment: '#8b949e',
    string: '#a5d6ff',
    number: '#79c0ff',
    keyword: '#ff7b72',
    function: '#d2a8ff',
    property: '#79c0ff',
    variable: '#ffa657',
    type: '#ffa657'
  }
} as const;

/** Maps the JavaScript grammar's tags onto the token classes above. */
export const liveHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'cm-live-comment' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'cm-live-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'cm-live-number' },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword
    ],
    class: 'cm-live-keyword'
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'cm-live-function'
  },
  { tag: tags.propertyName, class: 'cm-live-property' },
  { tag: [tags.definition(tags.variableName), tags.self], class: 'cm-live-variable' },
  { tag: [tags.typeName, tags.className], class: 'cm-live-type' }
]);

type ColourSpec = Record<string, { color: string }>;

function colours(mode: 'light' | 'dark', prefix = ''): ColourSpec {
  const spec: ColourSpec = {};
  for (const name of tokenNames) spec[`${prefix}.cm-live-${name}`] = { color: palette[mode][name] };
  return spec;
}

/**
 * Editor chrome and token colours. The colours follow the page's theme through VitePress's `html.dark`
 * class (not CodeMirror's own dark flag), so a reader flipping the site theme restyles a mounted editor
 * with no reconfiguration. Everything else uses VitePress's own variables, as the old text area did.
 */
export const liveEditorTheme = EditorView.baseTheme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--vp-c-text-1)',
    fontFamily: 'var(--vp-font-family-mono)',
    fontSize: 'var(--vp-code-font-size)'
  },
  '&.cm-focused': { outline: '2px solid var(--vp-c-brand-1)', outlineOffset: '-2px' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'var(--vp-code-line-height)',
    overflow: 'auto'
  },
  '.cm-content': { padding: '12px 16px', caretColor: 'var(--vp-c-text-1)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vp-c-text-1)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(100, 108, 255, 0.18)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'rgba(100, 108, 255, 0.32)'
  },
  '.cm-matchingBracket': { backgroundColor: 'rgba(100, 108, 255, 0.25)', outline: 'none' },
  ...colours('light'),
  ...colours('dark', 'html.dark & ')
});
