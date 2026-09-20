# Packaging

One installer, and the manifests for five package registries.

## The `.run` installer

One self-extracting file that installs the application on any Linux
distribution, the way DaVinci Resolve's installer does: a prebuilt binary, a
graphical wizard, no build step for the person installing.

Build it:

```bash
./packaging/build-installer.sh                # build the app, then package it
./packaging/build-installer.sh --skip-build   # reuse src-tauri/target/release
```

The result is `packaging/dist/OdysseyDesign_<version>_Linux.run`, about 3 MB.
The version comes from `src-tauri/tauri.conf.json`, so bumping it there is
enough. The archive is built with sorted names and a fixed mtime, so the same
input tree produces a byte-identical `.run`.

### What the file is

A `/bin/sh` script with an xz-compressed tar appended after a marker line. Run
it and it verifies its own SHA-256 (a truncated download is the common failure
and is worth catching before anything is written), unpacks into a temporary
directory, and starts the wizard. The temporary directory is removed on exit
either way.

```
./OdysseyDesign_0.1.0_Linux.run            install, graphical if a display exists
./OdysseyDesign_0.1.0_Linux.run --text     install in the terminal
./OdysseyDesign_0.1.0_Linux.run --check    verify the file, install nothing
./OdysseyDesign_0.1.0_Linux.run --extract DIR
                                           unpack only, install nothing
```

### What the wizard does

Welcome, licence, install scope, dependency check, install, finish.

**Scope.** *Just me* installs to `~/.local/opt/odyssey-design` and needs no
password; it is offered first and is the default. *All users* installs to
`/opt/odyssey-design`. Both add a `hicolor` icon set, a desktop entry with an
absolute `Exec`, and a symlink on `PATH`.

**Dependencies.** WebKitGTK 4.1 and GTK 3 are looked for through `ldconfig`,
falling back to walking the standard library directories when there is no
cache. `ffmpeg` and `ffprobe` are looked for on `PATH`. Anything missing is
named, mapped to a native package, and offered for installation through
pacman, apt, dnf, zypper or apk. Which manager is present decides the package
names, so derivatives — Mint, Pop, EndeavourOS, Nobara, Omarchy — need no
entry of their own. If there is no mapping the wizard says what to install by
hand rather than guessing.

**Privileges.** The wizard runs as the user. Only the file-copying pass is
escalated, through `pkexec` when there is a display and `sudo` otherwise, so
no graphical code runs as root.

**Uninstalling.** The install writes `install-manifest.txt` listing every path
it created, and `uninstall.sh` removes exactly those. Empty directories go
only via `rmdir`, which refuses to touch a directory something else still
uses. Shared caches (`mimeinfo.cache`, `icon-theme.cache`) are left alone, and
user documents are never touched.

### Layout

```
build-installer.sh              builds the .run
sync-release.sh                 renders every package manifest from a release
templates/                      the manifest sources, with @VERSION@ and @SHA_*@
installer/header.sh.in          the self-extracting header, @VERSION@ etc. substituted
installer/setup.sh              the wizard; --perform-install is the privileged half
installer/uninstall.sh          shipped into the install prefix
installer/lib/common.sh         distro detection, package maps, zenity/kdialog/text UI
installer/odyssey-design.desktop.in
```

`setup.sh` and `uninstall.sh` each split into a wizard half and a
`--perform-*` half that is non-interactive and reads its settings from the
environment. That split is what keeps the GUI out of root.

## The package manifests

Five registries, one generator. Every manifest says the same three things (a
version, a URL and a SHA-256), so they are rendered from `templates/` rather
than edited by hand:

```bash
./packaging/sync-release.sh v0.1.0           # read the published release
./packaging/sync-release.sh v0.1.0 --local   # read packaging/dist instead
./packaging/sync-release.sh v0.1.0 --check   # diff only, change nothing
```

| Directory | Registry | Install command |
| --- | --- | --- |
| `aur/odyssey-design-bin` | AUR | `yay -S odyssey-design-bin` |
| `aur/odyssey-design-git` | AUR | `yay -S odyssey-design-git` |
| `winget/` | winget-pkgs | `winget install Fs1lyric.OdysseyDesign` |
| `scoop/` | own bucket | `scoop install odyssey-design` |
| `homebrew/Casks/` | own tap | `brew install --cask fs1lyric/odyssey/odyssey-design` |

Submitting each one, once per registry, is in
[`SUBMITTING.md`](SUBMITTING.md). None of it happens automatically: every one
of them publishes to strangers.

### The two Arch packages

`odyssey-design-bin` unpacks the released `.run` with `--extract`, so nothing
in the installer runs and makepkg stays in charge of what lands where.

`odyssey-design-git` builds from source, so it needs Rust and Node:

```bash
cd packaging/aur/odyssey-design-git && makepkg -si
```

`options=('!lto')` is required there: rusqlite compiles SQLite through the `cc`
crate, which picks up makepkg's `CFLAGS`, and with Arch's default LTO that
produces an archive of LLVM bitcode that rust-lld cannot resolve `sqlite3_*`
out of.

## Testing an installer build

The text path can be driven without a display:

```bash
./packaging/build-installer.sh --skip-build
HOME=/tmp/fakehome ODYSSEY_TEXT_INSTALL=1 \
  ./packaging/dist/OdysseyDesign_0.1.0_Linux.run --text
```

Installing under a throwaway `HOME` keeps a test off the real system; the
uninstaller then verifies itself by leaving nothing behind.
