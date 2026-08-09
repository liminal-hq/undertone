// Shared types for the Composer's example library — split out so per-example files don't need to import from composer.ts itself (avoiding a cycle)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export interface ComposerExample {
  label: string;
  code: string;
  /** Applied to the tempo slider when the example loads; omitted for one-shots, where tempo doesn't really apply. */
  bpm?: number;
}

export interface ExampleGroup {
  label: string;
  examples: ComposerExample[];
}
