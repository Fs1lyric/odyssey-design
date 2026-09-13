/** Odyssey Slides — deck editing with a filmstrip and a presenter mode. */
import type { Item } from "./api";
import type { Editor } from "./docs";

interface Slide {
  title: string;
  body: string;
}
interface DeckData {
  slides: Slide[];
}

export function mountSlides(
  host: HTMLElement,
  item: Item,
  onChange: (patch: Partial<Item>) => void
): Editor {
  const data = (item.data ?? {}) as DeckData;
  const slides: Slide[] = Array.isArray(data.slides) && data.slides.length
    ? data.slides
    : [{ title: "Title slide", body: "" }];
  let current = 0;

  const deck = document.createElement("div");
  deck.className = "deck";

  const filmstrip = document.createElement("div");
  filmstrip.className = "deck__filmstrip";
  filmstrip.setAttribute("role", "tablist");
  filmstrip.setAttribute("aria-label", "Slides");

  const stage = document.createElement("div");
  stage.className = "deck__stage";

  const slideEl = document.createElement("section");
  slideEl.className = "slide";

  const titleEl = document.createElement("textarea");
  titleEl.className = "slide__title";
  titleEl.rows = 1;
  titleEl.setAttribute("aria-label", "Slide title");

  const bodyEl = document.createElement("textarea");
  bodyEl.className = "slide__body";
  bodyEl.setAttribute("aria-label", "Slide body");

  slideEl.append(titleEl, bodyEl);

  const controls = document.createElement("div");
  controls.className = "deck__controls";

  const addBtn = button("Add slide", () => {
    slides.splice(current + 1, 0, { title: "", body: "" });
    current += 1;
    render();
    save();
  });
  const dupBtn = button("Duplicate", () => {
    slides.splice(current + 1, 0, { ...slides[current] });
    current += 1;
    render();
    save();
  });
  const delBtn = button("Delete", () => {
    if (slides.length === 1) return;
    slides.splice(current, 1);
    current = Math.max(0, current - 1);
    render();
    save();
  });
  const upBtn = button("Move up", () => move(-1));
  const downBtn = button("Move down", () => move(1));
  const presentBtn = button("Present", () => setPresenting(true));
  presentBtn.className = "btn btn--primary";

  const count = document.createElement("span");
  count.className = "deck__count";

  controls.append(addBtn, dupBtn, delBtn, upBtn, downBtn, presentBtn, count);
  stage.append(slideEl, controls);
  deck.append(filmstrip, stage);

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn--quiet";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function move(delta: number) {
    const target = current + delta;
    if (target < 0 || target >= slides.length) return;
    const [s] = slides.splice(current, 1);
    slides.splice(target, 0, s);
    current = target;
    render();
    save();
  }

  function save() {
    onChange({
      data: { slides },
      body: slides.map((s) => `${s.title}\n${s.body}`).join("\n\n"),
    });
  }

  let presenting = false;
  function setPresenting(on: boolean) {
    presenting = on;
    deck.classList.toggle("is-presenting", on);
    titleEl.readOnly = on;
    bodyEl.readOnly = on;
    presentBtn.textContent = on ? "Exit" : "Present";
    if (on) deck.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (!presenting) return;
    if (e.key === "Escape") setPresenting(false);
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      if (current < slides.length - 1) { current += 1; render(); }
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      if (current > 0) { current -= 1; render(); }
    }
  }
  document.addEventListener("keydown", onKey);

  titleEl.addEventListener("input", () => {
    slides[current].title = titleEl.value;
    renderFilmstrip();
    save();
  });
  bodyEl.addEventListener("input", () => {
    slides[current].body = bodyEl.value;
    save();
  });

  function renderFilmstrip() {
    filmstrip.replaceChildren();
    slides.forEach((s, i) => {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "thumb";
      t.setAttribute("role", "tab");
      t.setAttribute("aria-current", String(i === current));
      t.setAttribute("aria-label", `Slide ${i + 1}: ${s.title || "untitled"}`);
      const n = document.createElement("span");
      n.className = "thumb__n";
      n.textContent = String(i + 1);
      const title = document.createElement("span");
      title.className = "thumb__title";
      title.textContent = s.title || "Untitled";
      t.append(n, title);
      t.addEventListener("click", () => { current = i; render(); });
      filmstrip.appendChild(t);
    });
  }

  function render() {
    const s = slides[current];
    titleEl.value = s.title;
    bodyEl.value = s.body;
    count.textContent = `Slide ${current + 1} of ${slides.length}`;
    delBtn.disabled = slides.length === 1;
    renderFilmstrip();
  }

  host.replaceChildren(deck);
  render();

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKey);
      host.replaceChildren();
    },
  };
}
