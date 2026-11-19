// Numbered case ids for the data files that build their own groups
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Program } from './interpret';
import type { ProgramCase, SpanText } from './programs';

/** Makes layer 1 cases with ids numbered per `<group>-<stem>` (`mini-star-03`), fresh for each call of the maker. */
export function caseMaker(group: string, defaultSpans?: readonly SpanText[]) {
  const counter = new Map<string, number>();
  return (
    stem: string,
    from: string,
    program: Program,
    spans?: readonly SpanText[]
  ): ProgramCase => {
    const key = `${group}-${stem}`;
    const next = (counter.get(key) ?? 0) + 1;
    counter.set(key, next);
    const spec: ProgramCase = {
      id: `${key}-${String(next).padStart(2, '0')}`,
      group,
      from,
      program
    };
    const chosen = spans ?? defaultSpans;
    return chosen === undefined ? spec : { ...spec, spans: chosen };
  };
}
