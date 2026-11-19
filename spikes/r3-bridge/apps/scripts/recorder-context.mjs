// A tiny recording context for the Node, Deno, and Bun scripts: every call becomes one line of text
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** Makes a context whose nodes log every call, so runtimes can be compared by the log's hash. */
export function recordingContext() {
  const log = [];
  let nextId = 1;
  const param = (id, name) => ({
    setValueAtTime: (v, t) => log.push(`${id}.${name} set ${v} @${t}`),
    linearRampToValueAtTime: (v, t) => log.push(`${id}.${name} lin ${v} @${t}`)
  });
  const node = (kind, params) => {
    const id = `n${nextId++}:${kind}`;
    log.push(`create ${id}`);
    const out = {
      connect: (to, o = 0, i = 0) => log.push(`${id} -> ${to.id} ${o} ${i}`),
      start: (t) => log.push(`${id} start @${t}`),
      stop: (t) => log.push(`${id} stop @${t}`),
      id
    };
    for (const name of params) out[name] = param(id, name);
    return new Proxy(out, {
      set(target, key, value) {
        log.push(`${id}.${String(key)} = ${value}`);
        target[key] = value;
        return true;
      }
    });
  };
  return {
    log,
    currentTime: 0,
    destination: { id: 'n0:destination' },
    createOscillator: () => node('oscillator', ['frequency']),
    createGain: () => node('gain', ['gain']),
    createBiquadFilter: () => node('filter', ['frequency']),
    createStereoPanner: () => node('panner', ['pan']),
    createChannelMerger: (n) => node(`merger${n}`, [])
  };
}
