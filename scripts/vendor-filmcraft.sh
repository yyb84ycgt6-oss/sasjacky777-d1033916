#!/usr/bin/env bash
#
# Imports FilmCraft (storytold/filmcraft) into filmcraft/, whole, exactly as
# upstream tracks it at one commit — and its only git dependency, craft-libs,
# into filmcraft/vendor/craft-libs at the commit FilmCraft itself pins.
#
#   scripts/vendor-filmcraft.sh            # re-import the pinned commit (a no-op diff if nothing drifted)
#   scripts/vendor-filmcraft.sh <commit>   # move to another upstream commit
#   scripts/vendor-filmcraft.sh --check    # exit 1 if filmcraft/ differs from what upstream + the edits below give
#
# Why a script and not a one-off copy: a vendored tree nobody can regenerate is a
# tree nobody can audit. Re-running this and seeing an empty `git diff` is the
# proof that filmcraft/ is upstream's code plus the three edits listed here and
# nothing else.
#
# The three edits, all so the package builds from this repository alone instead
# of fetching craft-libs from GitHub at build time:
#   Cargo.toml  exclude = ["vendor"]    a path dependency inside a workspace is
#                                       otherwise made a member of it, and
#                                       craft-libs is its own workspace
#   Cargo.toml  [patch] craft-ui        points the pinned git dependency at the
#                                       vendored copy of the same commit
#   Cargo.lock  craft-ui's `source`     a patched path package has none; leaving
#                                       it makes `cargo --locked` refuse to build
#
# Archives come from `git archive`, so only tracked files arrive: no .git, no
# build output, nothing a contributor had lying around.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/filmcraft"
FILMCRAFT_URL="https://github.com/storytold/filmcraft"
CRAFT_LIBS_URL="https://github.com/storytold/craft-libs"
PINNED="ca36cf9a6af29ca6de15ebcbfbd052e6470fef8c"

check=0
rev="$PINNED"
case "${1:-}" in
  --check) check=1 ;;
  "") ;;
  *) rev="$1" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Fetches one commit of a repository and unpacks its tracked files into $3.
unpack() {
  local url="$1" commit="$2" into="$3" repo="$work/repo-$RANDOM"
  git init -q "$repo"
  if ! git -C "$repo" fetch -q --depth 1 "$url" "$commit"; then
    echo "Could not fetch $commit from $url — check the commit exists and the network reaches github.com." >&2
    exit 2
  fi
  local got
  got="$(git -C "$repo" rev-parse FETCH_HEAD)"
  case "$got" in
    "$commit"*) ;;
    *) echo "Asked $url for $commit but got $got; refusing to import the wrong tree." >&2; exit 2 ;;
  esac
  mkdir -p "$into"
  git -C "$repo" archive FETCH_HEAD | tar -x -C "$into"
  printf '%s\n' "$got"
}

out="$work/filmcraft"
filmcraft_commit="$(unpack "$FILMCRAFT_URL" "$rev" "$out")"

# FilmCraft names the craft-libs commit it builds against; vendor exactly that one.
craft_rev="$(sed -n 's/^craft-ui = .*git = "https:\/\/github.com\/storytold\/craft-libs", rev = "\([0-9a-f]\{40\}\)".*/\1/p' "$out/Cargo.toml")"
if [ -z "$craft_rev" ]; then
  echo "filmcraft@$filmcraft_commit no longer pins craft-ui to a craft-libs commit the way this script expects." >&2
  echo "Read its Cargo.toml and update the edits below before importing it." >&2
  exit 2
fi
craft_commit="$(unpack "$CRAFT_LIBS_URL" "$craft_rev" "$out/vendor/craft-libs")"

# Edit 1: keep the vendored workspace out of FilmCraft's.
grep -q '^default-members = ' "$out/Cargo.toml" || { echo "Cargo.toml has no default-members line to anchor the exclude on." >&2; exit 2; }
sed -i '/^default-members = /a exclude = ["vendor"]' "$out/Cargo.toml"

# Edit 2: build craft-ui from the vendored copy.
cat >>"$out/Cargo.toml" <<'EOF'

# Added by SAS-JACKY's scripts/vendor-filmcraft.sh: build craft-ui from the copy
# of the pinned craft-libs commit in vendor/, not from GitHub.
[patch."https://github.com/storytold/craft-libs"]
craft-ui = { path = "vendor/craft-libs/crates/ui" }
EOF

# Edit 3: the lockfile entry a path package gets.
lock_line="source = \"git+$CRAFT_LIBS_URL?rev=$craft_rev#$craft_rev\""
grep -qxF "$lock_line" "$out/Cargo.lock" || { echo "Cargo.lock has no craft-libs source line to drop: $lock_line" >&2; exit 2; }
grep -vxF "$lock_line" "$out/Cargo.lock" >"$work/Cargo.lock"
mv "$work/Cargo.lock" "$out/Cargo.lock"

cat >"$out/vendor/UPSTREAM" <<EOF
# Written by scripts/vendor-filmcraft.sh. Do not edit; re-run the script.
filmcraft  $FILMCRAFT_URL  $filmcraft_commit
craft-libs $CRAFT_LIBS_URL $craft_commit
EOF

if [ "$check" = 1 ]; then
  # Against what is committed, not the working tree: a local `cargo build`
  # leaves filmcraft/target/ behind, and that is not drift.
  committed="$work/committed"
  mkdir -p "$committed"
  git -C "$ROOT" archive HEAD:filmcraft | tar -x -C "$committed"
  if diff -r -q "$out" "$committed" >"$work/drift"; then
    echo "filmcraft/ is upstream $filmcraft_commit and craft-libs $craft_commit, plus the three edits — nothing else."
    exit 0
  fi
  echo "filmcraft/ differs from upstream $filmcraft_commit plus the three edits:" >&2
  cat "$work/drift" >&2
  exit 1
fi

rm -rf "$DEST"
mv "$out" "$DEST"
echo "Imported filmcraft $filmcraft_commit and craft-libs $craft_commit into filmcraft/."
echo "Commit with: git add -f filmcraft   (-f: the root .gitignore's 'dist' and '*.log' patterns must not drop upstream files)"
