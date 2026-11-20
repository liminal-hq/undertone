// The AudioWorkletProcessor of the opt-in worklet backend, as the text the package puts in the module it adds to a worklet
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// It runs in the worklet global scope, so it is plain JavaScript held as text (see workletShim.ts for why): the module the main
// thread builds is the shim, the worklet module's glue, and this, in that order, and this is called with the global scope and the
// glue's exports. It plays booked voices only (D-48): it never queries a pattern. The main thread posts the voices a pattern gave
// (`collectVoices`, flat) and the frame they start at; the processor books them in the worklet module's `WorkletEngine` and renders
// each 128-frame block into its output.
//
// Messages in (`port.postMessage`):
//   { type: 'play', token, numbers, strings, frame, period }  queue a pass of voices from host frame `frame`, repeating every
//                                                             `period` frames when it is a number (a loop)
//   { type: 'cancel', token }                                 stop a queue: what it has not booked yet never is
//   { type: 'sample', op, name, source|base|decoded }         the sample registry: register, pending, load, or clear
//   { type: 'clock', buffer, ticksPerMs }                     time with a counter a page worker spins in `buffer`
//   { type: 'stats', id }                                     answer with the statistics so far
//   { type: 'reset-stats' }                                   start the statistics again
//   { type: 'close' }                                         free the engine and stop
// Messages out: { type: 'ready', ... } once, { type: 'stats', id, ... }, { type: 'error', message }, { type: 'queued', token, id }.
//
// Frames: `currentFrame` of the worklet scope is the host's clock, `engine.frame` the engine's own, and `offset` is how far the
// first is ahead of the second. A voice posted at host frame F is booked at engine frame F - offset. The offset grows when the
// host skips blocks (the engine did not get them), and that growth is the drift the statistics report.
//
// Timing: a clock read around each `process` call, kept in a histogram of 5 microsecond buckets to 20 ms (no allocation while it
// runs), and compared with the block's budget (128 frames at the sample rate). The clock is `performance.now()` where the scope
// has it. Chromium's worklet scope does not (found by the headless check, harness/check.ts), so the page can send a `clock`
// message with a SharedArrayBuffer counter that one of its workers spins (it needs a cross-origin isolated page); the counter
// is read with `Atomics.load` and turned to milliseconds with the ticks per millisecond the page measured. With neither the
// statistics say so (`timing: 'none'`) and report no times.

export const workletProcessorName = 'undertone-worklet';

