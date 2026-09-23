//! Odyssey Design — Tauri command surface.

mod db;
mod hw;
mod sheet;
#[cfg(test)]
mod stress;
mod sync;
mod timeline;
mod track;
mod video;

use db::{Item, Query};
use sheet::{Addr, Sheet, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// One connection behind a mutex. SQLite is fast enough that contention is a
/// non-issue at desktop scale, and it keeps the threading story trivial.
pub struct AppState {
    conn: Mutex<rusqlite::Connection>,
}

type CmdResult<T> = Result<T, db::Error>;

fn with_db<T>(
    state: &tauri::State<'_, AppState>,
    f: impl FnOnce(&rusqlite::Connection) -> CmdResult<T>,
) -> CmdResult<T> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| db::Error::Invalid("database lock poisoned".into()))?;
    f(&conn)
}

#[tauri::command]
fn list_items(state: tauri::State<'_, AppState>, query: Query) -> CmdResult<Vec<Item>> {
    with_db(&state, |c| db::list_items(c, &query))
}

#[tauri::command]
fn get_item(state: tauri::State<'_, AppState>, id: String) -> CmdResult<Option<Item>> {
    with_db(&state, |c| db::get_item(c, &id))
}

#[tauri::command]
fn create_item(state: tauri::State<'_, AppState>, item: Item) -> CmdResult<Item> {
    with_db(&state, |c| db::create_item(c, item))
}

#[tauri::command]
fn update_item(state: tauri::State<'_, AppState>, item: Item) -> CmdResult<()> {
    with_db(&state, |c| db::update_item(c, &item))
}

#[tauri::command]
fn delete_item(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    with_db(&state, |c| db::delete_item(c, &id))
}

#[tauri::command]
fn related(state: tauri::State<'_, AppState>, id: String) -> CmdResult<Vec<Item>> {
    with_db(&state, |c| db::related(c, &id))
}

#[tauri::command]
fn link_items(
    state: tauri::State<'_, AppState>,
    src: String,
    dst: String,
    rel: String,
) -> CmdResult<db::Link> {
    with_db(&state, |c| db::link(c, &src, &dst, &rel))
}

/// Recalculate a whole sheet. The frontend owns the raw cell text; Rust owns
/// evaluation, so the formula engine has one implementation and one test suite.
#[tauri::command]
fn evaluate_sheet(cells: HashMap<String, String>) -> HashMap<String, Value> {
    let mut s = Sheet::default();
    for (addr, raw) in cells {
        s.set(&addr, &raw);
    }
    s.evaluate_all()
}

/// Evaluate a single formula in the context of a sheet — used by the formula bar.
#[tauri::command]
fn evaluate_cell(cells: HashMap<String, String>, addr: String) -> Value {
    let mut s = Sheet::default();
    for (a, raw) in cells {
        s.set(&a, &raw);
    }
    match Addr::parse(&addr) {
        Some(a) => s.eval_cell(a),
        None => Value::Error("#REF!".into()),
    }
}

// ---------- Video ----------

#[tauri::command]
fn probe_media(path: String) -> Result<video::MediaInfo, video::Error> {
    video::probe(&path)
}

// ---------- Multi-track project ----------

#[tauri::command]
fn render_profiles() -> Vec<timeline::RenderProfile> {
    timeline::render_profiles()
}

#[tauri::command]
fn waveform(path: String, buckets: usize) -> Result<Vec<f32>, video::Error> {
    video::waveform(&path, buckets)
}

/// Render a span of the timeline into the on-disk preview cache.
#[tauri::command]
fn render_timeline_preview(
    app: tauri::AppHandle,
    project: timeline::Project,
    start: f64,
    end: f64,
    scale: f64,
) -> Result<timeline::PreviewChunk, timeline::Error> {
    let dir = preview_cache_dir(&app)?;
    timeline::render_preview(&project, start, end, scale, &dir)
}

/// The cache key a range would have right now. The UI compares this against a
/// chunk's stored key to decide whether the chunk is still valid.
#[tauri::command]
fn preview_key(project: timeline::Project, start: f64, end: f64, scale: f64) -> String {
    timeline::preview_key(&project, start, end, scale)
}

#[tauri::command]
fn clear_timeline_previews(app: tauri::AppHandle) -> Result<usize, timeline::Error> {
    let dir = preview_cache_dir(&app)?;
    timeline::clear_previews(&dir)
}

fn preview_cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, timeline::Error> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
        .join("previews");
    Ok(dir)
}

// ---------- Proxies ----------

fn proxy_cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, video::Error> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| video::Error::Invalid(e.to_string()))?
        .join("proxies"))
}

#[tauri::command]
fn create_proxy(
    app: tauri::AppHandle,
    path: String,
    width: u32,
) -> Result<video::Proxy, video::Error> {
    let dir = proxy_cache_dir(&app)?;
    video::create_proxy(&path, width, &dir)
}

