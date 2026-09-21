//! Point tracking: follow a region of a source through time.
//!
//! The region is matched frame to frame by normalised cross-correlation on a
//! greyscale copy of the source decoded by ffmpeg at a modest width. NCC is
//! indifferent to uniform changes in brightness and contrast, which is what
//! a subject walking from shade into sun looks like. The search runs coarse
//! to fine around the last position, the peak is refined to a fraction of a
//! pixel with a parabola through its neighbours, and the template drifts
//! slowly toward what it sees so a turning subject stays matched without the
//! track sliding off it. When the best match falls below a confidence floor
//! the track stops there rather than inventing positions.
//!
//! Positions come back normalised to the source picture (0..1 on each axis),
//! so the caller maps them onto whatever it is animating: a mask's
//! percentages, a text overlay's pixels, a clip's position.

use crate::timeline::Error;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};

type Result<T> = std::result::Result<T, Error>;

/// The region to follow, normalised to the source picture: centre and size.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One tracked sample.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct TrackPoint {
    /// Source time, seconds.
    pub t: f64,
    /// Region centre, normalised to the source picture.
    pub x: f64,
    pub y: f64,
    /// Normalised correlation of the match, 0..1.
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackResult {
    pub points: Vec<TrackPoint>,
    /// True when the track ended early because the subject was lost.
    pub lost: bool,
}

/// Width the source is analysed at. Tracking precision comes from the
/// sub-pixel refinement, not raw resolution, and a narrow frame keeps the
/// search fast enough to run while the user waits.
const ANALYSIS_WIDTH: u32 = 480;
/// Below this correlation the match is not trusted.
const LOST_BELOW: f64 = 0.45;

struct Gray {
    w: usize,
    h: usize,
    px: Vec<f32>,
}

impl Gray {
    fn at(&self, x: isize, y: isize) -> f32 {
        let x = x.clamp(0, self.w as isize - 1) as usize;
        let y = y.clamp(0, self.h as isize - 1) as usize;
        self.px[y * self.w + x]
    }
}

