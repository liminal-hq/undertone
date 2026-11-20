// The control table's row types: a copy of the ts-rs output in crates/undertone-wasm/bindings, which a test keeps in step
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/** What argument a control takes, as the bridge reads it. */
export type ControlArg =
  | 'patternable'
  | 'patternableWithTime'
  | 'integer'
  | 'number'
  | 'choice'
  | 'text'
  | 'numberList'
  | 'path';

/** One control as plain data: what the bridge needs to install its method. */
export interface ControlRow {
  /** The method's name in JavaScript (`delayfeedback`). */
  jsName: string;
  /** The method's name in Rust (`delay_feedback`). */
  rustName: string;
  /** The `VoiceParams` fields (JSON names) the control writes; the first is the one a pattern sets. */
  fields: string[];
  /** What argument it takes. */
  arg: ControlArg;
  /** Whether a pattern is refused with the reference's "takes a plain value" message. */
  scalarOnly: boolean;
  /** The name the reference's messages use (`fmi` says `fm`). */
  messageName: string;
  /** For a `choice`, the words allowed. */
  choices: string[];
  /** The range in words, for documentation. */
  range: string;
  /** A sentence on what the control does. */
  summary: string;
}
