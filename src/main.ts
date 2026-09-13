/** Odyssey Design — application shell: library, routing and autosave. */
import { api, blankItem, type Item, type Kind } from "./api";
import { mountDocs, type Editor } from "./docs";
import { mountSheets } from "./sheets";
import { mountSlides } from "./slides";
import { mountVideo } from "./video";

const KIND_LABEL: Record<Kind, string> = {
  doc: "Document",
  sheet: "Sheet",
  slide: "Deck",
  video: "Timeline",
  asset: "Asset",
};

const KIND_ICON: Record<Kind, string> = {
  doc: "file-text",
  sheet: "table",
  slide: "presentation-chart",
  video: "film-strip",
  asset: "image",
};

const els = {
  library: document.getElementById("library") as HTMLElement,
  editor: document.getElementById("editor") as HTMLElement,
  title: document.getElementById("doc-title") as HTMLInputElement,
  kind: document.getElementById("doc-kind") as HTMLElement,
  savestate: document.getElementById("savestate") as HTMLElement,
  search: document.getElementById("search") as HTMLInputElement,
  themeToggle: document.getElementById("theme-toggle") as HTMLButtonElement,
};

let current: Item | null = null;
let editor: Editor | null = null;
let saveTimer: number | undefined;
let pending: Partial<Item> = {};

// ---------- save ----------

function setSaveState(text: string, state: "" | "saving" | "saved" | "error") {
  els.savestate.textContent = text;
  els.savestate.dataset.state = state;
}

/** Debounced write-behind. Typing should never wait on the disk. */
function queueSave(patch: Partial<Item>) {
  if (!current) return;
  pending = { ...pending, ...patch };
  setSaveState("Saving…", "saving");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 600);
}

async function flush() {
  if (!current || !Object.keys(pending).length) return;
  // A snapshot, not an alias. Aliasing meant an edit queued during the await
  // was indistinguishable from one already written, so the cleanup below
  // deleted it and the edit was lost.
  const sending: Partial<Item> = { ...pending };
  const next = { ...current, ...sending } as Item;
  // `pending` is NOT cleared yet: if the write fails the edit has to survive,
  // and clearing first meant a transient failure silently discarded work.
  try {
    await api.updateItem(next);
    current = next;
    // Drop only the keys that were actually written; anything the user typed
    // during the await stays queued for the next flush.
    for (const key of Object.keys(sending)) {
      if (pending[key as keyof Item] === sending[key as keyof Item]) {
        delete pending[key as keyof Item];
      }
    }
    setSaveState("Saved", "saved");
    await refreshLibrary();
  } catch (e) {
    // The edit is still in `pending`, so the next save attempt retries it.
    setSaveState("Not saved", "error");
    console.error("save failed", e);
  }
}

// ---------- library ----------

async function refreshLibrary() {
  const search = els.search.value.trim();
  const items = await api.listItems(search ? { search } : {});
  els.library.replaceChildren();

  const order: Kind[] = ["doc", "sheet", "slide", "video"];
  for (const kind of order) {
    const group = items.filter((i) => i.kind === kind);
    if (!group.length) continue;

    const heading = document.createElement("p");
    heading.className = "rail__group";
    heading.textContent = group.length === 1 ? KIND_LABEL[kind] : `${KIND_LABEL[kind]}s`;
    els.library.appendChild(heading);

    for (const item of group) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "doc-row";
      row.setAttribute("role", "listitem");
      row.setAttribute("aria-current", String(item.id === current?.id));

      const title = document.createElement("span");
      title.className = "doc-row__title";
      title.textContent = item.title || "Untitled";

      const k = document.createElement("i");
      k.className = `ph ph-${KIND_ICON[kind]} doc-row__kind`;
      k.setAttribute("aria-hidden", "true");

      row.append(k, title);
      row.addEventListener("click", () => void openItem(item.id));
      els.library.appendChild(row);
    }
  }

  if (!items.length) {
    const none = document.createElement("p");
    none.className = "rail__group";
    none.textContent = search ? "No matches" : "Library is empty";
    els.library.appendChild(none);
  }
}

// ---------- routing ----------

async function openItem(id: string) {
  await flush();
  const item = await api.getItem(id);
  if (!item) return;

  editor?.destroy();
  current = item;
  pending = {};

  els.title.value = item.title;
  els.kind.textContent = KIND_LABEL[item.kind] ?? item.kind;
  setSaveState("", "");

  const onChange = (patch: Partial<Item>) => queueSave(patch);

  switch (item.kind) {
    case "sheet": editor = mountSheets(els.editor, item, onChange); break;
    case "slide": editor = mountSlides(els.editor, item, onChange); break;
    case "video": editor = mountVideo(els.editor, item, onChange); break;
    default:      editor = mountDocs(els.editor, item, onChange); break;
  }

  await refreshLibrary();
}

async function createNew(kind: Kind) {
  const item = await api.createItem(blankItem(kind));
  await refreshLibrary();
  await openItem(item.id);
  els.title.focus();
  els.title.select();
}

// ---------- theme ----------

function initTheme() {
  const stored = localStorage.getItem("odyssey-theme");
  if (stored === "dark" || stored === "light") {
    document.documentElement.setAttribute("data-theme", stored);
  }
  syncToggle();

  els.themeToggle.addEventListener("click", () => {
    const root = document.documentElement;
    const currentTheme =
      root.getAttribute("data-theme") ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = currentTheme === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("odyssey-theme", next);
    syncToggle();
  });
}

function syncToggle() {
  const isDark =
    document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.hasAttribute("data-theme") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  els.themeToggle.setAttribute("aria-pressed", String(isDark));
  els.themeToggle.replaceChildren();
  const glyph = document.createElement("i");
  glyph.className = isDark ? "ph ph-sun" : "ph ph-moon";
  glyph.setAttribute("aria-hidden", "true");
  els.themeToggle.append(glyph, document.createTextNode(isDark ? "Light theme" : "Dark theme"));
}

// ---------- wiring ----------

document.querySelectorAll<HTMLButtonElement>("[data-new]").forEach((b) => {
  b.addEventListener("click", () => void createNew(b.dataset.new as Kind));
});

els.title.addEventListener("input", () => queueSave({ title: els.title.value }));

let searchTimer: number | undefined;
els.search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void refreshLibrary(), 180);
});

// A pending debounced save must not be lost when the window closes.
window.addEventListener("beforeunload", () => {
  if (Object.keys(pending).length) void flush();
});

initTheme();
void refreshLibrary();
