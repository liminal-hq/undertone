// The summary of a worklet statistics snapshot, shared by the harness page and the run-all page
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** The summary of a statistics snapshot, with the acceptance checks. */
export function summarise(stats, context, elapsed) {
  const budget = stats.budgetMs;
  const p99 = stats.processMs?.p99 ?? null;
  const underruns = stats.overruns + stats.skippedBlocks;
  const checks = {
    noUnderrun: underruns === 0,
    p99Within40Percent: p99 !== null && p99 <= budget * 0.4,
    zeroDrift: stats.maxDriftFrames === 0
  };
  return {
    elapsedSeconds: elapsed,
    blocks: stats.blocks,
    expectedBlocks: Math.floor((elapsed * stats.sampleRate) / stats.quantumFrames),
    underruns,
    overruns: stats.overruns,
    skippedBlocks: stats.skippedBlocks,
    budgetMs: budget,
    timing: stats.timing,
    clockTicksPerMs: stats.clockTicksPerMs,
    processMs: stats.processMs,
    p99PercentOfBudget: p99 === null ? null : (p99 / budget) * 100,
    over40Percent: stats.over40Percent,
    queueMs: stats.queueMs,
    driftFrames: stats.driftFrames,
    maxDriftFrames: stats.maxDriftFrames,
    lateStarts: stats.lateStarts,
    maxLateFrames: stats.maxLateFrames,
    liveNodes: stats.liveNodes,
    errors: stats.errors,
    main: stats.main,
    sampleRate: stats.sampleRate,
    baseLatency: context.baseLatency,
    outputLatency: context.outputLatency,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    checks,
    passed: Object.values(checks).every(Boolean)
  };
}
