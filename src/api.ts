/** Typed wrappers over the Tauri command surface. */
import { invoke } from "@tauri-apps/api/core";
import { devStore, isTauri } from "./devstore";
import { emptyProject, renderable, type Frei0rPlugin, type JobResult, type PreviewChunk, type Project, type Proxy, type RenderJob, type RenderProfile, type Subtitle } from "./timeline";

export type Kind = "doc" | "sheet" | "slide" | "video" | "asset";

export interface Item {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  status: string;
  project: string | null;
  due: string | null;
  ends_at: string | null;
  recurrence: string | null;
  url: string | null;
  pinned: boolean;
  data: unknown;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface Query {
  kind?: string;
  status?: string;
  project?: string;
  tag?: string;
  search?: string;
  limit?: number;
}

export type CellValue =
  | { t: "number"; v: number }
  | { t: "text"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "error"; v: string }
  | { t: "empty" };

export interface MediaInfo {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
}

export interface LoudnessReport {
  integrated: number;
  range: number;
  true_peak: number;
  momentary_max: number;
  short_term_max: number;
}

export interface TrackResult {
  points: Array<{ t: number; x: number; y: number; confidence: number }>;
  lost: boolean;
}

/** A clip read from an EDL or OTIO file, placed but not yet built. */
export interface ImportedClip {
  lane: "video" | "audio";
  track: number;
  name: string;
  /** Null when the file was not found; `wanted` is where it was expected. */
  path: string | null;
  wanted: string;
  generator: string | null;
  start: number;
  in_point: number;
  out_point: number;
  speed: number;
  reverse: boolean;
  transition: [string, number] | null;
  /** The whole clip, when the file came from Odyssey's own OTIO export. */
  odyssey: Record<string, unknown> | null;
}

export interface Imported {
  title: string;
  video_tracks: string[];
  audio_tracks: string[];
  clips: ImportedClip[];
  markers: Array<{ time: number; duration: number; name: string; colour: string; comment: string }>;
  missing: string[];
  warnings: string[];
}

export const api = {
  listItems: async (query: Query = {}) =>
    isTauri() ? invoke<Item[]>("list_items", { query }) : devStore.listItems(query),
  getItem: async (id: string) =>
    isTauri() ? invoke<Item | null>("get_item", { id }) : devStore.getItem(id),
  createItem: async (item: Partial<Item>) =>
    isTauri() ? invoke<Item>("create_item", { item }) : devStore.createItem(item),
  updateItem: async (item: Item) =>
    isTauri() ? invoke<void>("update_item", { item }) : devStore.updateItem(item),
  deleteItem: async (id: string) =>
    isTauri() ? invoke<void>("delete_item", { id }) : devStore.deleteItem(id),
  related: (id: string) => invoke<Item[]>("related", { id }),

  evaluateSheet: async (cells: Record<string, string>) =>
    isTauri()
      ? invoke<Record<string, CellValue>>("evaluate_sheet", { cells })
      : devStore.evaluateSheet(),

  probeMedia: (path: string) => invoke<MediaInfo>("probe_media", { path }),
  clipThumbnail: (source: string, at: number) =>
    invoke<string>("clip_thumbnail", { source, at }),

  renderProfiles: () => invoke<RenderProfile[]>("render_profiles"),
  frei0rPlugins: () => invoke<Frei0rPlugin[]>("frei0r_plugins"),
  // Every call that hands a project to the renderer passes it through
  // `renderable`, so editor-only state such as a bypassed effect never reaches
  // ffmpeg and a preview key never counts it.
  renderTimelinePreview: (project: Project, start: number, end: number, scale: number) =>
    invoke<PreviewChunk>("render_timeline_preview", { project: renderable(project), start, end, scale }),
  previewKey: (project: Project, start: number, end: number, scale: number) =>
    invoke<string>("preview_key", { project: renderable(project), start, end, scale }),
  clearTimelinePreviews: () => invoke<number>("clear_timeline_previews"),

  createProxy: (path: string, width: number) => invoke<Proxy>("create_proxy", { path, width }),
  findProxy: (path: string, width: number) => invoke<Proxy | null>("find_proxy", { path, width }),
  clearProxies: () => invoke<number>("clear_proxies"),
  hardwareProfiles: () => invoke<RenderProfile[]>("hardware_profiles"),
  runRenderQueue: (jobs: RenderJob[]) =>
    invoke<JobResult[]>("run_render_queue", { jobs: jobs.map((j) => ({ ...j, project: renderable(j.project) })) }),
  savePreset: (profile: RenderProfile) => invoke<string>("save_preset", { profile }),
  loadPresets: () => invoke<RenderProfile[]>("load_presets"),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),
  detectScenes: (source: string, threshold: number) =>
    invoke<number[]>("detect_scenes", { source, threshold }),
  exportEdl: (project: Project, title: string) =>
    invoke<string>("export_edl", { project: renderable(project), title }),
  exportOtio: (project: Project, name: string) =>
    invoke<string>("export_otio", { project: renderable(project), name }),
  /** Read an EDL or OTIO file, finding its media among `known` paths. */
  importInterchange: (path: string, fps: number, known: string[]) =>
    invoke<Imported>("import_interchange", { path, fps, known }),
  analyseStabilisation: (source: string) => invoke<string>("analyse_stabilisation", { source }),
  freezeFrame: (source: string, at: number) => invoke<string>("freeze_frame", { source, at }),
  renderZone: (project: Project, profile: RenderProfile, output: string, start: number, end: number) =>
    invoke<string>("render_zone", { project: renderable(project), profile, output, start, end }),
  exportFrame: (project: Project, at: number, output: string) =>
    invoke<string>("export_frame", { project: renderable(project), at, output }),
  /** Offsets that line each of `others` up with `reference` by audio. */
  audioSync: (reference: string, others: string[]) =>
    invoke<Array<{ offset: number; confidence: number }>>("audio_sync", { reference, others }),
  /** Follow a region (centre and size, normalised to the picture) through a
   *  source from `start` to `end` seconds. */
  trackRegion: (source: string, start: number, end: number, rate: number, region: { x: number; y: number; w: number; h: number }) =>
    invoke<TrackResult>("track_region", { source, start, end, rate, region }),
  /** EBU R128 figures for the finished mix, from a real render. */
  measureLoudness: (project: Project) =>
    invoke<LoudnessReport>("measure_loudness", { project: renderable(project) }),
  /** The exact frame at `at` as ffmpeg renders it, cached on disk. */
  previewFrame: (project: Project, at: number) =>
    invoke<string>("preview_frame", { project: renderable(project), at }),
  audioPeak: (source: string, start: number, end: number) =>
    invoke<number>("audio_peak", { source, start, end }),
  mediaStatus: async (paths: string[]) =>
    isTauri() ? invoke<boolean[]>("media_status", { paths }) : paths.map(() => true),
  autosave: (project: Project, itemId: string) =>
    invoke<string>("autosave", { project, itemId }),
  autosaves: (itemId: string) => invoke<string[]>("autosaves", { itemId }),
  restoreAutosave: (path: string) => invoke<Project>("restore_autosave", { path }),

