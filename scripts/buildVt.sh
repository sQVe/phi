#!/usr/bin/env bash
# Build build/libphi-vt.so: src/vt/shim.c linked with libghostty-vt built from a pinned Ghostty
# commit with patches/*.patch applied. Zig and the Ghostty source are cached under
# ${XDG_CACHE_HOME:-$HOME/.cache}/phi; nothing is installed system-wide.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "build:vt supports Linux x86_64 only, not $(uname -s) $(uname -m)." >&2
  exit 1
fi

zig_version=0.16.0
zig_sha256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ghostty_commit=83edd491e3024ae5e50393d62877b8897da1cccd
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/phi"
zig_dir="$cache_dir/zig-$zig_version"
ghostty_dir="$cache_dir/ghostty-$ghostty_commit"
# Zig fetches Ghostty's build dependencies into its global cache. Keeping it here lets one cache
# directory hold every download.
export ZIG_GLOBAL_CACHE_DIR="$cache_dir/zig-cache"

mkdir -p "$cache_dir"

# Each download goes to a temporary path first, so an interrupted run leaves no partial directory.
if [[ ! -x "$zig_dir/zig" ]]; then
  rm -rf "$zig_dir.tmp" "$zig_dir.tar.xz"
  curl -fsSL "https://ziglang.org/download/$zig_version/zig-x86_64-linux-$zig_version.tar.xz" -o "$zig_dir.tar.xz"
  echo "$zig_sha256  $zig_dir.tar.xz" | sha256sum -c --quiet
  mkdir -p "$zig_dir.tmp"
  tar -xJf "$zig_dir.tar.xz" -C "$zig_dir.tmp" --strip-components=1
  rm "$zig_dir.tar.xz"
  mv "$zig_dir.tmp" "$zig_dir"
fi

if [[ ! -d "$ghostty_dir" ]]; then
  rm -rf "$ghostty_dir.tmp"
  git init -q "$ghostty_dir.tmp"
  git -C "$ghostty_dir.tmp" fetch -q --depth 1 https://github.com/ghostty-org/ghostty.git "$ghostty_commit"
  git -C "$ghostty_dir.tmp" checkout -q FETCH_HEAD
  mv "$ghostty_dir.tmp" "$ghostty_dir"
fi

# git apply --reverse --check succeeds only when a patch is already applied, so a second run skips
# it. A patch that is neither applied nor applies cleanly fails the build.
for patch in "$PWD"/patches/*.patch; do
  if git -C "$ghostty_dir" apply --reverse --check "$patch" 2>/dev/null; then
    continue
  fi
  if ! git -C "$ghostty_dir" apply "$patch"; then
    echo "$(basename "$patch") does not apply to Ghostty $ghostty_commit." >&2
    echo "If you changed an applied patch, delete $ghostty_dir and rebuild." >&2
    exit 1
  fi
  echo "applied $(basename "$patch")"
done

(cd "$ghostty_dir" && "$zig_dir/zig" build -Demit-lib-vt=true -Doptimize=ReleaseFast)
mkdir -p build
"$zig_dir/zig" cc -O2 -shared -fPIC -I"$ghostty_dir/include" \
  -DPHI_GHOSTTY_COMMIT="\"$ghostty_commit\"" src/vt/shim.c \
  "$ghostty_dir/zig-out/lib/libghostty-vt.a" -o build/libphi-vt.so
echo "built build/libphi-vt.so"
