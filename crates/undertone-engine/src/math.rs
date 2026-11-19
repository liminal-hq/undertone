// The engine's transcendental maths behind one trait, with the C library and `libm` back-ends
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The engine's transcendental maths.
//!
//! The recorded graphs of the TypeScript reference hold numbers made by JavaScriptCore's `sin`,
//! `cos`, `exp`, and `pow`, rounded to nine significant digits. The engine must reproduce them,
//! natively and in WebAssembly, so every call to those functions goes through [`Maths`]. Two
//! back-ends implement it:
//!
//! - [`Native`] calls the Rust standard library's `f64` methods, which use the platform C library
//!   (and, on `wasm32-unknown-unknown`, the port of `libm` that ships with the compiler).
//! - `Libm` (behind the `libm` cargo feature, on by default) calls the pure-Rust `libm` crate, the
//!   same code on every target and every CPU.
//!
//! [`Active`] is the back-end the free functions ([`sin`], [`cos`], and the rest) use: `Libm` when
//! the `libm` feature is on (the default, so renders do not depend on the host's C library),
//! [`Native`] when it is off (`--no-default-features`). The wave tables ([`waves`]) and the gain maths
//! ([`gains`]) are generic over [`Maths`], so a test can build the same table with both.
//!
//! The functions follow C semantics for the edge cases the engine never reaches; in particular
//! [`Maths::pow`] is C's `pow`, which differs from JavaScript's `**` only for a base of exactly
//! one or minus one raised to an infinite power, and for a `NaN` exponent of zero.

pub mod gains;
pub mod waves;

/// The transcendental functions the engine needs, as associated functions so a back-end is a type.
pub trait Maths {
	/// The sine of `x` radians.
	fn sin(x: f64) -> f64;
	/// The cosine of `x` radians.
	fn cos(x: f64) -> f64;
	/// The arc cosine of `x`, in radians, for `x` in `-1..=1`.
	fn acos(x: f64) -> f64;
	/// `e` raised to `x`.
	fn exp(x: f64) -> f64;
	/// The natural logarithm of `x`.
	fn ln(x: f64) -> f64;
	/// `x` raised to the power `y`.
	fn pow(x: f64, y: f64) -> f64;
}

/// The back-end that calls the Rust standard library's `f64` methods (the platform C library).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Native;

impl Maths for Native {
	fn sin(x: f64) -> f64 {
		x.sin()
	}
	fn cos(x: f64) -> f64 {
		x.cos()
	}
	fn acos(x: f64) -> f64 {
		x.acos()
	}
	fn exp(x: f64) -> f64 {
		x.exp()
	}
	fn ln(x: f64) -> f64 {
		x.ln()
	}
	fn pow(x: f64, y: f64) -> f64 {
		x.powf(y)
	}
}

/// The back-end that calls the pure-Rust `libm` crate, the same code on every target.
#[cfg(feature = "libm")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Libm;

#[cfg(feature = "libm")]
impl Maths for Libm {
	fn sin(x: f64) -> f64 {
		libm::sin(x)
	}
	fn cos(x: f64) -> f64 {
		libm::cos(x)
	}
	fn acos(x: f64) -> f64 {
		libm::acos(x)
	}
	fn exp(x: f64) -> f64 {
		libm::exp(x)
	}
	fn ln(x: f64) -> f64 {
		libm::log(x)
	}
	fn pow(x: f64, y: f64) -> f64 {
		libm::pow(x, y)
	}
}

/// The back-end the engine uses: `Libm` by default, [`Native`] with `--no-default-features`.
#[cfg(not(feature = "libm"))]
pub type Active = Native;

/// The back-end the engine uses: `Libm` by default, [`Native`] with `--no-default-features`.
#[cfg(feature = "libm")]
pub type Active = Libm;

/// The name of the [`Active`] back-end: `"native"` or `"libm"`.
pub const ACTIVE_NAME: &str = if cfg!(feature = "libm") {
	"libm"
} else {
	"native"
};

/// The sine of `x` radians, on the [`Active`] back-end.
pub fn sin(x: f64) -> f64 {
	Active::sin(x)
}

/// The cosine of `x` radians, on the [`Active`] back-end.
pub fn cos(x: f64) -> f64 {
	Active::cos(x)
}

/// The arc cosine of `x`, on the [`Active`] back-end.
pub fn acos(x: f64) -> f64 {
	Active::acos(x)
}

/// `e` raised to `x`, on the [`Active`] back-end.
pub fn exp(x: f64) -> f64 {
	Active::exp(x)
}

/// The natural logarithm of `x`, on the [`Active`] back-end.
pub fn ln(x: f64) -> f64 {
	Active::ln(x)
}

/// `x` raised to the power `y`, on the [`Active`] back-end.
pub fn pow(x: f64, y: f64) -> f64 {
	Active::pow(x, y)
}

/// `x ** y` as JavaScriptCore computes it, rounded correctly (D-25), on every back-end.
///
/// The engine uses `**` with a fractional exponent for a semitone ratio (`2 ** (n / 12)`), a pan law
/// (`10 ** (law / 20)`), and the master bus's makeup gain. [`pow`] follows the platform or `libm` and can be one
/// unit in the last place away from JavaScriptCore; this is the pattern crate's `js::pow` (a double-double
/// `exp(y * ln x)` with the `x ** -0.5` rule), so a booked number is the one the reference wrote.
///
/// ```
/// use undertone_engine::math::js_pow;
/// assert_eq!(js_pow(2.0, 12.0 / 12.0), 2.0);
/// assert_eq!(js_pow(2.0, -0.5), 0.7071067811865475);
/// ```
pub fn js_pow(x: f64, y: f64) -> f64 {
	undertone_pattern::js::pow(x, y)
}

