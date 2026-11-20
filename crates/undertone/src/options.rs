// Builder-style options for a render and for a WAV file
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`RenderOptions`] and [`WavOptions`]: the options of an offline render and of a WAV file, with chained
//! setters.
//!
//! The engine's own option structs (`undertone::engine::render::RenderOptions` and
//! `undertone::engine::wav::WavOptions`) are plain data, every field an `Option` and every number an `f64` so
//! that a value the reference rejects (half a cycle, three channels) is rejected here with the reference's
//! message. These wrappers keep that behaviour and add what a program using them wants: a setter for each
//! field that takes anything that converts to the field's type (`.cycles(4)` and `.bpm(110)` work, as do
//! `.seed("level-1")` and `.seed(7.0)`), and the registry of samples a render plays (decoded PCM the host hands
//! over, decision D-30).
//!
//! Nothing here checks a value: the checks, with the reference's messages and in its order, run when the render
//! is planned, so one call reports the first mistake.

use crate::error::Result;
use undertone_engine::params::Pitch;
use undertone_engine::render::{MasterSetting, RenderOptions as EngineRenderOptions};
use undertone_engine::samples::{SampleData, Samples};
use undertone_engine::wav::{BitDepth, WavOptions as EngineWavOptions};
use undertone_pattern::random::Seed;

/// What an offline render is asked to do. Build one with [`RenderOptions::new`] (or `default()`) and chain
/// setters; every setting is optional and the defaults are the reference's.
///
/// ```
/// use undertone::prelude::*;
///
/// // Four cycles at 110 bpm, plus a second of tail so the last release rings out, in 24 bit.
/// let options = RenderOptions::new().cycles(4).bpm(110).tail(1).seed("level-1").sample_rate(22_050);
/// let audio = render(&note("c3 [e3 g3] <b3 a3> ~")?.sound("triangle").release(0.4)?, &options)?;
/// assert_eq!(audio.frames(), ((4.0 * 240.0 / 110.0 + 1.0) * 22_050.0f64).round() as usize);
/// # Ok::<(), undertone::Error>(())
/// ```
#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
	options: EngineRenderOptions,
	samples: Samples,
}

