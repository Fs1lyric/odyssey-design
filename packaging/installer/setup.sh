#!/bin/bash
# Odyssey Design installer.
#
# Two modes. With no arguments it runs the wizard: welcome, licence, scope,
# dependency check, install, finish. With --perform-install it does the file
# operations and nothing else, reading its settings from the environment.
# The wizard runs as the user and escalates only that second mode, so the
# graphical part never runs as root.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

PAYLOAD="$HERE/payload"
VERSION="$(cat "$PAYLOAD/VERSION" 2>/dev/null || echo "0.0.0")"

# ------------------------------------------------------- privileged half ----

# Emits "NN" progress percentages and "# text" status lines on stdout.
perform_install() {
  local prefix="$ODY_PREFIX" bindir="$ODY_BINDIR"
  local appdir="$ODY_APPDIR" icondir="$ODY_ICONDIR"
  local manifest="$prefix/install-manifest.txt"
  local -a installed=()

  record() { installed+=("$1"); }

  echo "5"; echo "# Creating $prefix"
  mkdir -p "$prefix/bin" || return 1

  echo "20"; echo "# Installing the application"
  install -Dm755 "$PAYLOAD/bin/$APP_ID" "$prefix/bin/$APP_ID" || return 1
  record "$prefix/bin/$APP_ID"

  local doc
  for doc in LICENSE README.md VERSION; do
    if [ -f "$PAYLOAD/$doc" ]; then
      install -Dm644 "$PAYLOAD/$doc" "$prefix/$doc" || return 1
      record "$prefix/$doc"
    fi
  done

  echo "45"; echo "# Installing icons"
  local icon size
  for icon in "$PAYLOAD"/share/icons/*.png; do
    [ -f "$icon" ] || continue
    size="$(basename "$icon" .png)"
    install -Dm644 "$icon" "$icondir/${size}/apps/$APP_ID.png" || return 1
    record "$icondir/${size}/apps/$APP_ID.png"
  done

  echo "60"; echo "# Creating the menu entry"
  mkdir -p "$appdir"
  # Exec is absolute so the entry works whether or not bindir is on PATH.
  sed "s|@EXEC@|$prefix/bin/$APP_ID|g; s|@ICON@|$APP_ID|g" \
    "$PAYLOAD/share/$APP_ID.desktop.in" > "$appdir/$APP_ID.desktop" || return 1
  chmod 644 "$appdir/$APP_ID.desktop"
  record "$appdir/$APP_ID.desktop"

  echo "75"; echo "# Linking $bindir/$APP_ID"
  mkdir -p "$bindir"
  ln -sfn "$prefix/bin/$APP_ID" "$bindir/$APP_ID" || return 1
  record "$bindir/$APP_ID"

  echo "85"; echo "# Installing the uninstaller"
  install -Dm755 "$HERE/uninstall.sh" "$prefix/uninstall.sh" || return 1
  install -Dm644 "$HERE/lib/common.sh" "$prefix/lib/common.sh" || return 1
  record "$prefix/uninstall.sh"
  record "$prefix/lib/common.sh"

  echo "92"; echo "# Refreshing the desktop database"
  # Both are best-effort: the entry is valid without them, they just make it
  # show up in the menu without a re-login.
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$appdir" >/dev/null 2>&1
  command -v gtk-update-icon-cache >/dev/null 2>&1 &&
    gtk-update-icon-cache -qtf "$(dirname "$icondir")/hicolor" >/dev/null 2>&1

  # The manifest is what uninstall.sh removes, so it is written last and
  # lists itself.
  record "$manifest"
  printf '%s\n' "${installed[@]}" > "$manifest"
  chmod 644 "$manifest"

  echo "100"; echo "# Done"
  return 0
}

if [ "${1:-}" = "--perform-install" ]; then
  perform_install
  exit $?
fi

# ------------------------------------------------------------- wizard -------

detect_distro
ui_init

trap 'exit 130' INT

# Step 1 — welcome.
if ! ui_confirm "$APP_NAME $VERSION" \
  "<b>$APP_NAME $VERSION</b>\n\nLocal-first editor for documents, spreadsheets, decks and video.\n\nDetected system: $DISTRO_NAME\n\nThis installer will check for the libraries the application needs, install it, and add it to your applications menu." \
  "Install"; then
  exit 0
fi

# Step 2 — licence.
if ! ui_license "$PAYLOAD/LICENSE"; then
  ui_info "$APP_NAME" "The licence was not accepted. Nothing has been installed."
  exit 0
fi

# Step 3 — where it goes. Installing for one user needs no password, so it is
# offered first and is the default.
SCOPE="$(ui_choose "$APP_NAME — Install for" \
  "Choose who should be able to run $APP_NAME." \
  "user|Just me — installs to your home directory, no password needed" \
  "system|All users — installs to /opt, asks for your password")"
[ -n "$SCOPE" ] || exit 0

if [ "$SCOPE" = "system" ]; then
  ODY_PREFIX="/opt/$APP_ID"
  ODY_BINDIR="/usr/local/bin"
  ODY_APPDIR="/usr/share/applications"
  ODY_ICONDIR="/usr/share/icons/hicolor"
else
  ODY_PREFIX="$HOME/.local/opt/$APP_ID"
  ODY_BINDIR="$HOME/.local/bin"
  ODY_APPDIR="$HOME/.local/share/applications"
  ODY_ICONDIR="$HOME/.local/share/icons/hicolor"
fi
export ODY_PREFIX ODY_BINDIR ODY_APPDIR ODY_ICONDIR

# An existing install is replaced in place; say so rather than silently
# overwriting it.
if [ -e "$ODY_PREFIX/bin/$APP_ID" ]; then
  OLD="$(cat "$ODY_PREFIX/VERSION" 2>/dev/null || echo "unknown")"
  if ! ui_confirm "$APP_NAME" \
    "Version $OLD is already installed in $ODY_PREFIX.\n\nIt will be replaced with version $VERSION. Your documents are stored separately and are not touched." \
    "Replace"; then
    exit 0
  fi
fi

# Step 4 — dependencies.
check_dependencies

if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
  PKGS=()
  UNMAPPED=()
  for dep in "${MISSING_REQUIRED[@]}"; do
    pkg="$(package_for "$dep")"
    if [ -n "$pkg" ]; then PKGS+=("$pkg"); else UNMAPPED+=("$dep"); fi
  done

  LIST=""
  for dep in "${MISSING_REQUIRED[@]}"; do
    LIST="$LIST\n  • $(describe_dep "$dep")"
  done

  if [ "${#PKGS[@]}" -gt 0 ]; then
    CMD="$(install_command "${PKGS[@]}")"
    if ui_confirm "$APP_NAME — Missing dependencies" \
      "$APP_NAME needs these, and they are not installed:\n$LIST\n\nThe installer can fetch them now with your package manager:\n\n<tt>$CMD</tt>\n\nYou will be asked for your password." \
      "Install them"; then

      if [ "$(id -u)" -eq 0 ]; then
        SH_PREFIX=()
      elif command -v pkexec >/dev/null 2>&1 && [ "$UI_MODE" = "gui" ]; then
        SH_PREFIX=(pkexec)
      elif command -v sudo >/dev/null 2>&1; then
        SH_PREFIX=(sudo)
      else
        SH_PREFIX=()
      fi

      if ! ${SH_PREFIX[@]+"${SH_PREFIX[@]}"} /bin/sh -c "$CMD"; then
        if ! ui_confirm "$APP_NAME" \
          "Installing the dependencies failed.\n\nYou can continue and install them yourself afterwards with:\n\n<tt>$CMD</tt>\n\n$APP_NAME will not start until they are present." \
          "Continue anyway"; then
          exit 1
        fi
      fi
    fi
  else
    # No mapping for this package manager; tell the user what to look for.
    if ! ui_confirm "$APP_NAME — Missing dependencies" \
      "$APP_NAME needs these, and this installer does not know the package names on $DISTRO_NAME:\n$LIST\n\nInstall them with your package manager, then run this installer again." \
      "Continue anyway"; then
      exit 1
    fi
  fi
fi

# Step 5 — copy everything into place.
if [ "$SCOPE" = "system" ] && [ "$(id -u)" -ne 0 ]; then
  if command -v pkexec >/dev/null 2>&1 && [ "$UI_MODE" = "gui" ]; then
    ESCALATE=(pkexec env
      "ODY_PREFIX=$ODY_PREFIX" "ODY_BINDIR=$ODY_BINDIR"
      "ODY_APPDIR=$ODY_APPDIR" "ODY_ICONDIR=$ODY_ICONDIR")
  elif command -v sudo >/dev/null 2>&1; then
    ESCALATE=(sudo
      "ODY_PREFIX=$ODY_PREFIX" "ODY_BINDIR=$ODY_BINDIR"
      "ODY_APPDIR=$ODY_APPDIR" "ODY_ICONDIR=$ODY_ICONDIR")
  else
    ui_error "Installing for all users needs root, and neither pkexec nor sudo is available.\n\nRun this installer as root, or choose \"Just me\"."
    exit 1
  fi
else
  ESCALATE=()
fi

install_worker() {
  ${ESCALATE[@]+"${ESCALATE[@]}"} /bin/bash "$HERE/setup.sh" --perform-install
}

if run_with_progress "Installing $APP_NAME" install_worker; then
  NOTE=""
  case ":$PATH:" in
    *":$ODY_BINDIR:"*) ;;
    # A user install into a directory that is not on PATH still works from the
    # menu, so this is a note rather than a failure.
    *) NOTE="\n\nNote: <tt>$ODY_BINDIR</tt> is not on your PATH, so the <tt>$APP_ID</tt> command will not work in a terminal until you add it." ;;
  esac

  if ui_confirm "$APP_NAME — Installed" \
    "<b>$APP_NAME $VERSION is installed.</b>\n\nIt is in your applications menu, and in a terminal as <tt>$APP_ID</tt>.\n\nTo remove it later, run:\n<tt>$ODY_PREFIX/uninstall.sh</tt>$NOTE" \
    "Launch now"; then
    setsid "$ODY_PREFIX/bin/$APP_ID" >/dev/null 2>&1 &
  fi
  exit 0
else
  ui_error "Installation failed.\n\nNothing was left behind in $ODY_PREFIX that you need to clean up by hand."
  exit 1
fi
