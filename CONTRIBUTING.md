# Contributing

Bug reports and patches are welcome.

## Getting set up

```bash
npm install
npm run tauri dev
```

Requires Rust, Node, webkit2gtk and GTK 3. The video editor needs `ffmpeg` and
`ffprobe` on `PATH`. On Linux the preview decodes through GStreamer, so
`gst-libav` is needed to play H.264 sources directly; without it, build proxies
instead.

## Tests

```bash
cd src-tauri && cargo test
```

Some tests invoke ffmpeg, render real files and probe the results. They are the
ones worth keeping green: a filter graph that looks correct as a string is not
necessarily one ffmpeg accepts.

Tests write to `src-tauri/target/test-scratch` rather than the system temp
directory, because renders are large and `/tmp` is often a small tmpfs.

## Conventions

- Effects compile to ffmpeg filters in `src-tauri/src/timeline.rs`. Adding one
  means a variant, a compile arm, an entry in `EFFECT_CATALOGUE`, and a case in
  the `every_effect_renders` test.
- Anything that reaches a filter string gets escaped. Paths, colours and plugin
  names are all interpolated, and colon and quote are filter syntax.
- The preview is an approximation; ffmpeg is the authority on output. Where the
  two differ, say so in a comment rather than pretending they match.

## Reporting a bug

Include the ffmpeg version, the source file's codec and resolution, and the
render command if one failed. `Show the ffmpeg command` in the editor prints the
exact invocation.
