#!/usr/bin/env bash
#
# gen-rn-bindings.sh - build the subetha-core staticlib with the `uniffi` feature and generate the
# React Native Turbo Module in sdk/react-native-core with uniffi-bindgen-react-native (ubrn).
#
# Usage: sdk/core/scripts/gen-rn-bindings.sh [--check]
#
#   --check    generate into a temp dir and fail if the committed sources differ (CI)
#
# Outputs (committed; see sdk/core/BINDINGS.md and sdk/react-native-core/README.md):
#   sdk/react-native-core/src/{index.tsx,NativeSubEthaCore.ts,generated/}   TypeScript
#   sdk/react-native-core/cpp/                                              JSI C++
#   sdk/react-native-core/android/, ios/, sub-etha-core.podspec             Turbo Module glue
#
# ubrn's npm package builds its CLI with cargo on first use (about a minute). Set UBRN to use
# an already-built `ubrn` instead of `npx uniffi-bindgen-react-native@$UBRN_VERSION`.

set -euo pipefail

UBRN_VERSION=0.28.3-5   # keep in step with uniffi 0.28 in sdk/core/Cargo.toml and the package.json
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
pkg="$root/sdk/react-native-core"
check=0
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    -h|--help) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "gen-rn-bindings: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$root"
cargo build -p subetha-core --features uniffi --lib
target_dir="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
lib="$target_dir/debug/libsubetha_core.a"
[ -f "$lib" ] || { echo "gen-rn-bindings: $lib not found" >&2; exit 1; }

if [ -n "${UBRN:-}" ]; then ubrn=("$UBRN"); else ubrn=(npx --yes "uniffi-bindgen-react-native@$UBRN_VERSION"); fi

# The generated files, relative to the package (everything else there is hand-written).
generated=(src/index.tsx src/NativeSubEthaCore.ts src/generated cpp android/CMakeLists.txt
  android/build.gradle android/cpp-adapter.cpp android/src/main/AndroidManifest.xml
  android/src/main/java ios/SubEthaCore.h ios/SubEthaCore.mm sub-etha-core.podspec)

# ubrn writes into the package itself (it resolves rust.directory, ../core, against it). For
# --check, keep a copy of the committed package, generate, compare, and put the copy back.
tmp="$(mktemp -d)"
cp -R "$pkg" "$tmp/committed"
restore() { if [ "$check" = 1 ]; then rm -rf "$pkg" && cp -R "$tmp/committed" "$pkg"; fi; rm -rf "$tmp"; }
trap restore EXIT
for f in "${generated[@]}"; do rm -rf "${pkg:?}/$f"; done
(cd "$pkg" && "${ubrn[@]}" generate all --config ubrn.config.yaml "$lib")

status=0
for f in "${generated[@]}"; do
  [ -e "$pkg/$f" ] || { echo "gen-rn-bindings: ubrn did not write $f" >&2; status=1; continue; }
  if [ "$check" = 1 ]; then diff -ru "$tmp/committed/$f" "$pkg/$f" || status=1; fi
done
# Anything else ubrn wrote is new: fail so the list above (and the commit) stay complete.
known="$(printf '%s\n' "${generated[@]}" | sed 's/[.]/\\./g; s|^|^\\./|; s|$|\\(/\\\|$\\)|')"
extra="$(comm -13 <(cd "$tmp/committed" && find . -type f | sort) <(cd "$pkg" && find . -type f | sort) | grep -v -f <(echo "$known") || true)"
[ -z "$extra" ] || { echo "gen-rn-bindings: ubrn wrote files this script doesn't know about:" >&2; echo "$extra" >&2; status=1; }

if [ "$check" = 1 ]; then
  if [ "$status" != 0 ]; then
    echo "gen-rn-bindings: committed React Native bindings are stale; run sdk/core/scripts/gen-rn-bindings.sh" >&2
    exit 1
  fi
  echo "gen-rn-bindings: bindings up to date"
elif [ "$status" != 0 ]; then
  exit 1
else
  echo "gen-rn-bindings: wrote $pkg"
fi
