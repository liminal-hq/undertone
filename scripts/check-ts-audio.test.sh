#!/usr/bin/env bash
# Tests scripts/check-ts-audio.sh against a small fake tree: a consistent tree passes, and each kind of disagreement between the fences,
# the manifest and the rendered files fails with the page, the name, or the file it looked at. A missing audio directory fails in CI and is
# skipped loudly elsewhere.

set -euo pipefail
cd "$(dirname "$0")/.."
script="$PWD/scripts/check-ts-audio.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0
pass() { echo "ok: $1"; }
bad() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

# fresh: a consistent tree of two pages, a manifest of three entries and the audio for them.
fresh() {
  rm -rf "$work/t" && mkdir -p "$work/t/audio/one" "$work/t/audio/two" "$work/t/audio/three"
  printf '# A\n\n```ts standalone audio=one\nx;\n```\n\n```ts standalone audio=two\nx;\n```\n\n```ts standalone\nplain;\n```\n' >"$work/t/a.md"
  printf '# B\n\n```ts standalone audio=three\nx;\n```\n' >"$work/t/b.md"
  cat >"$work/t/manifest.json" <<'JSON'
{
  "one": {
    "page": "docs/a.md",
    "kind": "run"
  },
  "two": {
    "page": "docs/a.md",
    "kind": "capture",
    "cycles": 4
  },
  "three": {
    "page": "docs/b.md",
    "kind": "direct"
  }
}
JSON
  sed -i "s#\"docs/#\"$work/t/#" "$work/t/manifest.json"
  cat >"$work/t/audio/manifest.json" <<'JSON'
{
  "one": [
    {
      "file": "render.wav",
      "sampleRate": 48000
    }
  ],
  "two": [
    {
      "file": "audio.wav"
    },
    {
      "file": "second.wav"
    }
  ],
  "three": [
    {
      "file": "audio.wav"
    }
  ]
}
JSON
  for f in one/render two/audio two/second three/audio; do echo RIFF >"$work/t/audio/$f.wav"; done
}

runenv() { status=0; out=$(env "$@" TS_AUDIO_PAGES="$work/t/a.md $work/t/b.md" TS_AUDIO_MANIFEST="$work/t/manifest.json" TS_AUDIO_DIR="${DIR:-$work/t/audio}" bash "$script" 2>&1) || status=$?; }
expect_fail() { # NAME PATTERN...
  local name=$1 pattern
  shift
  if [ "$status" -eq 0 ]; then bad "$name was accepted"; return; fi
  for pattern in "$@"; do
    grep -q -- "$pattern" <<<"$out" || { bad "$name: the report lacks '$pattern':
$out"; return; }
  done
  pass "$name fails and says where"
}

fresh
runenv
if [ "$status" -eq 0 ] && grep -q '3 entries, 3 fences' <<<"$out"; then pass "a consistent tree is accepted"; else bad "a consistent tree was refused:
$out"; fi

fresh
printf '\n```ts standalone audio=four\nx;\n```\n' >>"$work/t/b.md"
runenv
expect_fail "a fence with no manifest entry" "audio=four has no entry"

fresh
sed -i 's/audio=two/audio=one/' "$work/t/a.md"
runenv
expect_fail "a name used by two fences" "audio=one is used by more than one fence" "entry two is not used"

fresh
sed -i '/audio=three/d' "$work/t/b.md"
runenv
expect_fail "an entry no fence uses" "entry three is not used"

fresh
sed -i "s#t/b.md#t/a.md#" "$work/t/manifest.json"
runenv
expect_fail "an entry on the wrong page" "audio=three is on that page, but"

fresh
sed -i 's/"direct"/"live"/' "$work/t/manifest.json"
runenv
expect_fail "an unknown kind" "entry three has kind 'live'"

fresh
printf '\n<TsAudio name="nine" />\n' >>"$work/t/b.md"
runenv
expect_fail "a hand-written player with no entry" '<TsAudio name="nine" /> has no entry'

fresh
rm "$work/t/audio/two/second.wav"
runenv
expect_fail "a listed file that is missing" "two/second.wav is listed"

fresh
: >"$work/t/audio/one/render.wav"
runenv
expect_fail "an empty file" "one/render.wav is listed"

fresh
sed -i '/"three": \[/,/^  \]/d' "$work/t/audio/manifest.json"
runenv
expect_fail "an entry the rendered manifest lacks" "no files for three"

fresh
rm "$work/t/audio/manifest.json"
runenv
expect_fail "an audio directory with no manifest" "has no manifest.json"

fresh
DIR="$work/t/none" runenv
if [ "$status" -eq 0 ] && grep -q 'SKIPPED the rendered-audio check' <<<"$out"; then pass "no audio directory is skipped loudly outside CI"; else bad "no audio directory outside CI (status $status):
$out"; fi
DIR="$work/t/none" runenv CI=1
expect_fail "no audio directory in CI" "no rendered audio at"

[ "$failures" -eq 0 ] || { echo "$failures failures" >&2; exit 1; }
echo "check-ts-audio.test: all passed"
