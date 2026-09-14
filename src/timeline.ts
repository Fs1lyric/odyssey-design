/** Odyssey Video — the timeline model, mirroring src-tauri/src/timeline.rs.
 *  Rust owns rendering; this owns editing. The shapes must stay in step. */

export type Easing =
  | "linear" | "hold" | "easein" | "easeout" | "easeinout"
  | "cubicin" | "cubicout" | "cubicinout" | "sinein" | "sineout"
  | "backout" | "elasticout" | "bounceout";

export interface Keyframe {
  time: number;
  value: number;
  easing: Easing;
}

export type Param = number | { keyframes: Keyframe[] };

export interface Marker {
  id: string;
  time: number;
  name: string;
  colour: string;
}

export type Source =
  | { type: "media"; path: string }
  | { type: "still"; path: string }
  | { type: "adjustment" }
  | { type: "nested"; name: string; project: Project }
  | { type: "title"; text: string; background: string; size: number; color: string }
  | { type: "color"; color: string };

export type Effect =
  | { kind: "color"; brightness: Param; contrast: Param; saturation: Param; gamma: Param }
  | { kind: "hue"; degrees: Param }
  | { kind: "blur"; sigma: Param }
  | { kind: "sharpen"; amount: Param }
  | { kind: "opacity"; level: Param }
  | { kind: "fade"; in_secs: number; out_secs: number }
  | { kind: "crop"; x: Param; y: Param; width: number; height: number }
  | { kind: "rotate"; degrees: Param }
  | { kind: "transform"; scale: Param; x: Param; y: Param }
  | { kind: "vignette"; angle: Param }
  | { kind: "chromakey"; color: string; similarity: Param; blend: Param }
  | { kind: "text"; content: string; size: number; color: string; x: Param; y: Param; font: string }
  | { kind: "volume"; level: Param }
  | { kind: "audiofade"; in_secs: number; out_secs: number }
  | { kind: "highpass"; frequency: Param }
  | { kind: "lowpass"; frequency: Param }
  | { kind: "frei0r"; name: string; params: Param[] }
  | { kind: "curves"; master: Array<[number, number]>; red: Array<[number, number]>;
      green: Array<[number, number]>; blue: Array<[number, number]> }
  | { kind: "colorwheels"; lift_r: Param; lift_g: Param; lift_b: Param;
      gamma_r: Param; gamma_g: Param; gamma_b: Param;
      gain_r: Param; gain_g: Param; gain_b: Param }
  | { kind: "lut3d"; path: string }
  | { kind: "stabilize"; trf: string; smoothing: number; zoom: number }
  | { kind: "loudness"; target: number }
  | { kind: "denoise"; strength: number }
  | { kind: "flip"; horizontal: boolean; vertical: boolean }
  | { kind: "pixelate"; size: Param }
  | { kind: "invert" }
  | { kind: "monochrome" }
  | { kind: "temperature"; kelvin: Param }
  | { kind: "levels"; black: Param; white: Param }
  | { kind: "exposure"; stops: Param }
  | { kind: "grain"; strength: number }
  | { kind: "boxblur"; radius: Param }
  | { kind: "motionblur"; frames: number }
  | { kind: "edgedetect"; low: number; high: number }
  | { kind: "emboss" }
  | { kind: "crisp" }
  | { kind: "deband" }
  | { kind: "deflicker" }
  | { kind: "lenscorrect"; k1: Param; k2: Param }
  | { kind: "lumakey"; threshold: Param; tolerance: Param }
  | { kind: "despill"; colour: string; amount: Param }
  | { kind: "chromashift"; x: Param; y: Param }
  | { kind: "reframe"; aspect: number }
  | { kind: "posterize"; levels: Param }
  | { kind: "echo"; delay_ms: number; decay: number }
  | { kind: "chorus"; depth: number }
  | { kind: "flanger"; depth: number }
  | { kind: "pitchshift"; ratio: Param }
  | { kind: "noisegate"; threshold: number }
  | { kind: "compressor"; threshold: number; ratio: number }
  | { kind: "limiter"; ceiling: number }
  | { kind: "stereowidth"; amount: Param }
  | { kind: "mono" }
  | { kind: "swapchannels" }
  | { kind: "trimsilence"; threshold: number }
  | { kind: "vibrance"; intensity: Param }
  | { kind: "colorbalance"; r: Param; g: Param; b: Param }
  | { kind: "chromaticaberration"; amount: Param }
  | { kind: "shear"; x: Param; y: Param }
  | { kind: "colorkey"; color: string; similarity: Param; blend: Param }
  | { kind: "hsvkey"; hue: Param; sat: Param; val: Param; similarity: Param; blend: Param }
  | { kind: "frameblend"; frames: Param }
  | { kind: "falsecolor"; preset: string }
  | { kind: "histeq"; strength: Param }
  | { kind: "autolevels"; strength: Param }
  | { kind: "deinterlace"; mode: number }
  | { kind: "adaptivesharpen"; strength: Param }
  | { kind: "chromadenoise"; threshold: Param }
  | { kind: "huesaturation"; hue: Param; saturation: Param; intensity: Param }
  | { kind: "bilateral"; sigma_s: Param; sigma_r: Param }
  | { kind: "smartblur"; radius: Param; strength: Param }
  | { kind: "vaguedenoise"; threshold: Param }
  | { kind: "sepia" }
  | { kind: "scanlines"; amount: Param }
  | { kind: "mirror" }
  | { kind: "bass"; gain: Param; freq: Param }
  | { kind: "treble"; gain: Param; freq: Param }
  | { kind: "parametriceq"; freq: Param; width: Param; gain: Param }
  | { kind: "tremolo"; freq: Param; depth: Param }
  | { kind: "vibrato"; freq: Param; depth: Param }
  | { kind: "bitcrush"; bits: Param; mix: Param }
  | { kind: "exciter"; amount: Param }
  | { kind: "subboost"; amount: Param }
  | { kind: "speechnorm"; expansion: Param }
  | { kind: "audiodenoise"; reduction: Param };

