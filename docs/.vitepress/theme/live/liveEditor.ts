// Builds the CodeMirror editor a live example swaps in for its plain highlighted block; loaded on demand
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting
} from '@codemirror/language';
import { EditorState, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import type { ExampleKind } from './fragment';
import { liveEditorTheme, liveHighlightStyle } from './editorTheme';

export interface LiveEditorOptions {
  parent: HTMLElement;
  doc: string;
  kind: ExampleKind;
  /** The accessible name of the editing surface. */
  label: string;
  /** The id of the element that describes the keys (the hint under the editor). */
  describedBy: string;
  /** Called with the whole text after every edit. */
  onChange(text: string): void;
  /** Called on Ctrl or Cmd with Enter. */
  onPlay(): void;
}

export interface LiveEditor {
  /** Replaces the whole text (the Reset button). */
  setText(text: string): void;
  focus(): void;
  destroy(): void;
}

/**
 * Whether an example's text is JavaScript. `ts live` and `ts play` are; a `mini` fence is a mini-notation
 * string, which has no grammar here, so it stays plain text (as its fallback block is).
 */
export function highlightsAsScript(kind: ExampleKind): boolean {
  return kind !== 'mini';
}

/**
 * The editor: history, bracket matching and the default keys, Tab to indent (Escape then Tab moves focus on,
 * which CodeMirror's own tab-focus handling provides), and Ctrl or Cmd with Enter to play. It is
 * deliberately smaller than the Playground's full setup (no line numbers, folding or autocomplete).
 */
export function createLiveEditor(options: LiveEditorOptions): LiveEditor {
  const extensions: Extension[] = [
    liveEditorTheme,
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    // Ahead of the default keys, which would otherwise take Mod-Enter for "insert blank line below".
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            options.onPlay();
            return true;
          }
        }
      ])
    ),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({
      'aria-label': options.label,
      'aria-describedby': options.describedBy,
      'aria-multiline': 'true',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off'
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    })
  ];
  if (highlightsAsScript(options.kind)) {
    extensions.push(javascript({ typescript: true }), syntaxHighlighting(liveHighlightStyle));
  }
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({ doc: options.doc, extensions })
  });
  return {
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    }
  };
}
