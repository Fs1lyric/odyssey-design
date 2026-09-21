//! Stress suite: real renders at 4K and 8K, checked from the outside.
//!
//! 84 cases, each at 3840x2160 or 7680x4320: every major effect on its own,
//! and the scenarios that load the renderer hardest (layered blends, long
//! cut lists with transitions, nested sequences, multicam cuts, a ten-effect
//! stack, speed ramps, exact monitor frames, loudness measurement, tracking
//! and audio sync on full-resolution sources, preview spans). Every output is
//! probed for its size, its length and a picture that is not black, and the
//! peak memory of the ffmpeg processes it spawned is recorded, because at 8K
//! memory is what runs out first.
//!
//! The browser half, 16 cases of the preview's GPU pipeline at the same two
//! sizes, lives in scripts/stress-browser. Together they are the 100.
//!
//! Ignored by default. Run all of it, or one shard of it, with
//!
//!   STRESS_SHARD=0 STRESS_SHARDS=10 cargo test --release stress_suite -- --ignored --nocapture
//!
//! A JSON line per case is appended to target/test-scratch/stress/report.jsonl.

use crate::timeline::{self, Project};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Copy, Debug)]
struct Res {
    label: &'static str,
    w: u32,
    h: u32,
}

const RES: [Res; 2] = [
    Res {
        label: "4K",
        w: 3840,
        h: 2160,
    },
    Res {
        label: "8K",
        w: 7680,
        h: 4320,
    },
];

fn dir() -> PathBuf {
    let d = timeline::tests::scratch("stress");
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn ffmpeg(args: &[&str]) {
    let out = Command::new("ffmpeg")
        .args(["-y", "-v", "error"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "fixture failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A 2 s test pattern with tone at the given size, made once per size.
fn source(r: Res) -> PathBuf {
    let p = dir().join(format!("src-{}.mp4", r.label));
    if !p.is_file() {
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={}x{}:rate=25:duration=2", r.w, r.h),
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            p.to_str().unwrap(),
        ]);
    }
    p
}

/// A textured patch gliding across the frame at full resolution.
fn moving(r: Res) -> PathBuf {
    let p = dir().join(format!("moving-{}.mp4", r.label));
    if !p.is_file() {
        let s = r.w / 320; // patch and speed scale with the frame
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={}x{}:rate=25", 48 * s, 48 * s),
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=0x404040:size={}x{}:rate=25", r.w, r.h),
            "-filter_complex",
            &format!(
                "[1][0]overlay=x='{}+t*{}':y='{}+t*{}':shortest=1",
                40 * s,
                60 * s,
                50 * s,
                20 * s
            ),
            "-t",
            "2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            p.to_str().unwrap(),
        ]);
    }
    p
}

/// One camera of a two-camera take, starting `late` seconds after the other.
fn take(r: Res, name: &str, late: f64) -> PathBuf {
    let p = dir().join(format!("take-{name}-{}.mp4", r.label));
    if !p.is_file() {
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "anoisesrc=color=pink:seed=7:duration=6:amplitude=0.5",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={}x{}:rate=25:duration=4", r.w, r.h),
            "-filter_complex",
            &format!("[0]atrim=start={late},asetpts=PTS-STARTPTS[a]"),
            "-map",
            "1:v",
            "-map",
            "[a]",
            "-shortest",
            "-t",
            "4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            p.to_str().unwrap(),
        ]);
    }
    p
}

// ---- project building, in the JSON shape the editor sends ----

fn clip(path: &Path, start: f64, a: f64, b: f64) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "source": { "type": "media", "path": path.to_string_lossy() },
        "start": start, "in_point": a, "out_point": b,
    })
}

fn track(clips: Vec<Value>) -> Value {
    json!({ "id": uuid::Uuid::new_v4().to_string(), "kind": "video", "clips": clips })
}

fn project(r: Res, tracks: Vec<Value>) -> Project {
    serde_json::from_value(json!({ "width": r.w, "height": r.h, "fps": 25, "tracks": tracks }))
        .expect("stress project must deserialise")
}

fn profile() -> timeline::RenderProfile {
    let mut p = timeline::render_profiles().into_iter().next().unwrap();
    // Speed over quality: the suite tests the graph, not the encoder.
    p.preset = "ultrafast".into();
    p.crf = Some(30);
    p
}

// ---- checks ----

struct Probe {
    w: u32,
    h: u32,
    duration: f64,
}

