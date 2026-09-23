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

### GPU acceleration is three separate things

"Use the GPU" names three unrelated mechanisms in a video editor, and this
codebase does two of them. The monitor's shaders composite for the screen
(below). The export path decodes and encodes on the GPU. The compositing
*between* those two ends stays in software filters, because moving it would
mean a second renderer written in hardware filters rather than a flag —
`overlay_vaapi` is not `overlay`, and every effect would need a second
implementation with its own parity problem.

**Encoders are offered only after they have run.** `ffmpeg -encoders` lists
what ffmpeg was compiled with. A distribution build advertises `h264_nvenc` on
a laptop with no NVIDIA card, `h264_qsv` on AMD, and `h264_vaapi` where
`/dev/dri` does not exist or the user is not in the `render` group. On the
machine this was written on, ffmpeg advertises thirteen hardware encoders and
two of them work. So `hw.rs` asks each candidate to encode two frames of
`testsrc` to `null`, in parallel, once per process, and lists the survivors.
The VA-API render node is found the same way: the nodes under `/dev/dri` are
tried in order and the first that accepts an upload is kept, with
`ODYSSEY_VAAPI_DEVICE` overriding on machines with two GPUs where the wrong
guess is the slow one.

**The graph changes shape per family.** NVENC, AMF and VideoToolbox take
ordinary software frames, so they are a codec substitution and nothing more.
VA-API and QSV take GPU surfaces, and three things have to be true together or
the encoder refuses to open:

| | software-frame families | surface families |
|---|---|---|
| Device | none | `-init_hw_device` **and** `-filter_hw_device`, before the first input |
| End of the graph | `format=yuv420p` | `format=nv12,hwupload` |
| Output `-pix_fmt` | `yuv420p` | must be absent |

The last row is the one that bites: frames reaching a surface encoder are GPU
handles rather than planes, so `-pix_fmt yuv420p` sends ffmpeg looking for a
conversion that does not exist, and it reports an encoder it could not open
rather than an option it did not like. QSV on Linux is initialised as a VA-API
child (`qsv=hw@va`) so it shares surfaces with the driver that owns the card;
on Windows the D3D11 default is right and a render node would be wrong.

Preset names in a profile are x264's, because that is the vocabulary the
interface uses. Each family gets them translated rather than passed through:
NVENC wants `p1`–`p7`, AMF wants one of three words, and VA-API and
VideoToolbox have no preset and reject the option.

**Decoding asks for `auto` rather than a method.** `-hwaccel auto` is chosen
per input and per codec and falls back to software for the files the GPU does
not know, which is what a timeline mixing camera H.264 with a VP9 screen
recording needs. No `-hwaccel_output_format` is set, so frames come back to
system memory for the filter graph — keeping them on the card is the second
renderer again. Proxy building takes the same treatment, since it is
decode-bound by construction: a full-resolution source in, a small picture out.

**Parity here is also measured.** `every_hardware_profile_renders` exports a
two-track composite through every profile the machine offers and probes the
result. The probe already promises the encoder initialises, which is a smaller
claim than the compositing graph reaching it intact.

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

## The preview mirrors the graph

The monitor does not approximate the render with canvas filters. It rebuilds
each clip's chain the way `render_args` in timeline.rs does (`src/fxpipe.ts`):

1. The source is fitted inside the frame, and padded to it in black when the
   clip has no motion, because that pad is what covers the tracks beneath.
2. Effects run **in order** on that layer. Colour and pixel effects are WebGL2
   fragment shaders; geometry (crop, rotate, transform, transpose, reframe)
   runs on 2D canvases because it changes the layer's size.
3. The head transition runs, then motion places the layer centred, as the
   overlay's `(main_w-overlay_w)/2` does.

The timeline itself goes through `applyTransitions`, a port of
`apply_transitions`, so a dissolve's overlap lands at the same instant in the
monitor as in the file. Adjustment layers grade a snapshot of the composite so
far, the way the renderer gates their filters onto the running output.

The shaders are written against the filters' own arithmetic, and a few details
matter more than they look: `eq` works on limited-range luma codes;
`colorbalance`'s "lightness" is max+min, not their mean; `gblur`, `boxblur`
and `convolution` size each plane in its own pixels, so chroma spreads twice as
far on 4:2:0 video; Tint clips its channel mix before adding its offset.

**Parity is measured, not claimed.** `cargo test preview_parity_fixtures --
--ignored` renders a still through the real export path once per effect, and
`scripts/preview-parity` runs the same effect JSON through the pipeline in a
browser and reports the per-pixel difference. The check has already caught
export bugs, not only preview ones: `geq` ignores its `lum`/`cb`/`cr`
expressions on RGB input, so Mirror and Scanlines exported black frames for
stills until the format was pinned to YUV first.

**What the GPU path cannot do, the monitor says.** frei0r plugins, LUTs,
temporal filters (motion blur, denoisers, stabilisation), nested sequences and
the blend modes a canvas lacks are listed on the monitor. While the playhead
rests on such a frame, `preview_frame` renders it through the export graph,
caches it by the content hash of the slice it depends on, and the monitor
shows that, labelled "Exact frame". During playback those effects are absent,
which the label also says.

Timeline preview rendering remains for playing heavy spans at speed: a span is
rendered once and played back as a file, and the monitor labels itself so
rendered output is never mistaken for a live composite.

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
