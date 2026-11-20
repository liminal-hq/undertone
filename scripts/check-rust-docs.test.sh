#!/usr/bin/env bash
# Tests scripts/check-rust-docs.sh against a small fake rustdoc tree: names that exist pass, names that do not fail with the page and anchor
# looked for, and a missing rustdoc directory fails in CI and is skipped loudly elsewhere.
#
# The fake tree copies the shapes the real one has (checked against `cargo doc --no-deps --workspace`): a facade crate whose root index lists
# `reexport.*` entries, a module directory per module, `kind.Name.html` pages, `id="method.name"` anchors, a crate alias (`pub use
# undertone_pattern as pattern;`) with no link, and a glob re-export of a prelude module.

set -euo pipefail
cd "$(dirname "$0")/.."
script="$PWD/scripts/check-rust-docs.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
doc="$work/rustdoc"
mkdir -p "$doc"/undertone/{player,prelude} "$doc"/undertone_pattern/control

cat >"$doc/undertone/index.html" <<'HTML'
<dl class="item-table reexports"><dt id="reexport.Player"><code>pub use player::<a class="struct" href="player/struct.Player.html" title="struct undertone::player::Player">Player</a>;</code></dt><dt id="reexport.pattern"><code>pub use undertone_pattern as pattern;</code></dt><dt><code>pub use <a class="mod" href="prelude/index.html" title="mod undertone::prelude">prelude</a>::*;</code></dt></dl>
HTML
echo '<section id="method.new"></section><section id="method.render_seconds"></section><section id="method.shutdown"></section>' >"$doc/undertone/player/struct.Player.html"
echo '<h1>prelude</h1>' >"$doc/undertone/prelude/index.html"
echo '<h1>fn note</h1>' >"$doc/undertone/prelude/fn.note.html"
echo '<h1>undertone_pattern</h1>' >"$doc/undertone_pattern/index.html"
echo '<h1>control</h1>' >"$doc/undertone_pattern/control/index.html"
echo '<h1>fn note</h1>' >"$doc/undertone_pattern/control/fn.note.html"

failures=0
pass() { echo "ok: $1"; }
bad() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

# run NAME: runs the names check over a page holding the inline code NAME, leaving the output in $out and the status in $status.
run() {
  printf 'A page that names:\n\n' >"$work/page.md"
  for name in "$@"; do printf -- '- `%s`\n' "$name" >>"$work/page.md"; done
  status=0
  out=$(RUSTDOC_DIR="$doc" bash "$script" --names "$work/page.md" 2>&1) || status=$?
}

run 'Player::render_seconds' 'Player::new' 'undertone::Player' 'undertone::pattern::control::note' 'undertone::note' 'undertone::prelude::note'
if [ "$status" -eq 0 ]; then pass "names that exist are accepted"; else bad "names that exist were refused:
$out"; fi

run 'Player::render_to_wav'
if [ "$status" -ne 0 ] && grep -q 'struct.Player.html' <<<"$out" && grep -q 'method.render_to_wav' <<<"$out"; then
  pass "an invented method fails and names the page and the anchor"
else bad "an invented method was accepted or reported without the page and anchor (status $status):
$out"; fi

run 'undertone::pattern::render'
if [ "$status" -ne 0 ] && grep -q 'undertone_pattern' <<<"$out" && grep -q "'render'" <<<"$out"; then
  pass "an invented path fails and names where it looked"
else bad "an invented path was accepted or reported without where it looked (status $status):
$out"; fi

run 'Player::render_to_wav' 'undertone::pattern::render' 'Player::render_seconds'
if [ "$status" -ne 0 ] && grep -q 'render_to_wav' <<<"$out" && grep -q "'render'" <<<"$out" && ! grep -q 'render_seconds' <<<"$out"; then
  pass "a page with two invented names and a real one fails on exactly the invented two"
else bad "the mixed page was not judged name by name (status $status):
$out"; fi

run 'Missing::new'
if [ "$status" -ne 0 ] && grep -q 'Missing' <<<"$out"; then pass "a type with no page fails"; else bad "a type with no page was accepted (status $status): $out"; fi

# A path is not a module: a module-looking name that is not there fails too.
run 'undertone::nowhere::thing'
if [ "$status" -ne 0 ]; then pass "an unknown module fails"; else bad "an unknown module was accepted"; fi

# The whole check without rustdoc: CI refuses, a local run skips the HTML checks loudly and still runs the source checks.
status=0
out=$(CI=true RUSTDOC_DIR="$work/absent" bash "$script" 2>&1) || status=$?
if [ "$status" -ne 0 ] && grep -qi 'rustdoc' <<<"$out"; then pass "CI fails without rustdoc"; else bad "CI passed without rustdoc (status $status): $out"; fi
status=0
out=$(env -u CI RUSTDOC_DIR="$work/absent" bash "$script" 2>&1) || status=$?
if [ "$status" -eq 0 ] && grep -q 'SKIPPED' <<<"$out"; then pass "a local run skips the rustdoc checks loudly"; else bad "a local run without rustdoc did not skip loudly (status $status): $out"; fi