/// Follow `region` from source time `start` to `end`, sampling `rate` times a
/// second (clamped to 2..60).
pub fn track(source: &str, start: f64, end: f64, rate: f64, region: Region) -> Result<TrackResult> {
    let info = crate::video::probe(source).map_err(|e| Error::Invalid(e.to_string()))?;
    if info.width == 0 || info.height == 0 {
        return Err(Error::Invalid("the source has no picture".into()));
    }
    if end.is_nan() || start.is_nan() || end <= start {
        return Err(Error::Invalid("the span to track is empty".into()));
    }
    let rate = rate.clamp(2.0, 60.0);
    let aw = ANALYSIS_WIDTH.min(info.width as u32).max(16) as usize;
    let ah = ((info.height as f64 * aw as f64 / info.width as f64).round() as usize).max(16);

    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-ss",
            &format!("{start:.4}"),
            "-i",
            &info.path,
        ])
        .args([
            "-t",
            &format!("{:.4}", end - start),
            "-vf",
            &format!("fps={rate:.4},scale={aw}:{ah}:flags=area,format=gray"),
            "-f",
            "rawvideo",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NoFfmpeg
            } else {
                Error::Io(e)
            }
        })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Invalid("ffmpeg gave no output".into()))?;

    // Template size in analysis pixels, at least big enough to carry texture.
    let tw = ((region.w * aw as f64).round() as usize).clamp(8, aw / 2) | 1;
    let th = ((region.h * ah as f64).round() as usize).clamp(8, ah / 2) | 1;
    // Search as far as the subject could plausibly move in one sample.
    let radius = (tw.max(th) as isize).clamp(12, 64);

    let mut cx = region.x * aw as f64;
    let mut cy = region.y * ah as f64;
    let mut template: Option<Vec<f32>> = None;
    let mut points = Vec::new();
    let mut lost = false;
    let mut buf = vec![0u8; aw * ah];
    let mut index = 0usize;

    while stdout.read_exact(&mut buf).is_ok() {
        let frame = Gray {
            w: aw,
            h: ah,
            px: buf.iter().map(|&v| v as f32).collect(),
        };
        let t = start + index as f64 / rate;
        index += 1;

        let Some(tpl) = &mut template else {
            template = Some(patch(&frame, cx, cy, tw, th));
            points.push(TrackPoint {
                t,
                x: cx / aw as f64,
                y: cy / ah as f64,
                confidence: 1.0,
            });
            continue;
        };

        let (best, score) = search(&frame, tpl, tw, th, cx, cy, radius);
        if score < LOST_BELOW {
            lost = true;
            break;
        }
        cx = best.0.clamp(0.0, aw as f64 - 1.0);
        cy = best.1.clamp(0.0, ah as f64 - 1.0);
        points.push(TrackPoint {
            t,
            x: cx / aw as f64,
            y: cy / ah as f64,
            confidence: score,
        });
        // Let a confident match refresh the template a little.
        if score > 0.8 {
            let now = patch(&frame, cx, cy, tw, th);
            for (a, b) in tpl.iter_mut().zip(now) {
                *a = *a * 0.88 + b * 0.12;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if points.is_empty() {
        return Err(Error::Invalid(
            "no frames could be read in that span".into(),
        ));
    }
    Ok(TrackResult { points, lost })
}

/// The `tw`x`th` patch centred on (cx, cy), bilinearly sampled.
fn patch(f: &Gray, cx: f64, cy: f64, tw: usize, th: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(tw * th);
    let x0 = cx - (tw as f64 - 1.0) / 2.0;
    let y0 = cy - (th as f64 - 1.0) / 2.0;
    for j in 0..th {
        for i in 0..tw {
            let (x, y) = (x0 + i as f64, y0 + j as f64);
            let (xi, yi) = (x.floor(), y.floor());
            let (fx, fy) = ((x - xi) as f32, (y - yi) as f32);
            let (xi, yi) = (xi as isize, yi as isize);
            let top = f.at(xi, yi) * (1.0 - fx) + f.at(xi + 1, yi) * fx;
            let bot = f.at(xi, yi + 1) * (1.0 - fx) + f.at(xi + 1, yi + 1) * fx;
            out.push(top * (1.0 - fy) + bot * fy);
        }
    }
    out
}

/// A template and the statistics every correlation against it needs.
struct Template<'a> {
    px: &'a [f32],
    w: usize,
    h: usize,
    mean: f32,
    norm: f32,
}

/// Normalised cross-correlation of the template against the frame with the
/// template centred on integer pixel (cx, cy).
fn ncc(f: &Gray, t: &Template, cx: isize, cy: isize) -> f64 {
    let (tpl, tmean, tnorm, tw, th) = (t.px, t.mean, t.norm, t.w, t.h);
    let x0 = cx - (tw as isize - 1) / 2;
    let y0 = cy - (th as isize - 1) / 2;
    let n = (tw * th) as f32;
    let mut sum = 0.0f32;
    let mut sum2 = 0.0f32;
    let mut cross = 0.0f32;
    for j in 0..th {
        for i in 0..tw {
            let v = f.at(x0 + i as isize, y0 + j as isize);
            sum += v;
            sum2 += v * v;
            cross += v * (tpl[j * tw + i] - tmean);
        }
    }
    let var = (sum2 - sum * sum / n).max(0.0);
    if var < 1e-3 || tnorm < 1e-3 {
        return 0.0;
    }
    (cross / (var.sqrt() * tnorm)) as f64
}

/// Best match near (cx, cy): a stride-2 sweep of the whole window, a stride-1
/// polish around its winner, then a parabola through the peak's neighbours.
fn search(
    f: &Gray,
    tpl: &[f32],
    tw: usize,
    th: usize,
    cx: f64,
    cy: f64,
    r: isize,
) -> ((f64, f64), f64) {
    let n = tpl.len() as f32;
    let tmean = tpl.iter().sum::<f32>() / n;
    let tnorm = tpl
        .iter()
        .map(|v| (v - tmean) * (v - tmean))
        .sum::<f32>()
        .sqrt();
    let (ox, oy) = (cx.round() as isize, cy.round() as isize);
    let t = Template {
        px: tpl,
        w: tw,
        h: th,
        mean: tmean,
        norm: tnorm,
    };
    let score = |x: isize, y: isize| ncc(f, &t, x, y);

    let mut best = (ox, oy, f64::NEG_INFINITY);
    let mut y = -r;
    while y <= r {
        let mut x = -r;
        while x <= r {
            let s = score(ox + x, oy + y);
            if s > best.2 {
                best = (ox + x, oy + y, s);
            }
            x += 2;
        }
        y += 2;
    }
    let (bx, by) = (best.0, best.1);
    for dy in -1..=1 {
        for dx in -1..=1 {
            let s = score(bx + dx, by + dy);
            if s > best.2 {
                best = (bx + dx, by + dy, s);
            }
        }
    }
    let (bx, by, peak) = best;
    let refine = |lo: f64, mid: f64, hi: f64| {
        let d = lo - 2.0 * mid + hi;
        if d.abs() < 1e-9 {
            0.0
        } else {
            (0.5 * (lo - hi) / d).clamp(-0.5, 0.5)
        }
    };
    let sx = refine(score(bx - 1, by), peak, score(bx + 1, by));
    let sy = refine(score(bx, by - 1), peak, score(bx, by + 1));
    ((bx as f64 + sx, by as f64 + sy), peak)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured patch gliding across a flat background at a known speed.
    fn moving_patch() -> std::path::PathBuf {
        let p = crate::timeline::tests::scratch("odyssey-track-moving.mp4");
        if p.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return p;
        }
        let ok = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=48x48:rate=25",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x404040:size=320x180:rate=25",
                "-filter_complex",
                "[1][0]overlay=x='40+t*60':y='50+t*20':shortest=1",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&p)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        p
    }

    #[test]
    fn follows_a_moving_subject() {
        let src = moving_patch();
        // The patch's centre starts at (64, 74) in a 320x180 frame.
        let region = Region {
            x: 64.0 / 320.0,
            y: 74.0 / 180.0,
            w: 40.0 / 320.0,
            h: 40.0 / 180.0,
        };
        let r = track(src.to_str().unwrap(), 0.0, 1.5, 10.0, region).unwrap();
        assert!(!r.lost, "lost the subject: {:?}", r.points.last());
        assert!(r.points.len() >= 14, "{} points", r.points.len());
        for p in &r.points {
            let want = ((64.0 + p.t * 60.0) / 320.0, (74.0 + p.t * 20.0) / 180.0);
            let err = ((p.x - want.0) * 320.0).hypot((p.y - want.1) * 180.0);
            assert!(err < 2.0, "at {:.2}s off by {err:.2}px: {p:?}", p.t);
        }
    }

    #[test]
    fn stops_when_the_subject_is_gone() {
        let src = moving_patch();
        // A patch of flat background has nothing to match.
        let region = Region {
            x: 0.9,
            y: 0.1,
            w: 0.1,
            h: 0.15,
        };
        let r = track(src.to_str().unwrap(), 0.0, 1.0, 10.0, region).unwrap();
        assert!(r.lost, "followed featureless ground: {:?}", r.points);
        assert_eq!(r.points.len(), 1, "only the starting point is real");
    }
}
