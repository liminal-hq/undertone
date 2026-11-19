// The `wav` corpus: encodeWav's exact bytes for small inputs, recorded as hex
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { CORPUS_VERSION, encodeValue, messageOf } from './format';
import type { CaseRecord } from './format';
import type { Reference } from './reference';
import type { WavOptions } from '../../src/wav';

const TEST = 'src/wav.test.ts';
const GENERATED = 'generated: ';

/** One WAV case: the samples of each channel (as 32-bit floats), the sample rate, and the options. */
interface WavCase {
  id: string;
  from: string;
  sampleRate: number;
  channels: readonly (readonly number[])[];
  options?: WavOptions;
}

/** The edge samples every format must treat the same way: clipping, rounding, NaN, -0, the infinities. */
const EDGES = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 0.25, -0.25, Number.NaN, -0, Infinity, -Infinity];

/** A short pseudo-sine, so a dither stream spans many samples. */
const WAVE = Array.from({ length: 48 }, (_, i) => Math.sin(i / 3) * 0.8);

/** `count` channels of three frames each, every channel a different level so the order shows. */
function channelsOf(count: number): number[][] {
  return Array.from({ length: count }, (_, c) => [0.1 * (c + 1), -0.1 * (c + 1), 0.05 * (c + 1)]);
}

function wav(
  stem: string,
  from: string,
  channels: readonly (readonly number[])[],
  options?: WavOptions,
  sampleRate = 48000
): WavCase {
  return { id: `wav-${stem}`, from, sampleRate, channels, options };
}

