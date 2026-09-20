#!/bin/bash
# Builds the single-file Odyssey Design installer:
#
#     packaging/dist/OdysseyDesign_<version>_Linux.run
#
# The .run is a shell script with an xz-compressed tar appended to it. Running
# it extracts to a temporary directory and starts the wizard, so the person
# installing needs no Rust, no Node and no build step.
#
#   ./packaging/build-installer.sh              build everything, then package
#   ./packaging/build-installer.sh --skip-build reuse the existing release binary

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_ID="odyssey-design"

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$ROOT/src-tauri/tauri.conf.json" | head -1)"
[ -n "$VERSION" ] || die "could not read the version out of src-tauri/tauri.conf.json"

BINARY="$ROOT/src-tauri/target/release/$APP_ID"

# ------------------------------------------------------------------ build ---

if [ "$SKIP_BUILD" -eq 0 ]; then
  command -v npm   >/dev/null 2>&1 || die "npm is required to build (or pass --skip-build)"
  command -v cargo >/dev/null 2>&1 || die "cargo is required to build (or pass --skip-build)"

  say "Installing frontend dependencies"
  if [ -f "$ROOT/package-lock.json" ]; then
    ( cd "$ROOT" && npm ci )
  else
    ( cd "$ROOT" && npm install )
  fi

  say "Building the application (this takes a while)"
  # --no-bundle: Tauri's own .deb/.rpm/AppImage outputs are not wanted here,
  # only the release binary that goes into the payload.
  ( cd "$ROOT" && npm run tauri build -- --no-bundle )
else
  say "Skipping the build, reusing the existing binary"
fi

[ -x "$BINARY" ] || die "release binary not found at $BINARY — run without --skip-build"

# ------------------------------------------------------------------ stage ---

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PAYLOAD="$STAGE/payload"

say "Staging the payload"
mkdir -p "$PAYLOAD/bin" "$PAYLOAD/share/icons" "$STAGE/lib"

install -Dm755 "$BINARY" "$PAYLOAD/bin/$APP_ID"
# The binary is already stripped by the release profile, but a locally built
# one may not be; a smaller payload is a smaller download.
command -v strip >/dev/null 2>&1 && strip --strip-unneeded "$PAYLOAD/bin/$APP_ID" 2>/dev/null || true

install -Dm644 "$ROOT/LICENSE"   "$PAYLOAD/LICENSE"
install -Dm644 "$ROOT/README.md" "$PAYLOAD/README.md"
printf '%s\n' "$VERSION" > "$PAYLOAD/VERSION"

# Icons are named for the hicolor directory they are installed into.
install -Dm644 "$ROOT/src-tauri/icons/32x32.png"      "$PAYLOAD/share/icons/32x32.png"
install -Dm644 "$ROOT/src-tauri/icons/128x128.png"    "$PAYLOAD/share/icons/128x128.png"
install -Dm644 "$ROOT/src-tauri/icons/128x128@2x.png" "$PAYLOAD/share/icons/256x256.png"
install -Dm644 "$ROOT/src-tauri/icons/icon.png"       "$PAYLOAD/share/icons/512x512.png"

install -Dm644 "$HERE/installer/$APP_ID.desktop.in" "$PAYLOAD/share/$APP_ID.desktop.in"

install -Dm755 "$HERE/installer/setup.sh"      "$STAGE/setup.sh"
install -Dm755 "$HERE/installer/uninstall.sh"  "$STAGE/uninstall.sh"
install -Dm644 "$HERE/installer/lib/common.sh" "$STAGE/lib/common.sh"

# ---------------------------------------------------------------- package ---

say "Compressing"
ARCHIVE="$STAGE/payload.tar.xz"
# Sorted names and a fixed mtime make the archive reproducible: the same input
# tree gives a byte-identical .run.
tar --create \
    --directory "$STAGE" \
    --exclude payload.tar.xz \
    --sort=name \
    --mtime="@0" --owner=0 --group=0 --numeric-owner \
    --file - \
    setup.sh uninstall.sh lib payload \
  | xz -9e -T0 > "$ARCHIVE"

CHECKSUM="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
PAYLOAD_SIZE="$(du -h "$ARCHIVE" | cut -f1)"

OUTDIR="$HERE/dist"
mkdir -p "$OUTDIR"
OUT="$OUTDIR/OdysseyDesign_${VERSION}_Linux.run"

say "Writing $OUT"

# The header is a complete shell script; the archive follows the marker line.
sed -e "s|@VERSION@|$VERSION|g" \
    -e "s|@CHECKSUM@|$CHECKSUM|g" \
    -e "s|@SIZE@|$PAYLOAD_SIZE|g" \
    "$HERE/installer/header.sh.in" > "$OUT"
cat "$ARCHIVE" >> "$OUT"
chmod 755 "$OUT"

say "Done"

# The checksum people verify, and the one sync-release.sh publishes, is the
# .run's own. $CHECKSUM is the inner payload's, which the header checks after
# it splits the archive off; printing that one here would be read as the file's.
OUT_SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"
printf '\n  %s\n  %s, payload %s\n  sha256 %s\n  payload sha256 %s\n\n' \
  "$OUT" "$(du -h "$OUT" | cut -f1)" "$PAYLOAD_SIZE" "$OUT_SHA" "$CHECKSUM"
