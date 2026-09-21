/** Odyssey Video — the editor: transport, multi-track timeline, effects,
 *  keyframes, undo and rendering. */
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, type Item, type LoudnessReport, type MediaInfo } from "./api";
import { isTauri } from "./devstore";
import type { Editor } from "./docs";
import { Preview, type TrimSide } from "./preview";
import { drawScope, SCOPE_LABELS, type ScopeKind } from "./scopes";
import {
  ANIMATION_ROUTE, ROUTE_LABEL, EFFECT_CATALOGUE, EFFECT_PARAMS, History, clipDuration, clipEnd, emptyProject, renderable, isIdentityMotion,
  findClip, isAnimated, newTrack, paramAt, projectDuration, removeKeyframe,
  resolveCollision, setKeyframe, sourceDuration, sourceTimeAt, splitClip, makeFrei0r,
  defaultMotion, BLEND_LABELS, MOTION_PARAMS, TRANSITION_LABELS, EASING_LABELS, FADE_CURVES,
  defaultTitleStyle, makeClip, migrateProject, multicamSpan, switchAngle,
  type BlendMode, type TransitionKind, type Clip, type Effect, type Param,
  type BinItem, type Frei0rPlugin, type PreviewChunk, type Project, type RenderJob,
  type RenderProfile, type Track, type Marker, type TitleStyle, type Interpolation,
  type FadeCurve,
} from "./timeline";
import {
  audioLag, breakApart, closeGaps, editTracks, expandSelection, extract, fillScale, insertClip,
  joinThroughEdits, lift, nestClips, overwriteClip, rippleTrimNext, rippleTrimPrevious,
  setClipSpeed, speedForDuration, staticSpeed, throughEdits,
} from "./edits";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"];
const MEDIA_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "flac", "m4a", ...IMAGE_EXTS];
const isImage = (p: string) => IMAGE_EXTS.includes((p.split(".").pop() ?? "").toLowerCase());

/** Colour labels, as Premiere names them. Used for clips, bin items and markers. */
const LABELS: Array<[string, string]> = [
  ["", "None"], ["#8C6CD8", "Violet"], ["#D35AA4", "Rose"], ["#E0A33B", "Mango"],
  ["#4FA3E0", "Caribbean"], ["#62B35B", "Forest"], ["#C0362C", "Red"], ["#2C5FC9", "Blue"],
];

/** Editor preferences. Per machine rather than per project, so they live in
 *  local storage; a missing or unreadable store simply means the defaults. */
interface Prefs {
  stillSeconds: number;
  transitionSeconds: number;
  holdSeconds: number;
  autosaveMinutes: number;
  prerollSeconds: number;
}
const DEFAULT_PREFS: Prefs = {
  stillSeconds: 5, transitionSeconds: 1, holdSeconds: 2, autosaveMinutes: 5, prerollSeconds: 2,
};
const PREFS_KEY = "odyssey-video-prefs";
const PRESETS_KEY = "odyssey-effect-presets";

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the setting lasts for this session only */
  }
}

type TimeFormat = "timecode" | "frames" | "seconds";

/** Parse what someone types into a time field: timecode, a frame count with
 *  an `f` suffix, seconds, or any of those with a leading + or - to move
 *  relative to `now`. */
function parseTime(text: string, fps: number, now: number): number | null {
  const raw = text.trim();
  if (!raw) return null;
  const sign = raw[0] === "+" ? 1 : raw[0] === "-" ? -1 : 0;
  const body = sign ? raw.slice(1).trim() : raw;
  let t: number | null = null;
  if (/^\d+f$/i.test(body)) {
    t = Number(body.slice(0, -1)) / fps;
  } else if (/^[\d:;.]+$/.test(body) && /[:;]/.test(body)) {
    const parts = body.split(/[:;]/).map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    const [f, sec = 0, min = 0, hr = 0] = [...parts].reverse();
    t = hr * 3600 + min * 60 + sec + f / fps;
  } else if (/^\d*\.?\d+$/.test(body)) {
    t = Number(body);
  }
  if (t === null) return null;
  return sign ? now + sign * t : t;
}
const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 400;

