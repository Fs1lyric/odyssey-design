/** Odyssey Sheets — the grid. Raw cell text lives here; evaluation is Rust's. */
import { api, type CellValue, type Item } from "./api";
import type { Editor } from "./docs";

const COLS = 26;
const ROWS = 60;

interface SheetData {
  cells: Record<string, string>;
}

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function displayOf(v: CellValue | undefined): { text: string; type: string } {
  if (!v) return { text: "", type: "empty" };
  switch (v.t) {
    case "number": {
      const n = v.v;
      const text = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(10)));
      return { text, type: "number" };
    }
    case "text": return { text: v.v, type: "text" };
    case "bool": return { text: v.v ? "TRUE" : "FALSE", type: "bool" };
    case "error": return { text: v.v, type: "error" };
    default: return { text: "", type: "empty" };
  }
}

export function mountSheets(
  host: HTMLElement,
  item: Item,
  onChange: (patch: Partial<Item>) => void
): Editor {
  const data = (item.data ?? {}) as SheetData;
  const cells: Record<string, string> = { ...(data.cells ?? {}) };
  let active = "A1";
  let computed: Record<string, CellValue> = {};

  // ---- formula bar ----
  const bar = document.createElement("div");
  bar.className = "sheet-bar";

  const addr = document.createElement("span");
  addr.className = "sheet-bar__addr";
  addr.setAttribute("aria-live", "polite");
  addr.setAttribute("aria-label", "Selected cell");

  const formulaLabel = document.createElement("label");
  formulaLabel.className = "field";
  formulaLabel.style.flex = "1";
  const formulaLabelText = document.createElement("span");
  formulaLabelText.className = "field__label";
  formulaLabelText.textContent = "Formula for the selected cell";
  const formula = document.createElement("input");
  formula.type = "text";
  formula.className = "sheet-bar__input";
  formula.placeholder = "Value, or =SUM(A1:A10)";
  formulaLabel.append(formulaLabelText, formula);

  bar.append(addr, formulaLabel);

  // ---- grid ----
  const wrap = document.createElement("div");
  wrap.className = "grid-wrap";
  const table = document.createElement("table");
  table.className = "grid";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.innerHTML = '<span class="field__label">Row numbers</span>';
  headRow.appendChild(corner);
  for (let c = 0; c < COLS; c++) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = colName(c);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  const inputs = new Map<string, HTMLInputElement>();

  for (let r = 0; r < ROWS; r++) {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.scope = "row";
    rowHead.textContent = String(r + 1);
    tr.appendChild(rowHead);

    for (let c = 0; c < COLS; c++) {
      const ref = `${colName(c)}${r + 1}`;
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cell";
      input.dataset.ref = ref;
      input.setAttribute("aria-label", `Cell ${ref}`);
      input.autocomplete = "off";

      input.addEventListener("focus", () => selectCell(ref));
      // Record every keystroke into the model. Committing only on blur meant
      // typing in a cell and closing the window lost the edit outright, while
      // the save indicator still claimed "Saved". Recalculation stays on blur
      // because it is a round trip to Rust.
      input.addEventListener("input", () => stage(ref, input.value));
      input.addEventListener("blur", () => {
        commit(ref, input.value);
        paintCell(ref);
      });
      input.addEventListener("keydown", (e) => onCellKey(e, ref, r, c));

      inputs.set(ref, input);
      td.appendChild(input);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);

  function onCellKey(e: KeyboardEvent, ref: string, r: number, c: number) {
    const go = (dr: number, dc: number) => {
      const nr = Math.min(ROWS - 1, Math.max(0, r + dr));
      const nc = Math.min(COLS - 1, Math.max(0, c + dc));
      const next = inputs.get(`${colName(nc)}${nr + 1}`);
      if (next) { e.preventDefault(); next.focus(); next.select(); }
    };
    switch (e.key) {
      case "Enter": go(e.shiftKey ? -1 : 1, 0); break;
      case "Tab": go(0, e.shiftKey ? -1 : 1); break;
      case "ArrowUp": if (!isEditing(ref)) go(-1, 0); break;
      case "ArrowDown": if (!isEditing(ref)) go(1, 0); break;
      case "Escape":
        (e.target as HTMLInputElement).value = cells[ref] ?? "";
        paintCell(ref);
        break;
    }
  }

  /** Arrow keys navigate rather than move the caret unless the user has
   *  actually started typing in this cell. `stage` keeps the model in step with
   *  the input on every keystroke, so comparing the two can no longer tell us
   *  whether an edit is in progress; the caret position can. */
  function isEditing(ref: string): boolean {
    const el = inputs.get(ref);
    if (!el || document.activeElement !== el) return false;
    return el.value.length > 0 && el.selectionStart !== 0;
  }

  function selectCell(ref: string) {
    active = ref;
    addr.textContent = ref;
    formula.value = cells[ref] ?? "";
    const el = inputs.get(ref);
    if (el) el.value = cells[ref] ?? "";
  }

  /** Put the raw text into the model and queue a save, without recalculating.
   *  Cheap enough to run on every keystroke. */
  function stage(ref: string, raw: string): boolean {
    const prev = cells[ref] ?? "";
    if (raw === prev) return false;
    if (raw === "") delete cells[ref];
    else cells[ref] = raw;
    onChange({ data: { cells }, body: summarise() });
    return true;
  }

  function commit(ref: string, raw: string) {
    if (!stage(ref, raw)) return;
    void recalc();
  }

  function summarise(): string {
    return Object.entries(cells)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  }

  function paintCell(ref: string) {
    const el = inputs.get(ref);
    if (!el || document.activeElement === el) return;
    const raw = cells[ref];
    if (raw === undefined) {
      el.value = "";
      el.dataset.type = "empty";
      el.dataset.formula = "false";
      return;
    }
    const { text, type } = displayOf(computed[ref]);
    el.value = text || raw;
    el.dataset.type = type;
    el.dataset.formula = String(raw.startsWith("="));
  }

  function paintAll() {
    for (const ref of inputs.keys()) paintCell(ref);
  }

  async function recalc() {
    try {
      computed = await api.evaluateSheet(cells);
    } catch {
      computed = {};
    }
    paintAll();
  }

  formula.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit(active, formula.value);
      paintCell(active);
      inputs.get(active)?.focus();
    }
  });
  formula.addEventListener("blur", () => commit(active, formula.value));

  host.replaceChildren(bar, wrap);
  selectCell("A1");
  void recalc();

  return { destroy: () => host.replaceChildren() };
}
