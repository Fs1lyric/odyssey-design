//! Odyssey Video — the multi-track timeline engine.
//!
//! Written from scratch against ffmpeg. The model is a project containing
//! tracks, tracks containing clips positioned on an absolute timeline, and
//! clips carrying effects whose parameters may be keyframed.
//!
//! Rendering compiles the whole project into a single ffmpeg `filter_complex`:
//! every video clip is trimmed, speed-adjusted, effected, delayed to its start
//! position and overlaid onto a base canvas in track order; every audio clip is
//! trimmed, tempo-adjusted, gained, delayed and mixed. Keyframes become ffmpeg
//! expressions, so animation is evaluated per frame by ffmpeg itself rather
//! than by us rendering frame by frame.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the project has no clips")]
    Empty,
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
    #[error("project file: {0}")]
    Json(#[from] serde_json::Error),
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------- keyframes

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Easing {
    #[default]
    Linear,
    Hold,
    EaseIn,
    EaseOut,
    EaseInOut,
    CubicIn,
    CubicOut,
    CubicInOut,
    SineIn,
    SineOut,
    BackOut,
    ElasticOut,
    BounceOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe {
    /// Seconds from the start of the clip.
    pub time: f64,
    pub value: f64,
    #[serde(default)]
    pub easing: Easing,
}

/// A parameter is either a constant or an animated track of keyframes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Param {
    Static(f64),
    Animated { keyframes: Vec<Keyframe> },
}

impl Param {
    pub fn is_animated(&self) -> bool {
        matches!(self, Param::Animated { keyframes } if keyframes.len() > 1)
    }

    /// The value at t=0, used where a filter cannot take an expression.
    pub fn first(&self) -> f64 {
        match self {
            Param::Static(v) => *v,
            Param::Animated { keyframes } => keyframes.first().map(|k| k.value).unwrap_or(0.0),
        }
    }

    /// The reference implementation of keyframe interpolation. `to_expr` is
    /// what ffmpeg renders from, and `paramAt` in timeline.ts mirrors this for
    /// the preview — so this is the definition the other two are tested against.
    #[allow(dead_code)]
    pub fn value_at(&self, t: f64) -> f64 {
        match self {
            Param::Static(v) => *v,
            Param::Animated { keyframes } => {
                if keyframes.is_empty() {
                    return 0.0;
                }
                let mut sorted: Vec<&Keyframe> = keyframes.iter().collect();
                sorted.sort_by(|a, b| {
                    a.time
                        .partial_cmp(&b.time)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                if t <= sorted[0].time {
                    return sorted[0].value;
                }
                if t >= sorted[sorted.len() - 1].time {
                    return sorted[sorted.len() - 1].value;
                }
                for w in sorted.windows(2) {
                    let (a, b) = (w[0], w[1]);
                    if t >= a.time && t <= b.time {
                        let span = b.time - a.time;
                        if span <= 0.0 {
                            return b.value;
                        }
                        let p = ease((t - a.time) / span, a.easing);
                        return a.value + (b.value - a.value) * p;
                    }
                }
                sorted[sorted.len() - 1].value
            }
        }
    }

    /// Compile to an ffmpeg expression in `t` (seconds within the clip).
    /// Produces a nested if() chain, one segment per keyframe interval.
    pub fn to_expr(&self) -> String {
        match self {
            Param::Static(v) => format!("{v:.6}"),
            Param::Animated { keyframes } => {
                if keyframes.is_empty() {
                    return "0".into();
                }
                let mut kf: Vec<&Keyframe> = keyframes.iter().collect();
                kf.sort_by(|a, b| {
                    a.time
                        .partial_cmp(&b.time)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                if kf.len() == 1 {
                    return format!("{:.6}", kf[0].value);
                }

                // Build from the last segment backwards so each if() nests.
                let last = kf[kf.len() - 1];
                let mut expr = format!("{:.6}", last.value);
                for w in kf.windows(2).rev() {
                    let (a, b) = (w[0], w[1]);
                    let span = b.time - a.time;
                    let seg = if span <= 0.0 || a.easing == Easing::Hold {
                        format!("{:.6}", a.value)
                    } else {
                        // Normalised progress within this segment.
                        let p = format!("((t-{:.6})/{:.6})", a.time, span);
                        let eased = ease_expr(&p, a.easing);
                        format!("({:.6}+({:.6})*{})", a.value, b.value - a.value, eased)
                    };
                    expr = format!("if(lt(t,{:.6}),{},{})", b.time, seg, expr);
                }
                // Before the first keyframe, hold its value.
                format!("if(lt(t,{:.6}),{:.6},{})", kf[0].time, kf[0].value, expr)
            }
        }
    }
}

/// Companion to `ease_expr`: the same curves evaluated directly, so tests can
/// assert that the expression ffmpeg gets matches the values we intend.
#[allow(dead_code)]
fn ease(p: f64, e: Easing) -> f64 {
    let p = p.clamp(0.0, 1.0);
    match e {
        Easing::Linear => p,
        Easing::Hold => 0.0,
        Easing::EaseIn => p * p,
        Easing::EaseOut => p * (2.0 - p),
        Easing::EaseInOut => {
            if p < 0.5 {
                2.0 * p * p
            } else {
                -1.0 + (4.0 - 2.0 * p) * p
            }
        }
        Easing::CubicIn => p * p * p,
        Easing::CubicOut => 1.0 - (1.0 - p).powi(3),
        Easing::CubicInOut => {
            if p < 0.5 {
                4.0 * p * p * p
            } else {
                1.0 - (-2.0 * p + 2.0).powi(3) / 2.0
            }
        }
        Easing::SineIn => 1.0 - (p * std::f64::consts::FRAC_PI_2).cos(),
        Easing::SineOut => (p * std::f64::consts::FRAC_PI_2).sin(),
        // c1 = 1.70158 is the standard overshoot constant; c3 = c1 + 1.
        Easing::BackOut => 1.0 + 2.70158 * (p - 1.0).powi(3) + 1.70158 * (p - 1.0).powi(2),
        Easing::ElasticOut => {
            if p <= 0.0 {
                0.0
            } else if p >= 1.0 {
                1.0
            } else {
                // c4 = 2*PI/3
                2f64.powf(-10.0 * p) * ((p * 10.0 - 0.75) * 2.0943951).sin() + 1.0
            }
        }
        Easing::BounceOut => bounce_out(p),
    }
}

/// Shared by `ease` and its test; the expression form below mirrors this
/// piecewise definition exactly.
fn bounce_out(p: f64) -> f64 {
    const N: f64 = 7.5625;
    const D: f64 = 2.75;
    if p < 1.0 / D {
        N * p * p
    } else if p < 2.0 / D {
        let q = p - 1.5 / D;
        N * q * q + 0.75
    } else if p < 2.5 / D {
        let q = p - 2.25 / D;
        N * q * q + 0.9375
    } else {
        let q = p - 2.625 / D;
        N * q * q + 0.984375
    }
}

fn ease_expr(p: &str, e: Easing) -> String {
    match e {
        Easing::Linear => p.to_string(),
        Easing::Hold => "0".into(),
        Easing::EaseIn => format!("({p}*{p})"),
        Easing::EaseOut => format!("({p}*(2-{p}))"),
        Easing::EaseInOut => format!("(if(lt({p},0.5),2*{p}*{p},-1+(4-2*{p})*{p}))"),
        Easing::CubicIn => format!("({p}*{p}*{p})"),
        Easing::CubicOut => format!("(1-pow(1-{p},3))"),
        Easing::CubicInOut => {
            format!("(if(lt({p},0.5),4*{p}*{p}*{p},1-pow(-2*{p}+2,3)/2))")
        }
        Easing::SineIn => format!("(1-cos({p}*1.5707963267948966))"),
        Easing::SineOut => format!("(sin({p}*1.5707963267948966))"),
        Easing::BackOut => {
            format!("(1+2.70158*pow({p}-1,3)+1.70158*pow({p}-1,2))")
        }
        Easing::ElasticOut => format!(
            "(if(lte({p},0),0,if(gte({p},1),1,pow(2,-10*{p})*sin(({p}*10-0.75)*2.0943951023931953)+1)))"
        ),
        Easing::BounceOut => format!(
            "(if(lt({p},0.36363636),7.5625*{p}*{p},\
if(lt({p},0.72727273),7.5625*pow({p}-0.54545455,2)+0.75,\
if(lt({p},0.90909091),7.5625*pow({p}-0.81818182,2)+0.9375,\
7.5625*pow({p}-0.95454545,2)+0.984375))))"
        ),
    }
}

// ------------------------------------------------------------------ effects

/// What an effect compiles to. Animation reaches ffmpeg by one of three routes,
/// picked per filter from what ffmpeg actually supports:
///
///   1. **Expression** — the option accepts an expression in `t`, so ffmpeg
///      evaluates it per frame. Best fidelity. (eq, crop, rotate, drawtext,
///      volume, vignette)
///   2. **sendcmd** — the option is flagged AV_OPT_FLAG_RUNTIME_PARAM, so the
///      curve is sampled and issued as timed commands. (gblur, hue, chromakey,
///      colorchannelmixer, highpass, lowpass, scale)
///   3. **Timeline stacking** — neither of the above, but the filter supports
///      `enable`, so one instance per sampled slice is emitted, each active for
///      its own span. (unsharp, frei0r)
#[derive(Debug, Default)]
pub struct Compiled {
    pub filters: Vec<String>,
    /// (time, filter target, option, value) for a `sendcmd` prelude.
    pub commands: Vec<(f64, String, String, String)>,
}

impl Compiled {
    fn f(filter: String) -> Compiled {
        Compiled {
            filters: vec![filter],
            commands: Vec::new(),
        }
    }
    fn many(filters: Vec<String>) -> Compiled {
        Compiled {
            filters,
            commands: Vec::new(),
        }
    }
}

/// Hard cap so a long clip cannot generate an unbounded command list. At 60 fps
/// this covers 40 seconds of animation before sampling starts to thin out.
const MAX_SAMPLES: usize = 2400;

/// Sample an animated curve at the project frame rate, so a "sampled" route
/// lands one value per rendered frame — matching the per-frame expression
/// route exactly, until a clip is long enough to hit MAX_SAMPLES.
fn sample_times(dur: f64, fps: u32) -> Vec<f64> {
    let rate = (fps.max(1)) as f64;
    let n = ((dur * rate).ceil() as usize).clamp(2, MAX_SAMPLES);
    (0..n)
        .map(|i| dur * (i as f64) / ((n - 1) as f64))
        .collect()
}

/// Emit timed commands stepping `option` along the parameter's curve.
fn commands_for(
    p: &Param,
    target: &str,
    option: &str,
    dur: f64,
    fps: u32,
) -> Vec<(f64, String, String, String)> {
    if !p.is_animated() {
        return Vec::new();
    }
    sample_times(dur, fps)
        .into_iter()
        .map(|t| {
            (
                t,
                target.to_string(),
                option.to_string(),
                format!("{:.6}", p.value_at(t)),
            )
        })
        .collect()
}

/// Emit one filter instance per sampled slice, each gated to its own span.
fn stacked(p: &Param, dur: f64, fps: u32, build: impl Fn(f64) -> String) -> Vec<String> {
    if !p.is_animated() {
        return vec![build(p.first())];
    }
    let times = sample_times(dur, fps);
    let mut out = Vec::new();
    for (i, t) in times.iter().enumerate() {
        let next = times.get(i + 1).copied().unwrap_or(dur + 1.0);
        out.push(format!(
            "{}:enable='between(t,{:.4},{:.4})'",
            build(p.value_at(*t)),
            t,
            next
        ));
    }
    out
}

/// Effects are named so the UI can present them; each compiles to one or more
/// ffmpeg filters. Parameters that ffmpeg can evaluate per frame accept
/// keyframes; the rest fall back to their value at t=0, which is documented in
/// `supports_keyframes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Effect {
    /// Brightness -1..1, contrast 0..4, saturation 0..3, gamma 0.1..10.
    Color {
        #[serde(default = "p_zero")]
        brightness: Param,
        #[serde(default = "p_one")]
        contrast: Param,
        #[serde(default = "p_one")]
        saturation: Param,
        #[serde(default = "p_one")]
        gamma: Param,
    },
    /// Hue rotation in degrees.
    Hue {
        #[serde(default = "p_zero")]
        degrees: Param,
    },
    /// Gaussian blur, sigma in pixels.
    Blur {
        #[serde(default = "p_zero")]
        sigma: Param,
    },
    Sharpen {
        #[serde(default = "p_one")]
        amount: Param,
    },
    /// Opacity 0..1, applied to the clip's alpha before compositing.
    Opacity {
        #[serde(default = "p_one")]
        level: Param,
    },
    /// Fade from/to black at the clip's head and tail, in seconds.
    Fade {
        #[serde(default)]
        in_secs: f64,
        #[serde(default)]
        out_secs: f64,
    },
    /// Crop to a rectangle, in pixels.
    Crop {
        x: Param,
        y: Param,
        width: f64,
        height: f64,
    },
    /// Rotation in degrees, about the centre.
    Rotate {
        #[serde(default = "p_zero")]
        degrees: Param,
    },
    /// Uniform scale factor, 1.0 is unchanged. Pan offsets in pixels.
    Transform {
        #[serde(default = "p_one")]
        scale: Param,
        #[serde(default = "p_zero")]
        x: Param,
        #[serde(default = "p_zero")]
        y: Param,
    },
    Vignette {
        #[serde(default = "p_zero")]
        angle: Param,
    },
    /// Key out a colour. `similarity` and `blend` are 0..1.
    ChromaKey {
        color: String,
        #[serde(default = "p_point_one")]
        similarity: Param,
        #[serde(default = "p_zero")]
        blend: Param,
    },
    /// Burn text onto the clip.
    Text {
        content: String,
        #[serde(default = "d_size")]
        size: f64,
        #[serde(default = "d_white")]
        color: String,
        #[serde(default = "p_zero")]
        x: Param,
        #[serde(default = "p_zero")]
        y: Param,
        #[serde(default)]
        font: String,
    },
    /// Audio gain multiplier.
    Volume {
        #[serde(default = "p_one")]
        level: Param,
    },
    /// Audio fades in seconds.
    AudioFade {
        #[serde(default)]
        in_secs: f64,
        #[serde(default)]
        out_secs: f64,
    },
    Highpass {
        #[serde(default = "p_two_hundred")]
        frequency: Param,
    },
    Lowpass {
        #[serde(default = "p_three_thousand")]
        frequency: Param,
    },
    /// Lumetri-style curve grading. Each channel is a list of control points
    /// in 0..1, which is exactly what ffmpeg's `curves` filter takes.
    Curves {
        #[serde(default)]
        master: Vec<(f64, f64)>,
        #[serde(default)]
        red: Vec<(f64, f64)>,
        #[serde(default)]
        green: Vec<(f64, f64)>,
        #[serde(default)]
        blue: Vec<(f64, f64)>,
    },
    /// Three-way colour correction: shadows, midtones, highlights, per channel.
    /// Premiere calls these the colour wheels; ffmpeg calls them shadows,
    /// midtones and highlights on `colorbalance`.
    ColorWheels {
        #[serde(default = "p_zero")]
        lift_r: Param,
        #[serde(default = "p_zero")]
        lift_g: Param,
        #[serde(default = "p_zero")]
        lift_b: Param,
        #[serde(default = "p_zero")]
        gamma_r: Param,
        #[serde(default = "p_zero")]
        gamma_g: Param,
        #[serde(default = "p_zero")]
        gamma_b: Param,
        #[serde(default = "p_zero")]
        gain_r: Param,
        #[serde(default = "p_zero")]
        gain_g: Param,
        #[serde(default = "p_zero")]
        gain_b: Param,
    },
    /// A 3D lookup table, the way a creative LUT is applied.
    Lut3d { path: String },
    /// Stabilisation. `trf` is the motion file produced by the analysis pass;
    /// without one the effect is inert, because vidstabtransform has nothing
    /// to work from.
    Stabilize {
        #[serde(default)]
        trf: String,
        #[serde(default = "d_smoothing")]
        smoothing: f64,
        #[serde(default = "d_zoom")]
        zoom: f64,
    },
    /// EBU R128 loudness normalisation.
    Loudness {
        #[serde(default = "d_lufs")]
        target: f64,
    },
    /// Temporal and spatial denoise.
    Denoise {
        #[serde(default = "d_denoise")]
        strength: f64,
    },
    /// Mirror horizontally or vertically.
    Flip {
        #[serde(default)]
        horizontal: bool,
        #[serde(default)]
        vertical: bool,
    },
    /// Mosaic the picture.
    Pixelate {
        #[serde(default = "d_pixel")]
        size: Param,
    },
    /// Invert the picture.
    Invert,
    /// Reduce the picture to shades of grey.
    Monochrome,
    /// Warm or cool the picture, in kelvin.
    Temperature {
        #[serde(default = "d_kelvin")]
        kelvin: Param,
    },
    /// Lift or crush blacks and whites.
    Levels {
        #[serde(default = "p_zero")]
        black: Param,
        #[serde(default = "p_one")]
        white: Param,
    },
    /// Exposure, as a stop adjustment.
    Exposure {
        #[serde(default = "p_zero")]
        stops: Param,
    },
    /// Film grain.
    Grain {
        #[serde(default = "d_grain")]
        strength: f64,
    },
    /// Directional or box blur, cheaper than gaussian for large radii.
    BoxBlur {
        #[serde(default = "d_box")]
        radius: Param,
    },
    /// Motion blur by blending neighbouring frames.
    MotionBlur {
        #[serde(default = "d_frames")]
        frames: f64,
    },
    /// Outline edges.
    EdgeDetect {
        #[serde(default = "d_edge")]
        low: f64,
        #[serde(default = "d_edge_hi")]
        high: f64,
    },
    /// Emboss, through a convolution kernel.
    Emboss,
    /// Sharpen with a convolution rather than unsharp masking.
    Crisp,
    /// Remove banding in gradients.
    Deband,
    /// Even out flicker between frames.
    Deflicker,
    /// Correct barrel or pincushion distortion.
    LensCorrect {
        #[serde(default = "p_zero")]
        k1: Param,
        #[serde(default = "p_zero")]
        k2: Param,
    },
    /// Key on brightness rather than colour.
    LumaKey {
        #[serde(default = "d_luma")]
        threshold: Param,
        #[serde(default = "p_point_one")]
        tolerance: Param,
    },
    /// Remove the green or blue spill a key leaves behind.
    Despill {
        #[serde(default = "d_green")]
        colour: String,
        #[serde(default = "p_one")]
        amount: Param,
    },
    /// Shift the colour channels apart.
    ChromaShift {
        #[serde(default = "p_zero")]
        x: Param,
        #[serde(default = "p_zero")]
        y: Param,
    },
    /// Letterbox or pillarbox to a target aspect ratio.
    Reframe {
        #[serde(default = "d_aspect")]
        aspect: f64,
    },
    /// Posterise to a fixed number of levels.
    Posterize {
        #[serde(default = "d_levels")]
        levels: Param,
    },

    // ---- audio ----
    /// Echo.
    Echo {
        #[serde(default = "d_delay")]
        delay_ms: f64,
        #[serde(default = "d_decay")]
        decay: f64,
    },
    /// Chorus.
    Chorus {
        #[serde(default = "d_depth")]
        depth: f64,
    },
    /// Flanger.
    Flanger {
        #[serde(default = "d_depth")]
        depth: f64,
    },
    /// Shift pitch without changing length.
    PitchShift {
        #[serde(default = "p_one")]
        ratio: Param,
    },
    /// Gate out noise below a threshold.
    NoiseGate {
        #[serde(default = "d_gate")]
        threshold: f64,
    },
    /// Compress dynamics.
    Compressor {
        #[serde(default = "d_comp_threshold")]
        threshold: f64,
        #[serde(default = "d_comp_ratio")]
        ratio: f64,
    },
    /// Stop anything exceeding a ceiling.
    Limiter {
        #[serde(default = "d_limit")]
        ceiling: f64,
    },
    /// Widen or narrow the stereo image.
    StereoWidth {
        #[serde(default = "p_one")]
        amount: Param,
    },
    /// Fold to mono.
    Mono,
    /// Swap left and right.
    SwapChannels,
    /// Strip silence from the head and tail.
    TrimSilence {
        #[serde(default = "d_silence")]
        threshold: f64,
    },
    /// Saturation that protects already-saturated pixels (`vibrance`).
    Vibrance {
        #[serde(default = "p_zero")]
        intensity: Param,
    },
    /// Per-channel midtone lift (`colorbalance`).
    ColorBalance {
        #[serde(default = "p_zero")]
        r: Param,
        #[serde(default = "p_zero")]
        g: Param,
        #[serde(default = "p_zero")]
        b: Param,
    },
    /// Splits red and blue horizontally (`rgbashift`).
    ChromaticAberration {
        #[serde(default = "p_zero")]
        amount: Param,
    },
    /// Skew on each axis (`shear`).
    Shear {
        #[serde(default = "p_zero")]
        x: Param,
        #[serde(default = "p_zero")]
        y: Param,
    },
    /// Key on a flat RGB colour rather than chroma (`colorkey`).
    ColorKey {
        #[serde(default = "d_green")]
        color: String,
        #[serde(default = "p_point_one")]
        similarity: Param,
        #[serde(default = "p_zero")]
        blend: Param,
    },
    /// Key a hue/saturation/value region (`hsvkey`).
    HsvKey {
        #[serde(default = "p_zero")]
        hue: Param,
        #[serde(default = "p_half")]
        sat: Param,
        #[serde(default = "p_half")]
        val: Param,
        #[serde(default = "p_point_one")]
        similarity: Param,
        #[serde(default = "p_zero")]
        blend: Param,
    },
    /// Average N successive frames (`tmix`) for a shutter-drag look.
    FrameBlend {
        #[serde(default = "p_three")]
        frames: Param,
    },
    /// Map luma onto a colour ramp (`pseudocolor`).
    FalseColor {
        #[serde(default = "d_preset_magma")]
        preset: String,
    },
    /// Histogram equalisation (`histeq`).
    HistEq {
        #[serde(default = "p_zero")]
        strength: Param,
    },
    /// Auto black/white point per frame (`normalize`).
    AutoLevels {
        #[serde(default = "p_one")]
        strength: Param,
    },
    /// Deinterlace (`yadif`).
    Deinterlace {
        #[serde(default = "d_yadif_mode")]
        mode: f64,
    },
    /// Contrast-adaptive sharpen (`cas`).
    AdaptiveSharpen {
        #[serde(default = "p_half")]
        strength: Param,
    },
    /// Chroma-only noise reduction (`chromanr`).
    ChromaDenoise {
        #[serde(default = "p_three")]
        threshold: Param,
    },
    /// Hue/saturation with an intensity control (`huesaturation`).
    HueSaturation {
        #[serde(default = "p_zero")]
        hue: Param,
        #[serde(default = "p_zero")]
        saturation: Param,
        #[serde(default = "p_zero")]
        intensity: Param,
    },
    /// Edge-preserving smoothing (`bilateral`).
    Bilateral {
        #[serde(default = "p_point_one")]
        sigma_s: Param,
        #[serde(default = "p_point_one")]
        sigma_r: Param,
    },
    /// Blur that leaves edges alone (`smartblur`).
    SmartBlur {
        #[serde(default = "p_one")]
        radius: Param,
        #[serde(default = "p_one")]
        strength: Param,
    },
    /// Wavelet denoiser (`vaguedenoiser`).
    VagueDenoise {
        #[serde(default = "p_two")]
        threshold: Param,
    },
    /// Fixed sepia matrix (`colorchannelmixer`).
    Sepia,
    /// Darken alternate scanlines for a CRT look.
    Scanlines {
        #[serde(default = "p_half")]
        amount: Param,
    },
    /// Reflect the left half onto the right.
    Mirror,

    // ---- audio ----
    /// Low shelf (`bass`).
    Bass {
        #[serde(default = "p_zero")]
        gain: Param,
        #[serde(default = "p_hundred")]
        freq: Param,
    },
    /// High shelf (`treble`).
    Treble {
        #[serde(default = "p_zero")]
        gain: Param,
        #[serde(default = "p_three_thousand")]
        freq: Param,
    },
    /// One parametric band (`equalizer`).
    ParametricEq {
        #[serde(default = "p_thousand")]
        freq: Param,
        #[serde(default = "p_one")]
        width: Param,
        #[serde(default = "p_zero")]
        gain: Param,
    },
    /// Amplitude modulation (`tremolo`).
    Tremolo {
        #[serde(default = "p_two")]
        freq: Param,
        #[serde(default = "p_half")]
        depth: Param,
    },
    /// Pitch modulation (`vibrato`).
    Vibrato {
        #[serde(default = "p_two")]
        freq: Param,
        #[serde(default = "p_half")]
        depth: Param,
    },
    /// Bit-depth reduction (`acrusher`).
    BitCrush {
        #[serde(default = "p_two")]
        bits: Param,
        #[serde(default = "p_half")]
        mix: Param,
    },
    /// Harmonic exciter (`aexciter`).
    Exciter {
        #[serde(default = "p_one")]
        amount: Param,
    },
    /// Sub-bass reinforcement (`asubboost`).
    SubBoost {
        #[serde(default = "p_half")]
        amount: Param,
    },
    /// Level dialogue without pumping (`speechnorm`).
    SpeechNorm {
        #[serde(default = "p_two")]
        expansion: Param,
    },
    /// Spectral noise reduction (`afftdn`).
    AudioDenoise {
        #[serde(default = "p_hundred")]
        reduction: Param,
    },
    /// Any installed frei0r plugin. This is how the effect count reaches the
    /// hundreds: the same plugin library Kdenlive draws on. Parameters are
    /// frei0r's own normalised 0..1 values, in the plugin's declared order.
    Frei0r {
        name: String,
        #[serde(default)]
        params: Vec<Param>,
    },
}

fn p_zero() -> Param {
    Param::Static(0.0)
}
fn p_one() -> Param {
    Param::Static(1.0)
}
fn p_point_one() -> Param {
    Param::Static(0.1)
}
fn p_two_hundred() -> Param {
    Param::Static(200.0)
}
fn p_three_thousand() -> Param {
    Param::Static(3000.0)
}
fn d_size() -> f64 {
    48.0
}
fn d_smoothing() -> f64 {
    10.0
}
fn d_zoom() -> f64 {
    0.0
}
fn d_lufs() -> f64 {
    -16.0
}
fn d_denoise() -> f64 {
    4.0
}
fn d_pixel() -> Param {
    Param::Static(16.0)
}
fn d_kelvin() -> Param {
    Param::Static(6500.0)
}
fn d_grain() -> f64 {
    8.0
}
fn d_box() -> Param {
    Param::Static(4.0)
}
fn d_frames() -> f64 {
    3.0
}
fn d_edge() -> f64 {
    0.1
}
fn d_edge_hi() -> f64 {
    0.4
}
fn d_luma() -> Param {
    Param::Static(0.1)
}
fn d_green() -> String {
    "green".into()
}
fn d_aspect() -> f64 {
    16.0 / 9.0
}
fn d_levels() -> Param {
    Param::Static(6.0)
}
fn d_delay() -> f64 {
    300.0
}
fn d_decay() -> f64 {
    0.4
}
fn d_depth() -> f64 {
    0.5
}
fn d_gate() -> f64 {
    0.02
}
fn d_comp_threshold() -> f64 {
    0.125
}
fn d_comp_ratio() -> f64 {
    4.0
}
fn d_limit() -> f64 {
    0.95
}
fn d_silence() -> f64 {
    0.02
}
fn d_white() -> String {
    "white".into()
}

impl Effect {
    pub fn is_audio(&self) -> bool {
        matches!(
            self,
            Effect::Volume { .. }
                | Effect::AudioFade { .. }
                | Effect::Highpass { .. }
                | Effect::Lowpass { .. }
                | Effect::Loudness { .. }
                | Effect::Echo { .. }
                | Effect::Chorus { .. }
                | Effect::Flanger { .. }
                | Effect::PitchShift { .. }
                | Effect::NoiseGate { .. }
                | Effect::Compressor { .. }
                | Effect::Limiter { .. }
                | Effect::StereoWidth { .. }
                | Effect::Mono
                | Effect::SwapChannels
                | Effect::TrimSilence { .. }
                | Effect::Bass { .. }
                | Effect::Treble { .. }
                | Effect::ParametricEq { .. }
                | Effect::Tremolo { .. }
                | Effect::Vibrato { .. }
                | Effect::BitCrush { .. }
                | Effect::Exciter { .. }
                | Effect::SubBoost { .. }
                | Effect::SpeechNorm { .. }
                | Effect::AudioDenoise { .. }
        )
    }

    /// Every numeric parameter is animatable; this reports which route is used.
    /// The UI mirrors this mapping in timeline.ts to label each effect. The
    /// test below asserts every variant reports a known route, so adding an
    /// effect without classifying it fails here; keeping the TS copy in step is
    /// still a manual step.
    #[allow(dead_code)]
    pub fn animation_route(&self) -> &'static str {
        match self {
            Effect::Color { .. }
            | Effect::Crop { .. }
            | Effect::Rotate { .. }
            | Effect::Volume { .. }
            | Effect::Text { .. }
            | Effect::Vignette { .. } => "expression",
            Effect::Blur { .. }
            | Effect::Hue { .. }
            | Effect::ChromaKey { .. }
            | Effect::Opacity { .. }
            | Effect::Highpass { .. }
            | Effect::Lowpass { .. }
            | Effect::Transform { .. } => "command",
            Effect::Sharpen { .. } | Effect::Frei0r { .. } => "stacked",
            Effect::Fade { .. }
            | Effect::AudioFade { .. }
            | Effect::Curves { .. }
            | Effect::Lut3d { .. }
            | Effect::Stabilize { .. }
            | Effect::Loudness { .. }
            | Effect::Denoise { .. } => "static",
            Effect::ColorWheels { .. } => "command",
            Effect::Pixelate { .. }
            | Effect::Temperature { .. }
            | Effect::Levels { .. }
            | Effect::Exposure { .. }
            | Effect::BoxBlur { .. }
            | Effect::LensCorrect { .. }
            | Effect::LumaKey { .. }
            | Effect::Despill { .. }
            | Effect::ChromaShift { .. }
            | Effect::Posterize { .. }
            | Effect::PitchShift { .. }
            | Effect::StereoWidth { .. } => "command",
            Effect::Flip { .. }
            | Effect::Invert
            | Effect::Monochrome
            | Effect::Grain { .. }
            | Effect::MotionBlur { .. }
            | Effect::EdgeDetect { .. }
            | Effect::Emboss
            | Effect::Crisp
            | Effect::Deband
            | Effect::Deflicker
            | Effect::Reframe { .. }
            | Effect::Echo { .. }
            | Effect::Chorus { .. }
            | Effect::Flanger { .. }
            | Effect::NoiseGate { .. }
            | Effect::Compressor { .. }
            | Effect::Limiter { .. }
            | Effect::Mono
            | Effect::SwapChannels
            | Effect::TrimSilence { .. }
            | Effect::Vibrance { .. }
            | Effect::ColorBalance { .. }
            | Effect::ChromaticAberration { .. }
            | Effect::Shear { .. }
            | Effect::ColorKey { .. }
            | Effect::HsvKey { .. }
            | Effect::FrameBlend { .. }
            | Effect::FalseColor { .. }
            | Effect::HistEq { .. }
            | Effect::AutoLevels { .. }
            | Effect::Deinterlace { .. }
            | Effect::AdaptiveSharpen { .. }
            | Effect::ChromaDenoise { .. }
            | Effect::HueSaturation { .. }
            | Effect::Bilateral { .. }
            | Effect::SmartBlur { .. }
            | Effect::VagueDenoise { .. }
            | Effect::Sepia
            | Effect::Scanlines { .. }
            | Effect::Mirror
            | Effect::Bass { .. }
            | Effect::Treble { .. }
            | Effect::ParametricEq { .. }
            | Effect::Tremolo { .. }
            | Effect::Vibrato { .. }
            | Effect::BitCrush { .. }
            | Effect::Exciter { .. }
            | Effect::SubBoost { .. }
            | Effect::SpeechNorm { .. }
            | Effect::AudioDenoise { .. } => "static",
        }
    }

    /// Compile to ffmpeg filters plus any timed commands. `dur` is the clip's
    /// timeline duration.
    fn compile(&self, dur: f64, width: u32, height: u32, fps: u32) -> Compiled {
        // Route 1: an expression in `t`, evaluated by ffmpeg per frame.
        let expr = |p: &Param| -> String { p.to_expr() };
        // Routes 2 and 3 start from the value at t=0 and animate from there.
        let first = |p: &Param| -> String { format!("{:.6}", p.first()) };

        match self {
            Effect::Color { brightness, contrast, saturation, gamma } => {
                let animated = brightness.is_animated() || contrast.is_animated()
                    || saturation.is_animated() || gamma.is_animated();
                let mut f = format!(
                    "eq=brightness='{}':contrast='{}':saturation='{}':gamma='{}'",
                    expr(brightness), expr(contrast), expr(saturation), expr(gamma)
                );
                if animated {
                    f.push_str(":eval=frame");
                }
                Compiled::f(f)
            }
            Effect::Hue { degrees } => {
                let mut c = Compiled::f(format!("hue=h={}", first(degrees)));
                c.commands = commands_for(degrees, "hue", "h", dur, fps);
                c
            }
            Effect::Blur { sigma } => {
                if !sigma.is_animated() && sigma.first() <= 0.0 {
                    return Compiled::default();
                }
                let mut c = Compiled::f(format!("gblur=sigma={}", first(sigma)));
                c.commands = commands_for(sigma, "gblur", "sigma", dur, fps);
                c
            }
            Effect::Sharpen { amount } => {
                // unsharp has neither expressions nor runtime options, but it
                // does support `enable`, so animate by stacking gated copies.
                Compiled::many(stacked(amount, dur, fps, |v| format!("unsharp=5:5:{v:.4}:5:5:0")))
            }
            Effect::Opacity { level } => {
                let mut c = Compiled::many(vec![
                    "format=yuva420p".into(),
                    format!("colorchannelmixer=aa={}", first(level)),
                ]);
                c.commands = commands_for(level, "colorchannelmixer", "aa", dur, fps);
                c
            }
            Effect::Fade { in_secs, out_secs } => {
                let mut out = Vec::new();
                if *in_secs > 0.0 {
                    out.push(format!("fade=t=in:st=0:d={in_secs:.4}"));
                }
                if *out_secs > 0.0 {
                    let st = (dur - out_secs).max(0.0);
                    out.push(format!("fade=t=out:st={st:.4}:d={out_secs:.4}"));
                }
                Compiled::many(out)
            }
            Effect::Crop { x, y, width: w, height: h } => {
                Compiled::f(format!("crop={w:.0}:{h:.0}:'{}':'{}'", expr(x), expr(y)))
            }
            Effect::Rotate { degrees } => {
                let d = expr(degrees);
                Compiled::f(format!(
                    "rotate='({d})*PI/180':ow=rotw(({d})*PI/180):oh=roth(({d})*PI/180):c=none"
                ))
            }
            Effect::Transform { scale, x, y } => {
                // scale's w/h are runtime-settable, so a zoom can be animated.
                let s0 = scale.first().max(0.01);
                let nw = (width as f64 * s0).round().max(2.0);
                let nh = (height as f64 * s0).round().max(2.0);
                let mut c = Compiled::many(vec![
                    format!("scale={nw:.0}:{nh:.0}"),
                    format!(
                        "pad={width}:{height}:'{}':'{}':color=black@0",
                        expr_offset(x, width as f64, scale, true),
                        expr_offset(y, height as f64, scale, false)
                    ),
                ]);
                if scale.is_animated() {
                    let mut cmds = Vec::new();
                    for t in sample_times(dur, fps) {
                        let sv = scale.value_at(t).max(0.01);
                        cmds.push((t, "scale".into(), "w".into(), format!("{:.0}", (width as f64 * sv).round().max(2.0))));
                        cmds.push((t, "scale".into(), "h".into(), format!("{:.0}", (height as f64 * sv).round().max(2.0))));
                    }
                    c.commands = cmds;
                }
                c
            }
            Effect::Vignette { angle } => {
                // vignette's `a` accepts an expression evaluated per frame.
                let a = if angle.is_animated() { angle.to_expr() } else {
                    let v = angle.first();
                    format!("{:.6}", if v == 0.0 { 0.6 } else { v })
                };
                Compiled::f(format!("vignette=a='{a}'"))
            }
            Effect::ChromaKey { color, similarity, blend } => {
                let mut c = Compiled::f(format!(
                    "chromakey={}:{}:{}",
                    sanitise_color(color), first(similarity), first(blend)
                ));
                c.commands = commands_for(similarity, "chromakey", "similarity", dur, fps);
                c.commands.extend(commands_for(blend, "chromakey", "blend", dur, fps));
                c
            }
            Effect::Text { content, size, color, x, y, font } => {
                let mut f = format!(
                    "drawtext=text='{}':fontsize={:.0}:fontcolor={}:x='{}':y='{}'",
                    escape_drawtext(content), size, sanitise_color(color), expr(x), expr(y)
                );
                if !font.is_empty() {
                    f.push_str(&format!(":fontfile='{}'", escape_drawtext(font)));
                }
                Compiled::f(f)
            }
            Effect::Volume { level } => {
                let animated = level.is_animated();
                let mut f = format!("volume='{}'", expr(level));
                if animated {
                    f.push_str(":eval=frame");
                }
                Compiled::f(f)
            }
            Effect::AudioFade { in_secs, out_secs } => {
                let mut out = Vec::new();
                if *in_secs > 0.0 {
                    out.push(format!("afade=t=in:st=0:d={in_secs:.4}"));
                }
                if *out_secs > 0.0 {
                    let st = (dur - out_secs).max(0.0);
                    out.push(format!("afade=t=out:st={st:.4}:d={out_secs:.4}"));
                }
                Compiled::many(out)
            }
            Effect::Highpass { frequency } => {
                let mut c = Compiled::f(format!("highpass=f={}", first(frequency)));
                c.commands = commands_for(frequency, "highpass", "frequency", dur, fps);
                c
            }
            Effect::Lowpass { frequency } => {
                let mut c = Compiled::f(format!("lowpass=f={}", first(frequency)));
                c.commands = commands_for(frequency, "lowpass", "frequency", dur, fps);
                c
            }
            Effect::Curves { master, red, green, blue } => {
                let fmt = |pts: &Vec<(f64, f64)>| {
                    pts.iter()
                        .map(|(x, y)| format!("{:.4}/{:.4}", x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)))
                        .collect::<Vec<_>>()
                        .join(" ")
                };
                let mut parts = Vec::new();
                if master.len() > 1 { parts.push(format!("master='{}'", fmt(master))); }
                if red.len() > 1 { parts.push(format!("r='{}'", fmt(red))); }
                if green.len() > 1 { parts.push(format!("g='{}'", fmt(green))); }
                if blue.len() > 1 { parts.push(format!("b='{}'", fmt(blue))); }
                if parts.is_empty() {
                    return Compiled::default();
                }
                Compiled::f(format!("curves={}", parts.join(":")))
            }
            Effect::ColorWheels {
                lift_r, lift_g, lift_b, gamma_r, gamma_g, gamma_b, gain_r, gain_g, gain_b,
            } => {
                let mut c = Compiled::f(format!(
                    "colorbalance=rs={}:gs={}:bs={}:rm={}:gm={}:bm={}:rh={}:gh={}:bh={}",
                    first(lift_r), first(lift_g), first(lift_b),
                    first(gamma_r), first(gamma_g), first(gamma_b),
                    first(gain_r), first(gain_g), first(gain_b)
                ));
                for (p, opt) in [
                    (lift_r, "rs"), (lift_g, "gs"), (lift_b, "bs"),
                    (gamma_r, "rm"), (gamma_g, "gm"), (gamma_b, "bm"),
                    (gain_r, "rh"), (gain_g, "gh"), (gain_b, "bh"),
                ] {
                    c.commands.extend(commands_for(p, "colorbalance", opt, dur, fps));
                }
                c
            }
            Effect::Lut3d { path } => {
                // The path reaches a filter string, so it is quoted and the
                // characters ffmpeg treats as syntax are escaped.
                if path.trim().is_empty() {
                    return Compiled::default();
                }
                Compiled::f(format!("lut3d=file='{}'", escape_filter_path(path)))
            }
            Effect::Stabilize { trf, smoothing, zoom } => {
                // Without an analysis file there is nothing to transform by.
                if trf.trim().is_empty() {
                    return Compiled::default();
                }
                Compiled::f(format!(
                    "vidstabtransform=input='{}':smoothing={:.0}:zoom={:.2}:optzoom=1",
                    escape_filter_path(trf),
                    smoothing.clamp(1.0, 100.0),
                    zoom.clamp(-50.0, 50.0)
                ))
            }
            Effect::Loudness { target } => Compiled::f(format!(
                "loudnorm=I={:.1}:TP=-1.5:LRA=11",
                target.clamp(-70.0, -5.0)
            )),
            Effect::Denoise { strength } => {
                let s = strength.clamp(0.0, 30.0);
                if s <= 0.0 {
                    return Compiled::default();
                }
                Compiled::f(format!("hqdn3d={s:.2}:{:.2}:{:.2}:{:.2}", s * 0.75, s * 1.5, s * 1.5))
            }
            Effect::Flip { horizontal, vertical } => {
                let mut out = Vec::new();
                if *horizontal { out.push("hflip".to_string()); }
                if *vertical { out.push("vflip".to_string()); }
                Compiled::many(out)
            }
            Effect::Pixelate { size } => {
                let mut c = Compiled::f(format!("pixelize=w={}:h={}", first(size), first(size)));
                c.commands = commands_for(size, "pixelize", "w", dur, fps);
                c.commands.extend(commands_for(size, "pixelize", "h", dur, fps));
                c
            }
            Effect::Invert => Compiled::f("negate".into()),
            Effect::Monochrome => Compiled::f("colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3".into()),
            Effect::Temperature { kelvin } => {
                let mut c = Compiled::f(format!("colortemperature=temperature={}", first(kelvin)));
                c.commands = commands_for(kelvin, "colortemperature", "temperature", dur, fps);
                c
            }
            Effect::Levels { black, white } => {
                let mut c = Compiled::f(format!(
                    "colorlevels=rimin={b}:gimin={b}:bimin={b}:rimax={w}:gimax={w}:bimax={w}",
                    b = first(black), w = first(white)
                ));
                for (p, opts) in [(black, ["rimin", "gimin", "bimin"]), (white, ["rimax", "gimax", "bimax"])] {
                    for o in opts {
                        c.commands.extend(commands_for(p, "colorlevels", o, dur, fps));
                    }
                }
                c
            }
            Effect::Exposure { stops } => {
                // A stop is a doubling, which `eq` expresses as a multiplier.
                let expr = format!("pow(2,({}))", stops.to_expr());
                Compiled::f(format!("eq=contrast=1:brightness=0:gamma=1:saturation=1,\
colorchannelmixer=rr='{expr}':gg='{expr}':bb='{expr}'"))
            }
            Effect::Grain { strength } => Compiled::f(format!(
                "noise=alls={:.0}:allf=t+u", strength.clamp(0.0, 100.0)
            )),
            Effect::BoxBlur { radius } => {
                let mut c = Compiled::f(format!("boxblur=luma_radius={}:luma_power=1", first(radius)));
                c.commands = commands_for(radius, "boxblur", "luma_radius", dur, fps);
                c
            }
            Effect::MotionBlur { frames } => Compiled::f(format!(
                "tmix=frames={}", (*frames as i64).clamp(2, 32)
            )),
            Effect::EdgeDetect { low, high } => Compiled::many(vec![
                // edgedetect emits gray, which will not convert straight into
                // the alpha-carrying format the compositor needs.
                format!("edgedetect=low={:.3}:high={:.3}", low.clamp(0.0, 1.0), high.clamp(0.0, 1.0)),
                "format=yuv420p".into(),
            ]),
            Effect::Emboss => Compiled::many(vec![
                "format=yuv420p".into(),
                "convolution='-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:0 0 0 0 1 0 0 0 0'".into(),
            ]),
            Effect::Crisp => Compiled::f(
                "convolution='0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 0 0 0 1 0 0 0 0'".into()
            ),
            Effect::Deband => Compiled::f("deband".into()),
            Effect::Deflicker => Compiled::f("deflicker".into()),
            Effect::LensCorrect { k1, k2 } => {
                let mut c = Compiled::f(format!(
                    "lenscorrection=k1={}:k2={}", first(k1), first(k2)
                ));
                c.commands = commands_for(k1, "lenscorrection", "k1", dur, fps);
                c.commands.extend(commands_for(k2, "lenscorrection", "k2", dur, fps));
                c
            }
            Effect::LumaKey { threshold, tolerance } => {
                let mut c = Compiled::many(vec![
                    "format=yuva420p".into(),
                    format!("lumakey=threshold={}:tolerance={}", first(threshold), first(tolerance)),
                ]);
                c.commands = commands_for(threshold, "lumakey", "threshold", dur, fps);
                c.commands.extend(commands_for(tolerance, "lumakey", "tolerance", dur, fps));
                c
            }
            Effect::Despill { colour, amount } => {
                let kind = if colour.eq_ignore_ascii_case("blue") { "blue" } else { "green" };
                let mut c = Compiled::f(format!("despill=type={kind}:mix={}", first(amount)));
                c.commands = commands_for(amount, "despill", "mix", dur, fps);
                c
            }
            Effect::ChromaShift { x, y } => {
                let mut c = Compiled::f(format!(
                    "chromashift=cbh={}:crh={}", first(x), first(y)
                ));
                c.commands = commands_for(x, "chromashift", "cbh", dur, fps);
                c.commands.extend(commands_for(y, "chromashift", "crh", dur, fps));
                c
            }
            Effect::Reframe { aspect } => {
                let a = aspect.clamp(0.2, 5.0);
                // Fit inside the target box, then pad out to it.
                Compiled::many(vec![
                    format!("scale='if(gt(a,{a:.5}),iw,ih*{a:.5})':'if(gt(a,{a:.5}),iw/{a:.5},ih)'"),
                    format!("pad='max(iw,ih*{a:.5})':'max(ih,iw/{a:.5})':(ow-iw)/2:(oh-ih)/2:color=black@0"),
                ])
            }
            Effect::Posterize { levels } => {
                // Quantise each channel into N steps by flooring to a step size.
                let n = first(levels);
                Compiled::f(format!(
                    "lutrgb=r='floor(val/(256/max(2,{n})))*(256/max(2,{n}))':\
g='floor(val/(256/max(2,{n})))*(256/max(2,{n}))':\
b='floor(val/(256/max(2,{n})))*(256/max(2,{n}))'"
                ))
            }

            // ---- audio ----
            Effect::Echo { delay_ms, decay } => Compiled::f(format!(
                "aecho=0.8:0.9:{:.0}:{:.3}", delay_ms.clamp(1.0, 8000.0), decay.clamp(0.0, 1.0)
            )),
            Effect::Chorus { depth } => Compiled::f(format!(
                "chorus=0.7:0.9:55:0.4:0.25:{:.2}", depth.clamp(0.0, 4.0)
            )),
            Effect::Flanger { depth } => Compiled::f(format!(
                "flanger=depth={:.2}", depth.clamp(0.0, 10.0)
            )),
            Effect::PitchShift { ratio } => {
                // rubberband changes pitch without changing length.
                let mut c = Compiled::f(format!("rubberband=pitch={}", first(ratio)));
                c.commands = commands_for(ratio, "rubberband", "pitch", dur, fps);
                c
            }
            Effect::NoiseGate { threshold } => Compiled::f(format!(
                "agate=threshold={:.4}", threshold.clamp(0.0, 1.0)
            )),
            Effect::Compressor { threshold, ratio } => Compiled::f(format!(
                "acompressor=threshold={:.4}:ratio={:.2}",
                threshold.clamp(0.001, 1.0), ratio.clamp(1.0, 20.0)
            )),
            Effect::Limiter { ceiling } => Compiled::f(format!(
                "alimiter=limit={:.4}", ceiling.clamp(0.01, 1.0)
            )),
            Effect::StereoWidth { amount } => {
                let mut c = Compiled::f(format!("extrastereo=m={}", first(amount)));
                c.commands = commands_for(amount, "extrastereo", "m", dur, fps);
                c
            }
            Effect::Mono => Compiled::f("pan=mono|c0=0.5*c0+0.5*c1".into()),
            Effect::SwapChannels => Compiled::f("pan=stereo|c0=c1|c1=c0".into()),
            Effect::TrimSilence { threshold } => Compiled::f(format!(
                "silenceremove=start_periods=1:start_threshold={t:.4}:stop_periods=1:stop_threshold={t:.4}",
                t = threshold.clamp(0.0, 1.0)
            )),
            // ---- added effects: every value is clamped to the range the
            // underlying filter documents, so a wild keyframe cannot produce a
            // graph ffmpeg rejects at render time.
            Effect::Vibrance { intensity } => Compiled::f(format!(
                "vibrance=intensity={:.4}",
                intensity.first().clamp(-2.0, 2.0)
            )),
            Effect::ColorBalance { r, g, b } => Compiled::f(format!(
                "colorbalance=rm={:.4}:gm={:.4}:bm={:.4}",
                r.first().clamp(-1.0, 1.0),
                g.first().clamp(-1.0, 1.0),
                b.first().clamp(-1.0, 1.0)
            )),
            Effect::ChromaticAberration { amount } => {
                let a = amount.first().clamp(-255.0, 255.0).round() as i32;
                Compiled::f(format!("rgbashift=rh={a}:bh={}", -a))
            }
            Effect::Shear { x, y } => Compiled::f(format!(
                "shear=shx={:.4}:shy={:.4}",
                x.first().clamp(-2.0, 2.0),
                y.first().clamp(-2.0, 2.0)
            )),
            Effect::ColorKey { color, similarity, blend } => Compiled::f(format!(
                "colorkey={}:{:.4}:{:.4}",
                sanitise_color(color),
                similarity.first().clamp(0.01, 1.0),
                blend.first().clamp(0.0, 1.0)
            )),
            Effect::HsvKey { hue, sat, val, similarity, blend } => Compiled::f(format!(
                "hsvkey=hue={:.4}:sat={:.4}:val={:.4}:similarity={:.4}:blend={:.4}",
                hue.first(),
                sat.first().clamp(-1.0, 1.0),
                val.first().clamp(-1.0, 1.0),
                similarity.first().clamp(0.01, 1.0),
                blend.first().clamp(0.0, 1.0)
            )),
            Effect::FrameBlend { frames } => Compiled::f(format!(
                "tmix=frames={}",
                (frames.first().round() as i64).clamp(1, 128)
            )),
            Effect::FalseColor { preset } => Compiled::f(format!(
                "pseudocolor=preset={}",
                sanitise_preset(preset)
            )),
            Effect::HistEq { strength } => Compiled::f(format!(
                "histeq=strength={:.4}",
                strength.first().clamp(0.0, 1.0)
            )),
            Effect::AutoLevels { strength } => Compiled::f(format!(
                "normalize=strength={:.4}",
                strength.first().clamp(0.0, 1.0)
            )),
            Effect::Deinterlace { mode } => Compiled::f(format!(
                "yadif=mode={}",
                (mode.round() as i64).clamp(0, 3)
            )),
            Effect::AdaptiveSharpen { strength } => Compiled::f(format!(
                "cas=strength={:.4}",
                strength.first().clamp(0.0, 1.0)
            )),
            Effect::ChromaDenoise { threshold } => Compiled::f(format!(
                "chromanr=thres={:.4}",
                threshold.first().clamp(1.0, 200.0)
            )),
            Effect::HueSaturation { hue, saturation, intensity } => Compiled::f(format!(
                "huesaturation=hue={:.4}:saturation={:.4}:intensity={:.4}",
                hue.first().clamp(-180.0, 180.0),
                saturation.first().clamp(-1.0, 1.0),
                intensity.first().clamp(0.0, 1.0)
            )),
            Effect::Bilateral { sigma_s, sigma_r } => Compiled::f(format!(
                "bilateral=sigmaS={:.4}:sigmaR={:.4}",
                sigma_s.first().clamp(0.0, 512.0),
                sigma_r.first().clamp(0.0, 1.0)
            )),
            Effect::SmartBlur { radius, strength } => Compiled::f(format!(
                "smartblur=luma_radius={:.4}:luma_strength={:.4}",
                radius.first().clamp(0.1, 5.0),
                strength.first().clamp(-1.0, 1.0)
            )),
            Effect::VagueDenoise { threshold } => Compiled::f(format!(
                "vaguedenoiser=threshold={:.4}",
                threshold.first().clamp(0.0, 100.0)
            )),
            Effect::Sepia => Compiled::f(
                "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0".into(),
            ),
            Effect::Scanlines { amount } => {
                // Darken every other row. Chroma is passed through untouched.
                let a = amount.first().clamp(0.0, 1.0);
                Compiled::f(format!(
                    "geq=lum='p(X,Y)*(1-{a:.4}*mod(Y,2))':cb='p(X,Y)':cr='p(X,Y)'"
                ))
            }
            Effect::Mirror => Compiled::f(
                "geq=lum='p(if(lt(X,W/2),X,W-1-X),Y)':\
cb='p(if(lt(X,W/2),X,W-1-X),Y)':cr='p(if(lt(X,W/2),X,W-1-X),Y)'"
                    .into(),
            ),

            // ---- added audio ----
            Effect::Bass { gain, freq } => Compiled::f(format!(
                "bass=g={:.4}:f={:.4}",
                gain.first().clamp(-30.0, 30.0),
                freq.first().clamp(20.0, 2000.0)
            )),
            Effect::Treble { gain, freq } => Compiled::f(format!(
                "treble=g={:.4}:f={:.4}",
                gain.first().clamp(-30.0, 30.0),
                freq.first().clamp(1000.0, 20000.0)
            )),
            Effect::ParametricEq { freq, width, gain } => Compiled::f(format!(
                "equalizer=f={:.4}:width_type=q:w={:.4}:g={:.4}",
                freq.first().clamp(20.0, 20000.0),
                width.first().clamp(0.01, 10.0),
                gain.first().clamp(-30.0, 30.0)
            )),
            Effect::Tremolo { freq, depth } => Compiled::f(format!(
                "tremolo=f={:.4}:d={:.4}",
                freq.first().clamp(0.1, 20000.0),
                depth.first().clamp(0.0, 1.0)
            )),
            Effect::Vibrato { freq, depth } => Compiled::f(format!(
                "vibrato=f={:.4}:d={:.4}",
                freq.first().clamp(0.1, 20000.0),
                depth.first().clamp(0.0, 1.0)
            )),
            Effect::BitCrush { bits, mix } => Compiled::f(format!(
                "acrusher=bits={:.4}:mix={:.4}",
                bits.first().clamp(1.0, 64.0),
                mix.first().clamp(0.0, 1.0)
            )),
            Effect::Exciter { amount } => Compiled::f(format!(
                "aexciter=amount={:.4}",
                amount.first().clamp(0.0, 64.0)
            )),
            Effect::SubBoost { amount } => Compiled::f(format!(
                "asubboost=wet={:.4}",
                amount.first().clamp(0.0, 1.0)
            )),
            Effect::SpeechNorm { expansion } => Compiled::f(format!(
                "speechnorm=e={:.4}",
                expansion.first().clamp(1.0, 50.0)
            )),
            Effect::AudioDenoise { reduction } => Compiled::f(format!(
                "afftdn=nr={:.4}",
                reduction.first().clamp(0.01, 97.0)
            )),

            Effect::Frei0r { name, params } => {
                let plugin = sanitise_plugin(name);
                if plugin.is_empty() {
                    return Compiled::default();
                }
                let animated = params.iter().any(Param::is_animated);
                if !animated {
                    let joined: Vec<String> =
                        params.iter().map(|p| format!("{:.6}", p.first())).collect();
                    return Compiled::f(frei0r_filter(&plugin, &joined));
                }
                // frei0r's filter_params is a static string, so animate by
                // stacking one gated instance per sampled slice.
                let times = sample_times(dur, fps);
                let mut out = Vec::new();
                for (i, t) in times.iter().enumerate() {
                    let next = times.get(i + 1).copied().unwrap_or(dur + 1.0);
                    let joined: Vec<String> =
                        params.iter().map(|p| format!("{:.6}", p.value_at(*t))).collect();
                    out.push(format!(
                        "{}:enable='between(t,{:.4},{:.4})'",
                        frei0r_filter(&plugin, &joined), t, next
                    ));
                }
                Compiled::many(out)
            }
        }
    }
}

/// Centre the scaled image, then offset it. Written as an expression so a
/// keyframed pan animates without a command stream.
fn expr_offset(p: &Param, full: f64, scale: &Param, horizontal: bool) -> String {
    let _ = horizontal;
    let s = scale.first().max(0.01);
    let scaled = full * s;
    format!("({:.4})+({})", (full - scaled) / 2.0, p.to_expr())
}

fn frei0r_filter(plugin: &str, params: &[String]) -> String {
    if params.is_empty() {
        format!("frei0r=filter_name={plugin}")
    } else {
        format!(
            "frei0r=filter_name={plugin}:filter_params={}",
            params.join("|")
        )
    }
}

/// Paths reach ffmpeg filter strings, where backslash, colon, quote and comma
/// are syntax. Escaping them keeps a LUT in a directory with a colon in its
/// name from tearing the graph apart.
fn escape_filter_path(p: &str) -> String {
    p.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:")
        .replace(',', "\\,")
}

/// Plugin names are interpolated into a filter string, so allow only the
/// characters frei0r plugin filenames actually use.
/// `pseudocolor` preset names are a closed set; anything else falls back to a
/// known-good one rather than being pasted into the graph.
fn sanitise_preset(name: &str) -> String {
    const PRESETS: [&str; 13] = [
        "magma",
        "inferno",
        "plasma",
        "viridis",
        "turbo",
        "cividis",
        "range1",
        "range2",
        "shadows",
        "highlights",
        "solar",
        "nominal",
        "preferred",
    ];
    if PRESETS.contains(&name) {
        name.to_string()
    } else {
        "magma".into()
    }
}

fn sanitise_plugin(name: &str) -> String {
    if name.is_empty() || name.len() > 64 {
        return String::new();
    }
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        name.to_string()
    } else {
        String::new()
    }
}

/// Colours reach an ffmpeg filter string, so restrict them to names and hex.
fn sanitise_color(c: &str) -> String {
    let ok = c
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '#' || ch == '@' || ch == '.');
    if ok && !c.is_empty() {
        c.to_string()
    } else {
        "black".to_string()
    }
}

