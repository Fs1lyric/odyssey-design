/** Odyssey Video — the preview compositor.
 *
 *  Draws the project at a given time onto a canvas by compositing one hidden
 *  <video> element per active clip, in track order. Each clip goes through
 *  `FxPipeline`, which mirrors the renderer's per-clip chain: fit, effects in
 *  order on the clip's own layer, head transition, then motion and blend onto
 *  the composite. Transitions are resolved the way the renderer resolves them
 *  (`applyTransitions`), so overlaps line up with the export.
 *
 *  ffmpeg remains the authority. Where a clip uses something the pipeline
 *  cannot reproduce (frei0r, LUTs, temporal filters, nested sequences, blend
 *  modes a canvas lacks), the monitor says so, and while the playhead rests it
 *  shows the exact frame ffmpeg renders instead of an approximation.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip, MulticamGroup, Param, PreviewChunk, Project, TitleLayer, Track } from "./timeline";
import { paramAt, clipDuration, clipEnd, sourceTimeAt, speedAtOutput, BLEND_CANVAS, applyTransitions, isIdentityMotion } from "./timeline";
import { FxPipeline, type Surface } from "./fxpipe";
import { LoudnessMeter } from "./loudness";

/** What the monitor is showing: the live composite, a rendered span, or an
 *  exact frame from ffmpeg. */
export type MonitorMode = "live" | "rendered" | "exact";

/** One half of the trim two-up: a frame of a source, captioned. */
export interface TrimSide {
  /** Media or still path; null draws an empty (black) half. */
  path: string | null;
  still: boolean;
  /** Source time of the frame, seconds. */
  time: number;
  caption: string;
}

export class Preview {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private videos = new Map<string, HTMLVideoElement>();
  private stills = new Map<string, HTMLImageElement>();
  private project: Project;
  /** The timeline as the renderer composites it, transitions resolved. */
  private resolved: Project;
  private fx = new FxPipeline();
  private raf = 0;
  private lastTick = 0;

  // Audio graph: each clip's element feeds a per-clip gain, then its track's
  // gain, then an analyser the mixer reads levels from, then the speakers.
  private audio: AudioContext | null = null;
  private clipGain = new Map<string, GainNode>();
  private trackGain = new Map<string, GainNode>();
  private trackMeter = new Map<string, AnalyserNode>();
  private trackPan = new Map<string, StereoPannerNode>();
  /** The master bus every track feeds: fader, then a meter, then output. */
  private master: { gain: GainNode; meter: AnalyserNode } | null = null;
  /** Submixes: summing fader, pan, meter, then the master. Their effects are
   *  ffmpeg filters and, like clip audio effects, are heard in the export. */
  private buses = new Map<string, { gain: GainNode; pan: StereoPannerNode; meter: AnalyserNode }>();
  /** One gain per track and bus a send joins, keyed `track|bus`. */
  private sendGains = new Map<string, GainNode>();
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private meterBuf = new Float32Array(1024);
  private r128: LoudnessMeter | null = null;

  time = 0;
  playing = false;

  /** Shuttle rate. 1 is normal play; J and L step through ±2, 4 and 8.
   *  Negative rates cannot use the media elements' own playback, so reverse
   *  seeks every frame and is silent. */
  rate = 1;
  /** Where playback stops, for Play In to Out. Null plays to the end. */
  private stopAt: number | null = null;
  private rangeStart = 0;
  /** Loop back to the start of the range instead of stopping. */
  loop = false;

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

  /** Renders the exact frame at a time through ffmpeg. Set by the host; when
   *  null the monitor stays on the live composite and only reports. */
  exactFrame: ((project: Project, t: number) => Promise<string>) | null = null;
  onExactError: (detail: string) => void = () => {};
  /** Fired when the monitor's mode, or what it cannot show live, changes.
   *  `pending` is true while an exact frame is on its way. */
  onMode: (mode: MonitorMode, missing: string[], pending: boolean) => void = () => {};
  private exactToken = 0;
  private exactPending = -1;
  private exactTimer = 0;
  private exact: { token: number; img: HTMLImageElement } | null = null;
  private lastMissing: string[] = [];
  /** While a trim drag runs, the monitor shows the frames either side of the
   *  edit instead of the composite, as Premiere's trim monitor does. Two
   *  dedicated elements, because the two frames can come from the same clip. */
  private trimSides: [TrimSide | null, TrimSide | null] | null = null;
  private trimEls: HTMLVideoElement[] = [];
  /** Multicam view: every angle of a group at the playhead, in a grid. */
  private camView: MulticamGroup | null = null;
  private camEls: HTMLVideoElement[] = [];
  private lastReport = "";

