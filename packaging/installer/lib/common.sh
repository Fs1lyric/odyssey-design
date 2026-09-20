#!/bin/bash
# Shared helpers for the Odyssey Design installer: distro detection, package
# mapping, and a UI layer that is graphical when it can be and textual when it
# cannot. Sourced by setup.sh and uninstall.sh.

APP_NAME="Odyssey Design"
APP_ID="odyssey-design"

# ---------------------------------------------------------------- distro ----

# Sets DISTRO_ID, DISTRO_NAME, PKG_MANAGER.
detect_distro() {
  DISTRO_ID="unknown"
  DISTRO_NAME="Linux"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
  fi

  # Package names are chosen by which manager is present rather than by ID,
  # so derivatives (Mint, Pop, EndeavourOS, Nobara, Omarchy) need no entry of
  # their own.
  PKG_MANAGER=""
  for candidate in pacman apt-get dnf zypper apk xbps-install eopkg; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PKG_MANAGER="$candidate"
      break
    fi
  done
}

# Package names differ per distro for the same library. Echoes the native
# package providing $1, or nothing if we have no mapping for this system.
package_for() {
  local what="$1"
  case "$PKG_MANAGER" in
    pacman)
      case "$what" in
        webkit2gtk) echo "webkit2gtk-4.1" ;;
        gtk3)       echo "gtk3" ;;
        ffmpeg)     echo "ffmpeg" ;;
        frei0r)     echo "frei0r-plugins" ;;
        gstlibav)   echo "gst-libav" ;;
        gstgood)    echo "gst-plugins-good" ;;
      esac ;;
    apt-get)
      case "$what" in
        webkit2gtk) echo "libwebkit2gtk-4.1-0" ;;
        gtk3)       echo "libgtk-3-0" ;;
        ffmpeg)     echo "ffmpeg" ;;
        frei0r)     echo "frei0r-plugins" ;;
        gstlibav)   echo "gstreamer1.0-libav" ;;
        gstgood)    echo "gstreamer1.0-plugins-good" ;;
      esac ;;
    dnf)
      case "$what" in
        webkit2gtk) echo "webkit2gtk4.1" ;;
        gtk3)       echo "gtk3" ;;
        ffmpeg)     echo "ffmpeg-free" ;;
        frei0r)     echo "frei0r-plugins" ;;
        gstlibav)   echo "gstreamer1-libav" ;;
        gstgood)    echo "gstreamer1-plugins-good" ;;
      esac ;;
    zypper)
      case "$what" in
        webkit2gtk) echo "libwebkit2gtk-4_1-0" ;;
        gtk3)       echo "libgtk-3-0" ;;
        ffmpeg)     echo "ffmpeg" ;;
        frei0r)     echo "frei0r-plugins" ;;
        gstlibav)   echo "gstreamer-plugins-libav" ;;
        gstgood)    echo "gstreamer-plugins-good" ;;
      esac ;;
    apk)
      case "$what" in
        webkit2gtk) echo "webkit2gtk-4.1" ;;
        gtk3)       echo "gtk+3.0" ;;
        ffmpeg)     echo "ffmpeg" ;;
        frei0r)     echo "frei0r-plugins" ;;
        gstlibav)   echo "gst-libav" ;;
        gstgood)    echo "gst-plugins-good" ;;
      esac ;;
  esac
}

# The command that installs the packages in "$@", printed for the user to see
# before anything runs.
install_command() {
  case "$PKG_MANAGER" in
    pacman)       echo "pacman -S --needed --noconfirm $*" ;;
    apt-get)      echo "apt-get update && apt-get install -y $*" ;;
    dnf)          echo "dnf install -y $*" ;;
    zypper)       echo "zypper --non-interactive install $*" ;;
    apk)          echo "apk add $*" ;;
    xbps-install) echo "xbps-install -Sy $*" ;;
    eopkg)        echo "eopkg install -y $*" ;;
  esac
}

