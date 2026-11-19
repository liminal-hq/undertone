// Encodes rendered audio as a WAV file: 16 or 24 bit PCM, or 32 bit float, up to 8 channels
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`encode_wav`], the port of `encodeWav` in `src/wav.ts`: the bytes of a `.wav` file, equal to the reference's for
//! the same samples and options.
//!
//! - **Formats:** 16 or 24 bit integer PCM, or 32 bit IEEE float ([`BitDepth`]). Integer samples are scaled
//!   (negative by 32768 or 8388608, positive by one less), rounded, and clamped, so an overrange sample clips; a
//!   float file keeps every sample as it is, overrange, `NaN`, and all. A `NaN` is written as 0 in an integer
//!   file.
//! - **Dither:** TPDF dither (the difference of two uniform random numbers, one least significant bit either
//!   side) is added before quantizing, for 16 bit only, and on by default. It is drawn from the seeded generator
//!   ([`seeded_random`]), so the same render always gives the same bytes. Pass `dither: Some(false)` for none.
//! - **Channels:** up to eight. More than two use `WAVE_FORMAT_EXTENSIBLE` with a speaker mask, by default the
//!   one for 1 (mono), 2, 4 (quad), 6 (5.1), or 8 (7.1) channels, and zero for the other counts. Undertone
//!   orders 7.1 as front left, front right, centre, LFE, side left, side right, rear left, rear right, but a WAV
//!   stores channels in speaker-mask bit order (the side and rear pairs swap), so the eight channels are
//!   reordered unless a `channel_mask` is given.
//! - **Header:** a 16 or 24 bit file with up to two channels has the plain 16 byte `fmt ` chunk; a float file
//!   adds a `fact` chunk with the frame count; the data chunk is padded to an even size.
//!
//! ```
//! use undertone_engine::wav::{BitDepth, WavOptions, encode_wav};
//!
//! // Two frames of stereo, 16 bit, no dither: a 44 byte header and eight bytes of samples.
//! let bytes = encode_wav(
//!     44_100.0,
//!     &[vec![0.0_f32, 0.5], vec![0.0, -0.5]],
//!     &WavOptions { dither: Some(false), ..WavOptions::default() },
//! )?;
//! assert_eq!(bytes.len(), 44 + 8);
//! assert_eq!(&bytes[0..4], b"RIFF");
//! assert_eq!(&bytes[8..12], b"WAVE");
//! // The right channel's second sample is -0.5 * 32768 = -16384.
//! assert_eq!(i16::from_le_bytes([bytes[50], bytes[51]]), -16384);
//!
//! // Float keeps the samples as they are.
//! let float = encode_wav(
//!     48_000.0,
//!     &[vec![0.25_f32, 2.0]],
//!     &WavOptions { bit_depth: BitDepth::ThirtyTwo, ..WavOptions::default() },
//! )?;
//! assert_eq!(f32::from_le_bytes([float[62], float[63], float[64], float[65]]), 2.0);
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::math::{js_max, js_min};
use undertone_pattern::js::round;
use undertone_pattern::random::{Seed, seeded_random, to_uint32};
use undertone_pattern::{Error, Result};

/// The sample format of a WAV file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BitDepth {
	/// 16 bit integer PCM (the default).
	#[default]
	Sixteen,
	/// 24 bit integer PCM.
	TwentyFour,
	/// 32 bit IEEE float.
	ThirtyTwo,
}

impl BitDepth {
	/// The bits in a sample.
	pub fn bits(self) -> u32 {
		match self {
			BitDepth::Sixteen => 16,
			BitDepth::TwentyFour => 24,
			BitDepth::ThirtyTwo => 32,
		}
	}
}

/// What [`encode_wav`] is asked: the reference's `WavOptions`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WavOptions {
	/// Sample format. Default 16 bit.
	pub bit_depth: BitDepth,
	/// Adds TPDF dither before quantizing. 16 bit only. Default true.
	pub dither: Option<bool>,
	/// Seed of the dither noise, so the same render always gives the same bytes. Default 0.
	pub seed: Option<Seed>,
	/// Speaker position mask for 3 to 8 channel files. Defaults follow the channel count.
	pub channel_mask: Option<u32>,
}

/// The default speaker mask for a channel count: mono, stereo, quad, 5.1, and 7.1; zero for the others.
fn default_mask(channels: usize) -> u32 {
	match channels {
		1 => 0x4,
		2 => 0x3,
		4 => 0x33,
		6 => 0x60f,
		8 => 0x63f,
		_ => 0,
	}
}

/// Undertone orders 7.1 as FL FR C LFE SL SR RL RR, but WAV stores channels in speaker-mask bit order
/// (FL FR FC LFE BL BR SL SR), so the side and rear pairs swap.
const WAV_8_CHANNEL_ORDER: [usize; 8] = [0, 1, 2, 3, 6, 7, 4, 5];

/// The largest data chunk a WAV file can hold.
const MAX_DATA_BYTES: u64 = 0xffff_ffff - 36;

