// Tests that the ts live, ts play and mini fences become a LiveExample and every other fence is left alone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type { MarkdownRenderer } from 'vitepress';
import { audioName, extractAudioBlocks } from './audioFence';
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

describe('the audio marker on a standalone fence', () => {
  it('reads the name from `ts standalone audio=NAME` and nothing else', () => {
    expect(audioName('ts standalone audio=recipes-render-wav')).toBe('recipes-render-wav');
    expect(audioName('ts  standalone   audio=a1 ')).toBe('a1');
    expect(audioName('ts standalone')).toBeUndefined();
    expect(audioName('ts live audio=x')).toBeUndefined();
    expect(audioName('ts audio=x')).toBeUndefined();
    expect(audioName('ts standalone audio=')).toBeUndefined();
    expect(audioName('ts standalone audio=Bad_Name')).toBeUndefined();
    expect(audioName('ts standalone audio=a--b')).toBeUndefined();
    expect(audioName('ts standalone audio=a extra')).toBeUndefined();
  });

  it('keeps the highlighted block and adds the player under it', () => {
    const html = render('```ts standalone audio=my-clip\nnote("c4");\n```\n');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).not.toContain('LiveExample');
    expect(html).toMatch(/<\/pre>\s*<TsAudio name="my-clip" \/>\n$/);
    expect(render('```ts standalone\nx\n```\n')).not.toContain('TsAudio');
  });

  it('does not turn a fence that is not a ts standalone block into a player', () => {
    expect(render('```ts live audio=x\nx\n```\n')).not.toContain('TsAudio');
    expect(render('```text\nts standalone audio=x\n```\n')).not.toContain('TsAudio');
  });
});

describe('extractAudioBlocks', () => {
  const page = [
    '# Page',
    '',
    '```ts standalone audio=first',
    'const a = 1;',
    '```',
    '',
    '```ts standalone',
    'unmarked();',
    '```',
    '',
    '```ts live',
    'live();',
    '```',
    '',
    '```ts standalone audio=second',
    'one();',
    '',
    'two();',
    '```',
    ''
  ].join('\n');

  it('returns the marked blocks in page order with the line of their first line of code', () => {
    expect(extractAudioBlocks(page, 'docs/p.md')).toEqual([
      { name: 'first', page: 'docs/p.md', line: 4, code: 'const a = 1;' },
      { name: 'second', page: 'docs/p.md', line: 16, code: 'one();\n\ntwo();' }
    ]);
  });

  it('skips a marker that sits inside another fence', () => {
    const nested = '```text\n```ts standalone audio=hidden\n```\n';
    expect(extractAudioBlocks(nested, 'p.md')).toEqual([]);
  });

  it('returns nothing for a page without markers', () => {
    expect(extractAudioBlocks('plain\n\n```ts\nx\n```\n', 'p.md')).toEqual([]);
  });
});
