//! Odyssey Video — media inspection.
//!
//! Probing and thumbnailing for source files. The timeline model and the
//! renderer live in `timeline.rs`; this module only answers questions about
//! files on disk.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("clip source not found: {0}")]
    MissingSource(String),
    #[error("ffmpeg is not installed or not on PATH")]
    NoFfmpeg,
    #[error("{0}")]
    Invalid(String),
    #[error("render failed: {0}")]
    Render(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// What `ffprobe` can tell us about a source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub path: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
}

fn canonical_source(path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    let canonical = p
        .canonicalize()
        .map_err(|_| Error::MissingSource(path.to_string()))?;
    if !canonical.is_file() {
        return Err(Error::MissingSource(path.to_string()));
    }
    Ok(canonical)
}

pub fn probe(path: &str) -> Result<MediaInfo> {
    let source = canonical_source(path)?;
    let out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(&source)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NoFfmpeg
            } else {
                Error::Io(e)
            }
        })?;

    if !out.status.success() {
        return Err(Error::Render(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }

    let json: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| Error::Render(e.to_string()))?;

    let duration = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video");
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

    let (width, height, fps) = match video {
        Some(v) => (
            v["width"].as_u64().unwrap_or(0) as u32,
            v["height"].as_u64().unwrap_or(0) as u32,
            parse_rational(v["r_frame_rate"].as_str().unwrap_or("0/1")),
        ),
        None => (0, 0, 0.0),
    };

    Ok(MediaInfo {
        path: source.to_string_lossy().to_string(),
        duration,
        width,
        height,
        fps,
        has_audio,
    })
}

/// ffprobe reports frame rates as "30000/1001".
fn parse_rational(s: &str) -> f64 {
    match s.split_once('/') {
        Some((n, d)) => {
            let n: f64 = n.parse().unwrap_or(0.0);
            let d: f64 = d.parse().unwrap_or(1.0);
            if d == 0.0 { 0.0 } else { n / d }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

/// A single frame as a PNG, for timeline thumbnails and the preview scrubber.
pub fn thumbnail(source: &str, at: f64, width: u32, out: &Path) -> Result<String> {
    let src = canonical_source(source)?;
    let status = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-v", "error", "-ss"])
        .arg(format!("{:.4}", at.max(0.0)))
        .arg("-i")
        .arg(&src)
        .args(["-frames:v", "1", "-vf"])
        .arg(format!("scale={width}:-1"))
        .arg(out)
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { Error::NoFfmpeg } else { Error::Io(e) }
        })?;
    if !status.success() {
        return Err(Error::Render("could not extract a frame at that position".into()));
    }
    Ok(out.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffprobe_rationals() {
        assert!((parse_rational("30000/1001") - 29.97).abs() < 0.01);
        assert_eq!(parse_rational("25/1"), 25.0);
        assert_eq!(parse_rational("0/0"), 0.0);
        assert_eq!(parse_rational("nonsense"), 0.0);
    }

    #[test]
    fn probing_a_missing_file_names_it() {
        match probe("/nonexistent/definitely-not-here.mp4") {
            Err(Error::MissingSource(p)) => assert!(p.contains("definitely-not-here")),
            other => panic!("expected MissingSource, got {other:?}"),
        }
    }
}

/// Peak envelope of a file's audio, for drawing waveforms.
///
/// Decodes to low-rate mono PCM and reduces it to `buckets` peak values in
/// 0..1. The rate is deliberately low: a waveform drawn a few hundred pixels
/// wide cannot show more detail than this, and decoding at full rate for a long
/// file is slow enough to be felt.
pub fn waveform(path: &str, buckets: usize) -> Result<Vec<f32>> {
    const RATE: u32 = 4000;
    let buckets = buckets.clamp(16, 4096);
    let source = canonical_source(path)?;

    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&source)
        .args(["-map", "a:0?", "-ac", "1", "-ar", &RATE.to_string(), "-f", "s16le", "-"])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { Error::NoFfmpeg } else { Error::Io(e) }
        })?;

    // A file with no audio stream is not an error; it simply has no waveform.
    if !out.status.success() || out.stdout.is_empty() {
        return Ok(Vec::new());
    }

    let samples: Vec<i16> = out
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let per = (samples.len() as f64 / buckets as f64).max(1.0);
    let mut peaks = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let start = (b as f64 * per) as usize;
        let end = (((b + 1) as f64 * per) as usize).min(samples.len());
        if start >= end {
            peaks.push(0.0);
            continue;
        }
        let peak = samples[start..end]
            .iter()
            .map(|s| (*s as f32 / i16::MAX as f32).abs())
            .fold(0.0f32, f32::max);
        peaks.push(peak.min(1.0));
    }
    Ok(peaks)
}

