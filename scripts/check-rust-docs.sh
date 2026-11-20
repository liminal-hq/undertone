#!/usr/bin/env bash
# Checks the Rust guide pages (docs/guide/rust-*.md) against the source tree and the generated rustdoc, so a page cannot name something that
# is not there.
#
# Usage:
#   scripts/check-rust-docs.sh                 every check, over docs/guide/rust-*.md
#   scripts/check-rust-docs.sh --names FILE... only the inline names, over the given files (used by scripts/check-rust-docs.test.sh)
#   scripts/check-rust-docs.sh --audio FILE... only the RustAudio check, over the given files (used by scripts/check-rust-docs.test.sh)
#   scripts/check-rust-docs.sh --site-bar      only the site bar check, over the rustdoc directory (used by scripts/check-rust-docs.test.sh)
#
# The rustdoc directory is $RUSTDOC_DIR, default docs/public/rust (where CI downloads the rustdoc artifact, the contents of target/doc).
# Locally, build it with `scripts/build-rust-docs.sh` and run `RUSTDOC_DIR=target/doc scripts/check-rust-docs.sh`. When the directory
# is absent, CI (the `CI` variable is set) fails, and a local run skips the rustdoc checks with a loud notice and checks the rest.
#
# Source-level checks (no rustdoc needed):
#   1. every page has the "ships with 0.4.0" callout, no `ts` fence (docSnippets would execute a `ts standalone` one), and at least one
#      snippet import (`<<< @/../crates/...`), and every imported file exists;
#   2. every example under crates/undertone/examples/ is imported by some page;
#   3. every page is linked from guideSidebar in docs/.vitepress/config.mts;
#   3b. every page has exactly one <RustAudio example="NAME" /> and NAME is the file name of an example the page imports, except a page that
#       plays on a device and writes no WAV, which carries the line `<!-- rust-audio: none ... -->` and no player.
#
# Rustdoc checks, over the inline code of each page (fenced blocks are skipped):
#   4. an inline `Type::method` (CamelCase, then snake_case): a page `struct.Type.html`, `enum.Type.html`, `trait.Type.html`, `type.Type.html`,
#      or `union.Type.html` exists somewhere in the rustdoc tree, and one of them has an element with id `method.NAME`, `tymethod.NAME`, or
#      `associatedconstant.NAME`;
#   5. an inline `undertone::a::b::Name` path (the crate may also be `undertone_pattern` and so on) is resolved one segment at a time from the
#      crate's directory, as rustdoc lays it out: a module is a directory with an index.html, an item is a page `kind.Name.html`, and a
#      re-export is an element with id `reexport.Name` in the module's index.html, followed through its link (or, for `pub use crate as
#      alias;`, to the crate's directory). A glob re-export (`pub use prelude::*;`) is searched too. A segment after an item page must be one
#      of that page's anchors (a method, an associated constant, a variant, or a field);
#   6. the rustdoc index the site's nav links to (undertone/index.html) exists;
#   7. every rustdoc page sampled (each crate's index, one item page, one source page, and help.html) holds the site bar, an element with
#      the attribute data-site-bar, which scripts/build-rust-docs.sh adds with --html-before-content. A build without its flags fails here.
# A failure names the page and the anchor or file it looked for.
#
# It does not type-check prose, check what a method takes or returns, or read the code blocks, which are the example files that
# crates/undertone/tests/examples.rs compiles and runs. A name written without its type (`render_seconds`) or with a generic
# (`Pattern<ControlMap>::fast`) is not checked.

set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "check-rust-docs: $*" >&2; fail=1; }

rd=${RUSTDOC_DIR:-docs/public/rust}
kinds=(struct enum trait type union fn constant static macro attr derive)
anchors='method|tymethod|associatedconstant|variant|structfield|associatedtype'

# norm PATH: collapses `.` and `..` segments.
norm() {
  local -a out=()
  local -a parts
  local part
  IFS=/ read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    case "$part" in
      '' | .) ;;
      ..) if [ "${#out[@]}" -gt 0 ]; then unset 'out[${#out[@]}-1]'; fi ;;
      *) out+=("$part") ;;
    esac
  done
  (IFS=/; echo "${out[*]}")
}