function cases(): WavCase[] {
  return [
    wav(
      '16-stereo-canonical',
      `${TEST}: writes a canonical 16-bit stereo header`,
      [
        [0, 0.5],
        [0, -0.5]
      ],
      { dither: false },
      44100
    ),
    wav(
      '16-mono-edges',
      `${GENERATED}clipping, rounding, NaN, -0 and the infinities at 16 bits`,
      [EDGES],
      { dither: false }
    ),
    wav(
      '16-stereo-clipping',
      `${GENERATED}the two ends of the 16-bit range`,
      [
        [1, -1, 0.99999, -0.99999],
        [2, -2, 1e-6, -1e-6]
      ],
      { dither: false }
    ),
    wav(
      '16-dither-default-seed',
      `${TEST}: dithers 16-bit by default, the same bytes for the same seed`,
      [WAVE, WAVE.map((v) => -v)]
    ),
    wav('16-dither-seed-7', `${GENERATED}a numeric seed`, [WAVE], { seed: 7 }),
    wav('16-dither-seed-text', `${GENERATED}a text seed`, [WAVE], { seed: 'undertone' }),
    wav(
      '16-dither-seed-negative',
      `${GENERATED}a negative seed wraps as an unsigned number`,
      [WAVE],
      { seed: -1 }
    ),
    wav(
      '16-dither-silence',
      `${GENERATED}dither on silence is the noise alone`,
      [new Array(32).fill(0)],
      { dither: true, seed: 3 }
    ),
    wav('16-silence-no-dither', `${GENERATED}undithered silence is zero`, [new Array(32).fill(0)], {
      dither: false
    }),
    wav('16-dither-edges', `${GENERATED}dither on the edge samples`, [EDGES], {
      dither: true,
      seed: 5
    }),
    wav('16-empty', `${GENERATED}no frames`, [[]], { dither: false }),
    wav(
      '24-mono-edges',
      `${GENERATED}clipping, rounding, NaN, -0 and the infinities at 24 bits`,
      [EDGES],
      { bitDepth: 24 }
    ),
    wav(
      '24-stereo',
      `${GENERATED}24-bit stereo with a ramp`,
      [WAVE.slice(0, 12), WAVE.slice(12, 24)],
      { bitDepth: 24 }
    ),
    wav('24-dither-ignored', `${GENERATED}dither is for 16-bit only`, [WAVE.slice(0, 12)], {
      bitDepth: 24,
      dither: true,
      seed: 9
    }),
    wav('24-odd-data-padded', `${GENERATED}an odd data size gets a pad byte`, [[0.5]], {
      bitDepth: 24
    }),
    wav(
      '32-float-mono',
      `${TEST}: writes 32-bit float with format tag 3, a fact chunk and unclamped samples`,
      [[0.25, 2]],
      { bitDepth: 32 }
    ),
    wav(
      '32-float-edges',
      `${GENERATED}float keeps NaN, -0, the infinities and overrange samples`,
      [EDGES, EDGES.map((v) => -v)],
      { bitDepth: 32 }
    ),
    wav(
      '32-float-tiny',
      `${GENERATED}a denormal and the largest 32-bit float`,
      [[1e-45, 3.4028234663852886e38, -1e-39]],
      { bitDepth: 32, dither: true }
    ),
    wav('32-empty', `${GENERATED}no frames in float`, [[]], { bitDepth: 32 }),
    wav(
      '3-channels',
      `${GENERATED}three channels are extensible with an empty mask`,
      channelsOf(3)
    ),
    wav('4-channels', `${TEST}: quad has its default mask`, channelsOf(4)),
    wav('5-channels', `${GENERATED}five channels, no default mask`, channelsOf(5), {
      dither: false
    }),
    wav(
      '6-channels-24',
      `${TEST}: uses WAVE_FORMAT_EXTENSIBLE with the PCM GUID and mask for 6 channels`,
      channelsOf(6),
      { bitDepth: 24 }
    ),
    wav('6-channels-float', `${GENERATED}extensible float`, channelsOf(6), { bitDepth: 32 }),
    wav('7-channels', `${GENERATED}seven channels, no default mask`, channelsOf(7), {
      dither: false
    }),
    wav('8-channels-reordered', `${TEST}: stores 7.1 in speaker-mask order`, channelsOf(8), {
      dither: false
    }),
    wav(
      '8-channels-explicit-mask',
      `${GENERATED}an explicit mask keeps the channel order`,
      channelsOf(8),
      { dither: false, channelMask: 0x63f }
    ),
    wav('4-channels-custom-mask', `${GENERATED}a custom speaker mask`, channelsOf(4), {
      dither: false,
      channelMask: 0x107
    }),
    wav(
      '2-channels-mask-ignored',
      `${GENERATED}a mask on a stereo file is not written`,
      channelsOf(2),
      { dither: false, channelMask: 0x4 }
    ),
    wav(
      'sample-rate-fractional',
      `${GENERATED}a fractional sample rate is truncated in the header`,
      [[0.1, 0.2]],
      { dither: false },
      22050.5
    ),
    wav(
      'sample-rate-high',
      `${GENERATED}a high sample rate and its byte rate`,
      [[0.1, 0.2]],
      { bitDepth: 24, dither: false },
      192000
    ),
    wav('error-no-channels', `${TEST}: rejects a source with no channels`, [], {}),
    wav('error-too-many-channels', `${TEST}: rejects more than 8 channels`, channelsOf(9), {}),
    wav(
      'error-unequal-lengths',
      `${TEST}: rejects channels of different lengths`,
      [[0, 0], [0]],
      {}
    )
  ];
}

/** Records one case: the inputs, and the bytes (as hex) or the message of the error. */
function record(ref: Reference, spec: WavCase): CaseRecord {
  const inputs = {
    id: spec.id,
    from: spec.from,
    sampleRate: spec.sampleRate,
    channels: encodeValue(spec.channels.map((channel) => Array.from(Float32Array.from(channel)))),
    options: encodeValue(spec.options ?? {})
  };
  try {
    const bytes = ref.lib.encodeWav(
      { sampleRate: spec.sampleRate, channels: spec.channels.map((c) => Float32Array.from(c)) },
      spec.options
    );
    return { ...inputs, bytes: Buffer.from(bytes).toString('hex') };
  } catch (error) {
    return { ...inputs, error: messageOf(error) };
  }
}

/**
 * The bytes of `wav/wav.json`: one case per line of inputs and expected bytes. Bytes are hex because a WAV file
 * is bytes, not a graph, and a case is small enough to read; there is no layer number, since nothing here is
 * a graph or a pattern.
 */
export function recordWav(ref: Reference): string {
  const lines = cases().map((spec) => `    ${JSON.stringify(record(ref, spec))}`);
  return `{\n  "corpus": ${CORPUS_VERSION},\n  "format": "wav",\n  "group": "wav",\n  "cases": [\n${lines.join(',\n')}\n  ]\n}\n`;
}
