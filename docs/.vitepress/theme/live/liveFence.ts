// A markdown-it plugin that turns a ```ts live, ```ts play or ```mini fence into an editable, playable example, and puts the rendered-audio player under a ```ts standalone audio=NAME fence
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { MarkdownRenderer } from 'vitepress';
import { audioName } from './audioFence';
import type { ExampleKind } from './fragment';

/** True when a fence's info string is `ts live` (the language, then the word `live`). */
export function isLiveFence(info: string): boolean {
  return /^ts\s+live\s*$/.test(info.trim());
}

/**
 * Which kind of player a fence's info string asks for: `ts live` (code that runs as written), `ts play` (a
 * fragment the player wraps) or `mini` (a bare mini-notation string), or undefined for any other fence.
 */
export function fenceKind(info: string): ExampleKind | undefined {
  const trimmed = info.trim();
  if (/^ts\s+live$/.test(trimmed)) return 'live';
  if (/^ts\s+play$/.test(trimmed)) return 'play';
  if (trimmed === 'mini') return 'mini';
  return undefined;
}

/**
 * Wraps each `ts live`, `ts play` and `mini` fence in `<LiveExample kind="..." :code="...">`. The fence's normally rendered, highlighted
 * block is the component's default slot, so with scripts off (or during the static build) the reader
 * sees the same highlighted code every other block shows; the component swaps in the editor once it is
 * mounted in a browser. The code travels as an escaped JavaScript string literal in the attribute.
 */
export function liveFencePlugin(md: MarkdownRenderer): void {
  const original = md.renderer.rules.fence;
  if (!original) throw new Error('liveFencePlugin needs the default fence rule');
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    // A `ts standalone audio=NAME` block stays the plain highlighted block, with the rendered audio's player under it.
    const audio = audioName(token.info);
    if (audio) {
      return `${original(tokens, idx, options, env, self)}<TsAudio name="${audio}" />\n`;
    }
    const kind = fenceKind(token.info);
    if (!kind) return original(tokens, idx, options, env, self);
    // `mini` is not a language the highlighter knows, so it is shown as plain text.
    const info = token.info;
    if (kind === 'mini') token.info = 'text';
    const rendered = original(tokens, idx, options, env, self);
    token.info = info;
    const literal = JSON.stringify(token.content.replace(/\n+$/, ''));
    return `<LiveExample kind="${kind}" :code="${md.utils.escapeHtml(literal)}">${rendered}</LiveExample>\n`;
  };
}