/// The tail of the sub-format GUID after the format tag: the standard `KSDATAFORMAT` bytes.
const GUID_TAIL: [u8; 14] = [
	0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

fn put_u16(out: &mut [u8], at: usize, value: u16) {
	out[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut [u8], at: usize, value: u32) {
	out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// Encodes audio as a WAV file and returns its bytes. `channels` is one slice of samples per channel (a
/// `Vec<Vec<f32>>`, as a render gives, or `&[&[f32]]`), all of the same length.
///
/// The header's sample rate is the JavaScript number written as an unsigned 32 bit integer (a fraction is
/// truncated).
///
/// # Errors
///
/// Fails with the reference's message when there are no channels, more than eight, channels of different
/// lengths, or more audio than a WAV file holds (over 4 GiB).
pub fn encode_wav<C: AsRef<[f32]>>(
	sample_rate: f64,
	channels: &[C],
	options: &WavOptions,
) -> Result<Vec<u8>> {
	let channel_count = channels.len();
	let bit_depth = options.bit_depth;
	let is_float = bit_depth == BitDepth::ThirtyTwo;

	if channel_count == 0 {
		return Err(Error::new("encodeWav: the source has no channels"));
	}
	if channel_count > 8 {
		return Err(Error::new(format!(
			"encodeWav: {channel_count} channels is more than the 8 WAV supports here"
		)));
	}
	let frames = channels[0].as_ref().len();
	if channels.iter().any(|c| c.as_ref().len() != frames) {
		return Err(Error::new(
			"encodeWav: every channel must have the same length",
		));
	}

	let bits = bit_depth.bits() as usize;
	let bytes_per_sample = bits / 8;
	let data_size = frames as u64 * channel_count as u64 * bytes_per_sample as u64;
	if data_size > MAX_DATA_BYTES {
		return Err(Error::new(
			"encodeWav: the audio is too long for a WAV file (over 4 GiB)",
		));
	}
	let data_size = data_size as usize;

	let extensible = channel_count > 2;
	let mask = options
		.channel_mask
		.unwrap_or_else(|| default_mask(channel_count));
	let reorder = channel_count == 8 && options.channel_mask.is_none();
	let order: Vec<usize> = if reorder {
		WAV_8_CHANNEL_ORDER.to_vec()
	} else {
		(0..channel_count).collect()
	};

	let fmt_size = if extensible {
		40
	} else if is_float {
		18
	} else {
		16
	};
	let fact_size = if is_float { 12 } else { 0 };
	let pad = data_size % 2;
	let header_size = 12 + 8 + fmt_size + fact_size + 8;
	let mut out = vec![0_u8; header_size + data_size + pad];

	let format_tag: u16 = if is_float { 3 } else { 1 };
	out[0..4].copy_from_slice(b"RIFF");
	let riff_size = (out.len() - 8) as u32;
	put_u32(&mut out, 4, riff_size);
	out[8..12].copy_from_slice(b"WAVE");
	out[12..16].copy_from_slice(b"fmt ");
	put_u32(&mut out, 16, fmt_size as u32);
	put_u16(&mut out, 20, if extensible { 0xfffe } else { format_tag });
	put_u16(&mut out, 22, channel_count as u16);
	put_u32(&mut out, 24, to_uint32(sample_rate));
	put_u32(
		&mut out,
		28,
		to_uint32(sample_rate * channel_count as f64 * bytes_per_sample as f64),
	);
	put_u16(&mut out, 32, (channel_count * bytes_per_sample) as u16);
	put_u16(&mut out, 34, bits as u16);
	let mut pos = 36;
	if extensible {
		put_u16(&mut out, pos, 22); // cbSize
		put_u16(&mut out, pos + 2, bits as u16); // valid bits per sample
		put_u32(&mut out, pos + 4, mask);
		put_u16(&mut out, pos + 8, format_tag); // sub-format GUID: tag + the standard KSDATAFORMAT tail
		out[pos + 10..pos + 24].copy_from_slice(&GUID_TAIL);
		pos += 24;
	} else if is_float {
		put_u16(&mut out, pos, 0); // cbSize
		pos += 2;
	}
	if is_float {
		out[pos..pos + 4].copy_from_slice(b"fact");
		put_u32(&mut out, pos + 4, 4);
		put_u32(&mut out, pos + 8, frames as u32);
		pos += 12;
	}
	out[pos..pos + 4].copy_from_slice(b"data");
	put_u32(&mut out, pos + 4, data_size as u32);
	pos += 8;

	let dither = bit_depth == BitDepth::Sixteen && options.dither.unwrap_or(true);
	let mut random = dither.then(|| seeded_random(options.seed.clone().unwrap_or(Seed::Num(0.0))));
	let neg_scale = f64::from(1_u32 << (bits - 1));
	let pos_scale = neg_scale - 1.0;

	for frame in 0..frames {
		for &channel in &order {
			let sample = channels[channel].as_ref()[frame];
			if is_float {
				out[pos..pos + 4].copy_from_slice(&sample.to_le_bytes());
				pos += 4;
				continue;
			}
			let sample = f64::from(sample);
			let mut value = if sample < 0.0 {
				sample * neg_scale
			} else {
				sample * pos_scale
			};
			if let Some(random) = &mut random {
				// `random() - random()`: the left call is made first.
				let first = random.next_value();
				value += first - random.next_value();
			}
			// A `NaN` stays `NaN` through the clamp and is written as 0, as `setInt16(NaN)` and `NaN & 0xff` do.
			let value = js_max(-neg_scale, js_min(pos_scale, round(value))) as i32;
			if bit_depth == BitDepth::Sixteen {
				out[pos..pos + 2].copy_from_slice(&(value as i16).to_le_bytes());
				pos += 2;
			} else {
				out[pos] = (value & 0xff) as u8;
				out[pos + 1] = ((value >> 8) & 0xff) as u8;
				out[pos + 2] = ((value >> 16) & 0xff) as u8;
				pos += 3;
			}
		}
	}
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn plain() -> WavOptions {
		WavOptions {
			dither: Some(false),
			..WavOptions::default()
		}
	}

	#[test]
	fn a_mono_16_bit_file_has_the_canonical_header() {
		let bytes = encode_wav(48_000.0, &[vec![0.0_f32, 1.0, -1.0]], &plain()).unwrap();
		assert_eq!(bytes.len(), 44 + 6);
		assert_eq!(&bytes[36..40], b"data");
		assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 42);
		assert_eq!(
			u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
			96_000
		);
		let samples: Vec<i16> = bytes[44..]
			.chunks(2)
			.map(|b| i16::from_le_bytes([b[0], b[1]]))
			.collect();
		assert_eq!(samples, [0, 32767, -32768]);
	}

	#[test]
	fn nan_and_negative_zero_are_zero_and_overrange_clips() {
		let source = [vec![
			f32::NAN,
			-0.0,
			2.0,
			-2.0,
			f32::INFINITY,
			f32::NEG_INFINITY,
		]];
		let bytes = encode_wav(8000.0, &source, &plain()).unwrap();
		let samples: Vec<i16> = bytes[44..]
			.chunks(2)
			.map(|b| i16::from_le_bytes([b[0], b[1]]))
			.collect();
		assert_eq!(samples, [0, 0, 32767, -32768, 32767, -32768]);
	}

	#[test]
	fn the_same_seed_gives_the_same_dither_and_another_gives_another() {
		let source = [vec![0.0_f32; 16]];
		let a = encode_wav(8000.0, &source, &WavOptions::default()).unwrap();
		let b = encode_wav(8000.0, &source, &WavOptions::default()).unwrap();
		let c = encode_wav(
			8000.0,
			&source,
			&WavOptions {
				seed: Some(Seed::Num(1.0)),
				..WavOptions::default()
			},
		)
		.unwrap();
		assert_eq!(a, b);
		assert_ne!(a, c);
		// Dither is within one least significant bit either side.
		assert!(
			a[44..]
				.chunks(2)
				.all(|b| i16::from_le_bytes([b[0], b[1]]).abs() <= 1)
		);
	}

	#[test]
	fn seven_one_is_reordered_unless_a_mask_is_given() {
		let source: Vec<Vec<f32>> = (0..8).map(|c| vec![c as f32 / 16.0]).collect();
		let read = |bytes: &[u8]| -> Vec<i16> {
			bytes[68..]
				.chunks(2)
				.map(|b| i16::from_le_bytes([b[0], b[1]]))
				.collect()
		};
		let reordered = encode_wav(48_000.0, &source, &plain()).unwrap();
		let order: Vec<i16> = read(&reordered).iter().map(|v| (*v / 2048).abs()).collect();
		assert_eq!(order, [0, 1, 2, 3, 6, 7, 4, 5]);
		let kept = encode_wav(
			48_000.0,
			&source,
			&WavOptions {
				channel_mask: Some(0x63f),
				..plain()
			},
		)
		.unwrap();
		let order: Vec<i16> = read(&kept).iter().map(|v| (*v / 2048).abs()).collect();
		assert_eq!(order, [0, 1, 2, 3, 4, 5, 6, 7]);
	}

	#[test]
	fn the_errors_are_the_references() {
		let none: [Vec<f32>; 0] = [];
		assert_eq!(
			encode_wav(1.0, &none, &plain()).unwrap_err().message(),
			"encodeWav: the source has no channels"
		);
		assert_eq!(
			encode_wav(1.0, &vec![vec![0.0_f32]; 9], &plain())
				.unwrap_err()
				.message(),
			"encodeWav: 9 channels is more than the 8 WAV supports here"
		);
		assert_eq!(
			encode_wav(1.0, &[vec![0.0_f32; 2], vec![0.0]], &plain())
				.unwrap_err()
				.message(),
			"encodeWav: every channel must have the same length"
		);
	}
}