#[cfg(test)]
mod waveform_tests {
    use super::*;

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok()
    }

    /// ffmpeg's `sine` source runs at roughly -18 dB, so boost it to make the
    /// loudness assertion below meaningful.
    fn make_tone(name: &str, secs: f64, freq: u32) -> PathBuf {
        let p = std::env::temp_dir().join(format!("odyssey-wave-{name}.wav"));
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   &format!("sine=frequency={freq}:duration={secs}"),
                   "-af", "volume=6"])
            .arg(&p)
            .status()
            .expect("ffmpeg should run");
        assert!(status.success());
        p
    }

    #[test]
    fn extracts_a_peak_envelope() {
        if !ffmpeg_available() { return; }
        let tone = make_tone("tone", 1.0, 440);
        let peaks = waveform(&tone.to_string_lossy(), 64).unwrap();
        assert_eq!(peaks.len(), 64);
        assert!(peaks.iter().all(|p| (0.0..=1.0).contains(p)), "peaks out of range");
        let loud = peaks.iter().filter(|p| **p > 0.5).count();
        assert!(loud > 50, "expected a loud envelope, got {loud}/64 loud buckets");
    }

    #[test]
    fn silence_reads_as_a_flat_quiet_envelope() {
        if !ffmpeg_available() { return; }
        let p = std::env::temp_dir().join("odyssey-wave-silent.wav");
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1"])
            .arg(&p).status().unwrap();
        assert!(status.success());
        let peaks = waveform(&p.to_string_lossy(), 32).unwrap();
        assert_eq!(peaks.len(), 32);
        assert!(peaks.iter().all(|v| *v < 0.01), "silence should be flat");
    }

    /// A video with no audio track must return an empty envelope, not an error.
    #[test]
    fn a_file_without_audio_has_no_waveform() {
        if !ffmpeg_available() { return; }
        let p = std::env::temp_dir().join("odyssey-wave-noaudio.mp4");
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   "testsrc=size=64x64:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&p).status().unwrap();
        assert!(status.success());
        assert!(waveform(&p.to_string_lossy(), 32).unwrap().is_empty());
    }

    #[test]
    fn bucket_count_is_clamped() {
        if !ffmpeg_available() { return; }
        let tone = make_tone("clamp", 0.5, 220);
        assert_eq!(waveform(&tone.to_string_lossy(), 1).unwrap().len(), 16);
        assert_eq!(waveform(&tone.to_string_lossy(), 99999).unwrap().len(), 4096);
    }

    #[test]
    fn missing_files_are_reported() {
        assert!(matches!(waveform("/nonexistent/nope.wav", 32), Err(Error::MissingSource(_))));
    }
}

/// A low-resolution stand-in for a source file.
///
/// Proxies exist so that editing 4K does not crawl. The contract is strict and
/// one-directional: the preview may play a proxy, the renderer never may. A
/// render that silently used a proxy would quietly ship a degraded master, so
/// `timeline::render_args` only ever sees original paths.
///
/// Proxies are VP8 in WebM rather than H.264. The preview is a webview, and on
/// Linux that decodes through GStreamer, where H.264 needs `gst-libav` that
/// many systems do not ship. VP8 and Opus are available wherever the base
/// plugins are, so a proxy plays on a machine that cannot decode the original.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proxy {
    pub source: String,
    pub path: String,
    pub width: u32,
}

/// Identify a source by path, size and mtime, so replacing a file on disk
/// invalidates its proxy without the user having to think about it.
fn proxy_key(source: &Path, width: u32) -> Result<String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let meta = std::fs::metadata(source)?;
    let mut h = DefaultHasher::new();
    source.to_string_lossy().hash(&mut h);
    meta.len().hash(&mut h);
    if let Ok(modified) = meta.modified() {
        if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
            dur.as_secs().hash(&mut h);
        }
    }
    width.hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}

/// Where a proxy for this source would live, whether or not it exists yet.
pub fn proxy_path(source: &str, width: u32, cache_dir: &Path) -> Result<PathBuf> {
    let canonical = canonical_source(source)?;
    let key = proxy_key(&canonical, width)?;
    Ok(cache_dir.join(format!("{key}.webm")))
}

/// An existing proxy for this source, or None. Cheap: no decoding.
pub fn find_proxy(source: &str, width: u32, cache_dir: &Path) -> Option<Proxy> {
    let path = proxy_path(source, width, cache_dir).ok()?;
    if path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        Some(Proxy { source: source.to_string(), path: path.to_string_lossy().to_string(), width })
    } else {
        None
    }
}

