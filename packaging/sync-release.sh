#!/bin/bash
# Renders every package manifest from one published release.
#
# The manifests all say the same three things: a version, a URL and a SHA-256.
# Keeping them in five hand-edited files is how one of them ends up a version
# behind, so they are generated from templates/ instead, and this is the only
# place a version or a checksum is written down.
#
#   ./packaging/sync-release.sh v0.1.0        read the checksums off the release
#   ./packaging/sync-release.sh v0.1.0 --local
#                                             read them off files in packaging/dist
#   ./packaging/sync-release.sh v0.1.0 --check
#                                             render to a temporary directory and
#                                             diff, changing nothing
#
# Rendered output:
#   packaging/winget/Fs1lyric.OdysseyDesign.*.yaml
#   packaging/scoop/odyssey-design.json
#   packaging/homebrew/Casks/odyssey-design.rb
#   packaging/aur/odyssey-design-bin/{PKGBUILD,.SRCINFO}
#   packaging/aur/odyssey-design-git/.SRCINFO
#   site/releases.json

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TPL="$HERE/templates"
REPO="Fs1lyric/odyssey-design"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

TAG="${1:-}"
[ -n "$TAG" ] || die "usage: $0 <tag> [--local|--check]"
shift

MODE="release"
for arg in "$@"; do
  case "$arg" in
    --local) MODE="local" ;;
    --check) MODE="check" ;;
    *) die "unknown option: $arg" ;;
  esac
done

VERSION="${TAG#v}"
DATE="$(date -u +%Y-%m-%d)"

OUT="$ROOT"
if [ "$MODE" = "check" ]; then
  OUT="$(mktemp -d)"
  trap 'rm -rf "$OUT"' EXIT
  mkdir -p "$OUT/packaging" "$OUT/site"
  cp -r "$HERE/winget" "$HERE/scoop" "$HERE/homebrew" "$HERE/aur" "$OUT/packaging/" 2>/dev/null || true
fi

# ------------------------------------------------------------- checksums ---
# Asset names are fixed by .github/workflows/release.yml. A missing one is not
# fatal: that platform's manifest is skipped and said so, which is what happens
# while a release is still building.

declare -A SUM

asset_name() {
  case "$1" in
    linux_run)  echo "OdysseyDesign_${VERSION}_Linux.run" ;;
    linux_deb)  echo "OdysseyDesign_${VERSION}_amd64.deb" ;;
    win_msi)    echo "OdysseyDesign_${VERSION}_Windows_x64.msi" ;;
    win_zip)    echo "OdysseyDesign_${VERSION}_Windows_x64_portable.zip" ;;
    mac_arm)    echo "OdysseyDesign_${VERSION}_macOS_arm64.dmg" ;;
    mac_x64)    echo "OdysseyDesign_${VERSION}_macOS_x64.dmg" ;;
  esac
}

KEYS=(linux_run linux_deb win_msi win_zip mac_arm mac_x64)

if [ "$MODE" = "local" ]; then
  say "Reading checksums from packaging/dist"
  for key in "${KEYS[@]}"; do
    f="$HERE/dist/$(asset_name "$key")"
    [ -f "$f" ] && SUM[$key]="$(sha256sum "$f" | cut -d' ' -f1)"
  done
else
  command -v gh >/dev/null 2>&1 || die "gh is required to read a release (or pass --local)"
  say "Reading checksums from the $TAG release"

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  # checksums.txt is written by the release workflow, so one small download
  # covers every asset instead of fetching each file to hash it here.
  if gh release download "$TAG" --repo "$REPO" --pattern checksums.txt \
       --dir "$WORK" >/dev/null 2>&1; then
    while read -r sum name; do
      for key in "${KEYS[@]}"; do
        [ "$name" = "$(asset_name "$key")" ] && SUM[$key]="$sum"
      done
    done < <(sed 's/^\([0-9a-f]*\)[[:space:]]*\*\?/\1 /' "$WORK/checksums.txt")
  else
    warn "no checksums.txt on $TAG; downloading each asset to hash it"
    for key in "${KEYS[@]}"; do
      name="$(asset_name "$key")"
      if gh release download "$TAG" --repo "$REPO" --pattern "$name" \
           --dir "$WORK" >/dev/null 2>&1; then
        SUM[$key]="$(sha256sum "$WORK/$name" | cut -d' ' -f1)"
      fi
    done
  fi
