// The floating-point maths the pattern core uses, in one place with a libm and a standard-library back-end
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The floating-point functions the crate needs: `floor`, `sin`, `cos`, `powf`, and `sqrt`.
//!
//! With the `libm` feature (the default, decision D-23) they are the pure-Rust `libm` crate's, the same code on every target and CPU, and the crate needs no `std`. With `--no-default-features --features std` they are the standard library's `f64` methods (the platform C library). With neither feature the crate does not build, because a `no_std` build needs a maths provider. `floor` and `sqrt` are exact in IEEE arithmetic, so they agree either way; `sin`, `cos`, and `pow` can differ in the last bit between the two.

#[cfg(not(any(feature = "libm", feature = "std")))]
compile_error!(
	"undertone-pattern needs the `libm` feature (default) or the `std` feature for its maths"
);

/// The largest integer value not greater than `x`.
pub(crate) fn floor(x: f64) -> f64 {
	#[cfg(feature = "libm")]
	return libm::floor(x);
	#[cfg(all(feature = "std", not(feature = "libm")))]
	return x.floor();
}

/// The sine of `x` in radians.
pub(crate) fn sin(x: f64) -> f64 {
	#[cfg(feature = "libm")]
	return libm::sin(x);
	#[cfg(all(feature = "std", not(feature = "libm")))]
	return x.sin();
}

/// The cosine of `x` in radians.
pub(crate) fn cos(x: f64) -> f64 {
	#[cfg(feature = "libm")]
	return libm::cos(x);
	#[cfg(all(feature = "std", not(feature = "libm")))]
	return x.cos();
}

/// `x` raised to the power `y`.
pub(crate) fn powf(x: f64, y: f64) -> f64 {
	#[cfg(feature = "libm")]
	return libm::pow(x, y);
	#[cfg(all(feature = "std", not(feature = "libm")))]
	return x.powf(y);
}

/// The square root of `x`.
pub(crate) fn sqrt(x: f64) -> f64 {
	#[cfg(feature = "libm")]
	return libm::sqrt(x);
	#[cfg(all(feature = "std", not(feature = "libm")))]
	return x.sqrt();
}
