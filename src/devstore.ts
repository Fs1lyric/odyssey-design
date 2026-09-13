/** Browser-only fallback store.
 *
 *  Odyssey runs as a desktop app; its data lives in SQLite behind Tauri. But
 *  iterating on layout in a browser is much faster than rebuilding the binary,
 *  so when the Tauri bridge is absent we fall back to localStorage. This is a
 *  development affordance only — inside the packaged app it is never reached,
 *  because `isTauri()` is true there.
 *
 *  Formula evaluation deliberately has NO browser implementation: the engine
 *  lives in Rust and having a second one here would be two behaviours to keep
 *  in sync. In the browser, cells show their raw text.
 */
import type { CellValue, Item, Query } from "./api";

const KEY = "odyssey-dev-items";

function load(): Item[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Item[];
  } catch {
    return [];
  }
}

function persist(items: Item[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export const devStore = {
  listItems(query: Query = {}): Item[] {
    let items = load();
    if (query.kind) items = items.filter((i) => i.kind === query.kind);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter(
        (i) => i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q)
      );
    }
    return items.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  },

  getItem(id: string): Item | null {
    return load().find((i) => i.id === id) ?? null;
  },

  createItem(partial: Partial<Item>): Item {
    const now = new Date().toISOString();
    const item: Item = {
      id: crypto.randomUUID(),
      kind: "doc",
      title: "",
      body: "",
      status: "open",
      project: null,
      due: null,
      ends_at: null,
      recurrence: null,
      url: null,
      pinned: false,
      data: {},
      created_at: now,
      updated_at: now,
      tags: [],
      ...partial,
    } as Item;
    const items = load();
    items.push(item);
    persist(items);
    return item;
  },

  updateItem(item: Item): void {
    const items = load();
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      items[idx] = { ...item, updated_at: new Date().toISOString() };
      persist(items);
    }
  },

  deleteItem(id: string): void {
    persist(load().filter((i) => i.id !== id));
  },

  evaluateSheet(): Record<string, CellValue> {
    return {};
  },

  /** A deterministic stand-in envelope so waveform rendering can be developed
   *  in a browser. The real peaks come from ffmpeg via Rust; this is shaped
   *  like them (0..1, one peak per bucket) but is not the file's actual audio. */
  waveform(path: string, buckets: number): number[] {
    let seed = 0;
    for (let i = 0; i < path.length; i++) seed = (seed * 31 + path.charCodeAt(i)) >>> 0;
    return Array.from({ length: buckets }, (_, i) => {
      const t = i / buckets;
      const env = Math.sin(t * Math.PI) ** 0.6;
      const wobble = Math.abs(Math.sin(t * 40 + (seed % 100) / 10));
      return Math.min(1, env * (0.35 + 0.65 * wobble));
    });
  },
};

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
