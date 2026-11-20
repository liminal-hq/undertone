// The sample registry: decoded PCM by name, with the base note each recording sounds at
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Samples`], the registry of `src/samples.ts`: `registerSample`, `registerSamples`, `loadSamples`,
//! `getSampleBuffer`, `getSampleBaseNote`, `isSampleRegistered`, and `clearSamples`.
//!
//! **Decoding stays with the host.** The TypeScript registry takes a URL, encoded bytes, or an
//! already-decoded buffer, and decodes with the context's `decodeAudioData`. Rust has no decoder (D-30):
//! a caller hands over **decoded PCM** as [`SampleData`], one `Vec<f32>` per channel at the recording's own
//! sample rate. A browser bridge decodes with `decodeAudioData` and passes the channels through; a native host
//! decodes a file with whatever it likes. The two-step flow of the reference survives for a host that decodes
//! later: [`Samples::register_pending_sample`] registers a name and its base note (as `registerSample(name,
//! url)` does) and [`Samples::load_samples`] hands over the PCM once it is decoded (as `loadSamples` does). A
//! pending sample is registered but not available, so a voice that names it is skipped without a warning,
//! exactly as the reference skips an onset whose sample is still decoding.
//!
//! **There is no global registry.** The reference keeps one process-wide registry; here a [`Samples`] is a
//! value, owned by the [`Engine`](crate::engine::Engine) that plays from it
//! ([`Engine::samples_mut`](crate::engine::Engine::samples_mut)) or handed to a render
//! ([`RenderPlan::book_pattern_with_samples`](crate::render::RenderPlan::book_pattern_with_samples)). A
//! bridge that wants the JavaScript globals holds one `Samples` and clones it into each engine; a clone shares
//! the PCM (it is reference counted), so it is cheap.
//!
//! ```
//! use undertone_engine::engine::{Engine, OutputSetup};
//! use undertone_engine::graph::LogGraph;
//! use undertone_engine::params::{Pitch, VoiceParams};
//! use undertone_engine::samples::{SampleData, Samples};
//!
//! // A tiny decoded recording: mono, 44.1 kHz, sounding at a3.
//! let kick = SampleData {
//!     sample_rate: 44_100.0,
//!     channels: vec![vec![0.0, 0.5, 1.0, 0.5, 0.0, -0.5, -1.0, -0.5]],
//! };
//! let mut samples = Samples::default();
//! samples.register_sample("kick", kick, Some(Pitch::Name("a3".into())))?;
//! assert!(samples.is_sample_registered("kick", None));
//!
//! let mut engine = Engine::new(LogGraph::new(44_100.0, 2), OutputSetup::default())?;
//! *engine.samples_mut() = samples;
//!
//! // A pitched event an octave above the base note plays at twice the speed.
//! let voice = VoiceParams {
//!     sample_name: Some("kick".into()),
//!     pitch: Some(Pitch::Name("a4".into())),
//!     ..VoiceParams::empty()
//! };
//! engine.play(&voice, 0.0)?;
//!
//! let record = engine.into_graph().finish(None);
//! assert_eq!(record.nodes[2].kind, "bufferSource");
//! assert!(record.to_json("").contains(r#""playbackRate":["set 2 @0"]"#));
//! # Ok::<(), undertone_pattern::Error>(())
//! ```

use crate::params::Pitch;
use crate::render_graph::{MAX_BUFFER_SAMPLES, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use undertone_pattern::js::number_to_string;
use undertone_pattern::pitch::note_to_frequency;
use undertone_pattern::{Error, Result};

/// A decoded recording: PCM samples, one `Vec<f32>` per channel, at the recording's own sample rate.
///
/// The recording does not have to match the sample rate of the graph it plays on: a buffer source plays it at
/// `playback_rate * sample_rate / graph_rate` frames per output frame, as Web Audio does. All channels must
/// have the same, non-zero length, and there must be at least one channel; [`Samples`] checks this when it
/// takes the data.
#[derive(Debug, Clone, PartialEq)]
pub struct SampleData {
	/// The recording's sample rate in hertz (`AudioBuffer.sampleRate`).
	pub sample_rate: f64,
	/// The samples of each channel (`AudioBuffer.getChannelData(channel)`).
	pub channels: Vec<Vec<f32>>,
}

impl SampleData {
	/// Decoded PCM at `sample_rate` hertz, one `Vec` per channel.
	pub fn new(sample_rate: f64, channels: Vec<Vec<f32>>) -> Self {
		Self {
			sample_rate,
			channels,
		}
	}

	/// How many frames (samples per channel) the recording has.
	pub fn frames(&self) -> usize {
		self.channels.first().map_or(0, Vec::len)
	}

	/// Checks what Web Audio's `createBuffer` would insist on, so that a bad recording fails when it is handed
	/// over rather than when a voice is booked.
	fn validate(&self, name: &str) -> Result<()> {
		let bad = |what: &str| Error::new(format!("Sample \"{name}\" has {what}."));
		if self.channels.is_empty() {
			return Err(bad("no channels"));
		}
		if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&self.sample_rate) {
			return Err(bad(&format!(
				"an invalid sample rate: {} (from {} to {} Hz)",
				number_to_string(self.sample_rate),
				number_to_string(MIN_SAMPLE_RATE),
				number_to_string(MAX_SAMPLE_RATE)
			)));
		}
		let frames = self.frames();
		if frames == 0 {
			return Err(bad("no frames"));
		}
		if self.channels.iter().any(|channel| channel.len() != frames) {
			return Err(bad("channels of different lengths"));
		}
		if !fits_in_a_buffer(self.channels.len(), frames) {
			return Err(bad(&format!(
				"too many samples: {} channels of {frames} frames, at most {MAX_BUFFER_SAMPLES} in all",
				self.channels.len()
			)));
		}
		Ok(())
	}
}

/// Whether `channels` of `frames` frames fit in one graph buffer ([`MAX_BUFFER_SAMPLES`] samples in all).
fn fits_in_a_buffer(channels: usize, frames: usize) -> bool {
	frames
		.checked_mul(channels.max(1))
		.is_some_and(|total| total <= MAX_BUFFER_SAMPLES)
}

/// One sample to register in bulk ([`Samples::register_samples`]): the PCM and, optionally, the pitch the
/// recording sounds at (the TypeScript `SampleSource` with its `buffer` and `baseNote`).
#[derive(Debug, Clone, PartialEq)]
pub struct SampleSource {
	/// The decoded recording.
	pub data: SampleData,
	/// The pitch the recording actually sounds at; `None` means `c4`.
	pub base_note: Option<Pitch>,
}

#[derive(Debug, Clone)]
struct Entry {
	/// `None` while the host has not handed over the decoded PCM yet.
	data: Option<Arc<SampleData>>,
	base_note: Option<Pitch>,
}

/// The sample registry. See the module documentation.
#[derive(Debug, Clone, Default)]
pub struct Samples {
	entries: HashMap<String, Entry>,
	/// The names already warned about, which `clear_samples` forgets (the reference's `warned`).
	warned: HashSet<String>,
}

/// Validates a base note eagerly, as the reference does at registration, so a typo fails here and not inside
/// a booking.
fn check_base_note(base_note: &Option<Pitch>) -> Result<()> {
	match base_note {
		Some(Pitch::Name(name)) => note_to_frequency(name.as_str()).map(|_| ()),
		Some(Pitch::Hz(hz)) => note_to_frequency(*hz).map(|_| ()),
		None => Ok(()),
	}
}

impl Samples {
	/// An empty registry.
	pub fn new() -> Self {
		Self::default()
	}

	/// Registers decoded PCM under `name` (`registerSample`), replacing any earlier registration of the name.
	/// `base_note` is the pitch the recording sounds at; a pitched event that plays the sample uses
	/// `frequency(pitch) / frequency(base_note)` as its playback rate, and `None` means `c4`.
	///
	/// # Errors
	///
	/// A `base_note` that is not a note name or a positive frequency fails with the reference's message, and a
	/// recording with no channels, no frames, channels of different lengths, a sample rate outside the
	/// renderer's bounds (1 to 1,000,000 Hz), or more samples in all than one graph buffer holds (2^28) is
	/// refused, so a registered sample never makes booking panic. Nothing is registered on failure.
	pub fn register_sample(
		&mut self,
		name: impl Into<String>,
		data: SampleData,
		base_note: Option<Pitch>,
	) -> Result<()> {
		let name = name.into();
		check_base_note(&base_note)?;
		data.validate(&name)?;
		self.entries.insert(
			name,
			Entry {
				data: Some(Arc::new(data)),
				base_note,
			},
		);
		Ok(())
	}

	/// Registers many samples at once (`registerSamples`), in the order given. As in the reference, a sample
	/// that fails stops the loop and the ones before it stay registered.
	///
	/// # Errors
	///
	/// As [`Samples::register_sample`], for the first sample that fails.
	pub fn register_samples(
		&mut self,
		samples: impl IntoIterator<Item = (String, SampleSource)>,
	) -> Result<()> {
		for (name, source) in samples {
			self.register_sample(name, source.data, source.base_note)?;
		}
		Ok(())
	}

	/// Registers a name whose PCM the host will hand over later with [`Samples::load_samples`], with the pitch
	/// it will sound at (the reference's `registerSample(name, url)`). The name counts as registered
	/// ([`Samples::is_sample_registered`]) but its buffer is not available, so a voice that names it is skipped,
	/// without a warning, until the PCM arrives.
	///
	/// # Errors
	///
	/// A `base_note` that is not a note name or a positive frequency.
	pub fn register_pending_sample(
		&mut self,
		name: impl Into<String>,
		base_note: Option<Pitch>,
	) -> Result<()> {
		check_base_note(&base_note)?;
		self.entries.insert(
			name.into(),
			Entry {
				data: None,
				base_note,
			},
		);
		Ok(())
	}

	/// Hands over the decoded PCM of registered samples (`loadSamples`, with the decoding done by the host): a
	/// name to its recording. Each name keeps the base note it was registered with. Every name must be
	/// registered ([`Samples::register_sample`] or [`Samples::register_pending_sample`]) and every recording
	/// valid, or nothing is changed.
	///
	/// # Errors
	///
	/// A name that was never registered fails with the reference's message, `Sample "x" is not registered. Call
	/// registerSample() first.`, and an invalid recording as in [`Samples::register_sample`].
	pub fn load_samples(
		&mut self,
		decoded: impl IntoIterator<Item = (String, SampleData)>,
	) -> Result<()> {
		let decoded: Vec<(String, SampleData)> = decoded.into_iter().collect();
		for (name, data) in &decoded {
			if !self.entries.contains_key(name) {
				return Err(Error::new(format!(
					"Sample \"{name}\" is not registered. Call registerSample() first."
				)));
			}
			data.validate(name)?;
		}
		for (name, data) in decoded {
			if let Some(entry) = self.entries.get_mut(&name) {
				entry.data = Some(Arc::new(data));
			}
		}
		Ok(())
	}

	/// The key `name` is registered under, trying `{bank}_{name}` first when a bank is given
	/// (`resolveRegisteredKey`): `.bank(name)` is a lookup convention, not a loader.
	pub fn resolve_registered_key(&self, name: &str, bank: Option<&str>) -> Option<String> {
		if let Some(bank) = bank {
			let banked = format!("{bank}_{name}");
			if self.entries.contains_key(&banked) {
				return Some(banked);
			}
		}
		self.entries.contains_key(name).then(|| name.to_string())
	}

	/// The key a lookup uses: the registered one, else the bare name (which then fails).
	pub(crate) fn lookup_key(&self, name: &str, bank: Option<&str>) -> String {
		self.resolve_registered_key(name, bank)
			.unwrap_or_else(|| name.to_string())
	}

	/// The decoded recording of a sample, or `None` when the name is unregistered or its PCM has not arrived
	/// (`getSampleBuffer`; the reference also warns and starts a decode, which the engine does when it books).
	pub fn get_sample_buffer(&self, name: &str, bank: Option<&str>) -> Option<&SampleData> {
		self.entry_data(&self.lookup_key(name, bank))
			.map(|data| &**data)
	}

	pub(crate) fn entry_data(&self, key: &str) -> Option<&Arc<SampleData>> {
		self.entries.get(key).and_then(|entry| entry.data.as_ref())
	}

	/// Whether `key` is registered at all, with or without its PCM.
	pub(crate) fn has_entry(&self, key: &str) -> bool {
		self.entries.contains_key(key)
	}

	/// The base note a sample was registered with (`getSampleBaseNote`), or `None` if it set none or is
	/// unregistered.
	pub fn get_sample_base_note(&self, name: &str, bank: Option<&str>) -> Option<&Pitch> {
		self.entries
			.get(&self.lookup_key(name, bank))
			.and_then(|entry| entry.base_note.as_ref())
	}

	/// Whether a name (with an optional bank) is registered (`isSampleRegistered`), whether or not its PCM has
	/// arrived.
	pub fn is_sample_registered(&self, name: &str, bank: Option<&str>) -> bool {
		self.resolve_registered_key(name, bank).is_some()
	}

	/// Empties the registry and forgets which names were warned about (`clearSamples`).
	///
	/// An engine keeps the buffers it has already made from this registry, as the reference keeps what a
	/// context has decoded, so a name an engine has played still plays after a clear.
	pub fn clear_samples(&mut self) {
		self.entries.clear();
		self.warned.clear();
	}

	/// Notes that `key` was warned about; `true` the first time since the last clear.
	pub(crate) fn first_warning(&mut self, key: &str) -> bool {
		self.warned.insert(key.to_string())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn data(frames: usize) -> SampleData {
		SampleData::new(48_000.0, vec![vec![0.25; frames]])
	}

	#[test]
	fn a_rate_or_size_the_renderer_would_refuse_fails_at_registration() {
		let mut samples = Samples::new();
		for rate in [0.5, 1e100, 2_000_000.0, f64::INFINITY, f64::NAN] {
			let result = samples.register_sample("x", SampleData::new(rate, vec![vec![0.0]]), None);
			assert!(result.is_err(), "rate {rate} was accepted");
		}
		assert!(!samples.is_sample_registered("x", None));
		// The size check works on the lengths, so it is tested without making the data.
		assert!(fits_in_a_buffer(2, MAX_BUFFER_SAMPLES / 2));
		assert!(!fits_in_a_buffer(2, MAX_BUFFER_SAMPLES / 2 + 1));
		assert!(!fits_in_a_buffer(32, usize::MAX));
		assert!(samples.register_sample("ok", data(4), None).is_ok());
	}

	#[test]
	fn registering_reports_the_name_and_the_base_note() {
		let mut samples = Samples::new();
		assert!(!samples.is_sample_registered("bd", None));
		samples
			.register_sample("bd", data(4), Some(Pitch::Name("a2".into())))
			.unwrap();
		assert!(samples.is_sample_registered("bd", None));
		assert_eq!(
			samples.get_sample_base_note("bd", None),
			Some(&Pitch::Name("a2".into()))
		);
		assert_eq!(samples.get_sample_buffer("bd", None).unwrap().frames(), 4);
	}

	#[test]
	fn a_sample_without_a_base_note_has_none() {
		let mut samples = Samples::new();
		samples.register_sample("bd", data(4), None).unwrap();
		assert_eq!(samples.get_sample_base_note("bd", None), None);
		assert_eq!(samples.get_sample_base_note("ghost", None), None);
	}

	#[test]
	fn a_bad_base_note_fails_at_registration_with_the_pitch_message() {
		let mut samples = Samples::new();
		let error = samples
			.register_sample("bd", data(4), Some(Pitch::Name("h2".into())))
			.unwrap_err();
		assert!(error.message().contains("h2"), "{}", error.message());
		let error = samples
			.register_sample("bd", data(4), Some(Pitch::Hz(0.0)))
			.unwrap_err();
		assert_eq!(error.message(), "Invalid frequency: 0");
		assert!(!samples.is_sample_registered("bd", None));
	}

	#[test]
	fn a_recording_web_audio_would_refuse_is_refused() {
		let mut samples = Samples::new();
		let refuse = |samples: &mut Samples, data: SampleData| {
			samples
				.register_sample("x", data, None)
				.unwrap_err()
				.message()
				.to_string()
		};
		assert_eq!(
			refuse(&mut samples, SampleData::new(44_100.0, vec![])),
			"Sample \"x\" has no channels."
		);
		assert_eq!(
			refuse(&mut samples, SampleData::new(44_100.0, vec![vec![]])),
			"Sample \"x\" has no frames."
		);
		assert_eq!(
			refuse(
				&mut samples,
				SampleData::new(44_100.0, vec![vec![0.0; 2], vec![0.0; 3]])
			),
			"Sample \"x\" has channels of different lengths."
		);
		assert!(
			refuse(&mut samples, SampleData::new(0.0, vec![vec![0.0]])).contains("sample rate")
		);
		assert!(
			refuse(&mut samples, SampleData::new(f64::NAN, vec![vec![0.0]]))
				.contains("sample rate")
		);
		assert!(!samples.is_sample_registered("x", None));
	}

	#[test]
	fn a_bank_prefers_the_banked_name_and_falls_back_to_the_bare_one() {
		let mut samples = Samples::new();
		samples.register_sample("bd", data(2), None).unwrap();
		assert_eq!(
			samples.resolve_registered_key("bd", Some("TR707")),
			Some("bd".to_string())
		);
		samples.register_sample("TR707_bd", data(3), None).unwrap();
		assert_eq!(
			samples.resolve_registered_key("bd", Some("TR707")),
			Some("TR707_bd".to_string())
		);
		assert_eq!(
			samples
				.get_sample_buffer("bd", Some("TR707"))
				.unwrap()
				.frames(),
			3
		);
		// The banked name alone is enough, and another bank still falls back.
		let mut only = Samples::new();
		only.register_sample("TR707_sd", data(2), None).unwrap();
		assert!(only.is_sample_registered("sd", Some("TR707")));
		assert!(!only.is_sample_registered("sd", None));
		assert!(!only.is_sample_registered("sd", Some("TR808")));
	}

	#[test]
	fn register_samples_registers_in_order_and_stops_at_the_first_failure() {
		let mut samples = Samples::new();
		let source = |base: Option<Pitch>| SampleSource {
			data: data(2),
			base_note: base,
		};
		let error = samples
			.register_samples([
				("a".to_string(), source(None)),
				("b".to_string(), source(Some(Pitch::Name("zz".into())))),
				("c".to_string(), source(None)),
			])
			.unwrap_err();
		assert!(error.message().contains("zz"));
		assert!(samples.is_sample_registered("a", None));
		assert!(!samples.is_sample_registered("b", None));
		assert!(!samples.is_sample_registered("c", None));
	}

	#[test]
	fn a_pending_sample_is_registered_but_not_available_until_loaded() {
		let mut samples = Samples::new();
		samples
			.register_pending_sample("pad", Some(Pitch::Name("e3".into())))
			.unwrap();
		assert!(samples.is_sample_registered("pad", None));
		assert!(samples.get_sample_buffer("pad", None).is_none());
		samples
			.load_samples([("pad".to_string(), data(5))])
			.unwrap();
		assert_eq!(samples.get_sample_buffer("pad", None).unwrap().frames(), 5);
		// The base note it was registered with is kept.
		assert_eq!(
			samples.get_sample_base_note("pad", None),
			Some(&Pitch::Name("e3".into()))
		);
	}

	#[test]
	fn loading_an_unregistered_name_fails_and_changes_nothing() {
		let mut samples = Samples::new();
		samples.register_pending_sample("pad", None).unwrap();
		let error = samples
			.load_samples([("pad".to_string(), data(5)), ("ghost".to_string(), data(5))])
			.unwrap_err();
		assert_eq!(
			error.message(),
			"Sample \"ghost\" is not registered. Call registerSample() first."
		);
		assert!(samples.get_sample_buffer("pad", None).is_none());
	}

	#[test]
	fn clearing_forgets_the_samples_and_the_warnings() {
		let mut samples = Samples::new();
		samples.register_sample("bd", data(2), None).unwrap();
		assert!(samples.first_warning("bd"));
		assert!(!samples.first_warning("bd"));
		samples.clear_samples();
		assert!(!samples.is_sample_registered("bd", None));
		assert!(samples.first_warning("bd"));
	}

	#[test]
	fn a_clone_shares_the_pcm() {
		let mut samples = Samples::new();
		samples.register_sample("bd", data(2), None).unwrap();
		let copy = samples.clone();
		assert!(Arc::ptr_eq(
			samples.entry_data("bd").unwrap(),
			copy.entry_data("bd").unwrap()
		));
	}
}
