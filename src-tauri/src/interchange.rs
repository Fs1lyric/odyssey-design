//! Odyssey Video — reading timelines other editors wrote.
//!
//! Export lives beside the renderer in `timeline.rs`; this is the other
//! direction. Both formats are parsed into a flat list of placed clips rather
//! than a `Project`, because the editor owns clip construction (ids, defaults,
//! editor-only fields) and merges the result into whatever is already open.
//!
//! Parsing is pure. Finding the files an edit list names, and reading their
//! embedded start timecode, happens afterwards in `resolve`, so the parsers
//! can be tested on text alone.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    Video,
    Audio,
}

/// One clip placed on the imported timeline.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedClip {
    pub lane: Lane,
    /// Index among tracks of the same lane, from the bottom.
    pub track: usize,
    /// The name the list gives the clip, for display and for finding its file.
    pub name: String,
    /// The file, once resolved. None means it could not be found; the editor
    /// places it offline under `wanted` so Link Media can find it later.
    pub path: Option<String>,
    /// Where the file was expected, for the offline placeholder.
    pub wanted: String,
    /// `black`, `bars` or a colour for generated sources; None for media.
    pub generator: Option<String>,
    pub start: f64,
    pub in_point: f64,
    pub out_point: f64,
    pub speed: f64,
    pub reverse: bool,
    /// Transition at the head, as (kind, seconds). Kinds are Odyssey's.
    pub transition: Option<(String, f64)>,
    /// The complete clip, when the file is an Odyssey export carrying it.
    pub odyssey: Option<serde_json::Value>,
    /// True when `in_point` is a source timecode not yet made file-relative.
    #[serde(skip)]
    pub timecode_source: bool,
    /// A full path the list itself recorded, tried before any search.
    #[serde(skip)]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedMarker {
    pub time: f64,
    pub duration: f64,
    pub name: String,
    pub colour: String,
    pub comment: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Imported {
    pub title: String,
    pub video_tracks: Vec<String>,
    pub audio_tracks: Vec<String>,
    pub clips: Vec<ImportedClip>,
    pub markers: Vec<ImportedMarker>,
    /// Clip names whose files were not found.
    pub missing: Vec<String>,
    /// What the import could not carry over, in words.
    pub warnings: Vec<String>,
}

impl Imported {
    fn ensure_track(&mut self, lane: Lane, index: usize) {
        let (list, prefix) = match lane {
            Lane::Video => (&mut self.video_tracks, "V"),
            Lane::Audio => (&mut self.audio_tracks, "A"),
        };
        while list.len() <= index {
            list.push(format!("{prefix}{}", list.len() + 1));
        }
    }

    fn warn(&mut self, text: String) {
        if !self.warnings.contains(&text) {
            self.warnings.push(text);
        }
    }
}

// ---------------------------------------------------------------- timecode

/// Seconds from a SMPTE timecode. `;` or `.` before the frames field, or
/// `drop` set by an FCM line, means drop-frame counting, where frame numbers
/// 0 and 1 (0–3 at 60) are skipped every minute except each tenth.
pub fn timecode(tc: &str, fps: f64, drop: bool) -> Option<f64> {
    let parts: Vec<&str> = tc.split([':', ';', '.']).collect();
    if parts.len() != 4 {
        return None;
    }
    let n: Vec<u64> = parts
        .iter()
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    let nominal = fps.round().max(1.0) as u64;
    let drop = drop || tc.contains(';') || tc.contains('.');
    let (h, m, s, f) = (n[0], n[1], n[2], n[3]);
    let mut frames = ((h * 3600 + m * 60 + s) * nominal + f) as f64;
    if drop && nominal.is_multiple_of(30) {
        let skip = (nominal / 15) as f64;
        let minutes = (h * 60 + m) as f64;
        frames -= skip * (minutes - (minutes / 10.0).floor());
        // Drop-frame timecode counts 30000/1001 frames a second, not 30.
        return Some(frames / (nominal as f64 * 1000.0 / 1001.0));
    }
    Some(frames / fps.max(1.0))
}

fn is_timecode(s: &str) -> bool {
    s.len() >= 11
        && s.chars()
            .all(|c| c.is_ascii_digit() || c == ':' || c == ';' || c == '.')
        && s.split([':', ';', '.']).count() == 4
}

// --------------------------------------------------------------------- EDL

