// The `channels` group: placement on 1 to 8 channel destinations, surround angles, the fold-down, and the mono fold
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { ControlPatch } from '../../src/types';
import type { GraphCase, OutputSetup, VoicesGraphCase } from './graph';
import type { Program } from './interpret';

const SURROUND = 'src/surround.test.ts';
const ENGINE = 'src/engine.test.ts';
const MASTER = 'src/masterBus.test.ts';
const TOOLS = 'src/tools.test.ts';
const GUIDE = 'docs/guide/stereo-and-surround.md';
const GENERATED = 'generated: ';

/** A held tone: the voice every channel case places. */
const HELD: ControlPatch = {
  pitch: 'a3',
  soundType: 'triangle',
  attack: 0.02,
  decay: 0.1,
  sustain: 0.6,
  release: 0.15,
  gainLevel: 0.5,
  duration: 0.4
};

interface Extra {
  output?: OutputSetup;
  surround?: number;
  at?: number;
}

function voice(
  stem: string,
  from: string,
  patch: ControlPatch,
  extra: Extra = {}
): VoicesGraphCase {
  return {
    kind: 'voices',
    id: `channels-${stem}`,
    group: 'channels',
    from,
    baseline: true,
    output: extra.output,
    voices: [{ at: extra.at ?? 0, patch: { ...HELD, ...patch }, surround: extra.surround }]
  };
}