macro_rules! number_setters {
	($($(#[$doc:meta])* $name:ident),* $(,)?) => {
		$(
			$(#[$doc])*
			pub fn $name(mut self, value: impl Into<f64>) -> Self {
				self.options.$name = Some(value.into());
				self
			}
		)*
	};
}

impl RenderOptions {
	/// The default options: one two-second cycle at 120 bpm, 48000 Hz, stereo, through the master bus.
	pub fn new() -> Self {
		Self::default()
	}

	number_setters! {
		/// Whole pattern cycles to render (default 1). Pass this or [`seconds`](Self::seconds), not both.
		cycles,
		/// Seconds of the pattern to render: onsets at or after this time are dropped, and the pass ends at it.
		seconds,
		/// Tempo in beats per minute, four beats a cycle (default 120). Pass this or [`cps`](Self::cps).
		bpm,
		/// Tempo in cycles per second. Falls back to [`default_cpm`](Self::default_cpm), then to 120 bpm.
		cps,
		/// The sample rate of the render in hertz (default 48000).
		sample_rate,
		/// Output channels: 1, 2, 4, 6, or 8 (default 2). More than two uses discrete multichannel output.
		channels,
		/// Extra seconds rendered after the pattern, so releases and reverb can ring out (default 0).
		tail,
		/// Books the voices in windows of this many seconds instead of all up front (at least two render
		/// quanta, 256 frames). The audio is the same; a renderer that processes every node from the moment it is
		/// made does far less work.
		booking_window,
		/// The host's default tempo in cycles per minute (the reference's `setcpm()`), used when neither `bpm`
		/// nor `cps` is given. Rust has no global tempo, so the host holds it and passes it here (D-29).
		default_cpm,
	}

	/// Folds the tail onto the start, so the result loops without a gap and is exactly one pass long.
	pub fn wrap(mut self, wrap: bool) -> Self {
		self.options.wrap = Some(wrap);
		self
	}

	/// Holds each note for its share of the cycle, like a loop (the default). `false` is a one-shot, as `play`.
	pub fn gated(mut self, gated: bool) -> Self {
		self.options.gated = Some(gated);
		self
	}

	/// Seeds noise and reverb, so the same inputs give the same samples (default 0). Takes a number or a text.
	pub fn seed(mut self, seed: impl Into<Seed>) -> Self {
		self.options.seed = Some(seed.into());
		self
	}

	/// The master bus and its limiter: [`MasterSetting::On`] (the default), [`MasterSetting::Off`] for the raw
	/// mix, or [`MasterSetting::Tuned`] with a gain, limiter, and ceiling.
	pub fn master(mut self, master: MasterSetting) -> Self {
		self.options.master = Some(master);
		self
	}

	/// Registers decoded PCM that sample voices play, under `name`, with the pitch it sounds at (`None` means
	/// `c4`). Replaces an earlier recording of the same name.
	///
	/// # Errors
	///
	/// A recording with no channels, no frames, channels of different lengths, an out-of-range sample rate, or
	/// too many samples, and a base note that is not a note name or a positive frequency.
	pub fn register_sample(
		&mut self,
		name: impl Into<String>,
		data: SampleData,
		base_note: Option<Pitch>,
	) -> Result<&mut Self> {
		self.samples.register_sample(name, data, base_note)?;
		Ok(self)
	}

	/// Uses a whole registry of samples, replacing any registered so far.
	pub fn samples(mut self, samples: Samples) -> Self {
		self.samples = samples;
		self
	}

	/// The engine's options, for a host that plans the render itself (`RenderPlan::new` in the engine crate).
	pub fn engine_options(&self) -> &EngineRenderOptions {
		&self.options
	}

	/// The samples the render plays.
	pub fn sample_registry(&self) -> &Samples {
		&self.samples
	}

	pub(crate) fn into_parts(self) -> (EngineRenderOptions, Samples) {
		(self.options, self.samples)
	}
}

impl From<EngineRenderOptions> for RenderOptions {
	fn from(options: EngineRenderOptions) -> Self {
		RenderOptions {
			options,
			samples: Samples::default(),
		}
	}
}

/// How a WAV file is written. Build one with [`WavOptions::new`] (or `default()`) and chain setters.
///
/// ```
/// use undertone::prelude::*;
///
/// let audio = render(&note("c4")?, &RenderOptions::new().sample_rate(8_000))?;
/// let wav = audio.to_wav(&WavOptions::new().bit_depth(BitDepth::TwentyFour))?;
/// assert_eq!(&wav[0..4], b"RIFF");
/// assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 24); // bits per sample
/// # Ok::<(), undertone::Error>(())
/// ```
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WavOptions {
	options: EngineWavOptions,
}

impl WavOptions {
	/// The defaults: 16 bit with dither, and the speaker mask that follows the channel count.
	pub fn new() -> Self {
		Self::default()
	}

	/// The sample format: 16 bit (the default), 24 bit, or 32 bit float.
	pub fn bit_depth(mut self, bit_depth: BitDepth) -> Self {
		self.options.bit_depth = bit_depth;
		self
	}

	/// Adds TPDF dither before quantizing (16 bit only; default on).
	pub fn dither(mut self, dither: bool) -> Self {
		self.options.dither = Some(dither);
		self
	}

	/// Seeds the dither noise, so the same render always gives the same bytes (default 0).
	pub fn seed(mut self, seed: impl Into<Seed>) -> Self {
		self.options.seed = Some(seed.into());
		self
	}

	/// The speaker position mask for 3 to 8 channel files (the default follows the channel count).
	pub fn channel_mask(mut self, mask: u32) -> Self {
		self.options.channel_mask = Some(mask);
		self
	}

	/// The engine's options, for [`encode_wav`](undertone_engine::wav::encode_wav).
	pub fn engine_options(&self) -> &EngineWavOptions {
		&self.options
	}
}

impl From<EngineWavOptions> for WavOptions {
	fn from(options: EngineWavOptions) -> Self {
		WavOptions { options }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn setters_fill_the_engine_options_and_nothing_else() {
		let options = RenderOptions::new()
			.cycles(4)
			.bpm(110)
			.sample_rate(44_100)
			.channels(1)
			.tail(0.5)
			.wrap(true)
			.gated(false)
			.seed("a")
			.booking_window(1)
			.default_cpm(30)
			.master(MasterSetting::Off);
		let engine = options.engine_options();
		assert_eq!(engine.cycles, Some(4.0));
		assert_eq!(engine.bpm, Some(110.0));
		assert_eq!(engine.sample_rate, Some(44_100.0));
		assert_eq!(engine.channels, Some(1.0));
		assert_eq!(engine.tail, Some(0.5));
		assert_eq!(engine.wrap, Some(true));
		assert_eq!(engine.gated, Some(false));
		assert_eq!(engine.seed, Some(Seed::Str("a".into())));
		assert_eq!(engine.booking_window, Some(1.0));
		assert_eq!(engine.default_cpm, Some(30.0));
		assert_eq!(engine.master, Some(MasterSetting::Off));
		assert_eq!(engine.seconds, None);
		assert_eq!(engine.cps, None);
	}

	#[test]
	fn nothing_is_checked_until_the_render_is_planned() {
		let options = RenderOptions::new().cycles(1.5).seconds(2);
		assert_eq!(options.engine_options().cycles, Some(1.5));
	}

	#[test]
	fn wav_setters_fill_the_engine_options() {
		let options = WavOptions::new()
			.bit_depth(BitDepth::ThirtyTwo)
			.dither(false)
			.seed(3.0)
			.channel_mask(0x3);
		let engine = options.engine_options();
		assert_eq!(engine.bit_depth, BitDepth::ThirtyTwo);
		assert_eq!(engine.dither, Some(false));
		assert_eq!(engine.seed, Some(Seed::Num(3.0)));
		assert_eq!(engine.channel_mask, Some(3));
	}
}
