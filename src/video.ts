/** Odyssey Video — the editor: transport, multi-track timeline, effects,
 *  keyframes, undo and rendering. */
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type Item, type MediaInfo } from "./api";
import { isTauri } from "./devstore";
import type { Editor } from "./docs";
import { Preview } from "./preview";
import { drawScope, SCOPE_LABELS, type ScopeKind } from "./scopes";
import {
  ANIMATION_ROUTE, ROUTE_LABEL, EFFECT_CATALOGUE, EFFECT_PARAMS, History, clipDuration, clipEnd, emptyProject,
  findClip, isAnimated, newTrack, paramAt, projectDuration, removeKeyframe,
  resolveCollision, setKeyframe, sourceDuration, sourceTimeAt, splitClip, makeFrei0r,
  defaultMotion, BLEND_LABELS, MOTION_PARAMS, TRANSITION_LABELS,
  type BlendMode, type TransitionKind, type Clip, type Effect, type Param,
  type BinItem, type Frei0rPlugin, type PreviewChunk, type Project, type RenderJob,
  type RenderProfile, type Track,
} from "./timeline";

const MEDIA_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "flac", "m4a"];
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
  let project: Project = normalise(item.data);
  const history = new History();
  let selectedId: string | null = null;
  let pxPerSec = 40;
  let profiles: RenderProfile[] = [];
  let frei0r: Frei0rPlugin[] = [];
  const thumbs = new Map<string, string>();
  /** Peak envelopes keyed by source path, so two clips of one file share it. */
  const waves = new Map<string, number[]>();
  const wavePending = new Set<string>();
  let mixerOpen = false;
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
  let clipboard: Clip[] = [];
  let trackHeight = 66;
  /** Horizontal scroll position, preserved across the rebuilds that culling
   *  makes frequent. */
  let scrollLeft = 0;
  /** Guards against the scroll handler re-entering while lanes are rebuilding,
   *  because restoring the scroll position fires another scroll event. */
  let rebuilding = false;
  /** Which side panel the inspector column is showing. */
  type Panel = "clip" | "bin" | "subtitles";
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

  root.append(toolbar, stage, mixer, queuePanel, historyPanel, transport, tracksWrap, status);
  host.replaceChildren(root);

  // ---------------------------------------------------------------- helpers

  function normalise(data: unknown): Project {
    const d = (data ?? {}) as Partial<Project>;
    if (!Array.isArray(d.tracks) || !d.tracks.length) return emptyProject();
    // Older saved projects predate later fields, so fill the gaps rather than
    // rejecting them. Clips and tracks are migrated in place.
    for (const t of d.tracks as Track[]) {
      t.opacity ??= 1;
      t.blend ??= "normal";
      t.targeted ??= false;
      t.duck_under ??= null;
      for (const c of t.clips) {
        c.motion ??= defaultMotion();
        c.blend ??= "normal";
        c.channels ??= [];
        c.preserve_pitch ??= true;
        c.transition_in ??= null;
      }
    }
    // Older saved projects predate the bin and subtitles, so fill the gaps
    // rather than rejecting them.
    return {
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
    };
  }

  /** Record history, mutate, then persist and repaint. */
  function edit(fn: () => void) {
    history.push(project);
    fn();
    commit();
  }

  function commit() {
    // Any edit may have removed the selected clip, directly or with its track.
    if (selectedId && !findClip(project, selectedId)) selectedId = null;
    preview.setProject(project);
    onChange({ data: project, body: summarise() });
    render();
    void revalidateChunks();
  }

  function summarise(): string {
    return project.tracks
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
    const picked = await open({ multiple: true, filters: [{ name: "Media", extensions: MEDIA_EXTS }] });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];

    const infos: MediaInfo[] = [];
    for (const path of paths) {
      try {
        infos.push(await api.probeMedia(path));
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
            folder: "",
            label: "",
          });
        }
        placeOnTimeline(info.path, info.duration, info.width === 0);
      }
      const first = infos[0];
      if (first.width > 0 && wasPristine) {
        project.width = first.width - (first.width % 2);
        project.height = first.height - (first.height % 2);
        project.fps = Math.round(first.fps) || 30;
      }
    });
    void loadThumbs();
    void loadWaveforms();
    say(`Added ${infos.length} clip${infos.length === 1 ? "" : "s"}.`);
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
    const clip: Clip = {
      id: crypto.randomUUID(),
      source: { type: "media", path },
      start: endOf(track),
      in_point: 0,
      out_point: duration > 0 ? duration : 5,
      speed: 1, reverse: false, gain: 1, muted: false, effects: [],
      motion: defaultMotion(), blend: "normal", channels: [], preserve_pitch: true, transition_in: null,
    };
    track.clips.push(clip);
    selectedId = clip.id;
    return clip;
  }

  /** The first unlocked track of a kind, creating one if there is none. */
  function trackFor(kind: "video" | "audio"): Track {
    const existing = project.tracks.find((t) => t.kind === kind && !t.locked);
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
      const clip: Clip = {
        id: crypto.randomUUID(),
        source: { type: "title", text: "Title", background: "#101820", size: 96, color: "white" },
        start: preview.time, in_point: 0, out_point: 3,
        speed: 1, reverse: false, gain: 1, muted: false,
        effects: [{ kind: "fade", in_secs: 0.4, out_secs: 0.4 }],
        motion: defaultMotion(), blend: "normal", channels: [], preserve_pitch: true, transition_in: null,
      };
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectedId = clip.id;
    });
    say("Title added. Edit its text in the inspector.");
  }

  function addColor() {
    edit(() => {
      const track = trackFor("video");
      const clip: Clip = {
        id: crypto.randomUUID(),
        source: { type: "color", color: "#000000" },
        start: preview.time, in_point: 0, out_point: 2,
        speed: 1, reverse: false, gain: 1, muted: false, effects: [],
        motion: defaultMotion(), blend: "normal", channels: [], preserve_pitch: true, transition_in: null,
      };
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectedId = clip.id;
    });
  }

  function splitAtPlayhead() {
    const sel = editableSelection();
    if (!sel) return;
    const t = preview.time;
    if (t <= sel.clip.start || t >= clipEnd(sel.clip)) {
      say("Move the playhead over the selected clip first.", true);
      return;
    }
    edit(() => {
      const right = splitClip(sel.track, sel.clip, t);
      if (right) selectedId = right.id;
    });
    say(`Split at ${tc(t, project.fps)}.`);
  }

  function deleteSelected() {
    const sel = editableSelection();
    if (!sel) return;
    const name = labelOf(sel.clip);
    edit(() => {
      sel.track.clips = sel.track.clips.filter((c) => c.id !== sel.clip.id);
      selectedId = null;
    });
    // A destructive action with no feedback left the previous status standing,
    // which read as though nothing had happened.
    say(`Removed ${name}.`);
  }

  function duplicateSelected() {
    const sel = editableSelection();
    if (!sel) return;
    edit(() => {
      const copy: Clip = { ...structuredClone(sel.clip), id: crypto.randomUUID(), start: clipEnd(sel.clip) };
      resolveCollision(sel.track, copy);
      sel.track.clips.push(copy);
      selectedId = copy.id;
    });
  }

  function undo() {
    const prev = history.undo(project);
    if (!prev) { say("Nothing to undo."); return; }
    project = prev;
    commit();
    say("Undone.");
  }

  function redo() {
    const next = history.redo(project);
    if (!next) { say("Nothing to redo."); return; }
    project = next;
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
          const prev = history.undo(project);
          if (!prev) break;
          project = prev;
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
    ["S", "Split at the playhead"],
    ["Delete", "Remove the selected clip"],
    ["M", "Add a marker"],
    ["I / O", "Set the zone in and out"],
    ["[ / ]", "Jump to the previous or next edit"],
    [", / .", "Nudge one frame (shift for a second)"],
    ["Ctrl+C / Ctrl+V", "Copy and paste a clip"],
    ["F", "Zoom to fit"],
    ["E", "Enable or disable the clip"],
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
      const nested: Clip = {
        id: crypto.randomUUID(),
        source: { type: "nested", name: track.name, project: inner },
        start: 0,
        in_point: 0,
        out_point: span,
        speed: 1, reverse: false, channels: [], preserve_pitch: true,
        gain: 1, muted: false, effects: [],
        motion: defaultMotion(), blend: "normal", transition_in: null,
      };
      track.clips = [nested];
      selectedId = nested.id;
    });
    say(`Nested ${track.name} into one clip.`);
  }

  // ------------------------------------------------------- clip operations

  /** Nudge the selected clip by one frame, or a second with shift. */
  function nudge(direction: -1 | 1, big: boolean) {
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

  function copySelection() {
    const sel = selected();
    if (!sel) { say("Nothing selected to copy.", true); return; }
    clipboard = [structuredClone(sel.clip)];
    say(`Copied ${labelOf(sel.clip)}.`);
  }

  function pasteAtPlayhead() {
    if (!clipboard.length) { say("The clipboard is empty.", true); return; }
    edit(() => {
      const track = trackFor("video");
      for (const source of clipboard) {
        const copy: Clip = { ...structuredClone(source), id: crypto.randomUUID(), start: preview.time };
        resolveCollision(track, copy);
        track.clips.push(copy);
        selectedId = copy.id;
      }
    });
    say(`Pasted at ${tc(preview.time, project.fps)}.`);
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
    const sel = editableSelection();
    if (!sel) return;
    const hidden = sel.clip.motion.opacity === 0;
    edit(() => {
      sel.clip.motion.opacity = hidden ? 1 : 0;
      sel.clip.muted = !hidden;
    });
    say(hidden ? "Clip enabled." : "Clip disabled; it stays on the timeline.");
  }

  /** Scale the clip so it fills the frame, or put it back to its own size. */
  function fitClip(fill: boolean) {
    const sel = editableSelection();
    if (!sel) return;
    edit(() => {
      sel.clip.motion.scale = fill ? 100 : 100;
      sel.clip.motion.x = 0;
      sel.clip.motion.y = 0;
      sel.clip.motion.rotation = 0;
    });
    say(fill ? "Clip reset to fill the frame." : "Motion reset.");
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
    });
    say("Audio split onto its own track; the video clip is muted.");
  }

  function addAdjustmentLayer() {
    edit(() => {
      const track = trackFor("video");
      const clip: Clip = {
        id: crypto.randomUUID(),
        source: { type: "adjustment" },
        start: preview.time,
        in_point: 0,
        out_point: 3,
        speed: 1, reverse: false, gain: 1, muted: true, effects: [],
        motion: defaultMotion(), blend: "normal", channels: [], preserve_pitch: true, transition_in: null,
      };
      resolveCollision(track, clip);
      track.clips.push(clip);
      selectedId = clip.id;
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
        const clip: Clip = {
          id: crypto.randomUUID(),
          source: { type: "still", path: png },
          start: preview.time,
          in_point: 0, out_point: 2,
          speed: 1, reverse: false, gain: 1, muted: true, effects: [],
          motion: defaultMotion(), blend: "normal", channels: [], preserve_pitch: true, transition_in: null,
        };
        resolveCollision(track, clip);
        track.clips.push(clip);
        selectedId = clip.id;
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

  async function openRenderDialog() {
    if (!projectDuration(project)) { say("Add a clip before exporting.", true); return; }
    if (!profiles.length) {
      try { profiles = await api.renderProfiles(); } catch (e) { say(String(e), true); return; }
    }

    const dialog = document.createElement("dialog");
    dialog.className = "vid__dialog";

    const h = document.createElement("h2");
    h.textContent = "Export";

    const list = document.createElement("div");
    list.className = "vid__profiles";
    let chosen = profiles[0];
    profiles.forEach((p, i) => {
      const id = `profile-${i}`;
      const label = document.createElement("label");
      label.className = "vid__profile";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "profile";
      radio.id = id;
      radio.checked = i === 0;
      radio.addEventListener("change", () => { if (radio.checked) chosen = p; });
      const text = document.createElement("span");
      text.textContent = p.label;
      label.append(radio, text);
      list.appendChild(label);
    });

    const meta = document.createElement("p");
    meta.className = "vid__dialogmeta";
    meta.textContent =
      `${tc(projectDuration(project), project.fps)} · ${project.width}×${project.height} · ${project.fps} fps`;

    const actions = document.createElement("div");
    actions.className = "vid__dialogactions";
    const cancel = btn("Cancel", () => dialog.close());
    const go = btn("Export…", async () => {
      const out = await save({
        defaultPath: `${item.title || "odyssey"}.${chosen.container}`,
        filters: [{ name: chosen.label, extensions: [chosen.container] }],
      });
      if (!out) return;
      dialog.close();
      go.disabled = true;
      say(`Rendering ${tc(projectDuration(project), project.fps)}…`);
      try {
        const written = await api.renderProject(project, chosen, out);
        say(`Exported to ${basename(written)}`);
      } catch (e) {
        say(`Export failed. ${String(e)}`, true);
      } finally {
        go.disabled = false;
      }
    }, "btn btn--primary");

    actions.append(cancel, go);
    dialog.append(h, meta, list, actions);
    root.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  }

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

  // ---------------------------------------------------------------- toolbar

  const guidesBtn = iconBtn("grid-four", "Safe margins and grid", () => toggleGuides());
  guidesBtn.setAttribute("aria-pressed", "false");
  const compareBtn = iconBtn("columns", "Compare with effects bypassed", () => toggleCompare());
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
    iconBtn("palette", "Add colour card", addColor),
    sep(),
    iconBtn("scissors", "Split at playhead (S)", splitAtPlayhead),
    iconBtn("copy", "Duplicate clip", duplicateSelected),
    iconBtn("trash", "Delete clip (Del)", deleteSelected),
    iconBtn("arrows-in-line-horizontal", "Ripple delete, closing the gap", rippleDelete),
    iconBtn("scissors", "Razor every track at the playhead", razorAllTracks),
    iconBtn("arrows-out-line-horizontal", "Insert a second of space", () => insertSpace(1)),
    iconBtn("arrows-in-simple", "Close the gap at the playhead", removeSpace),
    iconBtn("crosshair", "Match frame", matchFrame),
    iconBtn("waveform-slash", "Split audio onto its own track", splitAudio),
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
    iconBtn("file-arrow-down", "Export an EDL", () => void exportInterchange("edl")),
    iconBtn("tree-structure", "Export OpenTimelineIO", () => void exportInterchange("otio")),
    iconBtn("scan", "Detect cuts in the selected clip", () => void detectScenes()),
    iconBtn("frame-corners", "Nest this track into one clip", nestSelectedTrack),
    iconBtn("arrows-out", "Zoom to fit (F)", zoomToFit),
    iconBtn("layout", "Workspaces", showWorkspaces),
    iconBtn("keyboard", "Keyboard and mouse", showShortcuts)
  );

  // -------------------------------------------------------------- transport

  const playBtn = iconBtn("play", "Play or pause (Space)", () => preview.toggle(), "btn btn--primary");
  const timecode = document.createElement("span");
  timecode.className = "vid__tc";
  timecode.setAttribute("aria-live", "off");

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
    timecode,
    heightSelect,
    resSelect,
    guidesBtn,
    compareBtn,
    ...scopeButtons,
    zoomOut, zoomIn
  );

  preview.onTick = (t) => {
    timecode.textContent = `${tc(t, project.fps)} / ${tc(projectDuration(project), project.fps)}`;
    monitor.dataset.rendered = String(preview.usingRendered);
    const glyph = playBtn.querySelector("i");
    if (glyph) glyph.className = preview.playing ? "ph ph-pause" : "ph ph-play";
    playBtn.setAttribute("aria-label", preview.playing ? "Pause (Space)" : "Play (Space)");
    positionPlayhead();
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
      tick.textContent = tc(t, project.fps).replace(/:\d\d$/, "");
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
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "vid__marker";
      pin.style.transform = `translateX(${marker.time * pxPerSec}px)`;
      pin.style.setProperty("--marker", marker.colour);
      pin.title = marker.name
        ? `${marker.name} at ${tc(marker.time, project.fps)}`
        : `Marker at ${tc(marker.time, project.fps)}`;
      pin.setAttribute("aria-label", pin.title);
      pin.addEventListener("pointerdown", (e) => e.stopPropagation());
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        preview.seek(marker.time);
      });
      pin.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        edit(() => { project.markers = project.markers.filter((m) => m.id !== marker.id); });
        say("Marker removed.");
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

    const scrub = (e: PointerEvent) => {
      const rect = ruler.getBoundingClientRect();
      preview.seek((e.clientX - rect.left) / pxPerSec);
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
        toggle(track.muted ? "speaker-slash" : "speaker-high",
               track.muted ? "Unmute track" : "Mute track", track.muted,
               () => edit(() => { track.muted = !track.muted; }))
      );
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

      for (const clip of track.clips) {
        // A clip is drawn if any part of it falls inside the window, and the
        // selected one always is, so the inspector never points at nothing.
        if (clip.id !== selectedId && (clipEnd(clip) < viewLeft || clip.start > viewRight)) {
          culled++;
          continue;
        }
        lane.appendChild(clipElement(clip, track));
      }

      row.append(head, lane);
      lanes.appendChild(row);
    }

    const scroller = document.createElement("div");
    scroller.className = "vid__scroller";
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
    el.dataset.selected = String(clip.id === selectedId);
    el.dataset.kind = clip.source.type;
    el.style.transform = `translateX(${clip.start * pxPerSec}px)`;
    el.style.width = `${Math.max(8, dur * pxPerSec)}px`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute(
      "aria-label",
      `${labelOf(clip)}, ${tc(dur, project.fps)}, starts ${tc(clip.start, project.fps)}` +
        `${clip.muted ? ", muted" : ""}${clip.effects.length ? `, ${clip.effects.length} effects` : ""}`
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

    const select = () => { selectedId = clip.id; renderTracks(); renderInspector(); };
    el.addEventListener("pointerdown", (e) => {
      if (track.locked) { say(`${track.name} is locked.`); return; }
      select();
      const target = e.target as HTMLElement;
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
    switch (clip.source.type) {
      case "media": return basename(clip.source.path);
      case "still": return `${basename(clip.source.path)} (freeze)`;
      case "adjustment": return "Adjustment layer";
      case "title": return clip.source.text || "Title";
      case "color": return "Colour";
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
    const before = JSON.stringify(project);
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

        // Vertical drag moves the clip to another track.
        const target = trackUnder(ev.clientY);
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
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moved) { renderInspector(); return; }
      resolveCollision(currentTrack, clip);
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
    renderClipPanel();
  }

  // ------------------------------------------------------------------- bin

  function renderBin() {
    const actions = document.createElement("div");
    actions.className = "vid__binactions";
    actions.append(
      iconBtn("plus", "Add media to the bin", () => void addMedia(), "btn", true),
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
    list.className = "vid__bin";
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

      const meta = document.createElement("p");
      meta.className = "vid__binmeta";
      const bits = [tc(item.duration, project.fps)];
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
        iconBtn("swap", `Relink ${item.name} to another file`, () => void replaceFootage(item)),
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

      row.append(head, meta, props, folderField, buttons);
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
    meta.textContent = `${track.name} · ${tc(dur, project.fps)}`;
    sidebar.appendChild(meta);

    // Source-specific fields
    if (clip.source.type === "title") {
      const src = clip.source;
      sidebar.appendChild(textField("Text", src.text, (v) => edit(() => { src.text = v; })));
      sidebar.appendChild(numField("Size", src.size, 8, 400, 1, (v) => edit(() => { src.size = v; })));
      sidebar.appendChild(textField("Colour", src.color, (v) => edit(() => { src.color = v; })));
      sidebar.appendChild(textField("Background", src.background, (v) => edit(() => { src.background = v; })));
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
          ? { kind: transSelect.value as TransitionKind, duration: clip.transition_in?.duration ?? 0.5 }
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
          clip, dur)
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
    const remove = iconBtn("x", "Remove effect", () => {
      edit(() => { clip.effects.splice(index, 1); });
      renderInspector();
    }, "btn btn--quiet vid__headx");
    head.append(name, remove);
    card.appendChild(head);

    // Plain numeric fields that are not keyframable parameters.
    if (effect.kind === "fade" || effect.kind === "audiofade") {
      const e = effect;
      card.appendChild(numField("Fade in (s)", e.in_secs, 0, 60, 0.05, (v) => edit(() => { e.in_secs = Math.max(0, v); })));
      card.appendChild(numField("Fade out (s)", e.out_secs, 0, 60, 0.05, (v) => edit(() => { e.out_secs = Math.max(0, v); })));
    }
    if (effect.kind === "text") {
      const e = effect;
      card.appendChild(textField("Content", e.content, (v) => edit(() => { e.content = v; })));
      card.appendChild(numField("Size", e.size, 8, 400, 1, (v) => edit(() => { e.size = v; })));
      card.appendChild(textField("Colour", e.color, (v) => edit(() => { e.color = v; })));
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

    for (const spec of EFFECT_PARAMS[effect.kind] ?? []) {
      card.appendChild(paramRow(effect as unknown as Record<string, Param>, spec, clip, dur));
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
        const before = JSON.stringify(project);
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
    for (const [value, label] of [
      ["linear", "Linear"], ["hold", "Hold"], ["easein", "Ease in"],
      ["easeout", "Ease out"], ["easeinout", "Ease in and out"],
    ] as const) {
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
    basis: "output" | "source" = "output"
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
        if (preDrag === null) preDrag = JSON.stringify(project);
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

      strip.append(name, meter, slider, readout, buttons);
      strips.appendChild(strip);
    }

    mixer.appendChild(strips);
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
    }
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
    switch (e.key) {
      case " ": e.preventDefault(); preview.toggle(); break;
      case "s": case "S": e.preventDefault(); splitAtPlayhead(); break;
      case "m": case "M": e.preventDefault(); addMarker(); break;
      case "i": case "I": e.preventDefault(); setZoneIn(); break;
      case "o": case "O": e.preventDefault(); setZoneOut(); break;
      case "Delete": case "Backspace": e.preventDefault(); deleteSelected(); break;
      case "ArrowRight": e.preventDefault(); preview.seek(preview.time + (e.shiftKey ? 1 : 1 / project.fps)); break;
      case "ArrowLeft": e.preventDefault(); preview.seek(preview.time - (e.shiftKey ? 1 : 1 / project.fps)); break;
      case "Home": e.preventDefault(); preview.seek(0); break;
      case "c": case "C":
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); copySelection(); }
        break;
      case "v": case "V":
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); pasteAtPlayhead(); }
        break;
      case "[": e.preventDefault(); jumpEdit(-1); break;
      case "]": e.preventDefault(); jumpEdit(1); break;
      case ",": e.preventDefault(); nudge(-1, e.shiftKey); break;
      case ".": e.preventDefault(); nudge(1, e.shiftKey); break;
      case "f": case "F": e.preventDefault(); zoomToFit(); break;
      case "e": case "E": e.preventDefault(); toggleClipEnabled(); break;
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
    timecode.textContent =
      `${tc(preview.time, project.fps)} / ${tc(projectDuration(project), project.fps)}`;
  }

  render();
  void loadThumbs();
  void loadWaveforms();
  // The plugin list is a filesystem scan, so fetch it once and redraw when it
  // lands rather than blocking the first paint.
  void api
    .frei0rPlugins()
    .then((list) => { frei0r = list; renderInspector(); })
    .catch(() => { /* no frei0r, or running outside Tauri: the select stays disabled */ });

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKey);
      if (meterRaf) cancelAnimationFrame(meterRaf);
      meterRaf = 0;
      if (scopeRaf) cancelAnimationFrame(scopeRaf);
      scopeRaf = 0;
      preview.destroy();
      host.replaceChildren();
    },
  };
}
