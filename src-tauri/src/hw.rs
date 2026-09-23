//! GPU acceleration.
//!
//! Three separate things are called "GPU" in a video editor, and only two of
//! them live here. The preview's shaders are in `src/fxpipe.ts`; this module
//! covers the export path: decoding sources on the GPU, and handing the
//! finished frames to a hardware encoder.
//!
//! ## Why the encoders are run before they are offered
//!
//! `ffmpeg -encoders` lists what ffmpeg was *compiled* with, not what this
//! machine can run. A distribution ffmpeg advertises `h264_nvenc` on a laptop
//! with no NVIDIA card, `h264_qsv` on AMD, and `h264_vaapi` where `/dev/dri`
//! does not exist or is not readable by this user. Offering such a profile
//! turns a long export into a failed one, so each candidate is asked to encode
//! two frames of `testsrc` to `null` before it is listed. The probe costs a
//! few hundred milliseconds, runs the candidates in parallel and is cached for
//! the life of the process.
//!
//! ## Why the graph changes shape per family
//!
//! NVENC, AMF and VideoToolbox take ordinary software frames, so they are a
//! codec substitution and nothing else. VAAPI and QSV take GPU surfaces: the
//! filter graph has to end in `format=nv12,hwupload`, a device has to be
//! initialised and bound to the graph with `-filter_hw_device`, and the
//! output `-pix_fmt` must not be set, because the frames reaching the encoder
//! are hardware surfaces rather than planes. Getting any one of those wrong
//! fails at encoder-init time with a message about impossible conversions.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// The GPU encoder families this knows how to drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// NVIDIA NVENC. Takes software frames.
    Nvenc,
    /// VA-API: Intel and AMD on Linux. Takes GPU surfaces.
    Vaapi,
    /// Intel Quick Sync via libmfx/oneVPL. Takes GPU surfaces.
    Qsv,
    /// Apple VideoToolbox. Takes software frames.
    VideoToolbox,
    /// AMD Advanced Media Framework, Windows. Takes software frames.
    Amf,
}

impl Family {
    /// The family an encoder name belongs to, or None for a software encoder.
    pub fn of(codec: &str) -> Option<Family> {
        match codec.rsplit_once('_').map(|(_, suffix)| suffix) {
            Some("nvenc") => Some(Family::Nvenc),
            Some("vaapi") => Some(Family::Vaapi),
            Some("qsv") => Some(Family::Qsv),
            Some("videotoolbox") => Some(Family::VideoToolbox),
            Some("amf") => Some(Family::Amf),
            _ => None,
        }
    }

    /// True when the encoder consumes GPU surfaces, so the filter graph must
    /// upload its frames and the output pixel format must be left alone.
    pub fn uploads(self) -> bool {
        matches!(self, Family::Vaapi | Family::Qsv)
    }

    /// Global options that create the device and bind it to the filter graph.
    /// These are ffmpeg's own options and belong before the first input.
    pub fn device_args(self) -> Vec<String> {
        let opt = |s: &str| s.to_string();
        match self {
            Family::Vaapi => match render_node() {
                Some(node) => vec![
                    opt("-init_hw_device"),
                    format!("vaapi=va:{node}"),
                    opt("-filter_hw_device"),
                    opt("va"),
                ],
                None => Vec::new(),
            },
            // QSV on Linux is a VA-API child: derived from a VA-API device it
            // shares surfaces with the driver that actually owns the GPU. On
            // Windows the D3D11 default is right and a node would be wrong.
            Family::Qsv => match render_node() {
                Some(node) if cfg!(target_os = "linux") => vec![
                    opt("-init_hw_device"),
                    format!("vaapi=va:{node}"),
                    opt("-init_hw_device"),
                    opt("qsv=hw@va"),
                    opt("-filter_hw_device"),
                    opt("hw"),
                ],
                _ => vec![
                    opt("-init_hw_device"),
                    opt("qsv=hw"),
                    opt("-filter_hw_device"),
                    opt("hw"),
                ],
            },
            Family::Nvenc | Family::VideoToolbox | Family::Amf => Vec::new(),
        }
    }

