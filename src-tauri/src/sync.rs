//! Audio sync: line separately recorded sources up by their sound.
//!
//! Each source's audio is decoded by ffmpeg to mono at a low rate and
//! correlated against the reference with GCC-PHAT: the cross-spectrum is
//! divided by its own magnitude before transforming back, which throws away
//! how each microphone coloured the sound and keeps only timing. What is left
//! peaks sharply at the lag between the recordings even when one camera's
//! mic is across the room from the other.
//!
//! The answer for each source is `d`, in seconds, such that a moment at
//! reference time `r` is at time `r + d` in that source.

use crate::timeline::Error;
use serde::Serialize;
use std::process::Command;

type Result<T> = std::result::Result<T, Error>;

/// Low enough to keep the transforms small, high enough for speech and
/// claps to carry timing to a quarter of a millisecond.
const RATE: u32 = 4000;
/// How much of each source is compared. Cameras rolling on one take overlap
/// well within this.
const WINDOW_SECS: f64 = 180.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SyncResult {
    /// Seconds to add to a reference time to find the same moment here.
    pub offset: f64,
    /// Peak height over the correlation's typical level. Below about 5 the
    /// match is doubtful.
    pub confidence: f64,
}

/// Sync every source in `others` to `reference`.
pub fn sync(reference: &str, others: &[String]) -> Result<Vec<SyncResult>> {
    let r = decode(reference)?;
    others.iter().map(|o| decode(o).map(|x| correlate(&r, &x))).collect()
}

fn decode(path: &str) -> Result<Vec<f32>> {
    let info = crate::video::probe(path).map_err(|e| Error::Invalid(e.to_string()))?;
    if !info.has_audio {
        return Err(Error::Invalid(format!("{path} has no audio to sync by")));
    }
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-i", &info.path, "-t", &format!("{WINDOW_SECS}")])
        .args(["-vn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "f32le", "-"])
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { Error::NoFfmpeg } else { Error::Io(e) })?;
    if !out.status.success() {
        return Err(Error::Render(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

/// GCC-PHAT between `r` and `x`.
fn correlate(r: &[f32], x: &[f32]) -> SyncResult {
    let n = (r.len() + x.len()).next_power_of_two().max(2);
    let load = |s: &[f32]| {
        let mut v = vec![(0.0f64, 0.0f64); n];
        for (i, &a) in s.iter().enumerate() {
            v[i].0 = a as f64;
        }
        v
    };
    let (mut fr, mut fx) = (load(r), load(x));
    fft(&mut fr, false);
    fft(&mut fx, false);
    // X · conj(R), whitened.
    let mut c: Vec<(f64, f64)> = fx
        .iter()
        .zip(&fr)
        .map(|(&(a, b), &(p, q))| {
            let (re, im) = (a * p + b * q, b * p - a * q);
            let m = re.hypot(im).max(1e-12);
            (re / m, im / m)
        })
        .collect();
    fft(&mut c, true);
    // Index k is a lag of k samples; the top half wraps to negative lags.
    let (mut best, mut peak) = (0usize, f64::NEG_INFINITY);
    let mut sum = 0.0;
    for (k, v) in c.iter().enumerate() {
        sum += v.0.abs();
        if v.0 > peak {
            peak = v.0;
            best = k;
        }
    }
    let typical = (sum / n as f64).max(1e-12);
    let lag = if best > n / 2 { best as f64 - n as f64 } else { best as f64 };
    // A lag of k means the source's sound arrives k samples after the
    // reference's, so reference time r is source time r + k/RATE.
    SyncResult { offset: lag / RATE as f64, confidence: peak / typical }
}

/// In-place iterative radix-2 FFT. `inverse` also scales by 1/n.
fn fft(a: &mut [(f64, f64)], inverse: bool) {
    let n = a.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            a.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = 2.0 * std::f64::consts::PI / len as f64 * if inverse { 1.0 } else { -1.0 };
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (ur, ui) = a[start + k];
                let (vr0, vi0) = a[start + k + len / 2];
                let (vr, vi) = (vr0 * cr - vi0 * ci, vr0 * ci + vi0 * cr);
                a[start + k] = (ur + vr, ui + vi);
                a[start + k + len / 2] = (ur - vr, ui - vi);
                let nc = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nc;
            }
        }
        len <<= 1;
    }
    if inverse {
        for v in a.iter_mut() {
            v.0 /= n as f64;
            v.1 /= n as f64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two "cameras" on one take: B starts rolling `late` seconds after A,
    /// and hears the room through a different microphone (filtered, quieter,
    /// with its own hiss).
    fn take(name: &str, late: f64, colour: &str) -> std::path::PathBuf {
        let p = crate::timeline::tests::scratch(&format!("odyssey-sync-{name}.mp4"));
        let ok = Command::new("ffmpeg")
            .args(["-y", "-v", "error",
                "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=7:duration=12:amplitude=0.5",
                "-f", "lavfi", "-i", "anoisesrc=color=white:seed=99:duration=12:amplitude=0.05",
                "-f", "lavfi", "-i", "color=c=gray:size=64x36:rate=10:duration=12",
                "-filter_complex",
                &format!("[0]atrim=start={late},asetpts=PTS-STARTPTS,{colour}[s];[s][1]amix=inputs=2:duration=first[a]"),
                "-map", "2:v", "-map", "[a]", "-shortest", "-c:v", "libx264", "-c:a", "aac"])
            .arg(&p)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        p
    }

    #[test]
    fn finds_the_offset_between_two_cameras() {
        let a = take("a", 0.0, "anull");
        let b = take("b", 1.35, "lowpass=f=1500,volume=0.4");
        let r = sync(a.to_str().unwrap(), &[b.to_string_lossy().to_string()]).unwrap();
        // B started 1.35 s late, so reference time r is B time r - 1.35.
        assert!((r[0].offset + 1.35).abs() < 0.01, "{:?}", r[0]);
        assert!(r[0].confidence > 5.0, "{:?}", r[0]);
        // And the other way round.
        let r = sync(b.to_str().unwrap(), &[a.to_string_lossy().to_string()]).unwrap();
        assert!((r[0].offset - 1.35).abs() < 0.01, "{:?}", r[0]);
    }

    #[test]
    fn fft_round_trips() {
        let mut v: Vec<(f64, f64)> = (0..64).map(|i| ((i as f64 * 0.37).sin(), 0.0)).collect();
        let orig = v.clone();
        fft(&mut v, false);
        fft(&mut v, true);
        for (a, b) in v.iter().zip(&orig) {
            assert!((a.0 - b.0).abs() < 1e-9 && a.1.abs() < 1e-9);
        }
    }
}