# The audio player: exactly one <RustAudio> per page, naming an example the page imports.
audio_page() { printf '%s\n' "$@" >"$work/audio.md"; }
audio_check() { status=0; out=$(bash "$script" --audio "$work/audio.md" 2>&1) || status=$?; }
audio_page '<<< @/../crates/undertone/examples/signals.rs' '' '<RustAudio example="signals" />'
audio_check
if [ "$status" -eq 0 ]; then pass "a RustAudio matching the imported example is accepted"; else bad "a matching RustAudio was refused: $out"; fi
audio_page '<<< @/../crates/undertone/examples/signals.rs'
audio_check
if [ "$status" -ne 0 ] && grep -q 'found 0' <<<"$out"; then pass "a page with no RustAudio fails"; else bad "a page with no RustAudio was accepted (status $status): $out"; fi
audio_page '<<< @/../crates/undertone/examples/signals.rs' '<RustAudio example="signals" />' '<RustAudio example="signals" />'
audio_check
if [ "$status" -ne 0 ] && grep -q 'found 2' <<<"$out"; then pass "a page with two RustAudio tags fails"; else bad "two RustAudio tags were accepted (status $status): $out"; fi
audio_page '<<< @/../crates/undertone/examples/signals.rs' '<RustAudio example="fm_synthesis" />'
audio_check
if [ "$status" -ne 0 ] && grep -q 'fm_synthesis' <<<"$out"; then pass "a RustAudio for an example the page does not import fails"; else bad "a mismatched RustAudio was accepted (status $status): $out"; fi

# The site bar: every sampled page holds data-site-bar. A tree built without the flags fails and names the page.
bar="$work/bar"
mkdir -p "$bar"/{undertone/player,src/undertone,undertone_pattern}
for page in undertone/index.html undertone_pattern/index.html undertone/player/struct.Player.html src/undertone/player.rs.html help.html; do
  echo '<body><nav data-site-bar></nav></body>' >"$bar/$page"
done
status=0
out=$(RUSTDOC_DIR="$bar" bash "$script" --site-bar 2>&1) || status=$?
if [ "$status" -eq 0 ]; then pass "pages with the site bar are accepted"; else bad "pages with the site bar were refused: $out"; fi
echo '<body>no bar</body>' >"$bar/undertone/player/struct.Player.html"
status=0
out=$(RUSTDOC_DIR="$bar" bash "$script" --site-bar 2>&1) || status=$?
if [ "$status" -ne 0 ] && grep -q 'struct.Player.html' <<<"$out" && grep -q 'data-site-bar' <<<"$out" && ! grep -q 'undertone/index.html' <<<"$out"; then
  pass "a page without the site bar fails and names the page"
else bad "a page without the site bar was accepted or reported wrongly (status $status): $out"; fi
echo '<body>no bar</body>' >"$bar/src/undertone/player.rs.html"
status=0
out=$(RUSTDOC_DIR="$bar" bash "$script" --site-bar 2>&1) || status=$?
if [ "$status" -ne 0 ] && grep -q 'player.rs.html' <<<"$out"; then pass "a source page without the site bar fails"; else bad "a source page without the site bar was accepted (status $status): $out"; fi

# Unresolved links: an href that is a Rust path (`self`, `crate::...`, `undertone_*::...`) fails and names the page and the path.
links="$work/links"
mkdir -p "$links"/{undertone/player,undertone_engine}
echo '<body><a href="../undertone_engine/index.html">engine</a> <a href="https://example.com/a::b">x</a></body>' >"$links/undertone/index.html"
status=0
out=$(RUSTDOC_DIR="$links" bash "$script" --links 2>&1) || status=$?
if [ "$status" -eq 0 ]; then pass "pages whose links are all URLs are accepted"; else bad "pages with only URL links were refused: $out"; fi
echo '<body><a href="self">module documentation</a></body>' >"$links/undertone/player/struct.Player.html"
status=0
out=$(RUSTDOC_DIR="$links" bash "$script" --links 2>&1) || status=$?
if [ "$status" -ne 0 ] && grep -q 'struct.Player.html' <<<"$out" && grep -q 'href="self"' <<<"$out" && ! grep -q 'undertone/index.html' <<<"$out"; then
  pass "a link to self fails and names the page"
else bad "a link to self was accepted or reported wrongly (status $status): $out"; fi
echo '<body><a href="undertone_engine::render::RenderPlan::new">x</a></body>' >"$links/undertone_engine/index.html"
status=0
out=$(RUSTDOC_DIR="$links" bash "$script" --links 2>&1) || status=$?
if [ "$status" -ne 0 ] && grep -q 'undertone_engine/index.html' <<<"$out" && grep -q 'RenderPlan::new' <<<"$out"; then pass "a link that is a crate path fails and names the path"; else bad "a crate path link was accepted (status $status): $out"; fi

[ "$failures" -eq 0 ] && echo "check-rust-docs.test: all passed"
exit "$failures"