    /// Filters appended to the end of the video chain. Empty for the families
    /// that take software frames.
    ///
    /// `extra_hw_frames` enlarges QSV's surface pool: the default is sized for
    /// a plain transcode and a compositing graph holds more frames in flight
    /// than that, which surfaces as "no free surfaces" partway through a long
    /// export rather than at the start.
    pub fn upload_filters(self) -> Vec<String> {
        match self {
            Family::Vaapi => vec!["format=nv12".into(), "hwupload".into()],
            Family::Qsv => vec!["format=nv12".into(), "hwupload=extra_hw_frames=64".into()],
            _ => Vec::new(),
        }
    }

    /// Encoder options beyond `-c:v` and the bitrate: the rate control mode
    /// and the family's own spelling of "preset".
    ///
    /// The preset names in a profile are x264's, because that is the
    /// vocabulary the interface uses. Each family gets them translated rather
    /// than passed through: NVENC's modern names are `p1`–`p7`, AMF's are
    /// three words, and VA-API and VideoToolbox have no preset at all and
    /// reject the option.
    pub fn encoder_args(self, preset: &str) -> Vec<String> {
        match self {
            Family::Nvenc => vec![
                "-preset".into(),
                nvenc_preset(preset).into(),
                // Without an explicit mode some builds pick constant QP and
                // quietly ignore the bitrate the profile asked for.
                "-rc".into(),
                "vbr".into(),
            ],
            Family::Qsv => vec!["-preset".into(), qsv_preset(preset).into()],
            Family::Amf => vec!["-quality".into(), amf_quality(preset).into()],
            // VA-API has -compression_level, not a preset, and its default is
            // the driver's balanced setting. VideoToolbox has neither.
            Family::Vaapi | Family::VideoToolbox => Vec::new(),
        }
    }
}

/// x264 preset vocabulary to NVENC's p1–p7. A name that is already a p-level
/// passes through, so a profile can name one directly.
fn nvenc_preset(preset: &str) -> &'static str {
    match preset {
        "p1" | "ultrafast" | "superfast" | "veryfast" => "p1",
        "p2" | "faster" => "p2",
        "p3" | "fast" => "p3",
        "p5" | "slow" => "p5",
        "p6" | "slower" => "p6",
        "p7" | "veryslow" | "placebo" => "p7",
        _ => "p4",
    }
}

/// QSV shares x264's names but stops at veryfast and veryslow.
fn qsv_preset(preset: &str) -> &'static str {
    match preset {
        "ultrafast" | "superfast" | "veryfast" => "veryfast",
        "faster" => "faster",
        "fast" => "fast",
        "slow" => "slow",
        "slower" => "slower",
        "veryslow" | "placebo" => "veryslow",
        _ => "medium",
    }
}

/// AMF has three speed/quality points rather than a ladder.
fn amf_quality(preset: &str) -> &'static str {
    match preset {
        "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" => "speed",
        "slow" | "slower" | "veryslow" | "placebo" => "quality",
        _ => "balanced",
    }
}

/// Per-input options that decode on the GPU.
///
/// `auto` rather than a named method on purpose: it is chosen per input and
/// per codec, and falls back to software decoding when the machine, the
/// driver or that particular codec cannot. A timeline mixing H.264 from a
/// camera with VP9 from a screen recorder therefore accelerates what it can
/// and decodes the rest normally, instead of failing on the first file the
/// GPU does not know.
///
/// No `-hwaccel_output_format` is set, so ffmpeg brings frames back to system
/// memory for the filter graph. Keeping them on the GPU would mean the whole
/// compositing graph in hardware filters, which is a different renderer.
pub fn decode_args() -> Vec<&'static str> {
    vec!["-hwaccel", "auto"]
}

/// The DRM render node VA-API and Linux QSV should open.
///
/// `ODYSSEY_VAAPI_DEVICE` wins when set, for machines with a discrete card and
/// an integrated one where the wrong guess is the slow one. Otherwise the
/// nodes are tried in order and the first that can actually take an upload is
/// kept — a node existing says nothing about the user being in the `render`
/// group or the driver being installed.
pub fn render_node() -> Option<String> {
    probe().vaapi_device.clone()
}

/// Hardware encoders this machine can really run, in preference order.
pub fn encoders() -> Vec<String> {
    probe().encoders.clone()
}

