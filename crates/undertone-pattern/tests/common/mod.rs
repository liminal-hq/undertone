// Shared helpers for the integration tests: the JSON reader and the program interpreter
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Helpers shared by `corpus.rs` and `properties.rs`.

pub mod encode;
pub mod interpret;
pub mod json;

#[allow(dead_code)]
/// The text JavaScript prints for a number, for building JSON numbers in generated programs.
pub fn interpret_number_text(n: f64) -> String {
	undertone_pattern::js::number_to_string(n)
}