/** The layer 3 cases of the `channels` group. */
export function channelsCases(): GraphCase[] {
  const wide = `${ENGINE}: routes channelGains through per-speaker gains into a merger on a multichannel destination`;
  const fold = `${ENGINE}: folds channelGains down to stereo when the destination cannot address them`;
  const sugar = `${GUIDE}: surround(angle) places the voice on the speaker ring`;
  const out: GraphCase[] = [
    voice('mono-gains', fold, { channelGains: [1, 0.5, 0.25] }, { output: { channels: 1 } }),
    voice(
      'mono-unplaced',
      `${GENERATED}an unplaced voice on a mono destination`,
      {},
      {
        output: { channels: 1 }
      }
    ),
    voice('stereo-gains', wide, { channelGains: [0.8, 0.2] }),
    voice('stereo-surround-front-right', sugar, {}, { surround: 30 }),
    voice(
      'stereo-surround-rear',
      `${GUIDE}: on stereo hardware the rears fold down`,
      {},
      {
        surround: 150
      }
    ),
    voice('quad-gains', wide, { channelGains: [1, 0.5, 0, 0.25] }, { output: { channels: 4 } }),
    voice('quad-surround-between', sugar, {}, { surround: 15, output: { channels: 4 } }),
    voice(
      'quad-surround-side',
      `${GUIDE}: surround on a four-channel destination folds to stereo`,
      {},
      {
        surround: -90,
        output: { channels: 4 }
      }
    ),
    voice(
      'quad-unplaced',
      `${GENERATED}an unplaced voice on four channels`,
      {},
      {
        output: { channels: 4 }
      }
    ),
    voice(
      'quad-zero-gains',
      `${GENERATED}all-zero gains on four channels`,
      {
        channelGains: [0, 0, 0, 0]
      },
      { output: { channels: 4 } }
    ),
    voice(
      'six-surround-rear-left',
      `${ENGINE}: folds 7.1 placement to 5.1 (not stereo) on a six-channel destination (rear-left)`,
      {},
      { surround: -150, output: { channels: 6 } }
    ),
    voice('six-surround-behind', sugar, {}, { surround: 180, output: { channels: 6 } }),
    voice(
      'six-fold-rears',
      `${ENGINE}: folds 7.1 placement to 5.1 (not stereo) on a six-channel destination`,
      { channelGains: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 1, 1] },
      { output: { channels: 6 } }
    ),
    voice(
      'six-lfe',
      `${GUIDE}: route to the LFE channel explicitly with channels()`,
      {
        channelGains: [0, 0, 0, 1, 0, 0, 0, 0]
      },
      { output: { channels: 6 } }
    ),
    voice(
      'six-prefix',
      `${GUIDE}: shorter channelGains arrays address a prefix`,
      {
        channelGains: [0.5, 0.5, 1]
      },
      { output: { channels: 6 } }
    ),
    voice('six-unplaced', ENGINE, {}, { output: { channels: 6 } }),
    voice('eight-surround-centre', sugar, {}, { surround: 0, output: { channels: 8 } }),
    voice('eight-surround-front-right', sugar, {}, { surround: 30, output: { channels: 8 } }),
    voice('eight-surround-between', sugar, {}, { surround: 60, output: { channels: 8 } }),
    voice('eight-surround-side', sugar, {}, { surround: 90, output: { channels: 8 } }),
    voice('eight-surround-rear', sugar, {}, { surround: 150, output: { channels: 8 } }),
    voice('eight-surround-behind', sugar, {}, { surround: 180, output: { channels: 8 } }),
    voice(
      'eight-surround-wrapped',
      `${SURROUND}: normalizes any angle onto the ring`,
      {},
      {
        surround: -330,
        output: { channels: 8 }
      }
    ),
    voice(
      'eight-all-gains',
      `${GUIDE}: eight gains, one per speaker`,
      {
        channelGains: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]
      },
      { output: { channels: 8 } }
    ),
    voice(
      'eight-seven-gains',
      `${GUIDE}: shorter channelGains arrays address a prefix (seven)`,
      {
        channelGains: [1, 0, 0, 0, 0, 0, 0.5]
      },
      { output: { channels: 8 } }
    ),
    voice(
      'eight-unplaced',
      `${ENGINE}: routes unplaced voices through a centred stereo merger on a widened destination`,
      {},
      {
        output: { channels: 8 }
      }
    ),
    voice(
      'eight-gains-over-pan',
      `${ENGINE}: gives channelGains precedence over pan`,
      {
        pan: -1,
        channelGains: [0, 0, 0, 0, 0, 0, 1, 0]
      },
      { output: { channels: 8 } }
    ),
    voice(
      'eight-sends',
      `${ENGINE}: sends follow the placement`,
      {
        channelGains: [0.5, 0, 0, 0, 0, 0, 0, 1],
        roomLevel: 0.3,
        delayLevel: 0.2
      },
      { output: { channels: 8 } }
    ),
    voice(
      'eight-master',
      `${MASTER}: skips the limiter above two channels so surround is not folded to stereo`,
      {},
      {
        surround: 120,
        output: { channels: 8, master: true }
      }
    ),
    voice(
      'single-gain',
      `${ENGINE}: pads single-entry channelGains to two so the merger cannot up-mix mono to both speakers`,
      {
        channelGains: [0.7]
      },
      { output: { channels: 4 } }
    ),
    voice(
      'empty-gains',
      `${ENGINE}: treats empty channelGains as no placement at all`,
      {
        channelGains: []
      },
      { output: { channels: 4 } }
    ),
    {
      kind: 'voices',
      id: 'channels-eight-orbit',
      group: 'channels',
      from: `${GUIDE}: a voice per angle walks around the ring`,
      baseline: true,
      output: { channels: 8 },
      voices: [-150, -90, -30, 0, 30, 90, 150].map((angle, index) => ({
        at: index * 0.25,
        patch: { ...HELD, pitch: 220 + index * 55 },
        surround: angle
      }))
    },
    // enableMultichannel: what the context's destination becomes.
    voice(
      'enable-hardware-16',
      `${SURROUND}: claims the full hardware channel count with discrete interpretation (capped at eight)`,
      {},
      {
        output: { channels: 2, maxChannels: 16, multichannel: true }
      }
    ),
    voice(
      'enable-hardware-8',
      `${SURROUND}: claims the full hardware channel count with discrete interpretation`,
      {
        channelGains: [0, 0, 1, 0, 0, 0, 0, 0.5]
      },
      { output: { channels: 2, maxChannels: 8, multichannel: true } }
    ),
    voice(
      'enable-hardware-6',
      `${GENERATED}enableMultichannel on six-channel hardware`,
      {
        channelGains: [0, 0, 1, 0, 0, 0, 0, 0.5]
      },
      { output: { channels: 2, maxChannels: 6, multichannel: true } }
    ),
    voice(
      'enable-hardware-4',
      `${GENERATED}enableMultichannel on four-channel hardware`,
      {
        channelGains: [0.5, 0, 0, 1]
      },
      { output: { channels: 2, maxChannels: 4, multichannel: true } }
    ),
    voice(
      'enable-stereo-hardware',
      `${SURROUND}: leaves plain stereo destinations untouched`,
      {
        channelGains: [0, 0, 1, 0, 0.5, 0.5, 0, 0]
      },
      { output: { multichannel: true } }
    ),
    voice(
      'enable-skipped-eight',
      `${GENERATED}an eight-channel destination that was not opted in keeps its speakers interpretation`,
      {
        channelGains: [1, 0, 0, 0, 0, 0, 0, 1]
      },
      { output: { channels: 8, multichannel: false } }
    ),
    // createMonoFold
    voice(
      'mono-fold-pan',
      `${TOOLS}: can sit in front of a custom output and take a stereo mix`,
      { pan: -1 },
      {
        output: { monoFold: true }
      }
    ),
    voice(
      'mono-fold-centred',
      `${TOOLS}: is a one-channel explicit gain connected to the output`,
      {},
      {
        output: { monoFold: true }
      }
    ),
    voice(
      'mono-fold-master',
      `${GENERATED}the mono fold in front of the master bus`,
      { pan: 0.5 },
      {
        output: { monoFold: true, master: true }
      }
    ),
    voice(
      'mono-fold-placed',
      `${GENERATED}channel gains folded to stereo, then to mono`,
      {
        channelGains: [1, 0.25, 0, 0, 0, 0, 0, 0]
      },
      { output: { monoFold: true } }
    )
  ];
  return out;
}

