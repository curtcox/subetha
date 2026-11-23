#!/usr/bin/env bash
#
# gen-bindings.sh - build the subetha-core cdylib with the `uniffi` feature and generate the
# Kotlin and Swift bindings from it (UniFFI "library mode").
#
# Usage: sdk/core/scripts/gen-bindings.sh [--release] [--check]
#
#   --release  build the library with the release profile (default: debug, which is faster;
#              the generated sources are identical)
#   --check    generate into a temp dir and fail if the committed sources differ (CI)
#
# Outputs (committed; see sdk/core/BINDINGS.md):
#   sdk/kotlin/subetha-core/src/main/kotlin/us/subetha/core/ffi/subetha_core.kt
#   sdk/swift/Sources/SubEthaCoreFFI/subetha_core.swift
#   sdk/swift/ffi/subetha_coreFFI.h, sdk/swift/ffi/module.modulemap   (go into the XCFramework)
#
# Also prints the path of the host cdylib, which the Kotlin tests load through JNA
# (-Psubetha.core.lib=<dir>, or the default target/<profile>/ lookup).

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
profile=debug
check=0
for arg in "$@"; do
  case "$arg" in
    --release) profile=release ;;
    --check) check=1 ;;
    -h|--help) sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "gen-bindings: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$root"
cargo_flags=(-p subetha-core --features uniffi --lib)
[ "$profile" = release ] && cargo_flags+=(--release)
cargo build "${cargo_flags[@]}"

target_dir="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
case "$(uname -s)" in
  Darwin) lib="$target_dir/$profile/libsubetha_core.dylib" ;;
  MINGW*|MSYS*|CYGWIN*) lib="$target_dir/$profile/subetha_core.dll" ;;
  *) lib="$target_dir/$profile/libsubetha_core.so" ;;
esac
[ -f "$lib" ] || { echo "gen-bindings: $lib not found" >&2; exit 1; }

bindgen=(cargo run -q -p subetha-core --features bindgen --bin uniffi-bindgen --)
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

"${bindgen[@]}" generate --library "$lib" --language kotlin --no-format --out-dir "$tmp/kotlin"
"${bindgen[@]}" generate --library "$lib" --language swift --no-format --out-dir "$tmp/swift"

kotlin_out="$root/sdk/kotlin/subetha-core/src/main/kotlin/us/subetha/core/ffi"
swift_out="$root/sdk/swift/Sources/SubEthaCoreFFI"
ffi_out="$root/sdk/swift/ffi"

stage="$tmp/stage"
mkdir -p "$stage/kotlin" "$stage/swift" "$stage/ffi"
cp "$tmp/kotlin/us/subetha/core/ffi/subetha_core.kt" "$stage/kotlin/"
cp "$tmp/swift/subetha_core.swift" "$stage/swift/"
cp "$tmp/swift/subetha_coreFFI.h" "$stage/ffi/"
# SwiftPM/Xcode want the file named module.modulemap inside the XCFramework's Headers.
cp "$tmp/swift/subetha_coreFFI.modulemap" "$stage/ffi/module.modulemap"

if [ "$check" = 1 ]; then
  status=0
  diff -u "$kotlin_out/subetha_core.kt" "$stage/kotlin/subetha_core.kt" || status=1
  diff -u "$swift_out/subetha_core.swift" "$stage/swift/subetha_core.swift" || status=1
  diff -u "$ffi_out/subetha_coreFFI.h" "$stage/ffi/subetha_coreFFI.h" || status=1
  diff -u "$ffi_out/module.modulemap" "$stage/ffi/module.modulemap" || status=1
  if [ "$status" != 0 ]; then
    echo "gen-bindings: committed bindings are stale; run sdk/core/scripts/gen-bindings.sh" >&2
    exit 1
  fi
  echo "gen-bindings: bindings up to date"
else
  mkdir -p "$kotlin_out" "$swift_out" "$ffi_out"
  cp "$stage/kotlin/subetha_core.kt" "$kotlin_out/"
  cp "$stage/swift/subetha_core.swift" "$swift_out/"
  cp "$stage/ffi/subetha_coreFFI.h" "$stage/ffi/module.modulemap" "$ffi_out/"
  echo "gen-bindings: wrote $kotlin_out, $swift_out, $ffi_out"
fi
echo "gen-bindings: host library $lib"