fn probe(path: &Path) -> Result<Probe, String> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let s = &v["streams"][0];
    Ok(Probe {
        w: s["width"].as_u64().unwrap_or(0) as u32,
        h: s["height"].as_u64().unwrap_or(0) as u32,
        duration: v["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0),
    })
}

/// Mean luma of one frame at `at`, 0..255, from a 64x36 thumbnail.
fn mean_luma(path: &Path, at: f64) -> Result<f64, String> {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", &format!("{at:.3}"), "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=64:36,format=gray",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.stdout.is_empty() {
        return Err("no frame decoded".into());
    }
    Ok(out.stdout.iter().map(|&b| b as f64).sum::<f64>() / out.stdout.len() as f64)
}

/// Render and verify size, length and that the picture is not black.
fn render_check(p: &Project, r: Res, name: &str, want_secs: f64) -> Result<String, String> {
    let out = dir().join(format!("out-{name}-{}.mp4", r.label));
    timeline::render(p, &profile(), &out).map_err(|e| e.to_string())?;
    let pr = probe(&out)?;
    if (pr.w, pr.h) != (r.w, r.h) {
        return Err(format!("output is {}x{}", pr.w, pr.h));
    }
    if (pr.duration - want_secs).abs() > 0.25 {
        return Err(format!(
            "output lasts {:.2}s, want {want_secs:.2}s",
            pr.duration
        ));
    }
    let luma = mean_luma(&out, want_secs / 2.0)?;
    let _ = std::fs::remove_file(&out);
    if luma < 2.0 {
        return Err(format!("picture is black (mean luma {luma:.1})"));
    }
    Ok(format!(
        "{}x{} {:.2}s luma {luma:.0}",
        pr.w, pr.h, pr.duration
    ))
}

// ---- memory watcher ----