/// Every encoder worth asking about, most preferred first. Order decides the
/// order of the profiles in the export dialog.
const CANDIDATES: [&str; 13] = [
    "h264_nvenc",
    "hevc_nvenc",
    "av1_nvenc",
    "h264_qsv",
    "hevc_qsv",
    "av1_qsv",
    "h264_vaapi",
    "hevc_vaapi",
    "av1_vaapi",
    "h264_videotoolbox",
    "hevc_videotoolbox",
    "h264_amf",
    "hevc_amf",
];

struct Probe {
    encoders: Vec<String>,
    vaapi_device: Option<String>,
}

static PROBE: OnceLock<Probe> = OnceLock::new();

fn probe() -> &'static Probe {
    PROBE.get_or_init(|| {
        // No ffmpeg, no acceleration, and no point probing thirteen times to
        // find that out.
        let Ok(out) = Command::new("ffmpeg")
            .args(["-hide_banner", "-encoders"])
            .output()
        else {
            return Probe {
                encoders: Vec::new(),
                vaapi_device: None,
            };
        };
        let compiled = String::from_utf8_lossy(&out.stdout).into_owned();

        let vaapi_device = find_render_node();

        let candidates: Vec<&'static str> = CANDIDATES
            .into_iter()
            .filter(|e| compiled.contains(e))
            .filter(|e| {
                // A surface encoder without a working device cannot be set up
                // at all, so skip the probe rather than pay for a failure.
                !Family::of(e).is_some_and(|f| f.uploads())
                    || vaapi_device.is_some()
                    || !cfg!(target_os = "linux")
            })
            .collect();

        // Each probe is its own ffmpeg process, mostly spent waiting on a
        // driver, so they run together rather than end to end.
        let mut threads = Vec::new();
        for enc in candidates {
            let device = vaapi_device.clone();
            threads.push(std::thread::spawn(move || {
                (enc, encoder_runs(enc, &device))
            }));
        }
        let encoders = threads
            .into_iter()
            .filter_map(|t| t.join().ok())
            .filter(|(_, ok)| *ok)
            .map(|(enc, _)| enc.to_string())
            .collect();

        Probe {
            encoders,
            vaapi_device,
        }
    })
}