fi

for key in "${KEYS[@]}"; do
  if [ -n "${SUM[$key]:-}" ]; then
    printf '    %-10s %s\n' "$key" "${SUM[$key]}"
  else
    warn "no artifact for $key; manifests that need it are skipped"
  fi
done

# ---------------------------------------------------------------- render ---

render() {
  local template="$1" target="$2"
  mkdir -p "$(dirname "$target")"
  sed -e "s|@VERSION@|$VERSION|g" \
      -e "s|@DATE@|$DATE|g" \
      -e "s|@SHA_LINUX_RUN@|${SUM[linux_run]:-}|g" \
      -e "s|@SHA_WIN_MSI@|${SUM[win_msi]:-}|g" \
      -e "s|@SHA_WIN_ZIP@|${SUM[win_zip]:-}|g" \
      -e "s|@SHA_MAC_ARM@|${SUM[mac_arm]:-}|g" \
      -e "s|@SHA_MAC_X64@|${SUM[mac_x64]:-}|g" \
      "$template" > "$target"
  say "wrote ${target#"$OUT"/}"
}

if [ -n "${SUM[win_msi]:-}" ]; then
  render "$TPL/winget-version.yaml.in"   "$OUT/packaging/winget/Fs1lyric.OdysseyDesign.yaml"
  render "$TPL/winget-installer.yaml.in" "$OUT/packaging/winget/Fs1lyric.OdysseyDesign.installer.yaml"
  render "$TPL/winget-locale.yaml.in"    "$OUT/packaging/winget/Fs1lyric.OdysseyDesign.locale.en-US.yaml"
fi

[ -n "${SUM[win_zip]:-}" ] &&
  render "$TPL/scoop.json.in" "$OUT/packaging/scoop/odyssey-design.json"

if [ -n "${SUM[mac_arm]:-}" ] && [ -n "${SUM[mac_x64]:-}" ]; then
  render "$TPL/homebrew-cask.rb.in" "$OUT/packaging/homebrew/Casks/odyssey-design.rb"
fi

[ -n "${SUM[linux_run]:-}" ] &&
  render "$TPL/aur-bin-PKGBUILD.in" "$OUT/packaging/aur/odyssey-design-bin/PKGBUILD"

# ------------------------------------------------------------- .SRCINFO ---
# The AUR rejects a push whose .SRCINFO disagrees with its PKGBUILD, and only
# makepkg can generate one. Off Arch it is skipped with a note rather than
# written wrong.

if command -v makepkg >/dev/null 2>&1; then
  for pkg in odyssey-design-bin odyssey-design-git; do
    dir="$OUT/packaging/aur/$pkg"
    [ -f "$dir/PKGBUILD" ] || continue
    ( cd "$dir" && makepkg --printsrcinfo > .SRCINFO )
    say "wrote packaging/aur/$pkg/.SRCINFO"
  done
else
  warn "makepkg not found; .SRCINFO not regenerated. Run this on Arch before pushing to the AUR."
fi

# --------------------------------------------------------- releases.json ---
# The site reads this for its version string, its file table and the published
# state of each channel. Channel flags are preserved across runs: publishing to
# a registry is a separate act from cutting a release.

