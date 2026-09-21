/** Odyssey Video — timeline edit operations.
 *
 *  Pure functions over the project model, kept apart from the editor so each
 *  one can be reasoned about (and exercised) without a DOM. They mutate the
 *  project they are given; the editor wraps every call in its undo snapshot. */
import {
  clipDuration, clipEnd, isAnimated, paramAt, sourceDuration, splitClip,
  type Clip, type Project, type Track,
} from "./timeline";

const EPS = 1e-6;

/** The tracks an edit acts on. Targeted tracks when any are targeted, the way
 *  Premiere's source patching works, otherwise every unlocked track. */
export function editTracks(p: Project): Track[] {
  const targeted = p.tracks.filter((t) => t.targeted && !t.locked);
  return targeted.length ? targeted : p.tracks.filter((t) => !t.locked);
}

/** Edit tracks plus any unlocked track with sync lock on. Ripple edits move
 *  these too, so picture and sound on other tracks stay in step. */
export function rippleTracks(p: Project, edited: Track[]): Track[] {
  const ids = new Set(edited.map((t) => t.id));
  return p.tracks.filter((t) => !t.locked && (ids.has(t.id) || t.sync_lock));
}

/** Cut a track at `t`, wherever a clip straddles it. */
export function cutTrackAt(track: Track, t: number): void {
  for (const clip of [...track.clips]) {
    if (t > clip.start + EPS && t < clipEnd(clip) - EPS) splitClip(track, clip, t);
  }
}

/** Remove `[a, b)` from a track, leaving a gap. Clips straddling a boundary
 *  are cut there first. `splitClip` refuses cuts within a few frames of an
 *  edge, so membership is decided by each piece's midpoint rather than by
 *  exact bounds. */
export function removeRange(track: Track, a: number, b: number): number {
  if (b <= a) return 0;
  cutTrackAt(track, a);
  cutTrackAt(track, b);
  const before = track.clips.length;
  track.clips = track.clips.filter((c) => {
    const mid = (c.start + clipEnd(c)) / 2;
    return !(mid >= a && mid < b);
  });
  return before - track.clips.length;
}

/** Move everything at or after `from` by `delta` seconds on the given tracks,
 *  and the markers and subtitles with them. */
export function shiftAfter(p: Project, tracks: Track[], from: number, delta: number): void {
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.start >= from - EPS) clip.start = Math.max(0, clip.start + delta);
    }
  }
  for (const m of p.markers) if (m.time >= from - EPS) m.time = Math.max(0, m.time + delta);
  for (const s of p.subtitles) {
    if (s.start >= from - EPS) {
      s.start = Math.max(0, s.start + delta);
      s.end = Math.max(s.start + 0.05, s.end + delta);
    }
  }
}

/** Premiere's Lift: take `[a, b)` out of the edit tracks and leave the gap. */
export function lift(p: Project, a: number, b: number): number {
  return editTracks(p).reduce((n, t) => n + removeRange(t, a, b), 0);
}

/** Premiere's Extract: take `[a, b)` out and close the gap. Sync-locked tracks
 *  lose the same span, which is what keeps them in sync. */
export function extract(p: Project, a: number, b: number): number {
  if (b <= a) return 0;
  const tracks = rippleTracks(p, editTracks(p));
  let removed = 0;
  for (const t of tracks) removed += removeRange(t, a, b);
  // Markers inside the span have nothing left to mark; drop them.
  p.markers = p.markers.filter((m) => !(m.time >= a && m.time < b));
  shiftAfter(p, tracks, b, -(b - a));
  return removed;
}

/** Every cut on the given tracks, sorted, including zero. */
export function editPointsOf(tracks: Track[]): number[] {
  const set = new Set<number>([0]);
  for (const t of tracks) {
    for (const c of t.clips) {
      set.add(Number(c.start.toFixed(5)));
      set.add(Number(clipEnd(c).toFixed(5)));
    }
  }
  return [...set].sort((x, y) => x - y);
}

/** Ripple Trim Previous Edit to Playhead (Q): remove from the nearest edit
 *  before the playhead up to it, and close the gap. Returns where the playhead
 *  should land, or null when there is nothing to trim. */
export function rippleTrimPrevious(p: Project, t: number): number | null {
  const edge = [...editPointsOf(editTracks(p))].reverse().find((e) => e < t - EPS);
  if (edge === undefined || !hasContent(p, edge, t)) return null;
  extract(p, edge, t);
  return edge;
}

/** Ripple Trim Next Edit to Playhead (W). The playhead stays where it is. */
export function rippleTrimNext(p: Project, t: number): boolean {
  const edge = editPointsOf(editTracks(p)).find((e) => e > t + EPS);
  if (edge === undefined || !hasContent(p, t, edge)) return false;
  extract(p, t, edge);
  return true;
}

function hasContent(p: Project, a: number, b: number): boolean {
  return editTracks(p).some((t) => t.clips.some((c) => c.start < b && clipEnd(c) > a));
}