/** Intrinsic clip motion. Every clip has it, the way Premiere does. */
export interface Motion {
  x: Param;
  y: Param;
  scale: Param;      // percent, 100 = original
  rotation: Param;   // degrees
  anchor_x: Param;
  anchor_y: Param;
  opacity: Param;    // 0..1
}

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "colordodge" | "colorburn" | "hardlight" | "softlight"
  | "difference" | "exclusion" | "addition" | "subtract"
  | "linearlight" | "pinlight" | "vividlight" | "hardmix" | "divide"
  | "glow" | "reflect" | "freeze" | "heat" | "negation" | "phoenix" | "grainmerge";

export function defaultMotion(): Motion {
  return { x: 0, y: 0, scale: 100, rotation: 0, anchor_x: 0, anchor_y: 0, opacity: 1 };
}

export function isIdentityMotion(m: Motion): boolean {
  const stat = (p: Param, v: number) => !isAnimated(p) && p === v;
  return stat(m.x, 0) && stat(m.y, 0) && stat(m.scale, 100) && stat(m.rotation, 0)
    && stat(m.anchor_x, 0) && stat(m.anchor_y, 0) && stat(m.opacity, 1);
}

/** Canvas equivalents for the preview. `subtract` has no canvas operation, so
 *  it previews as normal and only differs in the export. */
export const BLEND_CANVAS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  colordodge: "color-dodge",
  colorburn: "color-burn",
  hardlight: "hard-light",
  softlight: "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  addition: "lighter",
  subtract: "source-over",
  // Canvas has no equivalent for these, so they preview as normal and only
  // differ in the export. Same caveat as `subtract` above.
  linearlight: "source-over",
  pinlight: "source-over",
  vividlight: "source-over",
  hardmix: "source-over",
  divide: "source-over",
  glow: "source-over",
  reflect: "source-over",
  freeze: "source-over",
  heat: "source-over",
  negation: "source-over",
  phoenix: "source-over",
  grainmerge: "source-over",
};

