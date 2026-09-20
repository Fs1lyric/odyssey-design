#!/bin/bash
# Removes an Odyssey Design installation, using the manifest written at install
# time so only the files this installer created are touched. Installed to
# <prefix>/uninstall.sh and run from there.
#
#   ./uninstall.sh          ask first, graphically where there is a display
#   ./uninstall.sh --yes    remove without asking, for scripts and packaging
#   ./uninstall.sh --text   ask in the terminal even where there is a display

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"

# The removal pass deletes this script and its library, so it runs from a
# throwaway copy and is told where everything lives. Sourcing follows suit.
ODY_PREFIX="${ODY_PREFIX:-$HERE}"
ODY_LIB="${ODY_LIB:-$HERE/lib/common.sh}"
# shellcheck source=lib/common.sh
. "$ODY_LIB"

MANIFEST="${ODY_MANIFEST:-$ODY_PREFIX/install-manifest.txt}"
VERSION="$(cat "$ODY_PREFIX/VERSION" 2>/dev/null || echo "unknown")"

remove_files() {
  echo "10"; echo "# Removing installed files"

  local total done=0 line appdir="" icondirs=""
  total="$(wc -l < "$MANIFEST" 2>/dev/null || echo 1)"
  [ "$total" -gt 0 ] || total=1

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *.desktop) appdir="$(dirname "$line")" ;;
      */icons/hicolor/*) icondirs="$icondirs $(dirname "$line")" ;;
    esac
    # -e is false for a dangling symlink, so test for the link separately.
    if [ -e "$line" ] || [ -L "$line" ]; then
      rm -f "$line" 2>/dev/null
    fi
    done=$((done + 1))
    echo "$((10 + done * 70 / total))"
  done < "$MANIFEST"

  echo "85"; echo "# Clearing empty directories"
  # Only directories the installer created, and only while they are empty:
  # rmdir refuses otherwise, which is exactly the safety wanted here. The
  # hicolor size directories are shared with every other application, so they
  # go only if this was the last icon in them.
  local icondir
  for icondir in $icondirs; do
    # <hicolor>/<size>/apps, then <hicolor>/<size>.
    rmdir "$icondir" "$(dirname "$icondir")" 2>/dev/null
  done
  rmdir "$ODY_PREFIX/bin" "$ODY_PREFIX/lib" "$ODY_PREFIX" 2>/dev/null

  echo "92"; echo "# Refreshing the desktop database"
  if [ -n "$appdir" ] && [ -d "$appdir" ]; then
    command -v update-desktop-database >/dev/null 2>&1 &&
      update-desktop-database "$appdir" >/dev/null 2>&1
  fi

  echo "100"; echo "# Done"
  return 0
}

if [ "${1:-}" = "--perform-uninstall" ]; then
  remove_files
  exit $?
fi

ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    # Answering for the person only makes sense without a dialog to answer in.
    --text)   ODYSSEY_TEXT_INSTALL=1; export ODYSSEY_TEXT_INSTALL ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
# An unattended run must never block on a dialog nobody is there to dismiss.
if [ "$ASSUME_YES" -eq 1 ]; then
  ODYSSEY_TEXT_INSTALL=1; export ODYSSEY_TEXT_INSTALL
fi

detect_distro
ui_init

if [ ! -r "$MANIFEST" ]; then
  ui_error "No install manifest found at $MANIFEST.\n\nThis copy of $APP_NAME cannot be removed automatically; delete $ODY_PREFIX by hand."
  exit 1
fi

if [ "$ASSUME_YES" -eq 0 ] && ! ui_confirm "Remove $APP_NAME" \
  "<b>Remove $APP_NAME $VERSION?</b>\n\nThis deletes the application from <tt>$ODY_PREFIX</tt> and removes its menu entry.\n\nYour documents are stored separately, in your user data directory, and are <b>not</b> deleted." \
  "Remove"; then
  exit 0
fi

# Run the removal from a copy, because it deletes the original underneath it.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cp "$0" "$WORKDIR/uninstall.sh"
cp "$ODY_LIB" "$WORKDIR/common.sh"
chmod 755 "$WORKDIR/uninstall.sh"
# Root must be able to read them back out of the temp directory.
chmod 755 "$WORKDIR"

# Writing into /opt needs root; a home-directory install does not.
if [ -w "$ODY_PREFIX" ] || [ "$(id -u)" -eq 0 ]; then
  ESCALATE=()
elif command -v pkexec >/dev/null 2>&1 && [ "$UI_MODE" = "gui" ]; then
  ESCALATE=(pkexec env
    "ODY_PREFIX=$ODY_PREFIX" "ODY_LIB=$WORKDIR/common.sh" "ODY_MANIFEST=$MANIFEST")
elif command -v sudo >/dev/null 2>&1; then
  ESCALATE=(sudo
    "ODY_PREFIX=$ODY_PREFIX" "ODY_LIB=$WORKDIR/common.sh" "ODY_MANIFEST=$MANIFEST")
else
  ui_error "Removing $APP_NAME from $ODY_PREFIX needs root, and neither pkexec nor sudo is available."
  exit 1
fi

export ODY_PREFIX ODY_MANIFEST="$MANIFEST" ODY_LIB="$WORKDIR/common.sh"

uninstall_worker() {
  ${ESCALATE[@]+"${ESCALATE[@]}"} /bin/bash "$WORKDIR/uninstall.sh" --perform-uninstall
}

if run_with_progress "Removing $APP_NAME" uninstall_worker; then
  ui_info "$APP_NAME" "$APP_NAME has been removed."
  exit 0
else
  ui_error "Removing $APP_NAME failed. Some files may still be present in $ODY_PREFIX."
  exit 1
fi