/** Premiere's Insert: open space at `at` on the target and sync-locked tracks,
 *  then drop the clip into it. */
export function insertClip(p: Project, target: Track, clip: Clip, at: number): void {
  const len = clipDuration(clip);
  const tracks = rippleTracks(p, [target]);
  for (const t of tracks) cutTrackAt(t, at);
  shiftAfter(p, tracks, at, len);
  clip.start = at;
  target.clips.push(clip);
}

/** Premiere's Overwrite: replace whatever the clip lands on. Nothing moves. */
export function overwriteClip(target: Track, clip: Clip, at: number): void {
  removeRange(target, at, at + clipDuration(clip));
  clip.start = at;
  target.clips.push(clip);
}

/** Close every gap on each track, pulling clips left to meet the one before,
 *  and the first clip back to zero. Returns the total time closed. */
export function closeGaps(tracks: Track[]): number {
  let closed = 0;
  for (const track of tracks) {
    let cursor = 0;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (clip.start > cursor + EPS) {
        closed += clip.start - cursor;
        clip.start = cursor;
      }
      cursor = Math.max(cursor, clipEnd(clip));
    }
  }
  return closed;
}

function sourceKey(c: Clip): string | null {
  if (c.source.type === "media" || c.source.type === "still") return `${c.source.type}:${c.source.path}`;
  return null;
}

/** Everything about a clip except where it sits and which span it shows. Two
 *  halves of a through edit must agree on all of it or joining would change
 *  the picture. */
function lookOf(c: Clip): string {
  return JSON.stringify([c.speed, c.reverse, c.gain, c.muted, c.effects, c.motion, c.blend,
    c.channels, c.preserve_pitch, c.interpolation, c.label, c.group, c.link]);
}

/** Through edits: a cut with continuous source either side, as a razor leaves.
 *  Returned as [left, right] pairs. */
export function throughEdits(track: Track): Array<[Clip, Clip]> {
  const ordered = [...track.clips].sort((a, b) => a.start - b.start);
  const out: Array<[Clip, Clip]> = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i], b = ordered[i + 1];
    const key = sourceKey(a);
    if (!key || key !== sourceKey(b)) continue;
    if (isAnimated(a.speed) || b.transition_in) continue;
    if (Math.abs(clipEnd(a) - b.start) > 1e-3) continue;
    if (Math.abs(a.out_point - b.in_point) > 1e-3) continue;
    if (lookOf(a) !== lookOf(b)) continue;
    out.push([a, b]);
  }
  return out;
}

/** Join every through edit on the tracks. Returns how many were joined. */
export function joinThroughEdits(tracks: Track[]): number {
  let n = 0;
  for (const track of tracks) {
    // Rescan after each join: the joined clip may meet the next piece too.
    for (let pair = throughEdits(track)[0]; pair; pair = throughEdits(track)[0]) {
      const [a, b] = pair;
      a.out_point = b.out_point;
      track.clips = track.clips.filter((c) => c.id !== b.id);
      n++;
    }
  }
  return n;
}

/** Wrap the chosen clips into a nested sequence. The clips leave their tracks
 *  and one nested clip takes their place on the lowest track involved. */
export function nestClips(p: Project, picked: Array<{ clip: Clip; track: Track }>, name: string): Clip | null {
  if (!picked.length) return null;
  const start = Math.min(...picked.map((x) => x.clip.start));
  const end = Math.max(...picked.map((x) => clipEnd(x.clip)));
  const involved = p.tracks.filter((t) => picked.some((x) => x.track.id === t.id));
  const ids = new Set(picked.map((x) => x.clip.id));

  const inner: Project = {
    ...structuredClone(p),
    tracks: involved.map((t) => ({
      ...structuredClone(t),
      id: crypto.randomUUID(),
      locked: false, targeted: false, solo: false, muted: false, hidden: false,
      duck_under: null,
      clips: t.clips.filter((c) => ids.has(c.id)).map((c) => ({ ...structuredClone(c), start: c.start - start })),
    })),
    markers: [], zone_in: null, zone_out: null, subtitles: [], bin: [],
  };

  for (const t of involved) t.clips = t.clips.filter((c) => !ids.has(c.id));
  const host = involved.find((t) => t.kind === "video") ?? involved[0];
  const nested: Clip = {
    ...structuredClone(picked[0].clip),
    id: crypto.randomUUID(),
    source: { type: "nested", name, project: inner },
    start, in_point: 0, out_point: end - start,
    speed: 1, reverse: false, gain: 1, muted: false, effects: [],
    motion: { x: 0, y: 0, scale: 100, rotation: 0, anchor_x: 0, anchor_y: 0, opacity: 1 },
    blend: "normal", channels: [], transition_in: null,
    name, label: "", group: null, link: null, interpolation: "sampling",
  };
  host.clips.push(nested);
  return nested;
}

/** Undo a nest: put the sequence's clips back on the outer timeline where the
 *  nested clip showed them. Inner tracks land on the host track and the tracks
 *  of the same kind above it, and a new track is made wherever that space is
 *  already taken. Returns the clips placed. */