# True when the dynamic linker can find shared library $1.
has_library() {
  local soname="$1"
  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p 2>/dev/null | grep -q "[[:space:]]$soname[[:space:]]" && return 0
  fi
  # ldconfig is absent or has no cache (some containers, NixOS); fall back to
  # looking through the standard library directories by hand.
  local dir
  for dir in /lib /lib64 /usr/lib /usr/lib64 /usr/local/lib \
             /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu; do
    [ -e "$dir/$soname" ] && return 0
  done
  return 1
}

# Fills MISSING_REQUIRED and MISSING_OPTIONAL with mapping keys.
check_dependencies() {
  MISSING_REQUIRED=()
  MISSING_OPTIONAL=()

  has_library "libwebkit2gtk-4.1.so.0" || MISSING_REQUIRED+=("webkit2gtk")
  has_library "libgtk-3.so.0"          || MISSING_REQUIRED+=("gtk3")

  # The video editor shells out to both of these; the other three editors work
  # without them, so a missing ffmpeg is a warning rather than a hard stop.
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    MISSING_REQUIRED+=("ffmpeg")
  fi

  has_library "libgstlibav.so"  || MISSING_OPTIONAL+=("gstlibav")
  ls /usr/lib*/frei0r-1 >/dev/null 2>&1 || MISSING_OPTIONAL+=("frei0r")
}

describe_dep() {
  case "$1" in
    webkit2gtk) echo "WebKitGTK 4.1 — renders the application window" ;;
    gtk3)       echo "GTK 3 — window decoration, dialogs and theming" ;;
    ffmpeg)     echo "ffmpeg and ffprobe — the render engine for the video editor" ;;
    frei0r)     echo "frei0r plugins — 160+ extra video effects (optional)" ;;
    gstlibav)   echo "gst-libav — plays H.264 in the preview without proxies (optional)" ;;
    gstgood)    echo "gst-plugins-good — audio output in the preview (optional)" ;;
  esac
}

# ------------------------------------------------------------------- ui -----

# Sets UI_MODE to "gui" or "text".
ui_init() {
  UI_MODE="text"
  # Always set, because callers run under `set -u` and the text branches of the
  # dialogs still match on "$UI_MODE:$UI_TOOL".
  UI_TOOL="none"
  if [ -n "${ODYSSEY_TEXT_INSTALL:-}" ]; then
    return
  fi
  # A graphical wizard needs both a display to draw on and a tool to draw with.
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then
      UI_MODE="gui"; UI_TOOL="zenity"
    elif command -v kdialog >/dev/null 2>&1; then
      UI_MODE="gui"; UI_TOOL="kdialog"
    fi
  fi
}

# Markup and escapes are written for the graphical path; strip and expand them
# for the terminal.
plain() { printf '%b' "$1" | sed 's/<[^>]*>//g'; }

ui_info() { # title, text
  case "$UI_MODE:$UI_TOOL" in
    gui:zenity)  zenity --info --title="$1" --text="$2" --width=460 2>/dev/null ;;
    gui:kdialog) kdialog --title "$1" --msgbox "$2" 2>/dev/null ;;
    *)           printf '\n%s\n%s\n' "$1" "$(plain "$2")" ;;
  esac
}

ui_error() { # text
  case "$UI_MODE:$UI_TOOL" in
    gui:zenity)  zenity --error --title="$APP_NAME installer" --text="$1" --width=460 2>/dev/null ;;
    gui:kdialog) kdialog --title "$APP_NAME installer" --error "$1" 2>/dev/null ;;
    *)           printf '\nError: %s\n' "$(plain "$1")" >&2 ;;
  esac
}

