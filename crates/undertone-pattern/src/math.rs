// The floating-point maths the pattern core uses, in one place so a no_std build can swap the provider
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The floating-point functions the crate needs (`floor`, then `sin`, `cos`, and `powf` for signals and pitch).
//!
//! With the `std` feature (the default) they are the standard library's. A `no_std` build must provide them from a maths crate such as `libm` (the open question of R9), so the dependency stays out of this crate until that decision is made.

/// The largest integer value not greater than `x`.
#[cfg(feature = "std")]
pub(crate) fn floor(x: f64) -> f64 {
	x.floor()
}
