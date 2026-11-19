// Offline rendering: a pattern to samples to a WAV file, in one call each
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`render`], [`render_score`], and [`render_to_wav`]: the whole offline path, a pattern (or a score) through
//! the render plan and the in-house renderer to samples, and on to the bytes of a WAV file.
//!
//! These are the Rust form of `renderToBuffer(pattern, options)` followed by `encodeWav` in the TypeScript. A
//! render has no clock: every onset of the pattern is turned into a voice, booked on a
//! [`RenderGraph`], and the graph renders, so the same pattern,
//! options, and seed give the same samples on every machine.
//!
//! The tempo is an explicit part of the options (`bpm`, `cps`, or `default_cpm`), never a global (decision
//! D-29). Samples a pattern plays are registered on the options (decision D-30).

use crate::error::{Error, Result};
use crate::options::{RenderOptions, WavOptions};
use undertone_engine::render::RenderPlan;
use undertone_engine::render_graph::RenderGraph;
use undertone_engine::samples::Samples;
use undertone_engine::score::Score;
use undertone_engine::wav::encode_wav;
use undertone_pattern::{ControlMap, Pattern};

/// The samples of a finished render, one `Vec<f32>` per channel, with the sample rate they were rendered at.
///
/// Turn it into the bytes of a WAV file with [`RenderedAudio::to_wav`], or read the channels
/// ([`RenderedAudio::channels`]) to send them anywhere else.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedAudio {
	sample_rate: f64,
	channels: Vec<Vec<f32>>,
}

impl RenderedAudio {
	/// Audio from channels already rendered, one `Vec` per channel, at `sample_rate` hertz.
	///
	/// # Errors
	///
	/// Fails with the reference's `encodeWav` message when the channels are not all the same length, so a
	/// `RenderedAudio` always holds a rectangle of samples and [`RenderedAudio::interleaved`] cannot index past
	/// the end of a channel. No channels at all is allowed here; [`RenderedAudio::to_wav`] refuses it.
	///
	/// ```
	/// use undertone::prelude::*;
	///
	/// let audio = RenderedAudio::new(8_000.0, vec![vec![0.0, 0.5], vec![0.0, -0.5]])?;
	/// assert_eq!(audio.interleaved(), [0.0, 0.0, 0.5, -0.5]);
	/// let uneven = RenderedAudio::new(8_000.0, vec![vec![0.0, 0.0], vec![0.0]]);
	/// assert_eq!(uneven.unwrap_err().message(), "encodeWav: every channel must have the same length");
	/// # Ok::<(), undertone::Error>(())
	/// ```
	pub fn new(sample_rate: f64, channels: Vec<Vec<f32>>) -> Result<Self> {
		let frames = channels.first().map_or(0, Vec::len);
		if channels.iter().any(|channel| channel.len() != frames) {
			return Err(Error::new(
				"encodeWav: every channel must have the same length",
			));
		}
		Ok(RenderedAudio {
			sample_rate,
			channels,
		})
	}

	/// The sample rate in hertz.
	pub fn sample_rate(&self) -> f64 {
		self.sample_rate
	}

	/// The samples of each channel, in the engine's channel order.
	pub fn channels(&self) -> &[Vec<f32>] {
		&self.channels
	}

	/// Takes the channels out.
	pub fn into_channels(self) -> Vec<Vec<f32>> {
		self.channels
	}

	/// How many channels.
	pub fn channel_count(&self) -> usize {
		self.channels.len()
	}

	/// How many frames (samples per channel).
	pub fn frames(&self) -> usize {
		self.channels.first().map_or(0, Vec::len)
	}

	/// The length in seconds.
	pub fn seconds(&self) -> f64 {
		self.frames() as f64 / self.sample_rate
	}

	/// The largest absolute sample over every channel.
	pub fn peak(&self) -> f32 {
		self.channels
			.iter()
			.flatten()
			.fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
	}

	/// The samples interleaved frame by frame (`L R L R ...` for stereo), the layout most audio devices take.
	pub fn interleaved(&self) -> Vec<f32> {
		let mut out = Vec::with_capacity(self.frames() * self.channels.len());
		for frame in 0..self.frames() {
			for channel in &self.channels {
				out.push(channel[frame]);
			}
		}
		out
	}

