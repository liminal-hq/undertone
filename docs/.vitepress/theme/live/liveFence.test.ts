// Tests that a ts live fence becomes a LiveExample and every other fence is left alone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type { MarkdownRenderer } from 'vitepress';
import { isLiveFence, liveFencePlugin } from './liveFence';

function render(markdown: string): string {
  const md = new MarkdownIt();
  liveFencePlugin(md as unknown as MarkdownRenderer);
  return md.render(markdown);
}

describe('liveFencePlugin', () => {
  it('recognises only the exact `ts live` info string', () => {
    expect(isLiveFence('ts live')).toBe(true);
    expect(isLiveFence('ts   live ')).toBe(true);
    expect(isLiveFence('ts standalone')).toBe(false);
    expect(isLiveFence('ts')).toBe(false);
    expect(isLiveFence('js live')).toBe(false);
    expect(isLiveFence('ts live extra')).toBe(false);
  });

  it('wraps a live fence, keeping the plain block as the fallback slot', () => {
    const html = render('```ts live\nnote("c4").play();\n```\n');
    expect(html).toMatch(
      /^<LiveExample :code="&quot;note\(\\&quot;c4\\&quot;\)\.play\(\);&quot;">/
    );
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('</LiveExample>');
  });

  it('carries the code as an escaped string literal that round-trips', () => {
    const code = 'const a = "<b>&</b>";\nconsole.log(`x ${a}`, \'q\');\n  indented';
    const html = render('```ts live\n' + code + '\n```\n');
    const attribute = /:code="([^"]*)"/.exec(html)?.[1] ?? '';
    const decoded = attribute
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toBe(code);
  });

  it('leaves standalone and plain fences unwrapped', () => {
    expect(render('```ts standalone\nx\n```\n')).not.toContain('LiveExample');
    expect(render('```ts\nx\n```\n')).not.toContain('LiveExample');
  });
});
