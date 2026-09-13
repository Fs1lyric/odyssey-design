//! Odyssey Design — the shared document model.
//!
//! Shared with Odyssey Workspace: a document, a spreadsheet and a deck are the
//! same shape of record seen from different angles, so they live in one table,
//! `items`, discriminated by `kind`. The editable content is JSON in `data` —
//! a block list for docs, a sparse cell map for sheets, a slide array for decks
//! — while `body` holds a plain-text rendering used for search.
//!
//! `links` carries embeds: a sheet range shown inside a doc or a slide.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The kinds of record the workspace stores. Adding a module means adding a
/// variant here, not a new table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Doc,
    Sheet,
    Slide,
    Video,
    Asset,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Doc => "doc",
            Kind::Sheet => "sheet",
            Kind::Slide => "slide",
            Kind::Video => "video",
            Kind::Asset => "asset",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "doc" => Kind::Doc,
            "sheet" => Kind::Sheet,
            "slide" => Kind::Slide,
            "video" => Kind::Video,
            "asset" => Kind::Asset,
            other => return Err(Error::Invalid(format!("unknown kind: {other}"))),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    /// Absent when the frontend is creating a new item; `create_item` mints one.
    #[serde(default)]
    pub id: String,
    pub kind: Kind,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// open | done | archived — meaningful for tasks, ignored elsewhere.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub project: Option<String>,
    /// RFC3339. Due date for tasks, start for events.
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub ends_at: Option<String>,
    /// RRULE-ish string. Drives both recurring tasks and habits.
    #[serde(default)]
    pub recurrence: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// Kind-specific fields: phone/org for contacts, mime/path for files.
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Item {
    fn from_row(row: &Row) -> rusqlite::Result<Item> {
        let kind_str: String = row.get("kind")?;
        let data_str: String = row.get("data")?;
        let tags_str: Option<String> = row.get("tags").ok();
        Ok(Item {
            id: row.get("id")?,
            kind: Kind::parse(&kind_str).unwrap_or(Kind::Doc),
            title: row.get("title")?,
            body: row.get("body")?,
            status: row.get("status")?,
            project: row.get("project")?,
            due: row.get("due")?,
            ends_at: row.get("ends_at")?,
            recurrence: row.get("recurrence")?,
            url: row.get("url")?,
            pinned: row.get::<_, i64>("pinned")? != 0,
            data: serde_json::from_str(&data_str).unwrap_or(serde_json::Value::Null),
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            tags: tags_str
                .filter(|s| !s.is_empty())
                .map(|s| s.split(',').map(str::to_string).collect())
                .unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub id: String,
    pub src: String,
    pub dst: String,
    /// subtask | backlink | attachment | related
    pub rel: String,
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

/// Used by the test suite; the app always opens a file-backed database.
#[allow(dead_code)]
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS items (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            title       TEXT NOT NULL DEFAULT '',
            body        TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'open',
            project     TEXT,
            due         TEXT,
            ends_at     TEXT,
            recurrence  TEXT,
            url         TEXT,
            pinned      INTEGER NOT NULL DEFAULT 0,
            data        TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_items_kind    ON items(kind, status);
        CREATE INDEX IF NOT EXISTS idx_items_due     ON items(due);
        CREATE INDEX IF NOT EXISTS idx_items_project ON items(project);

        CREATE TABLE IF NOT EXISTS links (
            id   TEXT PRIMARY KEY,
            src  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            dst  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            rel  TEXT NOT NULL DEFAULT 'related',
            UNIQUE(src, dst, rel)
        );
        CREATE INDEX IF NOT EXISTS idx_links_src ON links(src);
        CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);

        CREATE TABLE IF NOT EXISTS tags (
            item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            tag     TEXT NOT NULL,
            PRIMARY KEY (item_id, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

        -- Mail and AI accounts. Credentials are NEVER stored here; only the
        -- non-secret connection metadata. Secrets live in the OS keyring,
        -- addressed by this row's id. See secrets.rs.
        CREATE TABLE IF NOT EXISTS accounts (
            id         TEXT PRIMARY KEY,
            service    TEXT NOT NULL,
            label      TEXT NOT NULL DEFAULT '',
            username   TEXT NOT NULL DEFAULT '',
            host       TEXT NOT NULL DEFAULT '',
            port       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_messages (
            id         TEXT PRIMARY KEY,
            thread_id  TEXT NOT NULL,
            role       TEXT NOT NULL,
            content    TEXT NOT NULL,
            provider   TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_thread ON ai_messages(thread_id, created_at);
        "#,
    )?;
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

const ITEM_COLUMNS: &str = "i.id, i.kind, i.title, i.body, i.status, i.project, i.due, \
     i.ends_at, i.recurrence, i.url, i.pinned, i.data, i.created_at, i.updated_at, \
     (SELECT group_concat(t.tag) FROM tags t WHERE t.item_id = i.id) AS tags";

pub fn create_item(conn: &Connection, mut item: Item) -> Result<Item> {
    if item.id.is_empty() {
        item.id = Uuid::new_v4().to_string();
    }
    let ts = now();
    item.created_at = ts.clone();
    item.updated_at = ts;
    if item.status.is_empty() {
        item.status = "open".into();
    }
    conn.execute(
        "INSERT INTO items (id, kind, title, body, status, project, due, ends_at,
                            recurrence, url, pinned, data, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            item.id,
            item.kind.as_str(),
            item.title,
            item.body,
            item.status,
            item.project,
            item.due,
            item.ends_at,
            item.recurrence,
            item.url,
            item.pinned as i64,
            serde_json::to_string(&item.data)?,
            item.created_at,
            item.updated_at,
        ],
    )?;
    set_tags(conn, &item.id, &item.tags)?;
    Ok(item)
}

pub fn update_item(conn: &Connection, item: &Item) -> Result<()> {
    let n = conn.execute(
        "UPDATE items SET title=?2, body=?3, status=?4, project=?5, due=?6, ends_at=?7,
                          recurrence=?8, url=?9, pinned=?10, data=?11, updated_at=?12
         WHERE id=?1",
        params![
            item.id,
            item.title,
            item.body,
            item.status,
            item.project,
            item.due,
            item.ends_at,
            item.recurrence,
            item.url,
            item.pinned as i64,
            serde_json::to_string(&item.data)?,
            now(),
        ],
    )?;
    if n == 0 {
        return Err(Error::Invalid(format!("no item with id {}", item.id)));
    }
    set_tags(conn, &item.id, &item.tags)?;
    Ok(())
}

pub fn delete_item(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_item(conn: &Connection, id: &str) -> Result<Option<Item>> {
    let sql = format!("SELECT {ITEM_COLUMNS} FROM items i WHERE i.id = ?1");
    Ok(conn
        .query_row(&sql, params![id], Item::from_row)
        .optional()?)
}

fn set_tags(conn: &Connection, item_id: &str, tags: &[String]) -> Result<()> {
    conn.execute("DELETE FROM tags WHERE item_id = ?1", params![item_id])?;
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?1, ?2)",
            params![item_id, tag],
        )?;
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
pub struct Query {
    pub kind: Option<String>,
    pub status: Option<String>,
    pub project: Option<String>,
    pub tag: Option<String>,
    /// Free text across title and body.
    pub search: Option<String>,
    /// RFC3339 bounds against `due`.
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub limit: Option<u32>,
}

pub fn list_items(conn: &Connection, q: &Query) -> Result<Vec<Item>> {
    // Every user value is bound, never interpolated (§8.3). Only the shape of
    // the WHERE clause is built as text, and only from our own literals.
    let mut where_parts: Vec<String> = vec!["1=1".into()];
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(kind) = &q.kind {
        Kind::parse(kind)?; // reject unknown kinds before they reach SQL
        where_parts.push(format!("i.kind = ?{}", binds.len() + 1));
        binds.push(Box::new(kind.clone()));
    }
    if let Some(status) = &q.status {
        where_parts.push(format!("i.status = ?{}", binds.len() + 1));
        binds.push(Box::new(status.clone()));
    }
    if let Some(project) = &q.project {
        where_parts.push(format!("i.project = ?{}", binds.len() + 1));
        binds.push(Box::new(project.clone()));
    }
    if let Some(tag) = &q.tag {
        where_parts.push(format!(
            "EXISTS (SELECT 1 FROM tags t WHERE t.item_id = i.id AND t.tag = ?{})",
            binds.len() + 1
        ));
        binds.push(Box::new(tag.clone()));
    }
    if let Some(search) = &q.search {
        let n = binds.len() + 1;
        // ESCAPE tells SQLite that our backslashes are escapes, not literals.
        where_parts.push(format!(
            r"(i.title LIKE ?{n} ESCAPE '\' OR i.body LIKE ?{n} ESCAPE '\')"
        ));
        binds.push(Box::new(format!("%{}%", escape_like(search))));
    }
    if let Some(before) = &q.due_before {
        where_parts.push(format!("i.due IS NOT NULL AND i.due <= ?{}", binds.len() + 1));
        binds.push(Box::new(before.clone()));
    }
    if let Some(after) = &q.due_after {
        where_parts.push(format!("i.due IS NOT NULL AND i.due >= ?{}", binds.len() + 1));
        binds.push(Box::new(after.clone()));
    }

    // Cap the result set so a pathological query cannot exhaust memory (§8.4).
    let limit = q.limit.unwrap_or(500).min(2000);
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items i WHERE {} \
         ORDER BY i.pinned DESC, COALESCE(i.due, i.updated_at) ASC LIMIT {limit}",
        where_parts.join(" AND ")
    );

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), Item::from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// LIKE treats % and _ as wildcards; a search for "50%" must not match everything.
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn link(conn: &Connection, src: &str, dst: &str, rel: &str) -> Result<Link> {
    let l = Link {
        id: Uuid::new_v4().to_string(),
        src: src.to_string(),
        dst: dst.to_string(),
        rel: rel.to_string(),
    };
    conn.execute(
        "INSERT OR IGNORE INTO links (id, src, dst, rel) VALUES (?1,?2,?3,?4)",
        params![l.id, l.src, l.dst, l.rel],
    )?;
    Ok(l)
}

/// The counterpart to `link`. Kept so the link API is complete, and wired up
/// when the UI grows an embed-removal control.
#[allow(dead_code)]
pub fn unlink(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM links WHERE id = ?1", params![id])?;
    Ok(())
}

/// Everything connected to an item, in either direction — this is what makes
/// backlinks work without a second table.
pub fn related(conn: &Connection, id: &str) -> Result<Vec<Item>> {
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items i
         WHERE i.id IN (SELECT dst FROM links WHERE src = ?1)
            OR i.id IN (SELECT src FROM links WHERE dst = ?1)
         ORDER BY i.updated_at DESC LIMIT 200"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![id], Item::from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}





#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: Kind, title: &str) -> Item {
        Item {
            id: String::new(),
            kind,
            title: title.into(),
            body: String::new(),
            status: String::new(),
            project: None,
            due: None,
            ends_at: None,
            recurrence: None,
            url: None,
            pinned: false,
            data: serde_json::Value::Null,
            created_at: String::new(),
            updated_at: String::new(),
            tags: vec![],
        }
    }

    #[test]
    fn creates_and_reads_back() {
        let c = open_in_memory().unwrap();
        let t = create_item(&c, item(Kind::Doc, "Ship v1")).unwrap();
        let got = get_item(&c, &t.id).unwrap().unwrap();
        assert_eq!(got.title, "Ship v1");
        assert_eq!(got.status, "open");
    }

    #[test]
    fn links_are_bidirectional_for_backlinks() {
        let c = open_in_memory().unwrap();
        let note = create_item(&c, item(Kind::Doc, "Design notes")).unwrap();
        let task = create_item(&c, item(Kind::Sheet, "Budget")).unwrap();
        link(&c, &note.id, &task.id, "related").unwrap();
        // The link was made note -> task, but the task must still see the note.
        assert_eq!(related(&c, &task.id).unwrap()[0].id, note.id);
        assert_eq!(related(&c, &note.id).unwrap()[0].id, task.id);
    }

    #[test]
    fn deleting_an_item_cascades_its_links() {
        let c = open_in_memory().unwrap();
        let a = create_item(&c, item(Kind::Doc, "A")).unwrap();
        let b = create_item(&c, item(Kind::Doc, "B")).unwrap();
        link(&c, &a.id, &b.id, "related").unwrap();
        delete_item(&c, &a.id).unwrap();
        assert!(related(&c, &b.id).unwrap().is_empty());
    }

    /// Regression test for §8.3: a search term containing LIKE wildcards must
    /// be matched literally, not expanded into a match-everything pattern.
    #[test]
    fn like_wildcards_in_search_are_escaped() {
        let c = open_in_memory().unwrap();
        create_item(&c, item(Kind::Doc, "Quarterly report")).unwrap();
        create_item(&c, item(Kind::Doc, "Up 50% this month")).unwrap();
        let q = Query { search: Some("50%".into()), ..Default::default() };
        let hits = list_items(&c, &q).unwrap();
        assert_eq!(hits.len(), 1, "wildcard leaked: {hits:?}");
        assert_eq!(hits[0].title, "Up 50% this month");
    }

    /// Regression test for §8.3: `kind` shapes the SQL text, so an unknown
    /// value must be rejected before the query is built.
    #[test]
    fn unknown_kind_is_rejected() {
        let c = open_in_memory().unwrap();
        let q = Query { kind: Some("doc' OR 1=1 --".into()), ..Default::default() };
        assert!(list_items(&c, &q).is_err());
    }

    /// Regression test for §8.4: an unbounded query must not be honoured.
    #[test]
    fn limit_is_capped() {
        let c = open_in_memory().unwrap();
        for n in 0..50 {
            create_item(&c, item(Kind::Doc, &format!("doc {n}"))).unwrap();
        }
        let q = Query { limit: Some(u32::MAX), ..Default::default() };
        assert_eq!(list_items(&c, &q).unwrap().len(), 50);
    }


}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    /// Regression test for a bug that made the app unusable: the frontend's
    /// "new item" payload has no `id`, because `create_item` mints one. `id`
    /// was a required field, so every create failed to deserialize and nothing
    /// could be opened. The browser dev store filled an id in, which is exactly
    /// why this never showed up in browser testing.
    #[test]
    fn the_frontends_new_item_payload_deserializes() {
        // These are verbatim the shapes blankItem() produces in src/api.ts.
        let payloads = [
            r#"{"kind":"doc","title":"Untitled document","body":"","status":"open","pinned":false,"tags":[],"data":{"html":""}}"#,
            r#"{"kind":"sheet","title":"Untitled sheet","body":"","status":"open","pinned":false,"tags":[],"data":{"cells":{}}}"#,
            r#"{"kind":"slide","title":"Untitled deck","body":"","status":"open","pinned":false,"tags":[],"data":{"slides":[{"title":"Title slide","body":""}]}}"#,
            r#"{"kind":"video","title":"Untitled timeline","body":"","status":"open","pinned":false,"tags":[],"data":{"tracks":[]}}"#,
        ];
        for payload in payloads {
            let item: Item = serde_json::from_str(payload)
                .unwrap_or_else(|e| panic!("payload rejected: {e}\n{payload}"));
            assert!(item.id.is_empty(), "a new item carries no id yet");
        }
    }

    /// And the whole round trip must work: create, then read it back.
    #[test]
    fn every_kind_can_be_created_and_reopened() {
        let c = open_in_memory().unwrap();
        for kind in ["doc", "sheet", "slide", "video"] {
            let payload = format!(
                r#"{{"kind":"{kind}","title":"Untitled","body":"","status":"open","pinned":false,"tags":[],"data":{{}}}}"#
            );
            let item: Item = serde_json::from_str(&payload).unwrap();
            let created = create_item(&c, item).unwrap();
            assert!(!created.id.is_empty(), "create_item must mint an id");

            let reopened = get_item(&c, &created.id)
                .unwrap()
                .unwrap_or_else(|| panic!("{kind} could not be reopened"));
            assert_eq!(reopened.kind.as_str(), kind);
        }
    }
}

#[cfg(test)]
mod query_boundary {
    use super::*;

    /// `list_items` runs on every app start with an empty query object. If that
    /// failed to deserialize, the library would never load at all.
    #[test]
    fn an_empty_query_deserializes() {
        let q: Query = serde_json::from_str("{}").expect("empty query must be accepted");
        assert!(q.kind.is_none() && q.search.is_none() && q.limit.is_none());
    }

    #[test]
    fn a_search_only_query_deserializes() {
        let q: Query = serde_json::from_str(r#"{"search":"budget"}"#).unwrap();
        assert_eq!(q.search.as_deref(), Some("budget"));
        assert!(q.kind.is_none(), "unsent fields stay absent");
    }
}
