# Roadmap

What is missing, roughly in the order it would be worth building. The editor is
usable without any of it; this is the honest gap list, not a wishlist.

## Next

- **Source monitor.** Set in and out points on a bin clip before placing it.
  The three-point editing workflow depends on this.
- **Title templates.** Title cards take layered text and shapes with outlines,
  shadows, alignment and timed reveals, but every card starts empty; there is
  no way to save a card's layout and reuse it.

## Larger

- **Nested buses.** Tracks route and send to buses, and every bus feeds the
  master. A bus cannot feed another bus.

## Known limitations

These are design consequences rather than missing work, and are explained in
[ARCHITECTURE.md](ARCHITECTURE.md).

- frei0r plugins, LUTs, temporal filters and nested sequences have no GPU path
  in the preview. The monitor names them and shows ffmpeg's exact frame when
  parked; during playback they are absent unless the span is rendered.
- Sampled keyframe routes (`command`, `stacked`) are coarser than per-frame
  expressions. Each effect reports which route it uses.
- `sendcmd` targets filters by name. Each animated effect is isolated in its
  own chain, so there is no cross-talk, at the cost of a longer graph.
- Rendering is one ffmpeg process per export. There is no partial re-render.
- GPU export accelerates the ends of the pipeline — decode and encode — but the
  compositing between them runs in software filters. Moving the graph itself
  onto the GPU means a second renderer written in hardware filters, not a flag.
- There is no GPU playback pipeline: the monitor's shaders composite for the
  screen, and the effects listed above have no path through them.

## Not planned

- Speech to text. It needs a trained model rather than code.
- Cloud collaboration.
