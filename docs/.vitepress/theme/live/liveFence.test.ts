// Tests that the ts live, ts play and mini fences become a LiveExample and every other fence is left alone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type { MarkdownRenderer } from 'vitepress';
import { fenceKind, isLiveFence, liveFencePlugin } from './liveFence';

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
      /^<LiveExample kind="live" :code="&quot;note\(\\&quot;c4\\&quot;\)\.play\(\);&quot;">/
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

  it('names the kind of player a fence asks for', () => {
    expect(fenceKind('ts live')).toBe('live');
    expect(fenceKind('ts  play ')).toBe('play');
    expect(fenceKind('mini')).toBe('mini');
    expect(fenceKind('ts standalone')).toBeUndefined();
    expect(fenceKind('ts')).toBeUndefined();
    expect(fenceKind('mini extra')).toBeUndefined();
    expect(fenceKind('ts play extra')).toBeUndefined();
  });

  it('wraps a play fence and a mini fence with their kind, and leaves the original code intact', () => {
    const play = render('```ts play\nnote("c4")\n```\n');
    expect(play).toMatch(/^<LiveExample kind="play" :code=/);
    expect(play).toContain('<pre><code class="language-ts">');
    const mini = render('```mini\nbd*2 sd\n```\n');
    expect(mini).toMatch(/^<LiveExample kind="mini" :code="&quot;bd\*2 sd&quot;">/);
    expect(mini).toContain('</LiveExample>');
  });
});