/// CMX3600 channel field to the lanes it names. `B` and `AA/V` carry both.
fn edl_lanes(channel: &str) -> Vec<(Lane, usize)> {
    let c = channel.to_ascii_uppercase();
    let mut out = Vec::new();
    for part in c.split('/') {
        match part {
            "V" => out.push((Lane::Video, 0)),
            "A" | "AA" | "A1" => out.push((Lane::Audio, 0)),
            "B" => {
                out.push((Lane::Video, 0));
                out.push((Lane::Audio, 0));
            }
            p if p.starts_with('A') => {
                if let Ok(n) = p[1..].parse::<usize>() {
                    out.push((Lane::Audio, n.saturating_sub(1)));
                }
            }
            _ => {}
        }
    }
    out.dedup();
    out
}

/// SMPTE wipe codes to Odyssey transitions. Only the common ones have a
/// counterpart; the rest become a dissolve and say so.
fn wipe_kind(code: &str) -> Option<&'static str> {
    match code.trim_start_matches(['W', 'w']).parse::<u32>().ok()? {
        1 => Some("wiperight"),
        2 => Some("wipedown"),
        3 => Some("cornerwipetopleft"),
        4 => Some("cornerwipetopright"),
        5 => Some("barndooropen"),
        6 => Some("barndooropen"),
        7 => Some("diagonalwipe"),
        8 => Some("diagonalwipe"),
        101 | 102 => Some("irisopen"),
        _ => None,
    }
}

struct EdlEvent {
    reel: String,
    lanes: Vec<(Lane, usize)>,
    trans: String,
    frames: f64,
    src_in: f64,
    rec_in: f64,
    rec_out: f64,
    from_name: Option<String>,
    to_name: Option<String>,
    source_file: Option<String>,
    speed: Option<f64>,
}

