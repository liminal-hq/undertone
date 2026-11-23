#!/usr/bin/env bash
# Installs the ALSA development files that undertone-native (through cpal) needs to build on Linux, where they are missing
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT OR Apache-2.0

# `cpal` links ALSA through `alsa-sys`, which finds it with `pkg-config`, so a build of the workspace needs `pkg-config` and the
# `alsa.pc` file from libasound2-dev. The shared ci-rust image has neither (D-49), so the Rust jobs that build the whole workspace
# run this first, the same way the docs jobs install libasound2t64 where it is missing. On a machine that already has them it does
# nothing. It needs root and `apt-get` (the CI containers run as root on Ubuntu); elsewhere install the packages yourself, see
# crates/undertone-native/README.md.

set -euo pipefail

if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists alsa; then
  echo "install-native-prereqs: the ALSA development files are present"
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "install-native-prereqs: no apt-get here; install the ALSA development files and pkg-config yourself (see crates/undertone-native/README.md)" >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends libasound2-dev pkg-config
