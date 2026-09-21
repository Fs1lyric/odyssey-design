/** Drives the real `Preview` compositor through transitions, an adjustment
 *  layer and an effect the live path cannot show, and checks pixels. */
import { Preview } from "../../src/preview";
import { emptyProject, makeClip, newTrack, type Project } from "../../src/timeline";

const out = document.getElementById("out")!;
const lines: string[] = [];
const check = (name: string, ok: boolean, detail = "") => lines.push(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);

function px(p: Preview, x: number, y: number): number[] {
  const c = p.canvas.getContext("2d")!;
  return [...c.getImageData(x, y, 1, 1).data].slice(0, 3);
}
const near = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const project: Project = { ...emptyProject(), width: 320, height: 180, background: "black" };
const v1 = project.tracks[0];
const red = makeClip({ type: "color", color: "#ff0000" }, 0, 2);
// One second of head handle, so the renderer can pull the dissolve back.
const blue = makeClip({ type: "color", color: "#0000ff" }, 2, 3, 1);
blue.transition_in = { kind: "dissolve", duration: 1, curve: "qsin" };
v1.clips = [red, blue];

const modes: string[] = [];
const p = new Preview(project);
p.onMode = (mode, missing) => modes.push(`${mode}:${missing.join("|")}`);

p.seek(0.5);
check("red before the transition", near(px(p, 160, 90), [255, 0, 0]), JSON.stringify(px(p, 160, 90)));
p.seek(1.5);
check("dissolve is pulled back and half way at 1.5s", near(px(p, 160, 90), [128, 0, 128], 10), JSON.stringify(px(p, 160, 90)));
p.seek(2.5);
check("blue after the transition", near(px(p, 160, 90), [0, 0, 255]), JSON.stringify(px(p, 160, 90)));

// An adjustment layer above inverts everything beneath it over its span.
const v2 = newTrack("V2", "video");
const adj = makeClip({ type: "adjustment" }, 0, 1);
adj.effects = [{ kind: "invert" }];
v2.clips = [adj];
project.tracks.splice(1, 0, v2);
p.setProject(project);
p.seek(0.5);
check("adjustment layer inverts the composite", near(px(p, 160, 90), [0, 255, 255]), JSON.stringify(px(p, 160, 90)));

// Crop shrinks the layer and the renderer overlays it centred.
red.effects = [{ kind: "crop", x: 0, y: 0, width: 100, height: 60 }];
adj.effects = [];
p.setProject(project);
p.seek(0.5);
check("cropped layer is centred", near(px(p, 160, 90), [255, 0, 0]) && near(px(p, 20, 20), [0, 0, 0]),
  `${JSON.stringify(px(p, 160, 90))} ${JSON.stringify(px(p, 20, 20))}`);

// frei0r cannot run in a browser: it must be named, not silently dropped.
red.effects = [{ kind: "frei0r", name: "cartoon", params: [] }];
p.setProject(project);
p.seek(0.5);
check("unsupported effect is reported", modes.some((m) => m.includes("frei0r cartoon")), modes.at(-1) ?? "");

// With an exact-frame source, a parked playhead swaps in ffmpeg's frame.
p.exactFrame = async () => "/src-tauri/target/test-scratch/preview-parity/invert.png";
p.seek(0.6);
await new Promise((r) => setTimeout(r, 800));
check("exact frame replaces the live composite when parked", modes.at(-1)?.startsWith("exact") ?? false, modes.at(-1) ?? "");
p.play();
await new Promise((r) => setTimeout(r, 200));
check("playing returns to the live composite", modes.at(-1)?.startsWith("live") ?? false, modes.at(-1) ?? "");
p.pause();

out.textContent = "SMOKE\n" + lines.join("\n");