/// Parse a CMX3600 edit decision list.
///
/// Record times start wherever the sequence did, usually 01:00:00:00; whole
/// hours before the first event are removed so the timeline begins at zero.
/// Source times stay as timecode until `resolve` knows each file's own start.
pub fn parse_edl(text: &str, fps: f64) -> Imported {
    let mut out = Imported::default();
    let mut drop = false;
    let mut events: Vec<EdlEvent> = Vec::new();
    let mut locs: Vec<(f64, String, String)> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let upper = line.to_ascii_uppercase();
        if let Some(t) = line.strip_prefix("TITLE:") {
            out.title = t.trim().to_string();
            continue;
        }
        if upper.starts_with("FCM:") {
            drop = upper.contains("DROP") && !upper.contains("NON-DROP");
            continue;
        }
        if let Some(rest) = line.strip_prefix('*') {
            let rest = rest.trim();
            let field = |key: &str| {
                rest.to_ascii_uppercase()
                    .starts_with(key)
                    .then(|| rest[key.len()..].trim().to_string())
            };
            if let Some(ev) = events.last_mut() {
                if let Some(v) = field("FROM CLIP NAME:") {
                    ev.from_name = Some(v);
                } else if let Some(v) = field("TO CLIP NAME:") {
                    ev.to_name = Some(v);
                } else if let Some(v) = field("SOURCE FILE:") {
                    ev.source_file = Some(v);
                }
            }
            if let Some(v) = field("LOC:") {
                // * LOC: 01:00:05:00 RED     Marker name
                let mut it = v.splitn(3, char::is_whitespace).filter(|s| !s.is_empty());
                if let Some(tc) = it.next() {
                    let colour = it.next().unwrap_or("").to_string();
                    let name = it.next().unwrap_or("").trim().to_string();
                    locs.push((timecode(tc, fps, drop).unwrap_or(0.0), colour, name));
                }
            }
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.first() == Some(&"M2") {
            // M2   REEL   050.0   01:00:00:00 — playback in frames a second.
            if let (Some(ev), Some(rate)) = (
                events.last_mut(),
                tokens.get(2).and_then(|v| v.parse::<f64>().ok()),
            ) {
                ev.speed = Some(rate / fps.max(1.0));
            }
            continue;
        }
        if tokens.len() < 8 || !tokens[0].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let tcs: Vec<&str> = tokens[tokens.len() - 4..].to_vec();
        if !tcs.iter().all(|t| is_timecode(t)) {
            continue;
        }
        let tc = |s: &str| timecode(s, fps, drop).unwrap_or(0.0);
        let trans = tokens[3].to_ascii_uppercase();
        let frames = if tokens.len() >= 9 {
            tokens[4].parse::<f64>().unwrap_or(0.0)
        } else {
            0.0
        };
        events.push(EdlEvent {
            reel: tokens[1].to_string(),
            lanes: edl_lanes(tokens[2]),
            trans,
            frames,
            // The source out is implied by the record length and speed, and
            // lists disagree on whether it is scaled, so it is not read.
            src_in: tc(tcs[0]),
            rec_in: tc(tcs[2]),
            rec_out: tc(tcs[3]),
            from_name: None,
            to_name: None,
            source_file: None,
            speed: None,
        });
    }

    let first = events
        .iter()
        .map(|e| e.rec_in)
        .chain(locs.iter().map(|l| l.0))
        .fold(f64::INFINITY, f64::min);
    let origin = if first.is_finite() {
        (first / 3600.0).floor() * 3600.0
    } else {
        0.0
    };

    for ev in &events {
        let rec_len = ev.rec_out - ev.rec_in;
        // The first line of a dissolve pair is the outgoing clip held for
        // zero frames; the clip itself is the previous event.
        if rec_len <= 1e-6 {
            continue;
        }
        let speed = ev.speed.unwrap_or(1.0);
        let reverse = speed < 0.0;
        let rate = speed.abs().max(0.01);
        let mut start = ev.rec_in - origin;
        let mut src_in = ev.src_in;
        let mut len = rec_len;
        let mut transition = None;
        if ev.trans != "C" {
            let secs = ev.frames / fps.max(1.0);
            let kind = if ev.trans == "D" {
                "dissolve"
            } else if ev.trans.starts_with('W') {
                wipe_kind(&ev.trans).unwrap_or_else(|| {
                    out.warn(format!(
                        "Wipe {} has no counterpart and came in as a dissolve.",
                        ev.trans
                    ));
                    "dissolve"
                })
            } else {
                out.warn("Keys (K events) came in as cuts.".into());
                ""
            };
            // An EDL starts a transition at the incoming event's record in.
            // Odyssey starts the clip at the cut and pulls it back over its
            // head handle, so the clip begins that much later in both times.
            if !kind.is_empty() && secs > 0.0 && secs < rec_len {
                start += secs;
                src_in += secs * rate;
                len -= secs;
                transition = Some((kind.to_string(), secs));
            }
        }
        let name = ev
            .to_name
            .clone()
            .or_else(|| ev.from_name.clone())
            .unwrap_or_else(|| ev.reel.clone());
        let reel = ev.reel.to_ascii_uppercase();
        let generator = match reel.as_str() {
            "BL" | "BLK" | "BLACK" => Some("black".to_string()),
            "BARS" => Some("bars".to_string()),
            _ => None,
        };
        if generator.as_deref() == Some("black") && transition.is_none() {
            // Black is the absence of a clip on a timeline with a black
            // background, which is what Odyssey's is by default.
            continue;
        }
        for &(lane, track) in &ev.lanes {
            out.ensure_track(lane, track);
            out.clips.push(ImportedClip {
                lane,
                track,
                name: name.clone(),
                path: None,
                wanted: String::new(),
                generator: generator.clone(),
                start,
                in_point: src_in,
                out_point: src_in + len * rate,
                speed: rate,
                reverse,
                transition: transition.clone(),
                odyssey: None,
                timecode_source: generator.is_none(),
                hint: ev.source_file.clone(),
            });
        }
    }

    for (time, colour, name) in locs {
        out.markers.push(ImportedMarker {
            time: time - origin,
            duration: 0.0,
            name,
            colour: marker_colour(&colour),
            comment: String::new(),
        });
    }
    if out.video_tracks.is_empty() && out.audio_tracks.is_empty() && !events.is_empty() {
        out.warn("The list named no channel Odyssey understands.".into());
    }
    out
}

/// Marker colour names used by Premiere, Resolve and OTIO, as hex.
fn marker_colour(name: &str) -> String {
    match name.to_ascii_uppercase().as_str() {
        "RED" => "#D14343",
        "ORANGE" => "#E07B24",
        "YELLOW" => "#D6B11F",
        "GREEN" => "#3F9E4D",
        "CYAN" => "#2EA3B8",
        "BLUE" => "#2C5FC9",
        "PURPLE" | "MAGENTA" | "VIOLET" => "#8A4FC9",
        "PINK" => "#D45C9E",
        "WHITE" => "#E6E6E6",
        "BLACK" => "#333333",
        _ => "#2C5FC9",
    }
    .into()
}

// -------------------------------------------------------------------- OTIO

