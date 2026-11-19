#!/usr/bin/env bash
# Checks that the audio players on the TypeScript guide pages, the manifest that names them, and the rendered files agree.
#
# Usage:
#   scripts/check-ts-audio.sh
#
# Environment (the defaults are the repository's; scripts/check-ts-audio.test.sh sets them to a small fake tree):
#   TS_AUDIO_PAGES     the markdown files to read, space separated (default: README.md, docs/*.md and docs/guide/*.md)
#   TS_AUDIO_MANIFEST  the manifest of blocks to render (default: docs/audio/manifest.json)
#   TS_AUDIO_DIR       where the rendered audio is (default: docs/public/ts-audio, where CI downloads the ts-audio artifact)
#
# Source-level checks (no audio needed):
#   1. every fence marked `ts standalone audio=NAME` has an entry NAME in the manifest, on the page the entry names, and no two
#      fences share a name;
#   2. every manifest entry is used by a marked fence, and has a `kind` of run, capture or direct;
#   3. every <TsAudio name="NAME" /> written by hand in a page names a manifest entry.
# Rendered-audio checks, when the audio directory exists:
#   4. its manifest.json lists every manifest entry, each with at least one file, and every listed file exists and is not empty.
# When the directory is absent, CI (the `CI` variable is set) fails, and a local run skips check 4 with a loud notice.
# A failure names the page, the name, or the file.
#
# It does not listen to the audio, compare it with the code, or run the blocks (src/docSnippets.test.ts runs them on a fake context
# and `bun run docs:audio` renders them).

set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "check-ts-audio: $*" >&2; fail=1; }

manifest=${TS_AUDIO_MANIFEST:-docs/audio/manifest.json}
dir=${TS_AUDIO_DIR:-docs/public/ts-audio}
if [ -n "${TS_AUDIO_PAGES:-}" ]; then
  read -ra pages <<<"$TS_AUDIO_PAGES"
else
  pages=(README.md docs/*.md docs/guide/*.md)
fi

[ -f "$manifest" ] || { note "no manifest at $manifest"; exit 1; }

# entries: one line per manifest entry, `NAME PAGE KIND` (the manifest is Prettier-formatted: entries at two spaces, fields at four).
entries=$(awk '
  /^  "[a-z0-9-]+": \{/ { if (name != "") print name, page, kind; name = $1; gsub(/[":]/, "", name); page = "-"; kind = "-" }
  /^    "page":/ { page = $2; gsub(/[",]/, "", page) }
  /^    "kind":/ { kind = $2; gsub(/[",]/, "", kind) }
  END { if (name != "") print name, page, kind }
' "$manifest")

# markers: one line per marked fence, `NAME PAGE`.
markers=$(for page in "${pages[@]}"; do
  sed -nE 's/^```ts standalone audio=([a-z0-9-]+)[[:space:]]*$/\1 '"${page//\//\\/}"'/p' "$page"
done)

while read -r name page; do
  [ -n "$name" ] || continue
  if [ "$(grep -c "^$name " <<<"$markers")" -gt 1 ]; then
    note "audio=$name is used by more than one fence: $(grep "^$name " <<<"$markers" | cut -d' ' -f2 | tr '\n' ' ')"
  fi
  entry=$(grep "^$name " <<<"$entries" || true)
  if [ -z "$entry" ]; then
    note "$page: audio=$name has no entry in $manifest"
  elif [ "$(cut -d' ' -f2 <<<"$entry")" != "$page" ]; then
    note "$page: audio=$name is on that page, but $manifest says $(cut -d' ' -f2 <<<"$entry")"
  fi
done <<<"$markers"

while read -r name page kind; do
  [ -n "$name" ] || continue
  grep -q "^$name " <<<"$markers" || note "$manifest: entry $name is not used by any fence marked audio=$name"
  case "$kind" in
    run | capture | direct) ;;
    *) note "$manifest: entry $name has kind '$kind', not run, capture or direct" ;;
  esac
done <<<"$entries"

for page in "${pages[@]}"; do
  for name in $(grep -oE '<TsAudio +name="[^"]*"' "$page" | sed -E 's/.*name="//; s/"$//' || true); do
    grep -q "^$name " <<<"$entries" || note "$page: <TsAudio name=\"$name\" /> has no entry in $manifest"
  done
done

if [ -d "$dir" ]; then
  rendered="$dir/manifest.json"
  if [ ! -f "$rendered" ]; then
    note "$dir exists but has no manifest.json (run bun run docs:audio)"
  else
    # files: one line per listed file, `NAME FILE`.
    listed=$(awk '
      /^  "[a-z0-9-]+": \[/ { name = $1; gsub(/[":]/, "", name) }
      /^ +"file":/ { file = $2; gsub(/[",]/, "", file); print name, file }
    ' "$rendered")
    while read -r name _; do
      [ -n "$name" ] || continue
      grep -q "^$name " <<<"$listed" || note "$rendered: no files for $name (run bun run docs:audio)"
    done <<<"$entries"
    while read -r name file; do
      [ -n "$name" ] || continue
      if [ ! -s "$dir/$name/$file" ]; then note "$dir/$name/$file is listed in $rendered but missing or empty"; fi
    done <<<"$listed"
  fi
elif [ -n "${CI:-}" ]; then
  note "no rendered audio at $dir: CI downloads the ts-audio artifact there, so the audio checks cannot be skipped in CI"
else
  {
    echo "check-ts-audio: ============================================================"
    echo "check-ts-audio: SKIPPED the rendered-audio check (no audio at $dir)."
    echo "check-ts-audio: Run 'bun run docs:audio' to render it, then run this again."
    echo "check-ts-audio: ============================================================"
  } >&2
fi

[ "$fail" -eq 0 ] && echo "check-ts-audio: ok ($(grep -c . <<<"$entries") entries, $(grep -c . <<<"$markers") fences)"
exit "$fail"
