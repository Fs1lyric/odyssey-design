/** Preview parity: does the monitor's GPU pipeline produce the frame ffmpeg
 *  does?
 *
 *  `cargo test preview_parity_fixtures -- --ignored` renders one still through
 *  the real export path once per effect. This page runs the same still and
 *  the same effect JSON through `FxPipeline`, composites it the way the
 *  preview does, and reports the per-pixel difference from ffmpeg's frame.
 *
 *    npx vite --port 5199 &
 *    chromium --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader \
 *      --virtual-time-budget=30000 --dump-dom \
 *      http://localhost:5199/scripts/preview-parity/index.html
 */
import { FxPipeline } from "../../src/fxpipe";
import type { Clip, Effect } from "../../src/timeline";
import { defaultMotion } from "../../src/timeline";

const DIR = "/src-tauri/target/test-scratch/preview-parity";
const W = 320;
const H = 180;

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => fail(new Error(`could not load ${src}`));
    im.src = src;
  });
}

function pixels(img: CanvasImageSource): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(img, 0, 0, W, H);
  return x.getImageData(0, 0, W, H).data;
}

async function main() {
  const out = document.getElementById("out")!;
  const cases: Array<{ name: string; effect: Effect }> = await (await fetch(`${DIR}/cases.json`)).json();
  const source = await load(`${DIR}/source.png`);
  const fx = new FxPipeline();
  const rows: Array<{ name: string; mae: number; bad: number }> = [];
  // ?dump=a,b appends those cases' preview frames as data URLs, for viewing.
  const dump = new Set((new URLSearchParams(location.search).get("dump") ?? "").split(",").filter(Boolean));
  const dumps: string[] = [];

  for (const { name, effect } of cases) {
    const expected = pixels(await load(`${DIR}/${name}.png?${Date.now()}`));
    fx.beginFrame();
    const clip = {
      id: name, effects: [effect], motion: defaultMotion(), transition_in: null,
      source: { type: "still", path: "" }, blend: "normal",
    } as unknown as Clip;
    // A 320x180 still in a 320x180 frame with no motion: padded full frame.
    const base = fx.surface(W, H, 1);
    base.ctx.fillStyle = "#000";
    base.ctx.fillRect(0, 0, W, H);
    base.ctx.drawImage(source, 0, 0, W, H);
    const { layer, missing } = fx.build(clip, base, 0, 1, 1, W, H);

    const comp = document.createElement("canvas");
    comp.width = W;
    comp.height = H;
    const c = comp.getContext("2d")!;
    c.fillStyle = "#000";
    c.fillRect(0, 0, W, H);
    c.drawImage(layer.canvas, (W - layer.w) / 2, (H - layer.h) / 2, layer.w, layer.h);
    const got = pixels(comp);
    if (dump.has(name)) dumps.push(`DUMP ${name} ${comp.toDataURL("image/png")}`);

    let sum = 0;
    let bad = 0;
    for (let i = 0; i < got.length; i += 4) {
      const d = (Math.abs(got[i] - expected[i]) + Math.abs(got[i + 1] - expected[i + 1]) + Math.abs(got[i + 2] - expected[i + 2])) / 3;
      sum += d;
      if (d > 24) bad++;
    }
    rows.push({ name: missing.length ? `${name} (MISSING)` : name, mae: sum / (W * H), bad: (100 * bad) / (W * H) });
  }

  out.textContent = "PARITY\n" + rows
    .map((r) => `${r.name.padEnd(22)} mean |Δ| ${r.mae.toFixed(2).padStart(6)}   pixels off >24: ${r.bad.toFixed(1).padStart(5)}%`)
    .join("\n") + (dumps.length ? "\n" + dumps.join("\n") : "");
}

main().catch((e) => {
  document.getElementById("out")!.textContent = `ERROR ${e?.stack ?? e}`;
});