/// drawtext parses its own mini-language; these characters must not leak.
fn escape_drawtext(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\u{2019}")
        .replace(':', "\\:")
        .replace('%', "\\%")
        .replace('\n', "\\n")
}

// ------------------------------------------------------------------- clips

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Source {
    /// A media file on disk.
    Media { path: String },
    /// A generated title card.
    Title {
        text: String,
        #[serde(default = "d_black")]
        background: String,
        #[serde(default = "d_size")]
        size: f64,
        #[serde(default = "d_white")]
        color: String,
    },
    /// A solid colour card, useful for gaps, flashes and backgrounds.
    Color { color: String },
    /// A still image held for the clip's duration. This is how a freeze frame
    /// reaches the timeline: a frame is extracted to a file and placed as one.
    Still { path: String },
    /// An adjustment layer. It paints nothing; its effects are applied to
    /// whatever is already composited beneath it, for the span it covers.
    Adjustment,
    /// Another timeline used as a clip. It is rendered to a cached file first
    /// and then behaves like media, which keeps one filter graph flat rather
    /// than nesting graphs inside graphs.
    Nested { name: String, project: Box<Project> },
}

fn d_black() -> String {
    "black".into()
}

/// Intrinsic clip motion, the way Premiere gives every clip a Motion section.
///
/// These are not effects you add; every clip has them. Position is an offset
/// from centre in project pixels, scale is a percentage, rotation is degrees
/// about the anchor, and opacity is 0..1. All of them keyframe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Motion {
    #[serde(default = "p_zero")]
    pub x: Param,
    #[serde(default = "p_zero")]
    pub y: Param,
    #[serde(default = "p_hundred")]
    pub scale: Param,
    #[serde(default = "p_zero")]
    pub rotation: Param,
    /// Anchor offset from the clip's centre, in project pixels. Rotation and
    /// scale happen about this point.
    #[serde(default = "p_zero")]
    pub anchor_x: Param,
    #[serde(default = "p_zero")]
    pub anchor_y: Param,
    #[serde(default = "p_one")]
    pub opacity: Param,
}

impl Default for Motion {
    fn default() -> Self {
        Motion {
            x: p_zero(),
            y: p_zero(),
            scale: p_hundred(),
            rotation: p_zero(),
            anchor_x: p_zero(),
            anchor_y: p_zero(),
            opacity: p_one(),
        }
    }
}

impl Motion {
    /// True when nothing has been moved, so the renderer can skip the work.
    pub fn is_identity(&self) -> bool {
        !self.x.is_animated()
            && self.x.first() == 0.0
            && !self.y.is_animated()
            && self.y.first() == 0.0
            && !self.scale.is_animated()
            && (self.scale.first() - 100.0).abs() < 1e-9
            && !self.rotation.is_animated()
            && self.rotation.first() == 0.0
            && !self.anchor_x.is_animated()
            && self.anchor_x.first() == 0.0
            && !self.anchor_y.is_animated()
            && self.anchor_y.first() == 0.0
            && !self.opacity.is_animated()
            && (self.opacity.first() - 1.0).abs() < 1e-9
    }
}

/// How a clip combines with what is beneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Addition,
    Subtract,
    LinearLight,
    PinLight,
    VividLight,
    HardMix,
    Divide,
    Glow,
    Reflect,
    Freeze,
    Heat,
    Negation,
    Phoenix,
    GrainMerge,
}

impl BlendMode {
    /// The name ffmpeg's `blend` filter uses.
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::ColorDodge => "dodge",
            BlendMode::ColorBurn => "burn",
            BlendMode::HardLight => "hardlight",
            BlendMode::SoftLight => "softlight",
            BlendMode::Difference => "difference",
            BlendMode::Exclusion => "exclusion",
            BlendMode::Addition => "addition",
            BlendMode::Subtract => "subtract",
            BlendMode::LinearLight => "linearlight",
            BlendMode::PinLight => "pinlight",
            BlendMode::VividLight => "vividlight",
            BlendMode::HardMix => "hardmix",
            BlendMode::Divide => "divide",
            BlendMode::Glow => "glow",
            BlendMode::Reflect => "reflect",
            BlendMode::Freeze => "freeze",
            BlendMode::Heat => "heat",
            BlendMode::Negation => "negation",
            BlendMode::Phoenix => "phoenix",
            BlendMode::GrainMerge => "grainmerge",
        }
    }
}

fn p_two() -> Param {
    Param::Static(2.0)
}
fn p_half() -> Param {
    Param::Static(0.5)
}
fn p_three() -> Param {
    Param::Static(3.0)
}
fn p_thousand() -> Param {
    Param::Static(1000.0)
}
fn d_preset_magma() -> String {
    "magma".into()
}
fn d_yadif_mode() -> f64 {
    0.0
}
fn p_hundred() -> Param {
    Param::Static(100.0)
}

impl Motion {
    /// Filters applied to the clip layer itself: scale, rotation and opacity.
    /// Position is NOT here; it is carried by the overlay that composites this
    /// layer, because overlay's x/y accept expressions in `t` and so animate
    /// per frame for free.
    fn compile(&self, dur: f64, fps: u32) -> Compiled {
        let mut c = Compiled::default();

        let scale_animated = self.scale.is_animated();
        if scale_animated || (self.scale.first() - 100.0).abs() > 1e-9 {
            let s = self.scale.to_expr();
            c.filters.push(format!(
                "scale=w='max(2,round(iw*({s})/100))':h='max(2,round(ih*({s})/100))':eval=frame"
            ));
        }

        let rot_animated = self.rotation.is_animated();
        if rot_animated || self.rotation.first() != 0.0 {
            let r = self.rotation.to_expr();
            // Grow the output box so corners are not clipped as it turns.
            c.filters.push(format!(
                "rotate='({r})*PI/180':ow='rotw(({r})*PI/180)':oh='roth(({r})*PI/180)':c=none"
            ));
        }

        let op_animated = self.opacity.is_animated();
        if op_animated || (self.opacity.first() - 1.0).abs() > 1e-9 {
            c.filters.push("format=yuva420p".into());
            c.filters.push(format!(
                "colorchannelmixer=aa={:.6}",
                self.opacity.first().clamp(0.0, 1.0)
            ));
            c.commands = commands_for(&self.opacity, "colorchannelmixer", "aa", dur, fps);
        }
        c
    }