# Returns 0 for yes, 1 for no.
ui_confirm() { # title, text, [ok-label]
  local ok="${3:-Continue}"
  case "$UI_MODE:$UI_TOOL" in
    gui:zenity)
      zenity --question --title="$1" --text="$2" --width=480 \
             --ok-label="$ok" --cancel-label="Cancel" 2>/dev/null ;;
    gui:kdialog)
      kdialog --title "$1" --yesno "$2" 2>/dev/null ;;
    *)
      local reply
      printf '\n%s\n%s\n\n%s [Y/n] ' "$1" "$(plain "$2")" "$ok"
      read -r reply </dev/tty || return 1
      case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac ;;
  esac
}

# Shows a scrolling licence and requires explicit agreement.
ui_license() { # path
  [ -r "$1" ] || return 0
  case "$UI_MODE:$UI_TOOL" in
    gui:zenity)
      zenity --text-info --title="$APP_NAME — Licence" --filename="$1" \
             --width=640 --height=460 --checkbox="I accept the terms of the MIT licence" \
             2>/dev/null ;;
    gui:kdialog)
      kdialog --title "$APP_NAME — Licence" --textbox "$1" 600 400 2>/dev/null
      kdialog --yesno "Do you accept the terms of the MIT licence?" 2>/dev/null ;;
    *)
      printf '\n--- Licence ---\n'; cat "$1"; printf -- '---------------\n'
      local reply
      printf '\nAccept the MIT licence? [Y/n] '
      read -r reply </dev/tty || return 1
      case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac ;;
  esac
}

# Offers a list of "tag|label" choices; echoes the chosen tag.
ui_choose() { # title, text, choice...
  local title="$1" text="$2"; shift 2
  case "$UI_MODE:$UI_TOOL" in
    gui:zenity)
      # Rows are triples: selected flag, hidden tag, visible label.
      local rows=() c first="TRUE"
      for c in "$@"; do
        rows+=("$first" "${c%%|*}" "${c#*|}")
        first="FALSE"
      done
      zenity --list --title="$title" --text="$text" --radiolist \
             --column="Pick" --column="Tag" --column="Option" \
             --hide-column=2 --print-column=2 \
             --width=520 --height=260 "${rows[@]}" 2>/dev/null
      ;;
    gui:kdialog)
      local args=() c first="on"
      for c in "$@"; do
        args+=("${c%%|*}" "${c#*|}" "$first")
        first="off"
      done
      kdialog --title "$title" --radiolist "$text" "${args[@]}" 2>/dev/null
      ;;
    *)
      local i=1 c tags=()
      printf '\n%s\n%s\n\n' "$title" "$text"
      for c in "$@"; do
        tags+=("${c%%|*}")
        printf '  %d) %s\n' "$i" "${c#*|}"
        i=$((i + 1))
      done
      local reply
      printf '\nChoice [1]: '
      read -r reply </dev/tty || reply=1
      case "$reply" in (*[!0-9]*|"") reply=1 ;; esac
      [ "$reply" -ge 1 ] && [ "$reply" -le "$#" ] || reply=1
      echo "${tags[$((reply - 1))]}"
      ;;
  esac
}

# Runs shell function $2, which prints "NN" percent lines and "# text" status
# lines, behind a progress bar. Returns the function's exit status.
run_with_progress() { # title, function-name
  local title="$1" worker="$2"
  local status_file; status_file="$(mktemp)"

  case "$UI_MODE:$UI_TOOL" in
    gui:zenity)
      { "$worker"; echo "$?" >"$status_file"; } \
        | zenity --progress --title="$title" --text="Preparing…" \
                 --width=460 --percentage=0 --auto-close --no-cancel 2>/dev/null
      ;;
    *)
      { "$worker"; echo "$?" >"$status_file"; } \
        | while IFS= read -r line; do
            case "$line" in
              '#'*) printf '  %s\n' "${line#\# }" ;;
            esac
          done
      ;;
  esac

  local rc; rc="$(cat "$status_file" 2>/dev/null)"
  rm -f "$status_file"
  return "${rc:-1}"
}