  subtitlesToSrt: (subtitles: Subtitle[]) => invoke<string>("subtitles_to_srt", { subtitles }),
  subtitlesFromSrt: (text: string) => invoke<Subtitle[]>("subtitles_from_srt", { text }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  waveform: async (path: string, buckets: number) =>
    isTauri() ? invoke<number[]>("waveform", { path, buckets }) : devStore.waveform(path, buckets),
  renderProject: (project: Project, profile: RenderProfile, output: string) =>
    invoke<string>("render_project", { project: renderable(project), profile, output }),
  projectRenderArgs: (project: Project, profile: RenderProfile, output: string) =>
    invoke<string[]>("project_render_args", { project: renderable(project), profile, output }),
};

/** A blank record of each kind, with the right shape in `data`. */
export function blankItem(kind: Kind): Partial<Item> {
  const base = { kind, title: "", body: "", status: "open", pinned: false, tags: [] };
  switch (kind) {
    case "sheet":
      return { ...base, title: "Untitled sheet", data: { cells: {} } };
    case "slide":
      return {
        ...base,
        title: "Untitled deck",
        data: { slides: [{ title: "Title slide", body: "" }] },
      };
    case "video":
      return { ...base, title: "Untitled timeline", data: emptyProject() };
    default:
      return { ...base, title: "Untitled document", data: { html: "" } };
  }
}
