#!/usr/bin/env bash
#
# Imports third-party projects into third_party/<name>/, each one whole and
# byte-for-byte as upstream tracks it at the commit third_party/UPSTREAM pins.
#
#   scripts/vendor.sh                     # re-import every pinned project
#   scripts/vendor.sh <name>              # re-import one
#   scripts/vendor.sh <name> <commit>     # move one to another upstream commit (updates UPSTREAM)
#   scripts/vendor.sh --check [<name>]    # exit 1 unless what is committed equals upstream, byte for byte
#
# Why untouched copies: a vendored tree nobody can regenerate is a tree nobody
# can audit, and --check turning up empty is the proof that third_party/ holds
# upstream's code and nothing else. It matters legally too: FilmCraft's
# ArtCraft logos are licensed only "as part of copies of this repository", and
# a modified copy would have to strip them. So nothing here is ever edited in
# place — anything this repository needs to change lives outside third_party/.
#
# Archives come from `git archive`, so only tracked files arrive: no .git, no
# build output, nothing a contributor had lying around.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/third_party/UPSTREAM"
# GitHub refuses any blob over 100 MB; a push carrying one fails after the upload.
MAX_BYTES=$((100 * 1024 * 1024))

check=0
if [ "${1:-}" = "--check" ]; then check=1; shift; fi
only="${1:-}"
move_to="${2:-}"
if [ -n "$move_to" ] && [ "$check" = 1 ]; then
  echo "--check takes a name, not a commit." >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# name url commit, one per line; '#' starts a comment.
entries() { sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$MANIFEST"; }

if [ -n "$only" ] && ! entries | awk -v n="$only" '$1 == n { found = 1 } END { exit !found }'; then
  echo "third_party/UPSTREAM has no project named '$only'." >&2
  exit 2
fi

# Fetches one commit and unpacks its tracked files into $3. Prints the full commit.
unpack() {
  local url="$1" commit="$2" into="$3" repo
  repo="$(mktemp -d "$work/repo.XXXXXX")"
  git init -q "$repo"
  if ! git -C "$repo" fetch -q --depth 1 "$url" "$commit"; then
    echo "Could not fetch $commit from $url — check the commit exists and the network reaches it." >&2
    return 2
  fi
  local got
  got="$(git -C "$repo" rev-parse FETCH_HEAD)"
  case "$got" in
    "$commit"*) ;;
    *) echo "Asked $url for $commit but got $got; refusing to import the wrong tree." >&2; return 2 ;;
  esac
  mkdir -p "$into"
  git -C "$repo" archive FETCH_HEAD | tar -x -C "$into"
  rm -rf "$repo"
  printf '%s\n' "$got"
}

# Refuses trees that cannot be committed here as they are.
importable() {
  local name="$1" dir="$2" lfs big
  # git archive writes an LFS file as its pointer. Committed here, the pointer's
  # filter attribute would make every push demand an object this repository
  # never had; imported without it, the game silently lacks its art.
  lfs="$(find "$dir" -name .gitattributes -exec grep -l 'filter=lfs' {} + 2>/dev/null || true)"
  if [ -n "$lfs" ]; then
    echo "$name keeps files in Git LFS (${lfs#"$dir"/}); this script cannot import it whole." >&2
    return 2
  fi
  # git archive leaves a submodule out entirely — freeminer's playable game is
  # one — so the copy would look whole and silently not be.
  if [ -f "$dir/.gitmodules" ]; then
    echo "$name has git submodules ($(grep -c 'path =' "$dir/.gitmodules") of them); git archive would leave them out, so the import would not be whole." >&2
    return 2
  fi
  # A symlink is committed as a link, and one that climbs out of its project
  # would point any tool that follows it at the rest of this repository, or the
  # machine. Links inside the project (the Cataclysm forks' Android assets) are
  # fine; a link whose target is missing is fine too, it resolves after a build.
  local link escapes=""
  while IFS= read -r -d '' link; do
    case "$(realpath -m "$link")" in
      "$(realpath -m "$dir")"/*) ;;
      *) escapes="$escapes ${link#"$dir"/}" ;;
    esac
  done < <(find "$dir" -type l -print0)
  if [ -n "$escapes" ]; then
    echo "$name has symlinks pointing outside itself:$escapes" >&2
    return 2
  fi
  big="$(find "$dir" -type f -size +"${MAX_BYTES}"c -printf '%s %P\n' | head -5)"
  if [ -n "$big" ]; then
    echo "$name has files over GitHub's 100 MB limit:" >&2
    printf '  %s\n' "$big" >&2
    return 2
  fi
}

status=0
while read -r name url pinned; do
  [ -z "$only" ] || [ "$name" = "$only" ] || continue
  want="${move_to:-$pinned}"
  out="$work/$name"
  if ! commit="$(unpack "$url" "$want" "$out" </dev/null)"; then status=1; continue; fi

  if [ "$check" = 1 ]; then
    # Against what is committed, not the working tree: a local build leaves
    # target/ and the like behind, and that is not drift.
    committed="$work/committed-$name"
    mkdir -p "$committed"
    if ! git -C "$ROOT" archive "HEAD:third_party/$name" 2>/dev/null | tar -x -C "$committed"; then
      echo "$name: nothing committed at third_party/$name yet." >&2
      status=1
    elif diff -r -q "$out" "$committed" >"$work/drift-$name"; then
      echo "$name: committed tree is upstream $commit, byte for byte."
    else
      echo "$name: committed tree differs from upstream $commit:" >&2
      sed 's/^/  /' "$work/drift-$name" >&2
      status=1
    fi
    continue
  fi

  if ! importable "$name" "$out"; then status=1; continue; fi
  rm -rf "${ROOT:?}/third_party/$name"
  mv "$out" "$ROOT/third_party/$name"
  if [ "$commit" != "$pinned" ]; then
    awk -v n="$name" -v c="$commit" '$1 == n && !/^[[:space:]]*#/ { sub($3, c) } { print }' "$MANIFEST" >"$work/UPSTREAM"
    cat "$work/UPSTREAM" >"$MANIFEST"
  fi
  echo "$name: imported $commit into third_party/$name."
done < <(entries)

if [ "$check" = 0 ] && [ "$status" = 0 ]; then
  echo "Commit with: git add -f third_party   (-f: the root .gitignore's 'dist' and '*.log' patterns must not drop upstream files)"
fi
exit "$status"
