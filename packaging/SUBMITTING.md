# Submitting to the package registries

Everything here assumes a release already exists, because every registry wants
a URL it can download and a checksum it can verify:

```bash
git tag -a v0.1.0 -m "Odyssey Design 0.1.0"
git push origin v0.1.0            # .github/workflows/release.yml does the rest
```

Wait for the workflow, then render every manifest from the published artifacts:

```bash
./packaging/sync-release.sh v0.1.0
git add packaging site/releases.json && git commit -m "Packaging for 0.1.0"
```

That is the only step that writes a version or a checksum. Do not edit the
generated files: edit `packaging/templates/` and run the script again.
`./packaging/sync-release.sh v0.1.0 --check` renders to a temporary directory
and diffs instead of writing, which is worth wiring into CI once there is a
release for it to diff against.

Below, each registry once. None of it is automated on purpose: every one of
these publishes to strangers, and a wrong checksum is somebody else's broken
install.

---

## AUR, which is what `yay` and `paru` read

`yay -S odyssey-design-bin` works the moment the package is in the AUR. There
is nothing to submit to yay itself: it is a client, not a repository.

Two packages, both maintained here:

| Package | What it does |
| --- | --- |
| `odyssey-design-bin` | Unpacks the released `.run`. Installs in seconds. |
| `odyssey-design-git` | Builds the current commit. Needs Rust and Node. |

**First time only.** Make an account at <https://aur.archlinux.org>, add your
public SSH key under *My Account*, then:

```bash
git clone ssh://aur@aur.archlinux.org/odyssey-design-bin.git aur-bin
git clone ssh://aur@aur.archlinux.org/odyssey-design-git.git aur-git
```

Cloning an unregistered name gives an empty repository. That is how a new
package is created: push to it and it exists.

**Every release.** `.SRCINFO` must agree with `PKGBUILD` or the AUR rejects the
push, which is why `sync-release.sh` regenerates it with `makepkg --printsrcinfo`
and refuses to guess when `makepkg` is missing.

```bash
cp packaging/aur/odyssey-design-bin/{PKGBUILD,.SRCINFO} aur-bin/
cd aur-bin
makepkg --printsrcinfo > .SRCINFO      # belt and braces; should be a no-op
git commit -am "Update to 0.1.0" && git push
```

Test before pushing. This builds the package and installs it for real:

```bash
cd packaging/aur/odyssey-design-bin && makepkg -si
namcap odyssey-design-bin-*.pkg.tar.zst   # catches the common packaging faults
```

`odyssey-design-git` only needs a push when its `PKGBUILD` changes: `pkgver()`
reads the version out of git on every build, so it tracks `main` by itself.

---

## winget

One registry, one repository: <https://github.com/microsoft/winget-pkgs>. A
submission is a pull request against it.

`wingetcreate` is the path of least resistance, because it reads the MSI and
fills in the `ProductCode` that the generated manifest deliberately leaves out
(it is a per-build GUID that cannot be known from Linux):

```powershell
winget install Microsoft.WingetCreate

# First submission: interactive, starts from the installer URL.
wingetcreate new https://github.com/Fs1lyric/odyssey-design/releases/download/v0.1.0/OdysseyDesign_0.1.0_Windows_x64.msi

# Later releases: one command.
wingetcreate update Fs1lyric.OdysseyDesign `
  --version 0.1.0 `
  --urls https://github.com/Fs1lyric/odyssey-design/releases/download/v0.1.0/OdysseyDesign_0.1.0_Windows_x64.msi `
  --submit
```

To submit the manifests in `packaging/winget/` by hand instead, copy them to
`manifests/f/Fs1lyric/OdysseyDesign/0.1.0/` in a fork of `winget-pkgs` and open
a pull request. Validate first, on Windows:

```powershell
winget validate --manifest packaging\winget
winget install --manifest packaging\winget    # actually installs it
```

What the review checks: the URL is public and stable, the checksum matches, the
publisher and package names are consistent with any existing entry, and the
installer is not flagged by SmartScreen or the malware scan. An unsigned MSI is
accepted, and will warn on the way in.

---

## Scoop

Scoop has no central registry that accepts arbitrary submissions. `main` takes
command-line tools only, and `extras` wants a package people already ask for. A
GUI application with no users yet belongs in its own bucket, which needs nobody's
permission and works identically for the person installing.

**First time only.** Create a repository named `scoop-odyssey` under the
`Fs1lyric` account, with the manifest in a `bucket/` directory:

```bash
git clone https://github.com/Fs1lyric/scoop-odyssey && cd scoop-odyssey
mkdir -p bucket
cp ../odyssey-design/packaging/scoop/odyssey-design.json bucket/
git add . && git commit -m "Add odyssey-design" && git push
```

Then it installs with:

```powershell
scoop bucket add odyssey https://github.com/Fs1lyric/scoop-odyssey
scoop install odyssey-design
```

**Every release.** Copy the regenerated manifest in and push. The `checkver`
and `autoupdate` blocks let `scoop update` find new versions from the GitHub
releases feed without a manual edit, so this is mostly a formality once the
first one is in.

Later, if the application has users who ask for it, `extras` is a pull request
against <https://github.com/ScoopInstaller/Extras> with the same manifest.

---

## Homebrew

`homebrew-cask` has a notability bar (roughly: a repository with a real
following, not a brand-new project) and rejects submissions that do not clear
it. A tap needs no approval and the install command is barely longer.

**First time only.** Create a repository named `homebrew-odyssey` under the
`Fs1lyric` account. The `homebrew-` prefix is what makes `brew tap
fs1lyric/odyssey` resolve.

```bash
git clone https://github.com/Fs1lyric/homebrew-odyssey && cd homebrew-odyssey
mkdir -p Casks
cp ../odyssey-design/packaging/homebrew/Casks/odyssey-design.rb Casks/
git add . && git commit -m "Add odyssey-design" && git push
```

Then it installs with:

```bash
brew install --cask fs1lyric/odyssey/odyssey-design
```

**Every release.** Copy the regenerated cask in and push. On a Mac, check it
first:

```bash
brew audit --cask --new fs1lyric/odyssey/odyssey-design
brew install --cask fs1lyric/odyssey/odyssey-design
brew uninstall --cask odyssey-design
```

The cask carries a `caveats` block saying the application is not notarized,
because it is not: macOS will refuse the first launch until it is allowed in
System Settings. Removing that warning would be lying to the person installing.

---

## After publishing

`site/releases.json` decides what the download page claims. It ships with every
channel marked unavailable, and the site prints a *Not published yet* badge
against any command that would not resolve. Flip each one as it goes live:

```jsonc
"channels": {
  "aur":      { "available": true,  "packages": ["odyssey-design-bin", "odyssey-design-git"] },
  "winget":   { "available": false, "id": "Fs1lyric.OdysseyDesign" },
  ...
}
```

`sync-release.sh` preserves these flags across runs, so a later release does not
quietly reset them.

## Signing, which none of this does

Every artifact is unsigned. Windows SmartScreen and macOS Gatekeeper both say
so, and the downloads page repeats it rather than hiding it. Fixing it properly
means an Authenticode certificate for Windows and an Apple Developer ID plus
notarization for macOS, both paid and both annual. Until then the SHA-256 in
each manifest is the integrity story, which is genuine as far as it goes: it
proves the file came from this release, not that this release is trustworthy.