	/// Encodes the audio as a WAV file and returns its bytes (`encodeWav`).
	///
	/// # Errors
	///
	/// Fails with the reference's message when there are no channels, more than eight, or more audio than a WAV
	/// file holds (over 4 GiB). Channels of different lengths cannot get this far: [`RenderedAudio::new`] refuses them.
	///
	/// ```
	/// use undertone::prelude::*;
	///
	/// let audio = RenderedAudio::new(8_000.0, vec![vec![0.0, 0.5, -0.5, 0.0]])?;
	/// let wav = audio.to_wav(&WavOptions::new().bit_depth(BitDepth::ThirtyTwo))?;
	/// assert_eq!(&wav[8..12], b"WAVE");
	/// # Ok::<(), undertone::Error>(())
	/// ```
	pub fn to_wav(&self, options: &WavOptions) -> Result<Vec<u8>> {
		Ok(encode_wav(
			self.sample_rate,
			&self.channels,
			options.engine_options(),
		)?)
	}
}

/// Renders a pattern offline to samples (`renderToBuffer`).
///
/// A pass is `cycles` whole cycles (or `seconds`) at the tempo from `bpm` or `cps` (120 bpm, two seconds a
/// cycle, when neither is given), plus an optional `tail`. Notes are gated by their event's length, as in a
/// loop, unless `gated(false)`.
///
/// # Errors
///
/// An option the reference rejects fails with its message, in its order (see
/// [`RenderPlan::new`](undertone_engine::render::RenderPlan::new)); a pattern that fails when queried, a voice
/// that fails to book, and a render over the engine's bounds (1,048,576 cycles, 268,435,456 frames) fail the
/// same way.
///
/// ```
/// use undertone::prelude::*;
///
/// let pattern = note("c4 e4 g4 b4")?.sound("triangle");
/// let audio = render(&pattern, &RenderOptions::new().cycles(1).sample_rate(8_000))?;
/// assert_eq!((audio.channel_count(), audio.frames()), (2, 16_000));
/// assert!(audio.peak() > 0.01);
/// # Ok::<(), undertone::Error>(())
/// ```
pub fn render(pattern: &Pattern<ControlMap>, options: &RenderOptions) -> Result<RenderedAudio> {
	let (engine_options, samples) = options.clone().into_parts();
	let plan = RenderPlan::new(&engine_options)?;
	render_planned(&plan, samples, pattern)
}

/// Renders one pass of a [`Score`] at its own tempo (`score(...).render()`).
///
/// The score's tempo replaces any in the options, so leave `bpm`, `cps`, and `seconds` out (giving `bpm` fails
/// with "Pass either bpm or cps, not both"). Add a `tail` to let releases ring out, or `wrap` it for a seamless
/// loop.
///
/// # Errors
///
/// As [`render`].
///
/// ```
/// use undertone::prelude::*;
///
/// let cue = Score::new(&ScoreDefinition {
///     ticks_per_second: 100.0,
///     length_ticks: 100.0,
///     events: vec![ScoreEvent::note(0.0, ScoreNote::Name("e4".into()))],
///     ..ScoreDefinition::default()
/// })?;
/// let audio = render_score(&cue, &RenderOptions::new().sample_rate(8_000))?;
/// assert_eq!(audio.frames(), 8_000); // one second: 100 ticks at 100 ticks a second
/// # Ok::<(), undertone::Error>(())
/// ```
pub fn render_score(score: &Score, options: &RenderOptions) -> Result<RenderedAudio> {
	let (engine_options, samples) = options.clone().into_parts();
	let plan = score.render_plan(&engine_options)?;
	render_planned(&plan, samples, score.pattern())
}

