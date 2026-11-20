// The error type of the native output
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::fmt;

/// Why the native output could not be opened, or went wrong while open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum NativeError {
	/// The system has no output device (a machine with no sound card, or a container without one).
	NoDevice,
	/// No output device has the requested name. Carries the name that was asked for.
	DeviceNotFound(String),
	/// The device offers no `f32` output at a usable rate and channel count. Carries what was found.
	Unsupported(String),
	/// The player and the sink disagree (sample rate, channels), or an option is out of range.
	Format(String),
	/// The audio system refused to build, start, or list a stream. Carries its message.
	Stream(String),
	/// The player failed, for example because it was shut down before the output opened.
	Player(undertone::Error),
}

impl fmt::Display for NativeError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			NativeError::NoDevice => f.write_str("no audio output device is available"),
			NativeError::DeviceNotFound(name) => {
				write!(f, "no audio output device is named {name:?}")
			}
			NativeError::Unsupported(what) => write!(f, "unsupported output: {what}"),
			NativeError::Format(what) => write!(f, "output format: {what}"),
			NativeError::Stream(what) => write!(f, "audio stream: {what}"),
			NativeError::Player(error) => write!(f, "player: {error}"),
		}
	}
}

impl std::error::Error for NativeError {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			NativeError::Player(error) => Some(error),
			_ => None,
		}
	}
}

impl From<undertone::Error> for NativeError {
	fn from(error: undertone::Error) -> Self {
		NativeError::Player(error)
	}
}

/// A `Result` whose error is a [`NativeError`].
pub type Result<T> = std::result::Result<T, NativeError>;