/// Transcode a source to a small, seek-friendly proxy. Reuses an existing one.
pub fn create_proxy(source: &str, width: u32, cache_dir: &Path) -> Result<Proxy> {
    let width = ((width.clamp(160, 1920)) / 2) * 2;
    let canonical = canonical_source(source)?;
    let path = proxy_path(source, width, cache_dir)?;
    std::fs::create_dir_all(cache_dir)?;

    let proxy = Proxy {
        source: canonical.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        width,
    };
    if path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(proxy);
    }

    // A short GOP, not all-intra. Scrubbing means seeking constantly and long
    // GOPs make every seek decode a run of frames, but all-intra inflates the
    // file badly. 12 frames is the compromise.
    //
    // Note a proxy is not necessarily smaller on disk: for already-small or
    // highly compressible footage it can be larger. That is fine. The point is
    // decode cost, which falls with the pixel count, not bytes on disk.
    let out = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-v", "error", "-i"])
        .arg(&canonical)
        .args([
            "-vf", &format!("scale={width}:-2"),
            "-c:v", "libvpx",
            // Realtime deadline: a proxy that takes longer to build than the
            // edit saves is not a proxy.
            "-deadline", "realtime",
            "-cpu-used", "8",
            "-b:v", "0",
            "-crf", "32",
            "-g", "12",
            "-pix_fmt", "yuv420p",
            "-c:a", "libopus",
            "-b:a", "128k",
        ])
        .arg(&path)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { Error::NoFfmpeg } else { Error::Io(e) }
        })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.trim().lines().rev().take(5).collect();
        let msg: Vec<&str> = tail.into_iter().rev().collect();
        return Err(Error::Render(msg.join("\n")));
    }
    Ok(proxy)
}

pub fn clear_proxies(cache_dir: &Path) -> Result<usize> {
    let Ok(entries) = std::fs::read_dir(cache_dir) else { return Ok(0) };
    let mut n = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("webm") && std::fs::remove_file(&p).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod proxy_tests {
    use super::*;

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok()
    }

    fn make_media(name: &str, w: u32, h: u32) -> PathBuf {
        let p = std::env::temp_dir().join(format!("odyssey-proxy-{name}.mp4"));
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   &format!("testsrc=size={w}x{h}:rate=30:duration=1"),
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&p).status().expect("ffmpeg should run");
        assert!(status.success());
        p
    }

    #[test]
    fn creates_a_smaller_proxy_and_reuses_it() {
        if !ffmpeg_available() { return; }
        let src = make_media("big", 1280, 720);
        let dir = std::env::temp_dir().join("odyssey-proxy-cache");
        let _ = clear_proxies(&dir);

        assert!(find_proxy(&src.to_string_lossy(), 640, &dir).is_none(), "nothing cached yet");

        let proxy = create_proxy(&src.to_string_lossy(), 640, &dir)
            .unwrap_or_else(|e| panic!("proxy failed:\n{e}"));
        assert_eq!(proxy.width, 640);

        let info = probe(&proxy.path).unwrap();
        assert_eq!(info.width, 640, "proxy must actually be scaled down");
        assert!(info.has_audio, "proxy keeps audio so the preview can be heard");
        assert!(proxy.path.ends_with(".webm"), "proxies are WebM so a webview can decode them");

        // What matters is pixel throughput, not bytes: a proxy of tiny or very
        // compressible footage can be larger on disk and still decode far cheaper.
        let source_info = probe(&src.to_string_lossy()).unwrap();
        let source_pixels = source_info.width * source_info.height;
        let proxy_pixels = info.width * info.height;
        assert!(
            proxy_pixels * 3 < source_pixels,
            "proxy must cut pixel work substantially: {proxy_pixels} vs {source_pixels}"
        );

        // A second call is a cache hit, not a re-encode.
        let before = std::fs::metadata(&proxy.path).unwrap().modified().unwrap();
        let again = create_proxy(&src.to_string_lossy(), 640, &dir).unwrap();
        assert_eq!(before, std::fs::metadata(&again.path).unwrap().modified().unwrap());

        assert!(find_proxy(&src.to_string_lossy(), 640, &dir).is_some());
        assert!(clear_proxies(&dir).unwrap() >= 1);
    }

    /// Replacing the file on disk must invalidate its proxy.
    #[test]
    fn a_changed_source_gets_a_new_key() {
        if !ffmpeg_available() { return; }
        let src = make_media("changing", 320, 240);
        let dir = std::env::temp_dir().join("odyssey-proxy-key");
        let first = proxy_path(&src.to_string_lossy(), 640, &dir).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(1100));
        let _ = make_media("changing", 640, 480); // same name, different content
        let second = proxy_path(&src.to_string_lossy(), 640, &dir).unwrap();
        assert_ne!(first, second, "a rewritten source must not reuse its old proxy");
    }

    #[test]
    fn proxy_width_is_clamped_and_even() {
        if !ffmpeg_available() { return; }
        let src = make_media("clamp", 320, 240);
        let dir = std::env::temp_dir().join("odyssey-proxy-clamp");
        let _ = clear_proxies(&dir);
        let p = create_proxy(&src.to_string_lossy(), 1, &dir).unwrap();
        assert_eq!(p.width, 160, "clamped to the floor");
        let _ = clear_proxies(&dir);
    }

    #[test]
    fn a_missing_source_has_no_proxy() {
        let dir = std::env::temp_dir().join("odyssey-proxy-missing");
        assert!(find_proxy("/nonexistent/nope.mp4", 640, &dir).is_none());
        assert!(create_proxy("/nonexistent/nope.mp4", 640, &dir).is_err());
    }
}
