# Odyssey Design

A local-first desktop app for documents, spreadsheets, decks and video.
Everything is stored on your machine in SQLite. There is no account, no server
and no sync.

## Status

Working and testable. This is v1 of the editors, not a finished product — see
*Known limits* below for exactly what is and isn't there.

## The idea

Most suites are several separate apps that happen to share a login. Odyssey is
one record model with four editors over it: a document, a spreadsheet, a deck
and a video timeline are the same shape of thing seen from different angles.

```
items     id, kind, title, body, data(JSON), due, project, timestamps
links     src -> dst, rel      embeds and backlinks, both directions
sessions  item_id, start, end  editing sessions, the basis for history
```

Adding a module means adding a `kind`, not a new table.

## The four editors

**Docs** — rich text with a formatting toolbar, ⌘/Ctrl+B/I/U, plain-text paste,
and live word, character and reading-time counts.

**Sheets** — a 26×60 grid with a formula bar. The formula engine is Rust: a
recursive-descent parser covering arithmetic, comparisons, string concatenation,
cell references and ranges, with `SUM PRODUCT AVERAGE MIN MAX COUNT COUNTA IF
ROUND ABS SQRT FLOOR CEILING LEN UPPER LOWER CONCAT AND OR NOT`. Reference
cycles are detected and reported as `#CYCLE!` rather than hanging. Errors are
values, so one bad cell poisons only what depends on it.

**Slides** — filmstrip, add/duplicate/delete/reorder, and a presenter mode
driven by arrow keys with its own dark token set so it never inherits the page
theme.

**Video** — a multi-track non-linear editor, written from scratch against
ffmpeg. See below.

## The video editor

**Timeline.** Any number of video and audio tracks. Clips sit at absolute
positions, so gaps are real gaps. Drag a clip horizontally to move it in time or
vertically to move it to another track; drag its edges to trim. Audio-only files
land on an audio track automatically. Per-track mute, hide, lock and volume.
Zoom from 4 to 400 pixels per second.

**Preview.** A canvas compositor draws the project live: every active clip on
every visible track, in track order, with opacity and fades applied. Transport
is play/pause, frame step, home/end, and a scrubbable ruler. Keyboard: space to
play, S to split at the playhead, Delete to remove, arrows to step a frame,
shift+arrows to step a second, Ctrl+Z / Ctrl+Shift+Z to undo and redo.

**Effects.** Sixteen native: colour (brightness, contrast, saturation, gamma),
hue, blur, sharpen, vignette, chroma key, opacity, fade, transform, rotate,
crop, text overlay, volume, audio fade, high-pass and low-pass — **plus every
frei0r plugin installed on the machine**, browsable by name from the inspector.
That is the same plugin library Kdenlive draws on; this machine has 166, for 182
effects in total.

**Keyframes on every numeric parameter**, with linear, hold, ease-in, ease-out
and ease-in-out interpolation, set at the playhead. Animation reaches ffmpeg by
whichever of three routes that filter actually supports, and each effect card
says which one it used:

- **per-frame** — the option takes an expression in `t`, so ffmpeg evaluates it
  every frame. Exact. (colour, crop, rotate, volume, text, vignette)
- **sampled 20 Hz** — the option is a runtime parameter, so the curve is sampled
  and issued as timed `sendcmd` commands. (blur, hue, chroma key, opacity,
  high-pass, low-pass, transform)
- **sampled** — the filter supports neither, but does support `enable`, so one
  gated instance is emitted per slice. Coarsest. (sharpen, frei0r)

**Generated sources.** Title cards and colour clips need no file on disk.

**Speed, reverse and time remapping.** Speed is a curve, not a constant:
keyframe it and the clip ramps. Ramps render as constant-speed segments, cut at
8 per second, each with its own trim, `setpts` and staged `atempo` — so audio
follows video through a ramp, and rates beyond ffmpeg's 0.5–2.0 `atempo` limit
still work. Speed keyframes are indexed by position in the source, so a ramp
survives the clip being moved.

