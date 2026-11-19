#!/usr/bin/env bash
# Checks the Rust guide pages (docs/guide/rust-*.md) against the source tree, so a page cannot name something that is not there.
#
# What it checks, and no more:
#   1. every page has the "ships with 0.4.0" callout, no `ts` fence (docSnippets would execute a `ts standalone` one), and at least one
#      snippet import (`<<< @/../crates/...`), and every imported file exists;
#   2. every example under crates/undertone/examples/ is imported by some page;
#   3. every inline `undertone::a::b` path: `a` is a module or re-export declared in crates/undertone/src/lib.rs, and the last segment is
#      declared `pub` (fn, struct, enum, trait, type, const, static, or mod) somewhere under crates/, or is named in lib.rs or prelude.rs;
#   4. every inline `Type::method` (CamelCase then snake_case): `fn method` exists somewhere under crates/;
#   5. every page is linked from guideSidebar in docs/.vitepress/config.mts;
#   6. when docs/public/rust exists (CI downloads the rustdoc there), the rustdoc index the nav links to exists in it.
# It does not type-check prose, resolve a method against its own type, or parse rustdoc JSON. The code blocks themselves are the example
# files, which crates/undertone/tests/examples.rs compiles and runs, so they need no check here.

set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "check-rust-docs: $*" >&2; fail=1; }

pages=(docs/guide/rust-*.md)
[ -e "${pages[0]}" ] || { note "no docs/guide/rust-*.md pages"; exit 1; }
src=(crates/*/src)

declared() { # declared NAME: a pub item called NAME exists under crates/
  grep -rEqw --include='*.rs' "pub(\([a-z]+\))? +(const +)?(unsafe +)?(fn|struct|enum|trait|type|const|static|mod) +$1" "${src[@]}"
}

for page in "${pages[@]}"; do
  grep -q 'ships with 0.4.0' "$page" || note "$page: missing the 'ships with 0.4.0' callout"
  grep -Eq '^```ts' "$page" && note "$page: has a ts fence"
  imports=$(grep -E '^<<< ' "$page" | sed -E 's/^<<< +@\///; s/[{ ].*$//' || true)
  [ -n "$imports" ] || note "$page: no snippet import"
  for rel in $imports; do
    [ -f "docs/$rel" ] || note "$page: imported file docs/$rel does not exist"
  done
  slug=$(basename "$page" .md)
  grep -q "'/guide/$slug'" docs/.vitepress/config.mts || note "$page: not in guideSidebar"

  # Inline code only (single backticks); fenced blocks are skipped.
  inline=$(awk '/^```/{f=!f; next} !f' "$page" | grep -oE '`[^`]+`' | tr -d '`' || true)

  for path in $(grep -oE '^undertone(::[A-Za-z_][A-Za-z0-9_]*)+' <<<"$inline" | sort -u || true); do
    IFS=: read -ra seg <<<"${path//::/:}"
    first=${seg[1]}
    last=${seg[${#seg[@]}-1]}
    grep -Eqw "pub +(mod|use).*\b$first\b" crates/undertone/src/lib.rs || declared "$first" || note "$page: \`$path\`: no module or item '$first' at the crate root"
    if [ "${#seg[@]}" -gt 2 ]; then
      declared "$last" || grep -qw "$last" crates/undertone/src/lib.rs crates/undertone/src/prelude.rs || note "$page: \`$path\`: no pub item '$last'"
    fi
  done

  for pair in $(grep -oE '^[A-Z][A-Za-z0-9]*::[a-z_][a-z0-9_]*' <<<"$inline" | sort -u || true); do
    method=${pair#*::}
    grep -rEqw --include='*.rs' "fn +$method" "${src[@]}" || note "$page: \`$pair\`: no fn '$method' under crates/"
  done
done

for example in crates/undertone/examples/*.rs; do
  name=$(basename "$example")
  grep -lq "examples/$name" "${pages[@]}" 2>/dev/null || note "example $name is not imported by any Rust guide page"
done

if [ -d docs/public/rust ]; then
  [ -f docs/public/rust/undertone/index.html ] || note "docs/public/rust exists but has no undertone/index.html"
fi

[ "$fail" -eq 0 ] && echo "check-rust-docs: ${#pages[@]} pages ok"
exit "$fail"
