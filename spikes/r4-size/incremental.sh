#!/usr/bin/env bash
# Throwaway spike R4: incremental rebuild timings of the control crate after touching one file.
cd "$(dirname "$0")"
export CARGO_TARGET_DIR=/home/scott/.cache/undertone-spike-r4-target
t() { python3 timeit.py cargo build "$@" --target wasm32-unknown-unknown -p r4-control 2>&1 | tail -1; }
ctl=control/src/lib.rs; pat=../../crates/undertone-pattern/src/signal.rs
echo "== release, CARGO_INCREMENTAL=0 (the CI default), prime then touch control/src/lib.rs"
CARGO_INCREMENTAL=0 t --release >/dev/null; touch $ctl; CARGO_INCREMENTAL=0 t --release
echo "== release, CARGO_INCREMENTAL=0, touch crates/undertone-pattern/src/signal.rs"
touch $pat; CARGO_INCREMENTAL=0 t --release
echo "== release, CARGO_INCREMENTAL=1 (deliberate), prime then touch control/src/lib.rs"
CARGO_INCREMENTAL=1 t --release >/dev/null; touch $ctl; CARGO_INCREMENTAL=1 t --release
echo "== release, CARGO_INCREMENTAL=1, touch signal.rs"
touch $pat; CARGO_INCREMENTAL=1 t --release
echo "== dev profile (the day-to-day cargo build), CARGO_INCREMENTAL=1, prime then touch control/src/lib.rs"
CARGO_INCREMENTAL=1 t >/dev/null; touch $ctl; CARGO_INCREMENTAL=1 t
echo "== dev profile, touch signal.rs"
touch $pat; CARGO_INCREMENTAL=1 t
echo "== no change at all, release"
CARGO_INCREMENTAL=0 t --release