/// Renders a pattern and encodes it as a WAV file in one call: the pattern, the plan, the renderer, the samples,
/// and the bytes (`pattern.render(options)` then `encodeWav`).
///
/// # Errors
///
/// As [`render`] and [`RenderedAudio::to_wav`].
///
/// ```
/// use undertone::prelude::*;
///
/// let pattern = note("c3 [e3 g3] <b3 a3> ~")?.sound("triangle").release(0.4)?;
/// let wav = render_to_wav(
///     &pattern,
///     &RenderOptions::new().cycles(2).bpm(110).tail(1).sample_rate(8_000),
///     &WavOptions::new().bit_depth(BitDepth::TwentyFour),
/// )?;
/// assert_eq!(&wav[0..4], b"RIFF");
/// # Ok::<(), undertone::Error>(())
/// ```
pub fn render_to_wav(
	pattern: &Pattern<ControlMap>,
	options: &RenderOptions,
	wav: &WavOptions,
) -> Result<Vec<u8>> {
	render(pattern, options)?.to_wav(wav)
}

/// Books `pattern` on a renderer made for `plan` and renders it.
fn render_planned(
	plan: &RenderPlan,
	samples: Samples,
	pattern: &Pattern<ControlMap>,
) -> Result<RenderedAudio> {
	let graph = RenderGraph::try_new(plan.sample_rate, plan.channels, plan.length as u64)?;
	let mut rendered: Vec<Vec<f32>> = vec![Vec::new(); plan.channels as usize];
	// Without a booking window the render is never paused. With one, each pause renders up to where the next
	// window's voices start, so the renderer has not yet processed a node that is booked later.
	let engine = plan.book_pattern_with_samples(graph, samples, pattern, |graph, seconds| {
		let frames = (seconds * plan.sample_rate).round() as usize;
		render_until(graph, &mut rendered, frames);
		Ok(())
	})?;
	let mut graph = engine.into_graph();
	render_until(&mut graph, &mut rendered, plan.length);
	Ok(RenderedAudio {
		sample_rate: plan.sample_rate,
		channels: plan.finish(rendered),
	})
}

