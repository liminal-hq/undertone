// The cpal Sink: lists output devices, selects one, and runs a stream that calls the AudioCallback
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The system audio device through [`cpal`]: [`output_devices`] lists them and [`CpalSink`] is a
//! [`Sink`] over one.
//!
//! The stream is `f32` at the device's default sample rate and channel count (or the nearest `f32` format the
//! device offers when its default is another sample type), with the host's default buffer size. Build the
//! player from [`Sink::format`] so it renders at the device's rate.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::error::{NativeError, Result};
use crate::sink::{AudioCallback, Sink, StreamFormat};

/// Which output device to open.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum DeviceChoice {
	/// The system's default output device.
	#[default]
	Default,
	/// The device with this name, as [`output_devices`] reports it. An exact match wins; failing that, a name
	/// that matches one device case-insensitively as a substring (so `"pipewire"` finds `"PipeWire Sound Server"`).
	Named(String),
}

/// An output device the system offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
	/// The device's name, for [`DeviceChoice::Named`].
	pub name: String,
	/// Whether it is the system's default output device.
	pub is_default: bool,
	/// The format the device prefers, when it reports one.
	pub default_format: Option<StreamFormat>,
}

fn stream_error(what: &str, error: impl std::fmt::Display) -> NativeError {
	NativeError::Stream(format!("{what}: {error}"))
}

fn device_name(device: &cpal::Device) -> Option<String> {
	device
		.description()
		.ok()
		.map(|description| description.name().to_string())
}

/// Lists the output devices of the default audio host.
///
/// # Errors
///
/// [`NativeError::Stream`] when the audio system cannot be queried. A machine with no output devices gives an
/// empty list, not an error.
pub fn output_devices() -> Result<Vec<DeviceInfo>> {
	let host = cpal::default_host();
	let default_name = host.default_output_device().as_ref().and_then(device_name);
	let devices = host
		.output_devices()
		.map_err(|error| stream_error("listing output devices", error))?;
	Ok(devices
		.filter_map(|device| {
			let name = device_name(&device)?;
			let default_format = device
				.default_output_config()
				.ok()
				.map(|config| StreamFormat::new(config.sample_rate(), config.channels()));
			Some(DeviceInfo {
				is_default: default_name.as_deref() == Some(name.as_str()),
				name,
				default_format,
			})
		})
		.collect())
}

/// A [`Sink`] over a system output device. Open one with [`CpalSink::new`], hand it to
/// [`Output::open`](crate::Output::open), and close the output to release the device.
pub struct CpalSink {
	device: cpal::Device,
	name: String,
	format: StreamFormat,
	stream: Option<cpal::Stream>,
}

impl std::fmt::Debug for CpalSink {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("CpalSink")
			.field("name", &self.name)
			.field("format", &self.format)
			.field("playing", &self.stream.is_some())
			.finish()
	}
}

impl CpalSink {
	/// Finds `choice` and settles its format. The stream is not opened until the sink is started.
	///
	/// # Errors
	///
	/// [`NativeError::NoDevice`] when there is no default output, [`NativeError::DeviceNotFound`] for a name no
	/// device has (or several match by substring), and [`NativeError::Unsupported`] when the device offers no
	/// `f32` output.
	pub fn new(choice: &DeviceChoice) -> Result<Self> {
		let host = cpal::default_host();
		let device = match choice {
			DeviceChoice::Default => host.default_output_device().ok_or(NativeError::NoDevice)?,
			DeviceChoice::Named(wanted) => find_named(&host, wanted)?,
		};
		let name = device_name(&device).unwrap_or_else(|| "(unnamed device)".into());
		let config = pick_config(&device)?;
		Ok(CpalSink {
			device,
			name,
			format: StreamFormat::new(config.sample_rate, config.channels),
			stream: None,
		})
	}

	/// The default output device. Shorthand for `CpalSink::new(&DeviceChoice::Default)`.
	///
	/// # Errors
	///
	/// As for [`CpalSink::new`].
	pub fn default_output() -> Result<Self> {
		Self::new(&DeviceChoice::Default)
	}

	/// The device's name.
	pub fn device_name(&self) -> &str {
		&self.name
	}
}

fn find_named(host: &cpal::Host, wanted: &str) -> Result<cpal::Device> {
	let devices: Vec<(String, cpal::Device)> = host
		.output_devices()
		.map_err(|error| stream_error("listing output devices", error))?
		.filter_map(|device| Some((device_name(&device)?, device)))
		.collect();
	let mut exact = None;
	let mut partial = Vec::new();
	let lowered = wanted.to_lowercase();
	for (index, (name, _)) in devices.iter().enumerate() {
		if name == wanted {
			exact = Some(index);
			break;
		}
		if name.to_lowercase().contains(&lowered) {
			partial.push(index);
		}
	}
	let chosen = match (exact, partial.as_slice()) {
		(Some(index), _) => index,
		(None, [index]) => *index,
		_ => return Err(NativeError::DeviceNotFound(wanted.to_string())),
	};
	devices
		.into_iter()
		.nth(chosen)
		.map(|(_, device)| device)
		.ok_or_else(|| NativeError::DeviceNotFound(wanted.to_string()))
}

/// The device's default format when it is `f32`; otherwise an `f32` range at the default rate, then at the
/// default's channel count.
fn pick_config(device: &cpal::Device) -> Result<cpal::StreamConfig> {
	let default = device
		.default_output_config()
		.map_err(|error| stream_error("reading the default output format", error))?;
	if default.sample_format() == cpal::SampleFormat::F32 {
		return Ok(default.config());
	}
	let rate = default.sample_rate();
	let channels = default.channels();
	let ranges = device
		.supported_output_configs()
		.map_err(|error| stream_error("reading the supported output formats", error))?;
	let mut best: Option<cpal::SupportedStreamConfig> = None;
	for range in ranges.filter(|range| range.sample_format() == cpal::SampleFormat::F32) {
		let same_channels = range.channels() == channels;
		if let Some(config) = range.try_with_sample_rate(rate)
			&& (best.is_none() || same_channels)
		{
			best = Some(config);
		}
	}
	best.map(|config| config.config()).ok_or_else(|| {
		NativeError::Unsupported(format!(
			"{rate} Hz, {channels} channels, default sample type {:?}, and no f32 format at that rate",
			default.sample_format()
		))
	})
}

impl Sink for CpalSink {
	fn format(&self) -> StreamFormat {
		self.format
	}

	fn start(&mut self, mut callback: AudioCallback) -> Result<()> {
		let health = callback.health();
		let config = cpal::StreamConfig {
			channels: self.format.channels,
			sample_rate: self.format.sample_rate,
			buffer_size: cpal::BufferSize::Default,
		};
		let stream = self
			.device
			.build_output_stream(
				&config,
				move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| callback.fill(data),
				move |_error| health.report_stream_error(),
				None,
			)
			.map_err(|error| stream_error("building the output stream", error))?;
		stream
			.play()
			.map_err(|error| stream_error("starting the output stream", error))?;
		self.stream = Some(stream);
		Ok(())
	}

	fn stop(&mut self) {
		// Dropping a cpal stream stops it and releases the device.
		self.stream = None;
	}
}