    /// The overlay x/y expressions that place this layer on the canvas.
    ///
    /// Anchor is applied exactly: rotating about a point offset from centre is
    /// the same as rotating about centre and then translating by the anchor
    /// minus its own rotated position.
    fn overlay_position(&self) -> (String, String) {
        let x = self.x.to_expr();
        let y = self.y.to_expr();
        let ax = self.anchor_x.to_expr();
        let ay = self.anchor_y.to_expr();
        let r = format!("(({})*PI/180)", self.rotation.to_expr());

        let anchor_dx = format!("(({ax})-(({ax})*cos({r})-({ay})*sin({r})))");
        let anchor_dy = format!("(({ay})-(({ax})*sin({r})+({ay})*cos({r})))");

        (
            format!("(main_w-overlay_w)/2+({x})+{anchor_dx}"),
            format!("(main_h-overlay_h)/2+({y})+{anchor_dy}"),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionKind {
    /// The incoming clip fades up over whatever is beneath it.
    Dissolve,
    /// Fade down to the project background, then up again.
    DipToBlack,
    /// The incoming clip wipes in from the left.
    WipeLeft,
    WipeRight,
    WipeUp,
    WipeDown,
    DipToWhite,
    IrisOpen,
    IrisClose,
    BarnDoorOpen,
    BarnDoorClose,
    ClockWipe,
    SlideLeft,
    SlideRight,
    SlideUp,
    SlideDown,
    PixelDissolve,
    DiagonalWipe,
}

/// A transition at the head of a clip. Because clips composite by overlay, a
/// dissolve is simply the incoming clip's alpha rising while the outgoing one
/// still plays beneath it, so overlapping clips cross-fade naturally.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub kind: TransitionKind,
    #[serde(default = "d_transition")]
    pub duration: f64,
}

fn d_transition() -> f64 {
    0.5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub source: Source,
    /// Position on the timeline, in seconds.
    #[serde(default)]
    pub start: f64,
    /// Seconds into the source. Ignored for generated sources.
    #[serde(default)]
    pub in_point: f64,
    pub out_point: f64,
    /// Playback rate. 2.0 is double speed, 0.5 is half. Keyframe it to ramp —
    /// a curve here is time remapping, rendered as piecewise-constant segments.
    #[serde(default = "p_one")]
    pub speed: Param,
    #[serde(default)]
    pub reverse: bool,
    /// Which source audio channels this clip uses. Empty means all of them.
    /// A two-channel source recorded with a lav on the left and a room mic on
    /// the right is the case this exists for.
    #[serde(default)]
    pub channels: Vec<u32>,
    /// Keep the original pitch when the speed changes. Off means a sped-up
    /// clip rises in pitch, which is occasionally what you want.
    #[serde(default = "yes")]
    pub preserve_pitch: bool,
    #[serde(default = "one_f")]
    pub gain: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Every clip has motion, whether or not it has been touched.
    #[serde(default)]
    pub motion: Motion,
    #[serde(default)]
    pub blend: BlendMode,
    #[serde(default)]
    pub transition_in: Option<Transition>,
}

fn one_f() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}

/// One constant-speed span of a clip. A clip with a static speed has exactly
/// one; a keyframed (remapped) clip has many.
#[derive(Debug, Clone, Copy)]
pub struct Segment {
    /// Bounds within the source, in source seconds.
    pub src_start: f64,
    pub src_end: f64,
    pub speed: f64,
    /// Offset from the clip's start, in timeline seconds.
    pub out_offset: f64,
    /// Length on the timeline.
    pub out_len: f64,
}

/// How finely a speed ramp is cut into constant-speed pieces.
const SPEED_SEGMENTS_PER_SECOND: f64 = 8.0;
const MAX_SPEED_SEGMENTS: usize = 240;

impl Clip {
    /// Duration of the source material used, before speed is applied.
    pub fn source_duration(&self) -> f64 {
        (self.out_point - self.in_point).max(0.0)
    }

    fn speed_at(&self, src_offset: f64) -> f64 {
        let v = self.speed.value_at(src_offset).abs();
        if v < 0.01 {
            0.01
        } else {
            v
        }
    }

    /// Cut the clip into constant-speed segments. Speed keyframes are indexed
    /// by offset within the source material, so a ramp reads the same however
    /// the clip is later moved on the timeline.
    pub fn segments(&self) -> Vec<Segment> {
        let src_len = self.source_duration();
        if src_len <= 0.0 {
            return Vec::new();
        }
        if !self.speed.is_animated() {
            let v = self.speed_at(0.0);
            return vec![Segment {
                src_start: self.in_point,
                src_end: self.out_point,
                speed: v,
                out_offset: 0.0,
                out_len: src_len / v,
            }];
        }

        let n =
            ((src_len * SPEED_SEGMENTS_PER_SECOND).ceil() as usize).clamp(2, MAX_SPEED_SEGMENTS);
        let step = src_len / n as f64;
        let mut out = Vec::with_capacity(n);
        let mut cursor = 0.0;
        for i in 0..n {
            let a = i as f64 * step;
            let b = a + step;
            // Constant speed per segment, taken at its midpoint.
            let v = self.speed_at((a + b) / 2.0);
            let len = (b - a) / v;
            out.push(Segment {
                src_start: self.in_point + a,
                src_end: self.in_point + b,
                speed: v,
                out_offset: cursor,
                out_len: len,
            });
            cursor += len;
        }
        out
    }

    /// Duration occupied on the timeline, after speed.
    pub fn duration(&self) -> f64 {
        if !self.speed.is_animated() {
            return self.source_duration() / self.speed_at(0.0);
        }
        self.segments().iter().map(|s| s.out_len).sum()
    }

    pub fn end(&self) -> f64 {
        self.start + self.duration()
    }

    /// Where in the source a clip-local output time lands, honouring ramps.
    pub fn source_time_at(&self, local_out: f64) -> f64 {
        let segs = self.segments();
        if segs.is_empty() {
            return self.in_point;
        }
        for seg in &segs {
            if local_out < seg.out_offset + seg.out_len {
                return seg.src_start + (local_out - seg.out_offset) * seg.speed;
            }
        }
        segs[segs.len() - 1].src_end
    }

    pub fn is_generated(&self) -> bool {
        !matches!(self.source, Source::Media { .. } | Source::Still { .. })
    }

    pub fn is_adjustment(&self) -> bool {
        matches!(self.source, Source::Adjustment)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    #[serde(default = "d_track_name")]
    pub name: String,
    pub kind: TrackKind,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub locked: bool,
    /// When any track is soloed, every track that is not soloed goes silent.
    #[serde(default)]
    pub solo: bool,
    #[serde(default = "one_f")]
    pub volume: f64,
    /// Track-level opacity, multiplied into every clip on it.
    #[serde(default = "one_f")]
    pub opacity: f64,
    /// Track-level blend, used when a clip is set to Normal.
    #[serde(default)]
    pub blend: BlendMode,
    /// Which track an insert lands on. Premiere calls this patching.
    #[serde(default)]
    pub targeted: bool,
    /// Duck this track under another one: when the keyed track has sound, this
    /// track drops. Holds the id of the track that does the ducking.
    #[serde(default)]
    pub duck_under: Option<String>,
    /// How loud the key has to be before ducking starts, 0..1.
    #[serde(default = "d_duck_threshold")]
    pub duck_threshold: f64,
    /// How hard the duck pulls once it starts.
    #[serde(default = "d_duck_ratio")]
    pub duck_ratio: f64,
    /// Milliseconds to duck down, and to come back up.
    #[serde(default = "d_duck_attack")]
    pub duck_attack: f64,
    #[serde(default = "d_duck_release")]
    pub duck_release: f64,
}

fn d_duck_threshold() -> f64 {
    0.05
}
fn d_duck_ratio() -> f64 {
    8.0
}
fn d_duck_attack() -> f64 {
    20.0
}
fn d_duck_release() -> f64 {
    300.0
}

fn d_track_name() -> String {
    "Track".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum SubtitleMode {
    /// No subtitles in the output.
    #[default]
    Off,
    /// Drawn into the picture. Universal, but permanent.
    Burn,
    /// A selectable track the viewer can switch off. Container-dependent.
    Embed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subtitle {
    pub id: String,
    /// Absolute timeline seconds.
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// An entry in the project bin: media the project knows about, whether or not
/// it is currently on the timeline. This is what makes a project a project
/// rather than just a timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinItem {
    pub id: String,
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub has_audio: bool,
    /// A low-resolution stand-in used for preview only, never for export.
    #[serde(default)]
    pub proxy: Option<String>,
    /// Bin folder this item sits in. Empty means the root.
    #[serde(default)]
    pub folder: String,
    /// A colour label, as Premiere's bin labels work.
    #[serde(default)]
    pub label: String,
}

/// A named point on the timeline. Markers are navigation and communication,
/// not edits, so they never affect a render.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    pub time: f64,
    #[serde(default)]
    pub name: String,
    #[serde(default = "d_marker_colour")]
    pub colour: String,
}

fn d_marker_colour() -> String {
    "#2C5FC9".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    /// The work area, as Premiere calls it: an in and out point used for
    /// rendering or previewing part of the timeline.
    #[serde(default)]
    pub zone_in: Option<f64>,
    #[serde(default)]
    pub zone_out: Option<f64>,
    /// Media known to the project, independent of what is on the timeline.
    #[serde(default)]
    pub bin: Vec<BinItem>,
    #[serde(default)]
    pub subtitles: Vec<Subtitle>,
    #[serde(default)]
    pub subtitle_mode: SubtitleMode,
    #[serde(default = "d_sub_size")]
    pub subtitle_size: f64,
    #[serde(default = "d_w")]
    pub width: u32,
    #[serde(default = "d_h")]
    pub height: u32,
    #[serde(default = "d_fps")]
    pub fps: u32,
    #[serde(default = "d_rate")]
    pub sample_rate: u32,
    #[serde(default = "d_bg")]
    pub background: String,
}

fn d_sub_size() -> f64 {
    42.0
}
fn d_w() -> u32 {
    1920
}
fn d_h() -> u32 {
    1080
}
fn d_fps() -> u32 {
    30
}
fn d_rate() -> u32 {
    48000
}
fn d_bg() -> String {
    "black".into()
}

impl Default for Project {
    fn default() -> Self {
        Project {
            tracks: Vec::new(),
            markers: Vec::new(),
            zone_in: None,
            zone_out: None,
            bin: Vec::new(),
            subtitles: Vec::new(),
            subtitle_mode: SubtitleMode::Off,
            subtitle_size: 42.0,
            width: 1920,
            height: 1080,
            fps: 30,
            sample_rate: 48000,
            background: "black".into(),
        }
    }
}

impl Project {
    /// The timeline runs until the last clip on any track ends.
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.end())
            .fold(0.0, f64::max)
    }

    pub fn clip_count(&self) -> usize {
        self.tracks.iter().map(|t| t.clips.len()).sum()
    }

    fn validate(&self) -> Result<()> {
        if self.clip_count() == 0 {
            return Err(Error::Empty);
        }
        if self.width == 0 || self.height == 0 || self.fps == 0 {
            return Err(Error::Invalid(
                "frame size and rate must be non-zero".into(),
            ));
        }
        if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
            return Err(Error::Invalid(
                "H.264 requires even frame dimensions".into(),
            ));
        }
        for track in &self.tracks {
            for clip in &track.clips {
                if clip.source_duration() <= 0.0 {
                    return Err(Error::Invalid(format!(
                        "clip {} has no duration — its out point must be after its in point",
                        clip.id
                    )));
                }
                if clip.in_point < 0.0 || clip.start < 0.0 {
                    return Err(Error::Invalid(format!(
                        "clip {} has a negative position",
                        clip.id
                    )));
                }
                let slowest = if clip.speed.is_animated() {
                    clip.segments()
                        .iter()
                        .map(|s| s.speed)
                        .fold(f64::MAX, f64::min)
                } else {
                    clip.speed.first().abs()
                };
                if slowest < 0.01 {
                    return Err(Error::Invalid(format!(
                        "clip {} has a speed too close to zero to render",
                        clip.id
                    )));
                }
            }
        }
        Ok(())
    }
}

// ------------------------------------------------------------ render profile

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderProfile {
    pub id: String,
    pub label: String,
    pub container: String,
    pub video_codec: String,
    pub audio_codec: String,
    /// CRF for x264/x265, ignored when a bitrate is set.
    #[serde(default)]
    pub crf: Option<u32>,
    #[serde(default)]
    pub video_bitrate: Option<String>,
    #[serde(default = "d_abr")]
    pub audio_bitrate: String,
    #[serde(default = "d_preset")]
    pub preset: String,
}

fn d_abr() -> String {
    "192k".into()
}
fn d_preset() -> String {
    "medium".into()
}

/// One installed frei0r plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frei0rPlugin {
    pub name: String,
    /// A readable name derived from the plugin filename.
    pub label: String,
}

/// Enumerate installed frei0r plugins. These are shared libraries on disk, so
/// the list is whatever the machine actually has — the same source Kdenlive
/// draws its effect library from.
pub fn frei0r_plugins() -> Vec<Frei0rPlugin> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/usr/lib/frei0r-1"),
        PathBuf::from("/usr/lib64/frei0r-1"),
        PathBuf::from("/usr/local/lib/frei0r-1"),
        PathBuf::from("/usr/local/lib64/frei0r-1"),
    ];
    if let Ok(env_path) = std::env::var("FREI0R_PATH") {
        for part in env_path.split(':').filter(|p| !p.is_empty()) {
            dirs.push(PathBuf::from(part));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".frei0r-1/lib"));
    }

    let mut seen = std::collections::BTreeMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("so") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let name = sanitise_plugin(stem);
            if name.is_empty() {
                continue;
            }
            seen.entry(name.clone()).or_insert_with(|| Frei0rPlugin {
                label: humanise(&name),
                name,
            });
        }
    }
    seen.into_values().collect()
}

/// "alpha0ps_alphagrad" -> "Alpha0ps alphagrad"
fn humanise(name: &str) -> String {
    let spaced = name.replace(['_', '-'], " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Encoders this ffmpeg can actually use. Offering a profile the machine
/// cannot run is worse than not offering it, so the list is probed rather
/// than assumed.
pub fn hardware_encoders() -> Vec<String> {
    let Ok(out) = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    [
        "h264_nvenc",
        "h264_vaapi",
        "h264_qsv",
        "hevc_nvenc",
        "hevc_vaapi",
    ]
    .into_iter()
    .filter(|e| text.contains(e))
    .map(str::to_string)
    .collect()
}

/// Render profiles that use the GPU, appended only when the encoder exists.
pub fn hardware_profiles() -> Vec<RenderProfile> {
    hardware_encoders()
        .into_iter()
        .map(|enc| {
            let label = match enc.as_str() {
                "h264_nvenc" => "MP4 · H.264 · NVIDIA GPU",
                "h264_vaapi" => "MP4 · H.264 · VAAPI GPU",
                "h264_qsv" => "MP4 · H.264 · Intel Quick Sync",
                "hevc_nvenc" => "MP4 · H.265 · NVIDIA GPU",
                _ => "MP4 · H.265 · VAAPI GPU",
            };
            RenderProfile {
                id: format!("hw-{enc}"),
                label: label.into(),
                container: "mp4".into(),
                video_codec: enc,
                audio_codec: "aac".into(),
                crf: None,
                // Hardware encoders take a bitrate, not a CRF.
                video_bitrate: Some("12M".into()),
                audio_bitrate: "192k".into(),
                preset: "medium".into(),
            }
        })
        .collect()
}

/// Analyse a clip's motion for stabilisation. This is the first of vidstab's
/// two passes; the file it writes is what `Effect::Stabilize` transforms by.
pub fn analyse_stabilisation(source: &str, cache_dir: &Path) -> Result<String> {
    let src = canonical_source(source)?;
    std::fs::create_dir_all(cache_dir)?;

    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    src.to_string_lossy().hash(&mut h);
    if let Ok(meta) = std::fs::metadata(&src) {
        meta.len().hash(&mut h);
    }
    let trf = cache_dir.join(format!("{:016x}.trf", h.finish()));

    if trf.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(trf.to_string_lossy().to_string());
    }

    let out = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-v", "error", "-i"])
        .arg(&src)
        .args([
            "-vf",
            &format!(
                "vidstabdetect=result='{}':shakiness=5:accuracy=15",
                escape_filter_path(&trf.to_string_lossy())
            ),
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NoFfmpeg
            } else {
                Error::Io(e)
            }
        })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.trim().lines().rev().take(5).collect();
        let msg: Vec<&str> = tail.into_iter().rev().collect();
        return Err(Error::Render(msg.join("\n")));
    }
    Ok(trf.to_string_lossy().to_string())
}

/// Extract one frame to a PNG so it can be placed as a freeze frame.
pub fn freeze_frame(source: &str, at: f64, cache_dir: &Path) -> Result<String> {
    let src = canonical_source(source)?;
    std::fs::create_dir_all(cache_dir)?;
    let name = format!("freeze-{}.png", uuid::Uuid::new_v4());
    let path = cache_dir.join(name);

    let status = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-v", "error", "-ss"])
        .arg(format!("{:.4}", at.max(0.0)))
        .arg("-i")
        .arg(&src)
        .args(["-frames:v", "1"])
        .arg(&path)
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NoFfmpeg
            } else {
                Error::Io(e)
            }
        })?;

    if !status.success() {
        return Err(Error::Render(
            "could not extract a frame at that position".into(),
        ));
    }
    Ok(path.to_string_lossy().to_string())
}

/// Render only the span between `start` and `end`, at full export quality.
/// This is Premiere's render-the-zone, and it reuses the same slicing the
/// preview cache uses.
pub fn render_zone(
    project: &Project,
    profile: &RenderProfile,
    output: &Path,
    start: f64,
    end: f64,
) -> Result<String> {
    if end <= start {
        return Err(Error::Invalid("the export zone is empty".into()));
    }
    let sliced = slice(project, start, end);
    if sliced.clip_count() == 0 {
        return Err(Error::Invalid(
            "nothing on the timeline in that zone".into(),
        ));
    }
    render(&sliced, profile, output)
}

pub fn render_profiles() -> Vec<RenderProfile> {
    vec![
        RenderProfile {
            id: "mp4-h264".into(),
            label: "MP4 · H.264 · high quality".into(),
            container: "mp4".into(),
            video_codec: "libx264".into(),
            audio_codec: "aac".into(),
            crf: Some(18),
            video_bitrate: None,
            audio_bitrate: "192k".into(),
            preset: "slow".into(),
        },
        RenderProfile {
            id: "mp4-h264-fast".into(),
            label: "MP4 · H.264 · fast draft".into(),
            container: "mp4".into(),
            video_codec: "libx264".into(),
            audio_codec: "aac".into(),
            crf: Some(26),
            video_bitrate: None,
            audio_bitrate: "128k".into(),
            preset: "veryfast".into(),
        },
        RenderProfile {
            id: "mp4-h265".into(),
            label: "MP4 · H.265 · smaller file".into(),
            container: "mp4".into(),
            video_codec: "libx265".into(),
            audio_codec: "aac".into(),
            crf: Some(24),
            video_bitrate: None,
            audio_bitrate: "192k".into(),
            preset: "medium".into(),
        },
        RenderProfile {
            id: "webm-vp9".into(),
            label: "WebM · VP9 · for the web".into(),
            container: "webm".into(),
            video_codec: "libvpx-vp9".into(),
            audio_codec: "libopus".into(),
            crf: Some(31),
            video_bitrate: None,
            audio_bitrate: "128k".into(),
            preset: "good".into(),
        },
        RenderProfile {
            id: "mov-prores".into(),
            label: "MOV · ProRes 422 · for editing on".into(),
            container: "mov".into(),
            video_codec: "prores_ks".into(),
            audio_codec: "pcm_s16le".into(),
            crf: None,
            video_bitrate: None,
            audio_bitrate: "1536k".into(),
            preset: "medium".into(),
        },
        RenderProfile {
            id: "mp3-audio".into(),
            label: "MP3 · audio only".into(),
            container: "mp3".into(),
            video_codec: "none".into(),
            audio_codec: "libmp3lame".into(),
            crf: None,
            video_bitrate: None,
            audio_bitrate: "320k".into(),
            preset: "medium".into(),
        },
    ]
}

// ----------------------------------------------------------------- building

/// Whether a file carries an audio stream, memoised.
///
/// The graph references `[N:a]` for every media input, and a file with no
/// audio makes ffmpeg reject the whole description with "Stream specifier ':a'
/// in filtergraph description". Plenty of real footage has no audio: screen
/// recordings, exports, most B-roll. Probing is a subprocess, so the answer is
/// cached against the path and its modification time.
fn source_has_audio(path: &Path) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    let stamp = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}:{stamp}", path.to_string_lossy());

    if let Ok(map) = cache.lock() {
        if let Some(found) = map.get(&key) {
            return *found;
        }
    }

    let has = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);

    if let Ok(mut map) = cache.lock() {
        map.insert(key, has);
    }
    has
}

fn canonical_source(path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    let c = p
        .canonicalize()
        .map_err(|_| Error::MissingSource(path.to_string()))?;
    if !c.is_file() {
        return Err(Error::MissingSource(path.to_string()));
    }
    Ok(c)
}

/// One decoded input, plus where it came from.
struct Input {
    args: Vec<String>,
    /// Index into the ffmpeg input list.
    index: usize,
    has_audio: bool,
}

fn build_input(clip: &Clip, project: &Project, index: usize, src_len: f64) -> Result<Input> {
    let dur = src_len;
    match &clip.source {
        Source::Media { path } => {
            let src = canonical_source(path)?;
            let has_audio = source_has_audio(&src);
            Ok(Input {
                args: vec!["-i".into(), src.to_string_lossy().to_string()],
                index,
                has_audio,
            })
        }
        Source::Color { color } => Ok(Input {
            args: vec![
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "color=c={}:s={}x{}:r={}:d={:.4}",
                    sanitise_color(color),
                    project.width,
                    project.height,
                    project.fps,
                    dur
                ),
            ],
            index,
            has_audio: false,
        }),
        // A nested sequence is flattened to media before rendering, so one
        // reaching this point is a bug rather than a case to handle.
        Source::Nested { name, .. } => Err(Error::Invalid(format!(
            "nested sequence '{name}' was not flattened before rendering"
        ))),
        Source::Still { path } => {
            let src = canonical_source(path)?;
            Ok(Input {
                args: vec![
                    "-loop".into(),
                    "1".into(),
                    "-framerate".into(),
                    project.fps.to_string(),
                    "-t".into(),
                    format!("{dur:.4}"),
                    "-i".into(),
                    src.to_string_lossy().to_string(),
                ],
                index,
                has_audio: false,
            })
        }
        // An adjustment layer is not decoded; it is a compositing instruction.
        Source::Adjustment => Ok(Input {
            args: vec![
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "color=c=black@0:s=2x2:r={}:d={:.4}",
                    project.fps,
                    dur.max(0.04)
                ),
            ],
            index,
            has_audio: false,
        }),
        Source::Title { background, .. } => Ok(Input {
            args: vec![
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "color=c={}:s={}x{}:r={}:d={:.4}",
                    sanitise_color(background),
                    project.width,
                    project.height,
                    project.fps,
                    dur
                ),
            ],
            index,
            has_audio: false,
        }),
    }
}