export const BLEND_LABELS: Array<[BlendMode, string]> = [
  ["normal", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"],
  ["overlay", "Overlay"], ["darken", "Darken"], ["lighten", "Lighten"],
  ["colordodge", "Colour dodge"], ["colorburn", "Colour burn"],
  ["hardlight", "Hard light"], ["softlight", "Soft light"],
  ["difference", "Difference"], ["exclusion", "Exclusion"],
  ["addition", "Add"], ["subtract", "Subtract"],
  ["linearlight", "Linear light"], ["pinlight", "Pin light"],
  ["vividlight", "Vivid light"], ["hardmix", "Hard mix"], ["divide", "Divide"],
  ["glow", "Glow"], ["reflect", "Reflect"], ["freeze", "Freeze"],
  ["heat", "Heat"], ["negation", "Negation"], ["phoenix", "Phoenix"],
  ["grainmerge", "Grain merge"],
];

/** Motion parameters the inspector shows, in Premiere's order. */
export const MOTION_PARAMS: Array<{ key: keyof Motion; label: string; min: number; max: number; step: number }> = [
  { key: "x", label: "Position X", min: -4000, max: 4000, step: 1 },
  { key: "y", label: "Position Y", min: -4000, max: 4000, step: 1 },
  { key: "scale", label: "Scale %", min: 1, max: 800, step: 1 },
  { key: "rotation", label: "Rotation", min: -360, max: 360, step: 1 },
  { key: "anchor_x", label: "Anchor X", min: -4000, max: 4000, step: 1 },
  { key: "anchor_y", label: "Anchor Y", min: -4000, max: 4000, step: 1 },
  { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
];

export interface Clip {
  id: string;
  source: Source;
  start: number;
  in_point: number;
  out_point: number;
  speed: Param;
  reverse: boolean;
  channels: number[];
  preserve_pitch: boolean;
  gain: number;
  muted: boolean;
  effects: Effect[];
  motion: Motion;
  blend: BlendMode;
  transition_in: Transition | null;
}

export type TransitionKind =
  | "dissolve" | "diptoblack" | "diptowhite"
  | "wipeleft" | "wiperight" | "wipeup" | "wipedown" | "diagonalwipe"
  | "irisopen" | "irisclose" | "barndooropen" | "barndoorclose"
  | "clockwipe" | "pixeldissolve"
  | "slideleft" | "slideright" | "slideup" | "slidedown";

export interface Transition {
  kind: TransitionKind;
  duration: number;
}

export const TRANSITION_LABELS: Array<[TransitionKind, string]> = [
  ["dissolve", "Cross dissolve"],
  ["diptoblack", "Dip to black"],
  ["diptowhite", "Dip to white"],
  ["wipeleft", "Wipe left"],
  ["wiperight", "Wipe right"],
  ["wipeup", "Wipe up"],
  ["wipedown", "Wipe down"],
  ["diagonalwipe", "Diagonal wipe"],
  ["irisopen", "Iris open"],
  ["irisclose", "Iris close"],
  ["barndooropen", "Barn door open"],
  ["barndoorclose", "Barn door close"],
  ["clockwipe", "Clock wipe"],
  ["pixeldissolve", "Pixel dissolve"],
  ["slideleft", "Slide left"],
  ["slideright", "Slide right"],
  ["slideup", "Slide up"],
  ["slidedown", "Slide down"],
];

export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio";
  clips: Clip[];
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  solo: boolean;
  volume: number;
  opacity: number;
  blend: BlendMode;
  targeted: boolean;
  duck_under: string | null;
}

export interface BinItem {
  id: string;
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  proxy: string | null;
  folder: string;
  label: string;
}

export interface Subtitle {
  id: string;
  start: number;
  end: number;
  text: string;
}

export type SubtitleMode = "off" | "burn" | "embed";

export interface Proxy {
  source: string;
  path: string;
  width: number;
}

export interface Project {
  tracks: Track[];
  markers: Marker[];
  zone_in: number | null;
  zone_out: number | null;
  bin: BinItem[];
  subtitles: Subtitle[];
  subtitle_mode: SubtitleMode;
  subtitle_size: number;
  width: number;
  height: number;
  fps: number;
  sample_rate: number;
  background: string;
}

export interface PreviewChunk {
  start: number;
  end: number;
  path: string;
  key: string;
  width: number;
  height: number;
}

export interface Frei0rPlugin {
  name: string;
  label: string;
}

export interface RenderJob {
  id: string;
  name: string;
  project: Project;
  profile: RenderProfile;
  output: string;
  zone: [number, number] | null;
}

export interface JobResult {
  id: string;
  name: string;
  output: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

export interface RenderProfile {
  id: string;
  label: string;
  container: string;
  video_codec: string;
  audio_codec: string;
  crf: number | null;
  video_bitrate: string | null;
  audio_bitrate: string;
  preset: string;
}

// ---------------------------------------------------------------- helpers

export function emptyProject(): Project {
  return {
    tracks: [newTrack("V1", "video"), newTrack("A1", "audio")],
    markers: [],
    zone_in: null,
    zone_out: null,
    bin: [],
    subtitles: [],
    subtitle_mode: "off",
    subtitle_size: 42,
    width: 1920,
    height: 1080,
    fps: 30,
    sample_rate: 48000,
    background: "black",
  };
}

export function newTrack(name: string, kind: "video" | "audio"): Track {
  return {
    id: crypto.randomUUID(),
    name,
    kind,
    clips: [],
    muted: false,
    hidden: false,
    locked: false,
    solo: false,
    volume: 1,
    opacity: 1,
    blend: "normal",
    targeted: false,
    duck_under: null,
  };
}

export function isAnimated(p: Param): p is { keyframes: Keyframe[] } {
  return typeof p !== "number" && Array.isArray(p.keyframes);
}

function ease(p: number, e: Easing): number {
  const t = Math.min(1, Math.max(0, p));
  switch (e) {
    case "hold": return 0;
    case "easein": return t * t;
    case "easeout": return t * (2 - t);
    case "easeinout": return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case "cubicin": return t * t * t;
    case "cubicout": return 1 - Math.pow(1 - t, 3);
    case "cubicinout": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "sinein": return 1 - Math.cos((t * Math.PI) / 2);
    case "sineout": return Math.sin((t * Math.PI) / 2);
    // c1 = 1.70158 overshoot constant; c3 = c1 + 1. Matches ease() in timeline.rs.
    case "backout": return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
    case "elasticout":
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    case "bounceout": {
      const n = 7.5625, d = 2.75;
      if (t < 1 / d) return n * t * t;
      if (t < 2 / d) { const q = t - 1.5 / d; return n * q * q + 0.75; }
      if (t < 2.5 / d) { const q = t - 2.25 / d; return n * q * q + 0.9375; }
      const q = t - 2.625 / d;
      return n * q * q + 0.984375;
    }
    default: return t;
  }
}

/** Value of a parameter at a time offset within its clip. Mirrors Param::value_at. */
export function paramAt(p: Param, t: number): number {
  if (!isAnimated(p)) return typeof p === "number" ? p : 0;
  const kf = [...p.keyframes].sort((a, b) => a.time - b.time);
  if (!kf.length) return 0;
  if (t <= kf[0].time) return kf[0].value;
  const last = kf[kf.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      return a.value + (b.value - a.value) * ease((t - a.time) / span, a.easing);
    }
  }
  return last.value;
}

/** Set a parameter's value at a time, creating or moving a keyframe. */
export function setKeyframe(p: Param, t: number, value: number, easing: Easing = "linear"): Param {
  const kf = isAnimated(p) ? [...p.keyframes] : [{ time: 0, value: typeof p === "number" ? p : 0, easing: "linear" as Easing }];
  const at = kf.findIndex((k) => Math.abs(k.time - t) < 0.001);
  if (at >= 0) kf[at] = { time: t, value, easing };
  else kf.push({ time: t, value, easing });
  kf.sort((a, b) => a.time - b.time);
  return { keyframes: kf };
}

export function removeKeyframe(p: Param, t: number): Param {
  if (!isAnimated(p)) return p;
  const kf = p.keyframes.filter((k) => Math.abs(k.time - t) >= 0.001);
  if (kf.length <= 1) return kf.length ? kf[0].value : 0;
  return { keyframes: kf };
}

export function sourceDuration(c: Clip): number {
  return Math.max(0, c.out_point - c.in_point);
}

export interface Segment {
  src_start: number;
  src_end: number;
  speed: number;
  out_offset: number;
  out_len: number;
}

const SPEED_SEGMENTS_PER_SECOND = 8;
const MAX_SPEED_SEGMENTS = 240;

function speedAt(c: Clip, srcOffset: number): number {
  const v = Math.abs(paramAt(c.speed, srcOffset));
  return v < 0.01 ? 0.01 : v;
}

/** Constant-speed spans of a clip. Mirrors Clip::segments in timeline.rs. */
export function segments(c: Clip): Segment[] {
  const srcLen = sourceDuration(c);
  if (srcLen <= 0) return [];
  if (!isAnimated(c.speed)) {
    const v = speedAt(c, 0);
    return [{ src_start: c.in_point, src_end: c.out_point, speed: v, out_offset: 0, out_len: srcLen / v }];
  }
  const n = Math.min(MAX_SPEED_SEGMENTS, Math.max(2, Math.ceil(srcLen * SPEED_SEGMENTS_PER_SECOND)));
  const step = srcLen / n;
  const out: Segment[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const a = i * step, b = a + step;
    const v = speedAt(c, (a + b) / 2);
    const len = (b - a) / v;
    out.push({ src_start: c.in_point + a, src_end: c.in_point + b, speed: v, out_offset: cursor, out_len: len });
    cursor += len;
  }
  return out;
}

export function clipDuration(c: Clip): number {
  if (!isAnimated(c.speed)) return sourceDuration(c) / speedAt(c, 0);
  return segments(c).reduce((n, s) => n + s.out_len, 0);
}

/** Where in the source a given clip-local output time lands, honouring ramps. */
export function sourceTimeAt(c: Clip, localOut: number): number {
  const segs = segments(c);
  if (!segs.length) return c.in_point;
  for (const s of segs) {
    if (localOut < s.out_offset + s.out_len) {
      return s.src_start + (localOut - s.out_offset) * s.speed;
    }
  }
  const last = segs[segs.length - 1];
  return last.src_end;
}

/** Playback rate in effect at a clip-local output time. */
export function speedAtOutput(c: Clip, localOut: number): number {
  const segs = segments(c);
  for (const s of segs) {
    if (localOut < s.out_offset + s.out_len) return s.speed;
  }
  return segs.length ? segs[segs.length - 1].speed : 1;
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

export function projectDuration(p: Project): number {
  let max = 0;
  for (const t of p.tracks) for (const c of t.clips) max = Math.max(max, clipEnd(c));
  return max;
}

export function findClip(p: Project, id: string): { clip: Clip; track: Track } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { clip, track };
  }
  return null;
}