#[tauri::command]
fn find_proxy(app: tauri::AppHandle, path: String, width: u32) -> Option<video::Proxy> {
    let dir = proxy_cache_dir(&app).ok()?;
    video::find_proxy(&path, width, &dir)
}

#[tauri::command]
fn clear_proxies(app: tauri::AppHandle) -> Result<usize, video::Error> {
    let dir = proxy_cache_dir(&app)?;
    video::clear_proxies(&dir)
}

// ---------- Subtitles ----------

#[tauri::command]
fn subtitles_to_srt(subtitles: Vec<timeline::Subtitle>) -> String {
    timeline::to_srt(&subtitles)
}

#[tauri::command]
fn subtitles_from_srt(text: String) -> Vec<timeline::Subtitle> {
    timeline::from_srt(&text)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, timeline::Error> {
    std::fs::read_to_string(&path).map_err(|e| timeline::Error::Invalid(e.to_string()))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), timeline::Error> {
    std::fs::write(&path, contents).map_err(|e| timeline::Error::Invalid(e.to_string()))
}

fn preset_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, timeline::Error> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
        .join("presets"))
}

#[tauri::command]
fn run_render_queue(
    app: tauri::AppHandle,
    jobs: Vec<timeline::RenderJob>,
) -> Result<Vec<timeline::JobResult>, timeline::Error> {
    let dir = preview_cache_dir(&app)?;
    Ok(timeline::run_queue(&jobs, &dir))
}

#[tauri::command]
fn save_preset(
    app: tauri::AppHandle,
    profile: timeline::RenderProfile,
) -> Result<String, timeline::Error> {
    timeline::save_preset(&profile, &preset_dir(&app)?)
}

#[tauri::command]
fn load_presets(app: tauri::AppHandle) -> Result<Vec<timeline::RenderProfile>, timeline::Error> {
    Ok(timeline::load_presets(&preset_dir(&app)?))
}

#[tauri::command]
fn delete_preset(app: tauri::AppHandle, id: String) -> Result<(), timeline::Error> {
    timeline::delete_preset(&id, &preset_dir(&app)?)
}

#[tauri::command]
fn flatten_nested(
    app: tauri::AppHandle,
    project: timeline::Project,
) -> Result<timeline::Project, timeline::Error> {
    let dir = preview_cache_dir(&app)?;
    timeline::flatten_nested(&project, &dir)
}

#[tauri::command]
fn detect_scenes(source: String, threshold: f64) -> Result<Vec<f64>, timeline::Error> {
    timeline::detect_scenes(&source, threshold)
}

#[tauri::command]
fn export_edl(project: timeline::Project, title: String) -> String {
    timeline::to_edl(&project, &title)
}

#[tauri::command]
fn export_otio(project: timeline::Project, name: String) -> String {
    timeline::to_otio(&project, &name)
}

fn autosave_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, timeline::Error> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
        .join("autosave"))
}

/// The snapshot is written as the editor sent it. Parsing it first proves it
/// is a project, but writing the typed copy would drop editor-only fields such
/// as a bypassed effect's switch, and a restore would silently re-enable it.
#[tauri::command]
fn autosave(
    app: tauri::AppHandle,
    project: serde_json::Value,
    item_id: String,
) -> Result<String, timeline::Error> {
    serde_json::from_value::<timeline::Project>(project.clone())?;
    // The id becomes part of a filename.
    if item_id.is_empty()
        || !item_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(timeline::Error::Invalid("invalid item id".into()));
    }
    let dir = autosave_dir(&app)?;
    timeline::autosave(&project, &item_id, &dir)
}

#[tauri::command]
fn autosaves(app: tauri::AppHandle, item_id: String) -> Result<Vec<String>, timeline::Error> {
    let dir = autosave_dir(&app)?;
    Ok(timeline::autosaves(&item_id, &dir))
}

#[tauri::command]
fn restore_autosave(
    app: tauri::AppHandle,
    path: String,
) -> Result<serde_json::Value, timeline::Error> {
    // Only snapshots this app wrote may be read back through this command.
    let dir = autosave_dir(&app)?;
    let wanted = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?;
    if !wanted.starts_with(dir.canonicalize().unwrap_or(dir)) {
        return Err(timeline::Error::Invalid("not an autosave snapshot".into()));
    }
    let value: serde_json::Value = timeline::restore_autosave(&path)?;
    serde_json::from_value::<timeline::Project>(value.clone())?;
    Ok(value)
}

#[tauri::command]
fn export_frame(
    project: timeline::Project,
    at: f64,
    output: String,
) -> Result<String, timeline::Error> {
    timeline::export_frame(&project, at, std::path::Path::new(&output))
}

