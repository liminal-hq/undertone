// The error type of the pattern crate: a message that matches the reference word for word
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The error type: a message that matches the reference's word for word.

use alloc::string::String;
use core::fmt;

/// An error raised while building a pattern, with the exact message text the TypeScript reference throws.
///
/// The message is the whole contract: the conformance corpus records it word for word, including the UTF-16 position that mini-notation errors carry inside the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	message: String,
}

impl Error {
	/// An error with the given message.
	pub fn new(message: impl Into<String>) -> Self {
		Error {
			message: message.into(),
		}
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

#[cfg(feature = "std")]
impl std::error::Error for Error {}

/// The result of an operation that can fail with an [`Error`].
pub type Result<T> = core::result::Result<T, Error>;