/** Does this clip overlap anything else on its own track? */
export function overlaps(track: Track, clip: Clip): boolean {
  return track.clips.some(
    (o) => o.id !== clip.id && clip.start < clipEnd(o) && o.start < clipEnd(clip)
  );
}

/** Push a clip right until it no longer collides with its neighbours. */
export function resolveCollision(track: Track, clip: Clip) {
  let guard = 0;
  while (overlaps(track, clip) && guard++ < 500) {
    const blocker = track.clips
      .filter((o) => o.id !== clip.id && clip.start < clipEnd(o) && o.start < clipEnd(clip))
      .sort((a, b) => clipEnd(b) - clipEnd(a))[0];
    if (!blocker) break;
    clip.start = clipEnd(blocker);
  }
}

/** Split a clip at an absolute timeline position. Returns the new right half. */
export function splitClip(track: Track, clip: Clip, at: number): Clip | null {
  const local = at - clip.start;
  const dur = clipDuration(clip);
  if (local <= 0.05 || local >= dur - 0.05) return null;
  const cutInSource = sourceTimeAt(clip, local);
  const right: Clip = {
    ...structuredClone(clip),
    id: crypto.randomUUID(),
    start: at,
    in_point: cutInSource,
  };
  clip.out_point = cutInSource;
  const idx = track.clips.indexOf(clip);
  track.clips.splice(idx + 1, 0, right);
  return right;
}