**Timeline preview rendering.** Heavy effect stacks do not have to be
composited every frame. Render the timeline once and playback switches to the
rendered file, with the monitor labelling itself so rendered output is never
mistaken for a live composite. Chunks are cached on disk under a content hash
of the sliced range, which means an edit *inside* a rendered span invalidates
it while an edit elsewhere on the timeline leaves it valid. Previews render at
half resolution on the ultrafast preset, because they exist to play smoothly,
not to look final.

**Project bin.** Media the project knows about, independent of what is on the
timeline. Add once, place as many times as you like; removing a bin item is
refused while it is still in use.

**Proxy editing.** Build low-resolution stand-ins for the bin and the preview
plays those instead, so 4K does not crawl. The contract is one-directional and
enforced by a test: the preview may use a proxy, **the renderer never does**, so
an export always reads the original media. Proxies use a 12-frame GOP because
scrubbing means seeking constantly. Note a proxy is not necessarily smaller on
disk; the saving is decode cost, which falls with the pixel count.

**Subtitles.** A cue list with an editor, SRT import and export, and three
export modes: not included, burned into the picture, or a selectable track
(`mov_text` for MP4 and MOV, WebVTT for WebM, SRT for MKV). Burned cues are
drawn after compositing so they sit above every track.

**Export.** Six profiles — H.264 (quality and draft), H.265, VP9/WebM, ProRes
422, and audio-only MP3. "Show ffmpeg command" prints the exact invocation, so a
render is inspectable rather than a black box.

### How it compares to Kdenlive

Covered: playback and scrubbing with a preview monitor, multi-track video and
audio with compositing, undo, keyframes on every numeric parameter, effects and
colour correction including the full frei0r library, titles and text overlays,
speed changes, reverse, time remapping, and render profiles.

Still missing: motion tracking, masks, and nested sequences.

Preview divergences, documented rather than hidden: the preview is silent, so
audio cannot be scrubbed by ear; ffmpeg's `eq` brightness is additive while the
canvas filter is multiplicative, so preview brightness is approximate; and
chroma key, vignette, crop, rotate and frei0r have no canvas equivalent, so they
appear only in the export. ffmpeg is always the authority on the final output.

One renderer limitation: `sendcmd` targets a filter by name, so
two animated effects of the same kind on one clip receive each other's
commands.

## Running it

```bash
npm install
npm run tauri dev
```

Tests:

```bash
cd src-tauri && cargo test
```

Requires Rust, Node, webkit2gtk and GTK 3. The video editor additionally needs
`ffmpeg` and `ffprobe` on `PATH`.

The Rust suite includes end-to-end tests that generate real media with ffmpeg,
render actual projects and probe the results. Those are the tests that matter:
they catch filter graphs that are well-formed strings but invalid to ffmpeg.

## Design notes

The theme defines a complete light palette on `:root`, then redefines *tokens
only* under both `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`,
so the three viewer states (explicit light, explicit dark, and system default)
all render correctly. Measured contrast floor is 5.10:1 in light and 6.92:1 in
dark, against a 4.5:1 requirement.

Fonts are Adwaita Sans and JetBrains Mono — both system-installed, so nothing is
fetched at runtime and there is no silent-fallback risk.

## Security notes

- Cell search escapes LIKE wildcards and passes an explicit `ESCAPE` clause, so
  a search for `50%` matches literally instead of everything.
- `kind` shapes SQL text, so unknown values are rejected before a query is built.
  Every other user value is a bound parameter.
- Query result sets are capped, and formula recursion is depth-bounded.
- ffmpeg is invoked with an argument vector, never a shell string. Source paths
  are canonicalised, so a filename containing shell metacharacters or a leading
  dash stays inert. There is a regression test for exactly this.

## Known limits

- The grid renders all 1,560 cells rather than virtualising. Fine at this size;
  it would need windowing to grow much beyond it.
- Docs use `document.execCommand`, which is deprecated but is the only
  broadly-supported contenteditable formatting API. It is isolated in one array
  in `src/docs.ts` so it can be replaced without touching anything else.
- No export to `.docx`/`.xlsx`/`.pptx` yet.
- Formula evaluation runs only in the desktop app. In a browser, the dev store
  shows raw cell text — there is deliberately no second engine to keep in sync.

## Licence

MIT.
