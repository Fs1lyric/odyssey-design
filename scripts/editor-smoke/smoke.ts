/** Drives the real editor (mountVideo) through nested editing, undo inside a
 *  nest, trim feedback, the loudness panel and multicam cutting. */
import { mountVideo } from "../../src/video";
import { emptyProject, makeClip, newTrack, type Project } from "../../src/timeline";
import type { Imported, Item } from "../../src/api";
import { placeImported, setMulticamAudio } from "../../src/edits";

const out = document.getElementById("out")!;
const lines: string[] = [];
const check = (name: string, ok: boolean, detail = "") => lines.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const tick = () => new Promise((r) => setTimeout(r, 30));
const key = (k: string, extra: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));

try {
  // A project with a nested sequence holding two colour clips, and a
  // multicam group of two angles with a clip showing angle 1.
  const inner: Project = { ...emptyProject(), width: 640, height: 360 };
  inner.tracks[0].clips = [
    makeClip({ type: "color", color: "#ff0000" }, 0, 2),
    makeClip({ type: "color", color: "#00ff00" }, 2, 2),
  ];
  const project: Project = { ...emptyProject(), width: 640, height: 360 };
  const nest = makeClip({ type: "nested", name: "Inner", project: inner }, 0, 4);
  project.tracks[0].clips = [nest];
  const cams = newTrack("Multicam 1", "video");
  const group = {
    id: "g1", name: "Multicam 1",
    angles: [
      { path: "/cam/a.mp4", name: "A", offset: 0, duration: 20 },
      { path: "/cam/b.mp4", name: "B", offset: 1.5, duration: 20 },
    ],
  };
  const mc = makeClip({ type: "media", path: "/cam/a.mp4" }, 5, 12, 2);
  mc.multicam = { group: "g1", angle: 0 };
  cams.clips = [mc];
  project.tracks.push(cams);
  project.multicam = [group];

  let saved: Project | null = null;
  const item = { id: "smoke", kind: "video", title: "Smoke", body: "", data: project } as unknown as Item;
  const editor = mountVideo(document.getElementById("host")!, item, (patch) => {
    if (patch.data) saved = patch.data as Project;
  });
  await tick();

  // ---- nested editing ----
  const nestEl = document.querySelector<HTMLElement>(`.vid__clip[data-id="${nest.id}"]`)!;
  nestEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await tick();
  const crumbs = document.querySelector<HTMLElement>(".vid__crumbs")!;
  check("double-click opens the nest", !crumbs.hidden && crumbs.textContent!.includes("Inner"), crumbs.textContent ?? "");
  check("the timeline shows the nest's clips", document.querySelectorAll(".vid__clip").length === 2,
    `${document.querySelectorAll(".vid__clip").length} clips`);

  // Delete the first inner clip.
  const firstInner = document.querySelector<HTMLElement>(`.vid__clip[data-id="${inner.tracks[0].clips[0].id}"]`)!;
  firstInner.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await tick();
  key("Delete");
  await tick();
  const savedInner = () => ((saved!.tracks[0].clips[0].source as { project: Project }).project.tracks[0].clips.length);
  check("an edit inside the nest lands in the saved project", saved !== null && savedInner() === 1, saved ? `${savedInner()} inner clips` : "no save");
  key("z", { ctrlKey: true });
  await tick();
  check("undo inside the nest restores it and stays inside", savedInner() === 2 && !crumbs.hidden
    && document.querySelectorAll(".vid__clip").length === 2, `${savedInner()} inner, crumbs ${crumbs.hidden ? "hidden" : "shown"}`);
  key("Escape"); // clears the selection
  key("Escape"); // leaves the nest
  await tick();
  check("Esc returns to the parent", crumbs.hidden && !!document.querySelector(`.vid__clip[data-id="${nest.id}"]`));

  // ---- trim feedback ----
  const mcEl = document.querySelector<HTMLElement>(`.vid__clip[data-id="${mc.id}"]`)!;
  const handle = mcEl.querySelector<HTMLElement>(".vid__handle--r")!;
  const r = handle.getBoundingClientRect();
  handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left, clientY: r.top + 4 }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left - 40, clientY: r.top + 4 }));
  await tick();
  const readout = document.querySelector<HTMLElement>(".vid__trimreadout")!;
  check("trim readout appears with the mode and a signed delta", !readout.hidden && /Trim out\s+−00:/.test(readout.textContent ?? ""),
    JSON.stringify(readout.textContent));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await tick();
  check("trim readout hides on release", readout.hidden);
  key("z", { ctrlKey: true });
  await tick();

  // ---- loudness panel ----
  document.querySelector<HTMLButtonElement>('[aria-label="Audio mixer"]')?.click();
  await tick();
  check("mixer shows the R128 panel", document.querySelectorAll(".vid__r128 [data-r128]").length === 4);

  // ---- buses ----
  document.querySelector<HTMLButtonElement>('[aria-label="Add bus"]')!.click();
  await tick();
  check("Add bus makes a bus strip", saved!.buses.length === 1 && document.querySelectorAll(".vid__strip--bus").length === 1);
  const route = document.querySelector<HTMLSelectElement>(".vid__route")!;
  route.value = saved!.buses[0].id;
  route.dispatchEvent(new Event("change"));
  await tick();
  check("a track can be routed to the bus", saved!.tracks[0].output === saved!.buses[0].id);
  document.querySelector<HTMLButtonElement>('.vid__strip--bus [aria-label^="Remove"]')!.click();
  await tick();
  check("removing the bus sends its tracks back to the master", saved!.buses.length === 0 && saved!.tracks[0].output === null
    && !document.querySelector(".vid__route"));

  // ---- multicam ----
  document.querySelector<HTMLButtonElement>('[aria-label^="Multicam view"]')!.click();
  await tick();
  // Park the playhead inside the multicam clip (5 s to 15 s) and cut to B.
  document.querySelector<HTMLButtonElement>('[aria-label="Go to start"]')!.click();
  for (let i = 0; i < 8; i++) key("ArrowRight", { shiftKey: true });
  await tick();
  key("2");
  await tick();
  const mcs = saved!.tracks.find((t) => t.name === "Multicam 1")!.clips.slice().sort((a, b) => a.start - b.start);
  check("pressing 2 cuts to angle B at the playhead", mcs.length === 2 && mcs[1].multicam?.angle === 1
    && (mcs[1].source as { path: string }).path === "/cam/b.mp4",
    mcs.map((c) => `${c.start.toFixed(2)}:${c.multicam?.angle}`).join(" "));
  check("the new angle shows the same moment of the take", Math.abs((mcs[1].in_point - 1.5) - (2 + (mcs[1].start - 5))) < 0.01,
    `in ${mcs[1].in_point.toFixed(3)} at ${mcs[1].start.toFixed(3)}`);
  check("the first part keeps angle A", mcs[0].multicam?.angle === 0 && Math.abs(mcs[0].out_point - mcs[1].in_point + 1.5) < 0.01);

  editor.destroy();

  // ---- title layers through the inspector ----
  const tp: Project = { ...emptyProject(), width: 640, height: 360 };
  const card = makeClip({ type: "title", text: "Main", background: "black", size: 40, color: "white",
    style: { ...(await import("../../src/timeline")).defaultTitleStyle() } }, 0, 3);
  tp.tracks[0].clips = [card];
  let tSaved: Project | null = null;
  const tEditor = mountVideo(document.getElementById("host")!, { id: "t", kind: "video", title: "T", body: "", data: tp } as unknown as Item,
    (patch) => { if (patch.data) tSaved = patch.data as Project; });
  await tick();
  const cardEl = document.querySelector<HTMLElement>(`.vid__clip[data-id="${card.id}"]`)!;
  cardEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 1, clientY: 1 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await tick();
  const clickText = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)?.click();
  clickText("Add shape");
  await tick();
  clickText("Add text");
  await tick();
  const layersOf = () => ((tSaved?.tracks[0].clips[0].source as { style: { layers: Array<{ type: string }> } })?.style.layers ?? []);
  check("Add shape and Add text put layers on the card", layersOf().map((l) => l.type).join(",") === "rect,text",
    layersOf().map((l) => l.type).join(","));
  check("each layer gets its own card in the inspector", document.querySelectorAll(".vid__titlelayer").length === 2);
  key("z", { ctrlKey: true });
  await tick();
  check("undo removes the last layer", layersOf().length === 1);
  tEditor.destroy();

  // ---- fixed multicam audio (pure) ----
  const fixed = structuredClone(saved!);
  const grp = fixed.multicam![0];
  const laid = setMulticamAudio(fixed, grp, 1);
  const cuts = fixed.tracks.find((t) => t.name === "Multicam 1")!.clips;
  check("fixing audio to B lays one unbroken clip under both cuts", laid.length === 1
    && (laid[0].source as { path: string }).path === "/cam/b.mp4"
    && Math.abs(laid[0].start - 5) < 1e-6 && Math.abs(laid[0].in_point - 3.5) < 1e-6
    && Math.abs(laid[0].out_point - laid[0].in_point - 10) < 1e-6,
    laid.map((c) => `${c.start}:${c.in_point}-${c.out_point}`).join(" "));
  check("the angle clips go silent", cuts.every((c) => c.muted));
  const back = setMulticamAudio(fixed, grp, null);
  check("following the cut again removes the laid sound and its track", back.length === 0
    && cuts.every((c) => !c.muted) && !fixed.tracks.some((t) => t.name === "Multicam 1 audio"));

  // ---- edit list import (pure) ----
  const clipOf = (over: Partial<Imported["clips"][number]>): Imported["clips"][number] => ({
    lane: "video", track: 0, name: "a.mov", path: "/m/a.mov", wanted: "", generator: null,
    start: 0, in_point: 1, out_point: 3, speed: 1, reverse: false, transition: null, odyssey: null, ...over,
  });
  const im: Imported = {
    title: "Cut", video_tracks: ["V1"], audio_tracks: ["A1"], missing: ["gone.mov"], warnings: [],
    markers: [{ time: 1, duration: 0, name: "M", colour: "#D14343", comment: "" }],
    clips: [
      clipOf({}),
      clipOf({ lane: "audio" }),
      clipOf({ name: "gone.mov", path: null, wanted: "/edl/gone.mov", start: 2, transition: ["dissolve", 0.5] }),
      clipOf({ start: 5, odyssey: { effects: [{ kind: "hue", degrees: 30 }], source: { type: "media", path: "/old/a.mov" } } }),
    ],
  };
  const blank = emptyProject();
  placeImported(blank, im, () => false);
  check("an empty project takes the list on its own tracks", blank.tracks.length === 2
    && blank.tracks[0].clips.length === 3 && blank.tracks[1].clips.length === 1);
  const [v0, a0] = [blank.tracks[0].clips[0], blank.tracks[1].clips[0]];
  check("picture and sound of one event are linked", !!v0.link && v0.link === a0.link);
  const gone = blank.tracks[0].clips[1];
  check("a missing file comes in offline at the expected path", gone.source.type === "media"
    && gone.source.path === "/edl/gone.mov" && gone.transition_in?.kind === "dissolve");
  const whole = blank.tracks[0].clips[2];
  check("an Odyssey clip is restored whole, pointing at the found file", whole.effects.length === 1
    && (whole.source as { path: string }).path === "/m/a.mov" && whole.start === 5);
  check("markers come across", blank.markers.length === 1 && blank.markers[0].colour === "#D14343");
  const busy = emptyProject();
  busy.tracks[0].clips = [makeClip({ type: "color", color: "red" }, 0, 4)];
  placeImported(busy, im, () => false);
  check("a timeline with work on it gets new tracks", busy.tracks.length === 4
    && busy.tracks[0].clips.length === 1 && busy.tracks[2].name === "Cut V1");
} catch (e) {
  lines.push(`ERROR ${(e as Error).stack ?? e}`);
}
out.textContent = "EDITOR\n" + lines.join("\n");