fn rational(v: &serde_json::Value) -> Option<f64> {
    let rate = v["rate"].as_f64()?;
    let value = v["value"].as_f64()?;
    (rate > 0.0).then(|| value / rate)
}

fn range(v: &serde_json::Value) -> Option<(f64, f64)> {
    Some((rational(&v["start_time"])?, rational(&v["duration"])?))
}

fn schema(v: &serde_json::Value) -> &str {
    v["OTIO_SCHEMA"]
        .as_str()
        .and_then(|s| s.split('.').next())
        .unwrap_or("")
}

/// `file:///a%20b.mov` to `/a b.mov`. Anything that is not a file URL is
/// returned as written.
fn url_to_path(url: &str) -> String {
    let Some(rest) = url.strip_prefix("file://") else {
        return url.to_string();
    };
    // file://localhost/path and file:///C:/path
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let rest = match rest.as_bytes() {
        [b'/', d, b':', ..] if d.is_ascii_alphabetic() => &rest[1..],
        _ => rest,
    };
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn otio_transition(name: &str) -> &'static str {
    match name {
        "SMPTE_Dissolve" | "Dissolve" | "Cross Dissolve" => "dissolve",
        "FadeIn" | "FadeOut" | "Dip to Black" => "diptoblack",
        _ => "dissolve",
    }
}

