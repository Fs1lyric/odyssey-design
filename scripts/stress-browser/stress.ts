/** The browser half of the stress suite: the preview's GPU pipeline at 4K
 *  and 8K. Each case builds a full-resolution layer through `FxPipeline`,
 *  times it over several frames, and checks the output's size, that its
 *  centre was actually drawn, and that no GPU pass failed. With src-tauri's
 *  84 render cases these make the 100. */
import { FxPipeline } from "../../src/fxpipe";
import type { Clip, Effect } from "../../src/timeline";
import { defaultMotion } from "../../src/timeline";

const RES = [{ label: "4K", w: 3840, h: 2160 }, { label: "8K", w: 7680, h: 4320 }];

const CASES: Array<[string, (k: number) => Effect, (w: number, h: number) => [number, number]]> = [
  ["color", () => ({ kind: "color", brightness: 0.1, contrast: 1.2, saturation: 1.4, gamma: 1.1 }), (w, h) => [w, h]],
  ["blur", (k) => ({ kind: "blur", sigma: 12 * k }), (w, h) => [w, h]],
  ["chromakey", () => ({ kind: "chromakey", color: "0x00ff00", similarity: 0.25, blend: 0.1 }), (w, h) => [w, h]],
  ["mask", (k) => ({ kind: "mask", shape: "ellipse", x: 50, y: 50, width: 60, height: 60, feather: 60 * k, invert: false }), (w, h) => [w, h]],
  ["crop", (k) => ({ kind: "crop", x: 400 * k, y: 200 * k, width: 2400 * k, height: 1400 * k }), (_w, _h) => [0, 0]],
  ["rotate-20", () => ({ kind: "rotate", degrees: 20 }), (w, h) => rot(w, h, 20)],
  // At 8K this box is past most GPUs' texture limit: the oversize path.
  ["rotate-45", () => ({ kind: "rotate", degrees: 45 }), (w, h) => rot(w, h, 45)],
  ["lenscorrect", () => ({ kind: "lenscorrect", k1: -0.2, k2: 0.05 }), (w, h) => [w, h]],
];

function rot(w: number, h: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [Math.round(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))),
          Math.round(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)))];
}

/** A busy full-resolution frame: colour bars under a gradient and a grid,
 *  so every effect has detail to act on. */
function pattern(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  bars.forEach((b, i) => { x.fillStyle = b; x.fillRect((i * w) / 7, 0, w / 7 + 1, h); });
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgb(0 0 0 / 0)");
  g.addColorStop(1, "rgb(0 0 0 / 0.7)");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.strokeStyle = "#fff";
  for (let i = 0; i < w; i += w / 48) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
  return c;
}

const lines: string[] = [];
const results: unknown[] = [];
const fx = new FxPipeline();
lines.push(`GPU max texture ${fx.maxTexture}px`);

for (const r of RES) {
  const src = pattern(r.w, r.h);
  const k = r.w / 3840;
  for (const [name, make, expect] of CASES) {
    const clip = { id: name, effects: [make(k)], motion: defaultMotion(), transition_in: null,
      source: { type: "media", path: "" }, blend: "normal" } as unknown as Clip;
    const before = fx.failures;
    const frames = 4;
    let ms = 0;
    let layer = null as ReturnType<FxPipeline["build"]>["layer"] | null;
    let missing: string[] = [];
    let error = "";
    try {
      for (let i = 0; i < frames; i++) {
        fx.beginFrame();
        const base = fx.surface(r.w, r.h, 1);
        base.ctx.drawImage(src, 0, 0, r.w, r.h);
        const t = performance.now();
        const out = fx.build(clip, base, 0.5, 1, 1, r.w, r.h);
        // Reading a pixel forces the GPU work to finish inside the timing.
        out.layer.ctx.getImageData(Math.floor(out.layer.canvas.width / 2), Math.floor(out.layer.canvas.height / 2), 1, 1);
        ms += performance.now() - t;
        layer = out.layer;
        missing = out.missing;
      }
    } catch (e) {
      error = String(e);
    }
    const [ew, eh] = name === "crop" ? [Math.round(2400 * k), Math.round(1400 * k)] : expect(r.w, r.h);
    const problems: string[] = [];
    if (error) problems.push(error);
    if (missing.length) problems.push(`not reproduced: ${missing.join(", ")}`);
    if (fx.failures > before) problems.push(`${fx.failures - before} GPU pass(es) failed`);
    if (layer && (Math.abs(layer.w - ew) > 1 || Math.abs(layer.h - eh) > 1)) problems.push(`layer ${layer.w}x${layer.h}, want ${ew}x${eh}`);
    if (layer) {
      const px = layer.ctx.getImageData(Math.floor(layer.canvas.width / 2), Math.floor(layer.canvas.height / 2), 1, 1).data;
      if (px[3] === 0 && name !== "chromakey") problems.push("centre is empty");
    }
    const reduced = layer ? layer.canvas.width < Math.round(layer.w) : false;
    const ok = problems.length === 0;
    const avg = ms / frames;
    lines.push(`${ok ? "PASS" : "FAIL"} ${r.label} ${name.padEnd(12)} ${avg.toFixed(0).padStart(6)} ms/frame`
      + `${reduced ? `  (GPU pass at ${layer!.canvas.width}px wide, over the ${fx.maxTexture}px limit)` : ""}`
      + `${ok ? "" : "  " + problems.join("; ")}`);
    results.push({ res: r.label, name, ok, ms_per_frame: avg, reduced, problems });
  }
}
document.getElementById("out")!.textContent = "BROWSER STRESS\n" + lines.join("\n") + "\nJSON " + JSON.stringify(results);
