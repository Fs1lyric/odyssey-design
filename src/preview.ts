/** Odyssey Video — the preview compositor.
 *
 *  Draws the project at a given time onto a canvas by compositing one hidden
 *  <video> element per active clip, in track order, applying opacity and the
 *  effects the browser can express as canvas filters.
 *
 *  This is a preview, not the renderer. ffmpeg remains the authority on the
 *  final output. Two known divergences, both documented rather than hidden:
 *  ffmpeg's `eq` brightness is additive (-1..1) while the canvas `brightness()`
 *  filter is multiplicative, so brightness is approximated here; and effects
 *  with no canvas equivalent (chromakey, vignette, crop, rotate) are not shown
 *  in the preview at all.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip, Param, PreviewChunk, Project, Track } from "./timeline";
import { paramAt, clipDuration, clipEnd, sourceTimeAt, speedAtOutput, BLEND_CANVAS } from "./timeline";

export class Preview {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private videos = new Map<string, HTMLVideoElement>();
  private project: Project;
  private raf = 0;
  private lastTick = 0;

  // Audio graph: each clip's element feeds a per-clip gain, then its track's
  // gain, then an analyser the mixer reads levels from, then the speakers.
  private audio: AudioContext | null = null;
  private clipGain = new Map<string, GainNode>();
  private trackGain = new Map<string, GainNode>();
  private trackMeter = new Map<string, AnalyserNode>();
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private meterBuf = new Float32Array(1024);

  time = 0;
  playing = false;

  /** Rendered spans of the timeline. Where one covers the playhead, it is
   *  played back instead of compositing every clip live, which is the whole
   *  point of preview rendering: a heavy effect stack becomes one decode. */
  private chunks: PreviewChunk[] = [];
  private chunkEl: HTMLVideoElement | null = null;
  private activeChunk: PreviewChunk | null = null;

  /** True while the monitor is showing rendered output rather than a live
   *  composite. The UI surfaces this so the distinction is never a mystery. */
  usingRendered = false;

  /** When set, the right half of the frame is drawn without clip effects, so a
   *  grade can be judged against the untouched picture. */
  private bypassRight = false;

  /** Playback resolution. The canvas keeps its display size; only the backing
   *  pixel count drops, which is where the decode and composite cost is. */
  private resolution = 1;

  /** Original path -> proxy path. Preview only: the renderer never sees these,
   *  so an export can never silently ship proxy-quality footage. */
  private proxies: Record<string, string> = {};

  /** Fired on every frame while playing, so the UI can move its playhead. */
  onTick: (t: number) => void = () => {};
  onEnded: () => void = () => {};
  /** Fired when a source cannot be loaded, so a black monitor is explained
   *  rather than left a mystery. */
  onSourceError: (path: string, detail: string) => void = () => {};

  constructor(project: Project) {
    this.project = project;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "vid__canvas";
    this.canvas.width = project.width;
    this.canvas.height = project.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx = ctx;
    this.draw();
  }

  setResolution(scale: number) {
    this.resolution = Math.min(1, Math.max(0.1, scale));
    this.applySize();
    this.draw();
  }

  private applySize() {
    const w = Math.max(2, Math.round(this.project.width * this.resolution));
    const h = Math.max(2, Math.round(this.project.height * this.resolution));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  setBypassRight(on: boolean) {
    this.bypassRight = on;
    this.draw();
  }

  /** Swap in (or clear) the proxy map. Elements reload on the next draw. */
  setProxies(proxies: Record<string, string>) {
    const changed = JSON.stringify(proxies) !== JSON.stringify(this.proxies);
    this.proxies = proxies;
    if (changed) {
      // Force each element to re-resolve its source on the next sync.
      for (const v of this.videos.values()) {
        v.pause();
        delete v.dataset.src;
      }
      this.syncSources(true);
      this.draw();
    }
  }

  /** The file the preview should decode for a clip: its proxy if one exists. */
  private playbackPath(path: string): string {
    return this.proxies[path] ?? path;
  }

  /** Replace the set of rendered spans. */
  setChunks(chunks: PreviewChunk[]) {
    this.chunks = [...chunks].sort((a, b) => a.start - b.start);
    // Drop the element if its chunk is gone, so a stale render cannot show.
    if (this.activeChunk && !this.chunks.some((c) => c.key === this.activeChunk!.key)) {
      this.activeChunk = null;
      this.chunkEl?.pause();
      this.chunkEl?.removeAttribute("src");
    }
    this.draw();
  }

  private chunkAt(t: number): PreviewChunk | null {
    return this.chunks.find((c) => t >= c.start && t < c.end) ?? null;
  }

  private chunkElement(chunk: PreviewChunk): HTMLVideoElement {
    if (!this.chunkEl) {
      this.chunkEl = document.createElement("video");
      this.chunkEl.preload = "auto";
      this.chunkEl.muted = false;
      this.chunkEl.playsInline = true;
    }
    const src = convertSrc(chunk.path);
    if (this.chunkEl.dataset.src !== src) {
      this.chunkEl.src = src;
      this.chunkEl.dataset.src = src;
    }
    return this.chunkEl;
  }

  setProject(project: Project) {
    this.project = project;
    if (this.audio) this.applyMix();
    this.applySize();
    this.prune();
    this.draw();
  }

  destroy() {
    this.pause();
    for (const v of this.videos.values()) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    this.videos.clear();
    this.chunkEl?.pause();
    this.chunkEl?.removeAttribute("src");
    this.chunkEl = null;
    this.clipGain.clear();
    this.trackGain.clear();
    this.trackMeter.clear();
    void this.audio?.close().catch(() => {});
    this.audio = null;
  }

  /** Lazily create the audio graph. Browsers only allow this after a gesture,
   *  so it is built on the first play rather than at construction. */
  private ensureAudio(): AudioContext | null {
    if (this.audio) {
      if (this.audio.state === "suspended") void this.audio.resume().catch(() => {});
      return this.audio;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.audio = new Ctor();
    } catch {
      return null;
    }
    return this.audio;
  }

  /** The gain and analyser pair for a track, created on demand. */
  private trackNodes(trackId: string): { gain: GainNode; meter: AnalyserNode } | null {
    const ctx = this.ensureAudio();
    if (!ctx) return null;
    let gain = this.trackGain.get(trackId);
    let meter = this.trackMeter.get(trackId);
    if (!gain || !meter) {
      gain = ctx.createGain();
      meter = ctx.createAnalyser();
      meter.fftSize = 2048;
      gain.connect(meter);
      meter.connect(ctx.destination);
      this.trackGain.set(trackId, gain);
      this.trackMeter.set(trackId, meter);
    }
    return { gain, meter };
  }

  /** Route one clip's element into its track's bus. Safe to call repeatedly —
   *  createMediaElementSource may only be called once per element. */
  private routeAudio(clip: Clip, track: Track, el: HTMLMediaElement) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const nodes = this.trackNodes(track.id);
    if (!nodes) return;

    let src = this.sources.get(el);
    if (!src) {
      try {
        src = ctx.createMediaElementSource(el);
      } catch {
        return; // already routed, or the element cannot be captured
      }
      this.sources.set(el, src);
    }
    let cg = this.clipGain.get(clip.id);
    if (!cg) {
      cg = ctx.createGain();
      this.clipGain.set(clip.id, cg);
      src.disconnect();
      src.connect(cg);
    }
    try {
      cg.disconnect();
    } catch {
      /* not connected yet */
    }
    cg.connect(nodes.gain);
    cg.gain.value = clip.muted ? 0 : Math.max(0, clip.gain);
  }

  /** Apply track volume, mute and solo to the buses. */
  private applyMix() {
    const anySolo = this.project.tracks.some((t) => t.solo);
    for (const track of this.project.tracks) {
      const nodes = this.trackNodes(track.id);
      if (!nodes) continue;
      const silent = track.muted || (anySolo && !track.solo);
      nodes.gain.gain.value = silent ? 0 : Math.max(0, track.volume);
    }
  }

  /** Peak level of a track since the last read, 0..1. Used by the mixer. */
  levelOf(trackId: string): number {
    const meter = this.trackMeter.get(trackId);
    if (!meter) return 0;
    if (meter.fftSize !== this.meterBuf.length) this.meterBuf = new Float32Array(meter.fftSize);
    meter.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  /** Push mixer changes into the live audio graph. */
  refreshMix() {
    this.applyMix();
    for (const { clip, track, video } of this.activeMedia()) {
      this.routeAudio(clip, track, video);
    }
  }

  /** Drop video elements for clips that no longer exist. */
  private prune() {
    const live = new Set<string>();
    for (const t of this.project.tracks) for (const c of t.clips) live.add(c.id);
    for (const [id, v] of this.videos) {
      if (!live.has(id)) {
        v.pause();
        v.removeAttribute("src");
        this.videos.delete(id);
      }
    }
  }

  private elementFor(clip: Clip, src: string): HTMLVideoElement {
    let v = this.videos.get(clip.id);
    if (!v) {
      v = document.createElement("video");
      v.preload = "auto";
      v.muted = false; // level is governed by the audio graph, not the element
      v.playsInline = true;
      const el = v;
      el.addEventListener("error", () => {
        const why = el.error?.code === 4
          ? "the format is unsupported, or the file is outside the allowed asset scope"
          : el.error?.message || "unknown decode error";
        this.onSourceError(el.dataset.origin ?? el.dataset.src ?? "", why);
      });
      this.videos.set(clip.id, v);
    }
    if (v.dataset.src !== src) {
      v.src = src;
      v.dataset.src = src;
      v.dataset.origin = clip.source.type === "media" ? clip.source.path : clip.id;
    }
    return v;
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(t, this.duration()));
    // Scrubbing should not leave sound playing from the previous position.
    if (!this.playing) {
      for (const v of this.videos.values()) v.pause();
    }
    this.syncSources(true);
    this.draw();
    this.onTick(this.time);
  }

  duration(): number {
    let max = 0;
    for (const t of this.project.tracks) {
      for (const c of t.clips) max = Math.max(max, clipEnd(c));
    }
    return max;
  }

  play() {
    if (this.playing) return;
    if (this.time >= this.duration()) this.time = 0;
    this.playing = true;
    this.lastTick = performance.now();
    this.refreshMix();
    this.syncSources(true);
    if (this.activeChunk) {
      // A rendered span plays as one file; the live sources stay idle.
      void this.chunkEl?.play().catch(() => {});
    } else {
      for (const { clip, track, video } of this.activeMedia()) {
        this.routeAudio(clip, track, video);
        void video.play().catch(() => {});
      }
    }
    const loop = () => {
      if (!this.playing) return;
      const now = performance.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      this.time += dt;
      if (this.time >= this.duration()) {
        this.time = this.duration();
        this.pause();
        this.draw();
        this.onTick(this.time);
        this.onEnded();
        return;
      }
      this.syncSources(false);
      this.draw();
      this.onTick(this.time);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const v of this.videos.values()) v.pause();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Clips live at the current time, bottom track first. */
  private activeClips(): Array<{ clip: Clip; track: Track }> {
    const out: Array<{ clip: Clip; track: Track }> = [];
    for (const track of this.project.tracks) {
      if (track.hidden || track.kind !== "video") continue;
      for (const clip of track.clips) {
        if (this.time >= clip.start && this.time < clipEnd(clip)) out.push({ clip, track });
      }
    }
    return out;
  }

  /** Every media clip live right now, on any track. Audio-track clips are
   *  never drawn but must still be heard. */
  private activeMedia(): Array<{ clip: Clip; track: Track; video: HTMLVideoElement }> {
    const out: Array<{ clip: Clip; track: Track; video: HTMLVideoElement }> = [];
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (clip.source.type !== "media") continue;
        if (this.time < clip.start || this.time >= clipEnd(clip)) continue;
        if (track.kind === "video" && track.hidden) continue;
        out.push({ clip, track, video: this.elementFor(clip, convertSrc(this.playbackPath(clip.source.path))) });
      }
    }
    return out;
  }

  /** Position each source at the frame the playhead implies. */
  private syncSources(hard: boolean) {
    // Rendered span wins: play the file, and let the live sources rest.
    const chunk = this.chunkAt(this.time);
    this.activeChunk = chunk;
    this.usingRendered = chunk !== null;
    if (chunk) {
      const el = this.chunkElement(chunk);
      const want = this.time - chunk.start;
      if (hard || Math.abs(el.currentTime - want) > 0.25) {
        try {
          el.currentTime = Math.max(0, want);
        } catch {
          /* metadata not ready; the next tick retries */
        }
      }
      if (this.playing && el.paused) void el.play().catch(() => {});
      if (!this.playing && !el.paused) el.pause();
      for (const v of this.videos.values()) if (!v.paused) v.pause();
      return;
    }
    if (this.chunkEl && !this.chunkEl.paused) this.chunkEl.pause();

    for (const { clip, video } of this.activeMedia()) {
      // Honour speed ramps: both the source position and the playback rate
      // come from the segment the playhead is currently inside.
      const local = this.time - clip.start;
      const want = sourceTimeAt(clip, local);
      const speed = speedAtOutput(clip, local);
      video.playbackRate = Math.min(16, Math.max(0.0625, speed));
      // Only correct real drift; seeking every frame stalls decoding.
      if (hard || Math.abs(video.currentTime - want) > 0.25) {
        try {
          video.currentTime = Math.max(0, want);
        } catch {
          /* seeking before metadata is loaded throws; the next tick retries */
        }
      }
      if (this.playing && video.paused) void video.play().catch(() => {});
    }
    // Anything no longer live should stop decoding.
    const activeIds = new Set(this.activeMedia().map((a) => a.clip.id));
    for (const [id, v] of this.videos) {
      if (!activeIds.has(id) && !v.paused) v.pause();
    }
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = cssColor(this.project.background);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Rendered span: one decode, drawn straight to the canvas.
    const chunk = this.chunkAt(this.time);
    if (chunk) {
      const el = this.chunkEl;
      if (el && el.readyState >= 2 && el.videoWidth > 0) {
        drawContain(ctx, el, el.videoWidth, el.videoHeight, canvas.width, canvas.height);
      }
      ctx.restore();
      return;
    }

    for (const { clip } of this.activeClips()) {
      const local = this.time - clip.start;
      const dur = clipDuration(clip);
      ctx.save();
      // Intrinsic motion, applied the same way the renderer does: translate to
      // the anchor, rotate and scale about it, then translate back.
      const m = clip.motion;
      const mx = paramAt(m.x, local);
      const my = paramAt(m.y, local);
      const scale = Math.max(0.01, paramAt(m.scale, local) / 100);
      const rot = (paramAt(m.rotation, local) * Math.PI) / 180;
      const ax = paramAt(m.anchor_x, local);
      const ay = paramAt(m.anchor_y, local);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      ctx.translate(cx + mx + ax, cy + my + ay);
      ctx.rotate(rot);
      ctx.scale(scale, scale);
      ctx.translate(-cx - ax, -cy - ay);

      ctx.globalAlpha = opacityOf(clip, local, dur) * clamp01(paramAt(m.opacity, local));
      ctx.globalCompositeOperation = BLEND_CANVAS[clip.blend] ?? "source-over";
      ctx.filter = filterOf(clip, local);

      // Split compare draws the clip twice: effects on the left, bypassed on
      // the right, clipped to their halves.
      if (this.bypassRight) {
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width / 2, canvas.height);
        ctx.clip();
      }

      if (clip.source.type === "media") {
        const v = this.videos.get(clip.id);
        if (v && v.readyState >= 2 && v.videoWidth > 0) {
          drawContain(ctx, v, v.videoWidth, v.videoHeight, canvas.width, canvas.height);
        }
      } else if (clip.source.type === "color") {
        ctx.fillStyle = cssColor(clip.source.color);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else if (clip.source.type === "title") {
        ctx.fillStyle = cssColor(clip.source.background);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = cssColor(clip.source.color);
        ctx.font = `700 ${clip.source.size}px "Adwaita Sans", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        wrapText(ctx, clip.source.text, canvas.width / 2, canvas.height / 2, canvas.width * 0.86, clip.source.size * 1.25);
      }

      // Burned-in text effects are drawn after the clip content.
      for (const e of clip.effects) {
        if (e.kind === "text") {
          ctx.filter = "none";
          ctx.globalAlpha = 1;
          ctx.fillStyle = cssColor(e.color);
          ctx.font = `700 ${e.size}px "Adwaita Sans", system-ui, sans-serif`;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(e.content, paramAt(e.x, local), paramAt(e.y, local));
        }
      }
      ctx.restore();

      if (this.bypassRight) {
        // The same clip again, unfiltered, on the right.
        ctx.save();
        ctx.beginPath();
        ctx.rect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
        ctx.clip();
        this.paintClip(clip, local, dur, true);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** Draw one clip's picture. `bypass` skips the effect filters. */
  private paintClip(clip: Clip, local: number, dur: number, bypass: boolean) {
    const { ctx, canvas } = this;
    const m = clip.motion;
    const scale = Math.max(0.01, paramAt(m.scale, local) / 100);
    const rot = (paramAt(m.rotation, local) * Math.PI) / 180;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.translate(cx + paramAt(m.x, local) + paramAt(m.anchor_x, local),
                  cy + paramAt(m.y, local) + paramAt(m.anchor_y, local));
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-cx - paramAt(m.anchor_x, local), -cy - paramAt(m.anchor_y, local));
    ctx.globalAlpha = bypass ? 1 : opacityOf(clip, local, dur);
    ctx.filter = bypass ? "none" : filterOf(clip, local);

    if (clip.source.type === "media") {
      const v = this.videos.get(clip.id);
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        drawContain(ctx, v, v.videoWidth, v.videoHeight, canvas.width, canvas.height);
      }
    } else if (clip.source.type === "color") {
      ctx.fillStyle = cssColor(clip.source.color);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (clip.source.type === "title") {
      ctx.fillStyle = cssColor(clip.source.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
}

/** Fit the source inside the frame without distorting it. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sw: number,
  sh: number,
  dw: number,
  dh: number
) {
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(img, (dw - w) / 2, (dh - h) / 2, w, h);
}

function opacityOf(clip: Clip, local: number, dur: number): number {
  let a = 1;
  for (const e of clip.effects) {
    if (e.kind === "opacity") a *= clamp01(paramAt(e.level, local));
    if (e.kind === "fade") {
      if (e.in_secs > 0 && local < e.in_secs) a *= clamp01(local / e.in_secs);
      if (e.out_secs > 0 && local > dur - e.out_secs) {
        a *= clamp01((dur - local) / e.out_secs);
      }
    }
  }
  return clamp01(a);
}

/** Map the effects a canvas can express onto a CSS filter string. */
function filterOf(clip: Clip, local: number): string {
  const parts: string[] = [];
  for (const e of clip.effects) {
    switch (e.kind) {
      case "color": {
        const b = paramAt(e.brightness, local);
        // ffmpeg's brightness is additive; approximate it multiplicatively.
        parts.push(`brightness(${clamp(1 + b, 0, 4).toFixed(3)})`);
        parts.push(`contrast(${clamp(paramAt(e.contrast, local), 0, 4).toFixed(3)})`);
        parts.push(`saturate(${clamp(paramAt(e.saturation, local), 0, 4).toFixed(3)})`);
        break;
      }
      case "hue":
        parts.push(`hue-rotate(${paramAt(e.degrees, local).toFixed(2)}deg)`);
        break;
      case "blur": {
        const s = paramAt(e.sigma, local);
        if (s > 0) parts.push(`blur(${s.toFixed(2)}px)`);
        break;
      }
      default:
        break; // chromakey, vignette, crop, rotate have no canvas equivalent
    }
  }
  return parts.length ? parts.join(" ") : "none";
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const top = cy - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lineHeight));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** ffmpeg accepts names and hex; the canvas needs valid CSS. */
function cssColor(c: string): string {
  if (!c) return "#000";
  const at = c.indexOf("@");
  return at > 0 ? c.slice(0, at) : c;
}

/** Tauri serves local files through its own asset protocol; a bare filesystem
 *  path will not load in the webview. Outside Tauri the path is returned as-is
 *  so browser development still works. */
function convertSrc(path: string): string {
  if (!("__TAURI_INTERNALS__" in window)) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export type { Param };