  constructor(project: Project) {
    this.project = project;
    this.resolved = applyTransitions(project);
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
    this.invalidateExact();
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
    this.resolved = applyTransitions(project);
    this.invalidateExact();
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
    this.stills.clear();
    for (const el of [...this.trimEls, ...this.camEls]) { el.removeAttribute("src"); el.load(); }
    this.trimEls = [];
    this.camEls = [];
    window.clearTimeout(this.exactTimer);
    this.chunkEl?.pause();
    this.chunkEl?.removeAttribute("src");
    this.chunkEl = null;
    this.clipGain.clear();
    this.trackGain.clear();
    this.trackMeter.clear();
    this.trackPan.clear();
    this.master = null;
    this.r128?.destroy();
    this.r128 = null;
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
      // Track → pan → meter → master bus, the same order the renderer uses.
      const pan = ctx.createStereoPanner();
      gain.connect(pan);
      pan.connect(meter);
      this.trackGain.set(trackId, gain);
      this.trackMeter.set(trackId, meter);
      this.trackPan.set(trackId, pan);
      this.routeTrackOut(trackId);
    }
    return { gain, meter };
  }

  private busNodes(ctx: AudioContext, busId: string) {
    let b = this.buses.get(busId);
    if (!b) {
      b = { gain: ctx.createGain(), pan: ctx.createStereoPanner(), meter: ctx.createAnalyser() };
      b.meter.fftSize = 2048;
      b.gain.connect(b.pan);
      b.pan.connect(b.meter);
      b.meter.connect(this.masterBus(ctx).gain);
      this.buses.set(busId, b);
    }
    return b;
  }

  /** Connect a track's meter to its output (a bus or the master) and to a
   *  gain per send, as route_buses in timeline.rs routes the export. */
  private routeTrackOut(trackId: string) {
    const ctx = this.audio;
    const meter = this.trackMeter.get(trackId);
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!ctx || !meter) return;
    try { meter.disconnect(); } catch { /* not connected yet */ }
    const buses = new Set((this.project.buses ?? []).map((b) => b.id));
    const out = track?.output && buses.has(track.output) ? this.busNodes(ctx, track.output).gain : this.masterBus(ctx).gain;
    meter.connect(out);
    for (const send of track?.sends ?? []) {
      if (!buses.has(send.bus) || send.level <= 0) continue;
      const key = `${trackId}|${send.bus}`;
      let g = this.sendGains.get(key);
      if (!g) {
        g = ctx.createGain();
        g.connect(this.busNodes(ctx, send.bus).gain);
        this.sendGains.set(key, g);
      }
      g.gain.value = Math.min(4, send.level);
      meter.connect(g);
    }
  }

  private masterBus(ctx: AudioContext): { gain: GainNode; meter: AnalyserNode } {
    if (!this.master) {
      const gain = ctx.createGain();
      const meter = ctx.createAnalyser();
      meter.fftSize = 2048;
      gain.connect(meter);
      meter.connect(ctx.destination);
      this.master = { gain, meter };
    }
    return this.master;
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
      const pan = this.trackPan.get(track.id);
      if (pan) pan.pan.value = clamp(track.pan ?? 0, -1, 1);
      this.routeTrackOut(track.id);
    }
    if (this.audio) {
      for (const bus of this.project.buses ?? []) {
        const b = this.busNodes(this.audio, bus.id);
        b.gain.gain.value = bus.muted ? 0 : Math.max(0, bus.volume);
        b.pan.pan.value = clamp(bus.pan, -1, 1);
      }
      this.masterBus(this.audio).gain.gain.value = Math.max(0, this.project.master_volume ?? 1);
    }
  }

  /** Peak level of a track since the last read, 0..1. Used by the mixer. */
  levelOf(trackId: string): number {
    const meter = trackId === "master" ? this.master?.meter : this.trackMeter.get(trackId) ?? this.buses.get(trackId)?.meter;
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

  /** The R128 meter on the master bus, after the master fader. Null until
   *  the audio graph exists, which is after the first play. */
  loudnessMeter(): LoudnessMeter | null {
    if (!this.audio) return null;
    this.r128 ??= new LoudnessMeter(this.audio, this.masterBus(this.audio).gain);
    return this.r128;
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
    this.invalidateExact();
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
    for (const t of this.resolved.tracks) {
      for (const c of t.clips) max = Math.max(max, clipEnd(c));
    }
    return max;
  }

  /** Play `[a, b)` once, or round and round while `loop` is on. */
  playRange(a: number, b: number) {
    this.pause();
    this.rate = 1;
    this.rangeStart = a;
    this.stopAt = b;
    this.seek(a);
    this.play();
  }

  /** Set the shuttle rate and make sure playback is running at it. */
  shuttle(rate: number) {
    this.rate = rate;
    this.stopAt = null;
    this.rangeStart = 0;
    if (rate === 0) { this.pause(); return; }
    for (const v of this.videos.values()) if (rate < 0) v.pause();
    if (!this.playing) this.play();
    else this.syncSources(true);
  }

  /** A short burst of sound at the playhead, so scrubbing can be heard. */
  scrubAudio(ms = 90) {
    if (this.playing || this.usingRendered) return;
    this.refreshMix();
    const live = this.activeMedia();
    for (const { clip, track, video } of live) {
      this.routeAudio(clip, track, video);
      void video.play().catch(() => {});
    }
    window.setTimeout(() => {
      if (this.playing) return;
      for (const { video } of live) video.pause();
    }, ms);
  }

  play() {
    if (this.playing) return;
    if (this.rate === 0) this.rate = 1;
    const end = this.stopAt ?? this.duration();
    if (this.rate > 0 && this.time >= end - 1e-3) this.time = this.stopAt !== null ? this.rangeStart : 0;
    if (this.rate < 0 && this.time <= 1e-3) this.time = this.duration();
    this.playing = true;
    this.invalidateExact();
    this.lastTick = performance.now();
    this.refreshMix();
    this.syncSources(true);
    // Leave an exact frame at once rather than on the first animation frame,
    // so the monitor never labels live playback as ffmpeg's output.
    this.draw();
    if (this.activeChunk && this.rate === 1) {
      // A rendered span plays as one file; the live sources stay idle.
      void this.chunkEl?.play().catch(() => {});
    } else if (this.rate > 0) {
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
      this.time += dt * this.rate;
      const end = this.stopAt ?? this.duration();
      const past = this.rate > 0 ? this.time >= end : this.time <= 0;
      if (past && this.loop) {
        this.time = this.rate > 0 ? (this.stopAt !== null ? this.rangeStart : 0) : end;
        this.syncSources(true);
      } else if (past) {
        this.time = this.rate > 0 ? end : 0;
        this.stopAt = null;
        this.pause();
        this.draw();
        this.onTick(this.time);
        this.onEnded();
        return;
      }
      // Reverse has no native playback, so every frame is a seek.
      this.syncSources(this.rate < 0);
      this.draw();
      this.onTick(this.time);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    for (const el of this.camEls) el.pause();
    this.rate = 1;
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
    for (const track of this.resolved.tracks) {
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
    for (const track of this.resolved.tracks) {
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
    // Shuttling faster than real time or backwards cannot use one rendered
    // file's own playback, so it falls back to the live composite.
    const chunk = this.rate === 1 || !this.playing ? this.chunkAt(this.time) : null;
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
      const speed = speedAtOutput(clip, local) * Math.abs(this.rate || 1);
      video.playbackRate = Math.min(16, Math.max(0.0625, speed));
      // Only correct real drift; seeking every frame stalls decoding.
      if (hard || Math.abs(video.currentTime - want) > 0.25) {
        try {
          video.currentTime = Math.max(0, want);
        } catch {
          /* seeking before metadata is loaded throws; the next tick retries */
        }
      }
      if (this.playing && this.rate > 0 && video.paused) void video.play().catch(() => {});
      if (this.rate < 0 && !video.paused) video.pause();
    }
    // Anything no longer live should stop decoding.
    const activeIds = new Set(this.activeMedia().map((a) => a.clip.id));
    for (const [id, v] of this.videos) {
      if (!activeIds.has(id) && !v.paused) v.pause();
    }
  }

  draw() {
    const { ctx, canvas } = this;
    const W = this.project.width;
    const H = this.project.height;
    // Everything below is laid out in project pixels; `k` maps them onto the
    // backing store, so motion and effect sizes survive a resolution change.
    const k = canvas.width / Math.max(1, W);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = cssColor(this.project.background);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (this.trimSides) {
      this.drawTrim(this.trimSides);
      ctx.restore();
      return;
    }
    if (this.camView) {
      this.drawMulticam(this.camView);
      ctx.restore();
      return;
    }

    // Rendered span: one decode, drawn straight to the canvas.
    const chunk = this.activeChunk ?? (this.playing ? null : this.chunkAt(this.time));
    if (chunk) {
      const el = this.chunkEl;
      if (el && el.readyState >= 2 && el.videoWidth > 0) {
        drawContain(ctx, el, el.videoWidth, el.videoHeight, canvas.width, canvas.height);
      }
      ctx.restore();
      this.report("rendered", [], false);
      return;
    }

    // Exact frame: ffmpeg's own output for this instant, while parked on
    // something the live composite cannot reproduce.
    const exact = this.exact;
    if (!this.playing && !this.bypassRight && exact && exact.token === this.exactToken) {
      drawContain(ctx, exact.img, exact.img.naturalWidth, exact.img.naturalHeight, canvas.width, canvas.height);
      ctx.restore();
      this.report("exact", this.lastMissing, false);
      return;
    }

    ctx.setTransform(k, 0, 0, k, 0, 0);
    this.fx.beginFrame();
    const missing = new Set<string>();

    for (const { clip, track } of this.activeClips()) {
      const local = this.time - clip.start;
      const dur = clipDuration(clip);

      if (clip.source.type === "adjustment") {
        // An adjustment layer grades the composite so far, over its own span,
        // exactly as the renderer gates its filters onto the running output.
        if (!clip.effects.some((e) => e.enabled !== false)) continue;
        const snap = this.fx.surface(W, H, k);
        snap.ctx.drawImage(canvas, 0, 0, W, H);
        const res = this.fx.build(clip, snap, local, dur, k, W, H);
        res.missing.forEach((m) => missing.add(m));
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(res.layer.canvas, (W - res.layer.w) / 2, (H - res.layer.h) / 2, res.layer.w, res.layer.h);
        ctx.restore();
        continue;
      }
      if (clip.source.type === "nested") {
        missing.add("nested sequence");
        continue;
      }

      const blend = clip.blend === "normal" ? track.blend : clip.blend;
      const op = BLEND_CANVAS[blend] ?? "source-over";
      if (blend !== "normal" && op === "source-over") missing.add(`${blend} blend`);

      const base = this.sourceLayer(clip, local, dur, W, H, k);
      if (!base) continue;
      const res = this.fx.build(clip, base, local, dur, k, W, H);
      res.missing.forEach((m) => missing.add(m));

      ctx.save();
      this.placeLayer(clip, local, W, H);
      ctx.globalAlpha = clamp01(paramAt(clip.motion.opacity, local)) * clamp01(track.opacity ?? 1);
      ctx.globalCompositeOperation = op;
      // Split compare: effects on the left, the same clip bypassed on the
      // right. The halves are fixed to the frame, not to the moving layer.
      if (this.bypassRight) {
        ctx.save();
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.beginPath();
        ctx.rect(0, 0, W / 2, H);
        ctx.restore();
        ctx.clip();
      }
      const L = res.layer;
      ctx.drawImage(L.canvas, (W - L.w) / 2, (H - L.h) / 2, L.w, L.h);
      ctx.restore();

      if (this.bypassRight) {
        const plain = this.sourceLayer(clip, local, dur, W, H, k);
        if (plain) {
          const raw = this.fx.build(clip, plain, local, dur, k, W, H, true).layer;
          ctx.save();
          ctx.beginPath();
          ctx.rect(W / 2, 0, W / 2, H);
          ctx.clip();
          this.placeLayer(clip, local, W, H);
          ctx.globalAlpha = clamp01(track.opacity ?? 1);
          ctx.globalCompositeOperation = op;
          ctx.drawImage(raw.canvas, (W - raw.w) / 2, (H - raw.h) / 2, raw.w, raw.h);
          ctx.restore();
        }
      }
    }
    ctx.restore();

    this.lastMissing = [...missing];
    const wantExact = !this.playing && !this.bypassRight && missing.size > 0 && this.exactFrame !== null;
    if (wantExact) this.scheduleExact();
    this.report("live", this.lastMissing, wantExact);
  }

  /** Motion, as the renderer applies it: the layer is scaled and rotated about
   *  its anchor, then overlaid centred and offset by its position. */
  private placeLayer(clip: Clip, local: number, W: number, H: number) {
    const { ctx } = this;
    const m = clip.motion;
    const scale = Math.max(0.01, paramAt(m.scale, local) / 100);
    const rot = (paramAt(m.rotation, local) * Math.PI) / 180;
    const ax = paramAt(m.anchor_x, local);
    const ay = paramAt(m.anchor_y, local);
    const cx = W / 2;
    const cy = H / 2;
    ctx.translate(cx + paramAt(m.x, local) + ax, cy + paramAt(m.y, local) + ay);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-cx - ax, -cy - ay);
  }

  /** A clip's picture before its effects: fitted inside the frame as the
   *  renderer's scale does, and padded to the full frame in black when the
   *  clip has no motion, because that is what the renderer's pad produces and
   *  what covers the tracks beneath. With motion the layer keeps its own box. */
  private sourceLayer(clip: Clip, local: number, dur: number, W: number, H: number, k: number): Surface | null {
    const src = clip.source;
    if (src.type === "media" || src.type === "still") {
      let img: CanvasImageSource | null = null;
      let sw = 0;
      let sh = 0;
      if (src.type === "media") {
        const v = this.videos.get(clip.id);
        if (v && v.readyState >= 2 && v.videoWidth > 0) { img = v; sw = v.videoWidth; sh = v.videoHeight; }
      } else {
        const im = this.stillFor(src.path);
        if (im.complete && im.naturalWidth > 0) { img = im; sw = im.naturalWidth; sh = im.naturalHeight; }
      }
      if (!img) return null;
      const fit = Math.min(W / sw, H / sh);
      const pw = Math.max(1, Math.round(sw * fit));
      const ph = Math.max(1, Math.round(sh * fit));
      if (isIdentityMotion(clip.motion)) {
        const s = this.fx.surface(W, H, k);
        s.ctx.fillStyle = "#000";
        s.ctx.fillRect(0, 0, W, H);
        s.ctx.drawImage(img, (W - pw) / 2, (H - ph) / 2, pw, ph);
        return s;
      }
      const s = this.fx.surface(pw, ph, k);
      s.ctx.drawImage(img, 0, 0, pw, ph);
      return s;
    }
    const s = this.fx.surface(W, H, k);
    if (src.type === "color") {
      s.ctx.fillStyle = cssColor(src.color);
      s.ctx.fillRect(0, 0, W, H);
    } else if (src.type === "bars") {
      drawBars(s.ctx, W, H);
    } else if (src.type === "title") {
      drawTitle(s.ctx, src, local, dur, W, H);
    } else {
      return null;
    }
    return s;
  }

  /** Stills are decoded once per path and shared between clips. */
  private stillFor(path: string): HTMLImageElement {
    let im = this.stills.get(path);
    if (!im) {
      im = new Image();
      im.decoding = "async";
      im.onload = () => { if (!this.playing) this.draw(); };
      im.onerror = () => this.onSourceError(path, "the image could not be decoded");
      im.src = convertSrc(path);
      this.stills.set(path, im);
    }
    return im;
  }

  // ---- multicam grid ----

  setMulticamView(group: MulticamGroup | null) {
    this.camView = group;
    if (!group) for (const el of this.camEls) el.pause();
    this.draw();
  }

  /** The multicam clip under the playhead, topmost first, and the moment of
   *  the take it is showing, in reference time. */
  multicamAt(groupId: string): { clip: Clip; track: Track; ref: number } | null {
    const hits = this.activeClips().filter(({ clip }) => clip.multicam?.group === groupId);
    const top = hits[hits.length - 1];
    if (!top) return null;
    const group = this.camView?.id === groupId ? this.camView : null;
    const angle = group?.angles[top.clip.multicam!.angle];
    const local = this.time - top.clip.start;
    return { ...top, ref: sourceTimeAt(top.clip, local) - (angle?.offset ?? 0) };
  }

  /** Which grid cell a point on the canvas falls in (0..1 coordinates). */
  angleAt(x: number, y: number): number {
    const n = this.camView?.angles.length ?? 0;
    if (!n) return -1;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const i = Math.floor(y * rows) * cols + Math.floor(x * cols);
    return i >= 0 && i < n ? i : -1;
  }

  private drawMulticam(group: MulticamGroup) {
    const { ctx, canvas } = this;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    const n = group.angles.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cellW = cw / cols;
    const cellH = ch / rows;
    const at = this.multicamAt(group.id);
    const live = at?.clip.multicam?.angle ?? -1;
    const font = Math.max(10, Math.round(cellH / 12));
    group.angles.forEach((angle, i) => {
      let el = this.camEls[i];
      if (!el) {
        el = document.createElement("video");
        el.muted = true;
        el.preload = "auto";
        el.playsInline = true;
        el.addEventListener("seeked", () => { if (this.camView && !this.playing) this.draw(); });
        el.addEventListener("loadeddata", () => { if (this.camView && !this.playing) this.draw(); });
        this.camEls[i] = el;
      }
      const src = convertSrc(this.playbackPath(angle.path));
      if (el.dataset.src !== src) {
        el.src = src;
        el.dataset.src = src;
      }
      const x0 = (i % cols) * cellW;
      const y0 = Math.floor(i / cols) * cellH;
      if (at) {
        const want = at.ref + angle.offset;
        const inside = want >= 0 && want < angle.duration;
        if (!inside) {
          if (!el.paused) el.pause();
        } else if (this.playing && this.rate === 1) {
          if (el.paused) void el.play().catch(() => {});
          if (Math.abs(el.currentTime - want) > 0.2) el.currentTime = want;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - want) > 1 / 120) {
            try { el.currentTime = want; } catch { /* metadata pending */ }
          }
        }
        if (inside && el.readyState >= 2 && el.videoWidth) {
          const f = Math.min((cellW - 4) / el.videoWidth, (cellH - 4) / el.videoHeight);
          const w = el.videoWidth * f;
          const h = el.videoHeight * f;
          ctx.drawImage(el, x0 + (cellW - w) / 2, y0 + (cellH - h) / 2, w, h);
        }
      }
      const label = `${i + 1}  ${angle.name}`;
      ctx.font = `600 ${font}px "Adwaita Sans", system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgb(11 13 17 / 0.72)";
      ctx.fillRect(x0 + 6, y0 + 6, ctx.measureText(label).width + 12, font * 1.5);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x0 + 12, y0 + 6 + font * 0.25);
      if (i === live) {
        // The angle the programme is on, outlined as Premiere's red border.
        ctx.strokeStyle = "#e5484d";
        ctx.lineWidth = Math.max(3, Math.round(cw / 320));
        ctx.strokeRect(x0 + ctx.lineWidth / 2, y0 + ctx.lineWidth / 2, cellW - ctx.lineWidth, cellH - ctx.lineWidth);
      }
    });
    if (!at) {
      const msg = "No multicam clip at the playhead";
      ctx.font = `600 ${font}px "Adwaita Sans", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgb(255 255 255 / 0.8)";
      ctx.fillText(msg, cw / 2, ch / 2);
    }
  }

  // ---- trim two-up ----

  showTrim(left: TrimSide | null, right: TrimSide | null) {
    this.trimSides = [left, right];
    [left, right].forEach((side, i) => {
      if (!side?.path || side.still) return;
      let el = this.trimEls[i];
      if (!el) {
        el = document.createElement("video");
        el.muted = true;
        el.preload = "auto";
        el.playsInline = true;
        el.addEventListener("seeked", () => { if (this.trimSides) this.draw(); });
        el.addEventListener("loadeddata", () => { if (this.trimSides) this.draw(); });
        this.trimEls[i] = el;
      }
      const src = convertSrc(this.playbackPath(side.path));
      if (el.dataset.src !== src) {
        el.src = src;
        el.dataset.src = src;
      }
      // Seeking to the same spot again would stall the decoder mid-drag.
      if (Math.abs(el.currentTime - side.time) > 1 / 240) {
        try { el.currentTime = Math.max(0, side.time); } catch { /* metadata pending */ }
      }
    });
    this.draw();
  }

  hideTrim() {
    if (!this.trimSides) return;
    this.trimSides = null;
    this.draw();
  }

  private drawTrim(sides: [TrimSide | null, TrimSide | null]) {
    const { ctx, canvas } = this;
    const cw = canvas.width;
    const ch = canvas.height;
    const half = cw / 2;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    const font = Math.max(10, Math.round(ch / 22));
    sides.forEach((side, i) => {
      const x0 = i * half;
      if (side?.path) {
        let img: CanvasImageSource | null = null;
        let sw = 0;
        let sh = 0;
        if (side.still) {
          const im = this.stillFor(side.path);
          if (im.complete && im.naturalWidth) { img = im; sw = im.naturalWidth; sh = im.naturalHeight; }
        } else {
          const el = this.trimEls[i];
          if (el && el.readyState >= 2 && el.videoWidth) { img = el; sw = el.videoWidth; sh = el.videoHeight; }
        }
        if (img) {
          const f = Math.min((half - 4) / sw, ch / sh);
          const w = sw * f;
          const h = sh * f;
          ctx.drawImage(img, x0 + (half - w) / 2, (ch - h) / 2, w, h);
        }
      }
      if (side) {
        ctx.font = `600 ${font}px "Adwaita Sans", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const tw = ctx.measureText(side.caption).width;
        ctx.fillStyle = "rgb(11 13 17 / 0.72)";
        ctx.fillRect(x0 + half / 2 - tw / 2 - 6, ch - font * 1.8, tw + 12, font * 1.5);
        ctx.fillStyle = "#fff";
        ctx.fillText(side.caption, x0 + half / 2, ch - font * 0.45);
      }
    });
    ctx.fillStyle = "rgb(255 255 255 / 0.5)";
    ctx.fillRect(half - 1, 0, 2, ch);
  }

  // ---- exact frames ----

  /** Anything that could change the picture at the playhead invalidates the
   *  exact frame, so a stale one is never shown. */
  private invalidateExact() {
    this.exactToken++;
    this.exact = null;
    window.clearTimeout(this.exactTimer);
  }

  private scheduleExact() {
    if (!this.exactFrame || this.exactPending === this.exactToken) return;
    const token = this.exactToken;
    this.exactPending = token;
    window.clearTimeout(this.exactTimer);
    // Debounced, so scrubbing does not queue a render per mouse move.
    this.exactTimer = window.setTimeout(async () => {
      if (token !== this.exactToken || this.playing || !this.exactFrame) return;
      try {
        const path = await this.exactFrame(this.project, this.time);
        if (token !== this.exactToken) return;
        const img = new Image();
        img.onload = () => {
          if (token !== this.exactToken || this.playing) return;
          this.exact = { token, img };
          this.draw();
        };
        img.src = convertSrc(path);
      } catch (err) {
        if (token === this.exactToken) this.onExactError(String(err));
      }
    }, 220);
  }

  /** Tell the UI what the monitor is showing, when that changes. */
  private report(mode: MonitorMode, missing: string[], pending: boolean) {
    const key = `${mode}|${pending}|${missing.join(",")}`;
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.onMode(mode, missing, pending);
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

/** SMPTE-style bars, near enough to recognise; the export uses ffmpeg's. */
function drawBars(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const top = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  const bw = w / top.length;
  top.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * bw, 0, bw + 1, h * 0.67); });
  const mid = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];
  mid.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * bw, h * 0.67, bw + 1, h * 0.08); });
  ctx.fillStyle = "#131313";
  ctx.fillRect(0, h * 0.75, w, h * 0.25);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(w * 0.14, h * 0.75, w * 0.14, h * 0.25);
}

/** A title card with its Essential Graphics styling, mirroring title_drawtext
 *  in timeline.rs: the same anchors, margins and roll and crawl travel. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  src: Extract<Clip["source"], { type: "title" }>,
  local: number,
  dur: number,
  w: number,
  h: number
) {
  const st = src.style;
  if (!st || st.opaque) {
    ctx.fillStyle = cssColor(src.background);
    ctx.fillRect(0, 0, w, h);
  }
  ctx.font = `${src.size}px "Adwaita Sans", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const lines = src.text.split("\n");
  const lineH = src.size * 1.2;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const textH = lines.length * lineH;
  const d = Math.max(0.04, dur);
  const ox = st?.offset_x ?? 0, oy = st?.offset_y ?? 0;

  let x = (w - textW) / 2 + ox;
  if (st?.scroll === "crawl") x = w - (w + textW) * (local / d) + ox;
  else if (st?.align === "left") x = w * 0.06 + ox;
  else if (st?.align === "right") x = w - textW - w * 0.06 + ox;

  let y = (h - textH) / 2 + oy;
  if (st?.scroll === "roll") y = h - (h + textH) * (local / d) + oy;
  else if (st?.valign === "top") y = h * 0.08 + oy;
  else if (st?.valign === "bottom") y = h - textH - h * 0.08 + oy;
  else if (st?.valign === "lower-third") y = h * 0.72 + oy;

  if (st?.box_enabled) {
    const pad = st.box_padding;
    paintWith(ctx, st.box_color, () => ctx.fillRect(x - pad, y - pad, textW + pad * 2, textH + pad * 2));
  }
  lines.forEach((line, i) => {
    const ly = y + i * lineH;
    if (st?.shadow) {
      paintWith(ctx, st.shadow_color, () => ctx.fillText(line, x + st.shadow, ly + st.shadow));
    }
    if (st?.stroke_width) {
      paintWith(ctx, st.stroke_color, () => {
        ctx.lineJoin = "round";
        // drawtext's border straddles the glyph edge, so the canvas stroke,
        // centred on the edge, is drawn twice as wide.
        ctx.lineWidth = st.stroke_width * 2;
        ctx.strokeText(line, x, ly);
      });
    }
    paintWith(ctx, src.color, () => ctx.fillText(line, x, ly));
  });
  for (const layer of st?.layers ?? []) drawTitleLayer(ctx, layer, local, w, h);
}

/** One extra title layer, mirroring title_layer_filters: text fades in over
 *  its reveal, a shape grows from its left edge one frame's slice at a time. */
function drawTitleLayer(ctx: CanvasRenderingContext2D, layer: TitleLayer, local: number, w: number, h: number) {
  if (local < layer.appear) return;
  const into = local - layer.appear;
  if (layer.type === "rect") {
    const grown = layer.reveal > 0 ? clamp01(into / layer.reveal) : 1;
    const bx = Math.round(w * layer.x / 100), by = Math.round(h * layer.y / 100);
    const bw = Math.max(1, Math.round(w * layer.w / 100)), bh = Math.max(1, Math.round(h * layer.h / 100));
    paintWith(ctx, layer.color, () => ctx.fillRect(bx, by, Math.max(1, Math.round(bw * grown)), bh));
    if (layer.outline > 0 && grown >= 1) {
      // drawbox draws its thickness inside the box.
      const t = layer.outline;
      paintWith(ctx, layer.outline_color, () => {
        ctx.lineWidth = t;
        ctx.strokeRect(bx + t / 2, by + t / 2, bw - t, bh - t);
      });
    }
    return;
  }
  ctx.save();
  ctx.globalAlpha *= layer.reveal > 0 ? clamp01(into / layer.reveal) : 1;
  ctx.font = `${layer.size}px "Adwaita Sans", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const lines = layer.text.split("\n");
  const lineH = layer.size * 1.2;
  const textW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const textH = lines.length * lineH;
  const ax = w * layer.x / 100;
  const x = layer.align === "left" ? ax : layer.align === "right" ? ax - textW : ax - textW / 2;
  const y = h * layer.y / 100 - textH / 2;
  if (layer.box_enabled) {
    const pad = layer.box_padding;
    paintWith(ctx, layer.box_color, () => ctx.fillRect(x - pad, y - pad, textW + pad * 2, textH + pad * 2));
  }
  lines.forEach((line, i) => {
    const ly = y + i * lineH;
    if (layer.shadow) paintWith(ctx, layer.shadow_color, () => ctx.fillText(line, x + layer.shadow, ly + layer.shadow));
    if (layer.stroke_width) {
      paintWith(ctx, layer.stroke_color, () => {
        ctx.lineJoin = "round";
        ctx.lineWidth = layer.stroke_width * 2;
        ctx.strokeText(line, x, ly);
      });
    }
    paintWith(ctx, layer.color, () => ctx.fillText(line, x, ly));
  });
  ctx.restore();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** ffmpeg accepts names and hex; the canvas needs valid CSS. */
function cssColor(c: string): string {
  if (!c) return "#000";
  const at = c.indexOf("@");
  return at > 0 ? c.slice(0, at) : c;
}

/** The `@alpha` suffix ffmpeg colours may carry, 1 when absent. */
function alphaOf(c: string): number {
  const at = c.indexOf("@");
  const a = at > 0 ? Number(c.slice(at + 1)) : 1;
  return Number.isFinite(a) ? clamp01(a) : 1;
}

/** Fill or stroke in an ffmpeg colour, honouring its alpha. */
function paintWith(ctx: CanvasRenderingContext2D, colour: string, draw: () => void) {
  ctx.save();
  ctx.globalAlpha *= alphaOf(colour);
  ctx.fillStyle = cssColor(colour);
  ctx.strokeStyle = cssColor(colour);
  draw();
  ctx.restore();
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
