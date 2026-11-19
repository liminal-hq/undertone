// Checks which maths back-end the facade was built with, for the CI run on the platform's C library
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! CI runs `UNDERTONE_EXPECT_MATHS=native cargo nextest run -p undertone --no-default-features`, so that a
//! dependency that switches the `libm` feature back on through feature unification fails the run instead of
//! passing on the wrong back-end. Unset, the second test does nothing.

use undertone::engine::math::ACTIVE_NAME;

#[test]
fn the_back_end_follows_the_libm_feature() {
	assert_eq!(ACTIVE_NAME == "libm", cfg!(feature = "libm"));
}

#[test]
fn the_expected_back_end_is_the_one_in_use() {
	if let Ok(expected) = std::env::var("UNDERTONE_EXPECT_MATHS") {
		assert_eq!(
			ACTIVE_NAME, expected,
			"the facade is not using the maths back-end CI asked for"
		);
	}
}