# page_in DIR NAME: prints the page `kind.NAME.html` in the rustdoc directory DIR, if there is one.
page_in() {
  local kind
  for kind in "${kinds[@]}"; do
    if [ -f "$rd/$1/$kind.$2.html" ]; then echo "$1/$kind.$2.html"; return 0; fi
  done
  return 1
}

# follow_reexport DIR NAME: prints `dir:D` or `page:P` for the target of the re-export NAME in DIR's index.html.
follow_reexport() {
  local dir=$1 name=$2 idx="$rd/$1/index.html" entry href target crate
  [ -f "$idx" ] || return 1
  entry=$(sed -nE "s#.*(<dt id=\"reexport\.$name\">.*)#\1#p" "$idx" | head -n1 | sed -E 's#</dt>.*##')
  [ -n "$entry" ] || return 1
  href=$(grep -oE 'href="[^"#]+' <<<"$entry" | head -n1 | sed 's/^href="//' || true)
  if [ -n "$href" ]; then
    target=$(norm "$dir/$href")
    case "$target" in
      */index.html) [ -f "$rd/$target" ] && echo "dir:${target%/index.html}" ;;
      *) [ -f "$rd/$target" ] && echo "page:$target" ;;
    esac
    return 0
  fi
  # `pub use undertone_pattern as pattern;` has no link: the crate's own directory is the target.
  crate=$(sed -nE 's/.*pub use ([A-Za-z0-9_]+) as [A-Za-z0-9_]+;.*/\1/p' <<<"$entry")
  if [ -n "$crate" ] && [ -f "$rd/$crate/index.html" ]; then echo "dir:$crate"; return 0; fi
  return 1
}

# lookup DIR NAME LAST [DEPTH]: prints `dir:D` or `page:P` for NAME in the module DIR: a page, a module directory, a re-export, or
# something a glob re-export brings in. A last segment prefers the page (`fn mini` beside `mod mini`), a middle one the module.
lookup() {
  local dir=$1 name=$2 last=$3 depth=${4:-0} found glob target
  if [ "$last" = 1 ] && found=$(page_in "$dir" "$name"); then echo "page:$found"; return 0; fi
  if [ -f "$rd/$dir/$name/index.html" ]; then echo "dir:$dir/$name"; return 0; fi
  if found=$(page_in "$dir" "$name"); then echo "page:$found"; return 0; fi
  if found=$(follow_reexport "$dir" "$name") && [ -n "$found" ]; then echo "$found"; return 0; fi
  if [ "$depth" -lt 3 ] && [ -f "$rd/$dir/index.html" ]; then
    for glob in $(grep -oE 'pub use <a class="mod" href="[^"]+"[^>]*>[^<]*</a>::\*;' "$rd/$dir/index.html" | sed -E 's/.*href="([^"]+)".*/\1/' || true); do
      target=$(norm "$dir/$glob")
      if found=$(lookup "${target%/index.html}" "$name" "$last" $((depth + 1))); then echo "$found"; return 0; fi
    done
  fi
  return 1
}

