// A correctly rounded `x ** y` in double-double arithmetic, so a power matches JavaScriptCore bit for bit
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! `pow` rounded correctly (to the nearest double) instead of to within one unit in the last place.
//!
//! JavaScriptCore's `**` agrees with the correctly rounded result for every `midiToFrequency` input the corpus has (1,401 of 1,401 outside the `-0.5` rule), while the `libm` crate's `pow` is off by one unit in the last place for some. That matters beyond tolerance: `drift` writes a note's pitch into its random key, so one different bit gives a different random stream. This module computes `exp(y * ln x)` with about 100 bits of precision, so the rounding to a double is the correct one except in cases within 1e-28 of a tie.
//!
//! It is plain arithmetic (no FMA, no tables), so it gives the same bits on every target. It handles finite `x > 0` and `y` whose result is a normal number; the caller falls back to `libm` for everything else.

/// An unevaluated sum `hi + lo` with `|lo|` at most half an ulp of `hi`.
#[derive(Clone, Copy)]
struct Dd {
	hi: f64,
	lo: f64,
}

fn two_sum(a: f64, b: f64) -> Dd {
	let hi = a + b;
	let bb = hi - a;
	Dd {
		hi,
		lo: (a - (hi - bb)) + (b - bb),
	}
}

fn quick_two_sum(a: f64, b: f64) -> Dd {
	let hi = a + b;
	Dd {
		hi,
		lo: b - (hi - a),
	}
}

fn split(a: f64) -> (f64, f64) {
	let t = 134_217_729.0 * a; // 2^27 + 1
	let hi = t - (t - a);
	(hi, a - hi)
}

fn two_prod(a: f64, b: f64) -> Dd {
	let hi = a * b;
	let (ah, al) = split(a);
	let (bh, bl) = split(b);
	Dd {
		hi,
		lo: ((ah * bh - hi) + ah * bl + al * bh) + al * bl,
	}
}

impl Dd {
	fn of(x: f64) -> Dd {
		Dd { hi: x, lo: 0.0 }
	}

	fn add(self, o: Dd) -> Dd {
		let s = two_sum(self.hi, o.hi);
		let t = two_sum(self.lo, o.lo);
		let u = quick_two_sum(s.hi, s.lo + t.hi);
		quick_two_sum(u.hi, u.lo + t.lo)
	}

	fn neg(self) -> Dd {
		Dd {
			hi: -self.hi,
			lo: -self.lo,
		}
	}

	fn mul(self, o: Dd) -> Dd {
		let p = two_prod(self.hi, o.hi);
		quick_two_sum(p.hi, p.lo + (self.hi * o.lo + self.lo * o.hi))
	}

	fn mul_f(self, b: f64) -> Dd {
		let p = two_prod(self.hi, b);
		quick_two_sum(p.hi, p.lo + self.lo * b)
	}

	fn div_f(self, b: f64) -> Dd {
		let q1 = self.hi / b;
		let r = self.add(two_prod(q1, b).neg());
		let q2 = r.hi / b;
		let r = r.add(two_prod(q2, b).neg());
		let q3 = r.hi / b;
		quick_two_sum(q1, q2).add(Dd::of(q3))
	}
}

const LN2: Dd = Dd {
	hi: core::f64::consts::LN_2,
	lo: 2.319_046_813_846_299_6e-17,
};

/// `e ** a` as a double-double, for `|a.hi|` below about 700.
fn exp(a: Dd) -> Dd {
	let k = crate::math::floor(a.hi / LN2.hi + 0.5);
	let r = a.add(LN2.mul_f(k).neg());
	// Taylor series; |r| is at most about 0.35, so 30 terms are far below 1e-33.
	let mut sum = Dd::of(1.0);
	let mut term = Dd::of(1.0);
	for n in 1..=30 {
		term = term.mul(r).div_f(f64::from(n));
		sum = sum.add(term);
	}
	// Multiply by 2^k exactly, in two steps so neither factor leaves the normal range.
	let half = k as i32 / 2;
	let scale = |e: i32| f64::from_bits(((1023 + i64::from(e)) as u64) << 52);
	Dd {
		hi: sum.hi * scale(half) * scale(k as i32 - half),
		lo: sum.lo * scale(half) * scale(k as i32 - half),
	}
}

/// `ln x` as a double-double, for finite `x > 0`: the `libm` logarithm refined by one Newton step.
fn ln(x: f64) -> Dd {
	let l0 = crate::math::ln(x);
	// l = l0 + (x * e^-l0 - 1) to second order.
	let t = exp(Dd::of(-l0)).mul_f(x).add(Dd::of(-1.0));
	Dd::of(l0).add(t)
}

/// The correctly rounded `x ** y` for finite `x > 0` and finite `y`, or `None` when the result might not be a normal number (the caller then uses the C library's answer).
pub(crate) fn pow(x: f64, y: f64) -> Option<f64> {
	if !(x.is_finite() && x > 0.0 && y.is_finite()) {
		return None;
	}
	let z = ln(x).mul_f(y);
	if !(-700.0..700.0).contains(&z.hi) {
		return None;
	}
	let e = exp(z);
	Some(e.hi + e.lo)
}

#[cfg(test)]
mod tests {
	use super::pow;

	/// `midiToFrequency(m)` as Bun (JavaScriptCore) prints it, for a spread of notes.
	#[test]
	fn matches_javascriptcore_for_midi_to_frequency() {
		let table = [
			(-300.0, 2.436577950609835e-07),
			(-100.0, 0.025348187108150937),
			(-33.0, 1.2153397801643786),
			(0.0, 8.175798915643707),
			(21.0, 27.5),
			(36.0, 65.40639132514966),
			(50.0, 146.8323839587038),
			(64.0, 329.6275569128699),
			(81.0, 880.0),
			(100.0, 2637.02045530296),
			(127.0, 12543.853951415975),
			(200.0, 850544.0206437273),
			(400.0, 88483723550.07211),
		];
		for (midi, expected) in table {
			let hz = 440.0 * pow(2.0, (midi - 69.0) / 12.0).unwrap();
			assert_eq!(hz, expected, "midi {midi}");
		}
	}

	#[test]
	fn exact_powers_stay_exact_and_specials_fall_back() {
		assert_eq!(pow(2.0, 10.0), Some(1024.0));
		assert_eq!(pow(10.0, 2.0), Some(100.0));
		assert_eq!(pow(0.0, 2.0), None);
		assert_eq!(pow(-2.0, 2.0), None);
		assert_eq!(pow(2.0, 2000.0), None);
		assert_eq!(pow(f64::NAN, 1.0), None);
	}
}