/// Peak resident memory of any ffmpeg this process spawns, in MiB, polled
/// from /proc while a case runs. Linux only; elsewhere it reads zero.
struct Watcher {
    stop: Arc<AtomicBool>,
    peak_kb: Arc<AtomicU64>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Watcher {
    fn start() -> Watcher {
        let stop = Arc::new(AtomicBool::new(false));
        let peak_kb = Arc::new(AtomicU64::new(0));
        let (s, p) = (stop.clone(), peak_kb.clone());
        let me = std::process::id().to_string();
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                if let Ok(entries) = std::fs::read_dir("/proc") {
                    for e in entries.flatten() {
                        let Ok(status) = std::fs::read_to_string(e.path().join("status")) else {
                            continue;
                        };
                        let field = |k: &str| {
                            status
                                .lines()
                                .find(|l| l.starts_with(k))
                                .map(|l| l[k.len()..].trim().to_string())
                        };
                        if field("PPid:").as_deref() != Some(me.as_str()) {
                            continue;
                        }
                        if let Some(kb) = field("VmHWM:").and_then(|v| {
                            v.split_whitespace()
                                .next()
                                .and_then(|n| n.parse::<u64>().ok())
                        }) {
                            p.fetch_max(kb, Ordering::Relaxed);
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        Watcher {
            stop,
            peak_kb,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> u64 {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        self.peak_kb.load(Ordering::Relaxed) / 1024
    }
}

// ---- the cases ----

type Case = (String, Res, Box<dyn Fn(Res) -> Result<String, String>>);

/// The effects rendered one at a time, at each size. Sizes in pixels are
/// given for 4K and scaled for 8K.
fn effect_json(name: &str, r: Res) -> Value {
    let k = r.w as f64 / 3840.0;
    match name {
        "color" => {
            json!({"kind": "color", "brightness": 0.1, "contrast": 1.2, "saturation": 1.4, "gamma": 1.1})
        }
        "hue" => json!({"kind": "hue", "degrees": 90}),
        "blur" => json!({"kind": "blur", "sigma": 12.0 * k}),
        "boxblur" => json!({"kind": "boxblur", "radius": 8.0 * k}),
        "sharpen" => json!({"kind": "sharpen", "amount": 1.2}),
        "vignette" => json!({"kind": "vignette", "angle": 0.8}),
        "chromakey" => {
            json!({"kind": "chromakey", "color": "0x00ff00", "similarity": 0.25, "blend": 0.1})
        }
        "colorkey" => json!({"kind": "colorkey", "color": "red", "similarity": 0.3, "blend": 0.1}),
        "lumakey" => json!({"kind": "lumakey", "threshold": 0.0, "tolerance": 0.1}),
        "despill" => json!({"kind": "despill", "colour": "green", "amount": 0.5}),
        "crop" => {
            json!({"kind": "crop", "x": 400.0 * k, "y": 200.0 * k, "width": 2400.0 * k, "height": 1400.0 * k})
        }
        "rotate" => json!({"kind": "rotate", "degrees": 20}),
        "mask" => {
            json!({"kind": "mask", "shape": "ellipse", "x": 50, "y": 50, "width": 60, "height": 60, "feather": 60.0 * k, "invert": false})
        }
        "tint" => json!({"kind": "tint", "black": "navy", "white": "yellow", "amount": 0.8}),
        "exposure" => json!({"kind": "exposure", "stops": 0.5}),
        "invert" => json!({"kind": "invert"}),
        "sepia" => json!({"kind": "sepia"}),
        "temperature" => json!({"kind": "temperature", "kelvin": 3500}),
        "levels" => json!({"kind": "levels", "black": 0.1, "white": 0.9}),
        "posterize" => json!({"kind": "posterize", "levels": 4}),
        "vibrance" => json!({"kind": "vibrance", "intensity": 0.8}),
        "colorbalance" => json!({"kind": "colorbalance", "r": 0.3, "g": 0.0, "b": -0.3}),
        "curves" => {
            json!({"kind": "curves", "master": [[0, 0], [0.5, 0.7], [1, 1]], "red": [], "green": [], "blue": []})
        }
        "flip" => json!({"kind": "flip", "horizontal": true, "vertical": true}),
        "pixelate" => json!({"kind": "pixelate", "size": 32.0 * k}),
        "mirror" => json!({"kind": "mirror"}),
        "lenscorrect" => json!({"kind": "lenscorrect", "k1": -0.2, "k2": 0.05}),
        "scanlines" => json!({"kind": "scanlines", "amount": 0.4}),
        "transform" => json!({"kind": "transform", "scale": 0.7, "x": 100.0 * k, "y": 50.0 * k}),
        other => panic!("no stress effect {other}"),
    }
}

const EFFECTS: [&str; 29] = [
    "color",
    "hue",
    "blur",
    "boxblur",
    "sharpen",
    "vignette",
    "chromakey",
    "colorkey",
    "lumakey",
    "despill",
    "crop",
    "rotate",
    "mask",
    "tint",
    "exposure",
    "invert",
    "sepia",
    "temperature",
    "levels",
    "posterize",
    "vibrance",
    "colorbalance",
    "curves",
    "flip",
    "pixelate",
    "mirror",
    "lenscorrect",
    "scanlines",
    "transform",
];

fn with_effects(r: Res, effects: Vec<Value>) -> Project {
    let mut c = clip(&source(r), 0.0, 0.0, 1.0);
    c["effects"] = Value::Array(effects);
    project(r, vec![track(vec![c])])
}

type Scenario = (&'static str, fn(Res) -> Result<String, String>);

fn scenarios() -> Vec<Scenario> {
    vec![
        ("plain", |r| {
            render_check(
                &project(r, vec![track(vec![clip(&source(r), 0.0, 0.0, 2.0)])]),
                r,
                "plain",
                2.0,
            )
        }),
        ("layers-and-blends", |r| {
            // Four layers of the same source, scaled into quadrants, each
            // blended differently over the one beneath.
            let s = source(r);
            let (qx, qy) = (r.w as f64 / 4.0, r.h as f64 / 4.0);
            let blends = ["normal", "multiply", "screen", "difference"];
            let tracks = (0..4).map(|i| {
                let mut c = clip(&s, 0.0, 0.0, 1.5);
                c["motion"] = json!({"x": if i % 2 == 0 { -qx } else { qx }, "y": if i < 2 { -qy } else { qy }, "scale": 60, "rotation": i * 5, "opacity": 0.9});
                c["blend"] = json!(blends[i as usize]);
                track(vec![c])
            }).collect();
            render_check(&project(r, tracks), r, "layers", 1.5)
        }),
        ("cut-list-with-dissolves", |r| {
            // Twelve quarter-second cuts, each dissolving from the last.
            let s = source(r);
            let clips = (0..12)
                .map(|i| {
                    let mut c = clip(
                        &s,
                        i as f64 * 0.25,
                        0.3 + (i % 5) as f64 * 0.1,
                        0.55 + (i % 5) as f64 * 0.1,
                    );
                    if i > 0 {
                        c["transition_in"] = json!({"kind": "dissolve", "duration": 0.1});
                    }
                    c
                })
                .collect();
            render_check(&project(r, vec![track(clips)]), r, "cuts", 3.0)
        }),
        ("nested-sequence", |r| {
            let s = source(r);
            let inner = project(
                r,
                vec![track(vec![
                    clip(&s, 0.0, 0.0, 0.8),
                    clip(&s, 0.8, 1.0, 1.8),
                ])],
            );
            let outer = json!({
                "id": "nest", "start": 0.0, "in_point": 0.0, "out_point": 1.6,
                "source": {"type": "nested", "name": "Inner", "project": serde_json::to_value(&inner).unwrap()},
            });
            let p = project(r, vec![track(vec![outer])]);
            let flat = timeline::flatten_nested(&p, &dir()).map_err(|e| e.to_string())?;
            render_check(&flat, r, "nested", 1.6)
        }),
        ("multicam-cuts", |r| {
            // A multicam cut list as the renderer receives it: media clips
            // alternating between two cameras at their synced offsets.
            let (a, b) = (take(r, "a", 0.0), take(r, "b", 0.9));
            let clips = (0..6)
                .map(|i| {
                    let t = i as f64 * 0.5;
                    if i % 2 == 0 {
                        clip(&a, t, 1.0 + t, 1.5 + t)
                    } else {
                        clip(&b, t, 0.1 + t, 0.6 + t)
                    }
                })
                .collect();
            render_check(&project(r, vec![track(clips)]), r, "multicam", 3.0)
        }),
        ("ten-effect-stack", |r| {
            let names = [
                "color",
                "hue",
                "blur",
                "vignette",
                "sharpen",
                "curves",
                "mask",
                "tint",
                "lenscorrect",
                "chromakey",
            ];
            render_check(
                &with_effects(r, names.iter().map(|n| effect_json(n, r)).collect()),
                r,
                "stack",
                1.0,
            )
        }),
        ("speed-ramp", |r| {
            let mut c = clip(&source(r), 0.0, 0.0, 2.0);
            c["speed"] =
                json!({"keyframes": [{"time": 0.0, "value": 0.5}, {"time": 1.0, "value": 2.0}]});
            let p = project(r, vec![track(vec![c])]);
            let want = p.duration();
            render_check(&p, r, "ramp", want)
        }),
        ("exact-monitor-frame", |r| {
            let p = with_effects(
                r,
                vec![effect_json("rotate", r), effect_json("vignette", r)],
            );
            let path = timeline::preview_frame(&p, 0.5, &dir()).map_err(|e| e.to_string())?;
            let pr = probe(Path::new(&path))?;
            if (pr.w, pr.h) != (r.w, r.h) {
                return Err(format!("frame is {}x{}", pr.w, pr.h));
            }
            // Cached: the second request must not render again.
            let t = Instant::now();
            timeline::preview_frame(&p, 0.5, &dir()).map_err(|e| e.to_string())?;
            if t.elapsed().as_secs_f64() > 0.5 {
                return Err("the cached frame was rendered again".into());
            }
            let _ = std::fs::remove_file(&path);
            Ok(format!("{}x{}", pr.w, pr.h))
        }),
        ("loudness", |r| {
            let p = project(r, vec![track(vec![clip(&source(r), 0.0, 0.0, 2.0)])]);
            let l = timeline::measure_loudness(&p, &dir()).map_err(|e| e.to_string())?;
            if !l.integrated.is_finite() || !l.true_peak.is_finite() {
                return Err(format!("{l:?}"));
            }
            Ok(format!(
                "I {:.1} LUFS, TP {:.1} dBTP",
                l.integrated, l.true_peak
            ))
        }),
        ("tracking", |r| {
            let s = r.w as f64 / 320.0;
            let region = crate::track::Region {
                x: 64.0 * s / r.w as f64,
                y: 74.0 * s / r.h as f64,
                w: 40.0 * s / r.w as f64,
                h: 40.0 * s / r.h as f64,
            };
            let t = crate::track::track(moving(r).to_str().unwrap(), 0.0, 1.5, 10.0, region)
                .map_err(|e| e.to_string())?;
            if t.lost {
                return Err("lost the subject".into());
            }
            let worst = t
                .points
                .iter()
                .map(|p| {
                    let want = ((64.0 + p.t * 60.0) * s, (74.0 + p.t * 20.0) * s);
                    (p.x * r.w as f64 - want.0).hypot(p.y * r.h as f64 - want.1)
                })
                .fold(0.0, f64::max);
            // Two analysis pixels, in full-resolution pixels.
            let limit = 2.0 * r.w as f64 / 480.0;
            if worst > limit {
                return Err(format!("drifted {worst:.1}px (limit {limit:.1})"));
            }
            Ok(format!("{} points, worst {worst:.1}px", t.points.len()))
        }),
        ("audio-sync", |r| {
            let (a, b) = (take(r, "a", 0.0), take(r, "b", 0.9));
            let s = crate::sync::sync(a.to_str().unwrap(), &[b.to_string_lossy().to_string()])
                .map_err(|e| e.to_string())?;
            if (s[0].offset + 0.9).abs() > 0.01 {
                return Err(format!("{:?}", s[0]));
            }
            Ok(format!(
                "offset {:.4}s, confidence {:.0}",
                s[0].offset, s[0].confidence
            ))
        }),
        ("preview-span", |r| {
            let p = with_effects(r, vec![effect_json("blur", r)]);
            let c =
                timeline::render_preview(&p, 0.0, 1.0, 0.5, &dir()).map_err(|e| e.to_string())?;
            let pr = probe(Path::new(&c.path))?;
            let _ = std::fs::remove_file(&c.path);
            if pr.w != r.w / 2 {
                return Err(format!("span is {}x{}", pr.w, pr.h));
            }
            Ok(format!("{}x{}", pr.w, pr.h))
        }),
        ("transitions-reel", |r| {
            let s = source(r);
            let kinds = [
                "wipeleft",
                "irisopen",
                "slideright",
                "clockwipe",
                "pixeldissolve",
                "crosszoom",
                "spiral",
            ];
            let mut clips = vec![clip(&s, 0.0, 0.3, 0.7)];
            for (i, k) in kinds.iter().enumerate() {
                let mut c = clip(&s, 0.4 * (i + 1) as f64, 0.3, 0.7);
                c["transition_in"] = json!({"kind": k, "duration": 0.2});
                clips.push(c);
            }
            render_check(&project(r, vec![track(clips)]), r, "reel", 3.2)
        }),
    ]
}

fn cases() -> Vec<Case> {
    let mut out: Vec<Case> = Vec::new();
    for r in RES {
        for name in EFFECTS {
            out.push((
                format!("effect-{name}"),
                r,
                Box::new(move |r| {
                    render_check(&with_effects(r, vec![effect_json(name, r)]), r, name, 1.0)
                }),
            ));
        }
        for (name, f) in scenarios() {
            out.push((name.to_string(), r, Box::new(f)));
        }
    }
    out
}

#[test]
#[ignore]
fn stress_suite() {
    let all = cases();
    assert_eq!(all.len(), 84, "the Rust half of the 100");
    let shards: usize = std::env::var("STRESS_SHARDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1)
        .max(1);
    let shard: usize = std::env::var("STRESS_SHARD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let only = std::env::var("STRESS_ONLY").unwrap_or_default();
    let report = dir().join("report.jsonl");
    let mut failed = Vec::new();

    for (i, (name, r, run)) in all.iter().enumerate() {
        if i % shards != shard || (!only.is_empty() && !name.contains(&only)) {
            continue;
        }
        let watch = Watcher::start();
        let t = Instant::now();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(*r)))
            .unwrap_or_else(|p| {
                Err(p
                    .downcast_ref::<String>()
                    .cloned()
                    .unwrap_or_else(|| "panicked".into()))
            });
        let secs = t.elapsed().as_secs_f64();
        let mib = watch.finish();
        let (ok, detail) = match &outcome {
            Ok(d) => (true, d.clone()),
            Err(e) => (false, e.clone()),
        };
        println!(
            "{} #{i:02} {:<3} {name:<28} {secs:>7.1}s {mib:>6} MiB  {detail}",
            if ok { "PASS" } else { "FAIL" },
            r.label
        );
        let line = json!({"id": i, "name": name, "res": r.label, "ok": ok, "secs": secs, "peak_mib": mib, "detail": detail});
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&report)
            .unwrap();
        writeln!(f, "{line}").unwrap();
        if !ok {
            failed.push(format!("{} {name}: {detail}", r.label));
        }
    }
    assert!(
        failed.is_empty(),
        "{} stress case(s) failed:\n{}",
        failed.len(),
        failed.join("\n")
    );
}