/// Compile the whole project into an ffmpeg argument vector.
pub fn render_args(
    project: &Project,
    profile: &RenderProfile,
    output: &Path,
    srt: Option<&Path>,
) -> Result<Vec<String>> {
    project.validate()?;
    // Transitions are resolved into real overlaps before anything is built, so
    // the compositor never needs to know they exist.
    let overlapped = apply_transitions(project);
    let project = &overlapped;

    // Rendering onto one of our own sources would destroy the footage, and
    // ffmpeg's own message for it is unhelpfully indirect.
    for track in &project.tracks {
        for clip in &track.clips {
            if let Source::Media { path } = &clip.source {
                if let Ok(src) = canonical_source(path) {
                    let same = output
                        .canonicalize()
                        .map(|o| o == src)
                        .unwrap_or_else(|_| output == src.as_path());
                    if same {
                        return Err(Error::Invalid(format!(
                            "the output file is also a source clip ({}). Choose a different name.",
                            src.file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| src.to_string_lossy().to_string())
                        )));
                    }
                }
            }
        }
    }

    let total = project.duration();
    let wants_video = profile.video_codec != "none";
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
    let mut filters: Vec<String> = Vec::new();
    enum Composite {
        /// A picture laid on top of what is beneath it.
        Layer {
            label: String,
            start: f64,
            end: f64,
            pos: (String, String),
            blend: BlendMode,
        },
        /// An adjustment layer: filters applied to the composite so far, for
        /// the span it covers.
        Adjust {
            filters: Vec<String>,
            commands: Vec<(f64, String, String, String)>,
            start: f64,
            end: f64,
        },
    }
    let mut video_labels: Vec<Composite> = Vec::new(); // label, start, end
    let mut audio_labels: Vec<String> = Vec::new();
    let mut audio_owner: Vec<(String, String)> = Vec::new();

    // One input per constant-speed segment. A clip with a static speed has a
    // single segment; a remapped clip has many, each rendered independently and
    // laid back down end to end.
    struct Piece<'a> {
        input: Input,
        clip: &'a Clip,
        track: &'a Track,
        seg: Segment,
    }

    let mut pieces: Vec<Piece> = Vec::new();
    let mut index = 0usize;
    for track in &project.tracks {
        for clip in &track.clips {
            for seg in clip.segments() {
                let input = build_input(clip, project, index, seg.src_end - seg.src_start)?;
                index += 1;
                pieces.push(Piece {
                    input,
                    clip,
                    track,
                    seg,
                });
            }
        }
    }
    for p in &pieces {
        args.extend(p.input.args.iter().cloned());
    }

    for p in &pieces {
        let i = p.input.index;
        let clip = p.clip;
        let track = p.track;
        let seg = p.seg;
        let clip_dur = clip.duration();
        let seg_start = clip.start + seg.out_offset;
        let is_video_track = track.kind == TrackKind::Video;

        // ---- adjustment layer: no picture, only a change to what is below ----
        if is_video_track && !track.hidden && wants_video && clip.is_adjustment() {
            let mut filters: Vec<String> = Vec::new();
            let mut commands: Vec<(f64, String, String, String)> = Vec::new();
            for effect in clip.effects.iter().filter(|e| !e.is_audio()) {
                let c = effect.compile(clip_dur, project.width, project.height, project.fps);
                filters.extend(c.filters);
                commands.extend(c.commands);
            }
            if !filters.is_empty() {
                video_labels.push(Composite::Adjust {
                    filters,
                    commands,
                    start: seg_start,
                    end: seg_start + seg.out_len,
                });
            }
            continue;
        }

        // ---- video chain ----
        if is_video_track && !track.hidden && wants_video {
            let mut chain: Vec<String> = Vec::new();

            if !clip.is_generated() {
                chain.push(format!(
                    "trim=start={:.4}:end={:.4}",
                    seg.src_start, seg.src_end
                ));
            }
            chain.push("setpts=PTS-STARTPTS".into());
            if clip.reverse {
                chain.push("reverse".into());
            }
            if (seg.speed - 1.0).abs() > 0.001 {
                chain.push(format!("setpts=PTS/{:.6}", seg.speed));
            }
            // Shift to clip-local time so effect expressions and sendcmd times
            // are measured from the start of the clip, not of this segment.
            if seg.out_offset > 0.0 {
                chain.push(format!("setpts=PTS+{:.6}/TB", seg.out_offset));
            }

            chain.push(format!(
                "scale={w}:{h}:force_original_aspect_ratio=decrease",
                w = project.width,
                h = project.height
            ));
            // With motion the layer keeps its own box and the overlay places
            // it; padding to the full frame first would make position, scale
            // and rotation operate on letterboxing rather than on the picture.
            if clip.motion.is_identity() {
                chain.push(format!(
                    "pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
                    w = project.width,
                    h = project.height
                ));
            }
            chain.push("setsar=1".into());
            chain.push(format!("fps={}", project.fps));

            if let Source::Title {
                text, size, color, ..
            } = &clip.source
            {
                chain.push(format!(
                    "drawtext=text='{}':fontsize={:.0}:fontcolor={}:x=(w-text_w)/2:y=(h-text_h)/2",
                    escape_drawtext(text),
                    size,
                    sanitise_color(color)
                ));
            }

            let mut pipe = Pipeline::new();
            pipe.extend(chain);
            for effect in clip.effects.iter().filter(|e| !e.is_audio()) {
                let c = effect.compile(clip_dur, project.width, project.height, project.fps);
                if let Some(cmd) = sendcmd(&c.commands) {
                    // Its own chain, so these commands reach only this filter.
                    pipe.split();
                    pipe.push(cmd);
                    pipe.extend(c.filters);
                    pipe.split();
                } else {
                    pipe.extend(c.filters);
                }
            }

            if let Some(t) = &clip.transition_in {
                let d = t.duration.clamp(0.02, clip_dur.max(0.02));
                match t.kind {
                    TransitionKind::Dissolve => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!("fade=t=in:st=0:d={d:.4}:alpha=1"));
                    }
                    TransitionKind::DipToBlack => {
                        // Not alpha: dipping goes through the background colour.
                        pipe.push(format!("fade=t=in:st=0:d={d:.4}"));
                    }
                    TransitionKind::WipeLeft => {
                        // A hard edge travelling left to right, expressed as a
                        // per-pixel alpha test against time.
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(X,W*min(1,T/{d:.4})),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::WipeRight => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(gt(X,W*(1-min(1,T/{d:.4}))),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::WipeDown => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(Y,H*min(1,T/{d:.4})),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::WipeUp => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(gt(Y,H*(1-min(1,T/{d:.4}))),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::DiagonalWipe => {
                        // Edge runs corner to corner, so the test is on X+Y.
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(X+Y,(W+H)*min(1,T/{d:.4})),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::DipToWhite => {
                        // Like DipToBlack but through the opposite extreme.
                        pipe.push(format!("fade=t=in:st=0:d={d:.4}:color=white"));
                    }
                    TransitionKind::IrisOpen => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(hypot(X-W/2,Y-H/2),\
min(1,T/{d:.4})*hypot(W/2,H/2)),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::IrisClose => {
                        // Reveals from the edges inward instead of outward.
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(gt(hypot(X-W/2,Y-H/2),\
(1-min(1,T/{d:.4}))*hypot(W/2,H/2)),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::BarnDoorOpen => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(abs(X-W/2),min(1,T/{d:.4})*W/2),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::BarnDoorClose => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(gt(abs(X-W/2),(1-min(1,T/{d:.4}))*W/2),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::ClockWipe => {
                        // Angular sweep. atan2 is -PI..PI, so shift into 0..2PI.
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(mod(atan2(Y-H/2,X-W/2)+PI,2*PI),\
min(1,T/{d:.4})*2*PI),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::PixelDissolve => {
                        // A fixed per-pixel noise threshold crossed over time, so
                        // the pattern is stable rather than shimmering each frame.
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y)':a='if(lt(random(X+Y*W),min(1,T/{d:.4})),alpha(X,Y),0)'"
                        ));
                    }
                    TransitionKind::SlideRight => {
                        // The incoming clip travels in from the left edge. Each
                        // plane samples at the same offset so chroma tracks luma.
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X+W*(1-min(1,T/{d:.4})),Y)':\
cb='p(X+W*(1-min(1,T/{d:.4})),Y)':cr='p(X+W*(1-min(1,T/{d:.4})),Y)':\
a='if(lt(X,W*min(1,T/{d:.4})),alpha(X+W*(1-min(1,T/{d:.4})),Y),0)'"
                        ));
                    }
                    TransitionKind::SlideLeft => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X-W*(1-min(1,T/{d:.4})),Y)':\
cb='p(X-W*(1-min(1,T/{d:.4})),Y)':cr='p(X-W*(1-min(1,T/{d:.4})),Y)':\
a='if(gt(X,W*(1-min(1,T/{d:.4}))),alpha(X-W*(1-min(1,T/{d:.4})),Y),0)'"
                        ));
                    }
                    TransitionKind::SlideDown => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y+H*(1-min(1,T/{d:.4})))':\
cb='p(X,Y+H*(1-min(1,T/{d:.4})))':cr='p(X,Y+H*(1-min(1,T/{d:.4})))':\
a='if(lt(Y,H*min(1,T/{d:.4})),alpha(X,Y+H*(1-min(1,T/{d:.4}))),0)'"
                        ));
                    }
                    TransitionKind::SlideUp => {
                        pipe.push("format=yuva420p".into());
                        pipe.push(format!(
                            "geq=lum='p(X,Y-H*(1-min(1,T/{d:.4})))':\
cb='p(X,Y-H*(1-min(1,T/{d:.4})))':cr='p(X,Y-H*(1-min(1,T/{d:.4})))':\
a='if(gt(Y,H*(1-min(1,T/{d:.4}))),alpha(X,Y-H*(1-min(1,T/{d:.4}))),0)'"
                        ));
                    }
                }
            }

            let mut effective = clip.motion.clone();
            if (track.opacity - 1.0).abs() > 1e-9 {
                // Track opacity multiplies the clip's own, so a keyframed clip
                // opacity still animates underneath a dimmed track.
                effective.opacity = match &effective.opacity {
                    Param::Static(v) => Param::Static(v * track.opacity.clamp(0.0, 1.0)),
                    Param::Animated { keyframes } => Param::Animated {
                        keyframes: keyframes
                            .iter()
                            .map(|k| Keyframe {
                                time: k.time,
                                value: k.value * track.opacity.clamp(0.0, 1.0),
                                easing: k.easing,
                            })
                            .collect(),
                    },
                };
            }
            let motion = effective.compile(clip_dur, project.fps);
            if let Some(cmd) = sendcmd(&motion.commands) {
                pipe.split();
                pipe.push(cmd);
                pipe.extend(motion.filters);
                pipe.split();
            } else {
                pipe.extend(motion.filters);
            }

            pipe.push("format=yuva420p".into());
            pipe.push(format!("setpts=PTS+{:.6}/TB", clip.start));

            let label = format!("v{i}");
            filters.extend(pipe.emit(&format!("{i}:v"), &label, &format!("v{i}")));
            video_labels.push(Composite::Layer {
                label,
                start: seg_start,
                end: seg_start + seg.out_len,
                pos: effective.overlay_position(),
                blend: if clip.blend == BlendMode::Normal {
                    track.blend
                } else {
                    clip.blend
                },
            });
        }

        // ---- audio chain ----
        let any_solo = project.tracks.iter().any(|t| t.solo);
        let solo_ok = !any_solo || track.solo;
        let audible = solo_ok && !track.muted && !clip.muted && p.input.has_audio;
        if audible {
            let mut chain: Vec<String> = Vec::new();
            chain.push(format!(
                "atrim=start={:.4}:end={:.4}",
                seg.src_start, seg.src_end
            ));
            chain.push("asetpts=PTS-STARTPTS".into());
            if clip.reverse {
                chain.push("areverse".into());
            }
            if (seg.speed - 1.0).abs() > 0.001 {
                if clip.preserve_pitch {
                    for stage in atempo_stages(seg.speed) {
                        chain.push(format!("atempo={stage:.6}"));
                    }
                } else {
                    // Resampling changes duration and pitch together, the way
                    // speeding up a tape does.
                    chain.push(format!(
                        "asetrate={}*{:.6},aresample={}",
                        project.sample_rate, seg.speed, project.sample_rate
                    ));
                }
            }

            if !clip.channels.is_empty() {
                // Pick channels before anything else touches the audio, so a
                // later gain or effect applies to what was actually chosen.
                let picks: Vec<String> = clip
                    .channels
                    .iter()
                    .take(2)
                    .map(|c| format!("c{c}"))
                    .collect();
                let layout = if picks.len() >= 2 { "stereo" } else { "mono" };
                chain.push(format!(
                    "pan={layout}|{}",
                    picks
                        .iter()
                        .enumerate()
                        .map(|(i, c)| format!("c{i}={c}"))
                        .collect::<Vec<_>>()
                        .join("|")
                ));
            }
            chain.push(format!("aresample={}", project.sample_rate));
            chain.push("aformat=sample_fmts=fltp:channel_layouts=stereo".into());

            let gain = clip.gain.max(0.0) * track.volume.max(0.0);
            if (gain - 1.0).abs() > 0.001 {
                chain.push(format!("volume={gain:.4}"));
            }

            let mut pipe = Pipeline::new();
            pipe.extend(chain);
            for effect in clip.effects.iter().filter(|e| e.is_audio()) {
                let c = effect.compile(clip_dur, project.width, project.height, project.fps);
                if let Some(cmd) = sendcmd(&c.commands) {
                    pipe.split();
                    pipe.push(cmd);
                    pipe.extend(c.filters);
                    pipe.split();
                } else {
                    pipe.extend(c.filters);
                }
            }

            if seg_start > 0.0 {
                let ms = (seg_start * 1000.0).round() as i64;
                pipe.push(format!("adelay={ms}:all=1"));
            }

            let label = format!("a{i}");
            filters.extend(pipe.emit(&format!("{i}:a"), &label, &format!("a{i}")));
            audio_owner.push((label.clone(), track.id.clone()));
            audio_labels.push(label);
        }
    }

    // ---- composite video ----
    let final_video = if wants_video && !video_labels.is_empty() {
        filters.push(format!(
            "color=c={}:s={}x{}:r={}:d={:.4},format=yuva420p[base]",
            sanitise_color(&project.background),
            project.width,
            project.height,
            project.fps,
            total.max(0.04)
        ));
        let mut current = "base".to_string();
        for (n, op) in video_labels.iter().enumerate() {
            let out = format!("comp{n}");
            let (label, start, end, pos, blend) = match op {
                Composite::Adjust {
                    filters: adjust_filters,
                    commands,
                    start,
                    end,
                } => {
                    // Applied to the composite so far, gated to its own span so
                    // it grades only the stretch of timeline it covers.
                    let gated: Vec<String> = adjust_filters
                        .iter()
                        .map(|f| format!("{f}:enable='between(t,{start:.4},{end:.4})'"))
                        .collect();
                    let mut chain = Vec::new();
                    if let Some(cmd) = sendcmd(commands) {
                        chain.push(cmd);
                    }
                    chain.extend(gated);
                    filters.push(format!("[{current}]{}[{out}]", chain.join(",")));
                    current = out;
                    continue;
                }
                Composite::Layer {
                    label,
                    start,
                    end,
                    pos,
                    blend,
                } => (label, start, end, pos, blend),
            };
            // `enable` keeps a clip from painting outside its own span, and
            // shortest=0 keeps the base canvas defining the output length.
            if *blend == BlendMode::Normal {
                let (x, y) = pos;
                filters.push(format!(
                    "[{current}][{label}]overlay=x='{x}':y='{y}':eof_action=pass:shortest=0:\
enable='between(t,{start:.4},{end:.4})'[{out}]"
                ));
            } else {
                // `blend` combines two full frames and ignores alpha, so a
                // blended layer is first laid onto a transparent frame at its
                // position, then combined with what is below.
                let placed = format!("bpos{n}");
                let (x, y) = pos;
                filters.push(format!(
                    "color=c=black@0:s={w}x{h}:r={fps}:d={dur:.4},format=yuva420p[bbg{n}]",
                    w = project.width,
                    h = project.height,
                    fps = project.fps,
                    dur = total.max(0.04)
                ));
                filters.push(format!(
                    "[bbg{n}][{label}]overlay=x='{x}':y='{y}':eof_action=pass:shortest=0[{placed}]"
                ));
                filters.push(format!(
                    "[{current}][{placed}]blend=all_mode={mode}:shortest=0:\
enable='between(t,{start:.4},{end:.4})'[{out}]",
                    mode = blend.ffmpeg_name()
                ));
            }
            current = out;
        }
        // Burned-in subtitles are drawn after compositing, so they sit above
        // every track rather than under a later overlay.
        if project.subtitle_mode == SubtitleMode::Burn && !project.subtitles.is_empty() {
            let mut cued = current.clone();
            for (n, sub) in project.subtitles.iter().enumerate() {
                if sub.end <= sub.start || sub.text.trim().is_empty() {
                    continue;
                }
                let out = format!("sub{n}");
                filters.push(format!(
                    "[{cued}]drawtext=text='{}':fontsize={:.0}:fontcolor=white:\
borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y=h-text_h-(h*0.08):\
enable='between(t,{:.4},{:.4})'[{out}]",
                    escape_drawtext(sub.text.trim()),
                    project.subtitle_size,
                    sub.start,
                    sub.end
                ));
                cued = out;
            }
            current = cued;
        }
        filters.push(format!("[{current}]format=yuv420p[vout]"));
        Some("vout".to_string())
    } else {
        None
    };

    // ---- ducking ----
    //
    // Sum each track that participates, then compress the ducked track with the
    // key track as its sidechain. Tracks that do neither pass through.
    let mut ducked_labels: Vec<String> = Vec::new();
    if !audio_labels.is_empty() {
        let ducking: Vec<(&Track, String)> = project
            .tracks
            .iter()
            .filter_map(|t| t.duck_under.clone().map(|k| (t, k)))
            .collect();

        if !ducking.is_empty() {
            // Group the per-clip labels by the track they came from.
            let mut by_track: std::collections::BTreeMap<String, Vec<String>> = Default::default();
            for (label, track_id) in &audio_owner {
                by_track
                    .entry(track_id.clone())
                    .or_default()
                    .push(label.clone());
            }

            let sum = |id: &str, parts: &[String], filters: &mut Vec<String>| -> Option<String> {
                if parts.is_empty() {
                    return None;
                }
                if parts.len() == 1 {
                    return Some(parts[0].clone());
                }
                let joined: String = parts.iter().map(|l| format!("[{l}]")).collect();
                let out = format!("sum_{id}");
                filters.push(format!(
                    "{joined}amix=inputs={}:dropout_transition=0:normalize=0[{out}]",
                    parts.len()
                ));
                Some(out)
            };

            let mut consumed: std::collections::BTreeSet<String> = Default::default();
            for (track, key_id) in &ducking {
                let Some(own) = by_track.get(&track.id) else {
                    continue;
                };
                let Some(key_parts) = by_track.get(key_id) else {
                    continue;
                };
                if own.is_empty() || key_parts.is_empty() {
                    continue;
                }

                let Some(own_sum) = sum(&track.id, own, &mut filters) else {
                    continue;
                };
                // The key is copied, because it is also heard in the mix.
                let key_copy = format!("key_{}", track.id);
                let Some(key_sum) = sum(&format!("k{}", track.id), key_parts, &mut filters) else {
                    continue;
                };
                filters.push(format!("[{key_sum}]asplit=2[{key_copy}][{key_sum}_keep]"));

                let out = format!("duck_{}", track.id);
                filters.push(format!(
                    "[{own_sum}][{key_copy}]sidechaincompress=threshold={:.4}:ratio={:.2}:\
attack={:.1}:release={:.1}[{out}]",
                    track.duck_threshold.clamp(0.001, 1.0),
                    track.duck_ratio.clamp(1.0, 20.0),
                    track.duck_attack.clamp(0.01, 2000.0),
                    track.duck_release.clamp(0.01, 9000.0)
                ));

                for l in own {
                    consumed.insert(l.clone());
                }
                for l in key_parts {
                    consumed.insert(l.clone());
                }
                ducked_labels.push(out);
                ducked_labels.push(format!("{key_sum}_keep"));
            }

            if !consumed.is_empty() {
                audio_labels.retain(|l| !consumed.contains(l));
                audio_labels.extend(ducked_labels);
            }
        }
    }

    // ---- mix audio ----
    let final_audio = if audio_labels.is_empty() {
        None
    } else if audio_labels.len() == 1 {
        let only = &audio_labels[0];
        filters.push(format!(
            "[{only}]apad,atrim=0:{total:.4},asetpts=PTS-STARTPTS[aout]"
        ));
        Some("aout".to_string())
    } else {
        let joined: String = audio_labels.iter().map(|l| format!("[{l}]")).collect();
        filters.push(format!(
            "{joined}amix=inputs={}:dropout_transition=0:normalize=0,apad,atrim=0:{total:.4},asetpts=PTS-STARTPTS[aout]",
            audio_labels.len()
        ));
        Some("aout".to_string())
    };

    if final_video.is_none() && final_audio.is_none() {
        return Err(Error::Invalid(
            "nothing to render — every track is muted or hidden".into(),
        ));
    }

    args.push("-filter_complex".into());
    args.push(filters.join(";"));

    if let Some(v) = &final_video {
        args.push("-map".into());
        args.push(format!("[{v}]"));
    }
    if let Some(a) = &final_audio {
        args.push("-map".into());
        args.push(format!("[{a}]"));
    }

    if final_video.is_some() {
        args.push("-c:v".into());
        args.push(profile.video_codec.clone());
        if profile.video_codec.starts_with("libx26") {
            args.push("-preset".into());
            args.push(profile.preset.clone());
        }
        if profile.video_codec.starts_with("libvpx") {
            // libvpx ignores -preset; speed comes from deadline and cpu-used,
            // and CRF only applies with a zero target bitrate.
            args.push("-b:v".into());
            args.push("0".into());
            if profile.preset == "realtime" {
                args.push("-deadline".into());
                args.push("realtime".into());
                args.push("-cpu-used".into());
                args.push("8".into());
            }
        }
        if let Some(br) = &profile.video_bitrate {
            args.push("-b:v".into());
            args.push(br.clone());
        } else if let Some(crf) = profile.crf {
            args.push("-crf".into());
            args.push(crf.to_string());
        }
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
    }

    if final_audio.is_some() {
        args.push("-c:a".into());
        args.push(profile.audio_codec.clone());
        args.push("-b:a".into());
        args.push(profile.audio_bitrate.clone());
    }

    // A selectable subtitle stream, muxed rather than painted on.
    if project.subtitle_mode == SubtitleMode::Embed && !project.subtitles.is_empty() {
        if let Some(srt_path) = srt {
            let codec = match profile.container.as_str() {
                "mp4" | "mov" => Some("mov_text"),
                "webm" => Some("webvtt"),
                "mkv" => Some("srt"),
                // Nothing else here carries a subtitle track; skip rather than
                // fail the whole render over it.
                _ => None,
            };
            if let Some(codec) = codec {
                // The subtitle input must come after every media input, or the
                // media inputs shift and the filter graph's [0:v], [1:v] refs
                // all point at the wrong stream. Insert it immediately before
                // -filter_complex and derive its index from the inputs already
                // present rather than assuming a position.
                let at = args
                    .iter()
                    .position(|a| a == "-filter_complex")
                    .unwrap_or(args.len());
                let input_index = args[..at].iter().filter(|a| *a == "-i").count();
                args.insert(at, srt_path.to_string_lossy().to_string());
                args.insert(at, "-i".into());
                args.push("-map".into());
                args.push(format!("{input_index}:s:0"));
                args.push("-c:s".into());
                args.push(codec.to_string());
            }
        }
    }

    if profile.container == "mp4" || profile.container == "mov" {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }

    args.push("-t".into());
    args.push(format!("{total:.4}"));
    args.push(output.to_string_lossy().to_string());
    Ok(args)
}

/// A filter pipeline split into one or more chains.
///
/// `sendcmd` targets a filter by name and applies to every matching filter in
/// its own chain, so two animated blurs on one clip would otherwise receive
/// each other's commands. Giving each command-driven effect its own chain,
/// joined by intermediate labels, confines the commands to the filter they
/// were built for.
#[derive(Debug)]
struct Pipeline {
    chains: Vec<Vec<String>>,
}

impl Pipeline {
    fn new() -> Pipeline {
        Pipeline {
            chains: vec![Vec::new()],
        }
    }

    fn push(&mut self, filter: String) {
        self.chains
            .last_mut()
            .expect("always at least one chain")
            .push(filter);
    }

    fn extend(&mut self, filters: impl IntoIterator<Item = String>) {
        for f in filters {
            self.push(f);
        }
    }

    /// Begin a fresh chain, so what follows cannot see earlier commands.
    fn split(&mut self) {
        if !self.chains.last().map(Vec::is_empty).unwrap_or(true) {
            self.chains.push(Vec::new());
        }
    }

    /// Render to filter_complex chain strings, wiring intermediate labels.
    fn emit(self, input: &str, output: &str, tag: &str) -> Vec<String> {
        let chains: Vec<Vec<String>> = self.chains.into_iter().filter(|c| !c.is_empty()).collect();
        if chains.is_empty() {
            return vec![format!("[{input}]null[{output}]")];
        }
        let last = chains.len() - 1;
        let mut out = Vec::with_capacity(chains.len());
        let mut current = input.to_string();
        for (i, chain) in chains.into_iter().enumerate() {
            let label = if i == last {
                output.to_string()
            } else {
                format!("{tag}s{i}")
            };
            out.push(format!("[{current}]{}[{label}]", chain.join(",")));
            current = label;
        }
        out
    }
}

/// Build a `sendcmd` filter from timed option changes, or None if there are
/// none. Each one is placed in its own chain by `Pipeline`, so commands only
/// reach the filter they were generated for.
fn sendcmd(commands: &[(f64, String, String, String)]) -> Option<String> {
    if commands.is_empty() {
        return None;
    }
    let mut sorted: Vec<&(f64, String, String, String)> = commands.iter().collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let body: Vec<String> = sorted
        .iter()
        .map(|(t, target, opt, val)| format!("{t:.4} {target} {opt} {val}"))
        .collect();
    Some(format!("sendcmd=c='{}'", body.join(";")))
}

/// atempo only accepts 0.5–2.0, so larger changes are a product of stages.
fn atempo_stages(speed: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut remaining = speed;
    while remaining > 2.0 {
        out.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        out.push(0.5);
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > 0.001 {
        out.push(remaining);
    }
    out
}

/// Write a timestamped snapshot of the project, so a crash costs minutes
/// rather than a session. Old snapshots are pruned.
pub fn autosave(project: &Project, item_id: &str, dir: &Path) -> Result<String> {
    const KEEP: usize = 20;
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("{item_id}-{stamp}.json"));
    std::fs::write(&path, serde_json::to_string(project)?)?;

    // Prune oldest first; the filename sorts chronologically by construction.
    let mut mine: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with(item_id) && n.ends_with(".json"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    mine.sort();
    while mine.len() > KEEP {
        let oldest = mine.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(path.to_string_lossy().to_string())
}

/// Snapshots for one item, newest first.
pub fn autosaves(item_id: &str, dir: &Path) -> Vec<String> {
    let mut mine: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with(item_id) && n.ends_with(".json"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    mine.sort();
    mine.reverse();
    mine.into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// Read a snapshot back.
pub fn restore_autosave(path: &str) -> Result<Project> {
    let text = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

/// Detect cuts in a source by luminance change, the way Premiere's scene edit
/// detection does. Returns the times, in seconds, where a cut appears.
pub fn detect_scenes(source: &str, threshold: f64) -> Result<Vec<f64>> {
    let src = canonical_source(source)?;
    let threshold = threshold.clamp(0.05, 0.95);

    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-i"])
        .arg(&src)
        .args([
            "-vf",
            &format!("select='gt(scene,{threshold:.3})',metadata=print:file=-"),
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NoFfmpeg
            } else {
                Error::Io(e)
            }
        })?;

    // metadata=print writes "pts_time:12.345" lines to the file we set to stdout.
    let text = String::from_utf8_lossy(&out.stdout);
    let mut times: Vec<f64> = text
        .lines()
        .filter_map(|l| l.split("pts_time:").nth(1))
        .filter_map(|v| v.split_whitespace().next())
        .filter_map(|v| v.parse::<f64>().ok())
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup_by(|a, b| (*a - *b).abs() < 0.04);
    Ok(times)
}

/// Export as CMX3600 EDL, the interchange format every online system reads.
///
/// An EDL describes one video track of cuts, so only the first video track is
/// written and the caller is told when that loses information.
pub fn to_edl(project: &Project, title: &str) -> String {
    let fps = project.fps.max(1);
    let tc = |t: f64| -> String {
        let total = (t * fps as f64).round().max(0.0) as u64;
        let f = total % fps as u64;
        let s = (total / fps as u64) % 60;
        let m = (total / fps as u64 / 60) % 60;
        let h = total / fps as u64 / 3600;
        format!("{h:02}:{m:02}:{s:02}:{f:02}")
    };

    let mut out = format!("TITLE: {}\nFCM: NON-DROP FRAME\n\n", title.trim());
    let Some(track) = project.tracks.iter().find(|t| t.kind == TrackKind::Video) else {
        return out;
    };

    let mut clips: Vec<&Clip> = track.clips.iter().collect();
    clips.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for (i, clip) in clips.iter().enumerate() {
        let name = match &clip.source {
            Source::Media { path } => path.rsplit('/').next().unwrap_or("CLIP").to_string(),
            Source::Still { path } => path.rsplit('/').next().unwrap_or("STILL").to_string(),
            Source::Title { .. } => "TITLE".into(),
            Source::Color { .. } => "COLOUR".into(),
            Source::Adjustment => continue, // an adjustment layer is not an edit
            Source::Nested { name, .. } => name.to_uppercase(),
        };
        out.push_str(&format!(
            "{:03}  AX       V     C        {} {} {} {}\n* FROM CLIP NAME: {}\n\n",
            i + 1,
            tc(clip.in_point),
            tc(clip.out_point),
            tc(clip.start),
            tc(clip.end()),
            name
        ));
    }
    out
}

/// Export as OpenTimelineIO, which keeps every track rather than flattening.
pub fn to_otio(project: &Project, name: &str) -> String {
    let rate = project.fps.max(1) as f64;
    let time = |t: f64| -> serde_json::Value {
        serde_json::json!({
            "OTIO_SCHEMA": "RationalTime.1",
            "rate": rate,
            "value": (t * rate).round(),
        })
    };
    let range = |start: f64, dur: f64| -> serde_json::Value {
        serde_json::json!({
            "OTIO_SCHEMA": "TimeRange.1",
            "start_time": time(start),
            "duration": time(dur),
        })
    };

    let mut otio_tracks = Vec::new();
    for track in &project.tracks {
        let mut children = Vec::new();
        let mut clips: Vec<&Clip> = track.clips.iter().collect();
        clips.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // OTIO tracks are contiguous, so gaps are explicit Gap items.
        let mut cursor = 0.0;
        for clip in clips {
            if clip.start > cursor + 1e-6 {
                children.push(serde_json::json!({
                    "OTIO_SCHEMA": "Gap.1",
                    "name": "",
                    "source_range": range(0.0, clip.start - cursor),
                }));
            }
            let target = match &clip.source {
                Source::Media { path } | Source::Still { path } => serde_json::json!({
                    "OTIO_SCHEMA": "ExternalReference.1",
                    "target_url": path,
                }),
                _ => serde_json::json!({ "OTIO_SCHEMA": "MissingReference.1" }),
            };
            children.push(serde_json::json!({
                "OTIO_SCHEMA": "Clip.1",
                "name": clip.id,
                "source_range": range(clip.in_point, clip.source_duration()),
                "media_reference": target,
            }));
            cursor = clip.end();
        }

        otio_tracks.push(serde_json::json!({
            "OTIO_SCHEMA": "Track.1",
            "name": track.name,
            "kind": if track.kind == TrackKind::Audio { "Audio" } else { "Video" },
            "children": children,
        }));
    }

    let doc = serde_json::json!({
        "OTIO_SCHEMA": "Timeline.1",
        "name": name,
        "global_start_time": time(0.0),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "children": otio_tracks,
        },
    });
    serde_json::to_string_pretty(&doc).unwrap_or_default()
}

/// Serialise the subtitle list as SRT.
pub fn to_srt(subs: &[Subtitle]) -> String {
    let mut ordered: Vec<&Subtitle> = subs.iter().filter(|s| s.end > s.start).collect();
    ordered.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut out = String::new();
    for (i, sub) in ordered.iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            srt_time(sub.start),
            srt_time(sub.end),
            sub.text.trim()
        ));
    }
    out
}

fn srt_time(t: f64) -> String {
    let t = t.max(0.0);
    let h = (t / 3600.0).floor() as u64;
    let m = ((t % 3600.0) / 60.0).floor() as u64;
    let s = (t % 60.0).floor() as u64;
    let ms = ((t - t.floor()) * 1000.0).round() as u64;
    format!("{h:02}:{m:02}:{s:02},{:03}", ms.min(999))
}

/// Parse SRT. Malformed blocks are skipped rather than failing the import, so
/// one bad cue cannot cost the user the whole file.
pub fn from_srt(text: &str) -> Vec<Subtitle> {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    for block in normalised.split("\n\n") {
        let lines: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        // An optional index line precedes the timing line.
        let timing_at = lines.iter().position(|l| l.contains("-->"));
        let Some(ti) = timing_at else { continue };
        let Some((a, b)) = lines[ti].split_once("-->") else {
            continue;
        };
        let (Some(start), Some(end)) = (parse_srt_time(a), parse_srt_time(b)) else {
            continue;
        };
        if end <= start {
            continue;
        }
        let body = lines[ti + 1..].join("\n");
        if body.trim().is_empty() {
            continue;
        }
        out.push(Subtitle {
            id: uuid::Uuid::new_v4().to_string(),
            start,
            end,
            text: body,
        });
    }
    out
}

fn parse_srt_time(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, rest) = match parts.len() {
        3 => (
            parts[0].parse::<f64>().ok()?,
            parts[1].parse::<f64>().ok()?,
            parts[2],
        ),
        2 => (0.0, parts[0].parse::<f64>().ok()?, parts[1]),
        _ => return None,
    };
    let sec: f64 = rest.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// A rendered span of the timeline, cached on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewChunk {
    pub start: f64,
    pub end: f64,
    pub path: String,
    /// Content hash of the sliced project. A stale chunk is one whose key no
    /// longer matches what the timeline now says for that range.
    pub key: String,
    pub width: u32,
    pub height: u32,
}

/// One job in the render queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderJob {
    pub id: String,
    pub name: String,
    pub project: Project,
    pub profile: RenderProfile,
    pub output: String,
    /// None renders the whole timeline; Some renders that zone.
    #[serde(default)]
    pub zone: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobResult {
    pub id: String,
    pub name: String,
    pub output: String,
    pub ok: bool,
    pub detail: String,
    pub seconds: f64,
}

/// Run a queue of renders in order, the way Media Encoder does.
///
/// One failing job does not abandon the rest: every job reports its own
/// outcome, because a queue left half-run with no record of why is worse than
/// a queue that finishes with one error in it.
pub fn run_queue(jobs: &[RenderJob], cache_dir: &Path) -> Vec<JobResult> {
    jobs.iter()
        .map(|job| {
            let started = std::time::Instant::now();
            let outcome = flatten_nested(&job.project, cache_dir).and_then(|flat| match job.zone {
                Some((a, b)) => render_zone(&flat, &job.profile, Path::new(&job.output), a, b),
                None => render(&flat, &job.profile, Path::new(&job.output)),
            });
            let seconds = started.elapsed().as_secs_f64();
            match outcome {
                Ok(path) => JobResult {
                    id: job.id.clone(),
                    name: job.name.clone(),
                    output: path,
                    ok: true,
                    detail: String::new(),
                    seconds,
                },
                Err(e) => JobResult {
                    id: job.id.clone(),
                    name: job.name.clone(),
                    output: job.output.clone(),
                    ok: false,
                    detail: e.to_string(),
                    seconds,
                },
            }
        })
        .collect()
}