function tc(seconds: number, fps = 30): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s % 1) * fps);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${h > 0 ? p(h) + ":" : ""}${p(m)}:${p(sec)}:${p(f)}`;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function mountVideo(
  host: HTMLElement,
  item: Item,
  onChange: (patch: Partial<Item>) => void
): Editor {
  // ---------------------------------------------------------------- state
  /** The saved sequence. Undo history and persistence always act on this. */
  let saved: Project = normalise(item.data);
  /** The sequence being edited: `saved`, or a nested sequence inside it,
   *  reached through `nestPath`. It is the same object as the one inside the
   *  saved project, so edits made here land in it directly. */
  let project: Project = saved;
  /** Nested clip ids from the saved project down to the sequence open for
   *  editing, with where the playhead was in the parent when it was opened. */
  let nestPath: string[] = [];
  let nestReturn: number[] = [];
  const history = new History();
  /** The clip the inspector shows. Always a member of `selection` when set. */
  let selectedId: string | null = null;
  /** Every selected clip, including whole groups and linked partners. */
  let selection = new Set<string>();
  const prefs: Prefs = readStore(PREFS_KEY, DEFAULT_PREFS);
  let timeFormat: TimeFormat = "timecode";
  let audioScrub = true;
  let monitorZoom = 0; // 0 is fit
  let binView: "list" | "icons" = "list";
  let markerQuery = "";
  /** Bin paths that no longer resolve to a file. */
  let offline = new Set<string>();
  /** Source monitor in and out marks, per bin item, for this session. */
  const sourceMarks = new Map<string, { in: number; out: number }>();
  const binThumbs = new Map<string, string>();
  let lastAutosave = "";
  let autosaveTimer = 0;
  let unlistenDrop: (() => void) | null = null;
  let scrollerEl: HTMLElement | null = null;
  let pxPerSec = 40;
  let profiles: RenderProfile[] = [];
  let frei0r: Frei0rPlugin[] = [];
  const thumbs = new Map<string, string>();
  /** Peak envelopes keyed by source path, so two clips of one file share it. */
  const waves = new Map<string, number[]>();
  const wavePending = new Set<string>();
  let mixerOpen = false;
  /** The delivery target the loudness panel judges against, in LUFS. */
  let loudTarget = -16;
  /** The last ffmpeg measurement of the export, and the project it was for. */
  let exportLoudness: { report: LoudnessReport; key: string } | null = null;
  let measuringLoudness = false;
  let loudTick = 0;
  let meterRaf = 0;
  /** Rendered spans of the timeline, newest first. */
  let chunks: PreviewChunk[] = [];
  const PREVIEW_SCALE = 0.5;
  const PROXY_WIDTH = 640;
  /** How close, in pixels, an edge must be before it snaps. */
  const SNAP_PX = 8;
  let snapping = true;
  let scopeKind: ScopeKind | null = null;
  let scopeRaf = 0;
  let showGuides = false;
  let compareSplit = false;
  let historyOpen = false;
  let binFolder = "";
  let binQuery = "";
  let queue: RenderJob[] = [];
  let previewScale = 1;
  /** Copied clips with the kind of track each came from, so a paste puts
   *  sound back on audio tracks. Starts are kept relative to each other. */
  let clipboard: Array<{ clip: Clip; kind: "video" | "audio" }> = [];
  let trackHeight = 66;
  /** Horizontal scroll position, preserved across the rebuilds that culling
   *  makes frequent. */
  let scrollLeft = 0;
  /** Guards against the scroll handler re-entering while lanes are rebuilding,
   *  because restoring the scroll position fires another scroll event. */
  let rebuilding = false;
  /** Which side panel the inspector column is showing. */
  type Panel = "clip" | "bin" | "subtitles" | "markers";
  let panel: Panel = "clip";
  let useProxies = false;

  const preview = new Preview(project);

  // ---------------------------------------------------------------- shell
  const root = document.createElement("div");
  root.className = "vid";

  const stage = document.createElement("div");
  stage.className = "vid__stage";

  const monitor = document.createElement("div");
  monitor.className = "vid__monitor";
  monitor.appendChild(preview.canvas);

  const guides = document.createElement("div");
  guides.className = "vid__guides";
  guides.hidden = true;
  guides.setAttribute("aria-hidden", "true");
  monitor.appendChild(guides);

  const compare = document.createElement("div");
  compare.className = "vid__compare";
  compare.hidden = true;
  compare.setAttribute("aria-hidden", "true");
  monitor.appendChild(compare);

  const scopePanel = document.createElement("div");
  scopePanel.className = "vid__scope";
  scopePanel.hidden = true;
  const scopeCanvas = document.createElement("canvas");
  scopeCanvas.width = 280;
  scopeCanvas.height = 180;
  const scopeTitle = document.createElement("span");
  scopeTitle.className = "vid__scopetitle";
  scopePanel.append(scopeTitle, scopeCanvas);
  monitor.appendChild(scopePanel);

  // The monitor says what it is showing, so an approximation is never taken
  // for the export: a rendered span, an exact ffmpeg frame, or a live
  // composite that names whatever it cannot reproduce.
  // Trim readout: follows the pointer during a trim drag with the mode, the
  // signed change and the resulting edit points, so a trim can be judged to
  // the frame without reading the timeline.
  const trimReadout = document.createElement("div");
  trimReadout.className = "vid__trimreadout";
  trimReadout.setAttribute("role", "status");
  trimReadout.hidden = true;
  document.body.appendChild(trimReadout);

  const monitorStatus = document.createElement("div");
  monitorStatus.className = "vid__status";
  monitorStatus.setAttribute("role", "status");
  monitorStatus.hidden = true;
  monitor.appendChild(monitorStatus);

  const sidebar = document.createElement("aside");
  sidebar.className = "vid__side";
  sidebar.setAttribute("aria-label", "Clip inspector");

  stage.append(monitor, sidebar);

  const transport = document.createElement("div");
  transport.className = "vid__transport";

  const tracksWrap = document.createElement("div");
  tracksWrap.className = "vid__tracks";

  const status = document.createElement("p");
  status.className = "vid__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const queuePanel = document.createElement("section");
  queuePanel.className = "vid__history";
  queuePanel.hidden = true;
  queuePanel.setAttribute("aria-label", "Render queue");

  const historyPanel = document.createElement("section");
  historyPanel.className = "vid__history";
  historyPanel.hidden = true;
  historyPanel.setAttribute("aria-label", "Undo history");

  const mixer = document.createElement("section");
  mixer.className = "vid__mixer";
  mixer.hidden = true;
  mixer.setAttribute("aria-label", "Audio mixer");

  const toolbar = document.createElement("div");
  toolbar.className = "doc-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Timeline tools");

  // Which sequence is open. Hidden at the top level; inside a nest it is the
  // way back out.
  const crumbs = document.createElement("nav");
  crumbs.className = "vid__crumbs";
  crumbs.setAttribute("aria-label", "Sequence");
  crumbs.hidden = true;

  root.append(toolbar, stage, mixer, queuePanel, historyPanel, transport, crumbs, tracksWrap, status);
  host.replaceChildren(root);

  // ---------------------------------------------------------------- helpers

  /** Walk `nestPath` from the saved project. A step that no longer exists (an
   *  undo removed the nest) ends the walk there, so the editor lands on the
   *  deepest sequence that is still real. */
  function resolveNested(): Project {
    let p = saved;
    const kept: string[] = [];
    for (const id of nestPath) {
      const hit = findClip(p, id);
      if (!hit || hit.clip.source.type !== "nested") break;
      p = hit.clip.source.project;
      kept.push(id);
    }
    nestPath = kept;
    nestReturn.length = kept.length;
    return p;
  }

  /** Open a nested sequence for editing in place, as Premiere does on a
   *  double click. The playhead lands on the frame it was over. */
  function openNested(clip: Clip) {
    if (clip.source.type !== "nested") return;
    const inner = clip.source.project;
    const speed = isAnimated(clip.speed) ? 1 : Math.max(0.01, Math.abs(paramAt(clip.speed, 0)));
    const within = preview.time >= clip.start && preview.time < clipEnd(clip)
      ? clip.in_point + (preview.time - clip.start) * speed
      : clip.in_point;
    nestReturn.push(preview.time);
    nestPath.push(clip.id);
    project = resolveNested();
    // The inner sequence renders at the parent's size, so keep them in step.
    inner.width ||= saved.width;
    inner.height ||= saved.height;
    inner.fps ||= saved.fps;
    clearSelection();
    commit();
    preview.seek(within);
    say(`Editing ${clip.source.name}. Esc or the breadcrumb returns to the parent.`);
  }

  /** Close nested sequences until `depth` remain open. */
  function closeNested(depth = nestPath.length - 1) {
    if (depth < 0 || depth >= nestPath.length) return;
    const back = nestReturn[depth] ?? 0;
    nestPath = nestPath.slice(0, depth);
    nestReturn = nestReturn.slice(0, depth);
    project = resolveNested();
    clearSelection();
    commit();
    preview.seek(back);
    say(depth === 0 ? "Back to the main sequence." : "Back to the parent sequence.");
  }

  function renderCrumbs() {
    crumbs.hidden = nestPath.length === 0;
    if (crumbs.hidden) { crumbs.replaceChildren(); return; }
    const names = [item.title || "Sequence"];
    let p = saved;
    for (const id of nestPath) {
      const hit = findClip(p, id);
      if (!hit || hit.clip.source.type !== "nested") break;
      names.push(hit.clip.source.name);
      p = hit.clip.source.project;
    }
    const parts: HTMLElement[] = [];
    names.forEach((name, i) => {
      if (i) {
        const sep = document.createElement("i");
        sep.className = "ph ph-caret-right";
        sep.setAttribute("aria-hidden", "true");
        parts.push(sep);
      }
      if (i === names.length - 1) {
        const here = document.createElement("span");
        here.textContent = name;
        here.setAttribute("aria-current", "page");
        parts.push(here);
      } else {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn--quiet";
        b.textContent = name;
        b.addEventListener("click", () => closeNested(i));
        parts.push(b);
      }
    });
    const note = document.createElement("span");
    note.className = "vid__crumbnote";
    note.textContent = "Edits apply wherever this sequence is used. Export renders the open sequence.";
    parts.push(note);
    crumbs.replaceChildren(...parts);
  }

  function normalise(data: unknown): Project {
    const d = (data ?? {}) as Partial<Project>;
    if (!Array.isArray(d.tracks) || !d.tracks.length) return emptyProject();
    // Older saved projects predate later fields, so fill the gaps rather than
    // rejecting them.
    return migrateProject({
      tracks: d.tracks,
      markers: Array.isArray(d.markers) ? d.markers : [],
      zone_in: d.zone_in ?? null,
      zone_out: d.zone_out ?? null,
      bin: Array.isArray(d.bin) ? d.bin : [],
      subtitles: Array.isArray(d.subtitles) ? d.subtitles : [],
      subtitle_mode: d.subtitle_mode ?? "off",
      subtitle_size: d.subtitle_size ?? 42,
      width: d.width ?? 1920,
      height: d.height ?? 1080,
      fps: d.fps ?? 30,
      sample_rate: d.sample_rate ?? 48000,
      background: d.background ?? "black",
      master_volume: d.master_volume ?? 1,
      multicam: Array.isArray(d.multicam) ? d.multicam : [],
    });
  }

  /** Record history, mutate, then persist and repaint. */
  function edit(fn: () => void, label = "Edit") {
    history.push(saved, label);
    fn();
    commit();
  }

  function commit() {
    // Any edit may have removed selected clips, directly or with their track.
    if (selectedId && !findClip(project, selectedId)) selectedId = null;
    if (selectedId) selection.add(selectedId);
    selection = new Set([...selection].filter((id) => findClip(project, id)));
    preview.setProject(project);
    onChange({ data: saved, body: summarise() });
    render();
    void revalidateChunks();
  }

  function summarise(): string {
    return saved.tracks
      .flatMap((t) => t.clips.map((c) => (c.source.type === "media" ? basename(c.source.path) : c.source.type)))
      .join(" ");
  }

  function say(msg: string, isError = false) {
    status.textContent = msg;
    status.dataset.state = isError ? "error" : "ok";
  }

  function selected(): { clip: Clip; track: Track } | null {
    return selectedId ? findClip(project, selectedId) : null;
  }

  /** Every selected clip with its track, in timeline order. */
  function selectedClips(): Array<{ clip: Clip; track: Track }> {
    const out: Array<{ clip: Clip; track: Track }> = [];
    for (const track of project.tracks) {
      for (const clip of track.clips) if (selection.has(clip.id)) out.push({ clip, track });
    }
    return out.sort((a, b) => a.clip.start - b.clip.start);
  }

  /** Selected clips on unlocked tracks, explaining when there are none. */
  function editableClips(): Array<{ clip: Clip; track: Track }> {
    const all = selectedClips();
    if (!all.length) { say("Select a clip first.", true); return []; }
    const free = all.filter((x) => !x.track.locked);
    if (!free.length) say("Every selected clip is on a locked track.", true);
    return free;
  }

  /** Replace the selection. Groups and linked partners come along. */
  function selectOnly(ids: Iterable<string>, primary: string | null = null) {
    selection = expandSelection(project, ids);
    selectedId = primary && selection.has(primary) ? primary : [...selection][0] ?? null;
  }

  function clearSelection() {
    selection = new Set();
    selectedId = null;
  }

  /** A locked track refuses every edit, not just dragging. Returns the
   *  selection when it is safe to change, and explains itself otherwise. */
  function editableSelection(): { clip: Clip; track: Track } | null {
    const sel = selected();
    if (!sel) { say("Select a clip first.", true); return null; }
    if (sel.track.locked) { say(`${sel.track.name} is locked.`, true); return null; }
    return sel;
  }

  function btn(label: string, onClick: () => void, cls = "btn btn--quiet", title?: string) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    if (title) { b.title = title; b.setAttribute("aria-label", title); }
    b.addEventListener("click", onClick);
    return b;
  }

  /** A button carrying a Phosphor glyph. Icon-only buttons keep an aria-label,
   *  since the glyph is decorative to a screen reader. */
  function iconBtn(icon: string, label: string, onClick: () => void, cls = "btn btn--quiet", showLabel = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = showLabel ? cls : `${cls} btn--icon`;
    const i = document.createElement("i");
    i.className = `ph ph-${icon}`;
    i.setAttribute("aria-hidden", "true");
    b.appendChild(i);
    if (showLabel) b.appendChild(document.createTextNode(label));
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function sep() {
    const s = document.createElement("span");
    s.className = "doc-toolbar__sep";
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  // ---------------------------------------------------------------- actions

  async function addMedia() {
    const picked = await open({ multiple: true, filters: [{ name: "Media and images", extensions: MEDIA_EXTS }] });
    if (!picked) return;
    await importPaths(Array.isArray(picked) ? picked : [picked], panel !== "bin");
  }

  /** Every time an edge could snap to: clip boundaries, markers, the
   *  playhead, the zone, and zero. */
  function snapTargets(exclude: string | null): number[] {
    const t: number[] = [0, preview.time];
    for (const track of project.tracks) {
      for (const c of track.clips) {
        if (c.id === exclude) continue;
        t.push(c.start, clipEnd(c));
      }
    }
    for (const m of project.markers) t.push(m.time);
    if (project.zone_in !== null) t.push(project.zone_in);
    if (project.zone_out !== null) t.push(project.zone_out);
    return t;
  }

  /** Pull a time to the nearest target within the snap threshold. */
  function snap(time: number, exclude: string | null): number {
    if (!snapping) return time;
    const tolerance = SNAP_PX / pxPerSec;
    let best = time;
    let bestGap = tolerance;
    for (const target of snapTargets(exclude)) {
      const gap = Math.abs(target - time);
      if (gap < bestGap) { bestGap = gap; best = target; }
    }
    return best;
  }

  /** Put a bin item onto the timeline at the end of its natural track. */
  function placeOnTimeline(path: string, duration: number, audioOnly: boolean): Clip {
    const track = trackFor(audioOnly ? "audio" : "video");
    const clip = clipForPath(path, duration);
    clip.start = endOf(track);
    track.clips.push(clip);
    selectOnly([clip.id], clip.id);
    return clip;
  }

  /** A clip for a file: a still for an image, held for the preferred
   *  duration, and media for anything else. */
  function clipForPath(path: string, duration: number, inPoint = 0, outPoint?: number): Clip {
    if (isImage(path)) return makeClip({ type: "still", path }, 0, prefs.stillSeconds);
    return makeClip({ type: "media", path }, 0, outPoint ?? (duration > 0 ? duration : 5), inPoint);
  }

  /** The first unlocked track of a kind, creating one if there is none.
   *  A targeted track of that kind wins, as Premiere's patching does. */
  function trackFor(kind: "video" | "audio"): Track {
    const existing = project.tracks.find((t) => t.kind === kind && !t.locked && t.targeted)
      ?? project.tracks.find((t) => t.kind === kind && !t.locked);
    if (existing) return existing;
    const n = project.tracks.filter((t) => t.kind === kind).length + 1;
    const track = newTrack(`${kind === "video" ? "V" : "A"}${n}`, kind);
    project.tracks.push(track);
    return track;
  }

  /** Where the next clip should land on a track. */
  function endOf(track: Track): number {
    return track.clips.reduce((n, c) => Math.max(n, clipEnd(c)), 0);
  }

  /** Only adopt a source's format while the project is still untouched. */
  function projectIsPristine(): boolean {
    return project.tracks.every((t) => t.clips.length === 0);
  }

  function addTitle() {
    edit(() => {
      const track = trackFor("video");
      const clip = makeClip(
        { type: "title", text: "Title", background: "#101820", size: 96, color: "white", style: defaultTitleStyle() },
        preview.time, 3);
      clip.effects = [{ kind: "fade", in_secs: 0.4, out_secs: 0.4 }];
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectOnly([clip.id], clip.id);
    }, "Add title");
    say("Title added. Edit its text in the inspector.");
  }

  function addColor() {
    edit(() => {
      const track = trackFor("video");
      const clip = makeClip({ type: "color", color: "#000000" }, preview.time, 2);
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectOnly([clip.id], clip.id);
    }, "Add colour matte");
  }

  /** Premiere's New Item > Bars and Tone. */
  function addBars() {
    edit(() => {
      const track = trackFor("video");
      const clip = makeClip({ type: "bars" }, preview.time, 5);
      clip.name = "Bars and tone";
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectOnly([clip.id], clip.id);
    }, "Add bars and tone");
    say("Bars and tone added: SMPTE HD bars with a 1 kHz tone at -20 dBFS.");
  }

  /** Add Edit (S, Ctrl+K): cut every selected clip under the playhead. */
  function splitAtPlayhead() {
    const picked = editableClips();
    if (!picked.length) return;
    const t = preview.time;
    const under = picked.filter(({ clip }) => t > clip.start && t < clipEnd(clip));
    if (!under.length) {
      say("Move the playhead over a selected clip first.", true);
      return;
    }
    edit(() => {
      const made: string[] = [];
      for (const { clip, track } of under) {
        const right = splitClip(track, clip, t);
        if (right) made.push(right.id);
      }
      if (made.length) selectOnly(made, made[0]);
    }, "Add edit");
    say(`Cut ${under.length} clip${under.length === 1 ? "" : "s"} at ${tc(t, project.fps)}.`);
  }

  function deleteSelected() {
    const picked = editableClips();
    if (!picked.length) return;
    const name = picked.length === 1 ? labelOf(picked[0].clip) : `${picked.length} clips`;
    const ids = new Set(picked.map((x) => x.clip.id));
    edit(() => {
      for (const t of project.tracks) t.clips = t.clips.filter((c) => !ids.has(c.id));
      clearSelection();
    }, "Delete");
    // A destructive action with no feedback left the previous status standing,
    // which read as though nothing had happened.
    say(`Removed ${name}.`);
  }

  function duplicateSelected() {
    const picked = editableClips();
    if (!picked.length) return;
    const end = Math.max(...picked.map((x) => clipEnd(x.clip)));
    const start = Math.min(...picked.map((x) => x.clip.start));
    edit(() => {
      const made: string[] = [];
      const groups = new Map<string, string>();
      for (const { clip, track } of picked) {
        const copy: Clip = {
          ...structuredClone(clip),
          id: crypto.randomUUID(),
          start: clip.start - start + end,
          // A copy of a group is its own group, not a member of the original.
          group: clip.group ? groups.get(clip.group) ?? groups.set(clip.group, crypto.randomUUID()).get(clip.group)! : null,
          link: null,
        };
        resolveCollision(track, copy);
        track.clips.push(copy);
        made.push(copy.id);
      }
      selectOnly(made, made[0]);
    }, "Duplicate");
  }

  function undo() {
    const prev = history.undo(saved);
    if (!prev) { say("Nothing to undo."); return; }
    saved = prev;
    project = resolveNested();
    commit();
    say("Undone.");
  }

  function redo() {
    const next = history.redo(saved);
    if (!next) { say("Nothing to redo."); return; }
    saved = next;
    project = resolveNested();
    commit();
    say("Redone.");
  }

  /** Fetch peak envelopes for any media clip that lacks one. */
  async function loadWaveforms() {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.source.type !== "media") continue;
        const path = clip.source.path;
        if (waves.has(path) || wavePending.has(path)) continue;
        wavePending.add(path);
        try {
          const peaks = await api.waveform(path, 512);
          waves.set(path, peaks);
          renderTracks();
        } catch {
          // No audio stream, or no ffmpeg: the clip simply draws without one.
          waves.set(path, []);
        } finally {
          wavePending.delete(path);
        }
      }
    }
  }

  async function loadThumbs() {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.source.type !== "media" || thumbs.has(clip.id)) continue;
        try {
          const path = await api.clipThumbnail(clip.source.path, clip.in_point + 0.1);
          thumbs.set(clip.id, convertSrc(path));
          renderTracks();
        } catch {
          /* a thumbnail is a nicety; its absence must not break the timeline */
        }
      }
    }
  }

  function convertSrc(path: string): string {
    if (!isTauri()) return path;
    try {
      return convertFileSrc(path);
    } catch {
      return path;
    }
  }

  // --------------------------------------------------------- undo history

  function toggleHistory() {
    historyOpen = !historyOpen;
    historyBtn.setAttribute("aria-pressed", String(historyOpen));
    renderHistory();
  }

  function renderHistory() {
    historyPanel.hidden = !historyOpen;
    if (!historyOpen) return;
    historyPanel.replaceChildren();

    const head = document.createElement("h3");
    head.textContent = `History · ${history.depth()} step${history.depth() === 1 ? "" : "s"}`;
    historyPanel.appendChild(head);

    const list = document.createElement("div");
    list.className = "vid__historylist";
    const labels = history.labels();
    if (!labels.length) {
      const empty = document.createElement("p");
      empty.className = "vid__hint";
      empty.textContent = "Nothing to undo yet.";
      historyPanel.appendChild(empty);
      return;
    }
    // Newest first: stepping back N entries is N undos.
    labels.forEach((label, i) => {
      const steps = labels.length - i;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "btn btn--quiet vid__historyrow";
      row.textContent = label;
      row.title = `Go back ${steps} step${steps === 1 ? "" : "s"}`;
      row.addEventListener("click", () => {
        for (let k = 0; k < steps; k++) {
          const prev = history.undo(saved);
          if (!prev) break;
          saved = prev;
          project = resolveNested();
        }
        commit();
        renderHistory();
        say(`Went back ${steps} step${steps === 1 ? "" : "s"}.`);
      });
      list.appendChild(row);
    });
    historyPanel.appendChild(list);
  }

  // ----------------------------------------------------------- monitor aids

  function toggleGuides() {
    showGuides = !showGuides;
    guides.hidden = !showGuides;
    guidesBtn.setAttribute("aria-pressed", String(showGuides));
    say(showGuides ? "Safe margins and grid on." : "Guides off.");
  }

  /** Split compare: the right half shows the clip with its effects bypassed,
   *  so a grade can be judged against the original. */
  function toggleCompare() {
    compareSplit = !compareSplit;
    compare.hidden = !compareSplit;
    compareBtn.setAttribute("aria-pressed", String(compareSplit));
    preview.setBypassRight(compareSplit);
    say(compareSplit ? "Comparing: right half bypasses effects." : "Compare off.");
  }

  // ---------------------------------------------------------- help / layout

  const SHORTCUTS: Array<[string, string]> = [
    ["Space", "Play or pause"],
    ["J / K / L", "Shuttle reverse, stop, forward (press again to go faster)"],
    ["Shift+K", "Play around the playhead"],
    ["Ctrl+Shift+Space", "Play in to out"],
    ["S / Ctrl+K", "Add edit to the selected clips"],
    ["Ctrl+Shift+K", "Add edit to every track"],
    ["Delete", "Remove the selected clips"],
    ["Shift+Delete", "Ripple delete"],
    ["Q / W", "Ripple trim previous / next edit to the playhead"],
    ["; / '", "Lift / extract in to out"],
    ["M", "Add a marker (double-click a marker to edit it)"],
    ["I / O", "Mark in and out"],
    ["Shift+I / Shift+O", "Go to in / out"],
    ["Ctrl+Shift+I / O", "Clear in / out"],
    ["X", "Mark clip"],
    ["[ / ] or Up / Down", "Jump to the previous or next edit"],
    [", / .", "Nudge one frame (shift for a second)"],
    ["Ctrl+A / Ctrl+Shift+A / Esc", "Select all / deselect"],
    ["Ctrl-click / Shift-click", "Toggle / add a clip to the selection"],
    ["Drag on an empty lane", "Marquee select"],
    ["A / Shift+A", "Track select forward / backward"],
    ["Ctrl+G / Ctrl+Shift+G", "Group / ungroup"],
    ["Ctrl+L", "Link or unlink"],
    ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy, cut, paste (overwrite)"],
    ["Ctrl+Shift+V", "Paste insert"],
    ["Ctrl+Alt+V", "Paste attributes"],
    ["Ctrl+R", "Speed / duration"],
    ["G", "Audio gain"],
    ["Ctrl+D / Ctrl+Shift+D", "Default video transition / audio crossfade"],
    ["Ctrl+M", "Export"],
    ["Ctrl+Shift+E", "Export frame"],
    ["= / - / \\", "Zoom in, out, to fit"],
    ["F", "Zoom to fit"],
    ["E", "Enable or disable the clip"],
    ["Drag in the monitor / scroll", "Move / scale the selected clip"],
    ["Ctrl-click the opacity line", "Add an opacity keyframe"],
    ["Drag from the bin (Ctrl to insert)", "Overwrite or insert at the drop point"],
    ["Arrows", "Step a frame (shift for a second)"],
    ["Home / End", "Go to the start or end"],
    ["Ctrl+Z / Ctrl+Shift+Z", "Undo and redo"],
    ["Shift-drag an edge", "Ripple trim"],
    ["Ctrl-drag an edge", "Roll the cut"],
    ["Alt-drag", "Slip the clip"],
    ["Ctrl+Alt-drag an edge", "Slide the clip"],
    ["Shift+Alt-drag an edge", "Rate stretch"],
  ];

  function showShortcuts() {
    const dialog = document.createElement("dialog");
    dialog.className = "vid__dialog";
    const h = document.createElement("h2");
    h.textContent = "Keyboard and mouse";
    const list = document.createElement("div");
    list.className = "vid__shortcuts";
    for (const [keys, what] of SHORTCUTS) {
      const k = document.createElement("kbd");
      k.textContent = keys;
      const d = document.createElement("span");
      d.textContent = what;
      list.append(k, d);
    }
    const actions = document.createElement("div");
    actions.className = "vid__dialogactions";
    actions.appendChild(btn("Close", () => dialog.close(), "btn btn--primary"));
    dialog.append(h, list, actions);
    root.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  }

  /** Workspaces: which panels are showing, saved by name. */
  type Workspace = { mixer: boolean; history: boolean; guides: boolean; scope: ScopeKind | null; panel: Panel };

  function applyWorkspace(w: Workspace) {
    mixerOpen = w.mixer;
    mixerBtn.setAttribute("aria-pressed", String(mixerOpen));
    historyOpen = w.history;
    historyBtn.setAttribute("aria-pressed", String(historyOpen));
    showGuides = w.guides;
    guides.hidden = !showGuides;
    guidesBtn.setAttribute("aria-pressed", String(showGuides));
    panel = w.panel;
    setScope(w.scope);
    render();
  }

  const WORKSPACES: Array<[string, Workspace]> = [
    ["Editing", { mixer: false, history: false, guides: false, scope: null, panel: "clip" }],
    ["Colour", { mixer: false, history: false, guides: true, scope: "waveform", panel: "clip" }],
    ["Audio", { mixer: true, history: false, guides: false, scope: null, panel: "clip" }],
    ["Organising", { mixer: false, history: true, guides: false, scope: null, panel: "bin" }],
  ];

  function showWorkspaces() {
    const dialog = document.createElement("dialog");
    dialog.className = "vid__dialog";
    const h = document.createElement("h2");
    h.textContent = "Workspace";
    const note = document.createElement("p");
    note.className = "vid__dialogmeta";
    note.textContent = "Each one sets which panels are showing.";
    const list = document.createElement("div");
    list.className = "vid__profiles";
    for (const [name, w] of WORKSPACES) {
      const b = btn(name, () => { applyWorkspace(w); dialog.close(); say(`${name} workspace.`); },
                    "btn vid__profile");
      list.appendChild(b);
    }
    const actions = document.createElement("div");
    actions.className = "vid__dialogactions";
    actions.appendChild(btn("Close", () => dialog.close(), "btn btn--primary"));
    dialog.append(h, note, list, actions);
    root.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  }

  // ------------------------------------------------------------ interchange

  async function exportInterchange(kind: "edl" | "otio") {
    if (!isTauri()) { say("Writing a file needs the desktop app.", true); return; }
    if (!projectDuration(project)) { say("Nothing to export.", true); return; }
    const ext = kind === "edl" ? "edl" : "otio";
    const out = await save({
      defaultPath: `${item.title || "odyssey"}.${ext}`,
      filters: [{ name: kind === "edl" ? "CMX3600 EDL" : "OpenTimelineIO", extensions: [ext] }],
    });
    if (!out) return;
    try {
      const text = kind === "edl"
        ? await api.exportEdl(project, item.title || "Timeline")
        : await api.exportOtio(project, item.title || "Timeline");
      await api.writeTextFile(out, text);
      say(`Wrote ${basename(out)}.${kind === "edl" ? " An EDL carries one video track of cuts." : ""}`);
    } catch (e) {
      say(`Could not write that file. ${String(e)}`, true);
    }
  }

  /** Detect cuts in the selected clip and drop a marker on each. */
  async function detectScenes() {
    const sel = selected();
    if (!sel || sel.clip.source.type !== "media") {
      say("Select a media clip to scan for cuts.", true);
      return;
    }
    if (!isTauri()) { say("Scene detection needs the desktop app.", true); return; }
    say(`Scanning ${labelOf(sel.clip)} for cuts…`);
    try {
      const cuts = await api.detectScenes(sel.clip.source.path, 0.3);
      if (!cuts.length) { say("No cuts found."); return; }
      const speed = isAnimated(sel.clip.speed) ? 1 : Math.max(0.01, paramAt(sel.clip.speed, 0));
      edit(() => {
        for (const at of cuts) {
          // Source time to timeline time, through the clip's own trim and speed.
          const local = (at - sel.clip.in_point) / speed;
          if (local < 0 || local > clipDuration(sel.clip)) continue;
          project.markers.push({
            id: crypto.randomUUID(),
            time: sel.clip.start + local,
            name: "cut",
            colour: "#C0362C",
            comment: "Scene edit detection",
            duration: 0,
            kind: "comment",
          });
        }
        project.markers.sort((a, b) => a.time - b.time);
      });
      say(`Found ${cuts.length} cut${cuts.length === 1 ? "" : "s"}.`);
    } catch (e) {
      say(`Scene detection failed. ${String(e)}`, true);
    }
  }

  /** Fold the selected track into a single nested sequence clip. */
  function nestSelectedTrack() {
    const sel = selected();
    if (!sel) { say("Select a clip on the track you want to nest.", true); return; }
    const track = sel.track;
    if (track.clips.length < 2) { say("A track needs at least two clips to nest.", true); return; }

    const inner: Project = {
      ...structuredClone(project),
      tracks: [structuredClone(track)],
      markers: [],
      zone_in: null,
      zone_out: null,
    };
    const span = track.clips.reduce((n, c) => Math.max(n, clipEnd(c)), 0);
    edit(() => {
      const nested = makeClip({ type: "nested", name: track.name, project: inner }, 0, span);
      track.clips = [nested];
      selectOnly([nested.id], nested.id);
    });
    say(`Nested ${track.name} into one clip.`);
  }

  // ------------------------------------------------------- clip operations

  /** Nudge the selected clip by one frame, or a second with shift. */
  function nudge(direction: -1 | 1, big: boolean) {
    if (selection.size > 1) { nudgeMany(direction, big); return; }
    const sel = editableSelection();
    if (!sel) return;
    const step = big ? 1 : 1 / project.fps;
    // Clamp against the neighbours rather than resolving a collision: pushing
    // a clip past its neighbour would teleport it on a one-frame nudge, and
    // nudging back would not return it to where it started.
    const others = sel.track.clips.filter((c) => c.id !== sel.clip.id);
    const len = clipDuration(sel.clip);
    const before = others.filter((c) => clipEnd(c) <= sel.clip.start + 1e-6);
    const after = others.filter((c) => c.start >= clipEnd(sel.clip) - 1e-6);
    const floor = before.reduce((nn, c) => Math.max(nn, clipEnd(c)), 0);
    const ceiling = after.reduce((nn, c) => Math.min(nn, c.start), Infinity);

    const wanted = sel.clip.start + direction * step;
    const limited = Math.max(floor, Math.min(wanted, ceiling - len));
    if (Math.abs(limited - sel.clip.start) < 1e-9) {
      say("The clip is against its neighbour.");
      return;
    }
    edit(() => { sel.clip.start = Math.max(0, limited); });
  }

  /** Nudge a multi-clip selection as one block, refusing rather than letting
   *  any member ride over a clip that is not part of the move. */
  function nudgeMany(direction: -1 | 1, big: boolean) {
    const picked = editableClips();
    if (!picked.length) return;
    const step = (big ? 1 : 1 / project.fps) * direction;
    const ids = new Set(picked.map((x) => x.clip.id));
    const blocked = picked.some(({ clip, track }) => {
      const a = clip.start + step, b = clipEnd(clip) + step;
      return a < -1e-9 || track.clips.some((o) => !ids.has(o.id) && a < clipEnd(o) - 1e-6 && o.start < b - 1e-6);
    });
    if (blocked) { say("The selection is against a neighbour.", true); return; }
    edit(() => { for (const { clip } of picked) clip.start = Math.max(0, clip.start + step); }, "Nudge");
  }

  function copySelection() {
    const picked = selectedClips();
    if (!picked.length) { say("Nothing selected to copy.", true); return; }
    clipboard = picked.map(({ clip, track }) => ({ clip: structuredClone(clip), kind: track.kind }));
    say(picked.length === 1 ? `Copied ${labelOf(picked[0].clip)}.` : `Copied ${picked.length} clips.`);
  }

  /** Cut (Ctrl+X): copy, then remove. */
  function cutSelection() {
    if (!selectedClips().length) { say("Nothing selected to cut.", true); return; }
    copySelection();
    deleteSelected();
  }

  /** Fresh copies of the clipboard, starting at `at`, each with its track. */
  function clipboardAt(at: number): Array<{ clip: Clip; track: Track }> {
    const first = Math.min(...clipboard.map((c) => c.clip.start));
    const groups = new Map<string, string>();
    return clipboard.map(({ clip, kind }) => {
      const copy: Clip = { ...structuredClone(clip), id: crypto.randomUUID(), start: at + clip.start - first, link: null };
      if (clip.group) {
        if (!groups.has(clip.group)) groups.set(clip.group, crypto.randomUUID());
        copy.group = groups.get(clip.group)!;
      }
      return { clip: copy, track: trackFor(kind) };
    });
  }

  function pasteAtPlayhead() {
    if (!clipboard.length) { say("The clipboard is empty.", true); return; }
    edit(() => {
      const made = clipboardAt(preview.time);
      for (const { clip, track } of made) overwriteClip(track, clip, clip.start);
      selectOnly(made.map((m) => m.clip.id), made[0].clip.id);
    }, "Paste");
    say(`Pasted at ${tc(preview.time, project.fps)}.`);
  }

  /** Paste Insert (Ctrl+Shift+V): open room at the playhead and paste into it. */
  function pasteInsert() {
    if (!clipboard.length) { say("The clipboard is empty.", true); return; }
    edit(() => {
      const made = clipboardAt(preview.time);
      const span = Math.max(...made.map((m) => clipEnd(m.clip))) - preview.time;
      const holder = makeClip({ type: "color", color: "black" }, preview.time, span);
      // Ripple once for the whole paste, on the first destination track.
      insertClip(project, made[0].track, holder, preview.time);
      made[0].track.clips = made[0].track.clips.filter((c) => c.id !== holder.id);
      for (const { clip, track } of made) overwriteClip(track, clip, clip.start);
      selectOnly(made.map((m) => m.clip.id), made[0].clip.id);
    }, "Paste insert");
    say(`Inserted the clipboard at ${tc(preview.time, project.fps)}.`);
  }

  /** Every cut point on any track, which is what the edit-jump keys use. */
  function editPoints(): number[] {
    const points = new Set<number>([0]);
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        points.add(Number(clip.start.toFixed(4)));
        points.add(Number(clipEnd(clip).toFixed(4)));
      }
    }
    return [...points].sort((a, b) => a - b);
  }

  function jumpEdit(direction: -1 | 1) {
    const points = editPoints();
    const next = direction > 0
      ? points.find((t) => t > preview.time + 0.001)
      : [...points].reverse().find((t) => t < preview.time - 0.001);
    if (next === undefined) { say("No edit that way."); return; }
    preview.seek(next);
  }

  /** Zoom so the whole timeline fits the visible width. */
  function zoomToFit() {
    const total = projectDuration(project);
    if (!total) { say("Nothing to fit."); return; }
    const width = Math.max(200, tracksWrap.clientWidth - 160);
    pxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, width / total));
    renderTracks();
    say("Zoomed to fit.");
  }

  /** Mute or unmute a clip without removing it. */
  function toggleClipEnabled() {
    const picked = editableClips();
    if (!picked.length) return;
    const hidden = picked[0].clip.motion.opacity === 0;
    edit(() => {
      for (const { clip } of picked) {
        clip.motion.opacity = hidden ? 1 : 0;
        clip.muted = !hidden;
      }
    }, hidden ? "Enable" : "Disable");
    say(hidden ? "Enabled." : "Disabled; the clips stay on the timeline.");
  }

  /** Scale the clip so it fills the frame, or put it back to its own size. */
  /** Centre the clip, or scale it so it fills the frame with no bars. The
   *  renderer fits media inside the frame, so fit is 100% and fill is the
   *  extra needed to cover the short side. */
  function fitClip(fill: boolean) {
    const picked = editableClips();
    if (!picked.length) return;
    let unknown = 0;
    edit(() => {
      for (const { clip } of picked) {
        const dims = sourceSize(clip);
        if (fill && !dims) unknown++;
        clip.motion.scale = fill && dims ? Number(fillScale(dims[0], dims[1], project.width, project.height).toFixed(2)) : 100;
        clip.motion.x = 0;
        clip.motion.y = 0;
        clip.motion.rotation = 0;
      }
    }, fill ? "Scale to fill" : "Centre");
    say(fill
      ? unknown ? "Some clips have no known frame size; add them through the bin to scale them." : "Scaled to fill the frame."
      : "Centred at its fitted size.");
  }

  /** Frame size of a clip's source, from the bin, or null when unknown. */
  function sourceSize(clip: Clip): [number, number] | null {
    if (clip.source.type !== "media" && clip.source.type !== "still") return null;
    const path = clip.source.path;
    const b = project.bin.find((x) => x.path === path);
    return b && b.width && b.height ? [b.width, b.height] : null;
  }

  function duplicateTrack(track: Track) {
    edit(() => {
      const copy: Track = {
        ...structuredClone(track),
        id: crypto.randomUUID(),
        name: `${track.name} copy`,
        clips: track.clips.map((c) => ({ ...structuredClone(c), id: crypto.randomUUID() })),
      };
      project.tracks.push(copy);
    });
    say(`Duplicated ${track.name}.`);
  }

  function renameTrack(track: Track, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    edit(() => { track.name = trimmed; });
  }

  function setTrackHeight(px: number) {
    trackHeight = Math.max(36, Math.min(200, px));
    document.documentElement.style.setProperty("--lane-h", `${trackHeight}px`);
    renderTracks();
  }

  // ---------------------------------------------------------- render queue

  /** Add the current timeline to the queue rather than rendering it now. */
  async function queueExport() {
    if (!projectDuration(project)) { say("Add a clip before queueing a render.", true); return; }
    if (!profiles.length) {
      try { profiles = await api.renderProfiles(); } catch (e) { say(String(e), true); return; }
    }
    const out = await save({
      defaultPath: `${item.title || "odyssey"}-${queue.length + 1}.${profiles[0].container}`,
      filters: [{ name: profiles[0].label, extensions: [profiles[0].container] }],
    });
    if (!out) return;
    const zone: [number, number] | null =
      project.zone_in !== null || project.zone_out !== null ? activeZone() : null;
    queue.push({
      id: crypto.randomUUID(),
      name: `${item.title || "Timeline"}${zone ? " (zone)" : ""}`,
      // A snapshot: later edits must not change a job already queued.
      project: structuredClone(project),
      profile: profiles[0],
      output: out,
      zone,
    });
    renderQueuePanel();
    say(`Queued ${queue.length} render${queue.length === 1 ? "" : "s"}.`);
  }

  async function runQueue() {
    if (!queue.length) { say("The queue is empty.", true); return; }
    if (!isTauri()) { say("Rendering needs the desktop app.", true); return; }
    queueRunBtn.disabled = true;
    say(`Rendering ${queue.length} job${queue.length === 1 ? "" : "s"}…`);
    try {
      const results = await api.runRenderQueue(queue);
      const failed = results.filter((r) => !r.ok);
      queue = queue.filter((j) => failed.some((f) => f.id === j.id));
      renderQueuePanel();
      say(failed.length
        ? `${results.length - failed.length} rendered, ${failed.length} failed: ${failed[0].detail}`
        : `All ${results.length} renders finished.`, failed.length > 0);
    } catch (e) {
      say(`The queue failed. ${String(e)}`, true);
    } finally {
      queueRunBtn.disabled = false;
    }
  }

  function renderQueuePanel() {
    queuePanel.hidden = queue.length === 0;
    queuePanel.replaceChildren();
    if (!queue.length) return;

    const head = document.createElement("h3");
    head.textContent = `Render queue · ${queue.length}`;
    const actions = document.createElement("div");
    actions.className = "vid__headctl";
    actions.append(
      queueRunBtn,
      btn("Clear", () => { queue = []; renderQueuePanel(); say("Queue cleared."); })
    );
    head.appendChild(actions);
    queuePanel.appendChild(head);

    const list = document.createElement("div");
    list.className = "vid__historylist";
    queue.forEach((job, i) => {
      const row = document.createElement("div");
      row.className = "vid__historyrow";
      row.textContent = `${i + 1}. ${job.name} → ${basename(job.output)} (${job.profile.label})`;
      list.appendChild(row);
    });
    queuePanel.appendChild(list);
  }

  // ----------------------------------------------------------- bin actions

  /** Place every visible bin item on the timeline, end to end. */
  function automateToSequence() {
    const q = binQuery.trim().toLowerCase();
    const items = project.bin.filter((b) =>
      (!binFolder || b.folder === binFolder) &&
      (!q || b.name.toLowerCase().includes(q) || b.path.toLowerCase().includes(q))
    );
    if (!items.length) { say("Nothing in this folder to place.", true); return; }
    edit(() => {
      for (const item of items) {
        placeOnTimeline(item.path, item.duration, item.width === 0);
      }
    });
    say(`Placed ${items.length} clip${items.length === 1 ? "" : "s"} end to end.`);
  }

  /** Point every clip that used one file at another, keeping all edits. */
  async function replaceFootage(item: BinItem) {
    if (!isTauri()) { say("Choosing a file needs the desktop app.", true); return; }
    const picked = await open({ multiple: false, filters: [{ name: "Media", extensions: MEDIA_EXTS }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      const info = await api.probeMedia(picked);
      const oldPath = item.path;
      let touched = 0;
      edit(() => {
        for (const track of project.tracks) {
          for (const clip of track.clips) {
            if (clip.source.type === "media" && clip.source.path === oldPath) {
              clip.source = { type: "media", path: info.path };
              // A shorter replacement cannot hold the old out point.
              if (info.duration > 0 && clip.out_point > info.duration) {
                clip.out_point = info.duration;
                clip.in_point = Math.min(clip.in_point, Math.max(0, info.duration - 0.05));
              }
              touched++;
            }
          }
        }
        item.path = info.path;
        item.name = basename(info.path);
        item.duration = info.duration;
        item.width = info.width;
        item.height = info.height;
        item.has_audio = info.has_audio;
        item.proxy = null;
      });
      renderInspector();
      say(`Relinked ${touched} clip${touched === 1 ? "" : "s"} to ${basename(info.path)}.`);
    } catch (e) {
      say(`Could not relink. ${String(e)}`, true);
    }
  }

  /** A subclip is a named range of a bin item, added as its own bin entry. */
  function makeSubclip(item: BinItem) {
    const sel = selected();
    const [inPoint, outPoint] = sel && sel.clip.source.type === "media" && sel.clip.source.path === item.path
      ? [sel.clip.in_point, sel.clip.out_point]
      : [0, Math.min(item.duration, 5)];
    if (outPoint <= inPoint) { say("That range is empty.", true); return; }
    edit(() => {
      project.bin.push({
        ...structuredClone(item),
        id: crypto.randomUUID(),
        name: `${item.name} · ${tc(inPoint, project.fps)}-${tc(outPoint, project.fps)}`,
        duration: outPoint - inPoint,
        folder: item.folder,
      });
    });
    renderInspector();
    say("Subclip added to the bin.");
  }

  // ------------------------------------------------------- timeline editing

  /** Cut every unlocked track at the playhead, not just the selected clip. */
  function razorAllTracks() {
    const t = preview.time;
    let cuts = 0;
    edit(() => {
      for (const track of project.tracks) {
        if (track.locked) continue;
        for (const clip of [...track.clips]) {
          if (t > clip.start && t < clipEnd(clip) && splitClip(track, clip, t)) cuts++;
        }
      }
    });
    say(cuts ? `Cut ${cuts} clip${cuts === 1 ? "" : "s"} at ${tc(t, project.fps)}.`
             : "Nothing under the playhead to cut.");
  }

  /** Push everything at or after the playhead later, opening a gap. */
  function insertSpace(seconds = 1) {
    const t = preview.time;
    edit(() => {
      for (const track of project.tracks) {
        if (track.locked) continue;
        for (const clip of track.clips) {
          if (clip.start >= t - 1e-6) clip.start += seconds;
        }
      }
      for (const m of project.markers) if (m.time >= t) m.time += seconds;
    });
    say(`Inserted ${tc(seconds, project.fps)} at the playhead.`);
  }

  /** Close the gap at the playhead by pulling later clips earlier. */
  function removeSpace() {
    const t = preview.time;
    // The gap runs from the playhead to the next clip start on any track.
    let next = Infinity;
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.start > t + 1e-6) next = Math.min(next, clip.start);
        // A clip already under the playhead means there is no gap here.
        if (t >= clip.start && t < clipEnd(clip)) next = -1;
      }
    }
    if (next === -1) { say("The playhead is over a clip, not a gap.", true); return; }
    if (!Number.isFinite(next)) { say("No gap to close.", true); return; }

    const gap = next - t;
    edit(() => {
      for (const track of project.tracks) {
        if (track.locked) continue;
        for (const clip of track.clips) {
          if (clip.start >= next - 1e-6) clip.start = Math.max(0, clip.start - gap);
        }
      }
      for (const m of project.markers) if (m.time >= next) m.time -= gap;
    });
    say(`Closed a ${tc(gap, project.fps)} gap.`);
  }

  /** Jump to the source frame under the playhead, as Premiere's match frame. */
  function matchFrame() {
    const sel = selected();
    if (!sel) { say("Select a clip to match a frame from.", true); return; }
    const local = Math.max(0, preview.time - sel.clip.start);
    const at = sourceTimeAt(sel.clip, local);
    const name = labelOf(sel.clip);
    say(`${name} · source ${tc(at, project.fps)} (in ${tc(sel.clip.in_point, project.fps)}, out ${tc(sel.clip.out_point, project.fps)}).`);
  }

  // ---------------------------------------------------------------- scopes

  /** Scopes read the preview canvas, so they measure what the monitor shows
   *  and inherit its approximations. That is stated in the panel itself. */
  function setScope(kind: ScopeKind | null) {
    scopeKind = kind;
    scopePanel.hidden = kind === null;
    scopeTitle.textContent = kind
      ? (SCOPE_LABELS.find(([k]) => k === kind)?.[1] ?? "") + " · from the preview"
      : "";
    for (const b of scopeButtons) {
      b.setAttribute("aria-pressed", String(b.dataset.scope === kind));
    }
    if (kind && !scopeRaf) scopeLoop();
  }

  function scopeLoop() {
    if (!scopeKind || !host.isConnected) { scopeRaf = 0; return; }
    drawScope(scopeKind, preview.canvas, scopeCanvas);
    scopeRaf = requestAnimationFrame(scopeLoop);
  }

  const scopeButtons = SCOPE_LABELS.map(([kind, label]) => {
    const b = btn(label, () => setScope(scopeKind === kind ? null : kind), "btn btn--quiet vid__tab");
    b.dataset.scope = kind;
    b.setAttribute("aria-pressed", "false");
    return b;
  });

  // ---------------------------------------------------------------- markers

  function addMarker() {
    edit(() => {
      project.markers.push({
        id: crypto.randomUUID(),
        time: preview.time,
        name: "",
        colour: "#2C5FC9",
        comment: "",
        duration: 0,
        kind: "comment",
      });
      project.markers.sort((a, b) => a.time - b.time);
    });
    say(`Marker at ${tc(preview.time, project.fps)}.`);
  }

  function jumpMarker(direction: -1 | 1) {
    const times = project.markers.map((m) => m.time).sort((a, b) => a - b);
    const next = direction > 0
      ? times.find((t) => t > preview.time + 0.001)
      : [...times].reverse().find((t) => t < preview.time - 0.001);
    if (next === undefined) { say("No marker that way."); return; }
    preview.seek(next);
  }

  function clearMarkers() {
    if (!project.markers.length) { say("There are no markers."); return; }
    const n = project.markers.length;
    edit(() => { project.markers = []; });
    say(`Removed ${n} marker${n === 1 ? "" : "s"}.`);
  }

  // ------------------------------------------------------------------ zone

  function setZoneIn() {
    edit(() => {
      project.zone_in = preview.time;
      if (project.zone_out !== null && project.zone_out <= preview.time) project.zone_out = null;
    });
    say(`Zone in at ${tc(preview.time, project.fps)}.`);
  }

  function setZoneOut() {
    edit(() => {
      project.zone_out = preview.time;
      if (project.zone_in !== null && project.zone_in >= preview.time) project.zone_in = null;
    });
    say(`Zone out at ${tc(preview.time, project.fps)}.`);
  }

  function clearZone() {
    edit(() => { project.zone_in = null; project.zone_out = null; });
    say("Zone cleared.");
  }

  /** The zone, or the whole timeline when none is set. */
  function activeZone(): [number, number] {
    const a = project.zone_in ?? 0;
    const b = project.zone_out ?? projectDuration(project);
    return a < b ? [a, b] : [0, projectDuration(project)];
  }

  // ---------------------------------------------------------- timeline edits

  /** Delete the clip and close the gap it leaves, pulling later clips left. */
  function rippleDelete() {
    if (selection.size > 1) {
      const picked = editableClips();
      if (!picked.length) return;
      // Extract each clip's span, latest first so earlier spans do not move.
      edit(() => {
        for (const { clip, track } of [...picked].reverse()) {
          const a = clip.start, b = clipEnd(clip);
          track.clips = track.clips.filter((c) => c.id !== clip.id);
          for (const c of track.clips) if (c.start >= b - 1e-6) c.start = Math.max(0, c.start - (b - a));
        }
        clearSelection();
      }, "Ripple delete");
      say(`Rippled out ${picked.length} clips.`);
      return;
    }
    const sel = editableSelection();
    if (!sel) return;
    const { clip, track } = sel;
    const gap = clipDuration(clip);
    const from = clip.start;
    const name = labelOf(clip);
    edit(() => {
      track.clips = track.clips.filter((c) => c.id !== clip.id);
      for (const c of track.clips) {
        if (c.start >= from) c.start = Math.max(0, c.start - gap);
      }
      selectedId = null;
    });
    say(`Rippled out ${name} and closed ${tc(gap, project.fps)}.`);
  }

  /** Put the clip's audio on its own track, leaving the video silent. */
  function splitAudio() {
    const sel = editableSelection();
    if (!sel) return;
    if (sel.clip.source.type !== "media") {
      say("Only media clips carry audio to split.", true);
      return;
    }
    if (sel.clip.muted) { say("That clip is already muted.", true); return; }
    edit(() => {
      const audioTrack = trackFor("audio");
      const copy: Clip = {
        ...structuredClone(sel.clip),
        id: crypto.randomUUID(),
        effects: [],
        motion: defaultMotion(),
      };
      audioTrack.clips.push(copy);
      resolveCollision(audioTrack, copy);
      sel.clip.muted = true;
      // The two halves of one recording stay linked, as Premiere links them.
      const link = crypto.randomUUID();
      sel.clip.link = link;
      copy.link = link;
    });
    say("Audio split onto its own track; the video clip is muted.");
  }

  function addAdjustmentLayer() {
    edit(() => {
      const track = trackFor("video");
      const clip = makeClip({ type: "adjustment" }, preview.time, 3);
      clip.muted = true;
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectOnly([clip.id], clip.id);
    });
    say("Adjustment layer added. Effects on it grade everything beneath.");
  }

  async function addFreezeFrame() {
    const sel = selected();
    if (!sel || sel.clip.source.type !== "media") {
      say("Select a media clip to freeze a frame from.", true);
      return;
    }
    if (!isTauri()) { say("Freezing a frame needs the desktop app.", true); return; }
    const local = Math.max(0, preview.time - sel.clip.start);
    const at = sourceTimeAt(sel.clip, local);
    try {
      const png = await api.freezeFrame(sel.clip.source.path, at);
      edit(() => {
        const track = trackFor("video");
        const clip = makeClip({ type: "still", path: png }, preview.time, prefs.holdSeconds);
        clip.muted = true;
        resolveCollision(track, clip);
        track.clips.push(clip);
        selectOnly([clip.id], clip.id);
      });
      say(`Frozen frame at ${tc(at, project.fps)}.`);
    } catch (e) {
      say(`Could not freeze that frame. ${String(e)}`, true);
    }
  }

  async function stabiliseSelected() {
    const sel = editableSelection();
    if (!sel) return;
    if (sel.clip.source.type !== "media") {
      say("Only media clips can be stabilised.", true);
      return;
    }
    if (!isTauri()) { say("Stabilisation needs the desktop app.", true); return; }
    say(`Analysing motion in ${labelOf(sel.clip)}…`);
    try {
      const trf = await api.analyseStabilisation(sel.clip.source.path);
      edit(() => {
        sel.clip.effects = sel.clip.effects.filter((e) => e.kind !== "stabilize");
        sel.clip.effects.push({ kind: "stabilize", trf, smoothing: 10, zoom: 0 });
      });
      renderInspector();
      say("Stabilised. Adjust smoothing in the effect.");
    } catch (e) {
      say(`Stabilisation failed. ${String(e)}`, true);
    }
  }

  // ---------------------------------------------------------------- proxies

  /** Build a low-resolution stand-in for every bin item.
   *
   *  Proxies are a preview-only device. The renderer is never told about them,
   *  so an export always reads the original media. */
  async function buildProxies() {
    if (!isTauri()) { say("Proxies are built by ffmpeg, so they need the desktop app.", true); return; }
    if (!project.bin.length) { say("Add media before building proxies.", true); return; }

    proxyBtn.disabled = true;
    let made = 0;
    for (const item of project.bin) {
      say(`Building proxy for ${item.name}…`);
      try {
        const proxy = await api.createProxy(item.path, PROXY_WIDTH);
        item.proxy = proxy.path;
        made += 1;
      } catch (e) {
        say(`Proxy failed for ${item.name}. ${String(e)}`, true);
      }
    }
    proxyBtn.disabled = false;
    if (made) {
      useProxies = true;
      commit();
      preview.setProxies(proxyMap());
      say(`${made} prox${made === 1 ? "y" : "ies"} ready. Preview uses them; export always uses the originals.`);
    }
    render();
  }

  function proxyMap(): Record<string, string> {
    const map: Record<string, string> = {};
    if (!useProxies) return map;
    for (const item of project.bin) {
      if (item.proxy) map[item.path] = item.proxy;
    }
    return map;
  }

  function toggleProxies() {
    useProxies = !useProxies;
    proxyToggle.setAttribute("aria-pressed", String(useProxies));
    preview.setProxies(proxyMap());
    say(useProxies ? "Preview is using proxies." : "Preview is using the original media.");
  }

  // ------------------------------------------------- timeline preview render

  /** Render the whole timeline into the preview cache so a heavy effect stack
   *  plays back as one decode instead of being composited every frame. */
  async function renderPreviewRange() {
    const end = projectDuration(project);
    if (end <= 0) { say("Add a clip before rendering a preview.", true); return; }
    if (!isTauri()) {
      say("Preview rendering runs ffmpeg, so it only works in the desktop app.", true);
      return;
    }

    previewBtn.disabled = true;
    say(`Rendering preview for ${tc(end, project.fps)}…`);
    try {
      const chunk = await api.renderTimelinePreview(project, 0, end, PREVIEW_SCALE);
      chunks = [chunk];
      preview.setChunks(chunks);
      renderTracks();
      say(`Preview rendered at ${chunk.width}×${chunk.height}. Playback uses it until you edit.`);
    } catch (e) {
      say(`Preview render failed. ${String(e)}`, true);
    } finally {
      previewBtn.disabled = false;
      render();
    }
  }

  async function clearPreviews() {
    chunks = [];
    preview.setChunks(chunks);
    renderTracks();
    if (!isTauri()) { say("Cleared. The on-disk cache only exists in the desktop app."); render(); return; }
    try {
      const n = await api.clearTimelinePreviews();
      say(n ? `Cleared ${n} cached preview${n === 1 ? "" : "s"}.` : "No cached previews.");
    } catch (e) {
      say(String(e), true);
    }
    render();
  }

  /** Drop any chunk whose range no longer matches what the timeline says.
   *  An edit outside a chunk's range leaves it valid, which is what makes
   *  preview rendering worth doing on a long timeline. */
  async function revalidateChunks() {
    if (!chunks.length || !isTauri()) return;
    const kept: PreviewChunk[] = [];
    for (const chunk of chunks) {
      try {
        const key = await api.previewKey(project, chunk.start, chunk.end, PREVIEW_SCALE);
        if (key === chunk.key) kept.push(chunk);
      } catch {
        // Cannot verify (no Tauri bridge): drop it rather than show stale video.
      }
    }
    if (kept.length !== chunks.length) {
      chunks = kept;
      preview.setChunks(chunks);
      renderTracks();
    }
  }

  // ---------------------------------------------------------------- render

  async function showCommand() {
    if (!profiles.length) {
      try { profiles = await api.renderProfiles(); } catch (e) { say(String(e), true); return; }
    }
    let args: string[];
    try {
      args = await api.projectRenderArgs(project, profiles[0], "/tmp/preview.mp4");
    } catch (e) {
      say(String(e), true);
      return;
    }

    // Its own dialog, not the sidebar: replacing the sidebar destroyed the tab
    // strip and left no way back to the bin or subtitles.
    const dialog = document.createElement("dialog");
    dialog.className = "vid__dialog";

    const h = document.createElement("h2");
    h.textContent = "Render command";
    const note = document.createElement("p");
    note.className = "vid__dialogmeta";
    note.textContent = `What an export with ${profiles[0].label} would run.`;

    const pre = document.createElement("pre");
    pre.className = "vid__cmd";
    pre.textContent = `ffmpeg ${args.join(" ")}`;

    const actions = document.createElement("div");
    actions.className = "vid__dialogactions";
    const copied = document.createElement("span");
    copied.className = "vid__dialogmeta";
    copied.setAttribute("role", "status");
    copied.setAttribute("aria-live", "polite");
    actions.append(
      copied,
      btn("Copy", () => {
        void navigator.clipboard
          .writeText(pre.textContent ?? "")
          .then(() => { copied.textContent = "Copied to the clipboard."; })
          .catch(() => { copied.textContent = "Could not reach the clipboard."; });
      }),
      btn("Close", () => dialog.close(), "btn btn--primary")
    );

    dialog.append(h, note, pre, actions);
    root.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  }

  // ------------------------------------------------------------ dialog kit

  /** A modal with a heading, an optional note, a body the caller fills, and a
   *  row of actions. The body builder gets a `close` to call when done. */
  function openDialog(
    title: string,
    note: string,
    build: (body: HTMLElement, close: () => void) => HTMLElement[],
    wide = false
  ): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = wide ? "vid__dialog vid__dialog--wide" : "vid__dialog";
    const h = document.createElement("h2");
    h.textContent = title;
    dialog.appendChild(h);
    if (note) {
      const meta = document.createElement("p");
      meta.className = "vid__dialogmeta";
      meta.textContent = note;
      dialog.appendChild(meta);
    }
    const body = document.createElement("div");
    body.className = "vid__dialogbody";
    const close = () => dialog.close();
    const actions = document.createElement("div");
    actions.className = "vid__dialogactions";
    actions.append(...build(body, close));
    dialog.append(body, actions);
    root.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
    return dialog;
  }

  /** A labelled select whose options are [value, label] pairs. */
  function selectField<T extends string>(label: string, value: T, options: Array<[T, string]>, onSet: (v: T) => void) {
    const wrap = document.createElement("label");
    wrap.className = "vid__field";
    const span = document.createElement("span");
    span.className = "vid__fieldlabel";
    span.textContent = label;
    const select = document.createElement("select");
    for (const [v, text] of options) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = text;
      opt.selected = v === value;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onSet(select.value as T));
    wrap.append(span, select);
    return wrap;
  }

  /** A time as the transport shows it, in the chosen display format. */
  function fmtTime(t: number): string {
    if (timeFormat === "frames") return `${Math.round(Math.max(0, t) * project.fps)}f`;
    if (timeFormat === "seconds") return `${Math.max(0, t).toFixed(2)}s`;
    return tc(t, project.fps);
  }

  // ------------------------------------------------------------- selection

  function selectAll() {
    selectOnly(project.tracks.flatMap((t) => t.clips.map((c) => c.id)), selectedId);
    render();
    say(`Selected ${selection.size} clip${selection.size === 1 ? "" : "s"}.`);
  }

  function deselectAll() {
    if (!selection.size) return;
    clearSelection();
    render();
  }

  /** Track Select Forward (A) and Backward (Shift+A): everything from the
   *  playhead onwards, or up to it, on every track. */
  function trackSelect(direction: 1 | -1) {
    const t = preview.time;
    const ids = project.tracks.flatMap((track) => track.clips
      .filter((c) => direction > 0 ? clipEnd(c) > t + 1e-6 : c.start < t - 1e-6)
      .map((c) => c.id));
    selectOnly(ids);
    render();
    say(ids.length
      ? `Selected ${ids.length} clip${ids.length === 1 ? "" : "s"} ${direction > 0 ? "from" : "before"} the playhead.`
      : "Nothing that way.");
  }

  function groupSelection(group: boolean) {
    const picked = editableClips();
    if (!picked.length) return;
    if (group && picked.length < 2) { say("Select two or more clips to group.", true); return; }
    const id = crypto.randomUUID();
    edit(() => { for (const { clip } of picked) clip.group = group ? id : null; }, group ? "Group" : "Ungroup");
    say(group ? `Grouped ${picked.length} clips. They now select and move together.` : "Ungrouped.");
  }

  /** Link (Ctrl+L) toggles: a selection that is all one link is unlinked,
   *  anything else becomes one linked set. */
  function toggleLink() {
    const picked = editableClips();
    if (!picked.length) return;
    const shared = picked[0].clip.link;
    const unlink = shared !== null && picked.every((x) => x.clip.link === shared);
    if (!unlink && picked.length < 2) { say("Select the video and audio to link.", true); return; }
    const id = crypto.randomUUID();
    edit(() => { for (const { clip } of picked) clip.link = unlink ? null : id; }, unlink ? "Unlink" : "Link");
    say(unlink ? "Unlinked. Each part now selects on its own." : `Linked ${picked.length} clips.`);
  }

  // ------------------------------------------------------ paste attributes

  function pasteAttributes() {
    if (!clipboard.length) { say("Copy a clip first.", true); return; }
    const targets = editableClips();
    if (!targets.length) return;
    const from = clipboard[0].clip;
    const choice = { motion: true, opacity: true, blend: true, effects: true, speed: false, audio: true };
    openDialog("Paste attributes", `From ${labelOf(from)} onto ${targets.length} clip${targets.length === 1 ? "" : "s"}.`,
      (body, close) => {
        const rows: Array<[keyof typeof choice, string]> = [
          ["motion", "Motion (position, scale, rotation, anchor)"], ["opacity", "Opacity"],
          ["blend", "Blend mode"], ["effects", "Effects"], ["speed", "Speed and time interpolation"],
          ["audio", "Audio gain and channels"],
        ];
        for (const [key, text] of rows) body.appendChild(checkField(text, choice[key], (v) => { choice[key] = v; }));
        return [
          btn("Cancel", close),
          btn("Paste", () => {
            edit(() => {
              for (const { clip } of targets) {
                if (choice.motion) {
                  const opacity = clip.motion.opacity;
                  clip.motion = { ...structuredClone(from.motion), opacity };
                }
                if (choice.opacity) clip.motion.opacity = structuredClone(from.motion.opacity);
                if (choice.blend) clip.blend = from.blend;
                if (choice.effects) clip.effects = [...clip.effects, ...structuredClone(from.effects)];
                if (choice.speed) { clip.speed = structuredClone(from.speed); clip.interpolation = from.interpolation; }
                if (choice.audio) { clip.gain = from.gain; clip.channels = [...from.channels]; }
              }
            }, "Paste attributes");
            close();
            say(`Attributes pasted onto ${targets.length} clip${targets.length === 1 ? "" : "s"}.`);
          }, "btn btn--primary"),
        ];
      });
  }

  // ------------------------------------------------------- range editing

  function zoneOrExplain(): [number, number] | null {
    if (project.zone_in === null || project.zone_out === null) {
      say("Set an in point (I) and an out point (O) first.", true);
      return null;
    }
    return [project.zone_in, project.zone_out];
  }

  /** Lift (;): remove the in-to-out span from the edit tracks, leaving a gap. */
  function liftZone() {
    const z = zoneOrExplain();
    if (!z) return;
    edit(() => { lift(project, z[0], z[1]); }, "Lift");
    say(`Lifted ${tc(z[1] - z[0], project.fps)}; the gap stays.`);
  }

  /** Extract ('): remove the span and close it up. */
  function extractZone() {
    const z = zoneOrExplain();
    if (!z) return;
    edit(() => {
      extract(project, z[0], z[1]);
      project.zone_out = null;
      project.zone_in = null;
    }, "Extract");
    preview.seek(z[0]);
    say(`Extracted ${tc(z[1] - z[0], project.fps)} and closed the gap.`);
  }

  function rippleTrimToPlayhead(side: "previous" | "next") {
    const before = JSON.stringify(saved);
    let landed: number | null = null;
    let did = false;
    if (side === "previous") {
      landed = rippleTrimPrevious(project, preview.time);
      did = landed !== null;
    } else {
      did = rippleTrimNext(project, preview.time);
    }
    if (!did) {
      saved = JSON.parse(before) as Project;
      project = resolveNested();
      say("No clip to trim at the playhead.", true);
      return;
    }
    history.push(JSON.parse(before) as Project, side === "previous" ? "Ripple trim previous" : "Ripple trim next");
    commit();
    if (landed !== null) preview.seek(landed);
    say(side === "previous" ? "Trimmed back to the playhead." : "Trimmed forward to the playhead.");
  }

  function closeAllGaps() {
    const tracks = editTracks(project);
    let closed = 0;
    edit(() => { closed = closeGaps(tracks); }, "Close gaps");
    say(closed > 1e-6 ? `Closed ${tc(closed, project.fps)} of gaps.` : "There were no gaps to close.");
  }

  // ------------------------------------------------------- speed/duration

  function speedDialog() {
    const picked = editableClips();
    if (!picked.length) return;
    const first = picked[0].clip;
    const current = staticSpeed(first);
    if (current === null) { say("That clip has a speed ramp; edit its keyframes instead.", true); return; }
    const state = {
      percent: current * 100,
      seconds: clipDuration(first),
      reverse: first.reverse,
      pitch: first.preserve_pitch,
      ripple: false,
      interpolation: first.interpolation,
    };
    openDialog("Speed / duration", `${picked.length} clip${picked.length === 1 ? "" : "s"}`, (body, close) => {
      const grid = document.createElement("div");
      grid.className = "vid__fields";
      const speedInput = numField("Speed %", state.percent, 1, 10000, 1, () => {});
      const durInput = numField("Duration (s)", state.seconds, 0.02, 99999, 0.01, () => {});
      const sIn = speedInput.querySelector("input")!;
      const dIn = durInput.querySelector("input")!;
      // The two fields drive each other, the way Premiere's chain link does.
      sIn.addEventListener("input", () => {
        state.percent = Math.max(1, Number(sIn.value) || 100);
        state.seconds = sourceDuration(first) / (state.percent / 100);
        dIn.value = state.seconds.toFixed(3);
      });
      dIn.addEventListener("input", () => {
        state.seconds = Math.max(0.02, Number(dIn.value) || 1);
        state.percent = speedForDuration(first, state.seconds) * 100;
        sIn.value = state.percent.toFixed(2);
      });
      grid.append(speedInput, durInput);
      body.append(
        grid,
        checkField("Reverse speed", state.reverse, (v) => { state.reverse = v; }),
        checkField("Maintain audio pitch", state.pitch, (v) => { state.pitch = v; }),
        checkField("Ripple edit, shifting trailing clips", state.ripple, (v) => { state.ripple = v; }),
        selectField<Interpolation>("Time interpolation", state.interpolation, [
          ["sampling", "Frame sampling"], ["blending", "Frame blending"], ["optical", "Optical flow (slow to render)"],
        ], (v) => { state.interpolation = v; }),
      );
      return [
        btn("Cancel", close),
        btn("Apply", () => {
          edit(() => {
            for (const { clip, track } of picked) {
              setClipSpeed(project, track, clip, state.percent / 100, state.ripple);
              clip.reverse = state.reverse;
              clip.preserve_pitch = state.pitch;
              clip.interpolation = state.interpolation;
              if (!state.ripple) resolveCollision(track, clip);
            }
          }, "Speed / duration");
          close();
          say(`Speed set to ${state.percent.toFixed(1)}%.`);
        }, "btn btn--primary"),
      ];
    });
  }

  /** Insert Frame Hold Segment: freeze the frame under the playhead and open
   *  room for it inside the clip, pushing the rest of the track later. */
  async function insertFrameHold() {
    const sel = editableSelection();
    if (!sel || sel.clip.source.type !== "media") { say("Select a media clip under the playhead.", true); return; }
    if (!isTauri()) { say("Freezing a frame needs the desktop app.", true); return; }
    const t = preview.time;
    if (t <= sel.clip.start || t >= clipEnd(sel.clip)) { say("Move the playhead over the clip first.", true); return; }
    const at = sourceTimeAt(sel.clip, t - sel.clip.start);
    try {
      const png = await api.freezeFrame(sel.clip.source.path, at);
      edit(() => {
        const hold = makeClip({ type: "still", path: png }, t, prefs.holdSeconds);
        hold.muted = true;
        hold.name = `${labelOf(sel.clip)} hold`;
        insertClip(project, sel.track, hold, t);
        selectOnly([hold.id], hold.id);
      }, "Insert frame hold");
      say(`Inserted a ${prefs.holdSeconds}s frame hold at ${tc(t, project.fps)}.`);
    } catch (e) {
      say(`Could not freeze that frame. ${String(e)}`, true);
    }
  }

  // ------------------------------------------------------ nest, join, sync

  function nestSelection() {
    const picked = editableClips();
    if (!picked.length) return;
    const name = `Nested sequence ${project.tracks.flatMap((t) => t.clips).filter((c) => c.source.type === "nested").length + 1}`;
    edit(() => {
      const nested = nestClips(project, picked, name);
      if (nested) selectOnly([nested.id], nested.id);
    }, "Nest");
    say(`Nested ${picked.length} clip${picked.length === 1 ? "" : "s"} into ${name}.`);
  }

  function unnestSelected() {
    const sel = editableSelection();
    if (!sel || sel.clip.source.type !== "nested") { say("Select a nested sequence clip.", true); return; }
    let placed = 0;
    edit(() => {
      const clips = breakApart(project, sel.track, sel.clip);
      placed = clips.length;
      selectOnly(clips.map((c) => c.id));
    }, "Break apart nest");
    say(`Restored ${placed} clip${placed === 1 ? "" : "s"} from the nest.`);
  }

  function joinEdits() {
    const tracks = selection.size
      ? project.tracks.filter((t) => !t.locked && t.clips.some((c) => selection.has(c.id)))
      : editTracks(project);
    let joined = 0;
    edit(() => { joined = joinThroughEdits(tracks); }, "Join through edits");
    say(joined ? `Joined ${joined} through edit${joined === 1 ? "" : "s"}.` : "No through edits to join.");
  }

  /** Synchronize by audio: move every selected clip so its sound lines up
   *  with the first one selected, by correlating their waveforms. */
  async function syncByAudio() {
    const picked = editableClips().filter((x) => x.clip.source.type === "media");
    if (picked.length < 2) { say("Select two or more media clips that share sound.", true); return; }
    if (picked.some((x) => staticSpeed(x.clip) !== 1)) { say("Sync needs clips at 100% speed.", true); return; }
    if (!isTauri()) { say("Reading audio needs the desktop app.", true); return; }
    const primary = picked.find((x) => x.clip.id === selectedId) ?? picked[0];
    const envelope = async (clip: Clip) => {
      const path = (clip.source as { path: string }).path;
      const dur = project.bin.find((b) => b.path === path)?.duration || clip.out_point;
      const buckets = Math.min(4096, Math.max(64, Math.round(dur * 100)));
      return { peaks: await api.waveform(path, buckets), rate: buckets / Math.max(0.01, dur) };
    };
    say("Comparing waveforms…");
    try {
      const ref = await envelope(primary.clip);
      const moves: Array<{ clip: Clip; start: number }> = [];
      for (const other of picked) {
        if (other === primary) continue;
        const env = await envelope(other.clip);
        // Resample the other envelope onto the reference's bucket rate.
        const scaled = Array.from({ length: Math.round(env.peaks.length * ref.rate / env.rate) },
          (_, i) => env.peaks[Math.min(env.peaks.length - 1, Math.floor(i * env.rate / ref.rate))]);
        const maxLag = Math.max(1, Math.min(60, ref.peaks.length / ref.rate));
        const lag = audioLag(ref.peaks, scaled, ref.rate, maxLag);
        // A moment at source time s in the reference is at s + lag in the other.
        const refZero = primary.clip.start - primary.clip.in_point;
        moves.push({ clip: other.clip, start: refZero - lag + other.clip.in_point });
      }
      if (moves.some((m) => m.start < 0)) {
        say("Lining those up would put a clip before the start of the timeline. Move the reference later first.", true);
        return;
      }
      edit(() => { for (const m of moves) m.clip.start = m.start; }, "Synchronize");
      say(`Synchronized ${moves.length} clip${moves.length === 1 ? "" : "s"} to ${labelOf(primary.clip)} by audio.`);
    } catch (e) {
      say(`Could not read the audio. ${String(e)}`, true);
    }
  }

  /** Scene edit detection that cuts, rather than only marking. */
  async function cutAtScenes() {
    const sel = editableSelection();
    if (!sel || sel.clip.source.type !== "media") { say("Select a media clip to cut at its scene changes.", true); return; }
    if (!isTauri()) { say("Scene detection needs the desktop app.", true); return; }
    const speed = staticSpeed(sel.clip);
    if (speed === null) { say("Scene cuts need a clip without a speed ramp.", true); return; }
    say(`Scanning ${labelOf(sel.clip)} for cuts…`);
    try {
      const cuts = await api.detectScenes(sel.clip.source.path, 0.3);
      const times = cuts
        .map((at) => sel.clip.start + (at - sel.clip.in_point) / speed)
        .filter((t) => t > sel.clip.start + 0.05 && t < clipEnd(sel.clip) - 0.05);
      if (!times.length) { say("No scene changes inside the clip."); return; }
      edit(() => {
        let piece: Clip | null = sel.clip;
        for (const t of times) {
          if (!piece) break;
          piece = splitClip(sel.track, piece, t);
        }
      }, "Scene edit detection");
      say(`Cut at ${times.length} scene change${times.length === 1 ? "" : "s"}.`);
    } catch (e) {
      say(`Scene detection failed. ${String(e)}`, true);
    }
  }

  /** Apply Default Transitions (Ctrl+D video, Ctrl+Shift+D audio). */
  function applyDefaultTransition(kind: "video" | "audio") {
    const picked = editableClips().filter((x) => x.track.kind === kind);
    if (!picked.length) { say(`Select ${kind} clips to add a ${kind === "video" ? "cross dissolve" : "crossfade"} to.`, true); return; }
    edit(() => {
      for (const { clip } of picked) {
        clip.transition_in = { kind: "dissolve", duration: prefs.transitionSeconds, curve: "qsin" };
      }
    }, kind === "video" ? "Default transition" : "Default crossfade");
    say(kind === "video"
      ? `Cross dissolve added to ${picked.length} clip${picked.length === 1 ? "" : "s"}.`
      : `Constant power crossfade added to ${picked.length} clip${picked.length === 1 ? "" : "s"}.`);
  }

  function replaceWithBinItem(item: BinItem) {
    const picked = editableClips().filter((x) => x.clip.source.type === "media" || x.clip.source.type === "still");
    if (!picked.length) { say("Select a clip on the timeline to replace.", true); return; }
    edit(() => {
      for (const { clip } of picked) {
        // Premiere keeps the clip's length and where it starts in the new
        // source, clamped to what the new source actually has.
        const len = sourceDuration(clip);
        if (isImage(item.path)) {
          clip.source = { type: "still", path: item.path };
          clip.in_point = 0;
          clip.out_point = len;
        } else {
          clip.source = { type: "media", path: item.path };
          const room = item.duration > 0 ? item.duration : clip.in_point + len;
          clip.in_point = Math.max(0, Math.min(clip.in_point, room - len));
          clip.out_point = Math.min(room, clip.in_point + len);
        }
      }
    }, "Replace with clip");
    say(`Replaced ${picked.length} clip${picked.length === 1 ? "" : "s"} with ${item.name}.`);
  }

  // ------------------------------------------------------------- playback

  const SHUTTLE = [1, 2, 4, 8];

  /** J, K and L. Each press of L or J steps the rate up in that direction. */
  function shuttleKey(key: "j" | "k" | "l") {
    if (key === "k") { preview.pause(); return; }
    const dir = key === "l" ? 1 : -1;
    const now = preview.playing ? preview.rate : 0;
    const mag = Math.abs(now);
    const same = Math.sign(now) === dir;
    const next = same ? SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(mag) + 1)] : 1;
    preview.shuttle(dir * next);
    say(`${dir > 0 ? "Forward" : "Reverse"} ${next}×${dir < 0 ? " (silent)" : ""}`);
  }

  function playInToOut() {
    const [a, b] = activeZone();
    if (b - a < 1e-3) { say("Nothing to play.", true); return; }
    preview.playRange(a, b);
  }

  /** Play Around: from a little before the playhead to a little after. */
  function playAround() {
    const t = preview.time;
    const a = Math.max(0, t - prefs.prerollSeconds);
    const b = Math.min(projectDuration(project), t + prefs.prerollSeconds);
    preview.playRange(a, b);
  }

  function goToZone(which: "in" | "out") {
    const t = which === "in" ? project.zone_in : project.zone_out;
    if (t === null) { say(`No ${which} point is set.`, true); return; }
    preview.seek(t);
  }

  /** Mark Clip (X): in and out around the clip under the playhead. */
  function markClip() {
    const sel = selected();
    const t = preview.time;
    const hit = sel && t >= sel.clip.start && t <= clipEnd(sel.clip)
      ? sel.clip
      : editTracks(project).flatMap((tr) => tr.clips).find((c) => t >= c.start && t < clipEnd(c));
    if (!hit) { say("No clip under the playhead to mark.", true); return; }
    edit(() => { project.zone_in = hit.start; project.zone_out = clipEnd(hit); }, "Mark clip");
    say(`Marked ${labelOf(hit)}.`);
  }

  function goToTimecode(input: string) {
    const t = parseTime(input, project.fps, preview.time);
    if (t === null) { say(`"${input}" is not a time. Try 00:01:02:15, 90f, 12.5 or +1:00.`, true); return; }
    preview.seek(t);
  }

  async function exportFrame() {
    if (!isTauri()) { say("Exporting a frame needs the desktop app.", true); return; }
    if (!projectDuration(project)) { say("Nothing on the timeline to export.", true); return; }
    const at = preview.time;
    const out = await save({
      defaultPath: `${item.title || "frame"}-${tc(at, project.fps).replace(/:/g, "-")}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!out) return;
    say(`Rendering the frame at ${tc(at, project.fps)}…`);
    try {
      const written = await api.exportFrame(project, at, out);
      say(`Frame exported to ${basename(written)}. It is rendered by the export engine, so it matches an export.`);
    } catch (e) {
      say(`Could not export the frame. ${String(e)}`, true);
    }
  }

  // --------------------------------------------------------------- markers

  function markerDialog(marker: Marker) {
    const draft = structuredClone(marker);
    openDialog("Marker", `At ${tc(marker.time, project.fps)}`, (body, close) => {
      body.append(
        textField("Name", draft.name, (v) => { draft.name = v; }),
        textField("Comment", draft.comment, (v) => { draft.comment = v; }),
      );
      const grid = document.createElement("div");
      grid.className = "vid__fields";
      grid.append(
        numField("In (s)", draft.time, 0, 99999, 1 / project.fps, (v) => { draft.time = Math.max(0, v); }),
        numField("Duration (s)", draft.duration, 0, 99999, 1 / project.fps, (v) => { draft.duration = Math.max(0, v); }),
      );
      body.append(
        grid,
        selectField("Type", draft.kind, [["comment", "Comment marker"], ["chapter", "Chapter marker (written into MP4, MOV and MKV)"]],
          (v) => { draft.kind = v; }),
        selectField("Colour", draft.colour, LABELS.filter(([v]) => v).map(([v, n]) => [v, n] as [string, string]),
          (v) => { draft.colour = v; }),
      );
      return [
        btn("Delete", () => {
          edit(() => { project.markers = project.markers.filter((m) => m.id !== marker.id); }, "Delete marker");
          close();
          say("Marker removed.");
        }, "btn btn--quiet vid__danger"),
        btn("Cancel", close),
        btn("OK", () => {
          edit(() => {
            const m = project.markers.find((x) => x.id === marker.id);
            if (m) Object.assign(m, draft);
            project.markers.sort((a, b) => a.time - b.time);
          }, "Edit marker");
          close();
        }, "btn btn--primary"),
      ];
    });
  }

  function renderMarkers() {
    const actions = document.createElement("div");
    actions.className = "vid__binactions";
    actions.append(
      iconBtn("map-pin", "Add a marker at the playhead (M)", addMarker, "btn", true),
      iconBtn("bookmark-simple", "Add a chapter marker at the playhead", () => {
        edit(() => {
          project.markers.push({
            id: crypto.randomUUID(), time: preview.time, name: `Chapter ${project.markers.filter((m) => m.kind === "chapter").length + 1}`,
            colour: "#62B35B", comment: "", duration: 0, kind: "chapter",
          });
          project.markers.sort((a, b) => a.time - b.time);
        }, "Add chapter marker");
      }),
    );
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search names and comments…";
    search.value = markerQuery;
    search.setAttribute("aria-label", "Search markers");
    search.addEventListener("input", () => {
      markerQuery = search.value;
      renderInspector();
      const again = sidebar.querySelector<HTMLInputElement>('input[type="search"]');
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });
    sidebar.append(actions, search);

    const q = markerQuery.trim().toLowerCase();
    const list = project.markers.filter((m) => !q || m.name.toLowerCase().includes(q) || m.comment.toLowerCase().includes(q));
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "vid__hint";
      empty.textContent = project.markers.length ? "No markers match." : "No markers yet. Press M to add one at the playhead.";
      sidebar.appendChild(empty);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "vid__bin";
    for (const m of list) {
      const row = document.createElement("div");
      row.className = "vid__binitem vid__markerrow";
      row.style.setProperty("--marker", m.colour);
      row.dataset.active = String(preview.time >= m.time && preview.time <= m.time + Math.max(m.duration, 1 / project.fps));
      const head = document.createElement("div");
      head.className = "vid__binhead";
      const name = document.createElement("span");
      name.className = "vid__binname";
      name.textContent = m.name || (m.kind === "chapter" ? "Chapter" : "Marker");
      const kind = document.createElement("span");
      kind.className = "vid__route";
      kind.textContent = m.kind;
      head.append(name, kind);
      const meta = document.createElement("p");
      meta.className = "vid__binmeta";
      meta.textContent = m.duration > 0 ? `${tc(m.time, project.fps)} – ${tc(m.time + m.duration, project.fps)}` : tc(m.time, project.fps);
      const buttons = document.createElement("div");
      buttons.className = "vid__headctl";
      buttons.append(
        iconBtn("crosshair", "Go to this marker", () => preview.seek(m.time)),
        iconBtn("pencil-simple", "Edit this marker", () => markerDialog(m)),
      );
      row.append(head, meta);
      if (m.comment) {
        const c = document.createElement("p");
        c.className = "vid__binmeta";
        c.textContent = m.comment;
        row.appendChild(c);
      }
      row.appendChild(buttons);
      wrap.appendChild(row);
    }
    sidebar.appendChild(wrap);
  }

  // ---------------------------------------------------------------- tracks

  function trackDialog(track: Track) {
    openDialog(`${track.name} settings`, track.kind === "video" ? "Video track" : "Audio track", (body, close) => {
      body.appendChild(textField("Name", track.name, (v) => renameTrack(track, v)));
      if (track.kind === "video") {
        body.append(
          numField("Track opacity (0–1)", track.opacity, 0, 1, 0.01, (v) =>
            edit(() => { track.opacity = Math.min(1, Math.max(0, v)); }, "Track opacity")),
          selectField("Track blend (used by clips set to Normal)", track.blend, BLEND_LABELS, (v) =>
            edit(() => { track.blend = v; }, "Track blend")),
        );
      } else {
        const others = project.tracks.filter((t) => t.kind === "audio" && t.id !== track.id);
        body.append(
          numField("Pan (−1 left to 1 right)", track.pan, -1, 1, 0.05, (v) =>
            edit(() => { track.pan = Math.min(1, Math.max(-1, v)); preview.refreshMix(); }, "Track pan")),
          selectField("Duck this track under", track.duck_under ?? "",
            [["", "Nothing (no ducking)"], ...others.map((t) => [t.id, t.name] as [string, string])],
            (v) => edit(() => { track.duck_under = v || null; }, "Auto-ducking")),
        );
        const grid = document.createElement("div");
        grid.className = "vid__fields";
        grid.append(
          numField("Duck threshold", track.duck_threshold, 0.001, 1, 0.005, (v) => edit(() => { track.duck_threshold = v; })),
          numField("Duck ratio", track.duck_ratio, 1, 20, 0.5, (v) => edit(() => { track.duck_ratio = v; })),
          numField("Attack (ms)", track.duck_attack, 0.01, 2000, 5, (v) => edit(() => { track.duck_attack = v; })),
          numField("Release (ms)", track.duck_release, 0.01, 9000, 10, (v) => edit(() => { track.duck_release = v; })),
        );
        const hint = document.createElement("p");
        hint.className = "vid__hint";
        hint.textContent = "Ducking lowers this track whenever the chosen track has sound, the way Essential Sound ducks music under dialogue. It is applied in the export.";
        body.append(grid, hint);
      }
      body.append(
        checkField("Sync lock: move with inserts and extracts on other tracks", track.sync_lock, (v) =>
          edit(() => { track.sync_lock = v; }, "Sync lock")),
        checkField("Target: edits and pastes land here", track.targeted, (v) =>
          edit(() => { track.targeted = v; }, "Target track")),
      );
      return [btn("Done", close, "btn btn--primary")];
    });
  }

  function removeEmptyTracks() {
    const empty = project.tracks.filter((t) => !t.clips.length && !t.locked);
    const kinds = new Set(project.tracks.filter((t) => t.clips.length).map((t) => t.kind));
    // Keep one track of each kind so there is always somewhere to drop media.
    const doomed = empty.filter((t) => kinds.has(t.kind) || empty.filter((e) => e.kind === t.kind).indexOf(t) > 0);
    if (!doomed.length) { say("There are no empty tracks to delete."); return; }
    const ids = new Set(doomed.map((t) => t.id));
    edit(() => { project.tracks = project.tracks.filter((t) => !ids.has(t.id)); }, "Delete empty tracks");
    say(`Deleted ${doomed.length} empty track${doomed.length === 1 ? "" : "s"}.`);
  }

  // ----------------------------------------------------------------- audio

  function gainDialog() {
    const picked = editableClips();
    if (!picked.length) return;
    const state = { mode: "adjust" as "set" | "adjust" | "normalize", db: 0, peak: -1 };
    openDialog("Audio gain", `${picked.length} clip${picked.length === 1 ? "" : "s"} · current ${dbLabel(picked[0].clip.gain)}`,
      (body, close) => {
        body.append(
          selectField("Operation", state.mode, [
            ["set", "Set gain to"], ["adjust", "Adjust gain by"], ["normalize", "Normalize max peak to"],
          ], (v) => { state.mode = v; }),
          numField("dB", state.db, -96, 24, 0.5, (v) => { state.db = v; state.peak = v; }),
        );
        const hint = document.createElement("p");
        hint.className = "vid__hint";
        hint.textContent = "Normalizing measures each clip's loudest sample with ffmpeg and sets the gain that brings it to the target.";
        body.appendChild(hint);
        return [
          btn("Cancel", close),
          btn("OK", async () => {
            const fromDb = (db: number) => Math.pow(10, db / 20);
            if (state.mode !== "normalize") {
              edit(() => {
                for (const { clip } of picked) {
                  clip.gain = Math.min(16, Math.max(0, state.mode === "set" ? fromDb(state.db) : clip.gain * fromDb(state.db)));
                }
              }, "Audio gain");
              close();
              say(`Gain ${state.mode === "set" ? "set to" : "adjusted by"} ${state.db} dB.`);
              return;
            }
            if (!isTauri()) { say("Measuring peaks needs the desktop app.", true); return; }
            close();
            say("Measuring peaks…");
            const gains = new Map<string, number>();
            for (const { clip } of picked) {
              if (clip.source.type !== "media") continue;
              try {
                const peak = await api.audioPeak(clip.source.path, clip.in_point, clip.out_point);
                gains.set(clip.id, Math.min(16, fromDb(state.db - peak)));
              } catch {
                /* no audio in that clip; it keeps its gain */
              }
            }
            if (!gains.size) { say("None of those clips has audio to measure.", true); return; }
            edit(() => {
              for (const { clip } of picked) {
                const g = gains.get(clip.id);
                if (g !== undefined) clip.gain = g;
              }
            }, "Normalize peak");
            say(`Normalized ${gains.size} clip${gains.size === 1 ? "" : "s"} to a ${state.db} dB peak.`);
          }, "btn btn--primary"),
        ];
      });
  }

  /** Essential Sound: tag a clip by what it is and get the treatment for it.
   *  Loudness targets follow the usual broadcast-leaning practice. */
  const AUDIO_TYPES: Array<[string, string, () => Effect[]]> = [
    ["dialogue", "Dialogue", () => [
      { kind: "highpass", frequency: 80 },
      { kind: "compressor", threshold: 0.125, ratio: 3 },
      { kind: "deesser", intensity: 0.3 },
      { kind: "loudness", target: -16 },
    ]],
    ["music", "Music", () => [{ kind: "loudness", target: -25 }]],
    ["sfx", "Sound effects", () => [{ kind: "limiter", ceiling: 0.9 }, { kind: "loudness", target: -20 }]],
    ["ambience", "Ambience", () => [{ kind: "lowpass", frequency: 12000 }, { kind: "loudness", target: -30 }]],
  ];

  /** Lumetri-style looks, built from effects the renderer already has, so each
   *  one stays editable after it is applied. */
  const LOOKS: Array<[string, () => Effect[]]> = [
    ["Teal and orange", () => [
      { kind: "colorbalance", r: 0.08, g: -0.02, b: -0.08 },
      { kind: "vibrance", intensity: 0.25 },
      { kind: "color", brightness: 0, contrast: 1.12, saturation: 1.05, gamma: 1 },
    ]],
    ["Black and white", () => [
      { kind: "monochrome" },
      { kind: "color", brightness: 0, contrast: 1.2, saturation: 1, gamma: 1 },
    ]],
    ["Vintage film", () => [
      { kind: "sepia" },
      { kind: "color", brightness: 0.03, contrast: 0.9, saturation: 1, gamma: 1 },
      { kind: "grain", strength: 12 },
      { kind: "vignette", angle: 0.5 },
    ]],
    ["Warm", () => [{ kind: "temperature", kelvin: 4800 }]],
    ["Cool", () => [{ kind: "temperature", kelvin: 8200 }]],
    ["Bleach bypass", () => [{ kind: "color", brightness: 0, contrast: 1.35, saturation: 0.45, gamma: 1 }]],
    ["Faded", () => [{ kind: "color", brightness: 0.06, contrast: 0.78, saturation: 0.75, gamma: 1 }]],
    ["Duotone", () => [{ kind: "tint", black: "#1B2A4A", white: "#F2C57C", amount: 1 }]],
  ];

  interface EffectPreset { name: string; effects: Effect[] }

  function loadPresetsLocal(): EffectPreset[] {
    const stored = readStore<{ presets: EffectPreset[] }>(PRESETS_KEY, { presets: [] });
    return Array.isArray(stored.presets) ? stored.presets : [];
  }

  function saveEffectPreset(clip: Clip) {
    if (!clip.effects.length) { say("This clip has no effects to save.", true); return; }
    let name = `${labelOf(clip)} effects`;
    openDialog("Save effect preset", `${clip.effects.length} effect${clip.effects.length === 1 ? "" : "s"}, in order.`, (body, close) => {
      body.appendChild(textField("Preset name", name, (v) => { name = v; }));
      return [
        btn("Cancel", close),
        btn("Save", () => {
          const trimmed = name.trim();
          if (!trimmed) return;
          const presets = loadPresetsLocal().filter((p) => p.name !== trimmed);
          presets.push({ name: trimmed, effects: structuredClone(clip.effects) });
          writeStore(PRESETS_KEY, { presets });
          close();
          renderInspector();
          say(`Saved the preset "${trimmed}".`);
        }, "btn btn--primary"),
      ];
    });
  }

  // ---------------------------------------------------------------- titles

  const TITLE_TEMPLATES: Array<[string, string, (text: string) => { source: Extract<Clip["source"], { type: "title" }>; seconds: number }]> = [
    ["centered", "Centered title", (text) => ({
      seconds: 4,
      source: { type: "title", text, background: "#101820", size: 110, color: "white", style: defaultTitleStyle() },
    })],
    ["lower-third", "Lower third", (text) => ({
      seconds: 5,
      source: {
        type: "title", text, background: "black", size: 54, color: "white",
        style: { ...defaultTitleStyle(), opaque: false, align: "left", valign: "lower-third", box_enabled: true, box_color: "#101820@0.75", box_padding: 22 },
      },
    })],
    ["credits", "Rolling credits", (text) => ({
      seconds: 12,
      source: {
        type: "title", text, background: "black", size: 48, color: "white",
        style: { ...defaultTitleStyle(), scroll: "roll" },
      },
    })],
    ["crawl", "News crawl", (text) => ({
      seconds: 10,
      source: {
        type: "title", text, background: "black", size: 44, color: "white",
        style: { ...defaultTitleStyle(), opaque: false, scroll: "crawl", valign: "bottom", box_enabled: true, box_color: "#8C1D18@0.9", box_padding: 14 },
      },
    })],
    ["caption", "Outlined caption", (text) => ({
      seconds: 4,
      source: {
        type: "title", text, background: "black", size: 64, color: "white",
        style: { ...defaultTitleStyle(), opaque: false, valign: "bottom", stroke_width: 4, stroke_color: "black", shadow: 3 },
      },
    })],
  ];

  function titleTemplates() {
    let text = "Your title";
    openDialog("Title templates", "Transparent templates go on a track above your footage.", (body, close) => {
      body.appendChild(textField("Text (use Enter in the inspector for more lines)", text, (v) => { text = v; }));
      const list = document.createElement("div");
      list.className = "vid__profiles";
      for (const [, label, make] of TITLE_TEMPLATES) {
        list.appendChild(btn(label, () => {
          const { source, seconds } = make(text || label);
          edit(() => {
            const clip = makeClip(source, preview.time, seconds);
            clip.effects = [{ kind: "fade", in_secs: 0.3, out_secs: 0.3 }];
            clip.name = label;
            const track = source.style.opaque ? trackFor("video") : freeVideoTrackAbove(clip.start, clip.start + seconds);
            resolveCollision(track, clip);
            track.clips.push(clip);
            selectOnly([clip.id], clip.id);
          }, "Add title template");
          close();
          say(`${label} added.`);
        }, "btn vid__profile"));
      }
      body.appendChild(list);
      return [btn("Close", close)];
    });
  }

  /** The highest video track with nothing in `[a, b)`, made if none is free,
   *  so a transparent graphic sits over the picture rather than under it. */
  function freeVideoTrackAbove(a: number, b: number): Track {
    const videos = project.tracks.filter((t) => t.kind === "video" && !t.locked);
    const free = [...videos].reverse().find((t) => !t.clips.some((c) => c.start < b && clipEnd(c) > a));
    const top = videos[videos.length - 1];
    if (free && (free === top || !top.clips.length)) return free;
    const track = newTrack(`V${videos.length + 1}`, "video");
    const lastVideo = project.tracks.lastIndexOf(top);
    project.tracks.splice(lastVideo + 1, 0, track);
    return track;
  }

  // -------------------------------------------------------------- sequence

  const SEQUENCE_PRESETS: Array<[string, number, number, number]> = [
    ["HD 1080p 30", 1920, 1080, 30], ["HD 1080p 25", 1920, 1080, 25], ["HD 1080p 24", 1920, 1080, 24],
    ["HD 1080p 60", 1920, 1080, 60], ["HD 720p 30", 1280, 720, 30], ["UHD 4K 30", 3840, 2160, 30],
    ["Vertical 9:16", 1080, 1920, 30], ["Square 1:1", 1080, 1080, 30], ["Portrait 4:5", 1080, 1350, 30],
  ];

  function sequenceSettings() {
    const draft = {
      width: project.width, height: project.height, fps: project.fps,
      sample_rate: project.sample_rate, background: project.background,
    };
    openDialog("Sequence settings", "Frame size, rate and background for the whole timeline.", (body, close) => {
      const presets = document.createElement("div");
      presets.className = "vid__presetgrid";
      const grid = document.createElement("div");
      grid.className = "vid__fields";
      const fill = () => {
        grid.replaceChildren(
          numField("Width", draft.width, 16, 8192, 2, (v) => { draft.width = Math.round(v); }),
          numField("Height", draft.height, 16, 8192, 2, (v) => { draft.height = Math.round(v); }),
          numField("Frame rate", draft.fps, 1, 240, 1, (v) => { draft.fps = Math.round(v); }),
          numField("Sample rate", draft.sample_rate, 8000, 192000, 1000, (v) => { draft.sample_rate = Math.round(v); }),
        );
      };
      for (const [label, w, h, fps] of SEQUENCE_PRESETS) {
        presets.appendChild(btn(label, () => { draft.width = w; draft.height = h; draft.fps = fps; fill(); }, "btn btn--quiet vid__tab"));
      }
      fill();
      body.append(presets, grid, textField("Background colour", draft.background, (v) => { draft.background = v; }));
      return [
        btn("Cancel", close),
        btn("Apply", () => {
          if (draft.width % 2 || draft.height % 2) { say("Width and height must be even for H.264.", true); return; }
          edit(() => { Object.assign(project, draft); }, "Sequence settings");
          preview.setProject(project);
          if (monitorZoom) setMonitorZoom(monitorZoom);
          close();
          say(`Sequence is now ${draft.width}×${draft.height} at ${draft.fps} fps.`);
        }, "btn btn--primary"),
      ];
    });
  }

  function preferencesDialog() {
    const draft = { ...prefs };
    openDialog("Preferences", "Saved on this computer for every timeline.", (body, close) => {
      const grid = document.createElement("div");
      grid.className = "vid__fields";
      grid.append(
        numField("Still image duration (s)", draft.stillSeconds, 0.1, 600, 0.5, (v) => { draft.stillSeconds = v; }),
        numField("Default transition (s)", draft.transitionSeconds, 0.05, 30, 0.05, (v) => { draft.transitionSeconds = v; }),
        numField("Frame hold length (s)", draft.holdSeconds, 0.1, 600, 0.5, (v) => { draft.holdSeconds = v; }),
        numField("Play around pre/post-roll (s)", draft.prerollSeconds, 0.5, 30, 0.5, (v) => { draft.prerollSeconds = v; }),
        numField("Auto-save every (min, 0 = off)", draft.autosaveMinutes, 0, 120, 1, (v) => { draft.autosaveMinutes = v; }),
      );
      body.appendChild(grid);
      return [
        btn("Cancel", close),
        btn("Save", () => {
          Object.assign(prefs, draft);
          writeStore(PREFS_KEY, prefs);
          scheduleAutosave();
          close();
          say("Preferences saved.");
        }, "btn btn--primary"),
      ];
    });
  }

  // --------------------------------------------------------------- autosave

  function scheduleAutosave() {
    window.clearInterval(autosaveTimer);
    autosaveTimer = 0;
    if (!isTauri() || prefs.autosaveMinutes <= 0) return;
    autosaveTimer = window.setInterval(() => void autosaveNow(), prefs.autosaveMinutes * 60_000);
  }

  async function autosaveNow() {
    const json = JSON.stringify(saved);
    // An unchanged project is not worth another snapshot pushing an older
    // one out of the retention window.
    if (json === lastAutosave || !host.isConnected) return;
    try {
      await api.autosave(saved, item.id);
      lastAutosave = json;
    } catch {
      /* a failed snapshot is retried on the next tick */
    }
  }

  async function restoreDialog() {
    if (!isTauri()) { say("Auto-save versions live on disk, so they need the desktop app.", true); return; }
    let paths: string[] = [];
    try { paths = await api.autosaves(item.id); } catch (e) { say(String(e), true); return; }
    openDialog("Auto-save versions", paths.length
      ? `Newest first. Restoring is one undoable step. Every ${prefs.autosaveMinutes || "–"} min while this timeline is open.`
      : "No auto-saves yet for this timeline.", (body, close) => {
      const list = document.createElement("div");
      list.className = "vid__profiles";
      for (const path of paths) {
        const m = basename(path).match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/);
        const when = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString() : basename(path);
        list.appendChild(btn(when, async () => {
          try {
            const restored = normalise(await api.restoreAutosave(path));
            history.push(saved, "Restore auto-save");
            saved = restored;
            nestPath = [];
            project = saved;
            clearSelection();
            commit();
            close();
            say(`Restored the auto-save from ${when}.`);
          } catch (e) {
            say(`Could not restore that version. ${String(e)}`, true);
          }
        }, "btn vid__profile"));
      }
      body.appendChild(list);
      return [
        btn("Save a version now", () => { lastAutosave = ""; void autosaveNow().then(() => { close(); say("Version saved."); }); }),
        btn("Close", close, "btn btn--primary"),
      ];
    });
  }

  // ---------------------------------------------------------------- import

  /** Probe files and add them to the bin, placing them on the timeline too
   *  when `place` is set. Shared by the dialog, OS drops and folder imports. */
  async function importPaths(paths: string[], place: boolean) {
    const infos: MediaInfo[] = [];
    for (const path of paths) {
      try {
        const info = await api.probeMedia(path);
        // ffprobe reports a still as a zero-length video; the bin keeps no
        // length for it and the timeline holds it for the preferred time.
        if (isImage(info.path)) info.duration = 0;
        infos.push(info);
      } catch (e) {
        say(`Could not read ${basename(path)}. ${String(e)}`, true);
      }
    }
    if (!infos.length) return;

    // Whether the project was untouched has to be decided BEFORE anything is
    // placed, or adding several files at once never adopts their format.
    const wasPristine = projectIsPristine();
    edit(() => {
      for (const info of infos) {
        // Media enters the bin first; the bin is the project's library and the
        // timeline is one view of it.
        if (!project.bin.some((b) => b.path === info.path)) {
          project.bin.push({
            id: crypto.randomUUID(),
            path: info.path,
            name: basename(info.path),
            duration: info.duration,
            width: info.width,
            height: info.height,
            fps: info.fps,
            has_audio: info.has_audio,
            proxy: null,
            folder: binFolder,
            label: "",
          });
        }
        if (place) placeOnTimeline(info.path, info.duration, info.width === 0);
      }
      const first = infos.find((i) => i.width > 0 && !isImage(i.path));
      if (first && wasPristine && place) {
        project.width = first.width - (first.width % 2);
        project.height = first.height - (first.height % 2);
        project.fps = Math.round(first.fps) || 30;
      }
    }, place ? "Add media" : "Import to bin");
    void loadThumbs();
    void loadWaveforms();
    say(`${place ? "Added" : "Imported"} ${infos.length} file${infos.length === 1 ? "" : "s"}.`);
  }

  // -------------------------------------------------------------- the bin

  async function refreshOffline() {
    const paths = [...new Set([
      ...project.bin.map((b) => b.path),
      ...project.tracks.flatMap((t) => t.clips).flatMap((c) =>
        c.source.type === "media" || c.source.type === "still" ? [c.source.path] : []),
    ])];
    if (!paths.length) { offline = new Set(); return; }
    try {
      const status = await api.mediaStatus(paths);
      const next = new Set(paths.filter((_, i) => !status[i]));
      const changed = next.size !== offline.size || [...next].some((p) => !offline.has(p));
      offline = next;
      if (changed) render();
    } catch {
      /* cannot check: leave the last known state */
    }
  }

  /** Link Media: every missing file, each with a way to find it. Locating one
   *  also relinks any other missing file that sits beside it under the same
   *  name, as Premiere does when a folder has moved. */
  function linkMediaDialog() {
    openDialog("Link media", offline.size
      ? `${offline.size} file${offline.size === 1 ? " is" : "s are"} offline. The export will fail until they are found.`
      : "Every file this timeline uses is where it should be.", (body, close) => {
      const list = document.createElement("div");
      list.className = "vid__bin";
      for (const path of offline) {
        const row = document.createElement("div");
        row.className = "vid__binitem";
        const name = document.createElement("span");
        name.className = "vid__binname";
        name.textContent = basename(path);
        const where = document.createElement("p");
        where.className = "vid__binmeta";
        where.textContent = path;
        row.append(name, where, btn("Locate…", () => { close(); void locateMedia(path); }));
        list.appendChild(row);
      }
      body.appendChild(list);
      return [btn("Close", close, "btn btn--primary")];
    });
  }

  async function locateMedia(missing: string) {
    if (!isTauri()) { say("Choosing a file needs the desktop app.", true); return; }
    const picked = await open({ multiple: false, filters: [{ name: basename(missing), extensions: MEDIA_EXTS }] });
    if (!picked || Array.isArray(picked)) return;
    const newDir = picked.slice(0, picked.length - basename(picked).length);
    const candidates = [...offline].filter((p) => p !== missing).map((p) => [p, newDir + basename(p)] as const);
    const found = candidates.length ? await api.mediaStatus(candidates.map(([, n]) => n)) : [];
    const moves = new Map<string, string>([[missing, picked], ...candidates.filter((_, i) => found[i])]);
    edit(() => {
      for (const [from, to] of moves) relinkPath(from, to);
    }, "Link media");
    await refreshOffline();
    say(`Relinked ${moves.size} file${moves.size === 1 ? "" : "s"}.`);
  }

  function relinkPath(from: string, to: string) {
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if ((c.source.type === "media" || c.source.type === "still") && c.source.path === from) c.source.path = to;
      }
    }
    for (const b of project.bin) {
      if (b.path === from) { b.path = to; b.name = basename(to); b.proxy = null; }
    }
  }

  async function binThumb(item: BinItem): Promise<void> {
    if (binThumbs.has(item.id)) return;
    if (isImage(item.path)) { binThumbs.set(item.id, convertSrc(item.path)); return; }
    if (!item.width || !isTauri()) return;
    binThumbs.set(item.id, "");
    try {
      const png = await api.clipThumbnail(item.path, Math.min(1, item.duration / 2));
      binThumbs.set(item.id, convertSrc(png));
      if (panel === "bin") renderInspector();
    } catch {
      /* no frame: the tile stays plain */
    }
  }

  // --------------------------------------------------------- source monitor

  /** The source monitor: play a bin item on its own, mark in and out, then
   *  insert or overwrite that range at the playhead on the target track. */
  function sourceMonitor(bin: BinItem) {
    if (isImage(bin.path)) { say("A still has no range to mark; drag it to the timeline instead.", true); return; }
    const marks = sourceMarks.get(bin.id) ?? { in: 0, out: bin.duration || 0 };
    const proxy = useProxies && bin.proxy ? bin.proxy : bin.path;
    let video: HTMLVideoElement;
    const readout = document.createElement("p");
    readout.className = "vid__dialogmeta vid__tcline";

    const update = () => {
      const now = video?.currentTime ?? 0;
      readout.textContent = `${tc(now, project.fps)}   ·   in ${tc(marks.in, project.fps)}   out ${tc(marks.out, project.fps)}   ·   ${tc(Math.max(0, marks.out - marks.in), project.fps)}`;
      sourceMarks.set(bin.id, marks);
    };

    const place = (mode: "insert" | "overwrite") => {
      if (marks.out - marks.in < 1 / project.fps) { say("Mark an in point before the out point.", true); return; }
      const audioOnly = bin.width === 0;
      edit(() => {
        const track = trackFor(audioOnly ? "audio" : "video");
        const clip = clipForPath(bin.path, bin.duration, marks.in, marks.out);
        if (mode === "insert") insertClip(project, track, clip, preview.time);
        else overwriteClip(track, clip, preview.time);
        selectOnly([clip.id], clip.id);
      }, mode === "insert" ? "Insert" : "Overwrite");
      say(`${mode === "insert" ? "Inserted" : "Overwrote with"} ${tc(marks.out - marks.in, project.fps)} of ${bin.name}.`);
    };

    const step = (d: number) => { video.pause(); video.currentTime = Math.max(0, video.currentTime + d); };

    const dialog = openDialog(bin.name, "Source monitor · Space plays, L speeds up, K stops, J steps back, I and O mark, comma inserts, period overwrites.",
      (body, close) => {
        video = document.createElement("video");
        video.className = "vid__source";
        video.src = convertSrc(proxy);
        video.preload = "auto";
        video.addEventListener("loadedmetadata", () => {
          if (!marks.out) marks.out = video.duration;
          video.currentTime = marks.in;
          update();
        });
        video.addEventListener("timeupdate", update);
        const scrub = document.createElement("input");
        scrub.type = "range";
        scrub.min = "0";
        scrub.step = "0.001";
        scrub.max = String(bin.duration || 1);
        scrub.setAttribute("aria-label", "Source position");
        scrub.addEventListener("input", () => { video.currentTime = Number(scrub.value); });
        video.addEventListener("timeupdate", () => { scrub.value = String(video.currentTime); });

        const controls = document.createElement("div");
        controls.className = "vid__headctl vid__sourcebar";
        controls.append(
          iconBtn("caret-left", "Previous frame", () => step(-1 / project.fps)),
          iconBtn("play", "Play or pause", () => { video.paused ? void video.play() : video.pause(); }),
          iconBtn("caret-right", "Next frame", () => step(1 / project.fps)),
          btn("Mark in", () => { marks.in = video.currentTime; if (marks.out <= marks.in) marks.out = bin.duration || video.duration; update(); }),
          btn("Mark out", () => { marks.out = video.currentTime; if (marks.in >= marks.out) marks.in = 0; update(); }),
        );
        body.append(video, scrub, readout, controls);

        return [
          btn("Close", () => { video.pause(); close(); }),
          btn("Insert (,)", () => place("insert")),
          btn("Overwrite (.)", () => place("overwrite"), "btn btn--primary"),
        ];
      }, true);
    dialog.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); video.paused ? void video.play() : video.pause(); }
      else if (k === "i") { e.preventDefault(); marks.in = video.currentTime; update(); }
      else if (k === "o") { e.preventDefault(); marks.out = video.currentTime; update(); }
      else if (k === "k") { video.pause(); }
      else if (k === "l") { video.playbackRate = video.paused ? 1 : Math.min(8, video.playbackRate * 2); void video.play(); }
      else if (k === "j") { video.pause(); step(-0.5); }
      else if (k === "arrowleft") { e.preventDefault(); step(-1 / project.fps); }
      else if (k === "arrowright") { e.preventDefault(); step(1 / project.fps); }
      else if (k === ",") { e.preventDefault(); place("insert"); }
      else if (k === ".") { e.preventDefault(); place("overwrite"); }
    });
    dialog.addEventListener("close", () => { video.pause(); video.removeAttribute("src"); video.load(); });
    update();
  }

  // ------------------------------------------------------------- drag drop

  const BIN_MIME = "application/x-odyssey-bin";

  /** Drop a bin item on a lane: overwrite at the drop point, or insert with
   *  Ctrl held, the way Premiere's drag works. */
  function dropOnLane(e: DragEvent, lane: HTMLElement, track: Track) {
    const id = e.dataTransfer?.getData(BIN_MIME);
    const bin = id ? project.bin.find((b) => b.id === id) : undefined;
    if (!bin) return;
    e.preventDefault();
    if (track.locked) { say(`${track.name} is locked.`, true); return; }
    const audioOnly = bin.width === 0;
    if (audioOnly && track.kind === "video") { say("That file has no picture; drop it on an audio track.", true); return; }
    const rect = lane.getBoundingClientRect();
    const at = snap(Math.max(0, (e.clientX - rect.left) / pxPerSec), null);
    const marks = sourceMarks.get(bin.id);
    edit(() => {
      const clip = clipForPath(bin.path, bin.duration, marks?.in ?? 0, marks?.out);
      if (e.ctrlKey || e.metaKey) insertClip(project, track, clip, at);
      else overwriteClip(track, clip, at);
      selectOnly([clip.id], clip.id);
    }, e.ctrlKey || e.metaKey ? "Insert" : "Overwrite");
    void loadThumbs();
    void loadWaveforms();
    say(`${e.ctrlKey || e.metaKey ? "Inserted" : "Placed"} ${bin.name} at ${tc(at, project.fps)} on ${track.name}.`);
  }

  async function listenForFileDrops() {
    if (!isTauri()) return;
    try {
      unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop" || !host.isConnected) return;
        const paths = event.payload.paths.filter((p) => MEDIA_EXTS.includes((p.split(".").pop() ?? "").toLowerCase()));
        if (!paths.length) { say("None of those files is media Odyssey can use.", true); return; }
        void importPaths(paths, panel !== "bin");
      });
    } catch {
      /* drag and drop from the desktop is unavailable; the Add button remains */
    }
  }

  // ---------------------------------------------------------------- export

  async function openRenderDialog() {
    if (!projectDuration(project)) { say("Add a clip before exporting.", true); return; }
    if (!profiles.length) {
      try { profiles = await api.renderProfiles(); } catch (e) { say(String(e), true); return; }
    }
    let saved: RenderProfile[] = [];
    let hardware: RenderProfile[] = [];
    if (isTauri()) {
      [saved, hardware] = await Promise.all([
        api.loadPresets().catch(() => [] as RenderProfile[]),
        api.hardwareProfiles().catch(() => [] as RenderProfile[]),
      ]);
    }
    const all = [...saved, ...profiles, ...hardware];
    let chosen: RenderProfile = structuredClone(all.find((p) => !saved.includes(p)) ?? all[0]);
    const hasZone = project.zone_in !== null || project.zone_out !== null;
    let range: "all" | "zone" = hasZone ? "zone" : "all";
    const chapters = project.markers.filter((m) => m.kind === "chapter").length;

    openDialog("Export", `${tc(projectDuration(project), project.fps)} · ${project.width}×${project.height} · ${project.fps} fps`,
      (body, close) => {
        const settings = document.createElement("div");
        const drawSettings = () => {
          settings.replaceChildren();
          const video = chosen.video_codec !== "none";
          const grid = document.createElement("div");
          grid.className = "vid__fields";
          if (video) {
            grid.append(
              numField("Quality (CRF, lower is better)", chosen.crf ?? 0, 0, 63, 1, (v) => {
                chosen.crf = v > 0 ? Math.round(v) : null;
                if (v > 0) chosen.video_bitrate = null;
              }),
              textField("Video bitrate (e.g. 12M, blank for CRF)", chosen.video_bitrate ?? "", (v) => {
                chosen.video_bitrate = /^\d+(\.\d+)?[kKmM]?$/.test(v.trim()) ? v.trim() : null;
              }),
              textField("Encoder preset", chosen.preset, (v) => { chosen.preset = v.trim() || "medium"; }),
            );
          }
          grid.append(textField("Audio bitrate", chosen.audio_bitrate, (v) => { chosen.audio_bitrate = v.trim() || "192k"; }));
          settings.appendChild(grid);
          if (video) {
            settings.append(
              selectField("Output size", String(chosen.height ?? 0), [
                ["0", `Match sequence (${project.height}p)`], ["2160", "2160p"], ["1440", "1440p"], ["1080", "1080p"],
                ["720", "720p"], ["540", "540p"], ["480", "480p"], ["360", "360p"],
              ], (v) => { chosen.height = Number(v) || null; }),
              checkField("Burn in timecode", chosen.timecode, (v) => { chosen.timecode = v; }),
            );
          }
          settings.appendChild(selectField("Loudness normalization", String(chosen.loudnorm ?? ""), [
            ["", "Off"], ["-14", "-14 LUFS (streaming)"], ["-16", "-16 LUFS (podcast, web)"],
            ["-23", "-23 LUFS (EBU R128 broadcast)"], ["-24", "-24 LUFS (ATSC A/85)"],
          ], (v) => { chosen.loudnorm = v ? Number(v) : null; }));
        };

        const list = document.createElement("div");
        list.className = "vid__profiles vid__profiles--scroll";
        all.forEach((p, i) => {
          const label = document.createElement("label");
          label.className = "vid__profile";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "profile";
          radio.checked = p.id === chosen.id;
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            chosen = structuredClone(p);
            chosen.height ??= null;
            chosen.loudnorm ??= null;
            chosen.timecode ??= false;
            drawSettings();
          });
          const text = document.createElement("span");
          text.textContent = saved.includes(p) ? `★ ${p.label}` : hardware.includes(p) ? `${p.label}` : p.label;
          label.append(radio, text);
          if (saved.includes(p)) {
            label.appendChild(iconBtn("trash", `Delete the preset ${p.label}`, async () => {
              try {
                await api.deletePreset(p.id);
                close();
                say(`Deleted the preset ${p.label}.`);
                void openRenderDialog();
              } catch (err) {
                say(String(err), true);
              }
            }));
          }
          label.dataset.index = String(i);
          list.appendChild(label);
        });

        body.append(
          list,
          selectField("Range", range, hasZone
            ? [["all", "Entire sequence"], ["zone", "In to out"]]
            : [["all", "Entire sequence"]], (v) => { range = v; }),
        );
        if (chapters) {
          const note = document.createElement("p");
          note.className = "vid__hint";
          note.textContent = `${chapters} chapter marker${chapters === 1 ? "" : "s"} will be written into MP4, MOV and MKV files.`;
          body.appendChild(note);
        }
        drawSettings();
        body.appendChild(settings);

        const go = btn("Export…", async () => {
          const out = await save({
            defaultPath: `${item.title || "odyssey"}.${chosen.container}`,
            filters: [{ name: chosen.label, extensions: [chosen.container] }],
          });
          if (!out) return;
          close();
          const zone = range === "zone" ? activeZone() : null;
          say(`Rendering ${tc(zone ? zone[1] - zone[0] : projectDuration(project), project.fps)}…`);
          try {
            // One queued job, because the queue flattens nested sequences
            // and honours a zone; a direct render does neither.
            const [result] = await api.runRenderQueue([{
              id: crypto.randomUUID(), name: item.title || "Timeline", project: structuredClone(project),
              profile: chosen, output: out, zone,
            }]);
            if (!result.ok) throw new Error(result.detail);
            say(`Exported to ${basename(result.output)} in ${result.seconds.toFixed(1)}s.`);
          } catch (e) {
            say(`Export failed. ${String(e)}`, true);
          }
        }, "btn btn--primary");

        return [
          btn("Save as preset…", () => {
            let name = `${chosen.label} (custom)`;
            openDialog("Save export preset", "Presets appear at the top of the export list.", (b2, close2) => {
              b2.appendChild(textField("Name", name, (v) => { name = v; }));
              return [
                btn("Cancel", close2),
                btn("Save", async () => {
                  try {
                    await api.savePreset({ ...chosen, id: `preset-${crypto.randomUUID()}`, label: name.trim() || chosen.label });
                    close2();
                    close();
                    say(`Saved the export preset ${name}.`);
                    void openRenderDialog();
                  } catch (err) {
                    say(String(err), true);
                  }
                }, "btn btn--primary"),
              ];
            });
          }),
          btn("Cancel", close),
          go,
        ];
      }, true);
  }

  // ------------------------------------------------- direct manipulation

  /** Drag the picture in the program monitor to move the selected clip, and
   *  scroll over it to scale, as Premiere's Motion handles allow. Animated
   *  parameters get a keyframe at the playhead instead of losing their curve. */
  function attachMonitorControls() {
    const canvas = preview.canvas;
    const setParam = (key: "x" | "y" | "scale", value: number, clip: Clip) => {
      const local = Math.max(0, Math.min(preview.time - clip.start, clipDuration(clip)));
      clip.motion[key] = isAnimated(clip.motion[key]) ? setKeyframe(clip.motion[key], local, value) : value;
    };
    const target = () => {
      const sel = selected();
      if (!sel || sel.track.locked || sel.track.kind !== "video" || sel.clip.source.type === "adjustment") return null;
      const t = preview.time;
      return t >= sel.clip.start && t < clipEnd(sel.clip) ? sel : null;
    };
    // In multicam view a click on an angle cuts to it, and nothing else.
    canvas.addEventListener("pointerdown", (e) => {
      if (!multicamView) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const angle = preview.angleAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      if (angle >= 0) cutToAngle(angle);
    });
    canvas.addEventListener("pointerdown", (e) => {
      const sel = target();
      if (!sel) return;
      e.preventDefault();
      const clip = sel.clip;
      const local = Math.max(0, preview.time - clip.start);
      const origin = { x: paramAt(clip.motion.x, local), y: paramAt(clip.motion.y, local) };
      const before = JSON.stringify(saved);
      const start = { x: e.clientX, y: e.clientY };
      // Screen pixels to project pixels, through whatever size the canvas is shown at.
      const ratio = project.width / Math.max(1, canvas.getBoundingClientRect().width);
      let moved = false;
      canvas.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) * ratio;
        const dy = (ev.clientY - start.y) * ratio;
        if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
        // Shift constrains to the axis moved furthest.
        const lockX = ev.shiftKey && Math.abs(dy) > Math.abs(dx);
        const lockY = ev.shiftKey && !lockX;
        setParam("x", Math.round(origin.x + (lockX ? 0 : dx)), clip);
        setParam("y", Math.round(origin.y + (lockY ? 0 : dy)), clip);
        preview.setProject(project);
      };
      const up = () => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        if (!moved) return;
        history.push(JSON.parse(before) as Project, "Move in monitor");
        commit();
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
    });
    let wheelBefore: string | null = null;
    let wheelTimer = 0;
    canvas.addEventListener("wheel", (e) => {
      const sel = target();
      if (!sel) return;
      e.preventDefault();
      const clip = sel.clip;
      const local = Math.max(0, preview.time - clip.start);
      wheelBefore ??= JSON.stringify(saved);
      const factor = e.deltaY < 0 ? 1.03 : 1 / 1.03;
      setParam("scale", Math.min(800, Math.max(1, Number((paramAt(clip.motion.scale, local) * factor).toFixed(2)))), clip);
      preview.setProject(project);
      // A burst of wheel ticks is one undo step.
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        if (wheelBefore) history.push(JSON.parse(wheelBefore) as Project, "Scale in monitor");
        wheelBefore = null;
        commit();
      }, 300);
    }, { passive: false });
  }

  function setMonitorZoom(z: number) {
    monitorZoom = z;
    monitor.dataset.zoom = z ? "fixed" : "fit";
    const canvas = preview.canvas;
    if (!z) {
      canvas.style.width = "";
      canvas.style.height = "";
    } else {
      canvas.style.width = `${Math.round(project.width * z)}px`;
      canvas.style.height = `${Math.round(project.height * z)}px`;
    }
    say(z ? `Monitor at ${Math.round(z * 100)}%.` : "Monitor fits the panel.");
  }

  // ---------------------------------------------------------------- toolbar

  const guidesBtn = iconBtn("grid-four", "Safe margins and grid", () => toggleGuides());
  guidesBtn.setAttribute("aria-pressed", "false");
  const compareBtn = iconBtn("columns", "Compare with effects bypassed", () => toggleCompare());
  const multicamBtn = iconBtn("squares-four", "Multicam view: every angle, cut with 1–9", () => toggleMulticamView(), "btn", true);
  multicamBtn.setAttribute("aria-pressed", "false");
  compareBtn.setAttribute("aria-pressed", "false");
  const queueRunBtn = iconBtn("play", "Render the queue", () => void runQueue(), "btn btn--primary", true);
  const historyBtn = iconBtn("clock-counter-clockwise", "Undo history", () => toggleHistory(), "btn", true);
  historyBtn.setAttribute("aria-pressed", "false");
  const snapBtn = iconBtn("magnet", "Snapping", () => {
    snapping = !snapping;
    snapBtn.setAttribute("aria-pressed", String(snapping));
    say(snapping ? "Snapping on." : "Snapping off.");
  });
  snapBtn.setAttribute("aria-pressed", "true");
  const proxyBtn = iconBtn("stack-simple", "Build proxies", () => void buildProxies(), "btn", true);
  const proxyToggle = iconBtn("arrows-left-right", "Use proxies in the preview", () => toggleProxies());
  proxyToggle.setAttribute("aria-pressed", "false");
  const previewBtn = iconBtn("lightning", "Render timeline preview", () => void renderPreviewRange(), "btn", true);
  const mixerBtn = iconBtn("faders", "Audio mixer", () => toggleMixer(), "btn", true);
  mixerBtn.setAttribute("aria-pressed", "false");
  const undoBtn = iconBtn("arrow-counter-clockwise", "Undo (Ctrl+Z)", undo);
  const redoBtn = iconBtn("arrow-clockwise", "Redo (Ctrl+Shift+Z)", redo);

  toolbar.append(
    iconBtn("plus", "Add media", () => void addMedia(), "btn btn--primary", true),
    iconBtn("text-t", "Add title card", addTitle),
    iconBtn("text-aa", "Title templates: lower third, credits, crawl", titleTemplates),
    iconBtn("palette", "Add colour card", addColor),
    iconBtn("television-simple", "Add bars and tone", addBars),
    sep(),
    iconBtn("scissors", "Add edit to selected clips (S, Ctrl+K)", splitAtPlayhead),
    iconBtn("copy", "Duplicate clip", duplicateSelected),
    iconBtn("trash", "Delete clip (Del)", deleteSelected),
    iconBtn("arrows-in-line-horizontal", "Ripple delete, closing the gap", rippleDelete),
    iconBtn("scissors", "Razor every track at the playhead", razorAllTracks),
    iconBtn("arrows-out-line-horizontal", "Insert a second of space", () => insertSpace(1)),
    iconBtn("arrows-in-simple", "Close the gap at the playhead", removeSpace),
    iconBtn("crosshair", "Match frame", matchFrame),
    iconBtn("waveform-slash", "Split audio onto its own track", splitAudio),
    iconBtn("arrow-line-up", "Lift in to out, leaving a gap (;)", liftZone),
    iconBtn("arrow-line-down", "Extract in to out, closing the gap (')", extractZone),
    iconBtn("arrows-merge", "Close gaps on the edit tracks", closeAllGaps),
    iconBtn("link-simple-break", "Join through edits", joinEdits),
    iconBtn("gauge", "Speed / duration (Ctrl+R)", speedDialog),
    iconBtn("pause", "Insert frame hold segment", () => void insertFrameHold()),
    iconBtn("waves", "Synchronize selected clips by audio", () => void syncByAudio()),
    iconBtn("film-slate", "Cut at scene changes in the selected clip", () => void cutAtScenes()),
    iconBtn("stack", "Nest the selected clips", nestSelection),
    sep(),
    iconBtn("stack-plus", "Add an adjustment layer", addAdjustmentLayer),
    iconBtn("snowflake", "Freeze the current frame", () => void addFreezeFrame()),
    iconBtn("crosshair-simple", "Stabilise the selected clip", () => void stabiliseSelected()),
    sep(),
    iconBtn("map-pin", "Add a marker (M). Double-click a marker to remove it", addMarker),
    iconBtn("brackets-square", "Clear the zone and all markers", () => { clearZone(); clearMarkers(); }),
    iconBtn("caret-double-left", "Previous marker", () => jumpMarker(-1)),
    iconBtn("caret-double-right", "Next marker", () => jumpMarker(1)),
    iconBtn("arrow-line-left", "Set zone in (I)", setZoneIn),
    iconBtn("arrow-line-right", "Set zone out (O)", setZoneOut),
    snapBtn,
    historyBtn,
    sep(),
    undoBtn, redoBtn,
    sep(),
    iconBtn("film-strip", "Add video track", () => edit(() => {
      project.tracks.push(newTrack(`V${project.tracks.filter(t => t.kind === "video").length + 1}`, "video"));
    })),
    iconBtn("waveform", "Add audio track", () => edit(() => {
      project.tracks.push(newTrack(`A${project.tracks.filter(t => t.kind === "audio").length + 1}`, "audio"));
    })),
    sep(),
    mixerBtn,
    sep(),
    previewBtn,
    iconBtn("eraser", "Clear rendered previews", () => void clearPreviews()),
    sep(),
    iconBtn("export", "Export", () => void openRenderDialog(), "btn btn--primary", true),
    iconBtn("list-plus", "Add this render to the queue", () => void queueExport()),
    iconBtn("sliders-horizontal", "Show the ffmpeg command", () => void showCommand()),
    iconBtn("camera", "Export the frame at the playhead (Ctrl+Shift+E)", () => void exportFrame()),
    iconBtn("file-arrow-down", "Export an EDL", () => void exportInterchange("edl")),
    iconBtn("tree-structure", "Export OpenTimelineIO", () => void exportInterchange("otio")),
    iconBtn("scan", "Detect cuts in the selected clip", () => void detectScenes()),
    iconBtn("frame-corners", "Nest this track into one clip", nestSelectedTrack),
    iconBtn("arrows-out", "Zoom to fit (F)", zoomToFit),
    iconBtn("layout", "Workspaces", showWorkspaces),
    sep(),
    iconBtn("monitor", "Sequence settings", sequenceSettings),
    iconBtn("link", "Link media: find offline files", () => { void refreshOffline().then(linkMediaDialog); }),
    iconBtn("clock-clockwise", "Auto-save versions", () => void restoreDialog()),
    iconBtn("rows-plus-bottom", "Delete empty tracks", removeEmptyTracks),
    iconBtn("gear-six", "Preferences", preferencesDialog),
    iconBtn("keyboard", "Keyboard and mouse", showShortcuts)
  );

  // -------------------------------------------------------------- transport

  const playBtn = iconBtn("play", "Play or pause (Space)", () => preview.toggle(), "btn btn--primary");
  // The readout doubles as Go to Timecode: click it and type a time.
  const timecode = document.createElement("span");
  timecode.className = "vid__tc";
  timecode.setAttribute("aria-live", "off");
  timecode.tabIndex = 0;
  timecode.setAttribute("role", "button");
  timecode.title = "Click to type a time: 00:01:02:15, 90f, 12.5, or +1:00 to move relative";
  const editTimecode = () => {
    const input = document.createElement("input");
    input.className = "vid__tcinput";
    input.value = tc(preview.time, project.fps);
    input.setAttribute("aria-label", "Go to time");
    const done = (go: boolean) => {
      if (go) goToTimecode(input.value);
      input.replaceWith(timecode);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => { if (input.isConnected) done(false); });
    timecode.replaceWith(input);
    input.focus();
    input.select();
  };
  timecode.addEventListener("click", editTimecode);
  timecode.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); editTimecode(); } });

  const formatSelect = document.createElement("select");
  formatSelect.className = "vid__fxadd";
  formatSelect.setAttribute("aria-label", "Time display");
  for (const [value, label] of [["timecode", "Timecode"], ["frames", "Frames"], ["seconds", "Seconds"]] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    formatSelect.appendChild(opt);
  }
  formatSelect.addEventListener("change", () => {
    timeFormat = formatSelect.value as TimeFormat;
    preview.onTick(preview.time);
    renderTracks();
  });

  const zoomSelect = document.createElement("select");
  zoomSelect.className = "vid__fxadd";
  zoomSelect.setAttribute("aria-label", "Monitor zoom");
  for (const [value, label] of [["0", "Fit"], ["0.25", "25%"], ["0.5", "50%"], ["1", "100%"], ["2", "200%"]] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    zoomSelect.appendChild(opt);
  }
  zoomSelect.addEventListener("change", () => setMonitorZoom(Number(zoomSelect.value)));

  const loopBtn = iconBtn("repeat", "Loop playback", () => {
    preview.loop = !preview.loop;
    loopBtn.setAttribute("aria-pressed", String(preview.loop));
    say(preview.loop ? "Loop on." : "Loop off.");
  });
  loopBtn.setAttribute("aria-pressed", "false");
  const scrubBtn = iconBtn("ear", "Audio while scrubbing", () => {
    audioScrub = !audioScrub;
    scrubBtn.setAttribute("aria-pressed", String(audioScrub));
    say(audioScrub ? "Scrubbing plays sound." : "Scrubbing is silent.");
  });
  scrubBtn.setAttribute("aria-pressed", "true");

  const heightSelect = document.createElement("select");
  heightSelect.className = "vid__fxadd";
  heightSelect.setAttribute("aria-label", "Track height");
  for (const [value, label] of [["44", "Short"], ["66", "Normal"], ["104", "Tall"]] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === "66";
    heightSelect.appendChild(opt);
  }
  heightSelect.addEventListener("change", () => setTrackHeight(Number(heightSelect.value)));

  const resSelect = document.createElement("select");
  resSelect.className = "vid__fxadd";
  resSelect.setAttribute("aria-label", "Playback resolution");
  for (const [value, label] of [["1", "Full"], ["0.5", "1/2"], ["0.25", "1/4"]] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    resSelect.appendChild(opt);
  }
  resSelect.addEventListener("change", () => {
    previewScale = Number(resSelect.value);
    preview.setResolution(previewScale);
    say(previewScale === 1 ? "Playback at full resolution."
                           : `Playback at ${resSelect.selectedOptions[0].textContent} resolution.`);
  });

  const zoomOut = iconBtn("magnifying-glass-minus", "Zoom out",
    () => { pxPerSec = Math.max(MIN_PX_PER_SEC, pxPerSec / 1.5); renderTracks(); });
  const zoomIn = iconBtn("magnifying-glass-plus", "Zoom in",
    () => { pxPerSec = Math.min(MAX_PX_PER_SEC, pxPerSec * 1.5); renderTracks(); });

  transport.append(
    iconBtn("skip-back", "Go to start", () => preview.seek(0)),
    iconBtn("caret-left", "Previous frame", () => preview.seek(preview.time - 1 / project.fps)),
    playBtn,
    iconBtn("caret-right", "Next frame", () => preview.seek(preview.time + 1 / project.fps)),
    iconBtn("skip-forward", "Go to end", () => preview.seek(projectDuration(project))),
    iconBtn("brackets-curly", "Play in to out (Ctrl+Shift+Space)", playInToOut),
    iconBtn("arrows-horizontal", "Play around the playhead (Shift+K)", playAround),
    loopBtn,
    timecode,
    formatSelect,
    heightSelect,
    resSelect,
    zoomSelect,
    scrubBtn,
    guidesBtn,
    compareBtn,
    multicamBtn,
    ...scopeButtons,
    zoomOut, zoomIn
  );

  preview.onTick = (t) => {
    timecode.textContent = `${fmtTime(t)} / ${fmtTime(projectDuration(project))}`;
    // Page the timeline along with playback, as Premiere's auto-scroll does.
    if (preview.playing && scrollerEl) {
      const x = t * pxPerSec;
      const view = scrollerEl.clientWidth - 160;
      if (x < scrollerEl.scrollLeft || x > scrollerEl.scrollLeft + view) {
        scrollerEl.scrollLeft = Math.max(0, x - 40);
      }
    }
    monitor.dataset.rendered = String(preview.usingRendered);
    const glyph = playBtn.querySelector("i");
    if (glyph) glyph.className = preview.playing ? "ph ph-pause" : "ph ph-play";
    playBtn.setAttribute("aria-label", preview.playing ? "Pause (Space)" : "Play (Space)");
    positionPlayhead();
  };
  preview.exactFrame = isTauri() ? (p, t) => api.previewFrame(p, t) : null;
  preview.onExactError = (detail) => say(`Could not render the exact frame: ${detail}`, true);
  preview.onMode = (mode, missing, pending) => {
    monitor.dataset.mode = mode;
    monitor.dataset.rendered = String(mode === "rendered");
    const named = missing.slice(0, 3).join(", ") + (missing.length > 3 ? ` +${missing.length - 3}` : "");
    let text = "";
    let title = "";
    if (mode === "rendered") {
      text = "Rendered preview";
      title = "Playing a rendered span of the timeline, not a live composite.";
    } else if (mode === "exact") {
      text = "Exact frame";
      title = `Rendered by ffmpeg, as the export will be, because the live preview cannot show: ${missing.join(", ")}.`;
    } else if (missing.length) {
      text = pending ? "Rendering exact frame…" : `Not shown live: ${named}`;
      title = `The live preview leaves out ${missing.join(", ")}. Pause to see the exact frame, or render a preview span to play it.`;
    }
    monitorStatus.hidden = !text;
    monitorStatus.textContent = text;
    monitorStatus.title = title;
  };
  preview.onSourceError = (path, detail) => {
    say(`Could not load ${path ? basename(path) : "a clip"}: ${detail}`, true);
  };
  preview.onEnded = () => {
    const glyph = playBtn.querySelector("i");
    if (glyph) glyph.className = "ph ph-play";
  };

  // ------------------------------------------------------------ playhead UI

  const playhead = document.createElement("div");
  playhead.className = "vid__playhead";
  playhead.setAttribute("aria-hidden", "true");

  function positionPlayhead() {
    playhead.style.transform = `translateX(${preview.time * pxPerSec}px)`;
  }

  // ---------------------------------------------------------------- tracks

  function renderTracks() {
    rebuilding = true;
    tracksWrap.replaceChildren();
    const dur = Math.max(projectDuration(project), 10);
    const width = dur * pxPerSec;

    // Ruler
    const ruler = document.createElement("div");
    ruler.className = "vid__ruler";
    ruler.style.width = `${width}px`;
    ruler.setAttribute("role", "slider");
    ruler.setAttribute("aria-label", "Playhead position");
    ruler.setAttribute("aria-valuemin", "0");
    ruler.setAttribute("aria-valuemax", dur.toFixed(2));
    ruler.setAttribute("aria-valuenow", preview.time.toFixed(2));
    ruler.tabIndex = 0;

    const step = tickStep(pxPerSec);
    for (let t = 0; t <= dur; t += step) {
      const tick = document.createElement("span");
      tick.className = "vid__tick";
      tick.style.transform = `translateX(${t * pxPerSec}px)`;
      tick.textContent = timeFormat === "timecode" ? tc(t, project.fps).replace(/:\d\d$/, "") : fmtTime(t);
      ruler.appendChild(tick);
    }

    // The zone is shaded so the work area is obvious at a glance.
    if (project.zone_in !== null || project.zone_out !== null) {
      const [za, zb] = activeZone();
      const band = document.createElement("span");
      band.className = "vid__zone";
      band.style.transform = `translateX(${za * pxPerSec}px)`;
      band.style.width = `${Math.max(2, (zb - za) * pxPerSec)}px`;
      band.title = `Zone ${tc(za, project.fps)} to ${tc(zb, project.fps)}`;
      band.setAttribute("aria-hidden", "true");
      ruler.appendChild(band);
    }

    // Markers sit on the ruler and can be clicked to jump.
    for (const marker of project.markers) {
      if (marker.duration > 0) {
        const span = document.createElement("span");
        span.className = "vid__markerspan";
        span.style.transform = `translateX(${marker.time * pxPerSec}px)`;
        span.style.width = `${Math.max(2, marker.duration * pxPerSec)}px`;
        span.style.setProperty("--marker", marker.colour);
        span.setAttribute("aria-hidden", "true");
        ruler.appendChild(span);
      }
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "vid__marker";
      pin.dataset.kind = marker.kind;
      pin.style.transform = `translateX(${marker.time * pxPerSec}px)`;
      pin.style.setProperty("--marker", marker.colour);
      pin.title = `${marker.name || (marker.kind === "chapter" ? "Chapter" : "Marker")} at ${tc(marker.time, project.fps)}` +
        `${marker.comment ? ` · ${marker.comment}` : ""}. Double-click to edit`;
      pin.setAttribute("aria-label", pin.title);
      pin.addEventListener("pointerdown", (e) => e.stopPropagation());
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        preview.seek(marker.time);
      });
      pin.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        markerDialog(marker);
      });
      ruler.appendChild(pin);
    }

    // A bar under the ruler marks which spans are rendered.
    for (const chunk of chunks) {
      const bar = document.createElement("span");
      bar.className = "vid__rendered";
      bar.style.transform = `translateX(${chunk.start * pxPerSec}px)`;
      bar.style.width = `${Math.max(2, (chunk.end - chunk.start) * pxPerSec)}px`;
      bar.title = `Rendered ${tc(chunk.start, project.fps)} to ${tc(chunk.end, project.fps)}`;
      bar.setAttribute("aria-hidden", "true");
      ruler.appendChild(bar);
    }

    let lastScrubSound = 0;
    const scrub = (e: PointerEvent) => {
      const rect = ruler.getBoundingClientRect();
      preview.seek((e.clientX - rect.left) / pxPerSec);
      const now = performance.now();
      if (audioScrub && now - lastScrubSound > 70) {
        lastScrubSound = now;
        preview.scrubAudio();
      }
    };
    ruler.addEventListener("pointerdown", (e) => {
      // Seek first: pointer capture is an enhancement, and if it throws the
      // scrub must still happen.
      scrub(e);
      try {
        ruler.setPointerCapture(e.pointerId);
      } catch {
        /* capture is unavailable for this pointer; dragging still works */
      }
      const move = (ev: PointerEvent) => scrub(ev);
      const up = () => {
        ruler.removeEventListener("pointermove", move);
        ruler.removeEventListener("pointerup", up);
      };
      ruler.addEventListener("pointermove", move);
      ruler.addEventListener("pointerup", up);
    });
    ruler.addEventListener("keydown", (e) => {
      const frame = 1 / project.fps;
      if (e.key === "ArrowRight") { e.preventDefault(); preview.seek(preview.time + (e.shiftKey ? 1 : frame)); }
      if (e.key === "ArrowLeft") { e.preventDefault(); preview.seek(preview.time - (e.shiftKey ? 1 : frame)); }
      if (e.key === "Home") { e.preventDefault(); preview.seek(0); }
      if (e.key === "End") { e.preventDefault(); preview.seek(projectDuration(project)); }
    });

    // Only build clips that can actually be seen. Rebuilding every clip on
    // every edit costs 261 ms at 4000 clips, which is felt; culling to the
    // scrolled window with a screen of margin either side keeps it flat.
    const viewLeft = Math.max(0, (scrollLeft - tracksWrap.clientWidth) / pxPerSec);
    const viewRight = (scrollLeft + tracksWrap.clientWidth * 2) / pxPerSec;
    let culled = 0;

    const lanes = document.createElement("div");
    lanes.className = "vid__lanes";

    for (const track of project.tracks) {
      const row = document.createElement("div");
      row.className = "vid__row";

      const head = document.createElement("div");
      head.className = "vid__head";
      head.dataset.kind = track.kind;

      const name = document.createElement("span");
      name.className = "vid__headname";
      name.addEventListener("dblclick", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = track.name;
        input.className = "vid__rename";
        input.addEventListener("blur", () => { renameTrack(track, input.value); render(); });
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") input.blur();
          if (ev.key === "Escape") render();
        });
        name.replaceChildren(input);
        input.focus();
        input.select();
      });
      const kindIcon = document.createElement("i");
      kindIcon.className = `ph ph-${track.kind === "audio" ? "waveform" : "film-strip"}`;
      kindIcon.setAttribute("aria-hidden", "true");
      name.append(kindIcon, document.createTextNode(track.name));

      const controls = document.createElement("div");
      controls.className = "vid__headctl";

      controls.appendChild(
        toggle("target", track.targeted ? `Untarget ${track.name}` : `Target ${track.name} for edits`, track.targeted,
               () => edit(() => { track.targeted = !track.targeted; }, "Target track"))
      );
      controls.appendChild(
        toggle(track.sync_lock ? "link-simple" : "link-simple-break",
               track.sync_lock ? "Sync lock on: moves with ripple edits" : "Sync lock off", track.sync_lock,
               () => edit(() => { track.sync_lock = !track.sync_lock; }, "Sync lock"))
      );
      controls.appendChild(
        toggle(track.muted ? "speaker-slash" : "speaker-high",
               track.muted ? "Unmute track" : "Mute track", track.muted,
               () => edit(() => { track.muted = !track.muted; }))
      );
      const soloBtn = toggle("headphones", track.solo ? "Unsolo track" : "Solo track", track.solo,
        () => { edit(() => { track.solo = !track.solo; }, "Solo"); preview.refreshMix(); });
      soloBtn.classList.add("vid__solo");
      controls.appendChild(soloBtn);
      if (track.kind === "video") {
        controls.appendChild(
          toggle(track.hidden ? "eye-slash" : "eye",
                 track.hidden ? "Show track" : "Hide track", track.hidden,
                 () => edit(() => { track.hidden = !track.hidden; }))
        );
      }
      controls.appendChild(
        toggle(track.locked ? "lock-simple" : "lock-simple-open",
               track.locked ? "Unlock track" : "Lock track", track.locked,
               () => edit(() => { track.locked = !track.locked; }))
      );
      controls.appendChild(iconBtn("gear-six", `${track.name} settings: opacity, blend, pan, ducking`, () => trackDialog(track)));
      controls.appendChild(iconBtn("copy", `Duplicate ${track.name}`, () => duplicateTrack(track)));
      controls.appendChild(
        iconBtn("x", `Remove ${track.name}`, () => {
          if (project.tracks.length <= 1) {
            say("A project needs at least one track.", true);
            return;
          }
          if (track.locked) { say(`${track.name} is locked.`, true); return; }
          const clipCount = track.clips.length;
          edit(() => { project.tracks = project.tracks.filter((t) => t.id !== track.id); });
          say(clipCount
            ? `Removed ${track.name} and ${clipCount} clip${clipCount === 1 ? "" : "s"}.`
            : `Removed ${track.name}.`);
        }, "btn btn--quiet vid__headx")
      );

      head.append(name, controls);

      const lane = document.createElement("div");
      lane.className = "vid__lane";
      lane.style.width = `${width}px`;
      lane.style.minHeight = `${trackHeight}px`;
      lane.dataset.locked = String(track.locked);
      lane.dataset.track = track.id;
      lane.dataset.kind = track.kind;
      lane.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes(BIN_MIME)) { e.preventDefault(); lane.dataset.drop = "true"; }
      });
      lane.addEventListener("dragleave", () => { delete lane.dataset.drop; });
      lane.addEventListener("drop", (e) => { delete lane.dataset.drop; dropOnLane(e, lane, track); });
      lane.addEventListener("pointerdown", (e) => { if (e.target === lane) startMarquee(e); });

      const through = new Set(throughEdits(track).map(([, right]) => right.id));
      for (const clip of track.clips) {
        // A clip is drawn if any part of it falls inside the window, and the
        // selected one always is, so the inspector never points at nothing.
        if (clip.id !== selectedId && (clipEnd(clip) < viewLeft || clip.start > viewRight)) {
          culled++;
          continue;
        }
        const el = clipElement(clip, track);
        if (through.has(clip.id)) el.dataset.through = "true";
        lane.appendChild(el);
      }

      row.append(head, lane);
      lanes.appendChild(row);
    }

    const scroller = document.createElement("div");
    scroller.className = "vid__scroller";
    scrollerEl = scroller;
    scroller.scrollLeft = scrollLeft;
    // Scrolling brings different clips into the window, so the lanes are
    // rebuilt. The browser already coalesces scroll events to about one per
    // frame, so this rebuilds directly rather than through requestAnimationFrame,
    // which does not run at all while the window is hidden and would leave the
    // timeline frozen mid-scroll.
    scroller.addEventListener("scroll", () => {
      const next = scroller.scrollLeft;
      if (Math.abs(next - scrollLeft) < 1) return;
      scrollLeft = next;
      if (rebuilding) return;
      renderTracks();
    });

    const inner = document.createElement("div");
    inner.className = "vid__inner";
    inner.style.width = `${width}px`;
    inner.append(ruler, lanes, playhead);
    innerEl = inner;

    scroller.appendChild(inner);
    tracksWrap.appendChild(scroller);
    scroller.scrollLeft = scrollLeft;
    rebuilding = false;
    positionPlayhead();
    if (culled) {
      // Not a status message: this is diagnostic, and the status line belongs
      // to the user's own actions.
      tracksWrap.dataset.culled = String(culled);
    } else {
      delete tracksWrap.dataset.culled;
    }
  }

  let innerEl: HTMLElement | null = null;

  /** Rubber-band selection from an empty spot on a lane. A click that does
   *  not drag clears the selection instead. */
  function startMarquee(e: PointerEvent) {
    if (!innerEl || e.button !== 0) return;
    e.preventDefault();
    const inner = innerEl;
    const box = inner.getBoundingClientRect();
    const x0 = e.clientX - box.left;
    const y0 = e.clientY - box.top;
    const band = document.createElement("div");
    band.className = "vid__marquee";
    band.setAttribute("aria-hidden", "true");
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const before = new Set(selection);
    let dragged = false;
    const clipBoxes = [...inner.querySelectorAll<HTMLElement>(".vid__clip")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.id ?? "", l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top };
    });
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - box.left, y1 = ev.clientY - box.top;
      if (!dragged && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      if (!dragged) { dragged = true; inner.appendChild(band); }
      const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
      Object.assign(band.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
      const hit = clipBoxes.filter((c) => c.l < r && c.r > l && c.t < b && c.b > t).map((c) => c.id);
      selection = expandSelection(project, additive ? [...before, ...hit] : hit);
      for (const el of inner.querySelectorAll<HTMLElement>(".vid__clip")) {
        el.dataset.selected = String(selection.has(el.dataset.id ?? ""));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      band.remove();
      if (!dragged && !additive) clearSelection();
      else selectedId = selection.has(selectedId ?? "") ? selectedId : [...selection][0] ?? null;
      renderTracks();
      renderInspector();
      if (dragged) say(`Selected ${selection.size} clip${selection.size === 1 ? "" : "s"}.`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function toggle(icon: string, title: string, on: boolean, fn: () => void) {
    const b = iconBtn(icon, title, fn, "btn btn--quiet vid__toggle");
    b.setAttribute("aria-pressed", String(on));
    return b;
  }

  function tickStep(scale: number): number {
    const targets = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return targets.find((t) => t * scale >= 70) ?? 900;
  }

  function clipElement(clip: Clip, track: Track): HTMLElement {
    const dur = clipDuration(clip);
    const el = document.createElement("div");
    el.className = "vid__clip";
    el.dataset.id = clip.id;
    el.dataset.selected = String(selection.has(clip.id));
    el.dataset.primary = String(clip.id === selectedId);
    el.dataset.kind = clip.source.type;
    if (clip.label) el.style.setProperty("--clip-label", clip.label);
    if (clip.group) el.dataset.grouped = "true";
    if (clip.link) el.dataset.linked = "true";
    if ((clip.source.type === "media" || clip.source.type === "still") && offline.has(clip.source.path)) {
      el.dataset.offline = "true";
    }
    el.style.transform = `translateX(${clip.start * pxPerSec}px)`;
    el.style.width = `${Math.max(8, dur * pxPerSec)}px`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute(
      "aria-label",
      `${labelOf(clip)}, ${tc(dur, project.fps)}, starts ${tc(clip.start, project.fps)}` +
        `${clip.muted ? ", muted" : ""}${clip.effects.length ? `, ${clip.effects.length} effects` : ""}` +
        `${selection.has(clip.id) ? ", selected" : ""}${el.dataset.offline ? ", media offline" : ""}`
    );

    const thumb = thumbs.get(clip.id);
    if (thumb) {
      el.style.backgroundImage = `url("${thumb}")`;
      el.classList.add("has-thumb");
    }

    // Waveform, drawn across the portion of the source this clip actually uses.
    if (clip.source.type === "media") {
      const peaks = waves.get(clip.source.path);
      if (peaks && peaks.length) {
        el.appendChild(waveformEl(clip, peaks, Math.max(8, dur * pxPerSec)));
      }
    }

    const label = document.createElement("span");
    label.className = "vid__cliplabel";
    label.textContent = labelOf(clip);
    el.appendChild(label);

    if (clip.effects.length) {
      const fx = document.createElement("span");
      fx.className = "vid__clipfx";
      fx.textContent = `${clip.effects.length} fx`;
      el.appendChild(fx);
    }
    const speedLabel = isAnimated(clip.speed)
      ? "ramp"
      : paramAt(clip.speed, 0) !== 1
        ? `${paramAt(clip.speed, 0)}×`
        : null;
    if (speedLabel) {
      const sp = document.createElement("span");
      sp.className = "vid__clipfx";
      sp.textContent = speedLabel;
      el.appendChild(sp);
    }

    const left = document.createElement("span");
    left.className = "vid__handle vid__handle--l";
    const right = document.createElement("span");
    right.className = "vid__handle vid__handle--r";

    // Fade grips: drag a top corner inwards to fade in or out. The pip sits at
    // the current fade length so the clip shows its own fades at a glance.
    const fade = clip.effects.find((e) => e.kind === "fade") as
      | { kind: "fade"; in_secs: number; out_secs: number }
      | undefined;
    const fadeIn = document.createElement("span");
    fadeIn.className = "vid__fadegrip vid__fadegrip--in";
    fadeIn.style.transform = `translateX(${(fade?.in_secs ?? 0) * pxPerSec}px)`;
    fadeIn.title = "Drag to fade in";
    const fadeOut = document.createElement("span");
    fadeOut.className = "vid__fadegrip vid__fadegrip--out";
    fadeOut.style.transform = `translateX(${-(fade?.out_secs ?? 0) * pxPerSec}px)`;
    fadeOut.title = "Drag to fade out";

    el.append(left, right, fadeIn, fadeOut);

    // The opacity rubber band. Ctrl-click on it adds a keyframe there.
    // Inserted beneath the handles so trims still reach them.
    if (track.kind === "video" && trackHeight >= 44) el.insertBefore(rubberBand(clip, track, dur), left);

    const select = () => {
      if (!selection.has(clip.id)) selectOnly([clip.id], clip.id);
      else selectedId = clip.id;
      renderTracks();
      renderInspector();
    };
    if (clip.source.type === "nested") {
      el.addEventListener("dblclick", (e) => { e.preventDefault(); openNested(clip); });
    }
    el.addEventListener("pointerdown", (e) => {
      if (track.locked) { say(`${track.name} is locked.`); return; }
      const target = e.target as HTMLElement;
      const onBody = target !== left && target !== right && target !== fadeIn && target !== fadeOut;
      // Modifiers on the body change the selection; on the edges they pick a
      // trim mode, so the two never collide.
      if (onBody && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const next = new Set(selection);
        const members = expandSelection(project, [clip.id]);
        const removing = next.has(clip.id);
        for (const id of members) removing ? next.delete(id) : next.add(id);
        selection = next;
        selectedId = removing ? [...next][0] ?? null : clip.id;
        renderTracks();
        renderInspector();
        return;
      }
      if (onBody && e.shiftKey && !e.altKey) {
        selectOnly([...selection, clip.id], clip.id);
        renderTracks();
        renderInspector();
        return;
      }
      select();
      const mode: DragMode =
        target === fadeIn ? "fade-in"
        : target === fadeOut ? "fade-out"
        : target === left ? trimMode(e, "in")
        : target === right ? trimMode(e, "out")
        : e.altKey ? "slip"
        : "move";
      startDrag(e, clip, track, mode);
      if (mode !== "move" && mode !== "trim-in" && mode !== "trim-out") {
        say(`${mode.replace("-", " ")} · ${labelOf(clip)}`);
      }
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
    });

    return el;
  }

  /** The opacity line across a clip, as Premiere draws it on the timeline. */
  function rubberBand(clip: Clip, track: Track, dur: number): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "vid__band");
    svg.setAttribute("preserveAspectRatio", "none");
    const cols = 60;
    svg.setAttribute("viewBox", `0 0 ${cols} 100`);
    let d = "";
    for (let i = 0; i <= cols; i++) {
      const v = Math.min(1, Math.max(0, paramAt(clip.motion.opacity, (dur * i) / cols)));
      d += `${i ? "L" : "M"}${i} ${(1 - v) * 90 + 5}`;
    }
    // A wide invisible twin is the hit target; only the line itself takes the
    // pointer, so the rest of the clip still drags and trims as usual.
    for (const cls of ["vid__bandline", "vid__bandhit"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", cls);
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
    }
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = "Opacity. Ctrl-click to add a keyframe here.";
    svg.appendChild(title);
    svg.addEventListener("pointerdown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || track.locked) return;
      e.stopPropagation();
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const local = Math.max(0, Math.min(dur, ((e.clientX - r.left) / Math.max(1, r.width)) * dur));
      const value = Math.min(1, Math.max(0, 1 - ((e.clientY - r.top) / Math.max(1, r.height) - 0.05) / 0.9));
      edit(() => { clip.motion.opacity = setKeyframe(clip.motion.opacity, local, Number(value.toFixed(3))); }, "Opacity keyframe");
      say(`Opacity keyframe at ${tc(clip.start + local, project.fps)}: ${Math.round(value * 100)}%.`);
    });
    return svg;
  }

  /** An SVG envelope for the slice of the source between in and out points. */
  function waveformEl(clip: Clip, peaks: number[], widthPx: number): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "vid__wave");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    // One column per 2 device pixels is plenty and keeps the DOM small.
    const cols = Math.max(8, Math.min(400, Math.round(widthPx / 2)));
    const H = 100;
    svg.setAttribute("viewBox", `0 0 ${cols} ${H}`);

    // Map the clip's in/out range onto the envelope, which spans the whole file.
    const srcLen = sourceDuration(clip);
    const total = clip.out_point > 0 ? clip.out_point : srcLen;
    const fileLen = Math.max(total, clip.in_point + srcLen);
    const startFrac = fileLen > 0 ? clip.in_point / fileLen : 0;
    const endFrac = fileLen > 0 ? (clip.in_point + srcLen) / fileLen : 1;

    let d = "";
    for (let c = 0; c < cols; c++) {
      const f = startFrac + ((endFrac - startFrac) * c) / (cols - 1 || 1);
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.round(f * (peaks.length - 1))));
      const amp = Math.max(0.01, peaks[idx]);
      const half = (amp * H) / 2;
      d += `M${c} ${H / 2 - half}V${H / 2 + half}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(path);
    return svg;
  }

  function labelOf(clip: Clip): string {
    if (clip.name) return clip.name;
    switch (clip.source.type) {
      case "media": return basename(clip.source.path);
      case "still": return `${basename(clip.source.path)} (freeze)`;
      case "adjustment": return "Adjustment layer";
      case "title": return clip.source.text || "Title";
      case "color": return "Colour";
      case "bars": return "Bars and tone";
      case "nested": return clip.source.name;
      default: return "Clip";
    }
  }

  /** Drag to move a clip — horizontally in time, vertically between tracks —
   *  or drag its edges to trim. */
  type DragMode =
    | "move" | "trim-in" | "trim-out" | "fade-in" | "fade-out"
    // Advanced trims, chosen by modifier:
    | "ripple-in" | "ripple-out"   // trim and move everything after
    | "roll"                       // move the cut, both clips change
    | "slip"                       // change what the clip shows, not where
    | "slide"                      // move the clip, neighbours absorb it
    | "rate-stretch";              // drag the edge to change speed

  /** Which trim a modifier asks for. Shift ripples, Ctrl rolls, Alt slips,
   *  Ctrl+Alt slides, and Shift+Alt stretches the rate. */
  function trimMode(e: PointerEvent, edge: "in" | "out"): DragMode {
    if (e.shiftKey && e.altKey) return "rate-stretch";
    if (e.ctrlKey && e.altKey) return "slide";
    if (e.altKey) return "slip";
    if (e.ctrlKey || e.metaKey) return "roll";
    if (e.shiftKey) return edge === "in" ? "ripple-in" : "ripple-out";
    return edge === "in" ? "trim-in" : "trim-out";
  }

  function startDrag(e: PointerEvent, clip: Clip, track: Track, mode: DragMode) {
    e.preventDefault();
    const startX = e.clientX;
    const before = JSON.stringify(saved);
    const orig = { start: clip.start, in_point: clip.in_point, out_point: clip.out_point };
    // Fades live in an effect, which is created on first drag rather than
    // carried by every clip that never fades.
    const ensureFade = () => {
      let f = clip.effects.find((x) => x.kind === "fade") as
        | { kind: "fade"; in_secs: number; out_secs: number }
        | undefined;
      if (!f) {
        f = { kind: "fade", in_secs: 0, out_secs: 0 };
        clip.effects.push(f);
      }
      return f;
    };
    const origFade = { ...(clip.effects.find((x) => x.kind === "fade") as
      { in_secs: number; out_secs: number } | undefined ?? { in_secs: 0, out_secs: 0 }) };
    const speed = isAnimated(clip.speed) ? 1 : Math.max(0.01, Math.abs(paramAt(clip.speed, 0)));

    // Ordered neighbours, and a snapshot of everything the advanced trims move.
    const ordered = [...track.clips].sort((a, b) => a.start - b.start);
    const index = ordered.indexOf(clip);
    const prev = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
    const origPrev = prev ? { out_point: prev.out_point, start: prev.start } : null;
    const origNext = next ? { in_point: next.in_point, start: next.start } : null;
    const origLater = ordered
      .filter((c) => c.start > clip.start)
      .map((c) => ({ clip: c, start: c.start }));
    const origSourceLen = Math.max(0.05, orig.out_point - orig.in_point);

    let moved = false;
    let currentTrack = track;
    // Dragging one member of a selection moves the whole selection, keeping
    // every clip on its own track.
    const companions = mode === "move" && selection.size > 1 && selection.has(clip.id)
      ? selectedClips().filter((x) => x.clip.id !== clip.id && !x.track.locked).map((x) => ({ ...x, start: x.clip.start }))
      : [];

    // Lane geometry does not shift during a drag, so snapshot it once rather
    // than re-measuring on every pointer move.
    const lanes = [...document.querySelectorAll<HTMLElement>(".vid__lane")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.track ?? "", kind: el.dataset.kind, top: r.top, bottom: r.bottom };
    });

    const trackUnder = (y: number): Track | null => {
      const hit = lanes.find((l) => y >= l.top && y <= l.bottom);
      if (!hit) return null;
      const found = project.tracks.find((t) => t.id === hit.id);
      return found && !found.locked ? found : null;
    };

    const fps = project.fps;
    const signed = (d: number) => `${d < 0 ? "−" : "+"}${tc(Math.abs(d), fps)}`;
    const side = (c: Clip | null, edge: "in" | "out", label: string): TrimSide | null => {
      if (!c) return null;
      const src = c.source;
      const time = edge === "in" ? c.in_point : Math.max(c.in_point, c.out_point - 1 / fps);
      const media = src.type === "media" || src.type === "still";
      return { path: media ? src.path : null, still: src.type === "still", time, caption: `${label} ${tc(time, fps)}` };
    };
    // Only a neighbour that actually meets this clip shares its edit.
    const meets = (a: Clip | null, b: Clip | null) => !!a && !!b && Math.abs(clipEnd(a) - b.start) < 0.002;
    const prevTouching = prev && origPrev && Math.abs(origPrev.start + clipDuration(prev) - orig.start) < 0.002 ? prev : null;
    const MODE_NAMES: Partial<Record<DragMode, string>> = {
      "trim-in": "Trim in", "trim-out": "Trim out", "ripple-in": "Ripple in", "ripple-out": "Ripple out",
      roll: "Roll", slip: "Slip", slide: "Slide", "rate-stretch": "Rate stretch",
    };
    const feedback = (ev: PointerEvent) => {
      const name = MODE_NAMES[mode];
      if (!name) return;
      let delta = 0;
      let detail = "";
      let two: [TrimSide | null, TrimSide | null] | null = null;
      if (mode === "trim-in" || mode === "ripple-in") {
        delta = (clip.in_point - orig.in_point) / speed;
        detail = `In ${tc(clip.in_point, fps)} · duration ${tc(clipDuration(clip), fps)}`;
        two = [side(prevTouching, "out", "OUT"), side(clip, "in", "IN")];
      } else if (mode === "trim-out" || mode === "ripple-out") {
        delta = (clip.out_point - orig.out_point) / speed;
        detail = `Out ${tc(clip.out_point, fps)} · duration ${tc(clipDuration(clip), fps)}`;
        two = [side(clip, "out", "OUT"), side(meets(clip, next) ? next : null, "in", "IN")];
      } else if (mode === "roll") {
        delta = (clip.out_point - orig.out_point) / speed;
        detail = `Cut at ${tc(clipEnd(clip), fps)}`;
        two = [side(clip, "out", "OUT"), side(next, "in", "IN")];
      } else if (mode === "slip") {
        delta = clip.in_point - orig.in_point;
        detail = `In ${tc(clip.in_point, fps)} · out ${tc(clip.out_point, fps)}`;
        two = [side(clip, "in", "IN"), side(clip, "out", "OUT")];
      } else if (mode === "slide") {
        delta = clip.start - orig.start;
        detail = `Starts ${tc(clip.start, fps)}`;
        two = [side(prev, "out", "OUT"), side(next, "in", "IN")];
      } else if (mode === "rate-stretch") {
        const rate = isAnimated(clip.speed) ? 1 : paramAt(clip.speed, 0);
        trimReadout.textContent = `${name}  ${Math.round(rate * 100)}% · duration ${tc(clipDuration(clip), fps)}`;
      }
      if (mode !== "rate-stretch") trimReadout.textContent = `${name}  ${signed(delta)}\n${detail}`;
      trimReadout.hidden = false;
      trimReadout.style.left = `${ev.clientX + 14}px`;
      trimReadout.style.top = `${ev.clientY + 18}px`;
      if (two) preview.showTrim(two[0], two[1]);
    };

    const onMove = (ev: PointerEvent) => {
      const dt = (ev.clientX - startX) / pxPerSec;
      if (Math.abs(dt) > 0.001) moved = true;

      if (mode === "move") {
        const wanted = Math.max(0, orig.start + dt);
        // Snap either edge, whichever lands closer.
        const len = clipDuration(clip);
        const snappedStart = snap(wanted, clip.id);
        const snappedEnd = snap(wanted + len, clip.id) - len;
        clip.start = Math.abs(snappedStart - wanted) <= Math.abs(snappedEnd - wanted)
          ? snappedStart
          : Math.max(0, snappedEnd);
        if (companions.length) {
          // The block cannot move before zero, so the leader is held back by
          // whichever companion would get there first.
          const shift = Math.max(clip.start - orig.start, -Math.min(orig.start, ...companions.map((c) => c.start)));
          clip.start = orig.start + shift;
          for (const c of companions) c.clip.start = c.start + shift;
        }

        // Vertical drag moves the clip to another track.
        const target = companions.length ? null : trackUnder(ev.clientY);
        if (target && target.id !== currentTrack.id) {
          const from = currentTrack.clips.indexOf(clip);
          if (from >= 0) {
            currentTrack.clips.splice(from, 1);
            target.clips.push(clip);
            currentTrack = target;
            moved = true;
          }
        }
      } else if (mode === "fade-in") {
        const f = ensureFade();
        f.in_secs = Math.max(0, Math.min(origFade.in_secs + dt, clipDuration(clip)));
      } else if (mode === "fade-out") {
        const f = ensureFade();
        f.out_secs = Math.max(0, Math.min(origFade.out_secs - dt, clipDuration(clip)));
      } else if (mode === "ripple-in") {
        // Trim the head and pull everything after along by the same amount.
        const next_in = Math.max(0, Math.min(orig.in_point + dt * speed, orig.out_point - 0.05));
        const shift = (next_in - orig.in_point) / speed;
        clip.in_point = next_in;
        clip.start = Math.max(0, orig.start);
        for (const l of origLater) l.clip.start = Math.max(0, l.start - shift);
      } else if (mode === "ripple-out") {
        const next_out = Math.max(clip.in_point + 0.05, orig.out_point + dt * speed);
        const shift = (next_out - orig.out_point) / speed;
        clip.out_point = next_out;
        for (const l of origLater) l.clip.start = Math.max(0, l.start + shift);
      } else if (mode === "roll") {
        // Move the cut: this clip's tail and the next clip's head, together.
        if (!next || !origNext) return;
        const limit = Math.min(
          (origNext.in_point) / speed,                       // next clip's head handle
          (orig.out_point - orig.in_point - 0.05) / speed    // this clip must survive
        );
        const move = Math.max(-limit, Math.min(dt, limit));
        clip.out_point = orig.out_point + move * speed;
        next.in_point = Math.max(0, origNext.in_point + move * speed);
        next.start = Math.max(0, origNext.start + move);
      } else if (mode === "slip") {
        // Change what the clip shows without moving it or changing its length.
        const shift = dt * speed;
        const lo = -orig.in_point;
        const move = Math.max(lo, shift);
        clip.in_point = Math.max(0, orig.in_point + move);
        clip.out_point = clip.in_point + origSourceLen;
        clip.start = orig.start;
      } else if (mode === "slide") {
        // Move the clip; the neighbours give and take to absorb it.
        if (!prev || !next || !origPrev || !origNext) return;
        const lo = -(origPrev.out_point - prev.in_point - 0.05);
        const hi = origNext.in_point;
        const move = Math.max(lo / speed, Math.min(dt, hi / speed));
        clip.start = Math.max(0, orig.start + move);
        prev.out_point = origPrev.out_point + move * speed;
        next.in_point = Math.max(0, origNext.in_point + move * speed);
        next.start = Math.max(0, origNext.start + move);
      } else if (mode === "rate-stretch") {
        // Dragging the edge changes speed rather than the source range, so the
        // same material fills a different length of timeline.
        const wanted = Math.max(0.05, clipDuration(clip) + dt);
        const rate = origSourceLen / wanted;
        clip.speed = Math.min(8, Math.max(0.1, rate));
      } else if (mode === "trim-in") {
        const next = Math.max(0, Math.min(orig.in_point + dt * speed, orig.out_point - 0.05));
        clip.in_point = next;
        clip.start = Math.max(0, orig.start + (next - orig.in_point) / speed);
      } else {
        clip.out_point = Math.max(clip.in_point + 0.05, orig.out_point + dt * speed);
      }
      preview.setProject(project);
      renderTracks();
      feedback(ev);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      trimReadout.hidden = true;
      preview.hideTrim();
      if (!moved) { renderInspector(); return; }
      resolveCollision(currentTrack, clip);
      for (const c of companions) resolveCollision(c.track, c.clip);
      // Record the pre-drag state once, rather than on every pointer move.
      history.push(JSON.parse(before) as Project);
      commit();
      renderInspector();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ------------------------------------------------------------- inspector

  /** The sidebar is three panels behind a tab strip: the selected clip, the
   *  project bin, and the subtitle list. */
  function renderInspector() {
    sidebar.replaceChildren();

    const tabs = document.createElement("div");
    tabs.className = "vid__tabs";
    tabs.setAttribute("role", "tablist");
    const tabDefs: Array<[typeof panel, string, string]> = [
      ["clip", "sliders-horizontal", "Clip"],
      ["bin", "folder", `Bin${project.bin.length ? ` (${project.bin.length})` : ""}`],
      ["subtitles", "subtitles", `Subtitles${project.subtitles.length ? ` (${project.subtitles.length})` : ""}`],
      ["markers", "map-pin", `Markers${project.markers.length ? ` (${project.markers.length})` : ""}`],
    ];
    for (const [key, icon, label] of tabDefs) {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "btn btn--quiet vid__tab";
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(panel === key));
      const g = document.createElement("i");
      g.className = `ph ph-${icon}`;
      g.setAttribute("aria-hidden", "true");
      t.append(g, document.createTextNode(label));
      t.addEventListener("click", () => { panel = key; renderInspector(); });
      tabs.appendChild(t);
    }
    sidebar.appendChild(tabs);

    if (panel === "bin") { renderBin(); return; }
    if (panel === "subtitles") { renderSubtitles(); return; }
    if (panel === "markers") { renderMarkers(); return; }
    renderClipPanel();
  }

  // ------------------------------------------------------------------- bin

  function renderBin() {
    const actions = document.createElement("div");
    actions.className = "vid__binactions";
    const viewBtn = iconBtn(binView === "list" ? "squares-four" : "list", binView === "list" ? "Icon view" : "List view", () => {
      binView = binView === "list" ? "icons" : "list";
      renderInspector();
    });
    actions.append(
      iconBtn("plus", "Import media and images to the bin", () => void addMedia(), "btn", true),
      viewBtn,
      proxyBtn,
      proxyToggle,
      iconBtn("rows", "Place everything here on the timeline", automateToSequence),
      iconBtn("folder-plus", "New folder", () => {
        const name = `Folder ${new Set(project.bin.map((b) => b.folder)).size + 1}`;
        binFolder = name;
        renderInspector();
        say(`Showing ${name}. Media added now goes here.`);
      })
    );
    sidebar.appendChild(actions);

    // Search across names and paths.
    const search = document.createElement("label");
    search.className = "vid__field";
    const searchLabel = document.createElement("span");
    searchLabel.className = "vid__fieldlabel";
    searchLabel.textContent = "Search the bin";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.value = binQuery;
    searchInput.placeholder = "Name or path…";
    searchInput.addEventListener("input", () => {
      binQuery = searchInput.value;
      renderInspector();
      const again = sidebar.querySelector<HTMLInputElement>('input[type="search"]');
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });
    search.append(searchLabel, searchInput);
    sidebar.appendChild(search);

    // Folder strip, including the root.
    const folders = ["", ...new Set(project.bin.map((b) => b.folder).filter(Boolean))];
    if (folders.length > 1 || binFolder) {
      const strip = document.createElement("div");
      strip.className = "vid__tabs";
      for (const f of folders) {
        const b = btn(f || "All", () => { binFolder = f; renderInspector(); },
                      "btn btn--quiet vid__tab");
        b.setAttribute("aria-selected", String(binFolder === f));
        strip.appendChild(b);
      }
      sidebar.appendChild(strip);
    }

    if (!project.bin.length) {
      const empty = document.createElement("p");
      empty.className = "vid__hint";
      empty.textContent = "The bin is empty. Add media to start.";
      sidebar.appendChild(empty);
      return;
    }

    const q = binQuery.trim().toLowerCase();
    const visible = project.bin.filter((b) =>
      (!binFolder || b.folder === binFolder) &&
      (!q || b.name.toLowerCase().includes(q) || b.path.toLowerCase().includes(q))
    );

    const list = document.createElement("div");
    list.className = binView === "icons" ? "vid__bin vid__bin--icons" : "vid__bin";
    list.setAttribute("role", "list");

    if (!visible.length) {
      const none = document.createElement("p");
      none.className = "vid__hint";
      none.textContent = q ? `Nothing matches "${binQuery}".` : "This folder is empty.";
      sidebar.appendChild(none);
      return;
    }

    for (const item of visible) {
      const row = document.createElement("div");
      row.className = "vid__binitem";
      row.setAttribute("role", "listitem");
      // Drag onto a lane: overwrite there, or insert with Ctrl.
      row.draggable = true;
      row.title = "Drag to the timeline. Hold Ctrl when dropping to insert. Double-click for the source monitor.";
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData(BIN_MIME, item.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      });
      row.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest("input, select, button")) return;
        sourceMonitor(item);
      });
      if (item.label) row.style.setProperty("--clip-label", item.label);
      const missing = offline.has(item.path);
      if (missing) row.dataset.offline = "true";

      if (binView === "icons") {
        void binThumb(item);
        const tile = document.createElement("div");
        tile.className = "vid__bintile";
        const src = binThumbs.get(item.id);
        if (src) tile.style.backgroundImage = `url("${src}")`;
        tile.dataset.kind = isImage(item.path) ? "image" : item.width ? "video" : "audio";
        const cap = document.createElement("span");
        cap.className = "vid__binname";
        cap.textContent = item.name;
        const dur = document.createElement("span");
        dur.className = "vid__bindur";
        dur.textContent = isImage(item.path) ? "still" : tc(item.duration, project.fps);
        tile.appendChild(dur);
        row.append(tile, cap);
        if (missing) {
          const tag = document.createElement("span");
          tag.className = "vid__route vid__offline";
          tag.textContent = "offline";
          row.appendChild(tag);
        }
        list.appendChild(row);
        continue;
      }

      const head = document.createElement("div");
      head.className = "vid__binhead";
      const name = document.createElement("span");
      name.className = "vid__binname";
      name.textContent = item.name;
      name.title = item.path;
      head.appendChild(name);
      if (item.proxy) {
        const tag = document.createElement("span");
        tag.className = "vid__route";
        tag.textContent = "proxy";
        tag.title = "A proxy exists. Preview may use it; export never will.";
        head.appendChild(tag);
      }
      if (missing) {
        const tag = document.createElement("span");
        tag.className = "vid__route vid__offline";
        tag.textContent = "offline";
        tag.title = "The file is not where the project expects it.";
        head.appendChild(tag);
      }

      const meta = document.createElement("p");
      meta.className = "vid__binmeta";
      const bits = [isImage(item.path) ? "still image" : tc(item.duration, project.fps)];
      if (item.width) bits.push(`${item.width}×${item.height}`);
      if (item.fps) bits.push(`${Math.round(item.fps)} fps`);
      bits.push(item.has_audio ? "has audio" : "no audio");
      meta.textContent = bits.join(" · ");

      const buttons = document.createElement("div");
      buttons.className = "vid__headctl";
      buttons.append(
        iconBtn("plus", `Add ${item.name} to the timeline`, () => {
          edit(() => { placeOnTimeline(item.path, item.duration, item.width === 0); });
          say(`${item.name} added to the timeline.`);
        }),
        iconBtn("monitor-play", `Open ${item.name} in the source monitor`, () => sourceMonitor(item)),
        iconBtn("arrows-counter-clockwise", `Replace the selected clips with ${item.name}`, () => replaceWithBinItem(item)),
        iconBtn("swap", missing ? `Locate ${item.name}` : `Relink ${item.name} to another file`,
          () => void (missing ? locateMedia(item.path) : replaceFootage(item))),
        iconBtn("crop", `Make a subclip of ${item.name}`, () => makeSubclip(item)),
        iconBtn("trash", `Remove ${item.name} from the bin`, () => {
          const inUse = project.tracks.some((t) =>
            t.clips.some((c) => c.source.type === "media" && c.source.path === item.path));
          if (inUse) { say(`${item.name} is still on the timeline.`, true); return; }
          edit(() => { project.bin = project.bin.filter((b) => b.id !== item.id); });
          renderInspector();
        })
      );

      const props = document.createElement("p");
      props.className = "vid__binmeta";
      props.textContent = item.path;
      props.title = item.path;

      const folderField = document.createElement("label");
      folderField.className = "vid__field";
      const folderLabel = document.createElement("span");
      folderLabel.className = "vid__fieldlabel";
      folderLabel.textContent = "Folder";
      const folderInput = document.createElement("input");
      folderInput.type = "text";
      folderInput.value = item.folder;
      folderInput.placeholder = "(root)";
      folderInput.addEventListener("change", () => {
        edit(() => { item.folder = folderInput.value.trim(); });
        renderInspector();
      });
      folderField.append(folderLabel, folderInput);

      const labelField = selectField("Label", item.label, LABELS, (v) => {
        edit(() => { item.label = v; }, "Bin label");
        renderInspector();
      });

      const fields = document.createElement("div");
      fields.className = "vid__fields";
      fields.append(folderField, labelField);
      row.append(head, meta, props, fields, buttons);
      list.appendChild(row);
    }
    sidebar.appendChild(list);
  }

  // ------------------------------------------------------------- subtitles

  function renderSubtitles() {
    const actions = document.createElement("div");
    actions.className = "vid__binactions";

    const modeWrap = document.createElement("label");
    modeWrap.className = "vid__field";
    const modeLabel = document.createElement("span");
    modeLabel.className = "vid__fieldlabel";
    modeLabel.textContent = "In the export";
    const mode = document.createElement("select");
    for (const [value, text] of [
      ["off", "Not included"],
      ["burn", "Burned into the picture"],
      ["embed", "Selectable track"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      opt.selected = project.subtitle_mode === value;
      mode.appendChild(opt);
    }
    mode.addEventListener("change", () => {
      edit(() => { project.subtitle_mode = mode.value as Project["subtitle_mode"]; });
    });
    modeWrap.append(modeLabel, mode);

    actions.append(
      iconBtn("plus", "Add a subtitle at the playhead", () => {
        edit(() => {
          project.subtitles.push({
            id: crypto.randomUUID(),
            start: preview.time,
            end: preview.time + 2,
            text: "New subtitle",
          });
          project.subtitles.sort((a, b) => a.start - b.start);
        });
        renderInspector();
      }, "btn", true),
      iconBtn("download-simple", "Import an SRT file", () => void importSrt()),
      iconBtn("upload-simple", "Export an SRT file", () => void exportSrt())
    );

    sidebar.append(actions, modeWrap);

    if (!project.subtitles.length) {
      const empty = document.createElement("p");
      empty.className = "vid__hint";
      empty.textContent = "No subtitles yet. Add one at the playhead or import an SRT file.";
      sidebar.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "vid__bin";
    project.subtitles.forEach((sub, i) => {
      const row = document.createElement("div");
      row.className = "vid__binitem";
      row.dataset.active = String(preview.time >= sub.start && preview.time < sub.end);

      const times = document.createElement("div");
      times.className = "vid__fields";
      times.append(
        numField("Start", sub.start, 0, 99999, 0.05, (v) => edit(() => {
          sub.start = Math.max(0, Math.min(v, sub.end - 0.05));
          project.subtitles.sort((a, b) => a.start - b.start);
        })),
        numField("End", sub.end, 0, 99999, 0.05, (v) => edit(() => {
          sub.end = Math.max(sub.start + 0.05, v);
          project.subtitles.sort((a, b) => a.start - b.start);
        }))
      );

      const text = document.createElement("textarea");
      text.className = "vid__subtext";
      text.rows = 2;
      text.value = sub.text;
      text.setAttribute("aria-label", `Subtitle ${i + 1} text`);
      text.addEventListener("change", () => edit(() => { sub.text = text.value; }));

      const buttons = document.createElement("div");
      buttons.className = "vid__headctl";
      buttons.append(
        iconBtn("crosshair", "Move the playhead here", () => preview.seek(sub.start)),
        iconBtn("trash", "Delete this subtitle", () => {
          edit(() => { project.subtitles = project.subtitles.filter((x) => x.id !== sub.id); });
          renderInspector();
        })
      );

      row.append(times, text, buttons);
      list.appendChild(row);
    });
    sidebar.appendChild(list);
  }

  async function importSrt() {
    if (!isTauri()) { say("Importing a file needs the desktop app.", true); return; }
    const picked = await open({ multiple: false, filters: [{ name: "Subtitles", extensions: ["srt"] }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      const text = await api.readTextFile(picked);
      const cues = await api.subtitlesFromSrt(text);
      if (!cues.length) { say("That file contained no usable subtitles.", true); return; }
      edit(() => { project.subtitles = cues; });
      renderInspector();
      say(`Imported ${cues.length} subtitle${cues.length === 1 ? "" : "s"}.`);
    } catch (e) {
      say(`Could not import that file. ${String(e)}`, true);
    }
  }

  async function exportSrt() {
    if (!isTauri()) { say("Saving a file needs the desktop app.", true); return; }
    if (!project.subtitles.length) { say("There are no subtitles to export.", true); return; }
    const out = await save({
      defaultPath: `${item.title || "odyssey"}.srt`,
      filters: [{ name: "SubRip", extensions: ["srt"] }],
    });
    if (!out) return;
    try {
      const text = await api.subtitlesToSrt(project.subtitles);
      await api.writeTextFile(out, text);
      say(`Subtitles written to ${basename(out)}`);
    } catch (e) {
      say(`Could not write that file. ${String(e)}`, true);
    }
  }

  // ------------------------------------------------------------ clip panel

  function renderClipPanel() {
    const sel = selected();
    if (!sel) {
      const hint = document.createElement("p");
      hint.className = "vid__hint";
      hint.textContent = "Select a clip to edit it.";
      sidebar.appendChild(hint);
      return;
    }
    const { clip, track } = sel;
    const dur = clipDuration(clip);

    const title = document.createElement("h3");
    title.className = "vid__sidetitle";
    title.textContent = labelOf(clip);
    sidebar.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "vid__sidemeta";
    meta.textContent = `${track.name} · ${tc(dur, project.fps)}` +
      `${selection.size > 1 ? ` · ${selection.size} selected` : ""}` +
      `${clip.group ? " · grouped" : ""}${clip.link ? " · linked" : ""}`;
    sidebar.appendChild(meta);

    const identity = document.createElement("div");
    identity.className = "vid__fields";
    identity.append(
      textField("Clip name", clip.name, (v) => edit(() => { clip.name = v.trim(); }, "Rename clip")),
      selectField("Label", clip.label, LABELS, (v) => edit(() => {
        for (const x of selectedClips()) x.clip.label = v;
      }, "Clip label")),
    );
    sidebar.appendChild(identity);

    const quick = document.createElement("div");
    quick.className = "vid__binactions";
    quick.append(
      btn("Speed / duration…", speedDialog),
      btn("Audio gain…", gainDialog),
      btn("Scale to fill", () => fitClip(true)),
    );
    if (clip.source.type === "nested") {
      quick.append(btn("Open nest", () => openNested(clip)), btn("Break apart nest", unnestSelected));
    }
    if (selection.size > 1) {
      quick.append(btn("Group", () => groupSelection(true)), btn("Link", toggleLink), btn("Nest", nestSelection));
      if (selectedClips().filter((x) => x.clip.source.type === "media").length > 1) {
        const mc = btn("Create multicam", () => void createMulticam());
        mc.title = "Sync these cameras by their audio and cut between them";
        quick.appendChild(mc);
      }
    }
    const cam = clip.multicam ? groupById(clip.multicam.group) : null;
    if (cam && clip.multicam) {
      const mc = clip.multicam;
      quick.appendChild(selectField("Angle", String(mc.angle),
        cam.angles.map((a, i) => [String(i), `${i + 1} · ${a.name}`] as [string, string]),
        (v) => {
          const trial = structuredClone(clip);
          if (!switchAngle(trial, cam, Number(v))) { say("That camera was not rolling for all of this clip.", true); renderInspector(); return; }
          edit(() => { switchAngle(clip, cam, Number(v)); }, "Switch angle");
        }));
    }
    if (clip.group) quick.appendChild(btn("Ungroup", () => groupSelection(false)));
    if (clip.link && selection.size <= 2) quick.appendChild(btn("Unlink", toggleLink));
    sidebar.appendChild(quick);

    // Source-specific fields
    if (clip.source.type === "title") {
      const src = clip.source;
      const st = src.style;
      const text = document.createElement("textarea");
      text.className = "vid__subtext";
      text.rows = 3;
      text.value = src.text;
      text.setAttribute("aria-label", "Title text");
      text.addEventListener("change", () => edit(() => { src.text = text.value; }, "Title text"));
      sidebar.appendChild(text);
      const set = <K extends keyof TitleStyle>(key: K, v: TitleStyle[K]) => edit(() => { st[key] = v; }, "Title style");
      const g1 = document.createElement("div");
      g1.className = "vid__fields";
      g1.append(
        numField("Size", src.size, 8, 400, 1, (v) => edit(() => { src.size = v; })),
        textField("Colour", src.color, (v) => edit(() => { src.color = v; })),
        selectField("Align", st.align, [["left", "Left"], ["center", "Centre"], ["right", "Right"]], (v) => set("align", v)),
        selectField("Position", st.valign, [["top", "Top"], ["middle", "Middle"], ["lower-third", "Lower third"], ["bottom", "Bottom"]],
          (v) => set("valign", v)),
        numField("Offset X", st.offset_x, -4000, 4000, 1, (v) => set("offset_x", v)),
        numField("Offset Y", st.offset_y, -4000, 4000, 1, (v) => set("offset_y", v)),
        numField("Stroke width", st.stroke_width, 0, 64, 1, (v) => set("stroke_width", v)),
        textField("Stroke colour", st.stroke_color, (v) => set("stroke_color", v)),
        numField("Shadow distance", st.shadow, 0, 64, 1, (v) => set("shadow", v)),
        textField("Shadow colour", st.shadow_color, (v) => set("shadow_color", v)),
        textField("Box colour (@ sets alpha)", st.box_color, (v) => set("box_color", v)),
        numField("Box padding", st.box_padding, 0, 200, 1, (v) => set("box_padding", v)),
      );
      sidebar.append(
        g1,
        checkField("Background box behind the text", st.box_enabled, (v) => set("box_enabled", v)),
        checkField("Opaque card (off shows the tracks beneath)", st.opaque, (v) => set("opaque", v)),
        textField("Card colour", src.background, (v) => edit(() => { src.background = v; })),
        selectField("Roll and crawl", st.scroll, [["none", "Still"], ["roll", "Roll (credits, bottom to top)"], ["crawl", "Crawl (right to left)"]],
          (v) => set("scroll", v)),
      );
    }
    if (clip.source.type === "color") {
      const src = clip.source;
      sidebar.appendChild(textField("Colour", src.color, (v) => edit(() => { src.color = v; })));
    }

    const grid = document.createElement("div");
    grid.className = "vid__fields";
    grid.append(
      numField("Start", clip.start, 0, 99999, 0.01, (v) => edit(() => {
        clip.start = Math.max(0, v); resolveCollision(track, clip);
      })),
      numField("In point", clip.in_point, 0, 99999, 0.01, (v) => edit(() => {
        clip.in_point = Math.max(0, Math.min(v, clip.out_point - 0.05));
      })),
      numField("Out point", clip.out_point, 0, 99999, 0.01, (v) => edit(() => {
        clip.out_point = Math.max(clip.in_point + 0.05, v);
      })),
      numField("Gain", clip.gain, 0, 4, 0.05, (v) => edit(() => { clip.gain = Math.max(0, v); }))
    );
    sidebar.appendChild(grid);

    // Transition at the head of the clip.
    const transWrap = document.createElement("label");
    transWrap.className = "vid__field";
    const transLabel = document.createElement("span");
    transLabel.className = "vid__fieldlabel";
    transLabel.textContent = "Transition in";
    const transSelect = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "None";
    noneOpt.selected = !clip.transition_in;
    transSelect.appendChild(noneOpt);
    for (const [value, text] of TRANSITION_LABELS) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      opt.selected = clip.transition_in?.kind === value;
      transSelect.appendChild(opt);
    }
    transSelect.addEventListener("change", () => {
      edit(() => {
        clip.transition_in = transSelect.value
          ? {
              kind: transSelect.value as TransitionKind,
              duration: clip.transition_in?.duration ?? prefs.transitionSeconds,
              curve: clip.transition_in?.curve ?? "qsin",
            }
          : null;
      });
      renderInspector();
    });
    transWrap.append(transLabel, transSelect);
    sidebar.appendChild(transWrap);

    if (clip.transition_in) {
      const t = clip.transition_in;
      sidebar.appendChild(
        numField("Transition length", t.duration, 0.05, 10, 0.05, (v) =>
          edit(() => { t.duration = Math.max(0.05, v); }))
      );
      if (track.kind === "audio") {
        sidebar.appendChild(selectField<FadeCurve>("Crossfade shape", t.curve, FADE_CURVES, (v) =>
          edit(() => { t.curve = v; }, "Crossfade shape")));
      }
      const note = document.createElement("p");
      note.className = "vid__hint";
      note.textContent = "A dissolve needs head handles on this clip and tail on the one before; without them it shortens.";
      sidebar.appendChild(note);
    }

    // Speed sits with the clip rather than in an effect, and keyframing it is
    // time remapping: the ramp is rendered as constant-speed segments.
    sidebar.appendChild(
      paramRow(clip as unknown as Record<string, Param>,
        { key: "speed", label: "Speed (keyframe to ramp)", min: 0.1, max: 8, step: 0.05, keyframable: true },
        clip, dur, "source")
    );

    sidebar.appendChild(checkField("Mute this clip", clip.muted, (v) => edit(() => { clip.muted = v; })));
    sidebar.appendChild(checkField("Reverse", clip.reverse, (v) => edit(() => { clip.reverse = v; })));
    // Audio channel picking, for sources that carry a lav on one channel and
    // a room mic on another.
    sidebar.appendChild(
      textField("Audio channels (blank = all)", clip.channels.join(","), (v) =>
        edit(() => {
          clip.channels = v
            .split(/[ ,]+/)
            .map((n) => Number(n.trim()))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < 32)
            .slice(0, 2);
        }))
    );
    sidebar.appendChild(checkField("Keep pitch when speed changes", clip.preserve_pitch,
      (v) => edit(() => { clip.preserve_pitch = v; })));
    sidebar.appendChild(selectField<Interpolation>("Time interpolation", clip.interpolation, [
      ["sampling", "Frame sampling"], ["blending", "Frame blending"], ["optical", "Optical flow (slow to render)"],
    ], (v) => edit(() => { clip.interpolation = v; }, "Time interpolation")));

    const essentials = document.createElement("div");
    essentials.className = "vid__fields";
    const audioType = document.createElement("select");
    audioType.setAttribute("aria-label", "Essential Sound type");
    audioType.append(new Option("Audio type…", ""), ...AUDIO_TYPES.map(([v, label]) => new Option(label, v)));
    audioType.addEventListener("change", () => {
      const entry = AUDIO_TYPES.find(([v]) => v === audioType.value);
      if (!entry) return;
      edit(() => { for (const x of editableClips()) x.clip.effects.push(...entry[2]()); }, `Essential Sound: ${entry[1]}`);
      say(`${entry[1]} treatment added. Each step is an ordinary effect you can adjust or remove.`);
    });
    const look = document.createElement("select");
    look.setAttribute("aria-label", "Apply a creative look");
    look.append(new Option("Creative look…", ""), ...LOOKS.map(([label]) => new Option(label, label)));
    look.addEventListener("change", () => {
      const entry = LOOKS.find(([label]) => label === look.value);
      if (!entry) return;
      edit(() => { for (const x of editableClips()) x.clip.effects.push(...entry[1]()); }, `Look: ${entry[0]}`);
      say(`${entry[0]} look applied as editable effects.`);
    });
    essentials.append(audioType, look);
    sidebar.appendChild(essentials);

    // ---- Motion: intrinsic to every clip, so it sits above the effect stack ----
    const motionHead = document.createElement("div");
    motionHead.className = "vid__fxhead";
    const motionTitle = document.createElement("h4");
    motionTitle.textContent = "Motion";
    const resetMotion = btn("Reset", () => {
      edit(() => { clip.motion = defaultMotion(); });
      renderInspector();
    });
    const centreClip = btn("Centre", () => { fitClip(false); renderInspector(); });
    centreClip.title = "Put the clip back at the centre of the frame, unrotated";
    motionHead.append(motionTitle, centreClip, resetMotion);
    sidebar.appendChild(motionHead);

    const motionCard = document.createElement("div");
    motionCard.className = "vid__fx";
    for (const spec of MOTION_PARAMS) {
      motionCard.appendChild(
        paramRow(clip.motion as unknown as Record<string, Param>,
          { key: spec.key as string, label: spec.label, min: spec.min, max: spec.max,
            step: spec.step, keyframable: true },
          clip, dur, "output", defaultMotion()[spec.key] as number)
      );
    }

    // Blend mode sits with motion because it governs how the clip composites.
    const blendWrap = document.createElement("label");
    blendWrap.className = "vid__field";
    const blendLabel = document.createElement("span");
    blendLabel.className = "vid__fieldlabel";
    blendLabel.textContent = "Blend mode";
    const blendSelect = document.createElement("select");
    for (const [value, text] of BLEND_LABELS) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      opt.selected = clip.blend === value;
      blendSelect.appendChild(opt);
    }
    blendSelect.addEventListener("change", () =>
      edit(() => { clip.blend = blendSelect.value as BlendMode; }));
    blendWrap.append(blendLabel, blendSelect);
    motionCard.appendChild(blendWrap);

    sidebar.appendChild(motionCard);

    // Effects
    const fxHead = document.createElement("div");
    fxHead.className = "vid__fxhead";
    const fxTitle = document.createElement("h4");
    fxTitle.textContent = "Effects";
    const addFx = document.createElement("select");
    addFx.className = "vid__fxadd";
    addFx.setAttribute("aria-label", "Add an effect");
    const placeholder = document.createElement("option");
    placeholder.textContent = "Add effect…";
    placeholder.value = "";
    addFx.appendChild(placeholder);
    for (const entry of EFFECT_CATALOGUE) {
      const opt = document.createElement("option");
      opt.value = entry.label;
      opt.textContent = `${entry.group} · ${entry.label}`;
      addFx.appendChild(opt);
    }
    addFx.addEventListener("change", () => {
      const entry = EFFECT_CATALOGUE.find((c) => c.label === addFx.value);
      if (!entry) return;
      edit(() => { clip.effects.push(entry.make()); });
      renderInspector();
    });
    fxHead.append(fxTitle, addFx);
    sidebar.appendChild(fxHead);

    // The Effects panel's search box: type to filter, click to add.
    const fxSearch = document.createElement("input");
    fxSearch.type = "search";
    fxSearch.placeholder = "Search effects…";
    fxSearch.setAttribute("aria-label", "Search effects");
    const fxResults = document.createElement("div");
    fxResults.className = "vid__fxresults";
    fxSearch.addEventListener("input", () => {
      const q = fxSearch.value.trim().toLowerCase();
      fxResults.replaceChildren();
      if (!q) return;
      const hits = [
        ...EFFECT_CATALOGUE.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q))
          .map((c) => ({ label: `${c.group} · ${c.label}`, make: c.make })),
        ...frei0r.filter((f) => f.label.toLowerCase().includes(q)).map((f) => ({ label: `frei0r · ${f.label}`, make: () => makeFrei0r(f.name) })),
      ].slice(0, 12);
      if (!hits.length) {
        const none = document.createElement("p");
        none.className = "vid__hint";
        none.textContent = "No effect by that name.";
        fxResults.appendChild(none);
      }
      for (const hit of hits) {
        fxResults.appendChild(btn(hit.label, () => {
          edit(() => { clip.effects.push(hit.make()); }, "Add effect");
          renderInspector();
        }, "btn btn--quiet vid__fxhit"));
      }
    });
    sidebar.append(fxSearch, fxResults);

    const presetRow = document.createElement("div");
    presetRow.className = "vid__fields";
    const presetSelect = document.createElement("select");
    presetSelect.setAttribute("aria-label", "Apply an effect preset");
    const presets = loadPresetsLocal();
    presetSelect.append(new Option(presets.length ? `Apply preset (${presets.length})…` : "No effect presets yet", ""),
      ...presets.map((p) => new Option(p.name, p.name)));
    presetSelect.disabled = !presets.length;
    presetSelect.addEventListener("change", () => {
      const preset = presets.find((p) => p.name === presetSelect.value);
      if (!preset) return;
      edit(() => { for (const x of editableClips()) x.clip.effects.push(...structuredClone(preset.effects)); }, "Apply effect preset");
      renderInspector();
      say(`Applied the preset "${preset.name}".`);
    });
    presetRow.append(presetSelect, btn("Save effects as preset", () => saveEffectPreset(clip)));
    sidebar.appendChild(presetRow);

    // The frei0r library — the same plugin collection Kdenlive draws on.
    const f0 = document.createElement("select");
    f0.className = "vid__fxadd";
    f0.setAttribute("aria-label", "Add a frei0r effect");
    const f0head = document.createElement("option");
    f0head.value = "";
    f0head.textContent = frei0r.length ? `frei0r library (${frei0r.length})…` : "frei0r: none installed";
    f0.appendChild(f0head);
    for (const plugin of frei0r) {
      const opt = document.createElement("option");
      opt.value = plugin.name;
      opt.textContent = plugin.label;
      f0.appendChild(opt);
    }
    f0.disabled = frei0r.length === 0;
    f0.addEventListener("change", () => {
      if (!f0.value) return;
      edit(() => { clip.effects.push(makeFrei0r(f0.value)); });
      renderInspector();
    });
    sidebar.appendChild(f0);

    clip.effects.forEach((effect, i) => {
      sidebar.appendChild(effectCard(effect, i, clip, dur));
    });
  }

  function effectCard(effect: Effect, index: number, clip: Clip, dur: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "vid__fx";

    const head = document.createElement("div");
    head.className = "vid__fxtitle";
    const name = document.createElement("span");
    name.textContent = EFFECT_CATALOGUE.find((c) => c.make().kind === effect.kind)?.label ?? effect.kind;
    const route = ANIMATION_ROUTE[effect.kind];
    if (route && route !== "static") {
      const tag = document.createElement("span");
      tag.className = "vid__route";
      tag.textContent = ROUTE_LABEL[route];
      tag.title = route === "expression"
        ? "Animation is evaluated by ffmpeg on every frame."
        : route === "command"
          ? "Animation is sampled at 20 Hz and sent as timed commands."
          : "This filter cannot be animated directly, so it is sampled into gated instances.";
      head.appendChild(tag);
    }
    const on = effect.enabled !== false;
    card.dataset.bypassed = String(!on);
    const bypass = toggle(on ? "eye" : "eye-slash", on ? "Bypass this effect" : "Enable this effect", !on, () => {
      edit(() => { if (on) effect.enabled = false; else delete effect.enabled; }, on ? "Bypass effect" : "Enable effect");
      renderInspector();
    });
    const move = (to: number) => {
      if (to < 0 || to >= clip.effects.length) return;
      edit(() => {
        const [fx] = clip.effects.splice(index, 1);
        clip.effects.splice(to, 0, fx);
      }, "Reorder effects");
      renderInspector();
    };
    const up = iconBtn("caret-up", "Move up: applied earlier", () => move(index - 1), "btn btn--quiet vid__toggle");
    up.disabled = index === 0;
    const down = iconBtn("caret-down", "Move down: applied later", () => move(index + 1), "btn btn--quiet vid__toggle");
    down.disabled = index === clip.effects.length - 1;
    const dup = iconBtn("copy", "Duplicate effect", () => {
      edit(() => { clip.effects.splice(index + 1, 0, structuredClone(effect)); }, "Duplicate effect");
      renderInspector();
    }, "btn btn--quiet vid__toggle");
    const remove = iconBtn("x", "Remove effect", () => {
      edit(() => { clip.effects.splice(index, 1); });
      renderInspector();
    }, "btn btn--quiet vid__headx");
    head.append(name, bypass, up, down, dup, remove);
    card.appendChild(head);

    // Plain numeric fields that are not keyframable parameters.
    if (effect.kind === "fade" || effect.kind === "audiofade") {
      const e = effect;
      card.appendChild(numField("Fade in (s)", e.in_secs, 0, 60, 0.05, (v) => edit(() => { e.in_secs = Math.max(0, v); })));
      card.appendChild(numField("Fade out (s)", e.out_secs, 0, 60, 0.05, (v) => edit(() => { e.out_secs = Math.max(0, v); })));
    }
    if (effect.kind === "audiofade") {
      const e = effect;
      card.appendChild(selectField<FadeCurve>("Shape", e.curve ?? "tri", FADE_CURVES, (v) => edit(() => { e.curve = v; })));
    }
    if (effect.kind === "mask") {
      const e = effect;
      card.append(
        selectField("Shape", e.shape, [["ellipse", "Ellipse"], ["rectangle", "Rectangle"]], (v) => edit(() => { e.shape = v; })),
        checkField("Inverted", e.invert, (v) => edit(() => { e.invert = v; })),
      );
      const track = btn(tracking ? "Tracking…" : "Track mask forward", () => void trackMask(clip, e));
      track.title = "Follow what is inside the mask from the playhead to the end of the clip, keyframing its position";
      track.disabled = tracking || clip.source.type !== "media";
      card.appendChild(track);
    }
    if (effect.kind === "tint") {
      const e = effect;
      card.append(
        textField("Map black to (#rrggbb)", e.black, (v) => edit(() => { e.black = v; })),
        textField("Map white to (#rrggbb)", e.white, (v) => edit(() => { e.white = v; })),
        numField("Amount", e.amount, 0, 1, 0.05, (v) => edit(() => { e.amount = Math.min(1, Math.max(0, v)); })),
      );
    }
    if (effect.kind === "text") {
      const e = effect;
      card.appendChild(textField("Content", e.content, (v) => edit(() => { e.content = v; })));
      card.appendChild(numField("Size", e.size, 8, 400, 1, (v) => edit(() => { e.size = v; })));
      card.appendChild(textField("Colour", e.color, (v) => edit(() => { e.color = v; })));
      const follow = btn("Follow the tracked mask", () => followMask(clip, e));
      follow.title = "Move this text with the first keyframed mask on the clip";
      follow.disabled = !clip.effects.some((m) => m.kind === "mask" && (isAnimated(m.x) || isAnimated(m.y)));
      card.appendChild(follow);
    }
    if (effect.kind === "chromakey") {
      const e = effect;
      card.appendChild(textField("Key colour", e.color, (v) => edit(() => { e.color = v; })));
    }
    if (effect.kind === "crop") {
      const e = effect;
      card.appendChild(numField("Width", e.width, 2, 8000, 2, (v) => edit(() => { e.width = v; })));
      card.appendChild(numField("Height", e.height, 2, 8000, 2, (v) => edit(() => { e.height = v; })));
    }

    const defaults = EFFECT_CATALOGUE.find((c) => c.make().kind === effect.kind)?.make() as unknown as Record<string, Param> | undefined;
    for (const spec of EFFECT_PARAMS[effect.kind] ?? []) {
      const fallback = defaults?.[spec.key];
      card.appendChild(paramRow(effect as unknown as Record<string, Param>, spec, clip, dur, "output",
        typeof fallback === "number" ? fallback : undefined));
    }

    // frei0r plugins expose an arbitrary number of normalised 0..1 parameters.
    if (effect.kind === "frei0r") {
      const e = effect;
      e.params.forEach((_, i) => {
        card.appendChild(
          paramRow(e as unknown as Record<string, Param>, {
            key: String(i), label: `Param ${i + 1}`, min: 0, max: 1, step: 0.01, keyframable: true,
          }, clip, dur)
        );
      });
      const row = document.createElement("div");
      row.className = "vid__headctl";
      row.append(
        btn("Add param", () => { edit(() => { e.params.push(0.5); }); renderInspector(); }),
        btn("Remove param", () => {
          if (e.params.length <= 1) return;
          edit(() => { e.params.pop(); });
          renderInspector();
        })
      );
      card.appendChild(row);
    }
    return card;
  }

  /** A small curve editor for an animated parameter.
   *
   *  Keyframes are drawn against time and value; dragging one moves it in both
   *  axes, and its easing is picked from the row beneath. This is the piece
   *  Premiere calls the effect controls graph. */
  function keyframeGraph(
    bag: Record<string, Param>,
    key: string,
    spec: { min: number; max: number },
    clip: Clip,
    dur: number
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "vid__graph";

    const param = bag[key];
    if (!isAnimated(param)) return wrap;
    const kf = param.keyframes;

    const W = 260;
    const H = 84;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "vid__graphsvg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${key} curve, ${kf.length} keyframes`);

    const span = Math.max(0.001, dur);
    const range = Math.max(1e-6, spec.max - spec.min);
    const toX = (t: number) => (t / span) * W;
    const toY = (v: number) => H - ((v - spec.min) / range) * H;
    const fromX = (x: number) => (x / W) * span;
    const fromY = (y: number) => spec.min + ((H - y) / H) * range;

    // The curve, sampled so easing is visible rather than implied.
    let d = "";
    const STEPS = 90;
    for (let i = 0; i <= STEPS; i++) {
      const t = (span * i) / STEPS;
      const v = paramAt(param, t);
      d += `${i === 0 ? "M" : "L"}${toX(t).toFixed(2)} ${toY(v).toFixed(2)}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "vid__graphline");
    svg.appendChild(path);

    // The playhead, so a keyframe can be read against where you are.
    const local = Math.max(0, Math.min(preview.time - clip.start, dur));
    const head = document.createElementNS("http://www.w3.org/2000/svg", "line");
    head.setAttribute("x1", String(toX(local)));
    head.setAttribute("x2", String(toX(local)));
    head.setAttribute("y1", "0");
    head.setAttribute("y2", String(H));
    head.setAttribute("class", "vid__graphhead");
    svg.appendChild(head);

    kf.forEach((k, i) => {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(toX(k.time)));
      dot.setAttribute("cy", String(toY(k.value)));
      dot.setAttribute("r", "4");
      dot.setAttribute("class", "vid__graphdot");
      dot.setAttribute("tabindex", "0");
      dot.setAttribute("role", "button");
      dot.setAttribute("aria-label",
        `Keyframe ${i + 1} at ${tc(k.time, project.fps)}, value ${k.value.toFixed(2)}`);

      dot.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const before = JSON.stringify(saved);
        const rect = svg.getBoundingClientRect();
        const onMove = (m: PointerEvent) => {
          const x = ((m.clientX - rect.left) / rect.width) * W;
          const y = ((m.clientY - rect.top) / rect.height) * H;
          k.time = Math.max(0, Math.min(span, fromX(x)));
          k.value = Math.max(spec.min, Math.min(spec.max, fromY(y)));
          (bag[key] as { keyframes: typeof kf }).keyframes.sort((a, b) => a.time - b.time);
          preview.setProject(project);
          preview.draw();
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          history.push(JSON.parse(before) as Project, "Move keyframe");
          commit();
          renderInspector();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });

      dot.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        edit(() => { bag[key] = removeKeyframe(bag[key], k.time); });
        renderInspector();
      });
      svg.appendChild(dot);
    });

    wrap.appendChild(svg);

    // Easing for the keyframe nearest the playhead.
    const nearest = kf.reduce((best, k) =>
      Math.abs(k.time - local) < Math.abs(best.time - local) ? k : best, kf[0]);
    const easing = document.createElement("select");
    easing.className = "vid__fxadd";
    easing.setAttribute("aria-label", "Easing for the nearest keyframe");
    for (const [value, label] of EASING_LABELS) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      opt.selected = nearest.easing === value;
      easing.appendChild(opt);
    }
    easing.addEventListener("change", () => {
      edit(() => { nearest.easing = easing.value as typeof nearest.easing; });
      renderInspector();
    });
    wrap.appendChild(easing);
    return wrap;
  }

  /** A slider bound to a parameter, with keyframing at the playhead.
   *  `basis` picks the clock the keyframe times are measured on: effect
   *  parameters animate over the clip's output time, while speed keyframes are
   *  indexed by position in the source, so a ramp survives being moved. */
  function paramRow(
    bag: Record<string, Param>,
    spec: { key: string; label: string; min: number; max: number; step: number; keyframable: boolean },
    clip: Clip,
    dur: number,
    basis: "output" | "source" = "output",
    defaultValue?: number
  ): HTMLElement {
    // Evaluated live, not captured: the playhead moves between the inspector
    // being drawn and a slider being dragged, and a keyframe must land where
    // the playhead is NOW or it silently overwrites the previous one.
    const localNow = () => {
      const outLocal = Math.max(0, Math.min(preview.time - clip.start, dur));
      return basis === "source"
        ? Math.max(0, sourceTimeAt(clip, outLocal) - clip.in_point)
        : outLocal;
    };
    const local = localNow();
    const value = paramAt(bag[spec.key], local);

    const row = document.createElement("div");
    row.className = "vid__param";

    const label = document.createElement("label");
    label.className = "vid__paramlabel";
    label.textContent = spec.label;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.value = String(value);
    slider.setAttribute("aria-label", spec.label);

    const readout = document.createElement("output");
    readout.className = "vid__paramvalue";
    readout.textContent = value.toFixed(2);

    const animated = isAnimated(bag[spec.key]);

    slider.addEventListener("input", () => {
      readout.textContent = Number(slider.value).toFixed(2);
    });
    slider.addEventListener("change", () => {
      const v = Number(slider.value);
      const at = localNow();
      edit(() => {
        if (animated && spec.keyframable) bag[spec.key] = setKeyframe(bag[spec.key], at, v);
        else bag[spec.key] = v;
      });
      renderInspector();
    });

    row.append(label, slider, readout);

    if (defaultValue !== undefined) {
      const reset = iconBtn("arrow-u-up-left", `Reset ${spec.label} to ${defaultValue}`, () => {
        edit(() => { bag[spec.key] = defaultValue; }, `Reset ${spec.label}`);
        renderInspector();
      }, "btn btn--quiet vid__key");
      row.appendChild(reset);
    }

    if (spec.keyframable) {
      const hasKeyHere =
        animated &&
        (bag[spec.key] as { keyframes: Array<{ time: number }> }).keyframes.some(
          (k) => Math.abs(k.time - local) < 0.001
        );
      const key = iconBtn("diamond", "keyframe", () => {
        const at = localNow();
        edit(() => {
          bag[spec.key] = hasKeyHere
            ? removeKeyframe(bag[spec.key], at)
            : setKeyframe(bag[spec.key], at, Number(slider.value));
        });
        renderInspector();
      }, "btn btn--quiet vid__key");
      const keyLabel = hasKeyHere
        ? `Remove keyframe at ${tc(local, project.fps)}`
        : `Add keyframe at ${tc(local, project.fps)}`;
      key.title = keyLabel;
      key.setAttribute("aria-label", keyLabel);
      key.setAttribute("aria-pressed", String(hasKeyHere));
      row.appendChild(key);

      if (animated && basis === "output") {
        // Go to the previous or next keyframe, measured on the clip's clock.
        const times = (bag[spec.key] as { keyframes: Array<{ time: number }> }).keyframes
          .map((k) => k.time).sort((a, b) => a - b);
        const go = (dir: -1 | 1) => {
          const now = localNow();
          const t = dir > 0 ? times.find((k) => k > now + 1e-3) : [...times].reverse().find((k) => k < now - 1e-3);
          if (t === undefined) { say("No keyframe that way."); return; }
          preview.seek(clip.start + t);
          renderInspector();
        };
        row.append(
          iconBtn("caret-left", `Previous ${spec.label} keyframe`, () => go(-1), "btn btn--quiet vid__key"),
          iconBtn("caret-right", `Next ${spec.label} keyframe`, () => go(1), "btn btn--quiet vid__key"),
        );
      }

      if (animated) {
        const count = (bag[spec.key] as { keyframes: unknown[] }).keyframes.length;
        const badge = document.createElement("span");
        badge.className = "vid__kfcount";
        badge.textContent = `${count} keys · drag a point to move it, double-click to remove`;
        row.appendChild(badge);
        row.appendChild(keyframeGraph(bag, spec.key, spec, clip, dur));
      }
    }

    return row;
  }

  // ------------------------------------------------------------ field makers

  function numField(label: string, value: number, min: number, max: number, step: number, onSet: (v: number) => void) {
    const wrap = document.createElement("label");
    wrap.className = "vid__field";
    const span = document.createElement("span");
    span.className = "vid__fieldlabel";
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Number(value.toFixed(3)));
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) { onSet(v); renderInspector(); }
    });
    wrap.append(span, input);
    return wrap;
  }

  function textField(label: string, value: string, onSet: (v: string) => void) {
    const wrap = document.createElement("label");
    wrap.className = "vid__field";
    const span = document.createElement("span");
    span.className = "vid__fieldlabel";
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.addEventListener("change", () => onSet(input.value));
    wrap.append(span, input);
    return wrap;
  }

  function checkField(label: string, value: boolean, onSet: (v: boolean) => void) {
    const wrap = document.createElement("label");
    wrap.className = "vid__check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = value;
    cb.addEventListener("change", () => onSet(cb.checked));
    wrap.append(cb, document.createTextNode(` ${label}`));
    return wrap;
  }

  // ------------------------------------------------------------- multicam

  /** The group the monitor's angle grid shows, or null. */
  let multicamView: string | null = null;

  const groupById = (id: string) => (project.multicam ?? []).find((g) => g.id === id) ?? null;

  /** Sync the selected clips' sources by their audio and make them one
   *  multicam group, with a clip on a new top track showing the first angle. */
  async function createMulticam() {
    if (!isTauri()) { say("Multicam sync needs the desktop app.", true); return; }
    const picked = editableClips().filter(({ clip }) => clip.source.type === "media");
    const paths = [...new Set(picked.map(({ clip }) => (clip.source as { path: string }).path))];
    if (paths.length < 2) { say("Select clips from at least two cameras.", true); return; }
    say(`Syncing ${paths.length} angles by their audio…`);
    try {
      const [synced, infos] = await Promise.all([
        api.audioSync(paths[0], paths.slice(1)),
        Promise.all(paths.map((p) => api.probeMedia(p))),
      ]);
      const angles = paths.map((path, i) => ({
        path,
        name: basename(path),
        offset: i === 0 ? 0 : synced[i - 1].offset,
        duration: infos[i].duration,
      }));
      const doubtful = synced.map((r, i) => (r.confidence < 5 ? angles[i + 1].name : "")).filter(Boolean);
      const group = { id: crypto.randomUUID(), name: `Multicam ${(project.multicam?.length ?? 0) + 1}`, angles };
      const [lo, hi] = multicamSpan(group);
      if (hi - lo < 0.5) { say("Those recordings do not overlap enough to cut between.", true); return; }
      const start = Math.min(...picked.map(({ clip }) => clip.start));
      let made: Clip | null = null;
      edit(() => {
        (project.multicam ??= []).push(group);
        const track = newTrack(group.name, "video");
        const clip = makeClip({ type: "media", path: angles[0].path }, start, hi, lo);
        clip.multicam = { group: group.id, angle: 0 };
        clip.name = group.name;
        track.clips.push(clip);
        // Above everything, so the cut is what the programme shows.
        project.tracks.push(track);
        // The source clips would otherwise play their own sound underneath.
        for (const { clip: c } of picked) c.muted = true;
        made = clip;
      }, "Create multicam");
      const m = made as Clip | null;
      if (m) selectOnly([m.id], m.id);
      multicamView = group.id;
      multicamBtn.setAttribute("aria-pressed", "true");
      preview.setMulticamView(group);
      render();
      say(doubtful.length
        ? `Created ${group.name}, but the sync is doubtful for ${doubtful.join(", ")}. Check it before cutting.`
        : `Created ${group.name} with ${angles.length} angles; the source clips are muted. Press 1–${Math.min(9, angles.length)} or click an angle to cut.`,
        doubtful.length > 0);
    } catch (e) {
      say(`Could not sync: ${e}`, true);
    }
  }

  function toggleMulticamView() {
    if (multicamView) {
      multicamView = null;
      preview.setMulticamView(null);
    } else {
      const sel = selected();
      const id = sel?.clip.multicam?.group ?? project.multicam?.[0]?.id;
      const group = id ? groupById(id) : null;
      if (!group) { say("Create a multicam group first: select clips from each camera.", true); return; }
      multicamView = group.id;
      preview.setMulticamView(group);
      say(`${group.name}: press 1–${Math.min(9, group.angles.length)} or click an angle to cut, live or paused.`);
    }
    multicamBtn.setAttribute("aria-pressed", String(multicamView !== null));
  }

  /** Cut the programme to an angle at the playhead, as Premiere's multicam
   *  monitor does: the clip under the playhead is split there and the part
   *  from here on shows the new angle. Works during playback. */
  function cutToAngle(angle: number) {
    const group = multicamView ? groupById(multicamView) : null;
    if (!group || !group.angles[angle]) return;
    const hit = preview.multicamAt(group.id);
    const found = hit ? findClip(project, hit.clip.id) : null;
    if (!found) { say("No multicam clip at the playhead.", true); return; }
    if (found.track.locked) { say(`${found.track.name} is locked.`, true); return; }
    if (found.clip.multicam?.angle === angle) return;
    const trial = structuredClone(found.clip);
    if (!switchAngle(trial, group, angle)) {
      say(`${group.angles[angle].name} was not rolling for all of this clip.`, true);
      return;
    }
    const t = preview.time;
    edit(() => {
      const right = splitClip(found.track, found.clip, t);
      switchAngle(right ?? found.clip, group, angle);
    }, `Cut to angle ${angle + 1}`);
    say(`Cut to ${group.angles[angle].name} at ${tc(t, project.fps)}.`);
  }

  // ------------------------------------------------------------- tracking

  let tracking = false;

  /** Where a clip's picture sits inside the layer its effects see: the full
   *  frame when the clip has no motion (the renderer pads it), otherwise the
   *  fitted picture's own box. Masks are percentages of that layer. */
  async function pictureBox(clip: Clip): Promise<{ lw: number; lh: number; ox: number; oy: number; pw: number; ph: number } | null> {
    if (clip.source.type !== "media") return null;
    const info = await api.probeMedia(clip.source.path);
    if (!info.width || !info.height) return null;
    const W = project.width, H = project.height;
    const fit = Math.min(W / info.width, H / info.height);
    const pw = Math.round(info.width * fit), ph = Math.round(info.height * fit);
    return isIdentityMotion(clip.motion)
      ? { lw: W, lh: H, ox: (W - pw) / 2, oy: (H - ph) / 2, pw, ph }
      : { lw: pw, lh: ph, ox: 0, oy: 0, pw, ph };
  }

  /** Track the region under a mask and keyframe the mask onto it. */
  async function trackMask(clip: Clip, mask: Extract<Effect, { kind: "mask" }>) {
    if (!isTauri()) { say("Tracking needs the desktop app.", true); return; }
    if (clip.source.type !== "media") { say("Only video clips can be tracked.", true); return; }
    if (isAnimated(clip.speed) || clip.reverse) { say("Tracking needs a clip at a constant forward speed.", true); return; }
    const speed = Math.max(0.01, Math.abs(paramAt(clip.speed, 0)));
    const dur = clipDuration(clip);
    const fromLocal = preview.time >= clip.start && preview.time < clip.start + dur ? preview.time - clip.start : 0;
    const box = await pictureBox(clip).catch(() => null);
    if (!box) { say("Could not read the clip's picture size.", true); return; }
    const pct = (p: Param) => paramAt(p, fromLocal) / 100;
    // Mask centre and size, from layer percentages to the source picture.
    const region = {
      x: (pct(mask.x) * box.lw - box.ox) / box.pw,
      y: (pct(mask.y) * box.lh - box.oy) / box.ph,
      w: (pct(mask.width) * box.lw) / box.pw,
      h: (pct(mask.height) * box.lh) / box.ph,
    };
    if (region.x < 0 || region.x > 1 || region.y < 0 || region.y > 1) {
      say("Move the mask over the picture before tracking.", true);
      return;
    }
    tracking = true;
    renderInspector();
    say("Tracking…");
    try {
      const start = clip.in_point + fromLocal * speed;
      const res = await api.trackRegion(clip.source.path, start, clip.out_point, Math.min(15, project.fps), region);
      edit(() => {
        let x: Param = mask.x;
        let y: Param = mask.y;
        // Keyframes already inside the tracked span would fight the track.
        const lastT = (res.points[res.points.length - 1].t - clip.in_point) / speed;
        const strip = (p: Param): Param => isAnimated(p)
          ? { keyframes: p.keyframes.filter((k) => k.time < fromLocal - 1e-3 || k.time > lastT + 1e-3) }
          : p;
        x = strip(x);
        y = strip(y);
        for (const pt of res.points) {
          const local = (pt.t - clip.in_point) / speed;
          x = setKeyframe(x, local, Number((((box.ox + pt.x * box.pw) / box.lw) * 100).toFixed(3)));
          y = setKeyframe(y, local, Number((((box.oy + pt.y * box.ph) / box.lh) * 100).toFixed(3)));
        }
        mask.x = x;
        mask.y = y;
      }, "Track mask");
      const end = clip.start + (res.points[res.points.length - 1].t - clip.in_point) / speed;
      say(res.lost
        ? `Tracked to ${tc(end, project.fps)}, where the subject was lost. Move the mask and track again from there.`
        : `Tracked ${res.points.length} positions to the end of the clip.`, res.lost);
    } catch (e) {
      say(`Tracking failed: ${e}`, true);
    } finally {
      tracking = false;
      renderInspector();
    }
  }

  /** Keyframe a text overlay to move with the clip's tracked mask, keeping
   *  the offset it has from the mask now. */
  function followMask(clip: Clip, text: Extract<Effect, { kind: "text" }>) {
    const mask = clip.effects.find((m): m is Extract<Effect, { kind: "mask" }> =>
      m.kind === "mask" && (isAnimated(m.x) || isAnimated(m.y)));
    if (!mask) { say("Track a mask on this clip first.", true); return; }
    const W = project.width, H = project.height;
    // Text is placed in layer pixels and the mask in layer percent; with no
    // motion the layer is the frame, which is also what the monitor shows.
    const times = new Set<number>();
    for (const p of [mask.x, mask.y]) if (isAnimated(p)) for (const k of p.keyframes) times.add(k.time);
    const sorted = [...times].sort((a, b) => a - b);
    const t0 = Math.max(0, Math.min(clipDuration(clip), preview.time - clip.start));
    const mx0 = (paramAt(mask.x, t0) / 100) * W, my0 = (paramAt(mask.y, t0) / 100) * H;
    const tx0 = paramAt(text.x, t0), ty0 = paramAt(text.y, t0);
    edit(() => {
      let x: Param = tx0;
      let y: Param = ty0;
      for (const t of sorted) {
        x = setKeyframe(x, t, Number((tx0 + (paramAt(mask.x, t) / 100) * W - mx0).toFixed(2)));
        y = setKeyframe(y, t, Number((ty0 + (paramAt(mask.y, t) / 100) * H - my0).toFixed(2)));
      }
      text.x = x;
      text.y = y;
    }, "Text follows mask");
    say(`The text now follows the mask through ${sorted.length} keyframes.`);
  }

  // ---------------------------------------------------------------- mixer

  /** Rebuild the mixer strips. Meter bars are updated separately, per frame. */
  function renderMixer() {
    mixer.hidden = !mixerOpen;
    if (!mixerOpen) return;
    mixer.replaceChildren();

    const head = document.createElement("div");
    head.className = "vid__mixerhead";
    const h = document.createElement("h3");
    h.textContent = "Mixer";
    const anySolo = project.tracks.some((t) => t.solo);
    const note = document.createElement("span");
    note.className = "vid__mixernote";
    note.textContent = anySolo ? "Solo active. Other tracks are silent." : "";
    head.append(h, note);
    mixer.appendChild(head);

    const strips = document.createElement("div");
    strips.className = "vid__strips";

    for (const track of project.tracks) {
      const strip = document.createElement("div");
      strip.className = "vid__strip";
      strip.dataset.kind = track.kind;

      const name = document.createElement("span");
      name.className = "vid__stripname";
      name.textContent = track.name;

      // Meter: a bar scaled on the Y axis, so only transform animates.
      const meter = document.createElement("div");
      meter.className = "vid__meter";
      meter.dataset.track = track.id;
      const fill = document.createElement("span");
      fill.className = "vid__meterfill";
      meter.appendChild(fill);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "2";
      slider.step = "0.01";
      slider.value = String(track.volume);
      slider.className = "vid__vol";
      slider.setAttribute("aria-label", `${track.name} volume`);

      const readout = document.createElement("output");
      readout.className = "vid__voldb";
      readout.textContent = dbLabel(track.volume);

      // A fader drag mutates the project live so the sound follows the hand,
      // which means the undo snapshot must be taken before the first mutation,
      // not at commit time — by then the change is already in `project`.
      let preDrag: string | null = null;
      slider.addEventListener("input", () => {
        if (preDrag === null) preDrag = JSON.stringify(saved);
        track.volume = Number(slider.value);
        readout.textContent = dbLabel(track.volume);
        preview.refreshMix();
      });
      slider.addEventListener("change", () => {
        track.volume = Number(slider.value);
        if (preDrag !== null) {
          // One undo entry per drag, holding the value from before it started.
          history.push(JSON.parse(preDrag) as Project);
          preDrag = null;
        }
        commit();
      });

      const buttons = document.createElement("div");
      buttons.className = "vid__stripbtns";
      const mute = toggle(track.muted ? "speaker-slash" : "speaker-high",
                          track.muted ? "Unmute track" : "Mute track", track.muted, () => {
        edit(() => { track.muted = !track.muted; });
        preview.refreshMix();
        renderMixer();
      });
      const solo = toggle("headphones", track.solo ? "Unsolo track" : "Solo track", track.solo, () => {
        edit(() => { track.solo = !track.solo; });
        preview.refreshMix();
        renderMixer();
      });
      solo.classList.add("vid__solo");
      buttons.append(mute, solo);

      // Pan, as the Audio Track Mixer's knob; double-click centres it.
      const pan = document.createElement("input");
      pan.type = "range";
      pan.min = "-1";
      pan.max = "1";
      pan.step = "0.05";
      pan.value = String(track.pan);
      pan.className = "vid__pan";
      pan.setAttribute("aria-label", `${track.name} pan`);
      pan.title = `Pan ${panLabel(track.pan)}. Double-click to centre.`;
      let prePan: string | null = null;
      pan.addEventListener("input", () => {
        prePan ??= JSON.stringify(saved);
        track.pan = Number(pan.value);
        pan.title = `Pan ${panLabel(track.pan)}`;
        preview.refreshMix();
      });
      pan.addEventListener("change", () => {
        if (prePan !== null) { history.push(JSON.parse(prePan) as Project, "Pan"); prePan = null; }
        commit();
      });
      pan.addEventListener("dblclick", () => { edit(() => { track.pan = 0; }, "Centre pan"); preview.refreshMix(); });

      strip.append(name, meter, slider, readout, pan, buttons);
      strips.appendChild(strip);
    }

    // The master bus: every track feeds it, and the export applies it last.
    const master = document.createElement("div");
    master.className = "vid__strip vid__strip--master";
    const mName = document.createElement("span");
    mName.className = "vid__stripname";
    mName.textContent = "Master";
    const mMeter = document.createElement("div");
    mMeter.className = "vid__meter";
    mMeter.dataset.track = "master";
    const mFill = document.createElement("span");
    mFill.className = "vid__meterfill";
    const mClip = document.createElement("span");
    mClip.className = "vid__clipled";
    mClip.title = "Lights when the master bus reaches full scale";
    mMeter.append(mFill, mClip);
    const mSlider = document.createElement("input");
    mSlider.type = "range";
    mSlider.min = "0";
    mSlider.max = "2";
    mSlider.step = "0.01";
    mSlider.value = String(project.master_volume);
    mSlider.className = "vid__vol";
    mSlider.setAttribute("aria-label", "Master volume");
    const mReadout = document.createElement("output");
    mReadout.className = "vid__voldb";
    mReadout.textContent = dbLabel(project.master_volume);
    let preMaster: string | null = null;
    mSlider.addEventListener("input", () => {
      preMaster ??= JSON.stringify(saved);
      project.master_volume = Number(mSlider.value);
      mReadout.textContent = dbLabel(project.master_volume);
      preview.refreshMix();
    });
    mSlider.addEventListener("change", () => {
      if (preMaster !== null) { history.push(JSON.parse(preMaster) as Project, "Master volume"); preMaster = null; }
      commit();
    });
    master.append(mName, mMeter, mSlider, mReadout);
    strips.appendChild(master);
    strips.appendChild(loudnessPanel());

    mixer.appendChild(strips);
  }

  /** EBU R128 readouts: live from the monitor's master bus, and, on request,
   *  measured by ffmpeg from the actual export. */
  function loudnessPanel(): HTMLElement {
    const box = document.createElement("div");
    box.className = "vid__r128";
    const title = document.createElement("h4");
    title.textContent = "Loudness";
    const target = selectField("Target", String(loudTarget), [
      ["-14", "−14 LUFS · streaming"], ["-16", "−16 LUFS · podcast, web"],
      ["-23", "−23 LUFS · EBU R128"], ["-24", "−24 LUFS · ATSC A/85"],
    ], (v) => { loudTarget = Number(v); renderMixer(); });

    const grid = document.createElement("dl");
    grid.className = "vid__r128grid";
    for (const [key, label, hint] of [
      ["momentary", "M", "Momentary: the last 400 ms"],
      ["shortTerm", "S", "Short-term: the last 3 s"],
      ["integrated", "I", "Integrated: gated, since reset"],
      ["peak", "Peak", "Sample peak since reset, dBFS"],
    ] as const) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      dt.title = hint;
      const dd = document.createElement("dd");
      dd.dataset.r128 = key;
      dd.textContent = "—";
      grid.append(dt, dd);
    }

    const reset = btn("Reset", () => { preview.loudnessMeter()?.reset(); updateLoudness(true); });
    reset.title = "Start the integrated measurement again";
    const measure = btn(measuringLoudness ? "Measuring…" : "Measure export", () => void measureExportLoudness());
    measure.title = "Render the mix through ffmpeg and measure it with ebur128, as delivery QC would";
    measure.disabled = measuringLoudness;

    const report = document.createElement("p");
    report.className = "vid__r128report";
    const current = exportLoudness && exportLoudness.key === loudKey() ? exportLoudness.report : null;
    if (current) {
      const off = current.integrated - loudTarget;
      report.textContent = `Export: ${fmtLufs(current.integrated)} integrated, LRA ${current.range.toFixed(1)} LU, `
        + `true peak ${current.true_peak.toFixed(1)} dBTP. `
        + (Math.abs(off) <= 1 ? "On target." : `${Math.abs(off).toFixed(1)} LU ${off > 0 ? "over" : "under"} target.`)
        + (current.true_peak > -1 ? " True peak above −1 dBTP." : "");
      report.dataset.state = Math.abs(off) <= 1 && current.true_peak <= -1 ? "ok" : "warn";
    } else {
      report.textContent = exportLoudness
        ? "The timeline changed since the last measurement."
        : "The live meter follows the monitor, which skips ffmpeg's audio effects. Measure the export for delivery.";
    }
    box.append(title, target, grid, reset, measure, report);
    return box;
  }

  /** What the export measurement depends on, so a stale one is flagged. */
  function loudKey(): string {
    return JSON.stringify(renderable(project).tracks);
  }

  const fmtLufs = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : "—");

  async function measureExportLoudness() {
    if (!isTauri()) { say("Measuring the export needs the desktop app.", true); return; }
    measuringLoudness = true;
    renderMixer();
    const key = loudKey();
    try {
      exportLoudness = { report: await api.measureLoudness(project), key };
      say(`Export loudness: ${fmtLufs(exportLoudness.report.integrated)}.`);
    } catch (e) {
      say(`Could not measure loudness: ${e}`, true);
    } finally {
      measuringLoudness = false;
      renderMixer();
    }
  }

  /** Refresh the live readouts, a few times a second so they can be read. */
  function updateLoudness(force = false) {
    const now = performance.now();
    if (!force && now - loudTick < 200) return;
    loudTick = now;
    const meter = preview.loudnessMeter();
    if (meter) meter.active = preview.playing;
    const r = meter?.reading();
    for (const dd of mixer.querySelectorAll<HTMLElement>("[data-r128]")) {
      const key = dd.dataset.r128 as "momentary" | "shortTerm" | "integrated" | "peak";
      const v = r ? r[key] : -Infinity;
      dd.textContent = key === "peak"
        ? (Number.isFinite(v) ? `${v.toFixed(1)} dB` : "—")
        : fmtLufs(v);
      // Short-term and integrated are the figures delivery specs quote.
      if (key === "integrated" || key === "shortTerm") {
        dd.dataset.state = !Number.isFinite(v) ? "" : Math.abs(v - loudTarget) <= 1 ? "ok" : v > loudTarget ? "over" : "under";
      }
      if (key === "peak") dd.dataset.state = Number.isFinite(v) && v > -1 ? "over" : "";
    }
  }

  function panLabel(p: number): string {
    if (Math.abs(p) < 0.01) return "centre";
    return `${Math.round(Math.abs(p) * 100)} ${p < 0 ? "L" : "R"}`;
  }

  function dbLabel(v: number): string {
    if (v <= 0.0001) return "−∞";
    const db = 20 * Math.log10(v);
    return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
  }

  /** Drive the meter bars. Runs only while the mixer is open and playing. */
  function meterLoop() {
    if (!mixerOpen) { meterRaf = 0; return; }
    for (const el of mixer.querySelectorAll<HTMLElement>(".vid__meter")) {
      const id = el.dataset.track ?? "";
      const level = preview.playing ? preview.levelOf(id) : 0;
      const fill = el.firstElementChild as HTMLElement | null;
      if (fill) fill.style.transform = `scaleY(${level.toFixed(3)})`;
      // The clip light holds for a second and a half after a full-scale peak.
      if (level >= 0.999) el.dataset.clipped = String(performance.now());
      if (el.dataset.clipped && performance.now() - Number(el.dataset.clipped) > 1500) delete el.dataset.clipped;
    }
    updateLoudness();
    meterRaf = requestAnimationFrame(meterLoop);
  }

  function toggleMixer() {
    mixerOpen = !mixerOpen;
    mixerBtn.setAttribute("aria-pressed", String(mixerOpen));
    renderMixer();
    if (mixerOpen && !meterRaf) meterRaf = requestAnimationFrame(meterLoop);
  }

  // ------------------------------------------------------------- keyboard

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
    if (typing) return;
    if (!host.isConnected) return;
    // A modal owns the keyboard: Space must not start playback behind the
    // export dialog, and Delete must not remove a clip the user cannot see.
    if (document.querySelector("dialog[open]")) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Chords first, so a plain letter below never swallows its Ctrl form.
    if (ctrl) {
      const chord: Record<string, () => void> = {
        a: () => (e.shiftKey ? deselectAll() : selectAll()),
        g: () => groupSelection(!e.shiftKey),
        l: toggleLink,
        x: cutSelection,
        k: () => (e.shiftKey ? razorAllTracks() : splitAtPlayhead()),
        r: speedDialog,
        d: () => applyDefaultTransition(e.shiftKey ? "audio" : "video"),
        m: () => void openRenderDialog(),
        i: () => { if (e.shiftKey) edit(() => { project.zone_in = null; }, "Clear in"); },
        o: () => { if (e.shiftKey) edit(() => { project.zone_out = null; }, "Clear out"); },
        e: () => { if (e.shiftKey) void exportFrame(); },
        " ": () => { if (e.shiftKey) playInToOut(); },
        v: () => (e.altKey ? pasteAttributes() : e.shiftKey ? pasteInsert() : pasteAtPlayhead()),
        c: copySelection,
      };
      const run = chord[key];
      if (run) { e.preventDefault(); run(); }
      return;
    }
    if (multicamView && /^[1-9]$/.test(key)) {
      e.preventDefault();
      cutToAngle(Number(key) - 1);
      return;
    }
    switch (key) {
      case " ": e.preventDefault(); preview.toggle(); break;
      case "j": e.preventDefault(); shuttleKey("j"); break;
      case "k": e.preventDefault(); e.shiftKey ? playAround() : shuttleKey("k"); break;
      case "l": e.preventDefault(); shuttleKey("l"); break;
      case "s": e.preventDefault(); splitAtPlayhead(); break;
      case "m": e.preventDefault(); addMarker(); break;
      case "i": e.preventDefault(); e.shiftKey ? goToZone("in") : setZoneIn(); break;
      case "o": e.preventDefault(); e.shiftKey ? goToZone("out") : setZoneOut(); break;
      case "q": e.preventDefault(); rippleTrimToPlayhead("previous"); break;
      case "w": e.preventDefault(); rippleTrimToPlayhead("next"); break;
      case "x": e.preventDefault(); markClip(); break;
      case "a": e.preventDefault(); trackSelect(e.shiftKey ? -1 : 1); break;
      case "g": e.preventDefault(); gainDialog(); break;
      case ";": e.preventDefault(); liftZone(); break;
      case "'": e.preventDefault(); extractZone(); break;
      case "=": case "+": e.preventDefault(); pxPerSec = Math.min(MAX_PX_PER_SEC, pxPerSec * 1.5); renderTracks(); break;
      case "-": case "_": e.preventDefault(); pxPerSec = Math.max(MIN_PX_PER_SEC, pxPerSec / 1.5); renderTracks(); break;
      case "\\": e.preventDefault(); zoomToFit(); break;
      case "ArrowUp": e.preventDefault(); jumpEdit(-1); break;
      case "ArrowDown": e.preventDefault(); jumpEdit(1); break;
      case "Escape":
        if (selection.size === 0 && nestPath.length) closeNested();
        else deselectAll();
        break;
      case "Delete": case "Backspace": e.preventDefault(); e.shiftKey ? rippleDelete() : deleteSelected(); break;
      case "ArrowRight": e.preventDefault(); preview.seek(preview.time + (e.shiftKey ? 1 : 1 / project.fps)); break;
      case "ArrowLeft": e.preventDefault(); preview.seek(preview.time - (e.shiftKey ? 1 : 1 / project.fps)); break;
      case "Home": e.preventDefault(); preview.seek(0); break;
      case "[": e.preventDefault(); jumpEdit(-1); break;
      case "]": e.preventDefault(); jumpEdit(1); break;
      // Shift turns , and . into < and > on most layouts.
      case ",": case "<": e.preventDefault(); nudge(-1, e.shiftKey); break;
      case ".": case ">": e.preventDefault(); nudge(1, e.shiftKey); break;
      case "f": e.preventDefault(); zoomToFit(); break;
      case "e": e.preventDefault(); toggleClipEnabled(); break;
      case "End": e.preventDefault(); preview.seek(projectDuration(project)); break;
    }
  }
  document.addEventListener("keydown", onKey);

  // ---------------------------------------------------------------- start

  function render() {
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();
    renderTracks();
    renderInspector();
    renderMixer();
    renderHistory();
    renderCrumbs();
    timecode.textContent = `${fmtTime(preview.time)} / ${fmtTime(projectDuration(project))}`;
  }

  render();
  void loadThumbs();
  void loadWaveforms();
  attachMonitorControls();
  void listenForFileDrops();
  void refreshOffline();
  lastAutosave = JSON.stringify(saved);
  scheduleAutosave();
  // The plugin list is a filesystem scan, so fetch it once and redraw when it
  // lands rather than blocking the first paint.
  void api
    .frei0rPlugins()
    .then((list) => { frei0r = list; renderInspector(); })
    .catch(() => { /* no frei0r, or running outside Tauri: the select stays disabled */ });

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKey);
      // A last snapshot on the way out, then stop the timer.
      void autosaveNow();
      window.clearInterval(autosaveTimer);
      unlistenDrop?.();
      if (meterRaf) cancelAnimationFrame(meterRaf);
      meterRaf = 0;
      if (scopeRaf) cancelAnimationFrame(scopeRaf);
      scopeRaf = 0;
      preview.destroy();
      host.replaceChildren();
    },
  };
}
