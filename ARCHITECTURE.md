# Architecture

Odyssey Design is a Tauri application: a Rust backend, a TypeScript frontend,
and SQLite on disk. This document covers the decisions that are not obvious
from reading the code, and the constraints that forced them.

## One record model, four editors

A document, a spreadsheet, a deck and a timeline are the same shape of record
seen from different angles, so they live in one table discriminated by `kind`,
with the editable content as JSON in a `data` column and a plain-text rendering
in `body` for search.

```
items     id, kind, title, body, data(JSON), timestamps
links     src -> dst, rel        embeds and backlinks, traversed both ways
tags      item_id, tag
```

Adding a module means adding a `kind`, not a table. The cost is that `data` is
schemaless and migration happens in the frontend when a project loads.

## The video engine

The whole timeline compiles into a **single ffmpeg `filter_complex`**. There is
no per-clip rendering and no intermediate files; one process produces the
output. That choice drives most of what follows.

### Compositing

Every video clip is trimmed, speed-adjusted, effected, shifted to its timeline
position and overlaid onto a base canvas in track order. Position rides on the
overlay's `x`/`y` rather than a transform filter, because overlay accepts
expressions in `t` and therefore animates per frame for free.

Adjustment layers are not layers. They compile to filters applied to the
composite so far, gated with `enable='between(t,…)'` to the span they cover.

### Transitions are overlaps, not a filter

A dissolve is the incoming clip's alpha rising over whatever is beneath it.
Between tracks that works directly, but two clips butted together on one track
never overlap, so `apply_transitions` rewrites the timeline before the graph is
built: the incoming clip is pulled back by the transition length and consumes
its head handle, and the outgoing clip's tail is extended to play underneath.
Where a clip has no handles the transition shortens rather than inventing
frames.

### Keyframes reach ffmpeg three different ways

Animation is not uniform, because ffmpeg filters are not uniform. Each effect
declares which route it uses and the interface labels it:

| Route | Mechanism | Fidelity |
|---|---|---|
| `expression` | The option takes an expression in `t` | Exact, per frame |
| `command` | The option is `AV_OPT_FLAG_RUNTIME_PARAM`, so the curve is sampled into timed `sendcmd` entries | One value per rendered frame |
| `stacked` | Neither, but the filter supports `enable`, so one gated instance is emitted per sampled slice | Coarsest |

`sendcmd` targets a filter *by name*, so two animated effects of the same kind
on one clip would receive each other's commands. Each command-driven effect is
therefore isolated in its own filter chain, joined by intermediate labels.

### Time remapping

Speed is a curve, not a constant. A ramp is rendered as constant-speed
segments cut at eight per second, each with its own trim, `setpts` and staged
`atempo`, so audio follows video through a ramp. Keyframes are indexed by
position in the source rather than the timeline, so a ramp survives the clip
being moved.

## Constraints discovered the hard way

**A filter graph travels as one argument.** Linux refuses any single argument
over `MAX_ARG_STRLEN`, 131072 bytes, with `Argument list too long` before
ffmpeg starts. A thousand clips produce a 704 KB graph. Graphs above a
conservative threshold spill to a file passed with `-/filter_complex`, which is
ffmpeg's read-this-option-from-a-file syntax. The older
`-filter_complex_script` was removed in ffmpeg 7.

**Not every video has audio.** The graph references `[N:a]` for each media
input, and a silent file makes ffmpeg reject the entire description. Screen
recordings and most B-roll have no audio track, so audio presence is probed and
memoised against path and modification time rather than assumed.

**The preview decodes through the webview.** On Linux that means GStreamer,
where H.264 requires `gst-libav`, which many systems do not ship. Proxies and
timeline preview renders are therefore VP8 in WebM, which plays wherever the
base plugins exist. Export is unaffected and still offers H.264, H.265, VP9,
ProRes and MP3.

## The preview is an approximation

The monitor is a canvas compositor: one hidden `<video>` element per active
clip, drawn in track order with opacity, blend modes and the effects a canvas
filter can express. It is not the renderer, and it does not pretend to be.

Two divergences are deliberate and documented in the code:

- ffmpeg's `eq` brightness is additive; the canvas `brightness()` filter is
  multiplicative, so preview brightness is approximate.
- Chroma key, vignette, crop, rotate and frei0r have no canvas equivalent and
  appear only in the export.

Where the two disagree, ffmpeg is correct. Timeline preview rendering exists
for when that matters: a span is rendered once and played back as a file, and
the monitor labels itself so rendered output is never mistaken for a live
composite.

**Proxies are preview-only, and that contract is enforced by a test.** The
renderer never reads one. An export that silently used a proxy would ship a
degraded master without telling anyone.

## Performance

The timeline culls clips outside the scrolled window, keeping a screen of
margin either side and always keeping the selected clip so the inspector never
points at nothing. At four thousand clips this is the difference between 24771
DOM nodes and 3291, and between 261 ms and 49 ms per edit.

Scroll rebuilds run directly rather than through `requestAnimationFrame`, which
does not fire while a window is hidden and would leave the timeline frozen
mid-scroll.

## Testing

Filter strings are written by hand, so the only proof one is correct is ffmpeg
accepting it. A large part of the suite renders real files and probes the
results:

- Every effect is rendered in turn, collecting failures rather than stopping at
  the first, so one broken filter cannot hide the rest.
- Motion is checked by sampling pixels from the output, because the only honest
  proof a clip moved is that different pixels changed.
- Hostile inputs have regression tests: filenames containing shell
  metacharacters, colons in LUT paths, quotes in subtitle text, plugin names
  that are not plugin names.

Tests write to `target/test-scratch` rather than the system temp directory:
renders are large and `/tmp` is often a small tmpfs shared with everything else
on the machine.
