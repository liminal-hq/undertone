// Throwaway spike R4 worklet module: a raw C ABI engine stub (pattern queries and a minimal voice) for size
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The worklet module of spike R4 (RF-11): the pattern core (so a tree can be built from a byte program and
//! queried for a booking window), the engine's maths, and a minimal voice renderer (a sine with an
//! envelope, a one-pole lowpass, and the pan law). No `wasm-bindgen`; the host reads and writes linear
//! memory through `alloc`, `build`, `book`, and `render`. The real voice graph is not built yet, so
//! this module is a lower bound.

#[cfg(feature = "pattern")]
use std::cell::RefCell;

use undertone_engine::math::Libm;
use undertone_engine::math::gains::pan_law_gains;
use undertone_engine::math::waves::{ShapedWave, shaped_wave_table};
#[cfg(feature = "pattern")]
use undertone_pattern::control::{Control, ControlArg};
#[cfg(feature = "mini")]
use undertone_pattern::control::{n, note, sound};
#[cfg(feature = "pattern")]
use undertone_pattern::random::Seed;
#[cfg(feature = "pattern")]
use undertone_pattern::signal;
#[cfg(feature = "pattern")]
use undertone_pattern::{Fraction, Pattern, Span, Value, cat, pure, seq, silence, stack};

#[cfg(feature = "pattern")]
thread_local! {
	static PATTERNS: RefCell<Vec<Pattern<Value>>> = const { RefCell::new(Vec::new()) };
}

/// Allocates `n` bytes of linear memory for the host to write into.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
	let mut v = Vec::<u8>::with_capacity(n);
	let p = v.as_mut_ptr();
	std::mem::forget(v);
	p
}

/// Frees memory from [`alloc`].
///
/// # Safety
///
/// `p` and `n` must come from one call to [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
	drop(unsafe { Vec::from_raw_parts(p, 0, n) });
}

#[cfg(feature = "pattern")]
struct Reader<'a>(&'a [u8]);

#[cfg(feature = "pattern")]
impl Reader<'_> {
	fn u8(&mut self) -> u8 {
		let (a, rest) = self.0.split_first().unwrap_or((&0, &[]));
		self.0 = rest;
		*a
	}
	fn f64(&mut self) -> f64 {
		let n = self.0.len().min(8);
		let mut b = [0u8; 8];
		b[..n].copy_from_slice(&self.0[..n]);
		self.0 = &self.0[n..];
		f64::from_le_bytes(b)
	}
	fn text(&mut self) -> String {
		let len = self.u8() as usize;
		let len = len.min(self.0.len());
		let (t, rest) = self.0.split_at(len);
		self.0 = rest;
		String::from_utf8_lossy(t).into_owned()
	}
}

/// Builds a pattern from a postfix byte program and returns its handle, or `u32::MAX` on an error.
/// This stands in for deserialising a tree: every kind of node the core has is reachable from here.
///
/// # Safety
///
/// `p..p+len` must be readable memory.
#[cfg(feature = "pattern")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn build(p: *const u8, len: usize) -> u32 {
	let bytes = unsafe { std::slice::from_raw_parts(p, len) };
	let mut r = Reader(bytes);
	let mut stk: Vec<Pattern<Value>> = Vec::new();
	while !r.0.is_empty() {
		let op = r.u8();
		let out = match op {
			#[cfg(feature = "mini")]
			0 => note(&r.text()),
			#[cfg(feature = "mini")]
			1 => sound(&r.text()),
			#[cfg(feature = "mini")]
			2 => n(&r.text()),
			3 => Ok(pure(Value::Num(r.f64()))),
			4 => Ok(silence()),
			5 => {
				let c = r.u8() as usize;
				let at = stk.len().saturating_sub(c);
				Ok(stack(stk.split_off(at)))
			}
			6 => {
				let c = r.u8() as usize;
				let at = stk.len().saturating_sub(c);
				Ok(seq(stk.split_off(at)))
			}
			7 => {
				let c = r.u8() as usize;
				let at = stk.len().saturating_sub(c);
				Ok(cat(stk.split_off(at)))
			}
			8 => signal::by_name::<Value>(&r.text())
				.ok_or_else(|| undertone_pattern::Error::new("signal")),
			_ => {
				let Some(top) = stk.pop() else {
					return u32::MAX;
				};
				match op {
					9 => top.fast(r.f64()),
					10 => top.slow(r.f64()),
					11 => Ok(top.rev()),
					12 => top.euclid(r.f64(), r.f64(), r.f64()),
					13 => top.segment(r.f64()),
					14 => Ok(top.range(r.f64(), r.f64())),
					15 => top.rangex(r.f64(), r.f64()),
					#[cfg(feature = "mini")]
					16 => top.scale(&r.text()),
					17 => top.control(Control::Gain, ControlArg::Number(r.f64())),
					#[cfg(feature = "mini")]
					18 => top.control(Control::Pan, ControlArg::Text(r.text())),
					19 => top.seed(Seed::Num(r.f64())),
					20 => {
						let Some(other) = stk.pop() else {
							return u32::MAX;
						};
						top.jux(&other)
					}
					21 => top.every(r.f64(), |p| p.rev()),
					22 => Ok(top.with_s(&r.text())),
					_ => return u32::MAX,
				}
			}
		};
		match out {
			Ok(pat) => stk.push(pat),
			Err(_) => return u32::MAX,
		}
	}
	let Some(top) = stk.pop() else {
		return u32::MAX;
	};
	PATTERNS.with(|all| {
		let mut all = all.borrow_mut();
		all.push(top);
		(all.len() - 1) as u32
	})
}