/// Export presets: a render profile saved under a name the user chose.
pub fn save_preset(profile: &RenderProfile, dir: &Path) -> Result<String> {
    std::fs::create_dir_all(dir)?;
    let safe: String = profile
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if safe.is_empty() {
        return Err(Error::Invalid("a preset needs a name".into()));
    }
    let path = dir.join(format!("{safe}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(profile)?)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn load_presets(dir: &Path) -> Vec<RenderProfile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<RenderProfile> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|t| serde_json::from_str::<RenderProfile>(&t).ok())
        .collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

pub fn delete_preset(id: &str, dir: &Path) -> Result<()> {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let path = dir.join(format!("{safe}.json"));
    std::fs::remove_file(path).map_err(Error::Io)
}

/// Make transitions real by overlapping the clips they join.
///
/// A dissolve is the incoming clip's alpha rising over whatever is beneath it.
/// That works between tracks, but two clips butted together on ONE track never
/// overlap, so the incoming clip would fade up from the background instead of
/// from its neighbour. This pulls the incoming clip earlier by the transition
/// length and extends the outgoing clip's tail to play underneath, which is
/// what a cross dissolve actually is.
///
/// Both sides need handles: material beyond the cut. Where a clip has none the
/// transition is shortened to what is available rather than inventing frames.
pub fn apply_transitions(project: &Project) -> Project {
    let mut out = project.clone();
    for track in &mut out.tracks {
        // Work back to front so shifting a clip cannot disturb one not yet seen.
        let mut ordered: Vec<usize> = (0..track.clips.len()).collect();
        ordered.sort_by(|a, b| {
            track.clips[*a]
                .start
                .partial_cmp(&track.clips[*b].start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for w in ordered.windows(2) {
            let (prev_i, next_i) = (w[0], w[1]);
            let Some(t) = track.clips[next_i].transition_in.clone() else {
                continue;
            };

            let prev_end = track.clips[prev_i].end();
            let next_start = track.clips[next_i].start;
            // Only clips that actually meet form a transition.
            if (next_start - prev_end).abs() > 0.001 {
                continue;
            }

            let incoming = &track.clips[next_i];
            let speed = if incoming.speed.is_animated() {
                1.0
            } else {
                incoming.speed.first().abs().max(0.01)
            };
            // Handles available at the incoming head, in timeline seconds.
            let head_handle = incoming.in_point / speed;

            let outgoing = &track.clips[prev_i];
            let out_speed = if outgoing.speed.is_animated() {
                1.0
            } else {
                outgoing.speed.first().abs().max(0.01)
            };
            // Handles available at the outgoing tail is unknown without probing
            // the source, so the tail is extended only as far as the incoming
            // clip can be pulled back, which is always safe.
            let overlap = t
                .duration
                .min(head_handle)
                .min(outgoing.duration())
                .max(0.0);
            if overlap <= 0.001 {
                // No handles: leave it as a fade up from the background and say
                // so through the shortened duration.
                continue;
            }

            // Pull the incoming clip earlier, consuming its head handle.
            {
                let c = &mut track.clips[next_i];
                c.start -= overlap;
                c.in_point = (c.in_point - overlap * speed).max(0.0);
                c.transition_in = Some(Transition {
                    kind: t.kind,
                    duration: overlap,
                });
            }
            // Extend the outgoing tail so it plays under the dissolve.
            {
                let c = &mut track.clips[prev_i];
                c.out_point += overlap * out_speed;
            }
        }
    }
    out
}

/// Cut the project down to `[start, end)`, rebased so the slice begins at 0.
///
/// Clips straddling a boundary are trimmed rather than dropped, and the trim is
/// taken through `source_time_at` so a speed ramp stays correct across the cut.
pub fn slice(project: &Project, start: f64, end: f64) -> Project {
    let mut out = project.clone();
    for track in &mut out.tracks {
        let mut kept: Vec<Clip> = Vec::new();
        for clip in &track.clips {
            let c_start = clip.start;
            let c_end = clip.end();
            if c_end <= start || c_start >= end {
                continue; // entirely outside the range
            }

            let mut sliced = clip.clone();

            // Trim the head if the range starts partway through the clip.
            if c_start < start {
                let skip = start - c_start;
                sliced.in_point = clip.source_time_at(skip);
                sliced.start = 0.0;
                // A ramp indexed from the old in point no longer lines up.
                if clip.speed.is_animated() {
                    sliced.speed = Param::Static(
                        clip.segments()
                            .iter()
                            .find(|s| s.out_offset + s.out_len > skip)
                            .map(|s| s.speed)
                            .unwrap_or(1.0),
                    );
                }
            } else {
                sliced.start = c_start - start;
            }

            // Trim the tail if the clip runs past the end of the range.
            if c_end > end {
                let keep = end - c_start.max(start);
                let from = if c_start < start {
                    start - c_start
                } else {
                    0.0
                };
                sliced.out_point = clip.source_time_at(from + keep);
            }

            if sliced.out_point > sliced.in_point {
                kept.push(sliced);
            }
        }
        track.clips = kept;
    }
    out
}

/// A deliberately cheap encode: previews exist to play smoothly, not to look
/// final. Dimensions come from the caller so the scale factor applies.
///
/// VP8 in WebM, not H.264, for the same reason as proxies: the preview plays
/// in a webview, and on Linux that decodes through GStreamer, where H.264
/// requires `gst-libav` that many systems do not ship. Export is unaffected and
/// still offers the full profile list.
pub fn preview_profile() -> RenderProfile {
    RenderProfile {
        id: "preview".into(),
        label: "Timeline preview".into(),
        container: "webm".into(),
        video_codec: "libvpx".into(),
        audio_codec: "libopus".into(),
        crf: Some(32),
        video_bitrate: None,
        audio_bitrate: "128k".into(),
        preset: "realtime".into(),
    }
}

/// Content hash of a range. Two timelines that would render identically share
/// a key, so an edit elsewhere does not invalidate this chunk.
pub fn preview_key(project: &Project, start: f64, end: f64, scale: f64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let sliced = slice(project, start, end);
    let json = serde_json::to_string(&sliced).unwrap_or_default();
    let mut h = DefaultHasher::new();
    json.hash(&mut h);
    format!("{:.4}", scale).hash(&mut h);
    // Frame geometry changes the encode even when the clips do not.
    project.width.hash(&mut h);
    project.height.hash(&mut h);
    project.fps.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Render `[start, end)` to a cached file. If a file for this key already
/// exists, it is reused rather than re-encoded.
pub fn render_preview(
    project: &Project,
    start: f64,
    end: f64,
    scale: f64,
    cache_dir: &Path,
) -> Result<PreviewChunk> {
    if end <= start {
        return Err(Error::Invalid("the preview range is empty".into()));
    }
    let scale = scale.clamp(0.1, 1.0);
    let key = preview_key(project, start, end, scale);

    let mut sliced = slice(project, start, end);
    if sliced.clip_count() == 0 {
        return Err(Error::Invalid(
            "nothing on the timeline in that range".into(),
        ));
    }

    // H.264 needs even dimensions, and the scale must not collapse to nothing.
    let w = (((project.width as f64 * scale).round() as u32).max(16) / 2) * 2;
    let h = (((project.height as f64 * scale).round() as u32).max(16) / 2) * 2;
    sliced.width = w;
    sliced.height = h;

    std::fs::create_dir_all(cache_dir)?;
    let path = cache_dir.join(format!("{key}.webm"));

    let chunk = PreviewChunk {
        start,
        end,
        path: path.to_string_lossy().to_string(),
        key,
        width: w,
        height: h,
    };

    // Cache hit: a non-empty file for this key is already what we would build.
    if path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(chunk);
    }

    render(&sliced, &preview_profile(), &path)?;
    Ok(chunk)
}

/// Remove every cached preview. Used when the user wants the disk back.
pub fn clear_previews(cache_dir: &Path) -> Result<usize> {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return Ok(0);
    };
    let mut n = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("webm")
            && std::fs::remove_file(&p).is_ok()
        {
            n += 1;
        }
    }
    Ok(n)
}

/// Render any nested sequence to a cached file and replace it with that media,
/// so the rest of the pipeline never has to think about nesting.
pub fn flatten_nested(project: &Project, cache_dir: &Path) -> Result<Project> {
    let mut out = project.clone();
    for track in &mut out.tracks {
        for clip in &mut track.clips {
            let Source::Nested {
                name,
                project: inner,
            } = clip.source.clone()
            else {
                continue;
            };
            // Recurse first: a sequence may itself contain sequences.
            let flat_inner = flatten_nested(&inner, cache_dir)?;
            if flat_inner.clip_count() == 0 {
                return Err(Error::Invalid(format!("nested sequence '{name}' is empty")));
            }
            let chunk = render_preview(&flat_inner, 0.0, flat_inner.duration(), 1.0, cache_dir)?;
            clip.source = Source::Media { path: chunk.path };
        }
    }
    Ok(out)
}

/// The largest single argument the kernel will accept is MAX_ARG_STRLEN,
/// which is 32 pages: 131072 bytes on Linux. A filter graph passes as ONE
/// argument, and a few hundred clips comfortably exceeds that, at which point
/// exec fails outright with "Argument list too long" rather than anything
/// ffmpeg could report. Well below the limit, the graph is spilled to a file
/// and handed over with -filter_complex_script instead.
const MAX_INLINE_GRAPH: usize = 60_000;

/// Swap an oversized -filter_complex for -filter_complex_script backed by a
/// file. Returns the rewritten arguments and the file to clean up afterwards.
fn spill_graph(mut args: Vec<String>) -> Result<(Vec<String>, Option<PathBuf>)> {
    let Some(i) = args.iter().position(|a| a == "-filter_complex") else {
        return Ok((args, None));
    };
    if args.get(i + 1).map(|g| g.len()).unwrap_or(0) <= MAX_INLINE_GRAPH {
        return Ok((args, None));
    }

    let graph = args[i + 1].clone();
    let path = std::env::temp_dir().join(format!("odyssey-graph-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&path, &graph)?;

    // `-/optname file` is ffmpeg's read-this-option-from-a-file syntax. The
    // older -filter_complex_script was removed in ffmpeg 7.
    args[i] = "-/filter_complex".into();
    args[i + 1] = path.to_string_lossy().to_string();
    Ok((args, Some(path)))
}

pub fn render(project: &Project, profile: &RenderProfile, output: &Path) -> Result<String> {
    // Writing the SRT is a side effect, so it lives here rather than in
    // render_args, which stays pure and unit-testable.
    let mut srt_file: Option<PathBuf> = None;
    if project.subtitle_mode == SubtitleMode::Embed && !project.subtitles.is_empty() {
        let path = std::env::temp_dir().join(format!("odyssey-subs-{}.srt", uuid::Uuid::new_v4()));
        std::fs::write(&path, to_srt(&project.subtitles))?;
        srt_file = Some(path);
    }

    let args = render_args(project, profile, output, srt_file.as_deref())?;
    // A large timeline exceeds the kernel's per-argument limit, so the graph
    // may have to travel as a file rather than an argument.
    let (args, graph_file) = spill_graph(args)?;
    let out = Command::new("ffmpeg").args(&args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::NoFfmpeg
        } else {
            Error::Io(e)
        }
    })?;
    if let Some(path) = &srt_file {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = &graph_file {
        let _ = std::fs::remove_file(path);
    }

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.trim().lines().rev().take(8).collect();
        let msg: Vec<&str> = tail.into_iter().rev().collect();
        return Err(Error::Render(msg.join("\n")));
    }
    Ok(output.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Test scratch space, deliberately NOT the system temp directory.
    ///
    /// /tmp is a tmpfs here and shared with whatever else is running; a large
    /// unrelated file in it made renders fail with "Disk quota exceeded" and
    /// looked like flaky tests. The build directory is on real disk.
    /// Serialises the tests that spawn many ffmpeg processes.
    ///
    /// The harness runs tests in parallel, and several of these each start a
    /// render. Together they exhausted process resources and ffmpeg failed
    /// with "Resource temporarily unavailable", which looked like a broken
    /// filter but was only contention. Heavy tests take this lock; the pure
    /// ones stay parallel.
    pub(crate) fn render_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-scratch");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    /// A real, tiny media file with both video and audio.
    ///
    /// These used to be one-byte stubs, which worked only because the renderer
    /// assumed every media input had audio. Now that audio presence is probed,
    /// a stub correctly reports none and the audio chain vanishes, so the
    /// fixtures have to be actual media. They are tiny and cached on disk.
    fn temp_source(name: &str) -> PathBuf {
        let p = scratch(&format!("odyssey-tl-{name}.mp4"));
        if p.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return p;
        }
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=32x32:rate=10:duration=0.2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&p)
            .status();
        match status {
            Ok(s) if s.success() => p,
            // Without ffmpeg the graph-shape tests cannot be meaningful, but a
            // stub still lets the pure-logic tests run.
            _ => {
                let _ = std::fs::File::create(&p).and_then(|mut f| f.write_all(b"x"));
                p
            }
        }
    }

    fn media_clip(id: &str, path: &Path, start: f64, a: f64, b: f64) -> Clip {
        Clip {
            id: id.into(),
            source: Source::Media {
                path: path.to_string_lossy().to_string(),
            },
            start,
            in_point: a,
            out_point: b,
            speed: Param::Static(1.0),
            reverse: false,
            gain: 1.0,
            muted: false,
            effects: vec![],
            motion: Motion::default(),
            blend: BlendMode::Normal,
            channels: vec![],
            preserve_pitch: true,
            transition_in: None,
        }
    }

    fn video_track(clips: Vec<Clip>) -> Track {
        Track {
            id: "t1".into(),
            name: "V1".into(),
            kind: TrackKind::Video,
            clips,
            muted: false,
            hidden: false,
            locked: false,
            solo: false,
            volume: 1.0,
            opacity: 1.0,
            blend: BlendMode::Normal,
            targeted: false,
            duck_under: None,
            duck_threshold: 0.05,
            duck_ratio: 8.0,
            duck_attack: 20.0,
            duck_release: 300.0,
        }
    }

    fn profile() -> RenderProfile {
        render_profiles().into_iter().next().unwrap()
    }

    #[test]
    fn duration_is_the_furthest_clip_end() {
        let s = temp_source("a");
        let p = Project {
            tracks: vec![video_track(vec![
                media_clip("1", &s, 0.0, 0.0, 5.0),
                media_clip("2", &s, 12.0, 0.0, 3.0),
            ])],
            ..Default::default()
        };
        assert_eq!(p.duration(), 15.0);
    }

    #[test]
    fn overlapping_clips_on_separate_tracks_both_render() {
        let s = temp_source("b");
        let mut t2 = video_track(vec![media_clip("2", &s, 0.0, 0.0, 4.0)]);
        t2.id = "t2".into();
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 4.0)]), t2],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(joined.contains("[v0]"), "first clip missing");
        assert!(joined.contains("[v1]"), "second clip missing");
        assert_eq!(joined.matches("overlay=").count(), 2, "both must composite");
    }

    #[test]
    fn speed_changes_video_and_audio_together() {
        let s = temp_source("c");
        let mut c = media_clip("1", &s, 0.0, 0.0, 10.0);
        c.speed = Param::Static(2.0);
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        assert_eq!(p.duration(), 5.0, "double speed halves the timeline length");
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(joined.contains("setpts=PTS/2"), "video speed missing");
        assert!(joined.contains("atempo=2"), "audio speed missing");
    }

    /// atempo cannot exceed 2.0 in one stage.
    #[test]
    fn extreme_speed_is_split_into_atempo_stages() {
        let stages = atempo_stages(8.0);
        assert_eq!(stages.len(), 3);
        assert!(stages.iter().all(|s| (0.5..=2.0).contains(s)));
        let product: f64 = stages.iter().product();
        assert!((product - 8.0).abs() < 0.001);

        let slow = atempo_stages(0.25);
        assert!(slow.iter().all(|s| (0.5..=2.0).contains(s)));
        let p: f64 = slow.iter().product();
        assert!((p - 0.25).abs() < 0.001);
    }

    #[test]
    fn clip_is_delayed_to_its_timeline_position() {
        let s = temp_source("d");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 7.5, 0.0, 2.0)])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("setpts=PTS+7.5"),
            "video not delayed: {joined}"
        );
        assert!(joined.contains("adelay=7500"), "audio not delayed");
    }

    #[test]
    fn hidden_track_produces_no_video() {
        let s = temp_source("e");
        let mut t = video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]);
        t.hidden = true;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!joined.contains("[v0]"), "hidden track still rendered");
    }

    #[test]
    fn muted_track_produces_no_audio() {
        let s = temp_source("f");
        let mut t = video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]);
        t.muted = true;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!joined.contains("[a0]"), "muted track still had audio");
    }

    #[test]
    fn soloing_a_track_silences_the_others() {
        let s = temp_source("solo");
        let mut t1 = video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]);
        t1.id = "t1".into();
        let mut t2 = video_track(vec![media_clip("2", &s, 0.0, 0.0, 2.0)]);
        t2.id = "t2".into();
        t2.solo = true;

        let p = Project {
            tracks: vec![t1, t2],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            !joined.contains("[a0]"),
            "non-soloed track should be silent"
        );
        assert!(joined.contains("[a1]"), "soloed track should be audible");
        // Video is unaffected by solo.
        assert!(joined.contains("[v0]") && joined.contains("[v1]"));
    }

    #[test]
    fn without_any_solo_every_track_is_audible() {
        let s = temp_source("nosolo");
        let mut t1 = video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]);
        t1.id = "t1".into();
        let mut t2 = video_track(vec![media_clip("2", &s, 0.0, 0.0, 2.0)]);
        t2.id = "t2".into();
        let p = Project {
            tracks: vec![t1, t2],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(joined.contains("[a0]") && joined.contains("[a1]"));
    }

    #[test]
    fn track_volume_reaches_the_filter_graph() {
        let s = temp_source("tvol");
        let mut t = video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]);
        t.volume = 0.25;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("volume=0.2500"),
            "track volume not applied: {joined}"
        );
    }

    #[test]
    fn keyframes_compile_to_an_animated_expression() {
        let p = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 0.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 2.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let expr = p.to_expr();
        assert!(
            expr.contains("if(lt(t,"),
            "not a piecewise expression: {expr}"
        );
        // Sampled values must match the interpolation.
        assert!((p.value_at(0.0) - 0.0).abs() < 1e-9);
        assert!((p.value_at(1.0) - 0.5).abs() < 1e-9);
        assert!((p.value_at(2.0) - 1.0).abs() < 1e-9);
        // Outside the range it holds the end values.
        assert!((p.value_at(-5.0) - 0.0).abs() < 1e-9);
        assert!((p.value_at(99.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn easing_curves_differ_from_linear_at_the_midpoint() {
        let mk = |e: Easing| Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 0.0,
                    easing: e,
                },
                Keyframe {
                    time: 1.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
            ],
        };
        assert!((mk(Easing::Linear).value_at(0.5) - 0.5).abs() < 1e-9);
        assert!(mk(Easing::EaseIn).value_at(0.5) < 0.5);
        assert!(mk(Easing::EaseOut).value_at(0.5) > 0.5);
        assert!((mk(Easing::EaseInOut).value_at(0.5) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn animated_colour_effect_asks_ffmpeg_to_evaluate_per_frame() {
        let s = temp_source("g");
        let mut c = media_clip("1", &s, 0.0, 0.0, 4.0);
        c.effects.push(Effect::Color {
            brightness: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: -1.0,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 4.0,
                        value: 0.0,
                        easing: Easing::Linear,
                    },
                ],
            },
            contrast: Param::Static(1.0),
            saturation: Param::Static(1.0),
            gamma: Param::Static(1.0),
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("eval=frame"),
            "static evaluation would freeze the animation"
        );
        assert!(joined.contains("eq=brightness="));
    }

    #[test]
    fn fade_out_is_placed_at_the_clip_tail() {
        let s = temp_source("h");
        let mut c = media_clip("1", &s, 0.0, 0.0, 6.0);
        c.effects.push(Effect::Fade {
            in_secs: 1.0,
            out_secs: 2.0,
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(joined.contains("fade=t=in:st=0:d=1.0000"));
        assert!(joined.contains("fade=t=out:st=4.0000:d=2.0000"), "{joined}");
    }

    #[test]
    fn title_clips_need_no_file_on_disk() {
        let p = Project {
            tracks: vec![video_track(vec![Clip {
                id: "t".into(),
                source: Source::Title {
                    text: "Odyssey".into(),
                    background: "black".into(),
                    size: 96.0,
                    color: "white".into(),
                },
                start: 0.0,
                in_point: 0.0,
                out_point: 3.0,
                speed: Param::Static(1.0),
                reverse: false,
                gain: 1.0,
                muted: false,
                effects: vec![],
                motion: Motion::default(),
                blend: BlendMode::Normal,
                channels: vec![],
                preserve_pitch: true,
                transition_in: None,
            }])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("lavfi"),
            "generated source should use lavfi"
        );
        assert!(joined.contains("drawtext=text='Odyssey'"));
    }

    #[test]
    fn audio_only_profile_skips_the_video_chain() {
        let s = temp_source("i");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 3.0)])],
            ..Default::default()
        };
        let mp3 = render_profiles()
            .into_iter()
            .find(|p| p.id == "mp3-audio")
            .unwrap();
        let joined = render_args(&p, &mp3, Path::new("/tmp/o.mp3"), None)
            .unwrap()
            .join(" ");
        assert!(
            !joined.contains("[vout]"),
            "audio profile should not map video"
        );
        assert!(joined.contains("libmp3lame"));
    }

    #[test]
    fn empty_project_is_rejected() {
        assert!(matches!(
            render_args(
                &Project::default(),
                &profile(),
                Path::new("/tmp/o.mp4"),
                None
            ),
            Err(Error::Empty)
        ));
    }

    #[test]
    fn odd_dimensions_are_rejected_before_ffmpeg_fails() {
        let s = temp_source("j");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)])],
            width: 1921,
            height: 1080,
            ..Default::default()
        };
        assert!(render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).is_err());
    }

    #[test]
    fn zero_speed_is_rejected() {
        let s = temp_source("k");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.speed = Param::Static(0.0);
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        assert!(render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).is_err());
    }

    /// Regression test: drawtext has its own escaping, and a colon or quote in
    /// user text would otherwise terminate the filter argument.
    #[test]
    fn title_text_cannot_break_out_of_the_filter_string() {
        let hostile = "Title: 'quoted' , x=0:y=0";
        let escaped = escape_drawtext(hostile);
        assert!(
            !escaped.contains("':"),
            "unescaped colon after quote: {escaped}"
        );
        assert!(!escaped.contains('\''), "raw quote survived: {escaped}");
        assert!(escaped.contains("\\:"), "colon not escaped: {escaped}");
    }

    /// Regression test: colours land inside a filter string, so only names and
    /// hex are allowed through.
    #[test]
    fn hostile_colour_values_are_replaced() {
        assert_eq!(sanitise_color("red"), "red");
        assert_eq!(sanitise_color("#FF00AA"), "#FF00AA");
        assert_eq!(sanitise_color("black@0.5"), "black@0.5");
        assert_eq!(sanitise_color("red:x=evil"), "black");
        assert_eq!(sanitise_color("'; rm -rf /"), "black");
        assert_eq!(sanitise_color(""), "black");
    }

    /// Regression test: source paths stay one argv entry.
    #[test]
    fn hostile_filenames_stay_a_single_argument() {
        let nasty = scratch("odyssey-tl--x; rm -rf $(echo).mp4");
        std::fs::File::create(&nasty)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &nasty, 0.0, 0.0, 1.0)])],
            ..Default::default()
        };
        let args = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).unwrap();
        let arg = args.iter().find(|a| a.contains("rm -rf")).unwrap();
        assert!(arg.starts_with('/') && arg.ends_with(".mp4"));
        std::fs::remove_file(&nasty).ok();
    }

    // ---- keyframing every parameter ----

    #[test]
    fn animated_blur_is_driven_by_sendcmd() {
        let s = temp_source("kf1");
        let mut c = media_clip("1", &s, 0.0, 0.0, 4.0);
        c.effects.push(Effect::Blur {
            sigma: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.0,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 4.0,
                        value: 20.0,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("sendcmd=c='"),
            "no command stream: {joined}"
        );
        assert!(joined.contains("gblur sigma"), "blur not targeted");
    }

    #[test]
    fn animated_sharpen_stacks_gated_instances() {
        let s = temp_source("kf2");
        let mut c = media_clip("1", &s, 0.0, 0.0, 1.0);
        c.effects.push(Effect::Sharpen {
            amount: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.0,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 1.0,
                        value: 3.0,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        // unsharp has neither expressions nor runtime options, so it is stacked.
        assert!(
            joined.matches("unsharp=").count() > 1,
            "not stacked: {joined}"
        );
        assert!(joined.contains("enable='between(t,"), "slices not gated");
    }

    #[test]
    fn animated_vignette_uses_an_expression() {
        let s = temp_source("kf3");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Vignette {
            angle: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.1,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 2.0,
                        value: 1.2,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("vignette=a='if(lt(t,"),
            "not an expression: {joined}"
        );
    }

    #[test]
    fn every_effect_kind_reports_an_animation_route() {
        let all = vec![
            Effect::Color {
                brightness: p_zero(),
                contrast: p_one(),
                saturation: p_one(),
                gamma: p_one(),
            },
            Effect::Hue { degrees: p_zero() },
            Effect::Blur { sigma: p_one() },
            Effect::Sharpen { amount: p_one() },
            Effect::Opacity { level: p_one() },
            Effect::Fade {
                in_secs: 0.1,
                out_secs: 0.1,
            },
            Effect::Crop {
                x: p_zero(),
                y: p_zero(),
                width: 100.0,
                height: 100.0,
            },
            Effect::Rotate { degrees: p_zero() },
            Effect::Transform {
                scale: p_one(),
                x: p_zero(),
                y: p_zero(),
            },
            Effect::Vignette { angle: p_zero() },
            Effect::ChromaKey {
                color: "green".into(),
                similarity: p_point_one(),
                blend: p_zero(),
            },
            Effect::Text {
                content: "x".into(),
                size: 10.0,
                color: "white".into(),
                x: p_zero(),
                y: p_zero(),
                font: String::new(),
            },
            Effect::Volume { level: p_one() },
            Effect::AudioFade {
                in_secs: 0.1,
                out_secs: 0.1,
            },
            Effect::Highpass {
                frequency: p_two_hundred(),
            },
            Effect::Lowpass {
                frequency: p_three_thousand(),
            },
            Effect::Frei0r {
                name: "glow".into(),
                params: vec![Param::Static(0.5)],
            },
            Effect::Vibrance {
                intensity: Param::Static(0.5),
            },
            Effect::ColorBalance {
                r: Param::Static(0.1),
                g: Param::Static(0.0),
                b: Param::Static(-0.1),
            },
            Effect::ChromaticAberration {
                amount: Param::Static(2.0),
            },
            Effect::Shear {
                x: Param::Static(0.1),
                y: Param::Static(0.0),
            },
            Effect::ColorKey {
                color: "green".into(),
                similarity: Param::Static(0.2),
                blend: Param::Static(0.1),
            },
            Effect::HsvKey {
                hue: Param::Static(120.0),
                sat: Param::Static(0.5),
                val: Param::Static(0.5),
                similarity: Param::Static(0.2),
                blend: Param::Static(0.1),
            },
            Effect::FrameBlend {
                frames: Param::Static(3.0),
            },
            Effect::FalseColor {
                preset: "magma".into(),
            },
            Effect::HistEq {
                strength: Param::Static(0.5),
            },
            Effect::AutoLevels {
                strength: Param::Static(0.8),
            },
            Effect::Deinterlace { mode: 0.0 },
            Effect::AdaptiveSharpen {
                strength: Param::Static(0.5),
            },
            Effect::ChromaDenoise {
                threshold: Param::Static(20.0),
            },
            Effect::HueSaturation {
                hue: Param::Static(20.0),
                saturation: Param::Static(0.2),
                intensity: Param::Static(0.3),
            },
            Effect::Bilateral {
                sigma_s: Param::Static(2.0),
                sigma_r: Param::Static(0.2),
            },
            Effect::SmartBlur {
                radius: Param::Static(2.0),
                strength: Param::Static(0.5),
            },
            Effect::VagueDenoise {
                threshold: Param::Static(3.0),
            },
            Effect::Sepia,
            Effect::Scanlines {
                amount: Param::Static(0.4),
            },
            Effect::Mirror,
            Effect::Bass {
                gain: Param::Static(4.0),
                freq: Param::Static(100.0),
            },
            Effect::Treble {
                gain: Param::Static(3.0),
                freq: Param::Static(3000.0),
            },
            Effect::ParametricEq {
                freq: Param::Static(1000.0),
                width: Param::Static(1.0),
                gain: Param::Static(3.0),
            },
            Effect::Tremolo {
                freq: Param::Static(5.0),
                depth: Param::Static(0.5),
            },
            Effect::Vibrato {
                freq: Param::Static(5.0),
                depth: Param::Static(0.5),
            },
            Effect::BitCrush {
                bits: Param::Static(8.0),
                mix: Param::Static(0.5),
            },
            Effect::Exciter {
                amount: Param::Static(1.0),
            },
            Effect::SubBoost {
                amount: Param::Static(0.5),
            },
            Effect::SpeechNorm {
                expansion: Param::Static(2.0),
            },
            Effect::AudioDenoise {
                reduction: Param::Static(12.0),
            },
        ];
        for e in &all {
            let route = e.animation_route();
            assert!(
                ["expression", "command", "stacked", "static"].contains(&route),
                "unknown route {route}"
            );
            // Every effect must compile without panicking.
            let _ = e.compile(2.0, 1920, 1080, 30);
        }
        assert_eq!(
            all.len(),
            47,
            "catalogue size changed — update the UI list too"
        );
    }

    /// Regression test: two animated effects of the same kind on one clip must
    /// not receive each other's commands. Each gets its own filter chain.
    #[test]
    fn two_animated_effects_of_one_kind_do_not_cross_talk() {
        let s = temp_source("xtalk");
        let ramp = |a: f64, b: f64| Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: a,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 2.0,
                    value: b,
                    easing: Easing::Linear,
                },
            ],
        };
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Blur {
            sigma: ramp(0.0, 5.0),
        });
        c.effects.push(Effect::Blur {
            sigma: ramp(10.0, 20.0),
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let args = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).unwrap();
        let graph = args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].clone();

        // Two command streams, and each lives in a separate chain.
        assert_eq!(
            graph.matches("sendcmd=c='").count(),
            2,
            "expected one stream per effect"
        );
        let chains: Vec<&str> = graph.split(';').collect();
        let with_cmds: Vec<&&str> = chains.iter().filter(|c| c.contains("sendcmd")).collect();
        assert_eq!(
            with_cmds.len(),
            2,
            "commands must be in separate chains: {graph}"
        );
        for chain in with_cmds {
            assert_eq!(
                chain.matches("gblur").count(),
                1,
                "a chain carrying commands must hold exactly one blur: {chain}"
            );
        }
    }

    /// Sampling follows the project frame rate, so a "sampled" route lands one
    /// value per rendered frame.
    #[test]
    fn sampling_matches_the_project_frame_rate() {
        assert_eq!(sample_times(1.0, 30).len(), 30);
        assert_eq!(sample_times(2.0, 60).len(), 120);
        // Always at least two samples, and never unbounded.
        assert_eq!(sample_times(0.001, 30).len(), 2);
        assert_eq!(sample_times(9999.0, 60).len(), MAX_SAMPLES);
    }

    // ---- subtitles ----

    fn subs() -> Vec<Subtitle> {
        vec![
            Subtitle {
                id: "1".into(),
                start: 0.5,
                end: 2.0,
                text: "First line".into(),
            },
            Subtitle {
                id: "2".into(),
                start: 2.5,
                end: 4.0,
                text: "Second line".into(),
            },
        ]
    }

    #[test]
    fn srt_round_trips() {
        let srt = to_srt(&subs());
        assert!(srt.contains("00:00:00,500 --> 00:00:02,000"), "{srt}");
        assert!(srt.contains("First line"));

        let back = from_srt(&srt);
        assert_eq!(back.len(), 2);
        assert!((back[0].start - 0.5).abs() < 1e-3);
        assert!((back[0].end - 2.0).abs() < 1e-3);
        assert_eq!(back[0].text, "First line");
        assert!((back[1].start - 2.5).abs() < 1e-3);
    }

    #[test]
    fn srt_parsing_survives_a_malformed_block() {
        let text = "1\n00:00:01,000 --> 00:00:02,000\nGood\n\n                    2\nnot a timing line\nBad\n\n                    3\n00:00:03,000 --> 00:00:04,000\nAlso good\n";
        let cues = from_srt(text);
        assert_eq!(cues.len(), 2, "one bad block must not cost the whole file");
        assert_eq!(cues[0].text, "Good");
        assert_eq!(cues[1].text, "Also good");
    }

    #[test]
    fn srt_handles_crlf_and_missing_index_lines() {
        let text = "00:00:01,000 --> 00:00:02,000\r\nNo index here\r\n";
        let cues = from_srt(text);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "No index here");
    }

    #[test]
    fn zero_length_and_empty_cues_are_dropped() {
        let bad = vec![
            Subtitle {
                id: "a".into(),
                start: 1.0,
                end: 1.0,
                text: "zero length".into(),
            },
            Subtitle {
                id: "b".into(),
                start: 2.0,
                end: 3.0,
                text: "   ".into(),
            },
        ];
        assert_eq!(from_srt(&to_srt(&bad)).len(), 0);
    }

    #[test]
    fn burned_subtitles_are_drawn_after_compositing() {
        let s = temp_source("sub1");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 5.0)])],
            ..Default::default()
        };
        p.subtitles = subs();
        p.subtitle_mode = SubtitleMode::Burn;
        let args = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).unwrap();
        let graph = args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].clone();
        assert!(graph.contains("drawtext=text='First line'"), "{graph}");
        assert!(graph.contains("enable='between(t,0.5000,2.0000)'"));
        // Drawn on the composited result, not on a single clip's chain.
        let sub_chain = graph.split(';').find(|c| c.contains("First line")).unwrap();
        assert!(
            sub_chain.contains("comp") || sub_chain.contains("base"),
            "subtitles must sit above every track: {sub_chain}"
        );
    }

    #[test]
    fn embedded_subtitles_add_a_muxed_stream() {
        let s = temp_source("sub2");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 5.0)])],
            ..Default::default()
        };
        p.subtitles = subs();
        p.subtitle_mode = SubtitleMode::Embed;
        let srt = scratch("odyssey-test-subs.srt");
        std::fs::write(&srt, to_srt(&p.subtitles)).unwrap();

        let args = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), Some(&srt)).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("mov_text"), "mp4 needs mov_text: {joined}");
        assert!(joined.contains("1:s:0"), "subtitle stream not mapped"); // one media input, so index 1
                                                                         // Embedding must not also burn the text into the picture.
        assert!(
            !joined.contains("drawtext=text='First line'"),
            "embed must not burn in"
        );
    }

    #[test]
    fn subtitles_off_changes_nothing() {
        let s = temp_source("sub3");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 5.0)])],
            ..Default::default()
        };
        p.subtitles = subs();
        p.subtitle_mode = SubtitleMode::Off;
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!joined.contains("First line"));
        assert!(!joined.contains("-c:s"));
    }

    /// Regression test: cue text reaches drawtext, so its escaping must hold.
    #[test]
    fn hostile_subtitle_text_cannot_break_the_filter() {
        let s = temp_source("sub4");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 5.0)])],
            ..Default::default()
        };
        p.subtitles = vec![Subtitle {
            id: "x".into(),
            start: 0.0,
            end: 1.0,
            text: "Hi: 'there', x=1:y=2".into(),
        }];
        p.subtitle_mode = SubtitleMode::Burn;
        let graph = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!graph.contains("text='Hi: 'there'"), "raw quote survived");
        assert!(graph.contains("\\:"), "colon not escaped");
    }

    // ---- grading, LUT, stabilisation, adjustment layers ----

    #[test]
    fn curves_compile_only_the_channels_that_have_points() {
        let s = temp_source("cv");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Curves {
            master: vec![(0.0, 0.0), (0.5, 0.7), (1.0, 1.0)],
            red: vec![],
            green: vec![],
            blue: vec![],
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g.contains("curves=master='0.0000/0.0000 0.5000/0.7000 1.0000/1.0000'"),
            "{g}"
        );
        assert!(!g.contains(":r='"), "an empty channel must not be emitted");
    }

    #[test]
    fn a_curve_with_one_point_is_inert() {
        let s = temp_source("cv1");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Curves {
            master: vec![(0.5, 0.5)],
            red: vec![],
            green: vec![],
            blue: vec![],
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!g.contains("curves="), "a single point defines no curve");
    }

    #[test]
    fn curve_points_are_clamped_to_the_unit_range() {
        let s = temp_source("cv2");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Curves {
            master: vec![(-5.0, 9.0), (1.0, 1.0)],
            red: vec![],
            green: vec![],
            blue: vec![],
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g.contains("0.0000/1.0000"),
            "out-of-range points must clamp: {g}"
        );
    }

    /// Guards against the render test passing vacuously: prove each new
    /// transition actually reaches the filter graph, by looking for the
    /// expression that is unique to it.
    #[test]
    fn each_transition_emits_its_own_expression() {
        let cases: Vec<(TransitionKind, &str)> = vec![
            (TransitionKind::WipeRight, "W*(1-min(1,T/"),
            (TransitionKind::WipeDown, "lt(Y,H*min(1,T/"),
            (TransitionKind::WipeUp, "gt(Y,H*(1-min(1,T/"),
            (TransitionKind::DiagonalWipe, "X+Y,(W+H)"),
            (TransitionKind::DipToWhite, "color=white"),
            (TransitionKind::IrisOpen, "hypot(X-W/2,Y-H/2)"),
            (TransitionKind::IrisClose, "hypot(X-W/2,Y-H/2)"),
            (TransitionKind::BarnDoorOpen, "abs(X-W/2)"),
            (TransitionKind::BarnDoorClose, "abs(X-W/2)"),
            (TransitionKind::ClockWipe, "atan2(Y-H/2,X-W/2)"),
            (TransitionKind::PixelDissolve, "random(X+Y*W)"),
            (TransitionKind::SlideLeft, "p(X-W*(1-min(1,T/"),
            (TransitionKind::SlideRight, "p(X+W*(1-min(1,T/"),
            (TransitionKind::SlideUp, "p(X,Y-H*(1-min(1,T/"),
            (TransitionKind::SlideDown, "p(X,Y+H*(1-min(1,T/"),
        ];
        let src = temp_source("transexpr");
        for (kind, needle) in cases {
            let a = media_clip("a", &src, 0.0, 0.0, 4.0);
            let mut b = media_clip("b", &src, 4.0, 2.0, 6.0);
            b.transition_in = Some(Transition {
                kind,
                duration: 1.0,
            });
            let p = Project {
                tracks: vec![video_track(vec![a, b])],
                ..Default::default()
            };
            let resolved = apply_transitions(&p);
            let g = render_args(&resolved, &profile(), Path::new("/tmp/o.mp4"), None)
                .unwrap()
                .join(" ");
            assert!(
                g.contains(needle),
                "{kind:?} did not emit {needle:?} into the graph"
            );
        }
    }

    #[test]
    fn colour_wheels_map_to_shadows_midtones_highlights() {
        let s = temp_source("cw");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::ColorWheels {
            lift_r: Param::Static(0.1),
            lift_g: p_zero(),
            lift_b: p_zero(),
            gamma_r: p_zero(),
            gamma_g: Param::Static(0.2),
            gamma_b: p_zero(),
            gain_r: p_zero(),
            gain_g: p_zero(),
            gain_b: Param::Static(0.3),
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("colorbalance=rs=0.100000"), "shadows: {g}");
        assert!(g.contains("gm=0.200000"), "midtones");
        assert!(g.contains("bh=0.300000"), "highlights");
    }

    #[test]
    fn animated_colour_wheels_are_driven_by_commands() {
        let s = temp_source("cwa");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::ColorWheels {
            lift_r: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: -0.3,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 2.0,
                        value: 0.3,
                        easing: Easing::Linear,
                    },
                ],
            },
            lift_g: p_zero(),
            lift_b: p_zero(),
            gamma_r: p_zero(),
            gamma_g: p_zero(),
            gamma_b: p_zero(),
            gain_r: p_zero(),
            gain_g: p_zero(),
            gain_b: p_zero(),
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("sendcmd"), "no command stream: {g}");
        assert!(g.contains("colorbalance rs"), "wheel not targeted");
    }

    #[test]
    fn an_empty_lut_path_is_inert() {
        let s = temp_source("lut0");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Lut3d { path: "   ".into() });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!g.contains("lut3d"), "an empty path must not reach ffmpeg");
    }

    /// Regression test: a path lands inside a filter string, where colon and
    /// quote are syntax.
    #[test]
    fn filter_paths_escape_their_syntax_characters() {
        assert_eq!(escape_filter_path("/tmp/plain.cube"), "/tmp/plain.cube");
        assert!(escape_filter_path("/tmp/a:b.cube").contains("\\:"));
        assert!(escape_filter_path("/tmp/it's.cube").contains("\\'"));
        assert!(escape_filter_path("/tmp/a,b.cube").contains("\\,"));
    }

    #[test]
    fn stabilisation_without_an_analysis_file_is_inert() {
        let s = temp_source("st0");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Stabilize {
            trf: String::new(),
            smoothing: 10.0,
            zoom: 0.0,
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!g.contains("vidstabtransform"), "nothing to transform by");
    }

    #[test]
    fn stabilisation_clamps_its_parameters() {
        let s = temp_source("st1");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Stabilize {
            trf: "/tmp/x.trf".into(),
            smoothing: 9999.0,
            zoom: 999.0,
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("smoothing=100"), "smoothing not clamped: {g}");
        assert!(g.contains("zoom=50.00"), "zoom not clamped");
    }

    #[test]
    fn loudness_is_an_audio_effect_and_lands_in_the_audio_chain() {
        let s = temp_source("ln");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Loudness { target: -14.0 });
        assert!(c.effects[0].is_audio());
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("loudnorm=I=-14.0"), "{g}");
        // It must not appear in the video chain.
        let vchain = g.split(';').find(|c| c.contains("[v0]")).unwrap_or("");
        assert!(!vchain.contains("loudnorm"));
    }

    #[test]
    fn zero_denoise_is_inert() {
        let s = temp_source("dn");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Denoise { strength: 0.0 });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!g.contains("hqdn3d"));
    }

    #[test]
    fn an_adjustment_layer_grades_the_composite_and_paints_nothing() {
        let s = temp_source("adj");
        let mut adj = media_clip("a", &s, 0.0, 0.0, 2.0);
        adj.source = Source::Adjustment;
        adj.effects.push(Effect::Color {
            brightness: Param::Static(-0.3),
            contrast: p_one(),
            saturation: p_one(),
            gamma: p_one(),
        });

        let mut t2 = video_track(vec![adj]);
        t2.id = "t2".into();
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]), t2],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g.contains("eq=brightness="),
            "the adjustment did not compile: {g}"
        );
        // It contributes no layer of its own, so only one overlay happens.
        assert_eq!(
            g.matches("overlay=").count(),
            1,
            "an adjustment layer must not overlay"
        );
        assert!(
            g.contains("enable='between(t,0.0000,2.0000)'"),
            "not gated to its span"
        );
    }

    #[test]
    fn an_adjustment_layer_with_no_effects_does_nothing() {
        let s = temp_source("adj0");
        let mut adj = media_clip("a", &s, 0.0, 0.0, 2.0);
        adj.source = Source::Adjustment;
        let mut t2 = video_track(vec![adj]);
        t2.id = "t2".into();
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]), t2],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert_eq!(g.matches("overlay=").count(), 1);
    }

    #[test]
    fn a_still_frame_loops_a_single_image() {
        let png = scratch("odyssey-still.png");
        {
            use std::io::Write;
            std::fs::File::create(&png)
                .unwrap()
                .write_all(b"x")
                .unwrap();
        }
        let mut c = media_clip("1", &png, 0.0, 0.0, 3.0);
        c.source = Source::Still {
            path: png.to_string_lossy().to_string(),
        };
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let args = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-loop 1"), "a still must loop: {joined}");
        assert!(joined.contains("-t 3.0000"), "held for the clip duration");
    }

    #[test]
    fn hardware_profiles_use_a_bitrate_not_a_crf() {
        for p in hardware_profiles() {
            assert!(p.crf.is_none(), "{} should not use CRF", p.id);
            assert!(p.video_bitrate.is_some(), "{} needs a bitrate", p.id);
            assert!(p.id.starts_with("hw-"));
        }
    }

    #[test]
    fn render_zone_rejects_an_empty_or_barren_span() {
        let s = temp_source("rz");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)])],
            ..Default::default()
        };
        assert!(render_zone(&p, &profile(), Path::new("/tmp/o.mp4"), 5.0, 5.0).is_err());
        assert!(render_zone(&p, &profile(), Path::new("/tmp/o.mp4"), 50.0, 60.0).is_err());
    }

    // ---- track compositing, transitions, interchange, autosave ----

    #[test]
    fn track_opacity_multiplies_into_the_clip() {
        let s = temp_source("topa");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.motion.opacity = Param::Static(0.5);
        let mut t = video_track(vec![c]);
        t.opacity = 0.5;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g.contains("colorchannelmixer=aa=0.250000"),
            "0.5 clip under a 0.5 track should be 0.25: {g}"
        );
    }

    #[test]
    fn track_opacity_scales_a_keyframed_clip_opacity() {
        let s = temp_source("topk");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.motion.opacity = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 0.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 2.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let mut t = video_track(vec![c]);
        t.opacity = 0.5;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        // The animation survives, scaled: it must never reach full opacity.
        assert!(
            g.contains("sendcmd"),
            "keyframes should still drive commands"
        );
        assert!(
            !g.contains("colorchannelmixer aa 1.000000"),
            "track dimming was ignored: {g}"
        );
    }

    #[test]
    fn a_track_blend_applies_when_the_clip_is_normal() {
        let s = temp_source("tblend");
        let mut t = video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)]);
        t.blend = BlendMode::Screen;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("blend=all_mode=screen"), "{g}");
    }

    #[test]
    fn a_clip_blend_overrides_its_track() {
        let s = temp_source("cblend");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.blend = BlendMode::Multiply;
        let mut t = video_track(vec![c]);
        t.blend = BlendMode::Screen;
        let p = Project {
            tracks: vec![t],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("all_mode=multiply"), "the clip should win: {g}");
        assert!(!g.contains("all_mode=screen"));
    }

    #[test]
    fn speed_can_keep_or_shift_pitch() {
        let s = temp_source("pitch");
        let mut keep = media_clip("1", &s, 0.0, 0.0, 4.0);
        keep.speed = Param::Static(2.0);
        let p1 = Project {
            tracks: vec![video_track(vec![keep])],
            ..Default::default()
        };
        let g1 = render_args(&p1, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g1.contains("atempo=2"),
            "pitch-preserving speed uses atempo"
        );
        assert!(!g1.contains("asetrate"));

        let mut shift = media_clip("1", &s, 0.0, 0.0, 4.0);
        shift.speed = Param::Static(2.0);
        shift.preserve_pitch = false;
        let p2 = Project {
            tracks: vec![video_track(vec![shift])],
            ..Default::default()
        };
        let g2 = render_args(&p2, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g2.contains("asetrate"),
            "pitch-shifting speed resamples: {g2}"
        );
        assert!(!g2.contains("atempo"));
    }

    #[test]
    fn a_dissolve_fades_the_incoming_clip_alpha() {
        let s = temp_source("tr1");
        let mut c = media_clip("1", &s, 0.0, 0.0, 3.0);
        c.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 0.6,
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("fade=t=in:st=0:d=0.6000:alpha=1"), "{g}");
    }

    #[test]
    fn a_dip_to_black_does_not_use_alpha() {
        let s = temp_source("tr2");
        let mut c = media_clip("1", &s, 0.0, 0.0, 3.0);
        c.transition_in = Some(Transition {
            kind: TransitionKind::DipToBlack,
            duration: 0.4,
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("fade=t=in:st=0:d=0.4000"));
        assert!(
            !g.contains("d=0.4000:alpha=1"),
            "dipping goes through the background"
        );
    }

    #[test]
    fn a_transition_is_clamped_to_the_clip_length() {
        let s = temp_source("tr3");
        let mut c = media_clip("1", &s, 0.0, 0.0, 1.0);
        c.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 99.0,
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("d=1.0000:alpha=1"), "not clamped: {g}");
    }

    #[test]
    fn ducking_compresses_one_track_against_another() {
        let s = temp_source("duck");
        let mut music = video_track(vec![media_clip("m", &s, 0.0, 0.0, 4.0)]);
        music.id = "music".into();
        let mut voice = video_track(vec![media_clip("v", &s, 0.0, 0.0, 4.0)]);
        voice.id = "voice".into();
        music.duck_under = Some("voice".into());

        let p = Project {
            tracks: vec![music, voice],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g.contains("sidechaincompress"),
            "no ducking in the graph: {g}"
        );
        // The key track must still be audible as well as keying.
        assert!(
            g.contains("asplit=2"),
            "the key track was consumed rather than copied"
        );
    }

    #[test]
    fn ducking_against_a_missing_track_is_ignored() {
        let s = temp_source("duck0");
        let mut music = video_track(vec![media_clip("m", &s, 0.0, 0.0, 2.0)]);
        music.duck_under = Some("nope".into());
        let p = Project {
            tracks: vec![music],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!g.contains("sidechaincompress"));
    }

    #[test]
    fn edl_export_lists_cuts_in_order() {
        let s = temp_source("edl");
        let p = Project {
            tracks: vec![video_track(vec![
                media_clip("b", &s, 4.0, 0.0, 2.0),
                media_clip("a", &s, 0.0, 0.0, 2.0),
            ])],
            fps: 25,
            ..Default::default()
        };
        let edl = to_edl(&p, "Test");
        assert!(edl.starts_with("TITLE: Test"), "{edl}");
        assert!(edl.contains("FCM: NON-DROP FRAME"));
        let first = edl.find("001").unwrap();
        let second = edl.find("002").unwrap();
        assert!(first < second, "events must be numbered in timeline order");
        // 4s at 25fps is 00:00:04:00.
        assert!(
            edl.contains("00:00:04:00"),
            "record-in timecode wrong: {edl}"
        );
    }

    #[test]
    fn edl_skips_adjustment_layers() {
        let s = temp_source("edl2");
        let mut adj = media_clip("adj", &s, 0.0, 0.0, 2.0);
        adj.source = Source::Adjustment;
        let p = Project {
            tracks: vec![video_track(vec![adj, media_clip("a", &s, 2.0, 0.0, 2.0)])],
            ..Default::default()
        };
        let edl = to_edl(&p, "T");
        assert_eq!(
            edl.matches("FROM CLIP NAME").count(),
            1,
            "an adjustment layer is not an edit: {edl}"
        );
    }

    #[test]
    fn otio_export_keeps_every_track_and_fills_gaps() {
        let s = temp_source("otio");
        let mut audio = video_track(vec![media_clip("x", &s, 0.0, 0.0, 1.0)]);
        audio.kind = TrackKind::Audio;
        audio.id = "a".into();
        let p = Project {
            // A clip starting at 2s leaves a gap OTIO has to make explicit.
            tracks: vec![video_track(vec![media_clip("a", &s, 2.0, 0.0, 2.0)]), audio],
            ..Default::default()
        };
        let json = to_otio(&p, "Test");
        let doc: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(doc["OTIO_SCHEMA"], "Timeline.1");
        let tracks = doc["tracks"]["children"].as_array().unwrap();
        assert_eq!(tracks.len(), 2, "both tracks must survive");
        assert_eq!(tracks[1]["kind"], "Audio");
        let kinds: Vec<&str> = tracks[0]["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["OTIO_SCHEMA"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec!["Gap.1", "Clip.1"],
            "the leading gap must be explicit"
        );
    }

    #[test]
    fn autosave_writes_restores_and_prunes() {
        let dir = scratch("odyssey-autosave-test");
        let _ = std::fs::remove_dir_all(&dir);
        let s = temp_source("as");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)])],
            ..Default::default()
        };
        p.markers.push(Marker {
            id: "m".into(),
            time: 1.0,
            name: "cue".into(),
            colour: "#fff".into(),
        });

        let path = autosave(&p, "item1", &dir).unwrap();
        assert!(Path::new(&path).exists());

        let restored = restore_autosave(&path).unwrap();
        assert_eq!(restored.markers.len(), 1);
        assert_eq!(restored.markers[0].name, "cue");
        assert_eq!(restored.clip_count(), 1);

        // Snapshots for another item must not be listed or pruned with ours.
        autosave(&p, "item2", &dir).unwrap();
        assert_eq!(autosaves("item2", &dir).len(), 1);
        assert!(!autosaves("item1", &dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- transitions that actually overlap ----

    #[test]
    fn a_transition_overlaps_adjacent_clips_on_one_track() {
        let s = temp_source("xfade");
        // Two clips butted together, the second with head handles to spare.
        let a = media_clip("a", &s, 0.0, 0.0, 4.0);
        let mut b = media_clip("b", &s, 4.0, 2.0, 6.0);
        b.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 1.0,
        });

        let p = Project {
            tracks: vec![video_track(vec![a, b])],
            ..Default::default()
        };
        let resolved = apply_transitions(&p);
        let clips = &resolved.tracks[0].clips;

        let incoming = clips.iter().find(|c| c.id == "b").unwrap();
        let outgoing = clips.iter().find(|c| c.id == "a").unwrap();
        assert!(
            (incoming.start - 3.0).abs() < 1e-6,
            "the incoming clip should be pulled back by the transition: {}",
            incoming.start
        );
        assert!(
            (incoming.in_point - 1.0).abs() < 1e-6,
            "and consume its head handle: {}",
            incoming.in_point
        );
        assert!(
            (outgoing.out_point - 5.0).abs() < 1e-6,
            "the outgoing clip should be extended to play underneath: {}",
            outgoing.out_point
        );
        assert!(
            outgoing.end() > incoming.start,
            "they must actually overlap, or there is nothing to dissolve from"
        );
    }

    #[test]
    fn a_transition_without_handles_is_shortened_rather_than_invented() {
        let s = temp_source("xfade0");
        let a = media_clip("a", &s, 0.0, 0.0, 4.0);
        // in_point 0 means no head handle at all.
        let mut b = media_clip("b", &s, 4.0, 0.0, 4.0);
        b.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 1.0,
        });

        let p = Project {
            tracks: vec![video_track(vec![a, b])],
            ..Default::default()
        };
        let resolved = apply_transitions(&p);
        let incoming = resolved.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "b")
            .unwrap();
        assert!(
            (incoming.start - 4.0).abs() < 1e-6,
            "with no handles the clip must not move: {}",
            incoming.start
        );
        assert!(
            incoming.in_point >= 0.0,
            "and must never seek before the start of the source"
        );
    }

    #[test]
    fn a_transition_is_limited_by_the_shorter_neighbour() {
        let s = temp_source("xfade1");
        // The outgoing clip is only 0.5s, so a 2s dissolve cannot consume it.
        let a = media_clip("a", &s, 0.0, 0.0, 0.5);
        let mut b = media_clip("b", &s, 0.5, 4.0, 8.0);
        b.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 2.0,
        });

        let p = Project {
            tracks: vec![video_track(vec![a, b])],
            ..Default::default()
        };
        let resolved = apply_transitions(&p);
        let incoming = resolved.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "b")
            .unwrap();
        let overlap = incoming.transition_in.as_ref().unwrap().duration;
        assert!(
            overlap <= 0.5 + 1e-6,
            "overlap exceeded the outgoing clip: {overlap}"
        );
    }

    #[test]
    fn non_adjacent_clips_are_left_alone() {
        let s = temp_source("xfade2");
        let a = media_clip("a", &s, 0.0, 0.0, 2.0);
        // A gap between them: this is a fade up, not a cross dissolve.
        let mut b = media_clip("b", &s, 5.0, 2.0, 6.0);
        b.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 1.0,
        });

        let p = Project {
            tracks: vec![video_track(vec![a, b])],
            ..Default::default()
        };
        let resolved = apply_transitions(&p);
        let incoming = resolved.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "b")
            .unwrap();
        assert!(
            (incoming.start - 5.0).abs() < 1e-6,
            "a clip across a gap must not move"
        );
    }

    #[test]
    fn ducking_parameters_reach_the_filter() {
        let s = temp_source("duckp");
        let mut music = video_track(vec![media_clip("m", &s, 0.0, 0.0, 4.0)]);
        music.id = "music".into();
        music.duck_under = Some("voice".into());
        music.duck_threshold = 0.2;
        music.duck_ratio = 12.0;
        music.duck_attack = 5.0;
        music.duck_release = 800.0;
        let mut voice = video_track(vec![media_clip("v", &s, 0.0, 0.0, 4.0)]);
        voice.id = "voice".into();

        let p = Project {
            tracks: vec![music, voice],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("threshold=0.2000"), "threshold not applied: {g}");
        assert!(g.contains("ratio=12.00"));
        assert!(g.contains("attack=5.0"));
        assert!(g.contains("release=800.0"));
    }

    #[test]
    fn ducking_parameters_are_clamped_to_what_ffmpeg_accepts() {
        let s = temp_source("duckc");
        let mut music = video_track(vec![media_clip("m", &s, 0.0, 0.0, 2.0)]);
        music.id = "music".into();
        music.duck_under = Some("voice".into());
        music.duck_ratio = 9999.0;
        music.duck_threshold = 50.0;
        let mut voice = video_track(vec![media_clip("v", &s, 0.0, 0.0, 2.0)]);
        voice.id = "voice".into();
        let p = Project {
            tracks: vec![music, voice],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("ratio=20.00"), "ratio not clamped: {g}");
        assert!(g.contains("threshold=1.0000"), "threshold not clamped");
    }

    // ---- channels, nesting, queue, presets ----

    #[test]
    fn channel_mapping_picks_source_channels() {
        let s = temp_source("chan");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.channels = vec![1];
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            g.contains("pan=mono|c0=c1"),
            "one channel should fold to mono: {g}"
        );
    }

    #[test]
    fn two_channels_map_to_stereo() {
        let s = temp_source("chan2");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.channels = vec![2, 3];
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(g.contains("pan=stereo|c0=c2|c1=c3"), "{g}");
    }

    #[test]
    fn no_channel_mapping_leaves_the_audio_alone() {
        let s = temp_source("chan0");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)])],
            ..Default::default()
        };
        let g = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(!g.contains("pan="));
    }

    #[test]
    fn an_unflattened_nested_sequence_is_refused_rather_than_rendered_wrong() {
        let s = temp_source("nest0");
        let mut c = media_clip("n", &s, 0.0, 0.0, 2.0);
        c.source = Source::Nested {
            name: "Insert".into(),
            project: Box::new(Project::default()),
        };
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let err = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).unwrap_err();
        assert!(err.to_string().contains("not flattened"), "{err}");
    }

    #[test]
    fn an_empty_nested_sequence_is_reported_by_name() {
        let s = temp_source("nest1");
        let mut c = media_clip("n", &s, 0.0, 0.0, 2.0);
        c.source = Source::Nested {
            name: "Insert".into(),
            project: Box::new(Project::default()),
        };
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let dir = scratch("odyssey-nest-empty");
        let err = flatten_nested(&p, &dir).unwrap_err();
        assert!(
            err.to_string().contains("Insert"),
            "the name should be in the error: {err}"
        );
    }

    #[test]
    fn presets_save_load_and_delete() {
        let dir = scratch("odyssey-presets-test");
        let _ = std::fs::remove_dir_all(&dir);

        let mut p = profile();
        p.id = "my custom!!".into();
        p.label = "My custom".into();
        save_preset(&p, &dir).unwrap();

        let loaded = load_presets(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].label, "My custom");

        delete_preset("my custom!!", &dir).unwrap();
        assert!(load_presets(&dir).is_empty(), "the preset should be gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_preset_without_a_name_is_refused() {
        let dir = scratch("odyssey-presets-empty");
        let mut p = profile();
        p.id = "!!!".into();
        // Every character is replaced, but the result is still non-empty.
        assert!(save_preset(&p, &dir).is_ok());
        p.id = String::new();
        assert!(save_preset(&p, &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_job_does_not_abandon_the_queue() {
        let s = temp_source("queue");
        let good = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 1.0)])],
            width: 64,
            height: 48,
            fps: 10,
            ..Default::default()
        };
        // An empty project cannot render, so this job must fail on its own.
        let bad = Project::default();

        let jobs = vec![
            RenderJob {
                id: "a".into(),
                name: "bad".into(),
                project: bad,
                profile: preview_profile(),
                output: "/tmp/odyssey-q-bad.webm".into(),
                zone: None,
            },
            RenderJob {
                id: "b".into(),
                name: "good".into(),
                project: good,
                profile: preview_profile(),
                output: "/tmp/odyssey-q-good.webm".into(),
                zone: None,
            },
        ];
        let dir = scratch("odyssey-queue-cache");
        let results = run_queue(&jobs, &dir);

        assert_eq!(results.len(), 2, "every job must report an outcome");
        assert!(!results[0].ok, "the empty project should fail");
        assert!(!results[0].detail.is_empty(), "a failure must say why");
        assert_eq!(results[1].name, "good");
        assert!(results.iter().all(|r| r.seconds >= 0.0));
    }

    // ---- timeline preview rendering ----

    #[test]
    fn slicing_drops_clips_outside_the_range() {
        let s = temp_source("sl1");
        let p = Project {
            tracks: vec![video_track(vec![
                media_clip("a", &s, 0.0, 0.0, 2.0),  // 0..2
                media_clip("b", &s, 5.0, 0.0, 2.0),  // 5..7
                media_clip("c", &s, 20.0, 0.0, 2.0), // 20..22
            ])],
            ..Default::default()
        };
        let cut = slice(&p, 4.0, 10.0);
        let ids: Vec<&str> = cut.tracks[0].clips.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["b"], "only the overlapping clip survives");
        // And it is rebased so the slice starts at zero.
        assert_eq!(cut.tracks[0].clips[0].start, 1.0);
    }

    #[test]
    fn slicing_trims_a_clip_that_straddles_the_start() {
        let s = temp_source("sl2");
        // Clip runs 0..10 on the timeline, sourced from 0..10.
        let p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 10.0)])],
            ..Default::default()
        };
        let cut = slice(&p, 4.0, 8.0);
        let c = &cut.tracks[0].clips[0];
        assert_eq!(c.start, 0.0, "rebased to the slice");
        assert!(
            (c.in_point - 4.0).abs() < 1e-6,
            "head trimmed into the source"
        );
        assert!((c.out_point - 8.0).abs() < 1e-6, "tail trimmed");
        assert!((c.duration() - 4.0).abs() < 1e-6);
    }

    #[test]
    fn slicing_respects_a_speed_ramp_when_trimming() {
        let s = temp_source("sl3");
        let mut c = media_clip("a", &s, 0.0, 0.0, 8.0);
        // Ramp from 1x to 4x across the source.
        c.speed = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 8.0,
                    value: 4.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let out_len = c.duration();
        // Cut the first half of the OUTPUT, which is not the first half of the
        // source, because the clip accelerates.
        let half = out_len / 2.0;
        let expected_in = c.source_time_at(half);
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };

        let cut = slice(&p, half, out_len);
        let sliced = &cut.tracks[0].clips[0];
        assert!(
            (sliced.in_point - expected_in).abs() < 1e-6,
            "trim must follow the ramp: got {}, expected {expected_in}",
            sliced.in_point
        );
        assert!(
            expected_in > half,
            "an accelerating clip is further into the source than the output time"
        );
    }

    #[test]
    fn a_preview_key_is_stable_for_the_same_content() {
        let s = temp_source("pk1");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 4.0)])],
            ..Default::default()
        };
        let k1 = preview_key(&p, 0.0, 4.0, 0.5);
        let k2 = preview_key(&p, 0.0, 4.0, 0.5);
        assert_eq!(k1, k2, "same content must hash the same");
    }

    #[test]
    fn a_preview_key_changes_when_the_range_content_changes() {
        let s = temp_source("pk2");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 4.0)])],
            ..Default::default()
        };
        let before = preview_key(&p, 0.0, 4.0, 0.5);
        p.tracks[0].clips[0].effects.push(Effect::Blur {
            sigma: Param::Static(6.0),
        });
        assert_ne!(
            before,
            preview_key(&p, 0.0, 4.0, 0.5),
            "an edit must invalidate the chunk"
        );
    }

    /// An edit outside the range must NOT invalidate a rendered chunk, or
    /// preview rendering would be useless on a long timeline.
    #[test]
    fn an_edit_outside_the_range_keeps_the_key() {
        let s = temp_source("pk3");
        let mut p = Project {
            tracks: vec![video_track(vec![
                media_clip("a", &s, 0.0, 0.0, 4.0),
                media_clip("b", &s, 30.0, 0.0, 4.0),
            ])],
            ..Default::default()
        };
        let before = preview_key(&p, 0.0, 4.0, 0.5);
        p.tracks[0].clips[1].effects.push(Effect::Blur {
            sigma: Param::Static(6.0),
        });
        assert_eq!(
            before,
            preview_key(&p, 0.0, 4.0, 0.5),
            "a distant edit must not invalidate"
        );
    }

    #[test]
    fn changing_frame_geometry_invalidates_the_key() {
        let s = temp_source("pk4");
        let mut p = Project {
            tracks: vec![video_track(vec![media_clip("a", &s, 0.0, 0.0, 4.0)])],
            ..Default::default()
        };
        let before = preview_key(&p, 0.0, 4.0, 0.5);
        p.fps = 60;
        assert_ne!(before, preview_key(&p, 0.0, 4.0, 0.5));
    }

    #[test]
    fn an_empty_range_is_rejected() {
        let p = Project::default();
        let dir = scratch("odyssey-preview-empty");
        assert!(render_preview(&p, 5.0, 5.0, 0.5, &dir).is_err());
        assert!(
            render_preview(&p, 0.0, 2.0, 0.5, &dir).is_err(),
            "no clips in range"
        );
    }

    // ---- frei0r ----

    #[test]
    fn frei0r_effects_compile_to_a_plugin_call() {
        let s = temp_source("f0");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Frei0r {
            name: "glow".into(),
            params: vec![Param::Static(0.4)],
        });
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let joined = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(joined.contains("frei0r=filter_name=glow"), "{joined}");
        assert!(joined.contains("filter_params=0.400000"));
    }

    /// Regression test: a plugin name is interpolated into the filter graph.
    #[test]
    fn hostile_frei0r_plugin_names_are_rejected() {
        assert_eq!(sanitise_plugin("glow"), "glow");
        assert_eq!(sanitise_plugin("alpha0ps_alphagrad"), "alpha0ps_alphagrad");
        assert_eq!(sanitise_plugin("glow:x=1"), "");
        assert_eq!(sanitise_plugin("../../etc/passwd"), "");
        assert_eq!(sanitise_plugin("'; rm -rf /"), "");
        assert_eq!(sanitise_plugin(""), "");
    }

    // ---- time remapping ----

    #[test]
    fn constant_speed_is_a_single_segment() {
        let s = temp_source("sp1");
        let mut c = media_clip("1", &s, 0.0, 0.0, 4.0);
        c.speed = Param::Static(2.0);
        assert_eq!(c.segments().len(), 1);
        assert_eq!(c.duration(), 2.0);
    }

    #[test]
    fn a_speed_ramp_becomes_many_segments() {
        let s = temp_source("sp2");
        let mut c = media_clip("1", &s, 0.0, 0.0, 4.0);
        c.speed = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 4.0,
                    value: 4.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let segs = c.segments();
        assert!(segs.len() > 8, "ramp not subdivided: {}", segs.len());
        // Speeding up must shorten the clip, and bound it by the extremes:
        // 4s of source between 1x and 4x lies between 1s and 4s of timeline.
        let d = c.duration();
        assert!(d > 1.0 && d < 4.0, "ramped duration out of range: {d}");
        // Segments must tile the source without gaps.
        for w in segs.windows(2) {
            assert!(
                (w[0].src_end - w[1].src_start).abs() < 1e-6,
                "gap between segments"
            );
            assert!(
                (w[0].out_offset + w[0].out_len - w[1].out_offset).abs() < 1e-6,
                "gap on timeline"
            );
        }
        assert!((segs[0].speed - 1.0).abs() < 0.3, "starts near 1x");
        assert!(
            (segs[segs.len() - 1].speed - 4.0).abs() < 0.3,
            "ends near 4x"
        );
    }

    #[test]
    fn a_ramped_clip_renders_one_input_per_segment() {
        let s = temp_source("sp3");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.speed = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 2.0,
                    value: 2.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let segs = c.segments().len();
        let p = Project {
            tracks: vec![video_track(vec![c])],
            ..Default::default()
        };
        let args = render_args(&p, &profile(), Path::new("/tmp/o.mp4"), None).unwrap();
        assert_eq!(
            args.iter().filter(|a| *a == "-i").count(),
            segs,
            "expected one input per segment"
        );
        let joined = args.join(" ");
        assert_eq!(
            joined.matches("overlay=").count(),
            segs,
            "each segment composites"
        );
    }

    #[test]
    fn a_slow_ramp_lengthens_the_clip() {
        let s = temp_source("sp4");
        let mut c = media_clip("1", &s, 0.0, 0.0, 2.0);
        c.speed = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 2.0,
                    value: 0.25,
                    easing: Easing::Linear,
                },
            ],
        };
        assert!(
            c.duration() > 2.0,
            "slowing down must lengthen: {}",
            c.duration()
        );
    }

    #[test]
    fn every_render_profile_builds_a_valid_argument_vector() {
        let s = temp_source("l");
        let p = Project {
            tracks: vec![video_track(vec![media_clip("1", &s, 0.0, 0.0, 2.0)])],
            ..Default::default()
        };
        for profile in render_profiles() {
            let args = render_args(&p, &profile, Path::new("/tmp/out"), None).unwrap();
            assert!(
                args.contains(&"-filter_complex".to_string()),
                "{} has no graph",
                profile.id
            );
            assert!(
                args.last().unwrap().contains("out"),
                "{} lost its output",
                profile.id
            );
        }
    }
}