/// Can this encoder actually encode? Two frames of `testsrc` to the null
/// muxer: enough to build the device, initialise the encoder and be told no.
fn encoder_runs(encoder: &str, device: &Option<String>) -> bool {
    let family = Family::of(encoder);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-v".into(), "error".into()];
    if let Some(f) = family {
        // device_args() reads the cached node, which is not published yet
        // while the cache is being built, so the device is passed in.
        args.extend(device_args_with(f, device.as_deref()));
    }
    args.extend(
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=25:d=0.2",
            "-vf",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    let mut chain = vec!["format=nv12".to_string()];
    if family.is_some_and(Family::uploads) {
        chain.push("hwupload".into());
    }
    args.push(chain.join(","));
    args.extend(
        [
            "-c:v",
            encoder,
            "-b:v",
            "1M",
            "-frames:v",
            "2",
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(|s| s.to_string()),
    );

    Command::new("ffmpeg")
        .args(&args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `Family::device_args` against an explicit node rather than the cache.
fn device_args_with(family: Family, node: Option<&str>) -> Vec<String> {
    match (family, node) {
        (Family::Vaapi, Some(n)) => vec![
            "-init_hw_device".into(),
            format!("vaapi=va:{n}"),
            "-filter_hw_device".into(),
            "va".into(),
        ],
        (Family::Qsv, Some(n)) if cfg!(target_os = "linux") => vec![
            "-init_hw_device".into(),
            format!("vaapi=va:{n}"),
            "-init_hw_device".into(),
            "qsv=hw@va".into(),
            "-filter_hw_device".into(),
            "hw".into(),
        ],
        (Family::Qsv, _) => vec![
            "-init_hw_device".into(),
            "qsv=hw".into(),
            "-filter_hw_device".into(),
            "hw".into(),
        ],
        _ => Vec::new(),
    }
}

/// The first render node that accepts an upload. No encoder is involved: this
/// asks only whether a VA-API device can be created and fed, which is the
/// thing that differs between machines.
fn find_render_node() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let mut nodes: Vec<String> = Vec::new();
    if let Ok(explicit) = std::env::var("ODYSSEY_VAAPI_DEVICE") {
        if !explicit.trim().is_empty() {
            nodes.push(explicit);
        }
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir("/dev/dri")
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("renderD"))
        })
        .collect();
    found.sort();
    nodes.extend(found.iter().map(|p| p.to_string_lossy().to_string()));

    nodes.into_iter().find(|node| {
        Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-init_hw_device",
                &format!("vaapi=va:{node}"),
                "-filter_hw_device",
                "va",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=25:d=0.1",
                "-vf",
                "format=nv12,hwupload",
                "-f",
                "null",
                "-",
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_candidate_belongs_to_a_family() {
        for enc in CANDIDATES {
            assert!(
                Family::of(enc).is_some(),
                "{enc} has no family, so it would be driven as a software encoder"
            );
        }
    }

    #[test]
    fn only_surface_families_upload() {
        assert!(Family::Vaapi.uploads());
        assert!(Family::Qsv.uploads());
        for f in [Family::Nvenc, Family::VideoToolbox, Family::Amf] {
            assert!(!f.uploads(), "{f:?} takes software frames");
            assert!(f.upload_filters().is_empty());
        }
    }

    #[test]
    fn a_software_encoder_has_no_family() {
        for enc in [
            "libx264",
            "libx265",
            "libvpx-vp9",
            "prores_ks",
            "png",
            "none",
        ] {
            assert_eq!(Family::of(enc), None, "{enc} is software");
        }
    }

    #[test]
    fn families_that_reject_a_preset_are_not_given_one() {
        for f in [Family::Vaapi, Family::VideoToolbox] {
            assert!(
                !f.encoder_args("medium").iter().any(|a| a == "-preset"),
                "{f:?} rejects -preset"
            );
        }
    }

    #[test]
    fn presets_are_translated_into_each_familys_vocabulary() {
        let nvenc = |p| Family::Nvenc.encoder_args(p)[1].clone();
        assert_eq!(nvenc("veryfast"), "p1");
        assert_eq!(nvenc("medium"), "p4");
        assert_eq!(nvenc("veryslow"), "p7");
        // An unknown name lands on the balanced point rather than failing.
        assert_eq!(nvenc("nonsense"), "p4");
        // A p-level a profile names directly survives the round trip.
        assert_eq!(nvenc("p6"), "p6");

        let amf = |p| Family::Amf.encoder_args(p)[1].clone();
        assert_eq!(amf("fast"), "speed");
        assert_eq!(amf("medium"), "balanced");
        assert_eq!(amf("slower"), "quality");

        // x264 names QSV does not have are pulled to its nearest point.
        assert_eq!(Family::Qsv.encoder_args("ultrafast")[1], "veryfast");
        assert_eq!(Family::Qsv.encoder_args("placebo")[1], "veryslow");
    }

    #[test]
    fn a_surface_family_binds_its_device_to_the_graph() {
        // Without -filter_hw_device the upload has no device to upload to, and
        // ffmpeg fails at graph configuration rather than at encode.
        for f in [Family::Vaapi, Family::Qsv] {
            let args = device_args_with(f, Some("/dev/dri/renderD128"));
            assert!(
                args.iter().any(|a| a == "-filter_hw_device"),
                "{f:?} must bind a device to the filter graph"
            );
            assert!(args.iter().any(|a| a == "-init_hw_device"));
        }
    }

    /// What this machine can really do. Ignored by default because it runs
    /// ffmpeg against the drivers, which is the whole point of it: run it with
    /// `cargo test --lib hw::tests::report -- --ignored --nocapture` when a
    /// profile is missing from the export dialog and it should not be.
    #[test]
    #[ignore]
    fn report() {
        println!("render node: {:?}", render_node());
        let usable = encoders();
        for enc in CANDIDATES {
            println!(
                "  {:<20} {}",
                enc,
                if usable.iter().any(|u| u == enc) {
                    "runs here"
                } else {
                    "not usable"
                }
            );
        }
    }

    #[test]
    fn software_frame_families_need_no_device() {
        for f in [Family::Nvenc, Family::VideoToolbox, Family::Amf] {
            assert!(f.device_args().is_empty(), "{f:?} needs no device");
        }
    }
}