/// Queries cycles `from..to` of a pattern and writes five `f64`s a hap (part begin and end, whole begin and
/// end, number) into `out`, up to `cap` haps; returns the hap count written.
///
/// # Safety
///
/// `out..out+cap*5` `f64`s must be writable memory.
#[cfg(feature = "pattern")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn book(handle: u32, from: f64, to: f64, out: *mut f64, cap: usize) -> usize {
	PATTERNS.with(|all| {
		let all = all.borrow();
		let Some(pat) = all.get(handle as usize) else {
			return 0;
		};
		let span = Span::new(
			Fraction::from_int(from as i128),
			Fraction::from_int(to as i128),
		);
		let haps = pat.query(span);
		let out = unsafe { std::slice::from_raw_parts_mut(out, cap * 5) };
		for (hap, row) in haps.iter().zip(out.chunks_exact_mut(5)) {
			row[0] = hap.part.begin.to_f64();
			row[1] = hap.part.end.to_f64();
			row[2] = hap.whole.map_or(f64::NAN, |w| w.begin.to_f64());
			row[3] = hap.whole.map_or(f64::NAN, |w| w.end.to_f64());
			row[4] = hap.value.as_number().unwrap_or(f64::NAN);
		}
		haps.len().min(cap)
	})
}

/// One voice of the minimal renderer: a table-driven oscillator, an attack-release envelope, a one-pole
/// lowpass, and the pan law. Adds `frames` samples into the left and right buffers.
///
/// # Safety
///
/// `left` and `right` must each be `frames` writable `f32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn render(
	left: *mut f32,
	right: *mut f32,
	frames: usize,
	rate: f64,
	freq: f64,
	gain: f64,
	pan: f64,
	cutoff: f64,
) {
	let left = unsafe { std::slice::from_raw_parts_mut(left, frames) };
	let right = unsafe { std::slice::from_raw_parts_mut(right, frames) };
	let table = shaped_wave_table::<Libm>(ShapedWave::AbsSine);
	let gains = pan_law_gains::<Libm>(pan, -3.0);
	let a = (1.0 - (-2.0 * std::f64::consts::PI * cutoff / rate).exp()).clamp(0.0, 1.0);
	let (mut phase, mut lp) = (0.0f64, 0.0f64);
	for i in 0..frames {
		let env = (i as f64 / (frames as f64 * 0.1)).min(1.0) * (1.0 - i as f64 / frames as f64);
		let mut s = 0.0;
		for (k, c) in table.imag.iter().enumerate().take(8).skip(1) {
			s += *c as f64 * (phase * k as f64).sin();
		}
		lp += a * (s - lp);
		let v = lp * env * gain;
		left[i] += (v * gains.left) as f32;
		right[i] += (v * gains.right) as f32;
		phase += 2.0 * std::f64::consts::PI * freq / rate;
	}
}
