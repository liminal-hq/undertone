// A markdown-it plugin that turns a ```ts live fence into an editable, playable example
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { MarkdownRenderer } from 'vitepress';

/** True when a fence's info string is `ts live` (the language, then the word `live`). */
export function isLiveFence(info: string): boolean {
  return /^ts\s+live\s*$/.test(info.trim());
}

/**
 * Wraps each `ts live` fence in `<LiveExample :code="...">`. The fence's normally rendered, highlighted
 * block is the component's default slot, so with scripts off (or during the static build) the reader
 * sees the same highlighted code every other block shows; the component swaps in the editor once it is
 * mounted in a browser. The code travels as an escaped JavaScript string literal in the attribute.
 */
export function liveFencePlugin(md: MarkdownRenderer): void {
  const original = md.renderer.rules.fence;
  if (!original) throw new Error('liveFencePlugin needs the default fence rule');
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const rendered = original(tokens, idx, options, env, self);
    const token = tokens[idx];
    if (!isLiveFence(token.info)) return rendered;
    const literal = JSON.stringify(token.content.replace(/\n+$/, ''));
    return `<LiveExample :code="${md.utils.escapeHtml(literal)}">${rendered}</LiveExample>\n`;
  };
}