/// End-to-end tests that actually invoke ffmpeg. They generate their own
/// source media, render a real project and probe the result, so they catch
/// filter graphs that are well-formed strings but invalid to ffmpeg.
#[cfg(test)]
mod e2e {
    use super::tests::scratch;
    use super::*;
    use std::io::Write;

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().is_ok()
    }

    /// Generate a real, decodable test clip with video and audio.
    fn make_media(name: &str, secs: f64) -> PathBuf {
        let path = scratch(&format!("odyssey-e2e-{name}.mp4"));
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("testsrc=size=320x240:rate=30:duration={secs}"),
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency=440:duration={secs}"),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&path)
            .status()
            .expect("ffmpeg should run");
        assert!(status.success(), "could not build test media");
        path
    }

    fn probe_duration(path: &Path) -> f64 {
        let out = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(path)
            .output()
            .expect("ffprobe should run");
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(-1.0)
    }

    fn probe_streams(path: &Path) -> String {
        let out = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(path)
            .output()
            .expect("ffprobe should run");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn clip(id: &str, src: &Path, start: f64, a: f64, b: f64) -> Clip {
        Clip {
            id: id.into(),
            source: Source::Media {
                path: src.to_string_lossy().to_string(),
            },
            start,
            in_point: a,
            out_point: b,
            speed: Param::Static(1.0),
            reverse: false,
            gain: 1.0,
            muted: false,
            effects: vec![],
            motion: Motion::default(),
            blend: BlendMode::Normal,
            channels: vec![],
            preserve_pitch: true,
            transition_in: None,
        }
    }

    fn track(id: &str, clips: Vec<Clip>) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind: TrackKind::Video,
            clips,
            muted: false,
            hidden: false,
            locked: false,
            solo: false,
            volume: 1.0,
            opacity: 1.0,
            blend: BlendMode::Normal,
            targeted: false,
            duck_under: None,
            duck_threshold: 0.05,
            duck_ratio: 8.0,
            duck_attack: 20.0,
            duck_release: 300.0,
        }
    }

    fn fast_profile() -> RenderProfile {
        render_profiles()
            .into_iter()
            .find(|p| p.id == "mp4-h264-fast")
            .unwrap()
    }

    #[test]
    fn renders_a_two_track_project_with_effects_and_keyframes() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg missing — skipping");
            return;
        }
        let a = make_media("a", 3.0);
        let b = make_media("b", 3.0);

        // Track 1: a 2s clip, brightness animated across its length.
        let mut c1 = clip("c1", &a, 0.0, 0.0, 2.0);
        c1.effects.push(Effect::Color {
            brightness: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: -0.5,
                        easing: Easing::EaseInOut,
                    },
                    Keyframe {
                        time: 2.0,
                        value: 0.3,
                        easing: Easing::Linear,
                    },
                ],
            },
            contrast: Param::Static(1.2),
            saturation: Param::Static(1.0),
            gamma: Param::Static(1.0),
        });
        c1.effects.push(Effect::Fade {
            in_secs: 0.5,
            out_secs: 0.5,
        });

        // Track 2: a half-opacity overlay starting at 1s, at double speed.
        let mut c2 = clip("c2", &b, 1.0, 0.0, 2.0);
        c2.speed = Param::Static(2.0);
        c2.effects.push(Effect::Opacity {
            level: Param::Static(0.5),
        });

        let project = Project {
            tracks: vec![track("V1", vec![c1]), track("V2", vec![c2])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };

        // V1 ends at 2.0; V2 starts at 1.0 and runs 1.0s at double speed.
        assert_eq!(project.duration(), 2.0);

        let out = scratch("odyssey-e2e-out.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("render failed:\n{e}"));

        let dur = probe_duration(Path::new(&rendered));
        assert!((dur - 2.0).abs() < 0.35, "expected ~2.0s, got {dur}");
        let streams = probe_streams(Path::new(&rendered));
        assert!(streams.contains("video"), "no video stream: {streams}");
        assert!(streams.contains("audio"), "no audio stream: {streams}");
    }

    #[test]
    fn renders_a_title_card_with_no_source_file() {
        if !ffmpeg_available() {
            return;
        }
        let project = Project {
            tracks: vec![track(
                "V1",
                vec![Clip {
                    id: "title".into(),
                    source: Source::Title {
                        text: "Odyssey Design".into(),
                        background: "#101820".into(),
                        size: 36.0,
                        color: "white".into(),
                    },
                    start: 0.0,
                    in_point: 0.0,
                    out_point: 1.5,
                    speed: Param::Static(1.0),
                    reverse: false,
                    gain: 1.0,
                    muted: false,
                    effects: vec![Effect::Fade {
                        in_secs: 0.3,
                        out_secs: 0.3,
                    }],
                    motion: Motion::default(),
                    blend: BlendMode::Normal,
                    channels: vec![],
                    preserve_pitch: true,
                    transition_in: None,
                }],
            )],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-title.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("title render failed:\n{e}"));
        let dur = probe_duration(Path::new(&rendered));
        assert!((dur - 1.5).abs() < 0.35, "expected ~1.5s, got {dur}");
    }

    #[test]
    fn a_clip_positioned_later_leaves_the_gap_before_it() {
        if !ffmpeg_available() {
            return;
        }
        let a = make_media("gapsrc", 2.0);
        let project = Project {
            tracks: vec![track("V1", vec![clip("c", &a, 2.0, 0.0, 1.0)])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        assert_eq!(project.duration(), 3.0);
        let out = scratch("odyssey-e2e-gap.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("gap render failed:\n{e}"));
        let dur = probe_duration(Path::new(&rendered));
        assert!((dur - 3.0).abs() < 0.35, "gap not preserved: got {dur}");
    }

    /// A filename containing shell metacharacters must render normally.
    #[test]
    fn renders_a_file_whose_name_contains_shell_metacharacters() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("plain", 1.5);
        let nasty = scratch("odyssey e2e; echo pwned $(id).mp4");
        std::fs::copy(&src, &nasty).unwrap();

        let project = Project {
            tracks: vec![track("V1", vec![clip("c", &nasty, 0.0, 0.0, 1.0)])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-nasty.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("hostile filename render failed:\n{e}"));
        assert!(probe_duration(Path::new(&rendered)) > 0.5);
        std::fs::remove_file(&nasty).ok();
    }

    /// Rendering over a source file must fail loudly rather than destroy it.
    #[test]
    fn refuses_to_render_onto_its_own_source() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("selfout", 1.0);
        let project = Project {
            tracks: vec![track("V1", vec![clip("c", &src, 0.0, 0.0, 1.0)])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let err = render_args(&project, &fast_profile(), &src, None).unwrap_err();
        assert!(
            err.to_string().contains("also a source clip"),
            "unclear error: {err}"
        );
        // And the source is still intact.
        assert!(probe_duration(&src) > 0.5, "source was damaged");
    }

    /// sendcmd-driven animation must survive a real render.
    #[test]
    fn renders_an_animated_blur_through_sendcmd() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("blur", 2.0);
        let mut c = clip("c", &src, 0.0, 0.0, 2.0);
        c.effects.push(Effect::Blur {
            sigma: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.5,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 2.0,
                        value: 12.0,
                        easing: Easing::EaseInOut,
                    },
                ],
            },
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-blur-out.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("animated blur failed:\n{e}"));
        assert!((probe_duration(Path::new(&rendered)) - 2.0).abs() < 0.35);
    }

    /// Stacked, timeline-gated animation for a filter with no runtime options.
    #[test]
    fn renders_an_animated_sharpen_by_stacking() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("sharp", 1.0);
        let mut c = clip("c", &src, 0.0, 0.0, 1.0);
        c.effects.push(Effect::Sharpen {
            amount: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.0,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 1.0,
                        value: 2.5,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-sharp-out.mp4");
        render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("stacked sharpen failed:\n{e}"));
    }

    #[test]
    fn renders_an_animated_vignette_and_opacity() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("vig", 1.5);
        let mut c = clip("c", &src, 0.0, 0.0, 1.5);
        c.effects.push(Effect::Vignette {
            angle: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.1,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 1.5,
                        value: 1.2,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        c.effects.push(Effect::Opacity {
            level: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 0.2,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 1.5,
                        value: 1.0,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-vig-out.mp4");
        render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("animated vignette/opacity failed:\n{e}"));
    }

    /// Time remapping: a speed ramp renders and lands at the expected length.
    #[test]
    fn renders_a_speed_ramp() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("ramp", 4.0);
        let mut c = clip("c", &src, 0.0, 0.0, 4.0);
        c.speed = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: 1.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 4.0,
                    value: 4.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let expected = c.duration();
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-ramp-out.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("speed ramp failed:\n{e}"));
        let dur = probe_duration(Path::new(&rendered));
        assert!(
            (dur - expected).abs() < 0.4,
            "ramp length wrong: got {dur}, expected {expected}"
        );
        assert!(dur < 4.0, "speeding up should shorten the clip");
    }

    /// Two animated effects of the same kind on one clip must render.
    #[test]
    fn renders_two_animated_blurs_on_one_clip() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("xtalk", 1.0);
        let ramp = |a: f64, b: f64| Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: a,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 1.0,
                    value: b,
                    easing: Easing::Linear,
                },
            ],
        };
        let mut c = clip("c", &src, 0.0, 0.0, 1.0);
        c.effects.push(Effect::Blur {
            sigma: ramp(0.0, 3.0),
        });
        c.effects.push(Effect::Blur {
            sigma: ramp(4.0, 8.0),
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-xtalk-out.mp4");
        render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("two animated blurs failed:\n{e}"));
    }

    /// One pixel from a rendered file, as RGB. This is how motion gets checked:
    /// the only honest proof that a clip moved is that different pixels changed.
    ///
    /// The whole frame is decoded and indexed rather than cropped, because
    /// `crop` alone receives unset dimensions from the VP8 decoder and fails to
    /// configure its input pad.
    fn pixel_at(path: &Path, at: f64, width: u32, x: u32, y: u32) -> (u8, u8, u8) {
        let out = Command::new("ffmpeg")
            .args(["-v", "error", "-ss"])
            .arg(format!("{at:.3}"))
            .arg("-i")
            .arg(path)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .expect("ffmpeg should run");
        let b = out.stdout;
        let offset = ((y * width + x) * 3) as usize;
        assert!(
            b.len() > offset + 2,
            "frame too small: {} bytes, wanted pixel ({x},{y}) of a {width}px-wide frame",
            b.len()
        );
        (b[offset], b[offset + 1], b[offset + 2])
    }

    fn colour_clip(id: &str, hex: &str, start: f64, len: f64) -> Clip {
        Clip {
            id: id.into(),
            source: Source::Color { color: hex.into() },
            start,
            in_point: 0.0,
            out_point: len,
            speed: Param::Static(1.0),
            reverse: false,
            gain: 1.0,
            muted: false,
            effects: vec![],
            motion: Motion::default(),
            blend: BlendMode::Normal,
            channels: vec![],
            preserve_pitch: true,
            transition_in: None,
        }
    }

    /// Scale must actually shrink the picture: the centre keeps the colour and
    /// the corner falls back to the project background.
    #[test]
    fn motion_scale_shrinks_the_layer() {
        if !ffmpeg_available() {
            return;
        }
        let mut clip = colour_clip("c", "red", 0.0, 1.0);
        clip.motion.scale = Param::Static(50.0);

        let project = Project {
            tracks: vec![track("V1", vec![clip])],
            width: 320,
            height: 240,
            fps: 30,
            background: "black".into(),
            ..Default::default()
        };
        let out = scratch("odyssey-motion-scale-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("scale render failed:\n{e}"));

        let centre = pixel_at(&out, 0.4, 320, 160, 120);
        let corner = pixel_at(&out, 0.4, 320, 8, 8);
        assert!(
            centre.0 > 120 && centre.1 < 90,
            "centre should be red, got {centre:?}"
        );
        assert!(
            corner.0 < 60 && corner.1 < 60,
            "corner should be background, got {corner:?}"
        );
    }

    /// Position must move the layer, not merely re-letterbox it.
    #[test]
    fn motion_position_moves_the_layer() {
        if !ffmpeg_available() {
            return;
        }
        let mut clip = colour_clip("c", "red", 0.0, 1.0);
        clip.motion.scale = Param::Static(50.0);
        // Half the frame width to the left: the picture should clear the centre.
        clip.motion.x = Param::Static(-120.0);

        let project = Project {
            tracks: vec![track("V1", vec![clip])],
            width: 320,
            height: 240,
            fps: 30,
            background: "black".into(),
            ..Default::default()
        };
        let out = scratch("odyssey-motion-pos-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("position render failed:\n{e}"));

        let left = pixel_at(&out, 0.4, 320, 50, 120);
        let centre = pixel_at(&out, 0.4, 320, 250, 120);
        assert!(
            left.0 > 120 && left.1 < 90,
            "left should hold the picture, got {left:?}"
        );
        assert!(
            centre.0 < 60,
            "right of centre should be background, got {centre:?}"
        );
    }

    /// A keyframed position must differ between two times in the same render.
    #[test]
    fn motion_position_animates_over_time() {
        if !ffmpeg_available() {
            return;
        }
        let mut clip = colour_clip("c", "red", 0.0, 2.0);
        clip.motion.scale = Param::Static(40.0);
        clip.motion.x = Param::Animated {
            keyframes: vec![
                Keyframe {
                    time: 0.0,
                    value: -110.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time: 2.0,
                    value: 110.0,
                    easing: Easing::Linear,
                },
            ],
        };

        let project = Project {
            tracks: vec![track("V1", vec![clip])],
            width: 320,
            height: 240,
            fps: 30,
            background: "black".into(),
            ..Default::default()
        };
        let out = scratch("odyssey-motion-anim-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("animated position failed:\n{e}"));

        let early_left = pixel_at(&out, 0.2, 320, 55, 120);
        let late_left = pixel_at(&out, 1.8, 320, 55, 120);
        let late_right = pixel_at(&out, 1.8, 320, 265, 120);
        assert!(
            early_left.0 > 120,
            "should start on the left, got {early_left:?}"
        );
        assert!(
            late_left.0 < 60,
            "should have left the left side, got {late_left:?}"
        );
        assert!(
            late_right.0 > 120,
            "should finish on the right, got {late_right:?}"
        );
    }

    /// Opacity composites against what is beneath rather than replacing it.
    #[test]
    fn motion_opacity_blends_with_the_layer_below() {
        if !ffmpeg_available() {
            return;
        }
        let base = colour_clip("base", "white", 0.0, 1.0);
        let mut top = colour_clip("top", "black", 0.0, 1.0);
        top.motion.opacity = Param::Static(0.5);

        let mut t2 = track("V2", vec![top]);
        t2.id = "t2".into();
        let project = Project {
            tracks: vec![track("V1", vec![base]), t2],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-motion-op-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("opacity render failed:\n{e}"));

        let mid = pixel_at(&out, 0.4, 320, 160, 120);
        assert!(
            mid.0 > 80 && mid.0 < 190,
            "half-opacity black over white should be grey, got {mid:?}"
        );
    }

    /// A multiply blend of black over white must darken, which overlay alone
    /// would not do differently from a plain paste.
    #[test]
    fn blend_multiply_darkens() {
        if !ffmpeg_available() {
            return;
        }
        let base = colour_clip("base", "white", 0.0, 1.0);
        let mut top = colour_clip("top", "gray", 0.0, 1.0);
        top.blend = BlendMode::Multiply;

        let mut t2 = track("V2", vec![top]);
        t2.id = "t2".into();
        let project = Project {
            tracks: vec![track("V1", vec![base]), t2],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-blend-mult-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("multiply blend failed:\n{e}"));

        let mid = pixel_at(&out, 0.4, 320, 160, 120);
        assert!(mid.0 < 200, "multiply should darken white, got {mid:?}");
    }

    /// A curve that lifts midtones must actually brighten the picture.
    #[test]
    fn renders_a_curve_that_brightens() {
        if !ffmpeg_available() {
            return;
        }
        let plain = colour_clip("c", "gray", 0.0, 1.0);
        let project = Project {
            tracks: vec![track("V1", vec![plain.clone()])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let flat_out = scratch("odyssey-curve-flat-out.webm");
        render(&project, &preview_profile(), &flat_out).unwrap();
        let before = pixel_at(&flat_out, 0.4, 320, 160, 120);

        let mut lifted = plain;
        lifted.effects.push(Effect::Curves {
            master: vec![(0.0, 0.0), (0.5, 0.85), (1.0, 1.0)],
            red: vec![],
            green: vec![],
            blue: vec![],
        });
        let project2 = Project {
            tracks: vec![track("V1", vec![lifted])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-curve-lift-out.webm");
        render(&project2, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("curve render failed:\n{e}"));
        let after = pixel_at(&out, 0.4, 320, 160, 120);
        assert!(
            after.0 > before.0 + 15,
            "the curve should brighten: {before:?} -> {after:?}"
        );
    }

    /// An adjustment layer must darken what is beneath it, and only within
    /// the span it covers.
    #[test]
    fn renders_an_adjustment_layer_over_a_span() {
        if !ffmpeg_available() {
            return;
        }
        let base = colour_clip("base", "white", 0.0, 3.0);
        let mut adj = colour_clip("adj", "white", 1.0, 1.0);
        adj.source = Source::Adjustment;
        adj.effects.push(Effect::Color {
            brightness: Param::Static(-0.6),
            contrast: Param::Static(1.0),
            saturation: Param::Static(1.0),
            gamma: Param::Static(1.0),
        });

        let mut t2 = track("V2", vec![adj]);
        t2.id = "t2".into();
        let project = Project {
            tracks: vec![track("V1", vec![base]), t2],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-adjust-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("adjustment render failed:\n{e}"));

        let before = pixel_at(&out, 0.4, 320, 160, 120);
        let during = pixel_at(&out, 1.5, 320, 160, 120);
        let after = pixel_at(&out, 2.6, 320, 160, 120);
        assert!(
            during.0 + 20 < before.0,
            "the adjustment should darken during its span: {before:?} -> {during:?}"
        );
        assert!(
            after.0 > during.0 + 20,
            "and stop darkening after it: {during:?} -> {after:?}"
        );
    }

    #[test]
    fn renders_a_freeze_frame_as_a_still() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("freeze", 2.0);
        let dir = scratch("odyssey-stills");
        let png = freeze_frame(&src.to_string_lossy(), 1.0, &dir)
            .unwrap_or_else(|e| panic!("frame extraction failed:\n{e}"));
        assert!(Path::new(&png).exists(), "no still written");

        let mut clip = colour_clip("s", "black", 0.0, 1.5);
        clip.source = Source::Still { path: png.clone() };
        let project = Project {
            tracks: vec![track("V1", vec![clip])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-still-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("still render failed:\n{e}"));
        let dur = probe_duration(Path::new(&out));
        assert!(
            (dur - 1.5).abs() < 0.35,
            "still should hold for its clip length, got {dur}"
        );
        let _ = std::fs::remove_file(&png);
    }

    /// Two-pass stabilisation: analyse, then transform by the result.
    #[test]
    fn analyses_and_renders_stabilisation() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("stab", 1.0);
        let dir = scratch("odyssey-stab");
        let trf = analyse_stabilisation(&src.to_string_lossy(), &dir)
            .unwrap_or_else(|e| panic!("stabilisation analysis failed:\n{e}"));
        assert!(
            std::fs::metadata(&trf)
                .map(|m| m.len() > 0)
                .unwrap_or(false),
            "the analysis pass wrote nothing"
        );

        let mut clip = clip("c", &src, 0.0, 0.0, 1.0);
        clip.effects.push(Effect::Stabilize {
            trf: trf.clone(),
            smoothing: 10.0,
            zoom: 0.0,
        });
        let project = Project {
            tracks: vec![track("V1", vec![clip])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-stab-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("stabilised render failed:\n{e}"));
        assert!(probe_duration(Path::new(&out)) > 0.5);

        // A second analysis is a cache hit.
        let again = analyse_stabilisation(&src.to_string_lossy(), &dir).unwrap();
        assert_eq!(trf, again);
    }

    #[test]
    fn renders_only_the_requested_zone() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("zone", 2.0);
        let project = Project {
            tracks: vec![track(
                "V1",
                vec![
                    clip("a", &src, 0.0, 0.0, 2.0),
                    clip("b", &src, 8.0, 0.0, 2.0),
                ],
            )],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        assert_eq!(project.duration(), 10.0);
        let out = scratch("odyssey-zone-out.webm");
        render_zone(&project, &preview_profile(), &out, 8.0, 10.0)
            .unwrap_or_else(|e| panic!("zone render failed:\n{e}"));
        let dur = probe_duration(Path::new(&out));
        assert!((dur - 2.0).abs() < 0.35, "zone should be 2s, got {dur}");
    }

    #[test]
    fn renders_loudness_normalisation() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("loud", 1.0);
        let mut c = clip("c", &src, 0.0, 0.0, 1.0);
        c.effects.push(Effect::Loudness { target: -16.0 });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-loud-out.webm");
        let rendered = render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("loudness render failed:\n{e}"));
        assert!(probe_streams(Path::new(&rendered)).contains("audio"));
    }

    #[test]
    fn renders_denoise_and_colour_wheels() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("grade", 1.0);
        let mut c = clip("c", &src, 0.0, 0.0, 1.0);
        c.effects.push(Effect::Denoise { strength: 3.0 });
        c.effects.push(Effect::ColorWheels {
            lift_r: Param::Static(0.05),
            lift_g: p_zero(),
            lift_b: p_zero(),
            gamma_r: p_zero(),
            gamma_g: p_zero(),
            gamma_b: p_zero(),
            gain_r: p_zero(),
            gain_g: p_zero(),
            gain_b: Param::Static(0.1),
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-grade-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("grading render failed:\n{e}"));
        assert!(probe_duration(Path::new(&out)) > 0.5);
    }

    /// A dissolve must actually ramp the incoming clip up over the one below.
    #[test]
    fn renders_a_dissolve_between_overlapping_clips() {
        if !ffmpeg_available() {
            return;
        }
        let under = colour_clip("under", "black", 0.0, 2.0);
        let mut over = colour_clip("over", "white", 0.0, 2.0);
        over.transition_in = Some(Transition {
            kind: TransitionKind::Dissolve,
            duration: 1.5,
        });

        let mut t2 = track("V2", vec![over]);
        t2.id = "t2".into();
        let project = Project {
            tracks: vec![track("V1", vec![under]), t2],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-dissolve-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("dissolve failed:\n{e}"));

        let early = pixel_at(&out, 0.15, 320, 160, 120);
        let late = pixel_at(&out, 1.45, 320, 160, 120);
        assert!(
            late.0 > early.0 + 40,
            "the incoming clip should rise over the dissolve: {early:?} -> {late:?}"
        );
    }

    #[test]
    fn renders_a_ducked_mix() {
        if !ffmpeg_available() {
            return;
        }
        let music = make_media("duckmusic", 2.0);
        let voice = make_media("duckvoice", 2.0);
        let mut m = track("A1", vec![clip("m", &music, 0.0, 0.0, 2.0)]);
        m.id = "music".into();
        m.duck_under = Some("voice".into());
        let mut v = track("A2", vec![clip("v", &voice, 0.0, 0.0, 2.0)]);
        v.id = "voice".into();

        let project = Project {
            tracks: vec![m, v],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-duck-out.webm");
        let rendered = render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("ducked render failed:\n{e}"));
        assert!(probe_streams(Path::new(&rendered)).contains("audio"));
    }

    #[test]
    fn scene_detection_finds_a_hard_cut() {
        if !ffmpeg_available() {
            return;
        }
        // Two very different halves spliced together give one obvious cut.
        let a = scratch("odyssey-scene-a.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x240:r=30:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=white:s=320x240:r=30:d=1",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map",
                "[v]",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&a)
            .status()
            .unwrap();
        assert!(status.success());

        let cuts = detect_scenes(&a.to_string_lossy(), 0.3)
            .unwrap_or_else(|e| panic!("scene detection failed:\n{e}"));
        assert!(!cuts.is_empty(), "a black-to-white cut should be detected");
        assert!(
            cuts.iter().any(|t| (*t - 1.0).abs() < 0.2),
            "the cut should be near 1s, got {cuts:?}"
        );
    }

    /// Render every effect in turn and report which ffmpeg rejects.
    ///
    /// Filter strings are written by hand, so the only way to know a filter is
    /// correct is to make ffmpeg accept it. This renders each effect alone on
    /// a short clip and collects the failures rather than stopping at the
    /// first, so one broken filter does not hide the rest.
    #[test]
    fn every_effect_renders() {
        if !ffmpeg_available() {
            return;
        }
        let _guard = super::tests::render_lock();
        let src = make_media("allfx", 1.0);

        let cases: Vec<(&str, Effect)> = vec![
            (
                "flip",
                Effect::Flip {
                    horizontal: true,
                    vertical: true,
                },
            ),
            (
                "pixelate",
                Effect::Pixelate {
                    size: Param::Static(8.0),
                },
            ),
            ("invert", Effect::Invert),
            ("monochrome", Effect::Monochrome),
            (
                "temperature",
                Effect::Temperature {
                    kelvin: Param::Static(4000.0),
                },
            ),
            (
                "levels",
                Effect::Levels {
                    black: Param::Static(0.05),
                    white: Param::Static(0.9),
                },
            ),
            (
                "exposure",
                Effect::Exposure {
                    stops: Param::Static(0.5),
                },
            ),
            ("grain", Effect::Grain { strength: 10.0 }),
            (
                "boxblur",
                Effect::BoxBlur {
                    radius: Param::Static(3.0),
                },
            ),
            ("motionblur", Effect::MotionBlur { frames: 3.0 }),
            (
                "edgedetect",
                Effect::EdgeDetect {
                    low: 0.1,
                    high: 0.4,
                },
            ),
            ("emboss", Effect::Emboss),
            ("crisp", Effect::Crisp),
            ("deband", Effect::Deband),
            ("deflicker", Effect::Deflicker),
            (
                "lenscorrect",
                Effect::LensCorrect {
                    k1: Param::Static(-0.1),
                    k2: Param::Static(0.0),
                },
            ),
            (
                "lumakey",
                Effect::LumaKey {
                    threshold: Param::Static(0.1),
                    tolerance: Param::Static(0.1),
                },
            ),
            (
                "despill",
                Effect::Despill {
                    colour: "green".into(),
                    amount: Param::Static(1.0),
                },
            ),
            (
                "chromashift",
                Effect::ChromaShift {
                    x: Param::Static(2.0),
                    y: Param::Static(0.0),
                },
            ),
            ("reframe", Effect::Reframe { aspect: 1.0 }),
            (
                "posterize",
                Effect::Posterize {
                    levels: Param::Static(5.0),
                },
            ),
            (
                "curves",
                Effect::Curves {
                    master: vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)],
                    red: vec![],
                    green: vec![],
                    blue: vec![],
                },
            ),
            ("denoise", Effect::Denoise { strength: 3.0 }),
            (
                "vignette",
                Effect::Vignette {
                    angle: Param::Static(0.6),
                },
            ),
            (
                "hue",
                Effect::Hue {
                    degrees: Param::Static(30.0),
                },
            ),
            (
                "sharpen",
                Effect::Sharpen {
                    amount: Param::Static(1.0),
                },
            ),
            (
                "blur",
                Effect::Blur {
                    sigma: Param::Static(2.0),
                },
            ),
            (
                "chromakey",
                Effect::ChromaKey {
                    color: "green".into(),
                    similarity: Param::Static(0.2),
                    blend: Param::Static(0.05),
                },
            ),
            (
                "vibrance",
                Effect::Vibrance {
                    intensity: Param::Static(0.5),
                },
            ),
            (
                "colorbalance",
                Effect::ColorBalance {
                    r: Param::Static(0.1),
                    g: Param::Static(0.0),
                    b: Param::Static(-0.1),
                },
            ),
            (
                "chromaticaberration",
                Effect::ChromaticAberration {
                    amount: Param::Static(2.0),
                },
            ),
            (
                "shear",
                Effect::Shear {
                    x: Param::Static(0.1),
                    y: Param::Static(0.0),
                },
            ),
            (
                "colorkey",
                Effect::ColorKey {
                    color: "green".into(),
                    similarity: Param::Static(0.2),
                    blend: Param::Static(0.1),
                },
            ),
            (
                "hsvkey",
                Effect::HsvKey {
                    hue: Param::Static(120.0),
                    sat: Param::Static(0.5),
                    val: Param::Static(0.5),
                    similarity: Param::Static(0.2),
                    blend: Param::Static(0.1),
                },
            ),
            (
                "frameblend",
                Effect::FrameBlend {
                    frames: Param::Static(3.0),
                },
            ),
            (
                "falsecolor",
                Effect::FalseColor {
                    preset: "magma".into(),
                },
            ),
            (
                "histeq",
                Effect::HistEq {
                    strength: Param::Static(0.5),
                },
            ),
            (
                "autolevels",
                Effect::AutoLevels {
                    strength: Param::Static(0.8),
                },
            ),
            ("deinterlace", Effect::Deinterlace { mode: 0.0 }),
            (
                "adaptivesharpen",
                Effect::AdaptiveSharpen {
                    strength: Param::Static(0.5),
                },
            ),
            (
                "chromadenoise",
                Effect::ChromaDenoise {
                    threshold: Param::Static(20.0),
                },
            ),
            (
                "huesaturation",
                Effect::HueSaturation {
                    hue: Param::Static(20.0),
                    saturation: Param::Static(0.2),
                    intensity: Param::Static(0.3),
                },
            ),
            (
                "bilateral",
                Effect::Bilateral {
                    sigma_s: Param::Static(2.0),
                    sigma_r: Param::Static(0.2),
                },
            ),
            (
                "smartblur",
                Effect::SmartBlur {
                    radius: Param::Static(2.0),
                    strength: Param::Static(0.5),
                },
            ),
            (
                "vaguedenoise",
                Effect::VagueDenoise {
                    threshold: Param::Static(3.0),
                },
            ),
            ("sepia", Effect::Sepia),
            (
                "scanlines",
                Effect::Scanlines {
                    amount: Param::Static(0.4),
                },
            ),
            ("mirror", Effect::Mirror),
        ];

        let audio_cases: Vec<(&str, Effect)> = vec![
            (
                "echo",
                Effect::Echo {
                    delay_ms: 200.0,
                    decay: 0.4,
                },
            ),
            ("chorus", Effect::Chorus { depth: 0.5 }),
            ("flanger", Effect::Flanger { depth: 2.0 }),
            (
                "pitchshift",
                Effect::PitchShift {
                    ratio: Param::Static(1.2),
                },
            ),
            ("noisegate", Effect::NoiseGate { threshold: 0.02 }),
            (
                "compressor",
                Effect::Compressor {
                    threshold: 0.125,
                    ratio: 4.0,
                },
            ),
            ("limiter", Effect::Limiter { ceiling: 0.9 }),
            (
                "stereowidth",
                Effect::StereoWidth {
                    amount: Param::Static(1.5),
                },
            ),
            ("mono", Effect::Mono),
            ("swapchannels", Effect::SwapChannels),
            ("trimsilence", Effect::TrimSilence { threshold: 0.02 }),
            ("loudness", Effect::Loudness { target: -16.0 }),
            (
                "highpass",
                Effect::Highpass {
                    frequency: Param::Static(200.0),
                },
            ),
            (
                "lowpass",
                Effect::Lowpass {
                    frequency: Param::Static(3000.0),
                },
            ),
            (
                "volume",
                Effect::Volume {
                    level: Param::Static(0.8),
                },
            ),
            (
                "audiofade",
                Effect::AudioFade {
                    in_secs: 0.2,
                    out_secs: 0.2,
                },
            ),
            (
                "bass",
                Effect::Bass {
                    gain: Param::Static(4.0),
                    freq: Param::Static(100.0),
                },
            ),
            (
                "treble",
                Effect::Treble {
                    gain: Param::Static(3.0),
                    freq: Param::Static(3000.0),
                },
            ),
            (
                "parametriceq",
                Effect::ParametricEq {
                    freq: Param::Static(1000.0),
                    width: Param::Static(1.0),
                    gain: Param::Static(3.0),
                },
            ),
            (
                "tremolo",
                Effect::Tremolo {
                    freq: Param::Static(5.0),
                    depth: Param::Static(0.5),
                },
            ),
            (
                "vibrato",
                Effect::Vibrato {
                    freq: Param::Static(5.0),
                    depth: Param::Static(0.5),
                },
            ),
            (
                "bitcrush",
                Effect::BitCrush {
                    bits: Param::Static(8.0),
                    mix: Param::Static(0.5),
                },
            ),
            (
                "exciter",
                Effect::Exciter {
                    amount: Param::Static(1.0),
                },
            ),
            (
                "subboost",
                Effect::SubBoost {
                    amount: Param::Static(0.5),
                },
            ),
            (
                "speechnorm",
                Effect::SpeechNorm {
                    expansion: Param::Static(2.0),
                },
            ),
            (
                "audiodenoise",
                Effect::AudioDenoise {
                    reduction: Param::Static(12.0),
                },
            ),
        ];

        let mut failures: Vec<String> = Vec::new();
        for (name, effect) in cases.into_iter().chain(audio_cases) {
            let mut c = clip("c", &src, 0.0, 0.0, 1.0);
            c.effects.push(effect);
            let project = Project {
                tracks: vec![track("V1", vec![c])],
                width: 160,
                height: 120,
                fps: 10,
                ..Default::default()
            };
            let out = scratch(&format!("odyssey-fx-{name}.webm"));
            if let Err(e) = render(&project, &preview_profile(), &out) {
                let detail = e.to_string();
                let last = detail.lines().last().unwrap_or("").trim().to_string();
                failures.push(format!("{name}: {last}"));
            }
            let _ = std::fs::remove_file(&out);
        }

        assert!(
            failures.is_empty(),
            "ffmpeg rejected {} effect(s):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    /// `ease` (Rust) and `ease_expr` (ffmpeg) are two implementations of the
    /// same curves, and nothing stopped them drifting apart. Render the
    /// expression ffmpeg actually evaluates and compare it to the reference.
    ///
    /// The value is encoded as `128 + 80*v`, and clipped: ElasticOut peaks at
    /// ~1.354, and geq *wraps* out-of-range luma rather than saturating, so a
    /// tighter scale would silently decode as a wildly negative number.
    #[test]
    fn ease_expr_matches_the_rust_reference() {
        if !ffmpeg_available() {
            return;
        }
        let _guard = super::tests::render_lock();

        let all = [
            Easing::Linear,
            Easing::Hold,
            Easing::EaseIn,
            Easing::EaseOut,
            Easing::EaseInOut,
            Easing::CubicIn,
            Easing::CubicOut,
            Easing::CubicInOut,
            Easing::SineIn,
            Easing::SineOut,
            Easing::BackOut,
            Easing::ElasticOut,
            Easing::BounceOut,
        ];

        let mut failures: Vec<String> = Vec::new();
        for e in all {
            let expr = super::ease_expr("(X/(W-1))", e);
            let out = Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:s=256x2:r=1:d=1",
                ])
                .arg("-vf")
                .arg(format!("format=gray,geq=lum='clip(128+80*({expr}),0,255)'"))
                .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
                .output()
                .expect("ffmpeg should run");
            if !out.status.success() {
                failures.push(format!("{e:?}: ffmpeg rejected {expr}"));
                continue;
            }
            let b = out.stdout;
            if b.len() < 256 {
                failures.push(format!("{e:?}: short frame ({} bytes)", b.len()));
                continue;
            }
            for x in (0..256).step_by(17) {
                let p = x as f64 / 255.0;
                let want = super::ease(p, e);
                let got = (b[x] as f64 - 128.0) / 80.0;
                if (want - got).abs() > 0.03 {
                    failures.push(format!("{e:?} at p={p:.3}: rust={want:.4} ffmpeg={got:.4}"));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} easing mismatch(es):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    /// Each transition compiles to a per-pixel alpha expression, and a typo in
    /// one of those is invisible until render time. So render every kind and
    /// collect the rejections rather than stopping at the first.
    #[test]
    fn every_transition_renders() {
        if !ffmpeg_available() {
            return;
        }
        let _guard = super::tests::render_lock();
        let src = make_media("alltrans", 2.0);

        let kinds: Vec<(&str, TransitionKind)> = vec![
            ("dissolve", TransitionKind::Dissolve),
            ("diptoblack", TransitionKind::DipToBlack),
            ("diptowhite", TransitionKind::DipToWhite),
            ("wipeleft", TransitionKind::WipeLeft),
            ("wiperight", TransitionKind::WipeRight),
            ("wipeup", TransitionKind::WipeUp),
            ("wipedown", TransitionKind::WipeDown),
            ("diagonalwipe", TransitionKind::DiagonalWipe),
            ("irisopen", TransitionKind::IrisOpen),
            ("irisclose", TransitionKind::IrisClose),
            ("barndooropen", TransitionKind::BarnDoorOpen),
            ("barndoorclose", TransitionKind::BarnDoorClose),
            ("clockwipe", TransitionKind::ClockWipe),
            ("pixeldissolve", TransitionKind::PixelDissolve),
            ("slideleft", TransitionKind::SlideLeft),
            ("slideright", TransitionKind::SlideRight),
            ("slideup", TransitionKind::SlideUp),
            ("slidedown", TransitionKind::SlideDown),
        ];

        let mut failures: Vec<String> = Vec::new();
        for (name, kind) in kinds {
            let a = clip("a", &src, 0.0, 0.0, 1.0);
            let mut b = clip("b", &src, 1.0, 0.5, 1.5);
            b.transition_in = Some(Transition {
                kind,
                duration: 0.4,
            });
            let project = Project {
                tracks: vec![track("V1", vec![a, b])],
                width: 160,
                height: 120,
                fps: 10,
                ..Default::default()
            };
            let resolved = apply_transitions(&project);
            let out = scratch(&format!("odyssey-trans-{name}.webm"));
            if let Err(e) = render(&resolved, &preview_profile(), &out) {
                let detail = format!("{e}");
                let last = detail.lines().last().unwrap_or("").trim().to_string();
                failures.push(format!("{name}: {last}"));
            }
            let _ = std::fs::remove_file(&out);
        }

        assert!(
            failures.is_empty(),
            "ffmpeg rejected {} transition(s):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    /// Regression test: plenty of real footage has no audio track, and the
    /// graph references [N:a] for every media input. Assuming audio made
    /// ffmpeg reject the whole description with "Stream specifier ':a' in
    /// filtergraph description", so a silent clip could not render at all.
    #[test]
    fn a_video_with_no_audio_renders() {
        if !ffmpeg_available() {
            return;
        }
        let silent = scratch("odyssey-silent.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x48:rate=10:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&silent)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(
            !crate::video::probe(&silent.to_string_lossy())
                .unwrap()
                .has_audio,
            "the fixture should be silent"
        );

        let project = Project {
            tracks: vec![track("V1", vec![clip("c", &silent, 0.0, 0.0, 1.0)])],
            width: 64,
            height: 48,
            fps: 10,
            ..Default::default()
        };
        let out = scratch("odyssey-silent-out.webm");
        render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("a silent video failed to render:\n{e}"));
        assert!(probe_duration(Path::new(&out)) > 0.5);
    }

    /// And a silent clip mixed with one that has audio must still produce sound.
    #[test]
    fn a_silent_clip_beside_an_audible_one_still_mixes() {
        if !ffmpeg_available() {
            return;
        }
        let silent = scratch("odyssey-silent2.mp4");
        Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x48:rate=10:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&silent)
            .status()
            .unwrap();
        let audible = make_media("mixed", 1.0);

        let project = Project {
            tracks: vec![track(
                "V1",
                vec![
                    clip("a", &silent, 0.0, 0.0, 1.0),
                    clip("b", &audible, 1.0, 0.0, 1.0),
                ],
            )],
            width: 64,
            height: 48,
            fps: 10,
            ..Default::default()
        };
        let out = scratch("odyssey-mixed-out.webm");
        let rendered = render(&project, &preview_profile(), &out)
            .unwrap_or_else(|e| panic!("mixed audio failed:\n{e}"));
        assert!(
            probe_streams(Path::new(&rendered)).contains("audio"),
            "the audible clip should still give the output sound"
        );
    }

    /// A preview chunk must render, be small, and come back from cache.
    #[test]
    fn renders_and_caches_a_preview_chunk() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("prev", 4.0);
        let mut c = clip("c", &src, 0.0, 0.0, 4.0);
        // A heavy stack is exactly why preview rendering exists.
        c.effects.push(Effect::Blur {
            sigma: Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 1.0,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: 4.0,
                        value: 10.0,
                        easing: Easing::Linear,
                    },
                ],
            },
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 640,
            height: 480,
            fps: 30,
            ..Default::default()
        };

        let dir = scratch("odyssey-preview-cache");
        let _ = clear_previews(&dir);

        let chunk = render_preview(&project, 1.0, 3.0, 0.5, &dir)
            .unwrap_or_else(|e| panic!("preview render failed:\n{e}"));

        assert_eq!(chunk.width, 320, "scale applied");
        assert_eq!(chunk.height, 240);
        let dur = probe_duration(Path::new(&chunk.path));
        assert!(
            (dur - 2.0).abs() < 0.35,
            "chunk should cover the range: got {dur}"
        );

        // Second call must reuse the file rather than re-encode it.
        let before = std::fs::metadata(&chunk.path).unwrap().modified().unwrap();
        let again = render_preview(&project, 1.0, 3.0, 0.5, &dir).unwrap();
        let after = std::fs::metadata(&again.path).unwrap().modified().unwrap();
        assert_eq!(chunk.key, again.key);
        assert_eq!(before, after, "a cache hit must not re-encode");

        let removed = clear_previews(&dir).unwrap();
        assert!(removed >= 1);
    }

    /// The rendered chunk must reflect the slice, not the whole timeline.
    #[test]
    fn a_preview_chunk_covers_only_its_range() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("prevrange", 2.0);
        let project = Project {
            tracks: vec![track(
                "V1",
                vec![
                    clip("a", &src, 0.0, 0.0, 2.0),
                    clip("b", &src, 10.0, 0.0, 2.0),
                ],
            )],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        assert_eq!(project.duration(), 12.0);

        let dir = scratch("odyssey-preview-range");
        let _ = clear_previews(&dir);
        let chunk = render_preview(&project, 10.0, 12.0, 0.5, &dir)
            .unwrap_or_else(|e| panic!("range preview failed:\n{e}"));
        let dur = probe_duration(Path::new(&chunk.path));
        assert!(
            (dur - 2.0).abs() < 0.35,
            "expected just the last 2s, got {dur}"
        );
        let _ = clear_previews(&dir);
    }

    #[test]
    fn renders_burned_and_embedded_subtitles() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("subs", 3.0);
        let cues = vec![Subtitle {
            id: "1".into(),
            start: 0.5,
            end: 2.0,
            text: "Hello from Odyssey".into(),
        }];

        // Burned in.
        let mut burn = Project {
            tracks: vec![track("V1", vec![clip("c", &src, 0.0, 0.0, 3.0)])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        burn.subtitles = cues.clone();
        burn.subtitle_mode = SubtitleMode::Burn;
        let out1 = scratch("odyssey-e2e-subburn-out.mp4");
        render(&burn, &fast_profile(), &out1)
            .unwrap_or_else(|e| panic!("burned subtitles failed:\n{e}"));
        assert!(probe_duration(Path::new(&out1)) > 2.5);

        // Soft embedded: the output must carry a subtitle stream.
        let mut embed = burn.clone();
        embed.subtitle_mode = SubtitleMode::Embed;
        let out2 = scratch("odyssey-e2e-subembed-out.mp4");
        render(&embed, &fast_profile(), &out2)
            .unwrap_or_else(|e| panic!("embedded subtitles failed:\n{e}"));
        let streams = probe_streams(Path::new(&out2));
        assert!(
            streams.contains("subtitle"),
            "no subtitle stream: {streams}"
        );
    }

    /// frei0r is the route to hundreds of effects; prove one actually renders.
    #[test]
    fn renders_a_frei0r_plugin() {
        if !ffmpeg_available() {
            return;
        }
        // Skip cleanly if this ffmpeg was built without frei0r.
        let has = Command::new("ffmpeg")
            .args(["-hide_banner", "-filters"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("frei0r"))
            .unwrap_or(false);
        if !has {
            eprintln!("frei0r unavailable — skipping");
            return;
        }
        let src = make_media("f0r", 1.0);
        let mut c = clip("c", &src, 0.0, 0.0, 1.0);
        c.effects.push(Effect::Frei0r {
            name: "glow".into(),
            params: vec![Param::Static(0.5)],
        });
        let project = Project {
            tracks: vec![track("V1", vec![c])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let out = scratch("odyssey-e2e-frei0r.mp4");
        render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("frei0r render failed:\n{e}"));
    }

    /// A clip on an audio track must contribute audio and no video.
    #[test]
    fn renders_a_clip_on_an_audio_track() {
        if !ffmpeg_available() {
            return;
        }
        let src = make_media("aud", 2.0);
        let mut atrack = track("A1", vec![clip("c", &src, 0.0, 0.0, 2.0)]);
        atrack.kind = TrackKind::Audio;
        let vsrc = make_media("audv", 2.0);
        let project = Project {
            tracks: vec![track("V1", vec![clip("v", &vsrc, 0.0, 0.0, 2.0)]), atrack],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        let joined = render_args(&project, &fast_profile(), Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("[a1]"),
            "audio-track clip produced no audio: {joined}"
        );
        assert!(
            !joined.contains("[v1]"),
            "audio-track clip must not produce video"
        );

        let out = scratch("odyssey-e2e-audiotrack.mp4");
        let rendered = render(&project, &fast_profile(), &out)
            .unwrap_or_else(|e| panic!("audio track render failed:\n{e}"));
        let streams = probe_streams(Path::new(&rendered));
        assert!(
            streams.contains("audio") && streams.contains("video"),
            "{streams}"
        );
    }

    #[test]
    fn writes_every_container_profile_for_real() {
        if !ffmpeg_available() {
            return;
        }
        let _guard = super::tests::render_lock();
        let a = make_media("profiles", 1.0);
        let project = Project {
            tracks: vec![track("V1", vec![clip("c", &a, 0.0, 0.0, 1.0)])],
            width: 320,
            height: 240,
            fps: 30,
            ..Default::default()
        };
        // ProRes and VP9 are slow; cover the fast, broadly-used ones here.
        for id in ["mp4-h264-fast", "webm-vp9", "mp3-audio"] {
            let profile = render_profiles().into_iter().find(|p| p.id == id).unwrap();
            let out = std::env::temp_dir().join(format!("odyssey-e2e-{id}.{}", profile.container));
            let rendered = render(&project, &profile, &out)
                .unwrap_or_else(|e| panic!("profile {id} failed:\n{e}"));
            let streams = probe_streams(Path::new(&rendered));
            if profile.video_codec == "none" {
                assert!(!streams.contains("video"), "{id} should be audio only");
            } else {
                assert!(streams.contains("video"), "{id} produced no video");
            }
            let mut f = std::fs::File::open(&rendered).unwrap();
            let mut buf = [0u8; 1];
            use std::io::Read;
            assert!(f.read(&mut buf).unwrap() == 1, "{id} wrote an empty file");
            let _ = writeln!(std::io::stderr(), "  {id}: ok");
        }
    }
}

#[cfg(test)]
mod frei0r_tests {
    use super::*;

    #[test]
    fn enumerates_installed_plugins_or_returns_empty() {
        let plugins = frei0r_plugins();
        // Machines without frei0r must get an empty list, never a panic.
        for p in &plugins {
            assert!(!p.name.is_empty());
            assert!(!p.label.is_empty());
            assert_eq!(
                sanitise_plugin(&p.name),
                p.name,
                "unsafe name leaked through"
            );
        }
        eprintln!("  frei0r plugins found: {}", plugins.len());
    }

    #[test]
    fn humanises_plugin_names() {
        assert_eq!(humanise("glow"), "Glow");
        assert_eq!(humanise("alpha0ps_alphagrad"), "Alpha0ps alphagrad");
        assert_eq!(humanise("three-flip"), "Three flip");
    }
}

#[cfg(test)]
mod proxy_contract {
    use super::tests::scratch;
    use super::*;
    use std::io::Write;

    /// The contract that matters for proxies: the renderer must never read one.
    /// A proxy is a preview device, and an export that silently used one would
    /// ship a degraded master without the user ever being told.
    #[test]
    fn render_args_only_ever_reads_original_media() {
        let original = scratch("odyssey-contract-original.mp4");
        let proxy = scratch("odyssey-contract-proxy.mp4");
        for p in [&original, &proxy] {
            std::fs::File::create(p).unwrap().write_all(b"x").unwrap();
        }

        let clip = Clip {
            id: "c".into(),
            source: Source::Media {
                path: original.to_string_lossy().to_string(),
            },
            start: 0.0,
            in_point: 0.0,
            out_point: 2.0,
            speed: Param::Static(1.0),
            reverse: false,
            gain: 1.0,
            muted: false,
            effects: vec![],
            motion: Motion::default(),
            blend: BlendMode::Normal,
            channels: vec![],
            preserve_pitch: true,
            transition_in: None,
        };
        let mut project = Project {
            tracks: vec![Track {
                id: "t".into(),
                name: "V1".into(),
                kind: TrackKind::Video,
                clips: vec![clip],
                muted: false,
                hidden: false,
                locked: false,
                solo: false,
                volume: 1.0,
                opacity: 1.0,
                blend: BlendMode::Normal,
                targeted: false,
                duck_under: None,
                duck_threshold: 0.05,
                duck_ratio: 8.0,
                duck_attack: 20.0,
                duck_release: 300.0,
            }],
            ..Default::default()
        };
        // A bin entry carrying a proxy must not change what the renderer reads.
        project.bin.push(BinItem {
            id: "b".into(),
            path: original.to_string_lossy().to_string(),
            name: "original.mp4".into(),
            duration: 2.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            proxy: Some(proxy.to_string_lossy().to_string()),
            folder: String::new(),
            label: String::new(),
        });

        let profile = render_profiles().into_iter().next().unwrap();
        let joined = render_args(&project, &profile, Path::new("/tmp/o.mp4"), None)
            .unwrap()
            .join(" ");

        assert!(
            joined.contains("odyssey-contract-original"),
            "original must be read"
        );
        assert!(
            !joined.contains("odyssey-contract-proxy"),
            "a proxy must never reach the renderer: {joined}"
        );
    }
}

#[cfg(test)]
mod webview_playback {
    use super::tests::scratch;
    use super::*;

    /// Regression test for a black monitor.
    ///
    /// Anything the preview plays back is decoded by the webview, which on
    /// Linux means GStreamer. H.264 there needs `gst-libav`, which many systems
    /// do not ship, so a preview encoded as H.264 silently renders black. VP8
    /// and Opus are available wherever the base plugins are.
    #[test]
    fn the_preview_profile_is_decodable_by_a_webview() {
        let p = preview_profile();
        assert_eq!(
            p.container, "webm",
            "previews must be in a webview-friendly container"
        );
        assert!(
            p.video_codec.starts_with("libvpx"),
            "H.264 previews go black without gst-libav"
        );
        assert_eq!(p.audio_codec, "libopus");
    }

    /// Export is a separate concern and must keep offering real delivery codecs.
    #[test]
    fn export_profiles_still_offer_h264() {
        let ids: Vec<String> = render_profiles().into_iter().map(|p| p.id).collect();
        assert!(
            ids.iter().any(|id| id.contains("h264")),
            "export must still offer H.264: {ids:?}"
        );
        assert!(ids.iter().any(|id| id.contains("prores")), "and ProRes");
    }

    /// libvpx ignores -preset, so the speed flags have to be emitted explicitly
    /// or a preview render crawls.
    #[test]
    fn vp8_renders_get_their_speed_flags() {
        use std::io::Write;
        let src = scratch("odyssey-vp8flags.mp4");
        std::fs::File::create(&src)
            .unwrap()
            .write_all(b"x")
            .unwrap();

        let project = Project {
            tracks: vec![Track {
                id: "t".into(),
                name: "V1".into(),
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: "c".into(),
                    source: Source::Media {
                        path: src.to_string_lossy().to_string(),
                    },
                    start: 0.0,
                    in_point: 0.0,
                    out_point: 2.0,
                    speed: Param::Static(1.0),
                    reverse: false,
                    gain: 1.0,
                    muted: false,
                    effects: vec![],
                    motion: Motion::default(),
                    blend: BlendMode::Normal,
                    channels: vec![],
                    preserve_pitch: true,
                    transition_in: None,
                }],
                muted: false,
                hidden: false,
                locked: false,
                solo: false,
                volume: 1.0,
                opacity: 1.0,
                blend: BlendMode::Normal,
                targeted: false,
                duck_under: None,
                duck_threshold: 0.05,
                duck_ratio: 8.0,
                duck_attack: 20.0,
                duck_release: 300.0,
            }],
            ..Default::default()
        };
        let joined = render_args(&project, &preview_profile(), Path::new("/tmp/o.webm"), None)
            .unwrap()
            .join(" ");
        assert!(
            joined.contains("-deadline realtime"),
            "missing speed flags: {joined}"
        );
        assert!(joined.contains("-cpu-used 8"));
        assert!(
            joined.contains("-b:v 0"),
            "libvpx CRF needs a zero target bitrate"
        );
    }
}

/// Stress tests. These are not correctness checks; they exist to find where
/// the thing falls over, and they print numbers so the answer is a measurement
/// rather than an impression. Run with `cargo test stress -- --nocapture`.
#[cfg(test)]
mod stress {
    use super::tests::scratch;
    use super::*;
    use std::time::Instant;

    fn media(path: &Path, id: &str, start: f64, len: f64) -> Clip {
        Clip {
            id: id.into(),
            source: Source::Media {
                path: path.to_string_lossy().to_string(),
            },
            start,
            in_point: 0.0,
            out_point: len,
            speed: Param::Static(1.0),
            reverse: false,
            channels: vec![],
            preserve_pitch: true,
            gain: 1.0,
            muted: false,
            effects: vec![],
            motion: Motion::default(),
            blend: BlendMode::Normal,
            transition_in: None,
        }
    }

    fn track_of(id: &str, clips: Vec<Clip>) -> Track {
        Track {
            id: id.into(),
            name: id.into(),
            kind: TrackKind::Video,
            clips,
            muted: false,
            hidden: false,
            locked: false,
            solo: false,
            volume: 1.0,
            opacity: 1.0,
            blend: BlendMode::Normal,
            targeted: false,
            duck_under: None,
            duck_threshold: 0.05,
            duck_ratio: 8.0,
            duck_attack: 20.0,
            duck_release: 300.0,
        }
    }

    fn source() -> PathBuf {
        let p = scratch("stress-src.bin");
        if !p.exists() {
            use std::io::Write;
            std::fs::File::create(&p).unwrap().write_all(b"x").unwrap();
        }
        p
    }

    /// How long it takes to compile a big timeline into an ffmpeg command.
    /// This runs on every edit that touches the preview cache, so it has to be
    /// fast enough not to be felt.
    #[test]
    fn graph_build_scales_with_clip_count() {
        let src = source();
        for count in [10usize, 100, 500, 1000] {
            let clips: Vec<Clip> = (0..count)
                .map(|i| media(&src, &format!("c{i}"), i as f64 * 2.0, 2.0))
                .collect();
            let project = Project {
                tracks: vec![track_of("V1", clips)],
                width: 1920,
                height: 1080,
                fps: 30,
                ..Default::default()
            };

            let t = Instant::now();
            let args = render_args(
                &project,
                &profile_for_stress(),
                Path::new("/tmp/x.mp4"),
                None,
            )
            .expect("a large timeline must still compile");
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let graph_len = args
                .iter()
                .position(|a| a == "-filter_complex")
                .map(|i| args[i + 1].len())
                .unwrap_or(0);

            eprintln!(
                "  {count:>5} clips: {ms:>8.1} ms, filter graph {graph_len:>9} chars, {} args",
                args.len()
            );
            assert!(ms < 5000.0, "{count} clips took {ms:.0} ms to compile");
        }
    }

    fn profile_for_stress() -> RenderProfile {
        render_profiles().into_iter().next().unwrap()
    }

    /// Keyframes compile to expressions, so a heavily animated parameter makes
    /// a very long string. This is where that becomes a problem.
    #[test]
    fn keyframe_count_scales() {
        let src = source();
        for count in [10usize, 100, 500, 2000] {
            let mut c = media(&src, "c", 0.0, 60.0);
            c.effects.push(Effect::Color {
                brightness: Param::Animated {
                    keyframes: (0..count)
                        .map(|i| Keyframe {
                            time: i as f64 * (60.0 / count as f64),
                            value: if i % 2 == 0 { -0.5 } else { 0.5 },
                            easing: Easing::Linear,
                        })
                        .collect(),
                },
                contrast: p_one(),
                saturation: p_one(),
                gamma: p_one(),
            });
            let project = Project {
                tracks: vec![track_of("V1", vec![c])],
                width: 1920,
                height: 1080,
                fps: 30,
                ..Default::default()
            };
            let t = Instant::now();
            let args = render_args(
                &project,
                &profile_for_stress(),
                Path::new("/tmp/x.mp4"),
                None,
            )
            .unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let graph = args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].len();
            eprintln!("  {count:>5} keyframes: {ms:>8.1} ms, expression graph {graph:>9} chars");
            assert!(ms < 5000.0, "{count} keyframes took {ms:.0} ms");
        }
    }

    /// A command-driven effect samples at the frame rate, so a long clip
    /// produces a lot of commands. MAX_SAMPLES is meant to cap that.
    #[test]
    fn command_stream_is_capped_on_long_clips() {
        let src = source();
        for minutes in [1u32, 10, 60] {
            let len = minutes as f64 * 60.0;
            let mut c = media(&src, "c", 0.0, len);
            c.effects.push(Effect::Blur {
                sigma: Param::Animated {
                    keyframes: vec![
                        Keyframe {
                            time: 0.0,
                            value: 0.0,
                            easing: Easing::Linear,
                        },
                        Keyframe {
                            time: len,
                            value: 20.0,
                            easing: Easing::Linear,
                        },
                    ],
                },
            });
            let project = Project {
                tracks: vec![track_of("V1", vec![c])],
                width: 1920,
                height: 1080,
                fps: 60,
                ..Default::default()
            };
            let t = Instant::now();
            let args = render_args(
                &project,
                &profile_for_stress(),
                Path::new("/tmp/x.mp4"),
                None,
            )
            .unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
            let commands = graph.matches("gblur sigma").count();
            eprintln!("  {minutes:>3} min clip at 60fps: {ms:>7.1} ms, {commands} commands");
            assert!(
                commands <= MAX_SAMPLES,
                "command stream not capped: {commands}"
            );
        }
    }

    /// Many tracks means many overlay stages chained one after another.
    #[test]
    fn track_count_scales() {
        let src = source();
        for tracks in [2usize, 10, 50] {
            let ts: Vec<Track> = (0..tracks)
                .map(|i| {
                    track_of(
                        &format!("V{i}"),
                        vec![media(&src, &format!("c{i}"), 0.0, 5.0)],
                    )
                })
                .collect();
            let project = Project {
                tracks: ts,
                width: 1920,
                height: 1080,
                fps: 30,
                ..Default::default()
            };
            let t = Instant::now();
            let args = render_args(
                &project,
                &profile_for_stress(),
                Path::new("/tmp/x.mp4"),
                None,
            )
            .unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            eprintln!(
                "  {tracks:>3} tracks: {ms:>7.1} ms, {} inputs",
                args.iter().filter(|a| *a == "-i").count()
            );
            assert!(ms < 5000.0);
        }
    }

    /// A speed ramp expands into one input per segment, which is the sharpest
    /// multiplier in the whole engine.
    #[test]
    fn speed_ramps_expand_into_many_inputs() {
        let src = source();
        for len in [2.0f64, 10.0, 30.0] {
            let mut c = media(&src, "c", 0.0, len);
            c.speed = Param::Animated {
                keyframes: vec![
                    Keyframe {
                        time: 0.0,
                        value: 1.0,
                        easing: Easing::Linear,
                    },
                    Keyframe {
                        time: len,
                        value: 4.0,
                        easing: Easing::Linear,
                    },
                ],
            };
            let segments = c.segments().len();
            let project = Project {
                tracks: vec![track_of("V1", vec![c])],
                width: 1920,
                height: 1080,
                fps: 30,
                ..Default::default()
            };
            let t = Instant::now();
            let args = render_args(
                &project,
                &profile_for_stress(),
                Path::new("/tmp/x.mp4"),
                None,
            )
            .unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let inputs = args.iter().filter(|a| *a == "-i").count();
            eprintln!(
                "  {len:>4.0}s ramp: {segments} segments -> {inputs} ffmpeg inputs, {ms:.1} ms"
            );
            assert_eq!(inputs, segments, "one input per segment");
            assert!(segments <= MAX_SPEED_SEGMENTS);
        }
    }

    /// The bug this whole stress pass existed to find.
    ///
    /// A filter graph travels as ONE argument, and the kernel refuses any
    /// single argument over MAX_ARG_STRLEN (131072 bytes on Linux) with
    /// "Argument list too long" before ffmpeg ever runs. A few hundred clips
    /// crosses that, so the graph has to be spilled to a file.
    #[test]
    fn a_large_timeline_actually_renders() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let _guard = super::tests::render_lock();

        // Build real media once, then place it many times.
        let src = scratch("stress-media.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x48:rate=10:duration=0.4",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&src)
            .status()
            .expect("ffmpeg should run");
        assert!(status.success());

        for count in [50usize, 300] {
            let clips: Vec<Clip> = (0..count)
                .map(|i| media(&src, &format!("c{i}"), i as f64 * 0.4, 0.4))
                .collect();
            let project = Project {
                tracks: vec![track_of("V1", clips)],
                width: 64,
                height: 48,
                fps: 10,
                ..Default::default()
            };

            let graph_len = {
                let a = render_args(&project, &preview_profile(), Path::new("/tmp/x.webm"), None)
                    .unwrap();
                a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1].len()
            };

            let out = scratch(&format!("stress-{count}.webm"));
            let started = Instant::now();
            let result = render(&project, &preview_profile(), &out);
            let secs = started.elapsed().as_secs_f64();

            match &result {
                Ok(_) => eprintln!(
                    "  {count:>4} clips: graph {graph_len:>7} chars, rendered in {secs:>6.1}s"
                ),
                Err(e) => eprintln!("  {count:>4} clips: graph {graph_len:>7} chars, FAILED: {e}"),
            }
            assert!(
                result.is_ok(),
                "{count} clips failed to render: {:?}",
                result.err()
            );
            let _ = std::fs::remove_file(&out);
        }
    }

    /// Undo keeps whole-project snapshots. This is how big they get.
    #[test]
    fn project_snapshot_size() {
        let src = source();
        for count in [10usize, 100, 1000] {
            let clips: Vec<Clip> = (0..count)
                .map(|i| media(&src, &format!("c{i}"), i as f64 * 2.0, 2.0))
                .collect();
            let project = Project {
                tracks: vec![track_of("V1", clips)],
                width: 1920,
                height: 1080,
                fps: 30,
                ..Default::default()
            };
            let json = serde_json::to_string(&project).unwrap();
            let per_snapshot = json.len();
            eprintln!(
                "  {count:>5} clips: snapshot {:>8} KB, 100 undo levels = {:>6} MB",
                per_snapshot / 1024,
                per_snapshot * 100 / 1_048_576
            );
            assert!(
                per_snapshot * 100 < 512 * 1_048_576,
                "undo history would exceed 512 MB"
            );
        }
    }
}