/// Parse an OpenTimelineIO timeline.
///
/// Tracks are contiguous in OTIO, so a clip's place is the running sum of
/// everything before it. Transitions sit between items and take no time; the
/// incoming clip carries them here. A clip's source range is in its media's
/// own time, which starts at the reference's available range when it has one.
pub fn parse_otio(text: &str) -> Result<Imported, String> {
    let doc: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("not an OTIO file: {e}"))?;
    let timeline = match schema(&doc) {
        "Timeline" => doc,
        "SerializableCollection" => doc["children"]
            .as_array()
            .and_then(|c| c.iter().find(|x| schema(x) == "Timeline"))
            .cloned()
            .ok_or("the collection holds no timeline")?,
        other => return Err(format!("expected a Timeline, found {other:?}")),
    };
    let mut out = Imported {
        title: timeline["name"].as_str().unwrap_or("").to_string(),
        ..Default::default()
    };
    let origin = rational(&timeline["global_start_time"]).unwrap_or(0.0);

    let stack = &timeline["tracks"];
    for m in stack["markers"].as_array().into_iter().flatten() {
        if let Some((t, d)) = range(&m["marked_range"]) {
            out.markers.push(ImportedMarker {
                time: (t - origin).max(0.0),
                duration: d.max(0.0),
                name: m["name"].as_str().unwrap_or("").to_string(),
                colour: marker_colour(m["color"].as_str().unwrap_or("")),
                comment: m["metadata"]["odyssey"]["comment"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }

    let mut counts: HashMap<&str, usize> = HashMap::new();
    for track in stack["children"].as_array().into_iter().flatten() {
        if schema(track) != "Track" {
            out.warn("A nested stack at the top level was skipped.".into());
            continue;
        }
        let lane = if track["kind"].as_str() == Some("Audio") {
            Lane::Audio
        } else {
            Lane::Video
        };
        let key = if lane == Lane::Audio { "a" } else { "v" };
        let index = *counts.entry(key).or_default();
        counts.insert(key, index + 1);
        out.ensure_track(lane, index);
        if let Some(name) = track["name"].as_str().filter(|n| !n.is_empty()) {
            match lane {
                Lane::Video => out.video_tracks[index] = name.to_string(),
                Lane::Audio => out.audio_tracks[index] = name.to_string(),
            }
        }

        let mut cursor = 0.0;
        let mut pending: Option<(String, f64)> = None;
        for item in track["children"].as_array().into_iter().flatten() {
            match schema(item) {
                "Gap" => {
                    cursor += range(&item["source_range"]).map(|r| r.1).unwrap_or(0.0);
                }
                "Transition" => {
                    let a = rational(&item["in_offset"]).unwrap_or(0.0);
                    let b = rational(&item["out_offset"]).unwrap_or(0.0);
                    let kind = otio_transition(item["transition_type"].as_str().unwrap_or(""));
                    pending = Some((kind.to_string(), a + b));
                }
                "Clip" => {
                    let Some((src_start, dur)) = range(&item["source_range"]) else {
                        out.warn("A clip with no source range was skipped.".into());
                        continue;
                    };
                    let reference = if item["media_reference"].is_object() {
                        &item["media_reference"]
                    } else {
                        // OTIO 0.15 moved references into a map.
                        let key = item["active_media_reference_key"]
                            .as_str()
                            .unwrap_or("DEFAULT_MEDIA");
                        &item["media_references"][key]
                    };
                    let avail = range(&reference["available_range"]).map(|r| r.0);
                    let mut speed = 1.0;
                    for fx in item["effects"].as_array().into_iter().flatten() {
                        match schema(fx) {
                            "LinearTimeWarp" => speed *= fx["time_scalar"].as_f64().unwrap_or(1.0),
                            "FreezeFrame" => speed = 0.0,
                            _ => out.warn(format!(
                                "Effect {:?} has no counterpart and was dropped.",
                                fx["effect_name"].as_str().unwrap_or("unnamed")
                            )),
                        }
                    }
                    let (generator, url) = match schema(reference) {
                        "ExternalReference" => {
                            (None, reference["target_url"].as_str().map(url_to_path))
                        }
                        "GeneratorReference" => {
                            let kind = reference["generator_kind"].as_str().unwrap_or("");
                            let g = match kind {
                                "SMPTEBars" | "bars" => "bars".to_string(),
                                "SolidColor" => reference["parameters"]["color"]
                                    .as_str()
                                    .unwrap_or("black")
                                    .to_string(),
                                _ => "black".to_string(),
                            };
                            (Some(g), None)
                        }
                        _ => (None, None),
                    };
                    let name = item["name"].as_str().unwrap_or("").to_string();
                    let odyssey = item["metadata"]["odyssey"]["clip"].clone();
                    let frozen = speed == 0.0;
                    let rate = speed.abs();
                    let in_point = src_start - avail.unwrap_or(0.0);
                    // A freeze holds one frame for the clip's duration, which
                    // is a very slow clip of one frame's source.
                    let (out_point, clip_speed, len) = if frozen {
                        let frame = 1.0 / 30.0;
                        (in_point + frame, frame / dur.max(1e-3), dur)
                    } else {
                        // source_range.duration is in the clip's own time,
                        // before any time warp, so its span on the track is
                        // scaled by the warp.
                        (in_point + dur * rate, rate, dur)
                    };
                    let transition = pending.take();
                    out.clips.push(ImportedClip {
                        lane,
                        track: index,
                        name: if name.is_empty() {
                            url.as_deref()
                                .map(|u| u.rsplit(['/', '\\']).next().unwrap_or(u).to_string())
                                .unwrap_or_default()
                        } else {
                            name
                        },
                        path: None,
                        wanted: String::new(),
                        generator,
                        start: cursor,
                        in_point,
                        out_point,
                        speed: clip_speed,
                        reverse: speed < 0.0,
                        transition,
                        odyssey: odyssey.is_object().then_some(odyssey),
                        timecode_source: false,
                        hint: url,
                    });
                    cursor += len;
                }
                "Stack" => {
                    let d = range(&item["source_range"])
                        .map(|r| r.1)
                        .or_else(|| stack_duration(item))
                        .unwrap_or(0.0);
                    out.warn("Nested stacks were left as gaps.".into());
                    cursor += d;
                }
                _ => {}
            }
        }
    }
    Ok(out)
}

/// The length of a nested stack with no explicit range: its longest track.
fn stack_duration(stack: &serde_json::Value) -> Option<f64> {
    stack["children"].as_array().map(|tracks| {
        tracks
            .iter()
            .map(|t| {
                t["children"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| schema(c) != "Transition")
                    .filter_map(|c| range(&c["source_range"]).map(|r| r.1))
                    .sum::<f64>()
            })
            .fold(0.0, f64::max)
    })
}

// --------------------------------------------------------------- resolving

fn base_name(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

fn stem(p: &str) -> &str {
    let b = base_name(p);
    b.rsplit_once('.').map(|(s, _)| s).unwrap_or(b)
}

/// The file a clip names, found in this order: the full path the list
/// recorded; a bin item with the same file name; a file of that name beside
/// the list; a bin item whose name without extension matches (EDL reels are
/// often the file stem). Comparison ignores case.
pub fn find_file(clip: &ImportedClip, known: &[String], dir: Option<&Path>) -> Option<String> {
    if let Some(h) = &clip.hint {
        if Path::new(h).is_file() {
            return Some(h.clone());
        }
    }
    let names: Vec<String> = [clip.hint.as_deref(), Some(clip.name.as_str())]
        .into_iter()
        .flatten()
        .map(|n| base_name(n).to_lowercase())
        .filter(|n| !n.is_empty())
        .collect();
    if let Some(k) = known
        .iter()
        .find(|k| names.contains(&base_name(k).to_lowercase()))
    {
        return Some(k.clone());
    }
    if let Some(dir) = dir {
        for n in [clip.hint.as_deref(), Some(clip.name.as_str())]
            .into_iter()
            .flatten()
        {
            let p = dir.join(base_name(n));
            if !base_name(n).is_empty() && p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    let wanted = stem(&clip.name).to_lowercase();
    known
        .iter()
        .find(|k| !wanted.is_empty() && stem(k).to_lowercase() == wanted)
        .cloned()
}

/// A file's embedded start timecode in seconds, if it has one. Camera files
/// usually do, and an EDL's source times are counted from it.
pub fn start_timecode(path: &str, fps: f64) -> Option<f64> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format_tags=timecode:stream_tags=timecode",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let tc = text.lines().map(str::trim).find(|l| is_timecode(l))?;
    timecode(tc, fps, false)
}

/// Find every clip's file and make source timecodes file-relative. Clips
/// that cannot be found keep `path: None` and are listed in `missing`.
pub fn resolve(
    mut imported: Imported,
    known: &[String],
    dir: Option<&Path>,
    fps: f64,
    probe_tc: impl Fn(&str, f64) -> Option<f64>,
) -> Imported {
    let mut tc_cache: HashMap<String, Option<f64>> = HashMap::new();
    let mut missing = Vec::new();
    for clip in &mut imported.clips {
        if clip.generator.is_some() {
            continue;
        }
        match find_file(clip, known, dir) {
            Some(path) => {
                if clip.timecode_source {
                    let tc = *tc_cache
                        .entry(path.clone())
                        .or_insert_with(|| probe_tc(&path, fps));
                    // Only subtract a start the source times actually sit
                    // past; a file with no timecode counts from zero.
                    if let Some(tc) = tc.filter(|tc| clip.in_point + 1e-6 >= *tc) {
                        clip.in_point -= tc;
                        clip.out_point -= tc;
                    }
                }
                clip.path = Some(path);
            }
            None => {
                let base = clip
                    .hint
                    .as_deref()
                    .map(base_name)
                    .filter(|b| b.contains('.'))
                    .unwrap_or(&clip.name)
                    .to_string();
                clip.wanted = match (&clip.hint, dir) {
                    (Some(h), _) if Path::new(h).is_absolute() => h.clone(),
                    (_, Some(d)) => d.join(&base).to_string_lossy().into_owned(),
                    _ => base.clone(),
                };
                if !missing.contains(&clip.name) {
                    missing.push(clip.name.clone());
                }
            }
        }
    }
    imported.missing = missing;
    imported
}

#[cfg(test)]
mod tests {
    use super::*;

    const EDL: &str = "TITLE: Rough cut
FCM: NON-DROP FRAME

001  AX       V     C        00:00:00:00 00:00:04:00 01:00:00:00 01:00:04:00
* FROM CLIP NAME: interview.mov

002  AX       V     C        00:00:10:00 00:00:10:00 01:00:04:00 01:00:04:00
002  AX       V     D    025 00:00:20:00 00:00:25:00 01:00:04:00 01:00:09:00
* FROM CLIP NAME: interview.mov
* TO CLIP NAME: broll.mp4
* EFFECT NAME: CROSS DISSOLVE

003  AX       AA/V  C        00:00:02:00 00:00:04:00 01:00:12:00 01:00:14:00
M2   AX       050.0                00:00:02:00
* FROM CLIP NAME: fast.mov
* LOC: 01:00:01:00 RED     Pick up here
";

    #[test]
    fn timecode_counts_frames() {
        assert_eq!(timecode("00:00:04:00", 25.0, false), Some(4.0));
        assert_eq!(timecode("01:00:00:12", 25.0, false), Some(3600.48));
        assert_eq!(timecode("nonsense", 25.0, false), None);
    }

    #[test]
    fn drop_frame_skips_two_frames_a_minute() {
        // 00:01:00;02 is the first frame of minute one: frame 1800.
        let t = timecode("00:01:00;02", 30.0, false).unwrap();
        assert!((t - 1800.0 / (30000.0 / 1001.0)).abs() < 1e-9, "{t}");
        // Every tenth minute keeps its frames: 00:10:00;00 is frame 17982.
        let t = timecode("00:10:00;00", 30.0, false).unwrap();
        assert!((t - 17982.0 * 1001.0 / 30000.0).abs() < 1e-9, "{t}");
    }

    #[test]
    fn edl_places_cuts_from_zero() {
        let p = parse_edl(EDL, 25.0);
        assert_eq!(p.title, "Rough cut");
        let v: Vec<&ImportedClip> = p.clips.iter().filter(|c| c.lane == Lane::Video).collect();
        assert_eq!(v.len(), 3, "{:?}", p.clips);
        assert_eq!(v[0].start, 0.0, "the one-hour offset must go");
        assert_eq!((v[0].in_point, v[0].out_point), (0.0, 4.0));
        assert_eq!(v[0].name, "interview.mov");
    }

    #[test]
    fn edl_dissolve_lands_on_the_incoming_clip() {
        let p = parse_edl(EDL, 25.0);
        let b = p.clips.iter().find(|c| c.name == "broll.mp4").unwrap();
        let (kind, secs) = b.transition.clone().unwrap();
        assert_eq!(kind, "dissolve");
        assert_eq!(secs, 1.0);
        // Record in 4s plus the dissolve, which Odyssey pulls back over.
        assert_eq!(b.start, 5.0);
        assert_eq!(b.in_point, 21.0);
        assert_eq!(b.out_point, 25.0);
        assert!(
            !p.clips
                .iter()
                .any(|c| c.start == 4.0 && c.out_point == c.in_point),
            "the zero-length outgoing line is not a clip"
        );
    }

    #[test]
    fn edl_speed_and_both_channels() {
        let p = parse_edl(EDL, 25.0);
        let fast: Vec<&ImportedClip> = p.clips.iter().filter(|c| c.name == "fast.mov").collect();
        assert_eq!(fast.len(), 2, "AA/V is one clip on each lane");
        assert!(fast.iter().any(|c| c.lane == Lane::Audio));
        // 50 fps playback on a 25 fps list is double speed: 2s of record
        // time covers 4s of source.
        assert_eq!(fast[0].speed, 2.0);
        assert_eq!(fast[0].out_point - fast[0].in_point, 4.0);
        assert_eq!(p.markers.len(), 1);
        assert_eq!(p.markers[0].time, 1.0);
        assert_eq!(p.markers[0].name, "Pick up here");
    }

    #[test]
    fn edl_reads_its_own_export() {
        use crate::timeline::{to_edl, Project};
        let json = serde_json::json!({
            "fps": 25,
            "tracks": [{"id": "v", "kind": "video", "clips": [
                {"id": "a", "source": {"type": "media", "path": "/m/one.mov"},
                 "start": 0.0, "in_point": 1.0, "out_point": 3.0},
                {"id": "b", "source": {"type": "media", "path": "/m/two.mov"},
                 "start": 5.0, "in_point": 0.0, "out_point": 2.0}
            ]}]
        });
        let project: Project = serde_json::from_value(json).unwrap();
        let p = parse_edl(&to_edl(&project, "Round"), 25.0);
        let got: Vec<(String, f64, f64, f64)> = p
            .clips
            .iter()
            .map(|c| (c.name.clone(), c.start, c.in_point, c.out_point))
            .collect();
        assert_eq!(
            got,
            vec![
                ("one.mov".into(), 0.0, 1.0, 3.0),
                ("two.mov".into(), 5.0, 0.0, 2.0)
            ]
        );
    }

    #[test]
    fn otio_round_trips_an_odyssey_export() {
        use crate::timeline::{to_otio, Project};
        let json = serde_json::json!({
            "fps": 25,
            "markers": [{"id": "m", "time": 1.6, "name": "Here", "colour": "#D14343"}],
            "tracks": [
                {"id": "v", "name": "Pictures", "kind": "video", "clips": [
                    {"id": "a", "source": {"type": "media", "path": "/m/one two.mov"},
                     "start": 2.0, "in_point": 1.0, "out_point": 3.0,
                     "effects": [{"kind": "hue", "degrees": 30}]}
                ]},
                {"id": "a", "kind": "audio", "clips": [
                    {"id": "s", "source": {"type": "media", "path": "/m/song.wav"},
                     "start": 0.0, "in_point": 0.0, "out_point": 4.0}
                ]}
            ]
        });
        let project: Project = serde_json::from_value(json).unwrap();
        let p = parse_otio(&to_otio(&project, "Round")).unwrap();
        assert_eq!(p.title, "Round");
        assert_eq!(p.video_tracks, vec!["Pictures"]);
        assert_eq!(p.audio_tracks.len(), 1);
        let a = p.clips.iter().find(|c| c.lane == Lane::Video).unwrap();
        assert_eq!((a.start, a.in_point, a.out_point), (2.0, 1.0, 3.0));
        assert_eq!(a.hint.as_deref(), Some("/m/one two.mov"));
        let full = a
            .odyssey
            .as_ref()
            .expect("the full clip travels in metadata");
        assert_eq!(full["effects"][0]["kind"], "hue");
        assert_eq!(p.markers.len(), 1);
        assert_eq!(p.markers[0].time, 1.6);
        assert_eq!(p.markers[0].colour, "#D14343");
    }

    #[test]
    fn otio_from_another_editor() {
        // The shape Resolve and the OTIO adapters write: file URLs, an
        // available range starting at the camera's timecode, a transition
        // between items, and a time warp.
        let doc = serde_json::json!({
            "OTIO_SCHEMA": "Timeline.1",
            "name": "Other",
            "tracks": {"OTIO_SCHEMA": "Stack.1", "children": [
                {"OTIO_SCHEMA": "Track.1", "kind": "Video", "children": [
                    {"OTIO_SCHEMA": "Clip.2", "name": "A",
                     "source_range": {"start_time": {"rate": 24, "value": 86424},
                                      "duration": {"rate": 24, "value": 48}},
                     "media_references": {"DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": "file:///media/My%20Shot.mov",
                        "available_range": {"start_time": {"rate": 24, "value": 86400},
                                            "duration": {"rate": 24, "value": 2400}}}},
                     "active_media_reference_key": "DEFAULT_MEDIA"},
                    {"OTIO_SCHEMA": "Transition.1", "transition_type": "SMPTE_Dissolve",
                     "in_offset": {"rate": 24, "value": 6}, "out_offset": {"rate": 24, "value": 6}},
                    {"OTIO_SCHEMA": "Clip.1", "name": "B",
                     "source_range": {"start_time": {"rate": 24, "value": 0},
                                      "duration": {"rate": 24, "value": 48}},
                     "effects": [{"OTIO_SCHEMA": "LinearTimeWarp.1", "time_scalar": 2.0}],
                     "media_reference": {"OTIO_SCHEMA": "ExternalReference.1",
                                         "target_url": "/media/b.mov"}}
                ]}
            ]}
        });
        let p = parse_otio(&doc.to_string()).unwrap();
        let a = &p.clips[0];
        assert_eq!(a.hint.as_deref(), Some("/media/My Shot.mov"));
        assert_eq!(
            (a.in_point, a.out_point),
            (1.0, 3.0),
            "counted from the file's start"
        );
        let b = &p.clips[1];
        assert_eq!(b.transition, Some(("dissolve".into(), 0.5)));
        assert_eq!(b.start, 2.0);
        assert_eq!(b.speed, 2.0);
        // A warp keeps the clip's length on the track and consumes twice the
        // source.
        assert_eq!(b.out_point - b.in_point, 4.0);
    }

    #[test]
    fn resolve_finds_files_and_subtracts_timecode() {
        let mut p = parse_edl(
            "001  AX V C 10:00:01:00 10:00:03:00 01:00:00:00 01:00:02:00\n* FROM CLIP NAME: Cam.MOV\n\
             002  AX V C 00:00:00:00 00:00:01:00 01:00:02:00 01:00:03:00\n* FROM CLIP NAME: gone.mov\n",
            25.0,
        );
        p = resolve(p, &["/proj/cam.mov".into()], None, 25.0, |_, _| {
            Some(36000.0)
        });
        let cam = &p.clips[0];
        assert_eq!(
            cam.path.as_deref(),
            Some("/proj/cam.mov"),
            "names match without case"
        );
        assert_eq!((cam.in_point, cam.out_point), (1.0, 3.0));
        assert_eq!(p.missing, vec!["gone.mov".to_string()]);
        assert!(p.clips[1].path.is_none());
        assert_eq!(p.clips[1].wanted, "gone.mov");
    }

    #[test]
    fn file_urls_decode() {
        assert_eq!(url_to_path("file:///a%20b/c.mov"), "/a b/c.mov");
        assert_eq!(url_to_path("file://localhost/x.mov"), "/x.mov");
        assert_eq!(url_to_path("file:///C:/v/x.mov"), "C:/v/x.mov");
        assert_eq!(url_to_path("/plain.mov"), "/plain.mov");
    }
}
