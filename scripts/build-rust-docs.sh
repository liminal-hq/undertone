#!/usr/bin/env bash
# Builds the Rust API docs the way the site publishes them: `cargo doc --no-deps --workspace --locked` with warnings denied, the crate
# version labelled for the release the docs ship with, and the Undertone site bar and theme (docs/rustdoc/) added to every page.
#
# One place for the flags, used by the rustdoc job of .github/workflows/gh-pages.yml, the rust-doc job of .github/workflows/ci.yml, and
# anyone building the docs locally. Extra arguments go to `cargo doc`. The output is target/doc (or $CARGO_TARGET_DIR/doc).
#
# The bar's links are root-relative under the production base /undertone/ (the same HTML is on every page, whatever its depth), so the
# bar only resolves where the docs are served from /undertone/rust/.
#
# scripts/check-rust-docs.sh fails when a page lacks the bar, so a build without these flags cannot be published.

set -euo pipefail
cd "$(dirname "$0")/.."

# "(pre-release)" until the crates are published; rustdoc shows this string wherever it shows the crate version.
version='0.4.0 (pre-release)'

flags=(
  -D warnings
  --crate-version "$version"
  --html-in-header "$PWD/docs/rustdoc/site-head.html"
  --html-before-content "$PWD/docs/rustdoc/site-bar.html"
  --extend-css "$PWD/docs/rustdoc/site.css"
)

# RUSTDOCFLAGS is split on whitespace by cargo, so the version (which has a space) cannot go through it as one word. The encoded form
# separates arguments with the unit separator (0x1f) instead.
sep=$'\x1f'
encoded=''
for flag in "${flags[@]}"; do
  encoded+="${encoded:+$sep}$flag"
done

CARGO_ENCODED_RUSTDOCFLAGS="$encoded" exec cargo doc --no-deps --workspace --locked "$@"