# The renderer reads the sums and sizes out of the environment, so export
# them rather than interpolating into the script body.
for key in "${KEYS[@]}"; do
  upper="$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  export "SUM_$upper=${SUM[$key]:-}"
  size=""
  if [ -n "${SUM[$key]:-}" ]; then
    local_file="$HERE/dist/$(asset_name "$key")"
    [ -f "$local_file" ] && size="$(stat -c%s "$local_file")"
    [ -z "$size" ] && [ -f "${WORK:-/nonexistent}/$(asset_name "$key")" ] &&
      size="$(stat -c%s "$WORK/$(asset_name "$key")")"
  fi
  export "BYTES_$upper=$size"
done

export PUBLISHED_MODE="$MODE"
python3 - "$OUT/site/releases.json" "$VERSION" "$TAG" <<'PY'
import json, os, sys

path, version, tag = sys.argv[1], sys.argv[2], sys.argv[3]

sums = {}
for key in ("linux_run", "linux_deb", "win_msi", "win_zip", "mac_arm", "mac_x64"):
    value = os.environ.get("SUM_" + key.upper())
    if value:
        sums[key] = value

shape = [
    ("linux_run", "Linux",   "x86_64", "Self-extracting installer", f"OdysseyDesign_{version}_Linux.run"),
    ("linux_deb", "Linux",   "amd64",  "Debian package",            f"OdysseyDesign_{version}_amd64.deb"),
    ("win_msi",   "Windows", "x64",    "MSI installer",             f"OdysseyDesign_{version}_Windows_x64.msi"),
    ("win_zip",   "Windows", "x64",    "Portable archive",          f"OdysseyDesign_{version}_Windows_x64_portable.zip"),
    ("mac_arm",   "macOS",   "arm64",  "Disk image",                f"OdysseyDesign_{version}_macOS_arm64.dmg"),
    ("mac_x64",   "macOS",   "x64",    "Disk image",                f"OdysseyDesign_{version}_macOS_x64.dmg"),
]

assets = [
    {"platform": p, "arch": a, "kind": k, "file": f,
     "bytes": int(os.environ.get("BYTES_" + key.upper(), 0)) or None,
     "sha256": sums[key]}
    for key, p, a, k, f in shape if key in sums
]

try:
    with open(path) as fh:
        previous = json.load(fh)
except (OSError, ValueError):
    previous = {}

channels = previous.get("channels") or {
    "run":      {"available": True},
    "aur":      {"available": False, "packages": ["odyssey-design-bin", "odyssey-design-git"]},
    "winget":   {"available": False, "id": "Fs1lyric.OdysseyDesign"},
    "scoop":    {"available": False, "bucket": "https://github.com/Fs1lyric/scoop-odyssey"},
    "homebrew": {"available": False, "tap": "fs1lyric/odyssey"},
}

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as fh:
    json.dump({
        "_comment": "Written by packaging/sync-release.sh. Editing by hand is fine, but the script will overwrite it on the next release.",
        "version": version,
        "tag": tag,
        "published": bool(assets) and os.environ.get("PUBLISHED_MODE") != "local",
        "repo": "Fs1lyric/odyssey-design",
        "assets": assets,
        "channels": channels,
    }, fh, indent=2)
    fh.write("\n")
print("    site/releases.json")
PY

# ----------------------------------------------------------------- check ---

if [ "$MODE" = "check" ]; then
  say "Comparing against the working tree"
  if diff -ru --exclude=.git "$ROOT/packaging/winget"   "$OUT/packaging/winget"   &&
     diff -ru --exclude=.git "$ROOT/packaging/scoop"    "$OUT/packaging/scoop"    &&
     diff -ru --exclude=.git "$ROOT/packaging/homebrew" "$OUT/packaging/homebrew" &&
     diff -ru --exclude=.git "$ROOT/packaging/aur"      "$OUT/packaging/aur"      &&
     diff -u "$ROOT/site/releases.json" "$OUT/site/releases.json"; then
    say "Manifests are up to date."
  else
    die "manifests are out of date; run without --check to regenerate"
  fi
  exit 0
fi

say "Done. Next: packaging/SUBMITTING.md"
