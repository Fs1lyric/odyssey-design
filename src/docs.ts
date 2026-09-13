/** Odyssey Docs — a rich-text editor over contenteditable. */
import type { Item } from "./api";

export interface Editor {
  destroy(): void;
}

interface DocData {
  html: string;
}

/** Formatting commands. `execCommand` is deprecated but it is the only API
 *  with universal support for contenteditable formatting; the alternative is
 *  a full selection/range engine, which is a project in itself. Isolated here
 *  so it can be replaced without touching anything else. */
const COMMANDS: Array<{ cmd: string; arg?: string; icon: string; title: string; group?: boolean }> = [
  { cmd: "bold", icon: "text-b", title: "Bold" },
  { cmd: "italic", icon: "text-italic", title: "Italic" },
  { cmd: "underline", icon: "text-underline", title: "Underline" },
  { cmd: "strikeThrough", icon: "text-strikethrough", title: "Strikethrough" },
  { cmd: "formatBlock", arg: "h1", icon: "text-h-one", title: "Heading 1", group: true },
  { cmd: "formatBlock", arg: "h2", icon: "text-h-two", title: "Heading 2" },
  { cmd: "formatBlock", arg: "h3", icon: "text-h-three", title: "Heading 3" },
  { cmd: "formatBlock", arg: "p", icon: "paragraph", title: "Body text" },
  { cmd: "insertUnorderedList", icon: "list-bullets", title: "Bulleted list", group: true },
  { cmd: "insertOrderedList", icon: "list-numbers", title: "Numbered list" },
  { cmd: "formatBlock", arg: "blockquote", icon: "quotes", title: "Quote" },
  { cmd: "formatBlock", arg: "pre", icon: "code", title: "Code block" },
];

export function mountDocs(
  host: HTMLElement,
  item: Item,
  onChange: (patch: Partial<Item>) => void
): Editor {
  const data = (item.data ?? {}) as DocData;

  const toolbar = document.createElement("div");
  toolbar.className = "doc-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Text formatting");

  const page = document.createElement("article");
  page.className = "doc-page";
  page.contentEditable = "true";
  page.spellcheck = true;
  page.setAttribute("role", "textbox");
  page.setAttribute("aria-multiline", "true");
  page.setAttribute("aria-label", "Document body");
  page.innerHTML = data.html || "<p><br></p>";

  for (const { cmd, arg, icon, title, group } of COMMANDS) {
    if (group) {
      const div = document.createElement("span");
      div.className = "doc-toolbar__sep";
      div.setAttribute("aria-hidden", "true");
      toolbar.appendChild(div);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn--quiet btn--icon";
    const glyph = document.createElement("i");
    glyph.className = `ph ph-${icon}`;
    glyph.setAttribute("aria-hidden", "true");
    b.appendChild(glyph);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
    b.addEventListener("click", () => {
      page.focus();
      document.execCommand(cmd, false, arg);
      save();
    });
    toolbar.appendChild(b);
  }

  const stats = document.createElement("p");
  stats.className = "doc-stats";

  function refreshStats() {
    const text = page.innerText.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.length;
    const mins = Math.max(1, Math.round(words / 200));
    stats.replaceChildren();
    const parts: Array<[string, string]> = [
      [words.toLocaleString(), words === 1 ? "word" : "words"],
      [chars.toLocaleString(), chars === 1 ? "character" : "characters"],
      [String(mins), mins === 1 ? "minute to read" : "minutes to read"],
    ];
    for (const [value, label] of parts) {
      const span = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = value;
      span.append(b, document.createTextNode(` ${label}`));
      stats.appendChild(span);
    }
  }

  function save() {
    refreshStats();
    onChange({ data: { html: page.innerHTML }, body: page.innerText });
  }

  page.addEventListener("input", save);

  // Plain-text paste: pasted markup from a browser carries styles that fight
  // the document's own theme.
  page.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
  });

  page.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const map: Record<string, string> = { b: "bold", i: "italic", u: "underline" };
    const cmd = map[e.key.toLowerCase()];
    if (cmd) {
      e.preventDefault();
      document.execCommand(cmd);
      save();
    }
  });

  host.replaceChildren(toolbar, page, stats);
  refreshStats();
  return { destroy: () => host.replaceChildren() };
}