// ------------------------------------------------------------------ history

/** Snapshot undo. The project is a plain serialisable value, so whole-state
 *  snapshots are simpler and less bug-prone than command inversion, and at
 *  timeline sizes the memory cost is irrelevant. */
export class History {
  private past: string[] = [];
  private future: string[] = [];
  private names: string[] = [];
  private limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** Record the state *before* a change. `label` names it for the history
   *  panel; without one the entry is simply "Edit". */
  push(project: Project, label = "Edit") {
    this.past.push(JSON.stringify(project));
    this.names.push(label);
    if (this.past.length > this.limit) {
      this.past.shift();
      this.names.shift();
    }
    this.future.length = 0;
  }

  depth(): number { return this.past.length; }

  /** Entry names, oldest first. */
  labels(): string[] { return [...this.names]; }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  undo(current: Project): Project | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.names.pop();
    this.future.push(JSON.stringify(current));
    return JSON.parse(prev) as Project;
  }

  redo(current: Project): Project | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(JSON.stringify(current));
    this.names.push("Redo");
    return JSON.parse(next) as Project;
  }
}

/** Catalogue of effects the UI can add, with sane starting values. */
export const EFFECT_CATALOGUE: Array<{ label: string; group: string; make: () => Effect }> = [
  { label: "Colour", group: "Image", make: () => ({ kind: "color", brightness: 0, contrast: 1, saturation: 1, gamma: 1 }) },
  { label: "Hue", group: "Image", make: () => ({ kind: "hue", degrees: 0 }) },
  { label: "Blur", group: "Image", make: () => ({ kind: "blur", sigma: 4 }) },
  { label: "Sharpen", group: "Image", make: () => ({ kind: "sharpen", amount: 1 }) },
  { label: "Vignette", group: "Image", make: () => ({ kind: "vignette", angle: 0.6 }) },
  { label: "Chroma key", group: "Image", make: () => ({ kind: "chromakey", color: "green", similarity: 0.12, blend: 0.05 }) },
  { label: "Opacity", group: "Composite", make: () => ({ kind: "opacity", level: 1 }) },
  { label: "Fade in/out", group: "Composite", make: () => ({ kind: "fade", in_secs: 0.5, out_secs: 0.5 }) },
  { label: "Transform", group: "Geometry", make: () => ({ kind: "transform", scale: 1, x: 0, y: 0 }) },
  { label: "Rotate", group: "Geometry", make: () => ({ kind: "rotate", degrees: 0 }) },
  { label: "Crop", group: "Geometry", make: () => ({ kind: "crop", x: 0, y: 0, width: 1280, height: 720 }) },
  { label: "Text overlay", group: "Text", make: () => ({ kind: "text", content: "Text", size: 48, color: "white", x: 64, y: 64, font: "" }) },
  { label: "Volume", group: "Audio", make: () => ({ kind: "volume", level: 1 }) },
  { label: "Audio fade", group: "Audio", make: () => ({ kind: "audiofade", in_secs: 0.5, out_secs: 0.5 }) },
  { label: "High-pass", group: "Audio", make: () => ({ kind: "highpass", frequency: 200 }) },
  { label: "Low-pass", group: "Audio", make: () => ({ kind: "lowpass", frequency: 3000 }) },
  { label: "Loudness", group: "Audio", make: () => ({ kind: "loudness", target: -16 }) },
  { label: "Curves", group: "Colour", make: () => ({
      kind: "curves",
      master: [[0, 0], [0.5, 0.5], [1, 1]] as Array<[number, number]>,
      red: [] as Array<[number, number]>,
      green: [] as Array<[number, number]>,
      blue: [] as Array<[number, number]>,
    }) },
  { label: "Colour wheels", group: "Colour", make: () => ({
      kind: "colorwheels",
      lift_r: 0, lift_g: 0, lift_b: 0,
      gamma_r: 0, gamma_g: 0, gamma_b: 0,
      gain_r: 0, gain_g: 0, gain_b: 0,
    }) },
  { label: "LUT", group: "Colour", make: () => ({ kind: "lut3d", path: "" }) },
  { label: "Denoise", group: "Image", make: () => ({ kind: "denoise", strength: 4 }) },
  { label: "Stabilise", group: "Image", make: () => ({ kind: "stabilize", trf: "", smoothing: 10, zoom: 0 }) },

  { label: "Flip", group: "Geometry", make: () => ({ kind: "flip", horizontal: true, vertical: false }) },
  { label: "Reframe", group: "Geometry", make: () => ({ kind: "reframe", aspect: 1 }) },
  { label: "Lens correction", group: "Geometry", make: () => ({ kind: "lenscorrect", k1: -0.1, k2: 0 }) },

  { label: "Invert", group: "Colour", make: () => ({ kind: "invert" }) },
  { label: "Monochrome", group: "Colour", make: () => ({ kind: "monochrome" }) },
  { label: "Temperature", group: "Colour", make: () => ({ kind: "temperature", kelvin: 6500 }) },
  { label: "Levels", group: "Colour", make: () => ({ kind: "levels", black: 0, white: 1 }) },
  { label: "Exposure", group: "Colour", make: () => ({ kind: "exposure", stops: 0 }) },
  { label: "Posterize", group: "Colour", make: () => ({ kind: "posterize", levels: 6 }) },

  { label: "Pixelate", group: "Stylise", make: () => ({ kind: "pixelate", size: 16 }) },
  { label: "Film grain", group: "Stylise", make: () => ({ kind: "grain", strength: 8 }) },
  { label: "Box blur", group: "Stylise", make: () => ({ kind: "boxblur", radius: 4 }) },
  { label: "Motion blur", group: "Stylise", make: () => ({ kind: "motionblur", frames: 3 }) },
  { label: "Edge detect", group: "Stylise", make: () => ({ kind: "edgedetect", low: 0.1, high: 0.4 }) },
  { label: "Emboss", group: "Stylise", make: () => ({ kind: "emboss" }) },
  { label: "Crisp", group: "Stylise", make: () => ({ kind: "crisp" }) },
  { label: "Chroma shift", group: "Stylise", make: () => ({ kind: "chromashift", x: 2, y: 0 }) },

  { label: "Deband", group: "Repair", make: () => ({ kind: "deband" }) },
  { label: "Deflicker", group: "Repair", make: () => ({ kind: "deflicker" }) },

  { label: "Luma key", group: "Keying", make: () => ({ kind: "lumakey", threshold: 0.1, tolerance: 0.1 }) },
  { label: "Despill", group: "Keying", make: () => ({ kind: "despill", colour: "green", amount: 1 }) },

  { label: "Echo", group: "Audio", make: () => ({ kind: "echo", delay_ms: 300, decay: 0.4 }) },
  { label: "Chorus", group: "Audio", make: () => ({ kind: "chorus", depth: 0.5 }) },
  { label: "Flanger", group: "Audio", make: () => ({ kind: "flanger", depth: 2 }) },
  { label: "Pitch shift", group: "Audio", make: () => ({ kind: "pitchshift", ratio: 1 }) },
  { label: "Noise gate", group: "Audio", make: () => ({ kind: "noisegate", threshold: 0.02 }) },
  { label: "Compressor", group: "Audio", make: () => ({ kind: "compressor", threshold: 0.125, ratio: 4 }) },
  { label: "Limiter", group: "Audio", make: () => ({ kind: "limiter", ceiling: 0.95 }) },
  { label: "Stereo width", group: "Audio", make: () => ({ kind: "stereowidth", amount: 1 }) },
  { label: "Mono", group: "Audio", make: () => ({ kind: "mono" }) },
  { label: "Swap channels", group: "Audio", make: () => ({ kind: "swapchannels" }) },
  { label: "Trim silence", group: "Audio", make: () => ({ kind: "trimsilence", threshold: 0.02 }) },

  { label: "Vibrance", group: "Colour", make: () => ({ kind: "vibrance", intensity: 0.5 }) },
  { label: "Colour balance", group: "Colour", make: () => ({ kind: "colorbalance", r: 0, g: 0, b: 0 }) },
  { label: "Hue / saturation", group: "Colour", make: () => ({ kind: "huesaturation", hue: 0, saturation: 0, intensity: 0 }) },
  { label: "Histogram equalise", group: "Colour", make: () => ({ kind: "histeq", strength: 0.5 }) },
  { label: "Auto levels", group: "Colour", make: () => ({ kind: "autolevels", strength: 0.8 }) },
  { label: "False colour", group: "Colour", make: () => ({ kind: "falsecolor", preset: "magma" }) },
  { label: "Sepia", group: "Colour", make: () => ({ kind: "sepia" }) },
  { label: "Chromatic aberration", group: "Image", make: () => ({ kind: "chromaticaberration", amount: 2 }) },
  { label: "Scanlines", group: "Image", make: () => ({ kind: "scanlines", amount: 0.4 }) },
  { label: "Mirror", group: "Image", make: () => ({ kind: "mirror" }) },
  { label: "Adaptive sharpen", group: "Image", make: () => ({ kind: "adaptivesharpen", strength: 0.5 }) },
  { label: "Smart blur", group: "Image", make: () => ({ kind: "smartblur", radius: 2, strength: 0.5 }) },
  { label: "Bilateral smooth", group: "Image", make: () => ({ kind: "bilateral", sigma_s: 2, sigma_r: 0.2 }) },
  { label: "Wavelet denoise", group: "Image", make: () => ({ kind: "vaguedenoise", threshold: 3 }) },
  { label: "Chroma denoise", group: "Image", make: () => ({ kind: "chromadenoise", threshold: 20 }) },
  { label: "Frame blend", group: "Image", make: () => ({ kind: "frameblend", frames: 3 }) },
  { label: "Deinterlace", group: "Image", make: () => ({ kind: "deinterlace", mode: 0 }) },
  { label: "Shear", group: "Geometry", make: () => ({ kind: "shear", x: 0.1, y: 0 }) },
  { label: "Colour key", group: "Keying", make: () => ({ kind: "colorkey", color: "green", similarity: 0.2, blend: 0.1 }) },
  { label: "HSV key", group: "Keying", make: () => ({ kind: "hsvkey", hue: 120, sat: 0.5, val: 0.5, similarity: 0.2, blend: 0.1 }) },

  { label: "Bass", group: "Audio", make: () => ({ kind: "bass", gain: 4, freq: 100 }) },
  { label: "Treble", group: "Audio", make: () => ({ kind: "treble", gain: 3, freq: 3000 }) },
  { label: "Parametric EQ", group: "Audio", make: () => ({ kind: "parametriceq", freq: 1000, width: 1, gain: 3 }) },
  { label: "Tremolo", group: "Audio", make: () => ({ kind: "tremolo", freq: 5, depth: 0.5 }) },
  { label: "Vibrato", group: "Audio", make: () => ({ kind: "vibrato", freq: 5, depth: 0.5 }) },
  { label: "Bit crush", group: "Audio", make: () => ({ kind: "bitcrush", bits: 8, mix: 0.5 }) },
  { label: "Exciter", group: "Audio", make: () => ({ kind: "exciter", amount: 1 }) },
  { label: "Sub boost", group: "Audio", make: () => ({ kind: "subboost", amount: 0.5 }) },
  { label: "Speech normalise", group: "Audio", make: () => ({ kind: "speechnorm", expansion: 2 }) },
  { label: "Audio denoise", group: "Audio", make: () => ({ kind: "audiodenoise", reduction: 12 }) },
];

