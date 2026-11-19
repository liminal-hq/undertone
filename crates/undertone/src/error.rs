// The one error type of the facade, converted from the crates underneath
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! [`Error`] and [`Result`]: the single error type every fallible call of the `undertone` crate returns.
//!
//! The crates underneath report one error type of their own, a message that matches the TypeScript reference
//! word for word (`pan() position must be between -1 and 1`). The facade keeps that text as the message and
//! adds a [`ErrorKind`], so a host can tell a mistake in what it asked for from a player that has been shut
//! down.

use std::fmt;

/// What kind of failure an [`Error`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorKind {
	/// What was asked for is not valid: a bad option, a bad mini-notation string, a recording the engine
	/// refuses. The message is the reference's.
	Invalid,
	/// The [`Player`](crate::Player) was shut down, so it can no longer play or render.
	Closed,
}

/// An error from Undertone, with the reference's message.
///
/// The message is the whole contract: the conformance corpus records it word for word, including the UTF-16
/// position that mini-notation errors carry inside the text. [`Display`](fmt::Display) prints it unchanged.
///
/// ```
/// use undertone::pattern::control::note;
/// use undertone::{Error, ErrorKind};
///
/// fn build() -> undertone::Result<()> {
///     note("c4")?.pan(3.0)?;
///     Ok(())
/// }
///
/// let error: Error = build().unwrap_err();
/// assert_eq!(error.message(), "pan() position must be between -1 and 1, got 3");
/// assert_eq!(error.kind(), ErrorKind::Invalid);
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	kind: ErrorKind,
	message: String,
}

impl Error {
	/// An [`ErrorKind::Invalid`] error with the given message.
	pub fn new(message: impl Into<String>) -> Self {
		Error {
			kind: ErrorKind::Invalid,
			message: message.into(),
		}
	}

	/// The error of using a [`Player`](crate::Player) after [`Player::shutdown`](crate::Player::shutdown).
	pub fn closed() -> Self {
		Error {
			kind: ErrorKind::Closed,
			message: "The player has been shut down".into(),
		}
	}

	/// What kind of failure this is.
	pub fn kind(&self) -> ErrorKind {
		self.kind
	}

	/// The message, exactly as the reference writes it.
	pub fn message(&self) -> &str {
		&self.message
	}
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for Error {}

impl From<undertone_pattern::Error> for Error {
	fn from(error: undertone_pattern::Error) -> Self {
		Error::new(error.message())
	}
}

/// The result of an operation that can fail with an [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_message_survives_the_conversion_word_for_word() {
		let underneath =
			undertone_pattern::Error::new("cycles must be a positive whole number, got 1.5");
		let error: Error = underneath.clone().into();
		assert_eq!(error.message(), underneath.message());
		assert_eq!(error.to_string(), underneath.message());
		assert_eq!(error.kind(), ErrorKind::Invalid);
	}

	#[test]
	fn a_closed_player_is_its_own_kind() {
		let error = Error::closed();
		assert_eq!(error.kind(), ErrorKind::Closed);
		assert_eq!(error.message(), "The player has been shut down");
	}

	#[test]
	fn works_with_question_mark_and_box_dyn_error() {
		fn build() -> Result<()> {
			undertone_pattern::control::note("not a note")?;
			Ok(())
		}
		fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
			build()?;
			Ok(())
		}
		assert!(run().is_err());
	}

	#[test]
	fn is_send_sync_and_static() {
		fn needs<T: Send + Sync + 'static>() {}
		needs::<Error>();
	}
}
