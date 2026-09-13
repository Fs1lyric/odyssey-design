/** Typed wrappers over the Tauri command surface. */
import { invoke } from "@tauri-apps/api/core";
import { devStore, isTauri } from "./devstore";
import { emptyProject, type Frei0rPlugin, type JobResult, type PreviewChunk, type Project, type Proxy, type RenderJob, type RenderProfile, type Subtitle } from "./timeline";

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
  renderTimelinePreview: (project: Project, start: number, end: number, scale: number) =>
    invoke<PreviewChunk>("render_timeline_preview", { project, start, end, scale }),
  previewKey: (project: Project, start: number, end: number, scale: number) =>
    invoke<string>("preview_key", { project, start, end, scale }),
  clearTimelinePreviews: () => invoke<number>("clear_timeline_previews"),

  createProxy: (path: string, width: number) => invoke<Proxy>("create_proxy", { path, width }),
  findProxy: (path: string, width: number) => invoke<Proxy | null>("find_proxy", { path, width }),
  clearProxies: () => invoke<number>("clear_proxies"),
  hardwareProfiles: () => invoke<RenderProfile[]>("hardware_profiles"),
  runRenderQueue: (jobs: RenderJob[]) => invoke<JobResult[]>("run_render_queue", { jobs }),
  savePreset: (profile: RenderProfile) => invoke<string>("save_preset", { profile }),
  loadPresets: () => invoke<RenderProfile[]>("load_presets"),
  deletePreset: (id: string) => invoke<void>("delete_preset", { id }),
  detectScenes: (source: string, threshold: number) =>
    invoke<number[]>("detect_scenes", { source, threshold }),
  exportEdl: (project: Project, title: string) => invoke<string>("export_edl", { project, title }),
  exportOtio: (project: Project, name: string) => invoke<string>("export_otio", { project, name }),
  analyseStabilisation: (source: string) => invoke<string>("analyse_stabilisation", { source }),
  freezeFrame: (source: string, at: number) => invoke<string>("freeze_frame", { source, at }),
  renderZone: (project: Project, profile: RenderProfile, output: string, start: number, end: number) =>
    invoke<string>("render_zone", { project, profile, output, start, end }),

  subtitlesToSrt: (subtitles: Subtitle[]) => invoke<string>("subtitles_to_srt", { subtitles }),
  subtitlesFromSrt: (text: string) => invoke<Subtitle[]>("subtitles_from_srt", { text }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  waveform: async (path: string, buckets: number) =>
    isTauri() ? invoke<number[]>("waveform", { path, buckets }) : devStore.waveform(path, buckets),
  renderProject: (project: Project, profile: RenderProfile, output: string) =>
    invoke<string>("render_project", { project, profile, output }),
  projectRenderArgs: (project: Project, profile: RenderProfile, output: string) =>
    invoke<string[]>("project_render_args", { project, profile, output }),
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