/** How each effect's parameters reach ffmpeg when animated. Mirrors
 *  Effect::animation_route in timeline.rs.
 *   - expression: evaluated per frame, exact
 *   - command:    sampled at 20 Hz and issued as timed commands
 *   - stacked:    sampled into gated filter instances, coarsest
 *   - static:     the effect has no animatable parameters */
export const ANIMATION_ROUTE: Record<string, "expression" | "command" | "stacked" | "static"> = {
  color: "expression", crop: "expression", rotate: "expression", volume: "expression",
  text: "expression", vignette: "expression",
  blur: "command", hue: "command", chromakey: "command", opacity: "command",
  highpass: "command", lowpass: "command", transform: "command",
  sharpen: "stacked", frei0r: "stacked",
  fade: "static", audiofade: "static",
  curves: "static", lut3d: "static", stabilize: "static",
  flip: "static", invert: "static", monochrome: "static", grain: "static",
  motionblur: "static", edgedetect: "static", emboss: "static", crisp: "static",
  deband: "static", deflicker: "static", reframe: "static",
  echo: "static", chorus: "static", flanger: "static", noisegate: "static",
  compressor: "static", limiter: "static", mono: "static", swapchannels: "static",
  trimsilence: "static",
  pixelate: "command", temperature: "command", levels: "command", exposure: "command",
  boxblur: "command", lenscorrect: "command", lumakey: "command", despill: "command",
  chromashift: "command", posterize: "command", pitchshift: "command", stereowidth: "command",
  loudness: "static", denoise: "static",
  colorwheels: "command",
};

