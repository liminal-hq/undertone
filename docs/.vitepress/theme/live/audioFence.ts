// Reads the `audio=NAME` marker on a ```ts standalone fence and finds the marked blocks in a page's markdown
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** A fenced block that carries an audio marker: the code a page shows, and the name of the rendered audio that plays under it. */
export interface AudioBlock {
  /** The name in `audio=NAME`; the key of the block in docs/audio/manifest.json and of its folder under /ts-audio/. */
  name: string;
  /** The page the block is on, as the caller named it. */
  page: string;
  /** The 1-based line of the block's first line of code (the line after the opening fence). */
  line: number;
  /** The block's code, without its fences. */
  code: string;
}

const MARKER = /^ts\s+standalone\s+audio=([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * The audio name a fence's info string asks for, or undefined. The marker belongs to `ts standalone` blocks, the ones that run
 * as written and are rendered offline, for example `ts standalone audio=recipes-render-wav`.
 */
export function audioName(info: string): string | undefined {
  return MARKER.exec(info.trim())?.[1];
}

/** Every marked block in a page's markdown, in page order. A fence closes at the first line that starts with three backticks. */
export function extractAudioBlocks(markdown: string, page: string): AudioBlock[] {
  const lines = markdown.split('\n');
  const found: AudioBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('```')) continue;
    const name = audioName(lines[i].slice(3));
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].startsWith('```')) end++;
    if (name) found.push({ name, page, line: start + 1, code: lines.slice(start, end).join('\n') });
    i = end;
  }
  return found;
}
