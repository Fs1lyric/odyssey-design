/** Odyssey Video — measurement scopes.
 *
 *  All four read the preview canvas, so they measure exactly what the monitor
 *  is showing. That means they reflect the preview's approximations too: an
 *  effect the canvas cannot express (chroma key, vignette, frei0r) is absent
 *  from the scope as well as from the picture. ffmpeg remains the authority on
 *  the exported result.
 */

export type ScopeKind = "histogram" | "waveform" | "vectorscope" | "parade";

export const SCOPE_LABELS: Array<[ScopeKind, string]> = [
  ["histogram", "Histogram"],
  ["waveform", "Waveform"],
  ["parade", "RGB parade"],
  ["vectorscope", "Vectorscope"],
];

/** How many source columns to sample. Scopes are a shape, not a census, and
 *  reading every pixel of a 4K frame per tick would stall the UI. */
const COLUMNS = 220;
const ROWS = 160;

interface Sampled {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Downsample the source canvas once; every scope reads from this. */
function sample(source: HTMLCanvasElement): Sampled | null {
  if (!source.width || !source.height) return null;
  const w = Math.min(COLUMNS, source.width);
  const h = Math.min(ROWS, source.height);
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  try {
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  } catch {
    // A tainted canvas cannot be read back; better no scope than a crash.
    return null;
  }
}

function clear(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = "#0B0D11";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

/** Luma and per-channel distribution. */
function drawHistogram(ctx: CanvasRenderingContext2D, s: Sampled, w: number, h: number) {
  const bins = 64;
  const r = new Array(bins).fill(0);
  const g = new Array(bins).fill(0);
  const b = new Array(bins).fill(0);
  for (let i = 0; i < s.data.length; i += 4) {
    r[Math.min(bins - 1, (s.data[i] * bins) >> 8)]++;
    g[Math.min(bins - 1, (s.data[i + 1] * bins) >> 8)]++;
    b[Math.min(bins - 1, (s.data[i + 2] * bins) >> 8)]++;
  }
  const peak = Math.max(1, ...r, ...g, ...b);
  const colours = ["rgba(255,80,80,0.75)", "rgba(80,255,140,0.75)", "rgba(90,150,255,0.75)"];
  [r, g, b].forEach((channel, ci) => {
    ctx.fillStyle = colours[ci];
    for (let i = 0; i < bins; i++) {
      const bh = (channel[i] / peak) * (h - 2);
      ctx.fillRect((i / bins) * w, h - bh, w / bins - 1, bh);
    }
  });
}

/** Luma against horizontal position, the classic waveform monitor. */
function drawWaveform(ctx: CanvasRenderingContext2D, s: Sampled, w: number, h: number) {
  ctx.fillStyle = "rgba(140,230,170,0.5)";
  for (let x = 0; x < s.width; x++) {
    const px = (x / s.width) * w;
    for (let y = 0; y < s.height; y++) {
      const i = (y * s.width + x) * 4;
      const luma = (0.2126 * s.data[i] + 0.7152 * s.data[i + 1] + 0.0722 * s.data[i + 2]) / 255;
      ctx.fillRect(px, (1 - luma) * (h - 2), Math.max(1, w / s.width), 1);
    }
  }
}

/** The same idea, but one panel per channel side by side. */
function drawParade(ctx: CanvasRenderingContext2D, s: Sampled, w: number, h: number) {
  const panel = w / 3;
  const tints = ["rgba(255,90,90,0.5)", "rgba(90,235,130,0.5)", "rgba(100,160,255,0.5)"];
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = tints[c];
    for (let x = 0; x < s.width; x++) {
      const px = c * panel + (x / s.width) * panel;
      for (let y = 0; y < s.height; y++) {
        const v = s.data[(y * s.width + x) * 4 + c] / 255;
        ctx.fillRect(px, (1 - v) * (h - 2), Math.max(1, panel / s.width), 1);
      }
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  for (let c = 1; c < 3; c++) {
    ctx.beginPath();
    ctx.moveTo(c * panel + 0.5, 0);
    ctx.lineTo(c * panel + 0.5, h);
    ctx.stroke();
  }
}

/** Chroma plotted on the colour plane, with the neutral point at centre. */
function drawVectorscope(ctx: CanvasRenderingContext2D, s: Sampled, w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 2;

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  for (const frac of [0.33, 0.66, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(190,220,255,0.55)";
  for (let i = 0; i < s.data.length; i += 4) {
    const r = s.data[i], g = s.data[i + 1], b = s.data[i + 2];
    // Rec.601 chroma, which is what a vectorscope plots.
    const u = -0.169 * r - 0.331 * g + 0.5 * b;
    const v = 0.5 * r - 0.419 * g - 0.081 * b;
    ctx.fillRect(cx + (u / 128) * radius, cy - (v / 128) * radius, 1, 1);
  }
}

/** Render one scope from the current preview frame. */
export function drawScope(
  kind: ScopeKind,
  source: HTMLCanvasElement,
  target: HTMLCanvasElement
) {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  const w = target.width;
  const h = target.height;
  clear(ctx, w, h);

  const s = sample(source);
  if (!s) return;

  switch (kind) {
    case "histogram": drawHistogram(ctx, s, w, h); break;
    case "waveform": drawWaveform(ctx, s, w, h); break;
    case "parade": drawParade(ctx, s, w, h); break;
    case "vectorscope": drawVectorscope(ctx, s, w, h); break;
  }
}