/** Layer 2 programs for `channels()` and `surround()`: `[stem, from, program]`. */
export function channelPrograms(): [string, string, Program][] {
  const note = (source: string): Program[number] => ['note', source];
  const GAINS = 'src/control.test.ts: places voices on the 7.1 ring via channels() and surround()';
  const angles = [
    0, 30, -30, 90, -90, 150, -150, 180, -180, 15, 45, 60, -75, 7.5, 359.5, 390, -330, 540, 1e9
  ];
  const out: [string, string, Program][] = angles.map((angle) => [
    `surround-${String(angle).replace('-', 'minus-').replace('.', 'p')}`,
    `${SURROUND}: ${
      angle === 390 || angle === -330 || angle === 540 || angle === 1e9
        ? 'normalizes any angle onto the ring'
        : 'splits equal-power between the two nearest speakers'
    }`,
    [note('c4'), ['surround', angle]]
  ]);
  out.push(
    ['channels-one', `${GAINS}`, [note('c4'), ['channels', [1]]]],
    ['channels-two', `${GAINS}`, [note('c4 e4'), ['channels', [0.3, 0.7]]]],
    [
      'channels-eight',
      `${GAINS}`,
      [note('c4'), ['channels', [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]]]
    ],
    [
      'channels-zeros',
      `${GENERATED}all gains zero are silent but valid`,
      [note('c4'), ['channels', [0, 0, 0, 0]]]
    ],
    [
      'channels-above-one',
      `${GENERATED}gains above one are allowed`,
      [note('c4'), ['channels', [2, 0.5]]]
    ],
    [
      'channels-with-pan',
      `${ENGINE}: gives channelGains precedence over pan (both stay in the voice)`,
      [note('c4'), ['pan', -1], ['channels', [1, 0]]]
    ],
    [
      'channels-then-surround',
      `${GUIDE}: surround(angle) is sugar for channels(surroundGains(angle)), so the later one wins`,
      [note('c4'), ['channels', [1, 0]], ['surround', 90]]
    ],
    [
      'surround-then-channels',
      `${GUIDE}: surround(angle) is sugar for channels(surroundGains(angle)), so the later one wins`,
      [note('c4'), ['surround', 90], ['channels', [0, 1]]]
    ],
    [
      'surround-chord',
      `${GUIDE}: a chord placed at one angle`,
      [['chord', 'Cmaj7'], ['voicing'], ['surround', 45]]
    ],
    ['error-channels-empty', `${GAINS}`, [note('c4'), ['channels', []]]],
    ['error-channels-nine', `${GAINS}`, [note('c4'), ['channels', [1, 1, 1, 1, 1, 1, 1, 1, 1]]]],
    ['error-channels-negative', `${GAINS}`, [note('c4'), ['channels', [1, -0.5]]]]
  );
  return out;
}
