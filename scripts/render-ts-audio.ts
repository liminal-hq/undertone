// Renders the audio the TypeScript guide pages play: runs every marked documentation block offline and writes the WAV files
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAudioBlocks } from '../docs/.vitepress/theme/live/audioFence';
import { renderBlock } from './ts-audio/renderBlock';
import type { BlockSpec, RenderEngine } from './ts-audio/renderBlock';

// Usage: bun scripts/render-ts-audio.ts [OUTDIR] [--only NAME]...
//
// OUTDIR defaults to docs/public/ts-audio (git-ignored). Each block named in docs/audio/manifest.json is found in its page by the
// `audio=NAME` marker on its fence, run under node-web-audio-api (an offline engine for Node) against the library source, and
// written to OUTDIR/NAME/*.wav. OUTDIR/manifest.json lists the files of each block with their sample rate, channel count, length,
// bit depth and caption note; the <TsAudio name="..."> component on the pages reads it. CI runs this in a job and the site build
// downloads the result (see .github/workflows/gh-pages.yml). Nothing here listens to the audio; it prints each file's peak and RMS.
// Run it under a memory cap when memory is tight, for example
// `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- bun run docs:audio`.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One entry of the manifest the site reads: one rendered file. */
interface ManifestFile {
  file: string;
  sampleRate: number;
  channels: number;
  seconds: number;
  bitDepth: number;
  engine: string;
  note: string;
}

function parseArgs(argv: string[]): { out: string; only: string[] } {
  const only: string[] = [];
  let out = join(root, 'docs', 'public', 'ts-audio');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only.push(argv[++i]);
    else out = resolve(argv[i]);
  }
  // The output folder is emptied first, so it must not be the repository or a folder above it.
  if (out === root || root.startsWith(out + sep)) {
    throw new Error(`refusing to empty ${out}, which holds the repository`);
  }
  return { out, only };
}

async function loadEngine(): Promise<{ engine: RenderEngine; version: string }> {
  try {
    const nwa = await import('node-web-audio-api');
    const version = (
      JSON.parse(
        readFileSync(join(root, 'node_modules', 'node-web-audio-api', 'package.json'), 'utf8')
      ) as { version: string }
    ).version;
    return {
      engine: {
        OfflineAudioContext:
          nwa.OfflineAudioContext as unknown as RenderEngine['OfflineAudioContext']
      },
      version
    };
  } catch (error) {
    throw new Error(
      `node-web-audio-api did not load (${(error as Error).message}). Run \`bun install\`; on Linux it needs libasound.so.2 ` +
        '(`apt-get install libasound2t64`), even though no audio device is used.',
      { cause: error }
    );
  }
}

async function main(): Promise<void> {
  const { out, only } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    readFileSync(join(root, 'docs', 'audio', 'manifest.json'), 'utf8')
  ) as Record<string, BlockSpec>;
  const names = only.length > 0 ? only : Object.keys(manifest);
  const { engine, version } = await loadEngine();

  const pages = new Map<string, ReturnType<typeof extractAudioBlocks>>();
  const blockFor = (name: string, page: string) => {
    if (!pages.has(page)) {
      pages.set(page, extractAudioBlocks(readFileSync(join(root, page), 'utf8'), page));
    }
    const block = pages.get(page)?.find((candidate) => candidate.name === name);
    if (!block) throw new Error(`${page} has no block marked audio=${name}`);
    return block;
  };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const result: Record<string, ManifestFile[]> = {};
  let total = 0;
  console.log('name / file                                 size      seconds  peak dBFS  rms dBFS');
  for (const name of names) {
    const spec = manifest[name];
    if (!spec) throw new Error(`${name} is not in docs/audio/manifest.json`);
    const block = blockFor(name, spec.page);
    let files;
    try {
      files = await renderBlock(block.code, spec, engine);
    } catch (error) {
      throw new Error(`${spec.page}:${block.line} (audio=${name}): ${(error as Error).message}`, {
        cause: error
      });
    }
    mkdirSync(join(out, name), { recursive: true });
    result[name] = [];
    for (const file of files) {
      writeFileSync(join(out, name, file.file), file.bytes);
      total += file.bytes.length;
      result[name].push({
        file: file.file,
        sampleRate: file.sampleRate,
        channels: file.channels,
        seconds: Math.round(file.seconds * 100) / 100,
        bitDepth: file.bitDepth,
        engine: `node-web-audio-api ${version}`,
        note: file.note
      });
      const kb = `${(file.bytes.length / 1024).toFixed(0)} KB`;
      console.log(
        `${`${name}/${file.file}`.padEnd(42)} ${kb.padStart(9)} ${file.seconds.toFixed(2).padStart(9)} ${file.peakDb.toFixed(2).padStart(10)} ${file.rmsDb.toFixed(2).padStart(9)}`
      );
    }
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`);
  const count = Object.values(result).reduce((n, list) => n + list.length, 0);
  console.log(
    `render-ts-audio: ${count} files, ${(total / 1048576).toFixed(1)} MB, manifest at ${join(out, 'manifest.json')}`
  );
}

main().catch((error: unknown) => {
  console.error(`render-ts-audio: ${(error as Error).message}`);
  process.exit(1);
});