/// Renders the graph on until `rendered` holds `frames` frames of each channel.
fn render_until(graph: &mut RenderGraph, rendered: &mut [Vec<f32>], frames: usize) {
	let have = rendered.first().map_or(0, Vec::len);
	if frames <= have {
		return;
	}
	let mut block = vec![vec![0.0_f32; frames - have]; rendered.len()];
	let mut slices: Vec<&mut [f32]> = block.iter_mut().map(Vec::as_mut_slice).collect();
	let written = graph.render_block(&mut slices);
	for (channel, rendered_block) in rendered.iter_mut().zip(&block) {
		channel.extend_from_slice(&rendered_block[..written]);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::prelude::*;

	fn small() -> RenderOptions {
		RenderOptions::new().sample_rate(8_000).channels(2)
	}

	fn tune() -> Pattern<ControlMap> {
		note("c4 e4 g4 [b4 d5]")
			.unwrap()
			.sound("triangle")
			.release(0.2)
			.unwrap()
	}

	#[test]
	fn the_audio_has_the_planned_length_and_is_not_silent() {
		let audio = render(&tune(), &small().cycles(2).tail(0.5)).unwrap();
		assert_eq!(audio.sample_rate(), 8_000.0);
		assert_eq!(audio.frames(), ((2.0 * 2.0 + 0.5) * 8_000.0) as usize);
		assert_eq!(audio.channel_count(), 2);
		assert!(audio.peak() > 0.05 && audio.peak() <= 1.0);
		assert!(audio.channels().iter().flatten().all(|s| s.is_finite()));
	}

	#[test]
	fn the_same_options_and_seed_give_the_same_samples() {
		let noisy = sound("white*4").unwrap().decay(0.05).unwrap();
		let a = render(&noisy, &small().seed("x")).unwrap();
		let b = render(&noisy, &small().seed("x")).unwrap();
		let c = render(&noisy, &small().seed("y")).unwrap();
		assert_eq!(a, b);
		assert_ne!(a, c);
	}

	#[test]
	fn a_booking_window_gives_the_same_samples_as_booking_up_front() {
		let song = tune();
		let up_front = render(&song, &small().cycles(4).tail(1.0)).unwrap();
		let windowed = render(&song, &small().cycles(4).tail(1.0).booking_window(1)).unwrap();
		assert_eq!(up_front, windowed);
	}

	#[test]
	fn wrap_makes_the_file_one_pass_long() {
		let audio = render(&tune(), &small().cycles(1).tail(1.0).wrap(true)).unwrap();
		assert_eq!(audio.frames(), 16_000);
	}

	#[test]
	fn a_bad_option_fails_with_the_references_message() {
		let error = render(&tune(), &small().cycles(1.5)).unwrap_err();
		assert_eq!(
			error.message(),
			"cycles must be a positive whole number, got 1.5"
		);
		let error = render(&tune(), &small().bpm(120).cps(1)).unwrap_err();
		assert_eq!(error.message(), "Pass either bpm or cps, not both");
	}

	#[test]
	fn a_registered_sample_is_heard() {
		let mut options = small().seconds(1);
		options
			.register_sample("blip", SampleData::new(8_000.0, vec![vec![0.5; 800]]), None)
			.unwrap();
		let heard = render(&s("blip").unwrap(), &options).unwrap();
		assert!(heard.peak() > 0.05);
		// The same pattern with no sample registered is skipped, so it is silent.
		let silent = render(&s("blip").unwrap(), &small().seconds(1)).unwrap();
		assert_eq!(silent.peak(), 0.0);
	}

	#[test]
	fn a_bad_sample_fails_at_registration() {
		let mut options = RenderOptions::new();
		let error = options
			.register_sample("empty", SampleData::new(8_000.0, vec![]), None)
			.map(|_| ())
			.unwrap_err();
		assert_eq!(error.message(), "Sample \"empty\" has no channels.");
	}

	#[test]
	fn a_score_renders_at_its_own_tempo() {
		let cue = Score::new(&ScoreDefinition {
			ticks_per_second: 100.0,
			length_ticks: 200.0,
			events: vec![ScoreEvent::note(0.0, ScoreNote::Name("a3".into()))],
			..ScoreDefinition::default()
		})
		.unwrap();
		let audio = render_score(&cue, &small()).unwrap();
		assert_eq!(audio.frames(), 16_000);
		assert!(audio.peak() > 0.01);
		let error = render_score(&cue, &small().bpm(120)).unwrap_err();
		assert_eq!(error.message(), "Pass either bpm or cps, not both");
	}

	#[test]
	fn the_wav_has_the_renders_format_and_length() {
		let wav = render_to_wav(
			&tune(),
			&small().cycles(1),
			&WavOptions::new().bit_depth(BitDepth::Sixteen),
		)
		.unwrap();
		assert_eq!(&wav[0..4], b"RIFF");
		assert_eq!(&wav[8..16], b"WAVEfmt ");
		assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 2); // channels
		assert_eq!(
			u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
			8_000
		);
		assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
		assert_eq!(wav.len(), 44 + 16_000 * 2 * 2);
	}

	#[test]
	fn interleaving_walks_frame_by_frame() {
		let audio = RenderedAudio::new(1.0, vec![vec![1.0, 2.0], vec![3.0, 4.0]]).unwrap();
		assert_eq!(audio.interleaved(), [1.0, 3.0, 2.0, 4.0]);
		assert_eq!(audio.seconds(), 2.0);
	}

	#[test]
	fn uneven_channels_are_refused_at_construction() {
		let error = RenderedAudio::new(8_000.0, vec![vec![0.0, 0.0], vec![0.0]]).unwrap_err();
		assert_eq!(error.kind(), ErrorKind::Invalid);
		assert_eq!(
			error.message(),
			"encodeWav: every channel must have the same length"
		);
		assert!(RenderedAudio::new(8_000.0, vec![vec![0.0; 3], vec![0.0; 4]]).is_err());
		assert!(RenderedAudio::new(8_000.0, vec![vec![0.0], vec![]]).is_err());
		// Even rectangles, including none and empty ones, are fine and interleave without a panic.
		assert!(
			RenderedAudio::new(8_000.0, vec![])
				.unwrap()
				.interleaved()
				.is_empty()
		);
		let silent = RenderedAudio::new(8_000.0, vec![vec![], vec![]]).unwrap();
		assert!(silent.interleaved().is_empty());
		assert_eq!(silent.frames(), 0);
	}

	#[test]
	fn no_channels_are_refused_by_the_encoder() {
		let audio = RenderedAudio::new(8_000.0, vec![]).unwrap();
		assert!(audio.to_wav(&WavOptions::new()).is_err());
	}
}
