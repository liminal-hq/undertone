// Warnings the engine gives once, as the reference's warnOnce does, collected instead of printed
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The reference prints a few warnings once each (`warnOnce` in `src/warn.ts`): combined pitch controls, a pan
//! slide with a pan path, a pan law an autopan cannot follow, a master bus limiter skipped on a surround
//! output. A library should not print, so the engine keeps them as [`Warning`]s that the host reads with
//! `Engine::warnings` and shows as it likes. Each key is given at most once per engine (the reference's
//! `warnOnce` is once per process).

use std::borrow::Cow;

/// A warning the engine gave: a stable key and the reference's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
	/// The key that makes the warning once-only (`"pitch-curve-combined"`, `"autopan-pan-law"`, and so on; a
	/// sample warning's key is `sample:` and the name).
	pub key: Cow<'static, str>,
	/// The message, as the TypeScript reference words it.
	pub message: String,
}

/// The warnings given so far, each key once.
#[derive(Debug, Clone, Default)]
pub struct Warnings(Vec<Warning>);

impl Warnings {
	/// Records `message` under `key` unless that key was already given.
	pub fn once(&mut self, key: impl Into<Cow<'static, str>>, message: impl Into<String>) {
		let key = key.into();
		if self.0.iter().all(|warning| warning.key != key) {
			self.0.push(Warning {
				key,
				message: message.into(),
			});
		}
	}

	/// Records `message` under `key` whether or not the key was given before. For a warning whose
	/// once-only state lives elsewhere: the sample registry forgets its warnings when it is cleared.
	pub fn give(&mut self, key: impl Into<Cow<'static, str>>, message: impl Into<String>) {
		self.0.push(Warning {
			key: key.into(),
			message: message.into(),
		});
	}

	/// The warnings, in the order they were given.
	pub fn all(&self) -> &[Warning] {
		&self.0
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_key_is_given_once() {
		let mut warnings = Warnings::default();
		warnings.once("a", "first");
		warnings.once("a", "second");
		warnings.once("b", "third");
		assert_eq!(warnings.all().len(), 2);
		assert_eq!(warnings.all()[0].message, "first");
	}
}