export const ROUTE_LABEL: Record<string, string> = {
  expression: "per-frame",
  command: "sampled 20 Hz",
  stacked: "sampled",
  static: "",
};

/** frei0r plugins are added by name; their parameters are frei0r's own
 *  normalised 0..1 values, in the plugin's declared order. */
export function makeFrei0r(name: string, count = 4): Effect {
  return { kind: "frei0r", name, params: Array.from({ length: count }, () => 0.5 as Param) };
}

/** Which fields of an effect are numeric parameters the UI can edit and keyframe. */
export const EFFECT_PARAMS: Record<string, Array<{ key: string; label: string; min: number; max: number; step: number; keyframable: boolean }>> = {
  color: [
    { key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "contrast", label: "Contrast", min: 0, max: 4, step: 0.01, keyframable: true },
    { key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.01, keyframable: true },
    { key: "gamma", label: "Gamma", min: 0.1, max: 4, step: 0.01, keyframable: true },
  ],
  hue: [{ key: "degrees", label: "Degrees", min: -180, max: 180, step: 1, keyframable: true }],
  blur: [{ key: "sigma", label: "Amount", min: 0, max: 50, step: 0.5, keyframable: true }],
  sharpen: [{ key: "amount", label: "Amount", min: 0, max: 5, step: 0.1, keyframable: true }],
  opacity: [{ key: "level", label: "Opacity", min: 0, max: 1, step: 0.01, keyframable: true }],
  vignette: [{ key: "angle", label: "Angle", min: 0, max: 1.5, step: 0.01, keyframable: true }],
  chromakey: [
    { key: "similarity", label: "Similarity", min: 0, max: 1, step: 0.01, keyframable: true },
    { key: "blend", label: "Blend", min: 0, max: 1, step: 0.01, keyframable: true },
  ],
  transform: [
    { key: "scale", label: "Scale", min: 0.05, max: 4, step: 0.01, keyframable: true },
    { key: "x", label: "Pan X", min: -2000, max: 2000, step: 1, keyframable: true },
    { key: "y", label: "Pan Y", min: -2000, max: 2000, step: 1, keyframable: true },
  ],
  rotate: [{ key: "degrees", label: "Degrees", min: -360, max: 360, step: 1, keyframable: true }],
  crop: [
    { key: "x", label: "Offset X", min: 0, max: 4000, step: 1, keyframable: true },
    { key: "y", label: "Offset Y", min: 0, max: 4000, step: 1, keyframable: true },
  ],
  text: [
    { key: "x", label: "X", min: 0, max: 4000, step: 1, keyframable: true },
    { key: "y", label: "Y", min: 0, max: 4000, step: 1, keyframable: true },
  ],
  volume: [{ key: "level", label: "Level", min: 0, max: 4, step: 0.01, keyframable: true }],
  highpass: [{ key: "frequency", label: "Frequency", min: 20, max: 20000, step: 10, keyframable: true }],
  lowpass: [{ key: "frequency", label: "Frequency", min: 20, max: 20000, step: 10, keyframable: true }],
  pixelate: [{ key: "size", label: "Block size", min: 2, max: 128, step: 1, keyframable: true }],
  temperature: [{ key: "kelvin", label: "Kelvin", min: 1000, max: 12000, step: 50, keyframable: true }],
  levels: [
    { key: "black", label: "Black point", min: 0, max: 1, step: 0.01, keyframable: true },
    { key: "white", label: "White point", min: 0, max: 1, step: 0.01, keyframable: true },
  ],
  exposure: [{ key: "stops", label: "Stops", min: -4, max: 4, step: 0.1, keyframable: true }],
  boxblur: [{ key: "radius", label: "Radius", min: 0, max: 60, step: 1, keyframable: true }],
  lenscorrect: [
    { key: "k1", label: "Distortion", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "k2", label: "Secondary", min: -1, max: 1, step: 0.01, keyframable: true },
  ],
  lumakey: [
    { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, keyframable: true },
    { key: "tolerance", label: "Tolerance", min: 0, max: 1, step: 0.01, keyframable: true },
  ],
  despill: [{ key: "amount", label: "Amount", min: 0, max: 2, step: 0.05, keyframable: true }],
  chromashift: [
    { key: "x", label: "Shift X", min: -30, max: 30, step: 1, keyframable: true },
    { key: "y", label: "Shift Y", min: -30, max: 30, step: 1, keyframable: true },
  ],
  posterize: [{ key: "levels", label: "Levels", min: 2, max: 32, step: 1, keyframable: true }],
  pitchshift: [{ key: "ratio", label: "Pitch", min: 0.5, max: 2, step: 0.01, keyframable: true }],
  stereowidth: [{ key: "amount", label: "Width", min: 0, max: 4, step: 0.05, keyframable: true }],
  colorwheels: [
    { key: "lift_r", label: "Shadows R", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "lift_g", label: "Shadows G", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "lift_b", label: "Shadows B", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "gamma_r", label: "Midtones R", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "gamma_g", label: "Midtones G", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "gamma_b", label: "Midtones B", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "gain_r", label: "Highlights R", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "gain_g", label: "Highlights G", min: -1, max: 1, step: 0.01, keyframable: true },
    { key: "gain_b", label: "Highlights B", min: -1, max: 1, step: 0.01, keyframable: true },
  ],
};
