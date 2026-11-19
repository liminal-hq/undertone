#!/usr/bin/env bash
# Renders the audio the Rust guide pages play: runs every example under crates/undertone/examples/ and keeps the WAV files each one writes.
#
# Usage:
#   scripts/render-rust-audio.sh [OUTDIR]   OUTDIR defaults to docs/public/rust-audio (git-ignored)
#
# Each example writes to OUTDIR/<example>/, and OUTDIR/manifest.json lists the files of each example with their sample rate and channel
# count, read back from the WAV headers. The <RustAudio example="..."> component on the guide pages reads that manifest. CI runs this
# script in the Rust image and the site build downloads the result into docs/public/rust-audio/ (see .github/workflows/gh-pages.yml).
# Nothing here listens to the audio. When memory is tight, run it under a cap, for example
# `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- scripts/render-rust-audio.sh`.

set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:-docs/public/rust-audio}
mkdir -p "$out"
out=$(cd "$out" && pwd)
find "$out" -mindepth 1 -delete

cargo build --release --examples -p undertone --locked
bin=${CARGO_TARGET_DIR:-target}/release/examples

for src in crates/undertone/examples/*.rs; do
  name=$(basename "$src" .rs)
  mkdir -p "$out/$name"
  UNDERTONE_EXAMPLE_OUT="$out/$name" "$bin/$name" >/dev/null
done

# word FILE OFFSET BYTES: a little-endian unsigned integer from a WAV header.
word() { od -An -tu"$3" -j"$2" -N"$3" "$1" | tr -d ' '; }

{
  printf '{'
  first=1
  for dir in "$out"/*/; do
    name=$(basename "$dir")
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '\n  "%s": [' "$name"
    sep=
    for wav in "$dir"*.wav; do
      printf '%s\n    {"file": "%s", "sampleRate": %s, "channels": %s}' "$sep" "$(basename "$wav")" "$(word "$wav" 24 4)" "$(word "$wav" 22 2)"
      sep=,
    done
    printf '\n  ]'
  done
  printf '\n}\n'
} >"$out/manifest.json"

echo "render-rust-audio: $(find "$out" -name '*.wav' | wc -l) files, $(du -sh "$out" | cut -f1), manifest at $out/manifest.json"