export const workletProcessorSource = `(function (scope, glue) {
  const BUCKET_MS = 0.005;
  const BUCKETS = 4000;
  // The clock the timings use: performance.now() where the scope has it (Chromium's worklet scope does not), else a counter that
  // a worker on the page spins in a SharedArrayBuffer (the page sends it with a clock message), else none.
  function performanceClock() {
    if (typeof scope.performance === 'undefined' || typeof scope.performance.now !== 'function') return undefined;
    return {
      name: 'performance.now',
      tick: function () {
        return scope.performance.now();
      },
      span: function (from, to) {
        return to - from;
      }
    };
  }
  function counterClock(buffer, ticksPerMs) {
    const view = new Int32Array(buffer);
    return {
      name: 'spin-counter',
      tick: function () {
        return Atomics.load(view, 0);
      },
      // The counter is 32 bits and wraps: a span is the difference as a signed 32-bit number.
      span: function (from, to) {
        return ((to - from) | 0) / ticksPerMs;
      },
      ticksPerMs: ticksPerMs
    };
  }

  function Histogram() {
    this.counts = new Uint32Array(BUCKETS + 1);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
  Histogram.prototype.add = function (ms) {
    const bucket = ms >= 0 ? Math.min(BUCKETS, Math.floor(ms / BUCKET_MS)) : 0;
    this.counts[bucket] += 1;
    this.count += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  };
  Histogram.prototype.percentile = function (fraction) {
    if (this.count === 0) return null;
    const target = Math.ceil(this.count * fraction);
    let seen = 0;
    for (let bucket = 0; bucket <= BUCKETS; bucket += 1) {
      seen += this.counts[bucket];
      if (seen >= target) return bucket === BUCKETS ? this.max : (bucket + 1) * BUCKET_MS;
    }
    return this.max;
  };
  Histogram.prototype.summary = function () {
    return {
      count: this.count,
      mean: this.count === 0 ? null : this.sum / this.count,
      p50: this.percentile(0.5),
      p99: this.percentile(0.99),
      p999: this.percentile(0.999),
      max: this.count === 0 ? null : this.max
    };
  };

  class UndertoneProcessor extends scope.AudioWorkletProcessor {
    constructor(init) {
      super();
      const settings = (init && init.processorOptions) || {};
      glue.initSync({ module: settings.module });
      this.options = settings.options || {};
      this.engine = new glue.WorkletEngine(this.options);
      this.channels = this.options.channels || 2;
      this.clock = performanceClock();
      this.queues = new Map();
      this.waiting = [];
      this.closed = false;
      this.errors = [];
      this.base = undefined;
      this.offset = 0;
      this.resetStats();
      this.port.onmessage = (event) => this.receive(event.data);
      this.port.postMessage({
        type: 'ready',
        timing: this.clock ? this.clock.name : 'none',
        sampleRate: scope.sampleRate,
        channels: this.channels
      });
    }

    resetStats() {
      this.process_ = new Histogram();
      this.queue_ = new Histogram();
      this.blocks = 0;
      this.overruns = 0;
      this.slow = 0;
      this.skipped = 0;
      this.late = 0;
      this.maxLate = 0;
      this.lastDrift = 0;
      this.maxDrift = 0;
    }

    fail(message) {
      if (this.errors.length < 8) this.errors.push(message);
      this.port.postMessage({ type: 'error', message: message });
    }

    receive(message) {
      try {
        switch (message.type) {
          case 'play':
            // Until a block has run the offset between the two clocks is not known: the pass waits for the first block.
            if (this.base === undefined) this.waiting.push(message);
            else this.play(message);
            break;
          case 'cancel': {
            this.waiting = this.waiting.filter((waiting) => waiting.token !== message.token);
            const id = this.queues.get(message.token);
            if (id !== undefined) {
              this.engine.cancel(id);
              this.queues.delete(message.token);
            }
            break;
          }
          case 'sample':
            this.sample(message);
            break;
          case 'clock':
            this.clock = counterClock(message.buffer, message.ticksPerMs);
            this.resetStats();
            break;
          case 'stats':
            this.port.postMessage(this.stats(message.id));
            break;
          case 'reset-stats':
            this.resetStats();
            break;
          case 'close':
            this.closed = true;
            this.engine.free();
            break;
          default:
            this.fail('unknown message type ' + String(message.type));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    }

    play(message) {
      const start = message.frame - this.offset;
      if (start < this.engine.frame) {
        this.late += 1;
        this.maxLate = Math.max(this.maxLate, this.engine.frame - start);
      }
      const began = this.clock ? this.clock.tick() : 0;
      const period = typeof message.period === 'number' ? message.period : undefined;
      const id = this.engine.queue(message.numbers, message.strings, start, period);
      if (this.clock) this.queue_.add(this.clock.span(began, this.clock.tick()));
      this.queues.set(message.token, id);
      this.port.postMessage({ type: 'queued', token: message.token, id: id, late: start < this.engine.frame });
    }

    sample(message) {
      switch (message.op) {
        case 'register':
          glue.registerSample(message.name, message.source);
          break;
        case 'pending':
          glue.registerPendingSample(message.name, message.base);
          break;
        case 'load':
          glue.loadSample(message.name, message.decoded);
          break;
        case 'clear':
          glue.clearSamples();
          break;
        default:
          this.fail('unknown sample operation ' + String(message.op));
      }
    }

    stats(id) {
      const budget = (128 / scope.sampleRate) * 1000;
      return {
        type: 'stats',
        id: id,
        timing: this.clock ? this.clock.name : 'none',
        sampleRate: scope.sampleRate,
        quantumFrames: 128,
        budgetMs: budget,
        blocks: this.blocks,
        processMs: this.clock ? this.process_.summary() : null,
        clockTicksPerMs: this.clock && this.clock.ticksPerMs ? this.clock.ticksPerMs : null,
        queueMs: this.clock ? this.queue_.summary() : null,
        overruns: this.overruns,
        over40Percent: this.slow,
        skippedBlocks: this.skipped,
        driftFrames: this.base === undefined ? 0 : this.offset - this.base,
        maxDriftFrames: this.maxDrift,
        lateStarts: this.late,
        maxLateFrames: this.maxLate,
        engineFrame: this.engine.frame,
        hostFrame: scope.currentFrame,
        liveNodes: this.engine.liveNodes,
        queues: this.engine.queueCount,
        errors: this.errors.slice()
      };
    }

    process(inputs, outputs) {
      if (this.closed) return false;
      const clock = this.clock;
      const began = clock ? clock.tick() : 0;
      const host = scope.currentFrame;
      if (this.base === undefined) {
        this.offset = host - this.engine.frame;
        this.base = this.offset;
        for (const message of this.waiting.splice(0)) this.receive(message);
      } else {
        const ahead = host - this.engine.frame;
        if (ahead > this.offset) {
          // The host went on by more than the engine rendered: blocks were skipped, and every voice after this one is booked
          // for the host's clock, not the engine's.
          this.skipped += Math.ceil((ahead - this.offset) / 128);
          this.offset = ahead;
        }
      }
      const drift = this.offset - this.base;
      if (drift !== this.lastDrift) {
        this.lastDrift = drift;
        if (drift > this.maxDrift) this.maxDrift = drift;
      }
      try {
        const failure = this.engine.renderBlock(outputs[0]);
        if (failure !== undefined) this.fail(failure);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
      this.blocks += 1;
      if (clock) {
        const spent = clock.span(began, clock.tick());
        this.process_.add(spent);
        const budget = (outputs[0][0].length / scope.sampleRate) * 1000;
        if (spent > budget) this.overruns += 1;
        if (spent > budget * 0.4) this.slow += 1;
      }
      return true;
    }
  }

  scope.registerProcessor('${workletProcessorName}', UndertoneProcessor);
})(globalThis, {
  initSync: initSync,
  WorkletEngine: WorkletEngine,
  registerSample: registerSample,
  registerPendingSample: registerPendingSample,
  loadSample: loadSample,
  clearSamples: clearSamples
});
`;
