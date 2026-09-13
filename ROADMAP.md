# Roadmap

What is missing, roughly in the order it would be worth building. The editor is
usable without any of it; this is the honest gap list, not a wishlist.

## Next

- **Source monitor.** Set in and out points on a bin clip before placing it.
  The three-point editing workflow depends on this, and its absence is the
  biggest difference from how people actually cut.
- **Trim feedback.** Ripple, roll, slip and slide are implemented but have no
  visual feedback while dragging and no numeric readout. They work; they are
  hard to use.
- **Merge clips by audio sync.** Align separately recorded sound to picture by
  correlating their waveforms.
- **EDL and OTIO import.** Export works both ways round; import does not.

## Larger

- **A real title editor.** Currently one centred string per title card.
  Multiple text and shape items, outlines, shadows, alignment and templates.
- **Masks that track.** Per-effect shape masks following a subject.
- **Multi-channel audio routing.** Channel picking exists per clip; buses,
  sends and submixes do not.
- **Nested sequence editing.** Sequences can be created and rendered, but
  opening one to edit it in place is not implemented.

## Known limitations

These are design consequences rather than missing work, and are explained in
[ARCHITECTURE.md](ARCHITECTURE.md).

- The preview is a canvas approximation. Chroma key, vignette, crop, rotate and
  frei0r appear only in the export.
- Sampled keyframe routes (`command`, `stacked`) are coarser than per-frame
  expressions. Each effect reports which route it uses.
- `sendcmd` targets filters by name. Isolating each animated effect in its own
  chain prevents cross-talk, at the cost of a longer graph.
- Rendering is one ffmpeg process per export. There is no partial re-render and
  no GPU playback pipeline.

## Not planned

- Speech to text. It needs a trained model rather than code.
- Cloud collaboration.