# check_method PAGE PAIR: PAIR is `Type::method`.
check_method() {
  local page=$1 type=${2%%::*} method=${2#*::} pages=() p ok=0
  while IFS= read -r p; do pages+=("$p"); done < <(find "$rd" \( -path "$rd/src" -o -path "$rd/static.files" -o -path "$rd/trait.impl" -o -path "$rd/type.impl" \) -prune -o \
    \( -name "struct.$type.html" -o -name "enum.$type.html" -o -name "trait.$type.html" -o -name "type.$type.html" -o -name "union.$type.html" \) -print | sort)
  if [ "${#pages[@]}" -eq 0 ]; then
    note "$page: \`$2\`: no page for the type '$type' under $rd (looked for struct.$type.html, enum.$type.html, trait.$type.html, type.$type.html, union.$type.html)"
    return
  fi
  for p in "${pages[@]}"; do
    if grep -Eq "id=\"(method|tymethod|associatedconstant)\.$method\"" "$p"; then ok=1; fi
  done
  [ "$ok" -eq 1 ] || note "$page: \`$2\`: ${pages[*]} has no element with id \"method.$method\" (or tymethod.$method or associatedconstant.$method)"
}

# check_path PAGE PATH: PATH is `undertone::a::b::Name` (or another crate of the workspace).
check_path() {
  local page=$1 path=$2 segs=() cur i last found kind target remaining
  IFS=: read -ra segs <<<"${path//::/:}"
  cur=${segs[0]}
  if [ ! -f "$rd/$cur/index.html" ]; then
    note "$page: \`$path\`: no crate page $rd/$cur/index.html"
    return
  fi
  for ((i = 1; i < ${#segs[@]}; i++)); do
    last=0
    [ "$i" -eq $((${#segs[@]} - 1)) ] && last=1
    if ! found=$(lookup "$cur" "${segs[i]}" "$last"); then
      note "$page: \`$path\`: no item '${segs[i]}' in $cur (looked for $cur/{struct,enum,trait,type,union,fn,constant,static,macro,attr,derive}.${segs[i]}.html, $cur/${segs[i]}/index.html, and id=\"reexport.${segs[i]}\" or a glob re-export in $cur/index.html)"
      return
    fi
    kind=${found%%:*}
    target=${found#*:}
    if [ "$kind" = dir ]; then cur=$target; continue; fi
    # An item page: what follows is one of its anchors.
    if [ "$last" -eq 0 ]; then
      remaining=${segs[i + 1]}
      if [ "$i" -ne $((${#segs[@]} - 2)) ] || ! grep -Eq "id=\"($anchors)\.$remaining\"" "$rd/$target"; then
        note "$page: \`$path\`: $target has no element with id \"method.$remaining\" (or tymethod., associatedconstant., variant., structfield.)"
      fi
    fi
    return
  done
}

# check_names FILE...: the inline `Type::method` and `undertone::path` names of each file, against the rustdoc.
check_names() {
  local page inline pair path
  for page in "$@"; do
    # Inline code only (single backticks); fenced blocks are skipped.
    inline=$(awk '/^```/{f=!f; next} !f' "$page" | grep -oE '`[^`]+`' | tr -d '`' || true)
    for path in $(grep -oE '^undertone[a-z_]*(::[A-Za-z_][A-Za-z0-9_]*)+' <<<"$inline" | sort -u || true); do
      check_path "$page" "$path"
    done
    for pair in $(grep -oE '^[A-Z][A-Za-z0-9]*::[a-z_][a-z0-9_]*' <<<"$inline" | sort -u || true); do
      check_method "$page" "$pair"
    done
  done
}

# check_audio FILE...: each page holds exactly one <RustAudio example="NAME" />, and NAME is an example the page imports (`.../NAME.rs`).
check_audio() {
  local page tags count name
  for page in "$@"; do
    # A page whose example sends sound to a device and writes no WAV (the native output) says so with this marker, and then must
    # not have a player either: a player with no audio behind it would 404.
    if grep -q '^<!-- rust-audio: none' "$page"; then
      if grep -q '<RustAudio' "$page"; then note "$page: marked 'rust-audio: none' but has a <RustAudio> player"; fi
      continue
    fi
    tags=$(grep -oE '<RustAudio[^>]*>' "$page" || true)
    count=$(grep -c . <<<"$tags" || true)
    if [ "$count" -ne 1 ]; then
      note "$page: expected exactly one <RustAudio example=\"...\" />, found $count"
      continue
    fi
    name=$(sed -nE 's/.*example="([^"]*)".*/\1/p' <<<"$tags")
    if [ -z "$name" ]; then
      note "$page: <RustAudio> has no example=\"...\" attribute"
    elif ! grep -Eq "^<<< .*/$name\.rs([{ ]|\$)" "$page"; then
      note "$page: <RustAudio example=\"$name\" /> does not match an example the page imports (<<< .../$name.rs)"
    fi
  done
}

# check_site_bar: the sampled pages of the rustdoc directory each hold the site bar marker.
check_site_bar() {
  local -a sample=()
  local f
  for f in "$rd"/*/index.html "$rd/help.html"; do [ -f "$f" ] && sample+=("$f"); done
  f=$(find "$rd" \( -path "$rd/static.files" -o -path "$rd/trait.impl" -o -path "$rd/type.impl" -o -path "$rd/src" \) -prune -o -name 'struct.*.html' -print | sort | sed -n 1p)
  [ -n "$f" ] && sample+=("$f")
  f=$(find "$rd/src" -name '*.html' 2>/dev/null | sort | sed -n 1p)
  [ -n "$f" ] && sample+=("$f")
  if [ "${#sample[@]}" -eq 0 ]; then note "no rustdoc pages to sample under $rd"; return; fi
  for f in "${sample[@]}"; do
    grep -q 'data-site-bar' "$f" || note "$f: no data-site-bar (the Undertone site bar): build the docs with scripts/build-rust-docs.sh, which passes --html-before-content"
  done
  [ "$fail" -eq 0 ] && echo "check-rust-docs: ${#sample[@]} rustdoc pages sampled, each has the site bar"
  return 0
}

if [ "${1:-}" = "--site-bar" ]; then
  [ -d "$rd" ] || { echo "check-rust-docs: no rustdoc at $rd (set RUSTDOC_DIR)" >&2; exit 2; }
  check_site_bar
  exit "$fail"
fi

if [ "${1:-}" = "--audio" ]; then
  shift
  check_audio "$@"
  [ "$fail" -eq 0 ] && echo "check-rust-docs: $# files, RustAudio matches the imported example"
  exit "$fail"
fi

if [ "${1:-}" = "--names" ]; then
  shift
  [ -f "$rd/undertone/index.html" ] || { echo "check-rust-docs: no rustdoc at $rd (set RUSTDOC_DIR)" >&2; exit 2; }
  check_names "$@"
  [ "$fail" -eq 0 ] && echo "check-rust-docs: $# files, every name found in $rd"
  exit "$fail"
fi

pages=(docs/guide/rust-*.md)
[ -e "${pages[0]}" ] || { note "no docs/guide/rust-*.md pages"; exit 1; }

for page in "${pages[@]}"; do
  grep -q 'ships with 0.4.0' "$page" || note "$page: missing the 'ships with 0.4.0' callout"
  grep -Eq '^```ts' "$page" && note "$page: has a ts fence"
  imports=$(grep -E '^<<< ' "$page" | sed -E 's/^<<< +@\///; s/[{ ].*$//' || true)
  [ -n "$imports" ] || note "$page: no snippet import"
  for rel in $imports; do
    [ -f "docs/$rel" ] || note "$page: imported file docs/$rel does not exist"
  done
  check_audio "$page"
  slug=$(basename "$page" .md)
  grep -q "'/guide/$slug'" docs/.vitepress/config.mts || note "$page: not in guideSidebar"
done

for example in crates/undertone/examples/*.rs; do
  name=$(basename "$example")
  grep -lq "examples/$name" "${pages[@]}" 2>/dev/null || note "example $name is not imported by any Rust guide page"
done

if [ -f "$rd/undertone/index.html" ]; then
  check_names "${pages[@]}"
  check_site_bar
elif [ -d "$rd" ]; then
  note "$rd exists but has no undertone/index.html"
elif [ -n "${CI:-}" ]; then
  note "no rustdoc at $rd: CI downloads the rustdoc artifact there, so the rustdoc checks cannot be skipped in CI"
else
  {
    echo "check-rust-docs: ============================================================"
    echo "check-rust-docs: SKIPPED the rustdoc checks (no rustdoc at $rd)."
    echo "check-rust-docs: Page names (Type::method, undertone::path) were NOT checked."
    echo "check-rust-docs: Run 'scripts/build-rust-docs.sh' and then"
    echo "check-rust-docs:   RUSTDOC_DIR=target/doc scripts/check-rust-docs.sh"
    echo "check-rust-docs: ============================================================"
  } >&2
fi

[ "$fail" -eq 0 ] && echo "check-rust-docs: ${#pages[@]} pages ok"
exit "$fail"