export function breakApart(p: Project, host: Track, clip: Clip): Clip[] {
  if (clip.source.type !== "nested") return [];
  const inner = structuredClone(clip.source.project);
  const offset = clip.start - clip.in_point;
  const [a, b] = [clip.in_point, clip.out_point];
  host.clips = host.clips.filter((c) => c.id !== clip.id);

  const placed: Clip[] = [];
  const hostIndex = p.tracks.indexOf(host);
  for (const [i, track] of inner.tracks.entries()) {
    // Only what the nested clip actually showed comes back out.
    removeRange(track, -1e9, a);
    removeRange(track, b, 1e9);
    if (!track.clips.length) continue;
    const span: [number, number] = [
      Math.min(...track.clips.map((c) => c.start)) + offset,
      Math.max(...track.clips.map((c) => clipEnd(c))) + offset,
    ];
    const sameKind = p.tracks.filter((t, idx) => t.kind === track.kind && idx >= hostIndex);
    let dest = sameKind.find((t, n) =>
      n >= Math.min(i, sameKind.length) && !t.locked &&
      !t.clips.some((c) => c.start < span[1] - EPS && clipEnd(c) > span[0] + EPS));
    if (!dest) {
      dest = { ...structuredClone(track), id: crypto.randomUUID(), clips: [], name: `${track.name} (unnested)` };
      p.tracks.splice(hostIndex + 1 + i, 0, dest);
    }
    for (const c of track.clips) {
      const moved = { ...c, id: crypto.randomUUID(), start: c.start + offset };
      dest.clips.push(moved);
      placed.push(moved);
    }
  }
  return placed;
}

/** How far to move `other` so its audio lines up with `reference`.
 *
 *  Both are peak envelopes of the whole source at `rate` buckets per second.
 *  The answer is the lag maximising their normalised cross-correlation,
 *  searched within `maxLag` seconds, in source seconds: positive means the
 *  moment in `other` happens later in its file than in the reference's. */
export function audioLag(reference: number[], other: number[], rate: number, maxLag: number): number {
  const centre = (xs: number[]) => {
    const mean = xs.reduce((n, v) => n + v, 0) / Math.max(1, xs.length);
    return xs.map((v) => v - mean);
  };
  const a = centre(reference);
  const b = centre(other);
  const limit = Math.min(Math.round(maxLag * rate), Math.max(a.length, b.length));
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = -limit; lag <= limit; lag++) {
    let sum = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      sum += a[i] * b[j];
      na += a[i] * a[i];
      nb += b[j] * b[j];
    }
    // Normalising stops a lag with more overlap winning on length alone.
    const score = na > 0 && nb > 0 ? sum / Math.sqrt(na * nb) : -Infinity;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return best / rate;
}

/** Scale percent at which a picture of `w`×`h` fills the frame. The renderer
 *  fits media inside the frame first, so 100% is fit and this is the rest. */
export function fillScale(w: number, h: number, frameW: number, frameH: number): number {
  if (!w || !h) return 100;
  const fit = Math.min(frameW / w, frameH / h);
  return 100 * Math.max(frameW / (w * fit), frameH / (h * fit));
}

/** The selection grown to whole groups and linked partners, as clicking one
 *  member of a group or one side of a linked pair selects all of it. */
export function expandSelection(p: Project, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const groups = new Set<string>();
  const links = new Set<string>();
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (!out.has(c.id)) continue;
      if (c.group) groups.add(c.group);
      if (c.link) links.add(c.link);
    }
  }
  if (!groups.size && !links.size) return out;
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if ((c.group && groups.has(c.group)) || (c.link && links.has(c.link))) out.add(c.id);
    }
  }
  return out;
}

/** Retime a clip to a new speed, keeping its source span, and ripple the rest
 *  of its track when asked. */
export function setClipSpeed(p: Project, track: Track, clip: Clip, speed: number, ripple: boolean): void {
  const oldEnd = clipEnd(clip);
  clip.speed = Math.min(100, Math.max(0.01, speed));
  if (ripple) {
    const delta = clipEnd(clip) - oldEnd;
    const tracks = rippleTracks(p, [track]).filter((t) => t.id !== track.id);
    for (const c of track.clips) if (c.id !== clip.id && c.start >= oldEnd - EPS) c.start += delta;
    for (const t of tracks) for (const c of t.clips) if (c.start >= oldEnd - EPS) c.start = Math.max(0, c.start + delta);
  }
}

/** Speed that makes a clip last `seconds` on the timeline. */
export function speedForDuration(clip: Clip, seconds: number): number {
  return sourceDuration(clip) / Math.max(0.01, seconds);
}

/** The static speed of a clip, or null while it is ramped. */
export function staticSpeed(clip: Clip): number | null {
  return isAnimated(clip.speed) ? null : Math.abs(paramAt(clip.speed, 0)) || 1;
}