/// The exact frame at `at`, cached, for the monitor to show while parked on
/// effects the live preview cannot reproduce.
#[tauri::command]
async fn preview_frame(
    app: tauri::AppHandle,
    project: timeline::Project,
    at: f64,
) -> Result<String, timeline::Error> {
    let dir = preview_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || timeline::preview_frame(&project, at, &dir))
        .await
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
}

/// Offsets that line `others` up with `reference` by their audio.
#[tauri::command]
async fn audio_sync(
    reference: String,
    others: Vec<String>,
) -> Result<Vec<sync::SyncResult>, timeline::Error> {
    tauri::async_runtime::spawn_blocking(move || sync::sync(&reference, &others))
        .await
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
}

/// Follow a region of a source from `start` to `end` (source seconds).
#[tauri::command]
async fn track_region(
    source: String,
    start: f64,
    end: f64,
    rate: f64,
    region: track::Region,
) -> Result<track::TrackResult, timeline::Error> {
    tauri::async_runtime::spawn_blocking(move || track::track(&source, start, end, rate, region))
        .await
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
}

/// EBU R128 loudness of the finished mix, measured from a real render.
#[tauri::command]
async fn measure_loudness(
    app: tauri::AppHandle,
    project: timeline::Project,
) -> Result<timeline::LoudnessReport, timeline::Error> {
    let dir = preview_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || timeline::measure_loudness(&project, &dir))
        .await
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
}

#[tauri::command]
fn audio_peak(source: String, start: f64, end: f64) -> Result<f64, timeline::Error> {
    timeline::audio_peak(&source, start, end)
}

/// Which of these paths still point at a file, for offline media detection.
#[tauri::command]
fn media_status(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::path::Path::new(p).is_file())
        .collect()
}

#[tauri::command]
fn hardware_profiles() -> Vec<timeline::RenderProfile> {
    timeline::hardware_profiles()
}

#[tauri::command]
fn analyse_stabilisation(app: tauri::AppHandle, source: String) -> Result<String, timeline::Error> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
        .join("stabilise");
    timeline::analyse_stabilisation(&source, &dir)
}

#[tauri::command]
fn freeze_frame(app: tauri::AppHandle, source: String, at: f64) -> Result<String, timeline::Error> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| timeline::Error::Invalid(e.to_string()))?
        .join("stills");
    timeline::freeze_frame(&source, at, &dir)
}

#[tauri::command]
fn render_zone(
    project: timeline::Project,
    profile: timeline::RenderProfile,
    output: String,
    start: f64,
    end: f64,
) -> Result<String, timeline::Error> {
    timeline::render_zone(
        &project,
        &profile,
        std::path::Path::new(&output),
        start,
        end,
    )
}

#[tauri::command]
fn frei0r_plugins() -> Vec<timeline::Frei0rPlugin> {
    timeline::frei0r_plugins()
}

#[tauri::command]
fn render_project(
    project: timeline::Project,
    profile: timeline::RenderProfile,
    output: String,
) -> Result<String, timeline::Error> {
    timeline::render(&project, &profile, std::path::Path::new(&output))
}

#[tauri::command]
fn project_render_args(
    project: timeline::Project,
    profile: timeline::RenderProfile,
    output: String,
) -> Result<Vec<String>, timeline::Error> {
    timeline::render_args(&project, &profile, std::path::Path::new(&output), None)
}

#[tauri::command]
fn project_duration(project: timeline::Project) -> f64 {
    project.duration()
}

#[tauri::command]
fn clip_thumbnail(app: tauri::AppHandle, source: String, at: f64) -> Result<String, video::Error> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| video::Error::Invalid(e.to_string()))?
        .join("thumbs");
    std::fs::create_dir_all(&dir)?;
    let name = format!("{}.png", uuid::Uuid::new_v4());
    video::thumbnail(&source, at, 320, &dir.join(name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("odyssey-design.sqlite3"))?;
            app.manage(AppState {
                conn: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_items,
            get_item,
            create_item,
            update_item,
            delete_item,
            related,
            link_items,
            evaluate_sheet,
            evaluate_cell,
            probe_media,
            clip_thumbnail,
            render_profiles,
            frei0r_plugins,
            hardware_profiles,
            detect_scenes,
            run_render_queue,
            save_preset,
            load_presets,
            delete_preset,
            flatten_nested,
            export_edl,
            export_otio,
            autosave,
            autosaves,
            restore_autosave,
            export_frame,
            preview_frame,
            measure_loudness,
            track_region,
            audio_sync,
            audio_peak,
            media_status,
            analyse_stabilisation,
            freeze_frame,
            render_zone,
            create_proxy,
            find_proxy,
            clear_proxies,
            subtitles_to_srt,
            subtitles_from_srt,
            read_text_file,
            write_text_file,
            render_timeline_preview,
            preview_key,
            clear_timeline_previews,
            waveform,
            render_project,
            project_render_args,
            project_duration,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Odyssey Design");
}