/// JavaScript's `Math.min` for two numbers: `NaN` if either is `NaN`.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
	if a.is_nan() || b.is_nan() {
		f64::NAN
	} else {
		a.min(b)
	}
}

/// JavaScript's `Math.max` for two numbers: `NaN` if either is `NaN`.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
	if a.is_nan() || b.is_nan() {
		f64::NAN
	} else {
		a.max(b)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_active_back_end_matches_its_name() {
		assert_eq!(ACTIVE_NAME == "libm", cfg!(feature = "libm"));
	}

	#[test]
	fn the_active_type_is_the_back_end_the_name_says() {
		let type_name = core::any::type_name::<Active>();
		assert!(type_name.ends_with(if ACTIVE_NAME == "libm" {
			"Libm"
		} else {
			"Native"
		}));
	}

	/// CI sets `UNDERTONE_EXPECT_MATHS=native` for its `--no-default-features` run, so a dependency
	/// that switches `libm` back on through feature unification fails the run instead of passing
	/// silently on the wrong back-end. Unset, the test does nothing.
	#[test]
	fn the_expected_back_end_is_the_one_in_use() {
		if let Ok(expected) = std::env::var("UNDERTONE_EXPECT_MATHS") {
			assert_eq!(
				ACTIVE_NAME, expected,
				"the engine is not using the maths back-end CI asked for"
			);
		}
	}

	#[test]
	fn known_values_on_the_native_back_end() {
		assert_eq!(Native::sin(0.0), 0.0);
		assert_eq!(Native::cos(0.0), 1.0);
		assert_eq!(Native::exp(0.0), 1.0);
		assert_eq!(Native::ln(1.0), 0.0);
		assert_eq!(Native::pow(2.0, 10.0), 1024.0);
		assert_eq!(Native::acos(1.0), 0.0);
	}

	#[test]
	fn free_functions_use_the_active_back_end() {
		assert_eq!(sin(0.5), Active::sin(0.5));
		assert_eq!(pow(10.0, -0.15), Active::pow(10.0, -0.15));
	}

	#[test]
	fn min_and_max_propagate_nan_like_javascript() {
		assert!(js_min(f64::NAN, 1.0).is_nan());
		assert!(js_max(1.0, f64::NAN).is_nan());
		assert_eq!(js_min(1.0, 0.5), 0.5);
		assert_eq!(js_max(-1.0, 0.0), 0.0);
	}

	#[cfg(feature = "libm")]
	mod divergence {
		use super::super::*;

		/// The stated tolerance between the back-ends, in units of the last place of the result
		/// (and an absolute floor for results near zero), measured on the sweeps below.
		const MAX_ULPS: f64 = 4.0;
		const ABSOLUTE_FLOOR: f64 = 1e-15;

		fn close(a: f64, b: f64) -> bool {
			if a == b {
				return true;
			}
			let diff = (a - b).abs();
			diff <= ABSOLUTE_FLOOR || diff <= MAX_ULPS * f64::EPSILON * a.abs().max(b.abs())
		}

		fn sweep(
			name: &str,
			args: impl Iterator<Item = f64>,
			native: fn(f64) -> f64,
			soft: fn(f64) -> f64,
		) {
			for x in args {
				let (a, b) = (native(x), soft(x));
				assert!(close(a, b), "{name}({x}): native {a:e} against libm {b:e}");
			}
		}

		#[test]
		fn sin_and_cos_agree_over_the_engine_range() {
			let args = || (-100_000..=100_000).map(|i| f64::from(i) * 0.001);
			sweep("sin", args(), Native::sin, Libm::sin);
			sweep("cos", args(), Native::cos, Libm::cos);
		}

		#[test]
		fn exp_ln_and_acos_agree() {
			sweep(
				"exp",
				(-20_000..=20_000).map(|i| f64::from(i) * 0.001),
				Native::exp,
				Libm::exp,
			);
			sweep(
				"ln",
				(1..=10_000).map(|i| f64::from(i) * 0.001),
				Native::ln,
				Libm::ln,
			);
			sweep(
				"acos",
				(0..=10_000).map(|i| f64::from(i) * 1e-4),
				Native::acos,
				Libm::acos,
			);
		}

		#[test]
		fn pow_agrees_for_the_laws_and_pitches_the_engine_uses() {
			for i in 0..=12_000 {
				let db = -f64::from(i) * 0.01;
				let (a, b) = (Native::pow(10.0, db / 20.0), Libm::pow(10.0, db / 20.0));
				assert!(close(a, b), "10 ** ({db} / 20): {a:e} against {b:e}");
			}
			for i in 0..=12_800 {
				let e = (f64::from(i) * 0.01 - 69.0) / 12.0;
				let (a, b) = (Native::pow(2.0, e), Libm::pow(2.0, e));
				assert!(close(a, b), "2 ** {e}: {a:e} against {b:e}");
			}
		}

		#[test]
		fn wave_tables_agree_to_the_rounding_of_a_single_float() {
			use crate::math::waves::{ShapedWave, shaped_wave_table};
			for shape in [
				ShapedWave::HalfSine,
				ShapedWave::AbsSine,
				ShapedWave::PulseSine,
			] {
				let a = shaped_wave_table::<Native>(shape);
				let b = shaped_wave_table::<Libm>(shape);
				for (x, y) in a
					.real
					.iter()
					.chain(&a.imag)
					.zip(b.real.iter().chain(&b.imag))
				{
					assert!(
						(f64::from(*x) - f64::from(*y)).abs() <= 1e-6,
						"{shape:?}: {x} against {y}"
					);
				}
			}
		}
	}
}
