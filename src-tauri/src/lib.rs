use chrono::{Datelike, Utc};
use image::{imageops::FilterType, GenericImageView, ImageReader};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use rfd::FileDialog;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use url::Url;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultImportResult {
    vault_path: String,
    sha256: String,
    ext: String,
    size: u64,
    created_at: String,
    original_filename: String,
}

const DEFAULT_ROOT_COLLECTION_ID: &str = "root";
const DEFAULT_ROOT_COLLECTION_NAME: &str = "Root";
const DEFAULT_ROOT_COLLECTION_ICON: &str = "folder";
const DEFAULT_ROOT_COLLECTION_COLOR: &str = "#60a5fa";
const DEFAULT_TAG_COLOR: &str = "#64748b";
const DEFAULT_THUMB_STATUS: &str = "pending";
const DEFAULT_IMPORT_STATUS: &str = "ready";
const DEFAULT_META_STATUS: &str = "ready";
const IMPORT_THUMB_MAX_SIZE: u32 = 480;
const THUMB_WEBP_QUALITY: f32 = 60.0;
const BOOKMARK_HTML_MAX_BYTES: usize = 1_500_000;
const BOOKMARK_FAVICON_MAX_BYTES: usize = 512 * 1024;
const BOOKMARK_FETCH_TIMEOUT_SECS: u64 = 7;
const BOOKMARK_FETCH_RETRIES: usize = 1;
const BOOKMARK_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Stumble/0.1 Safari/537.36";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbCollectionRow {
    id: String,
    parent_id: Option<String>,
    name: String,
    description: Option<String>,
    icon: String,
    color: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbItemRow {
    id: String,
    collection_id: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
    title: String,
    filename: String,
    vault_key: String,
    vault_path: String,
    preview_url: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    thumb_status: String,
    import_status: String,
    url: Option<String>,
    favicon_path: Option<String>,
    meta_status: String,
    description: Option<String>,
    rating: i64,
    is_favorite: bool,
    created_at: i64,
    updated_at: i64,
    tag_ids: Vec<String>,
    tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbTagRow {
    id: String,
    name: String,
    color: String,
    sort_index: i64,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbCollectionItemRow {
    id: String,
    collection_id: String,
    item_id: String,
    custom_title: Option<String>,
    custom_description: Option<String>,
    sort_index: i64,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbAppState {
    collections: Vec<DbCollectionRow>,
    collection_items: Vec<DbCollectionItemRow>,
    tags: Vec<DbTagRow>,
    items: Vec<DbItemRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InsertItemInput {
    id: String,
    collection_id: Option<String>,
    #[serde(rename = "type")]
    item_type: String,
    title: String,
    filename: String,
    vault_key: String,
    vault_path: String,
    preview_url: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    thumb_status: String,
    import_status: String,
    url: Option<String>,
    favicon_path: Option<String>,
    meta_status: Option<String>,
    description: Option<String>,
    #[serde(default)]
    rating: i64,
    #[serde(default)]
    is_favorite: bool,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemMediaStateInput {
    item_id: String,
    width: Option<i64>,
    height: Option<i64>,
    thumb_status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeItemImportInput {
    item_id: String,
    title: String,
    filename: String,
    vault_key: String,
    vault_path: String,
    width: Option<i64>,
    height: Option<i64>,
    thumb_status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkItemImportErrorInput {
    item_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemBookmarkMetadataInput {
    item_id: String,
    url: Option<String>,
    title: Option<String>,
    filename: Option<String>,
    favicon_path: Option<String>,
    meta_status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTagInput {
    name: String,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTagNameInput {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTagColorInput {
    id: String,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteTagInput {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemTagsInput {
    item_id: String,
    tag_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemPreferencesInput {
    item_id: String,
    rating: Option<i64>,
    is_favorite: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultCleanupEntry {
    vault_key: String,
    vault_path: String,
    sha256: String,
    ext: String,
    deleted_from_disk: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteItemsResult {
    deleted_rows: usize,
    cleanup: Vec<VaultCleanupEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemsCollectionResult {
    updated_rows: usize,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionMembershipsResult {
    created_rows: usize,
    updated_rows: usize,
    deleted_rows: usize,
    skipped_rows: usize,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionOrderResult {
    updated_rows: usize,
    skipped_rows: usize,
    updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportPipelineMetrics {
    hash_ms: u64,
    copy_ms: u64,
    metadata_ms: u64,
    thumb_ms: u64,
    total_ms: u64,
    deduped: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportPipelineResult {
    vault_path: String,
    sha256: String,
    ext: String,
    size: u64,
    created_at: String,
    original_filename: String,
    width: Option<u32>,
    height: Option<u32>,
    thumb_status: String,
    thumb_path: Option<String>,
    metrics: ImportPipelineMetrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchBookmarkMetadataResult {
    final_url: String,
    title: Option<String>,
    favicon_path: Option<String>,
    favicon_ext: Option<String>,
    favicon_url_candidate: Option<String>,
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.to_owned())
        .ok_or_else(|| format!("non-utf8 path: {}", path.display()))
}

fn app_root_path() -> Result<PathBuf, String> {
    let app_data = std::env::var_os("APPDATA")
        .ok_or_else(|| "APPDATA environment variable is not available".to_string())?;
    Ok(PathBuf::from(app_data).join("Stumble"))
}

fn db_path() -> Result<PathBuf, String> {
    Ok(app_root_path()?.join("stumble.db"))
}

fn open_db_connection() -> Result<Connection, String> {
    let app_root = app_root_path()?;
    fs::create_dir_all(&app_root).map_err(|err| {
        format!(
            "failed to create app root directory {}: {}",
            app_root.display(),
            err
        )
    })?;

    let database_path = db_path()?;
    let connection = Connection::open(&database_path).map_err(|err| {
        format!(
            "failed to open sqlite database {}: {}",
            database_path.display(),
            err
        )
    })?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| format!("failed to enable sqlite foreign keys: {}", err))?;
    Ok(connection)
}

fn run_db_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                parent_id TEXT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES collections(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                collection_id TEXT NULL,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                vault_key TEXT NOT NULL,
                vault_path TEXT NOT NULL,
                preview_url TEXT NULL,
                width INTEGER NULL,
                height INTEGER NULL,
                thumb_status TEXT NOT NULL DEFAULT 'pending',
                import_status TEXT NOT NULL DEFAULT 'ready',
                url TEXT NULL,
                favicon_path TEXT NULL,
                meta_status TEXT NOT NULL DEFAULT 'ready',
                description TEXT NULL,
                rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
                is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS collection_items (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                custom_title TEXT NULL,
                custom_description TEXT NULL,
                sort_index INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                color TEXT NOT NULL DEFAULT '#64748b',
                sort_index INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS item_tags (
                item_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (item_id, tag_id),
                FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS vault_files (
                vault_key TEXT PRIMARY KEY,
                vault_path TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                ext TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count >= 0),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS item_overlays (
                item_id TEXT PRIMARY KEY,
                strokes_json TEXT NOT NULL DEFAULT '[]',
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_vault_files_ref_count ON vault_files(ref_count);
            "#,
        )
        .map_err(|err| format!("failed to run sqlite migrations: {}", err))?;
    ensure_items_status_columns(connection)?;
    ensure_items_bookmark_columns(connection)?;
    ensure_items_rating_favorite_columns(connection)?;
    ensure_collections_columns(connection)?;
    ensure_collection_items_columns(connection)?;
    ensure_tags_columns(connection)?;
    ensure_collection_items_indexes(connection)?;
    backfill_collection_items_from_items(connection)?;
    sync_legacy_item_collection_ids(connection)?;
    Ok(())
}

fn normalize_thumb_status(value: &str) -> String {
    match value.trim() {
        "ready" => "ready".to_string(),
        "pending" => "pending".to_string(),
        "skipped" => "skipped".to_string(),
        "error" => "error".to_string(),
        _ => DEFAULT_THUMB_STATUS.to_string(),
    }
}

fn normalize_import_status(value: &str) -> String {
    match value.trim() {
        "ready" => "ready".to_string(),
        "processing" => "processing".to_string(),
        "error" => "error".to_string(),
        _ => DEFAULT_IMPORT_STATUS.to_string(),
    }
}

fn normalize_meta_status(value: &str) -> String {
    match value.trim() {
        "ready" => "ready".to_string(),
        "pending" => "pending".to_string(),
        "error" => "error".to_string(),
        _ => DEFAULT_META_STATUS.to_string(),
    }
}

fn normalize_item_rating(value: i64) -> i64 {
    value.clamp(0, 5)
}

fn normalize_is_favorite_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn ensure_items_status_columns(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(items)")
        .map_err(|err| format!("failed to inspect items table info: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to read items table info: {}", err))?;

    let mut has_thumb_status = false;
    let mut has_import_status = false;
    for row_result in rows {
        let column_name =
            row_result.map_err(|err| format!("failed to parse items table column: {}", err))?;
        if column_name == "thumb_status" {
            has_thumb_status = true;
        }
        if column_name == "import_status" {
            has_import_status = true;
        }
    }

    if !has_thumb_status {
        connection
            .execute(
                "ALTER TABLE items ADD COLUMN thumb_status TEXT NOT NULL DEFAULT 'pending'",
                [],
            )
            .map_err(|err| format!("failed to add items.thumb_status column: {}", err))?;
    }

    if !has_import_status {
        connection
            .execute(
                "ALTER TABLE items ADD COLUMN import_status TEXT NOT NULL DEFAULT 'ready'",
                [],
            )
            .map_err(|err| format!("failed to add items.import_status column: {}", err))?;
    }

    Ok(())
}

fn ensure_items_bookmark_columns(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(items)")
        .map_err(|err| format!("failed to inspect items table info for bookmark columns: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to read items table info for bookmark columns: {}", err))?;

    let mut has_url = false;
    let mut has_favicon_path = false;
    let mut has_meta_status = false;
    for row_result in rows {
        let column_name = row_result
            .map_err(|err| format!("failed to parse items table column for bookmarks: {}", err))?;
        if column_name == "url" {
            has_url = true;
        }
        if column_name == "favicon_path" {
            has_favicon_path = true;
        }
        if column_name == "meta_status" {
            has_meta_status = true;
        }
    }

    if !has_url {
        connection
            .execute("ALTER TABLE items ADD COLUMN url TEXT NULL", [])
            .map_err(|err| format!("failed to add items.url column: {}", err))?;
    }

    if !has_favicon_path {
        connection
            .execute("ALTER TABLE items ADD COLUMN favicon_path TEXT NULL", [])
            .map_err(|err| format!("failed to add items.favicon_path column: {}", err))?;
    }

    if !has_meta_status {
        connection
            .execute(
                "ALTER TABLE items ADD COLUMN meta_status TEXT NOT NULL DEFAULT 'ready'",
                [],
            )
            .map_err(|err| format!("failed to add items.meta_status column: {}", err))?;
    }

    connection
        .execute(
            "UPDATE items
             SET meta_status = CASE
                 WHEN type = 'bookmark'
                      AND (url IS NULL OR TRIM(url) = '')
                 THEN 'error'
                 ELSE 'ready'
             END
             WHERE meta_status IS NULL OR TRIM(meta_status) = ''",
            [],
        )
        .map_err(|err| format!("failed to backfill items.meta_status values: {}", err))?;

    Ok(())
}

fn ensure_items_rating_favorite_columns(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(items)")
        .map_err(|err| {
            format!(
                "failed to inspect items table info for rating/favorite columns: {}",
                err
            )
        })?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| {
            format!(
                "failed to read items table info for rating/favorite columns: {}",
                err
            )
        })?;

    let mut has_rating = false;
    let mut has_is_favorite = false;
    for row_result in rows {
        let column_name = row_result.map_err(|err| {
            format!(
                "failed to parse items table column for rating/favorite columns: {}",
                err
            )
        })?;
        if column_name == "rating" {
            has_rating = true;
        }
        if column_name == "is_favorite" {
            has_is_favorite = true;
        }
    }

    if !has_rating {
        connection
            .execute(
                "ALTER TABLE items ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add items.rating column: {}", err))?;
    }

    if !has_is_favorite {
        connection
            .execute(
                "ALTER TABLE items ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add items.is_favorite column: {}", err))?;
    }

    connection
        .execute(
            "UPDATE items
             SET rating = CASE
                 WHEN rating IS NULL THEN 0
                 WHEN CAST(rating AS INTEGER) < 0 THEN 0
                 WHEN CAST(rating AS INTEGER) > 5 THEN 5
                 ELSE CAST(rating AS INTEGER)
             END",
            [],
        )
        .map_err(|err| format!("failed to backfill items.rating values: {}", err))?;

    connection
        .execute(
            "UPDATE items
             SET is_favorite = CASE
                 WHEN is_favorite IS NULL THEN 0
                 WHEN CAST(is_favorite AS INTEGER) <> 0 THEN 1
                 ELSE 0
             END",
            [],
        )
        .map_err(|err| format!("failed to backfill items.is_favorite values: {}", err))?;

    Ok(())
}

fn ensure_collections_columns(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(collections)")
        .map_err(|err| format!("failed to inspect collections table info: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to read collections table info: {}", err))?;

    let mut has_description = false;
    let mut has_icon = false;
    let mut has_updated_at = false;

    for row_result in rows {
        let column_name =
            row_result.map_err(|err| format!("failed to parse collections table column: {}", err))?;
        if column_name == "description" {
            has_description = true;
        }
        if column_name == "icon" {
            has_icon = true;
        }
        if column_name == "updated_at" {
            has_updated_at = true;
        }
    }

    if !has_description {
        connection
            .execute("ALTER TABLE collections ADD COLUMN description TEXT NULL", [])
            .map_err(|err| format!("failed to add collections.description column: {}", err))?;
    }

    if !has_icon {
        connection
            .execute(
                "ALTER TABLE collections ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'",
                [],
            )
            .map_err(|err| format!("failed to add collections.icon column: {}", err))?;
    }

    if !has_updated_at {
        connection
            .execute(
                "ALTER TABLE collections ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add collections.updated_at column: {}", err))?;
    }

    connection
        .execute(
            "UPDATE collections
             SET updated_at = created_at
             WHERE updated_at = 0",
            [],
        )
        .map_err(|err| format!("failed to backfill collections.updated_at values: {}", err))?;

    Ok(())
}

fn ensure_collection_items_columns(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(collection_items)")
        .map_err(|err| format!("failed to inspect collection_items table info: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to read collection_items table info: {}", err))?;

    let mut has_sort_index = false;
    for row_result in rows {
        let column_name = row_result
            .map_err(|err| format!("failed to parse collection_items table column: {}", err))?;
        if column_name == "sort_index" {
            has_sort_index = true;
        }
    }

    if !has_sort_index {
        connection
            .execute(
                "ALTER TABLE collection_items ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add collection_items.sort_index column: {}", err))?;
    }

    if !has_sort_index {
        connection
            .execute(
                "UPDATE collection_items
                 SET sort_index = CASE
                    WHEN created_at IS NULL THEN 0
                    ELSE created_at
                 END",
                [],
            )
            .map_err(|err| {
                format!("failed to backfill collection_items.sort_index values: {}", err)
            })?;
    }

    Ok(())
}

fn ensure_tags_columns(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(tags)")
        .map_err(|err| format!("failed to inspect tags table info: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to read tags table info: {}", err))?;

    let mut has_color = false;
    let mut has_sort_index = false;
    let mut has_created_at = false;
    let mut has_updated_at = false;
    for row_result in rows {
        let column_name =
            row_result.map_err(|err| format!("failed to parse tags table column: {}", err))?;
        if column_name == "color" {
            has_color = true;
        }
        if column_name == "sort_index" {
            has_sort_index = true;
        }
        if column_name == "created_at" {
            has_created_at = true;
        }
        if column_name == "updated_at" {
            has_updated_at = true;
        }
    }

    if !has_color {
        connection
            .execute(
                "ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT '#64748b'",
                [],
            )
            .map_err(|err| format!("failed to add tags.color column: {}", err))?;
    }

    if !has_created_at {
        connection
            .execute(
                "ALTER TABLE tags ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add tags.created_at column: {}", err))?;
    }

    if !has_updated_at {
        connection
            .execute(
                "ALTER TABLE tags ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add tags.updated_at column: {}", err))?;
    }

    if !has_sort_index {
        connection
            .execute(
                "ALTER TABLE tags ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|err| format!("failed to add tags.sort_index column: {}", err))?;
    }

    let now = Utc::now().timestamp_millis();
    connection
        .execute(
            "UPDATE tags
             SET color = COALESCE(NULLIF(TRIM(color), ''), ?1)
             WHERE color IS NULL OR TRIM(color) = ''",
            params![DEFAULT_TAG_COLOR],
        )
        .map_err(|err| format!("failed to backfill tags.color values: {}", err))?;
    connection
        .execute(
            "UPDATE tags
             SET created_at = ?1
             WHERE created_at = 0",
            params![now],
        )
        .map_err(|err| format!("failed to backfill tags.created_at values: {}", err))?;
    connection
        .execute(
            "UPDATE tags
             SET updated_at = created_at
             WHERE updated_at = 0",
            [],
        )
        .map_err(|err| format!("failed to backfill tags.updated_at values: {}", err))?;
    if !has_sort_index {
        connection
            .execute(
                "UPDATE tags
                 SET sort_index = created_at
                 WHERE sort_index = 0",
                [],
            )
            .map_err(|err| format!("failed to backfill tags.sort_index values: {}", err))?;
    }
    Ok(())
}

fn ensure_collection_items_indexes(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_items_collection_item_unique
            ON collection_items(collection_id, item_id);
            CREATE INDEX IF NOT EXISTS idx_collection_items_item_id
            ON collection_items(item_id);
            CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id
            ON collection_items(collection_id);
            CREATE INDEX IF NOT EXISTS idx_collection_items_collection_sort
            ON collection_items(collection_id, sort_index);
            "#,
        )
        .map_err(|err| format!("failed to ensure collection_items indexes: {}", err))?;
    Ok(())
}

fn backfill_collection_items_from_items(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare(
            "SELECT id, collection_id, created_at
             FROM items
             WHERE collection_id IS NOT NULL AND TRIM(collection_id) <> ''",
        )
        .map_err(|err| format!("failed to prepare collection_items backfill query: {}", err))?;

    let row_iter = stmt
        .query_map([], |row| {
            let item_id: String = row.get(0)?;
            let collection_id: String = row.get(1)?;
            let created_at: i64 = row.get(2)?;
            Ok((item_id, collection_id, created_at))
        })
        .map_err(|err| format!("failed to query items for collection_items backfill: {}", err))?;

    let mut rows = Vec::new();
    for row_result in row_iter {
        rows.push(
            row_result
                .map_err(|err| format!("failed to read collection_items backfill row: {}", err))?,
        );
    }

    for (item_id, collection_id, created_at) in rows {
        connection
            .execute(
                "INSERT OR IGNORE INTO collection_items (
                    id,
                    collection_id,
                    item_id,
                    custom_title,
                    custom_description,
                    sort_index,
                    created_at
                ) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    collection_id,
                    item_id,
                    created_at.max(0),
                    created_at.max(0)
                ],
            )
            .map_err(|err| format!("failed to backfill collection_items row: {}", err))?;
    }

    Ok(())
}

fn sync_legacy_item_collection_ids(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE items
             SET collection_id = NULL
             WHERE collection_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM collection_items AS ci
                 WHERE ci.item_id = items.id
                   AND ci.collection_id = items.collection_id
               )",
            [],
        )
        .map_err(|err| format!("failed to clear stale legacy item.collection_id values: {}", err))?;

    connection
        .execute(
            "UPDATE items
             SET collection_id = (
               SELECT ci.collection_id
               FROM collection_items AS ci
               WHERE ci.item_id = items.id
               ORDER BY ci.created_at ASC, ci.id ASC
               LIMIT 1
             )
             WHERE collection_id IS NULL
               AND EXISTS (
                 SELECT 1
                 FROM collection_items AS ci
                 WHERE ci.item_id = items.id
               )",
            [],
        )
        .map_err(|err| format!("failed to backfill legacy item.collection_id values: {}", err))?;

    Ok(())
}

fn ensure_default_root_collection(connection: &Connection) -> Result<(), String> {
    let collection_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))
        .map_err(|err| format!("failed to count collections: {}", err))?;

    if collection_count == 0 {
        let now = Utc::now().timestamp_millis();
        connection
            .execute(
                "INSERT INTO collections (
                    id,
                    name,
                    description,
                    icon,
                    color,
                    parent_id,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5, ?5)",
                params![
                    DEFAULT_ROOT_COLLECTION_ID,
                    DEFAULT_ROOT_COLLECTION_NAME,
                    DEFAULT_ROOT_COLLECTION_ICON,
                    DEFAULT_ROOT_COLLECTION_COLOR,
                    now
                ],
            )
            .map_err(|err| format!("failed to create default root collection: {}", err))?;
    }

    Ok(())
}

fn initialize_db() -> Result<(), String> {
    let connection = open_db_connection()?;
    run_db_migrations(&connection)?;
    ensure_default_root_collection(&connection)?;
    backfill_vault_refs_if_needed(&connection)?;
    cleanup_zero_ref_vault_files(&connection)?;
    Ok(())
}

fn normalize_ext(ext: &str) -> String {
    let cleaned = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if cleaned.is_empty() {
        return "bin".to_string();
    }

    let sanitized: String = cleaned
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    if sanitized.is_empty() {
        "bin".to_string()
    } else {
        sanitized
    }
}

fn extension_from_filename(filename: &str) -> Option<String> {
    Path::new(filename)
        .extension()
        .and_then(OsStr::to_str)
        .map(normalize_ext)
}

fn extension_from_path(path: &Path) -> String {
    path.extension()
        .and_then(OsStr::to_str)
        .map(normalize_ext)
        .unwrap_or_else(|| "bin".to_string())
}

fn storage_root_path() -> Result<PathBuf, String> {
    Ok(app_root_path()?.join("storage"))
}

fn thumbs_root_path() -> Result<PathBuf, String> {
    Ok(app_root_path()?.join("thumbs"))
}

fn favicons_root_path() -> Result<PathBuf, String> {
    Ok(app_root_path()?.join("favicons"))
}

fn ensure_storage_root_internal() -> Result<PathBuf, String> {
    let root = storage_root_path()?;
    fs::create_dir_all(&root)
        .map_err(|err| format!("failed to create storage root {}: {}", root.display(), err))?;
    Ok(root)
}

fn ensure_thumbs_root_internal() -> Result<PathBuf, String> {
    let root = thumbs_root_path()?;
    fs::create_dir_all(&root)
        .map_err(|err| format!("failed to create thumbs root {}: {}", root.display(), err))?;
    Ok(root)
}

fn ensure_favicons_root_internal() -> Result<PathBuf, String> {
    let root = favicons_root_path()?;
    fs::create_dir_all(&root)
        .map_err(|err| format!("failed to create favicons root {}: {}", root.display(), err))?;
    Ok(root)
}

fn thumb_filename_for_vault_key(vault_key: &str) -> Result<String, String> {
    let trimmed = vault_key.trim();
    if trimmed.is_empty() {
        return Err("cannot build thumb filename from empty vault key".to_string());
    }

    let sanitized: String = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '.' || *ch == '-' || *ch == '_')
        .collect();
    if sanitized.is_empty() {
        return Err(format!(
            "invalid vault key for thumb filename: {}",
            vault_key
        ));
    }

    Ok(format!("{sanitized}.webp"))
}

fn thumb_output_path_for_vault_key(vault_key: &str) -> Result<PathBuf, String> {
    let root = ensure_thumbs_root_internal()?;
    let filename = thumb_filename_for_vault_key(vault_key)?;
    Ok(root.join(filename))
}

fn remove_thumbnail_for_vault_key(vault_key: &str) -> Result<bool, String> {
    let thumb_path = thumb_output_path_for_vault_key(vault_key)?;
    if !thumb_path.exists() {
        return Ok(false);
    }

    fs::remove_file(&thumb_path).map_err(|err| {
        format!(
            "failed to remove thumbnail {}: {}",
            thumb_path.display(),
            err
        )
    })?;
    Ok(true)
}

fn remove_favicon_file(favicon_path: &str) -> Result<bool, String> {
    let trimmed = favicon_path.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let path = PathBuf::from(trimmed);
    if !path.exists() || !path.is_file() {
        return Ok(false);
    }

    fs::remove_file(&path)
        .map_err(|err| format!("failed to remove favicon {}: {}", path.display(), err))?;
    Ok(true)
}

fn ensure_current_month_directory(root: &Path) -> Result<PathBuf, String> {
    let now = Utc::now();
    let year_dir = root.join(format!("{:04}", now.year()));
    let month_dir = year_dir.join(format!("{:02}", now.month()));
    fs::create_dir_all(&month_dir).map_err(|err| {
        format!(
            "failed to create month directory {}: {}",
            month_dir.display(),
            err
        )
    })?;
    Ok(month_dir)
}

fn build_vault_filename(sha256: &str, ext: &str) -> String {
    format!("{sha256}.{}", normalize_ext(ext))
}

fn parse_vault_key(vault_key: &str) -> Option<(String, String)> {
    let trimmed = vault_key.trim();
    let separator_index = trimmed.rfind('.')?;
    if separator_index == 0 || separator_index >= trimmed.len() - 1 {
        return None;
    }
    let sha256 = trimmed[..separator_index].to_string();
    let ext = normalize_ext(&trimmed[separator_index + 1..]);
    Some((sha256, ext))
}

fn increment_vault_ref_in_tx(
    transaction: &Transaction<'_>,
    vault_key: &str,
    vault_path: &str,
) -> Result<(), String> {
    if vault_key.trim().is_empty() {
        return Ok(());
    }

    let (sha256, ext) =
        parse_vault_key(vault_key).ok_or_else(|| format!("invalid vault key: {}", vault_key))?;
    let now = Utc::now().timestamp_millis();
    transaction
        .execute(
            "INSERT INTO vault_files (
                vault_key,
                vault_path,
                sha256,
                ext,
                size_bytes,
                ref_count,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, 0, 1, ?5, ?5)
            ON CONFLICT(vault_key) DO UPDATE SET
                ref_count = vault_files.ref_count + 1,
                vault_path = excluded.vault_path,
                sha256 = excluded.sha256,
                ext = excluded.ext,
                updated_at = excluded.updated_at",
            params![vault_key, vault_path, sha256, ext, now],
        )
        .map_err(|err| format!("failed to increment vault ref count: {}", err))?;
    Ok(())
}

fn decrement_vault_ref_in_tx(
    transaction: &Transaction<'_>,
    vault_key: &str,
    decrement_by: i64,
) -> Result<i64, String> {
    if vault_key.trim().is_empty() {
        return Ok(0);
    }

    let bounded_decrement = decrement_by.max(0);
    let now = Utc::now().timestamp_millis();
    transaction
        .execute(
            "UPDATE vault_files
             SET ref_count = CASE
                                WHEN ref_count > ?2 THEN ref_count - ?2
                                ELSE 0
                             END,
                 updated_at = ?3
             WHERE vault_key = ?1",
            params![vault_key, bounded_decrement, now],
        )
        .map_err(|err| format!("failed to decrement vault ref count: {}", err))?;

    let refs = transaction
        .query_row(
            "SELECT ref_count FROM vault_files WHERE vault_key = ?1",
            params![vault_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("failed to read vault ref count after decrement: {}", err))?
        .unwrap_or(0);

    Ok(refs)
}

fn backfill_vault_refs_if_needed(connection: &Connection) -> Result<(), String> {
    let vault_file_rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM vault_files", [], |row| row.get(0))
        .map_err(|err| format!("failed to count vault rows: {}", err))?;
    if vault_file_rows > 0 {
        return Ok(());
    }

    let mut counts_by_key: HashMap<String, (String, i64)> = HashMap::new();
    let mut items_stmt = connection
        .prepare("SELECT vault_key, vault_path FROM items WHERE vault_key <> ''")
        .map_err(|err| format!("failed to prepare vault backfill query: {}", err))?;
    let items_iter = items_stmt
        .query_map([], |row| {
            let vault_key: String = row.get(0)?;
            let vault_path: String = row.get(1)?;
            Ok((vault_key, vault_path))
        })
        .map_err(|err| format!("failed to query item vault keys for backfill: {}", err))?;

    for row_result in items_iter {
        let (vault_key, vault_path) =
            row_result.map_err(|err| format!("failed to read backfill row: {}", err))?;
        let entry = counts_by_key.entry(vault_key).or_insert((vault_path, 0));
        entry.1 += 1;
    }

    if counts_by_key.is_empty() {
        return Ok(());
    }

    let now = Utc::now().timestamp_millis();
    for (vault_key, (vault_path, ref_count)) in counts_by_key {
        let Some((sha256, ext)) = parse_vault_key(&vault_key) else {
            eprintln!("skipping invalid vault key during backfill: {}", vault_key);
            continue;
        };

        connection
            .execute(
                "INSERT OR REPLACE INTO vault_files (
                    vault_key,
                    vault_path,
                    sha256,
                    ext,
                    size_bytes,
                    ref_count,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)",
                params![vault_key, vault_path, sha256, ext, ref_count, now],
            )
            .map_err(|err| format!("failed to insert vault backfill row: {}", err))?;
    }

    Ok(())
}

fn cleanup_zero_ref_vault_files(connection: &Connection) -> Result<(), String> {
    let mut stmt = connection
        .prepare(
            "SELECT vault_key, vault_path, sha256, ext
             FROM vault_files
             WHERE ref_count <= 0",
        )
        .map_err(|err| format!("failed to prepare zero-ref vault query: {}", err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|err| format!("failed to query zero-ref vault rows: {}", err))?;

    let mut pending_rows = Vec::new();
    for row_result in rows {
        pending_rows
            .push(row_result.map_err(|err| format!("failed to read zero-ref vault row: {}", err))?);
    }
    if pending_rows.is_empty() {
        return Ok(());
    }

    let storage_root = ensure_storage_root_internal()?;
    let mut prune_keys = Vec::new();
    for (vault_key, _vault_path, sha256, ext) in pending_rows {
        let vault_filename = build_vault_filename(&sha256, &ext);
        let existing_paths = find_vault_files(&storage_root, &vault_filename)
            .map_err(|err| format!("failed to find zero-ref vault files: {}", err))?;

        let mut cleanup_ok = true;
        for path in existing_paths {
            if let Err(err) = fs::remove_file(&path) {
                cleanup_ok = false;
                eprintln!(
                    "failed to cleanup zero-ref vault file {}: {}",
                    path.display(),
                    err
                );
            }
        }

        if let Err(err) = remove_thumbnail_for_vault_key(&vault_key) {
            cleanup_ok = false;
            eprintln!(
                "failed to cleanup zero-ref thumbnail for vault key {}: {}",
                vault_key, err
            );
        }

        if cleanup_ok {
            prune_keys.push(vault_key);
        }
    }

    for vault_key in prune_keys {
        connection
            .execute(
                "DELETE FROM vault_files WHERE vault_key = ?1",
                params![vault_key],
            )
            .map_err(|err| format!("failed to prune zero-ref vault row: {}", err))?;
    }

    Ok(())
}

fn find_vault_files(root: &Path, vault_filename: &str) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    let years = fs::read_dir(root)
        .map_err(|err| format!("failed to read storage root {}: {}", root.display(), err))?;
    for year_entry_result in years {
        let year_entry = year_entry_result
            .map_err(|err| format!("failed to read year folder in storage root: {}", err))?;
        let year_path = year_entry.path();
        if !year_path.is_dir() {
            continue;
        }

        let months = fs::read_dir(&year_path).map_err(|err| {
            format!(
                "failed to read year directory {}: {}",
                year_path.display(),
                err
            )
        })?;

        for month_entry_result in months {
            let month_entry = month_entry_result
                .map_err(|err| format!("failed to read month folder in storage root: {}", err))?;
            let month_path = month_entry.path();
            if !month_path.is_dir() {
                continue;
            }

            let candidate = month_path.join(vault_filename);
            if candidate.exists() {
                matches.push(candidate);
            }
        }
    }

    Ok(matches)
}

fn find_existing_vault_file(root: &Path, vault_filename: &str) -> Result<Option<PathBuf>, String> {
    let mut matches = find_vault_files(root, vault_filename)?;
    Ok(matches.pop())
}

fn sha256_for_file(file_path: &Path) -> Result<String, String> {
    let file = File::open(file_path)
        .map_err(|err| format!("failed to open file {}: {}", file_path.display(), err))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];

    loop {
        let bytes_read = reader
            .read(&mut chunk)
            .map_err(|err| format!("failed to read file {}: {}", file_path.display(), err))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&chunk[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_for_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_http_or_https_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn normalize_bookmark_url_input(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("bookmark url cannot be empty".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|err| format!("invalid bookmark url: {}", err))?;
    if !is_http_or_https_url(&parsed) {
        return Err("only http:// and https:// URLs are supported".to_string());
    }
    Ok(parsed)
}

fn normalize_optional_trimmed_string(value: Option<String>) -> Option<String> {
    value
        .map(|candidate| candidate.trim().to_string())
        .filter(|candidate| !candidate.is_empty())
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_tag_name(raw: &str) -> Result<String, String> {
    let normalized = collapse_whitespace(raw.trim());
    if normalized.is_empty() {
        return Err("tag name cannot be empty".to_string());
    }
    Ok(normalized)
}

fn normalize_tag_color(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_string();
    if normalized.is_empty() {
        return Err("tag color cannot be empty".to_string());
    }
    Ok(normalized)
}

fn db_tag_row_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DbTagRow> {
    Ok(DbTagRow {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        sort_index: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn find_tag_row_by_name_in_tx(
    transaction: &Transaction<'_>,
    tag_name: &str,
) -> Result<Option<DbTagRow>, String> {
    transaction
        .query_row(
            "SELECT id, name, color, sort_index, created_at, updated_at
             FROM tags
             WHERE name = ?1
             LIMIT 1",
            params![tag_name],
            db_tag_row_from_row,
        )
        .optional()
        .map_err(|err| format!("failed to query tag by name: {}", err))
}

fn next_tag_sort_index_in_tx(transaction: &Transaction<'_>) -> Result<i64, String> {
    transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM tags",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("failed to resolve next tag sort index: {}", err))
}

fn insert_tag_row_in_tx(
    transaction: &Transaction<'_>,
    name: &str,
    color: &str,
    now: i64,
) -> Result<DbTagRow, String> {
    let tag_id = Uuid::new_v4().to_string();
    let sort_index = next_tag_sort_index_in_tx(transaction)?;
    transaction
        .execute(
            "INSERT INTO tags (id, name, color, sort_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![&tag_id, name, color, sort_index, now],
        )
        .map_err(|err| format!("failed to insert tag row: {}", err))?;
    Ok(DbTagRow {
        id: tag_id,
        name: name.to_string(),
        color: color.to_string(),
        sort_index,
        created_at: now,
        updated_at: now,
    })
}

fn ensure_tag_exists_by_name_in_tx(
    transaction: &Transaction<'_>,
    tag_name: &str,
    now: i64,
) -> Result<String, String> {
    if let Some(existing) = find_tag_row_by_name_in_tx(transaction, tag_name)? {
        return Ok(existing.id);
    }
    let created = insert_tag_row_in_tx(transaction, tag_name, DEFAULT_TAG_COLOR, now)?;
    Ok(created.id)
}

fn next_duplicate_tag_name(connection: &Connection, source_name: &str) -> Result<String, String> {
    let base = format!("{} copy", source_name.trim());
    let base = collapse_whitespace(&base);
    if base.is_empty() {
        return Err("tag name cannot be empty".to_string());
    }

    let mut candidate = base.clone();
    let mut suffix = 2usize;
    loop {
        let exists = connection
            .query_row(
                "SELECT 1 FROM tags WHERE name = ?1 LIMIT 1",
                params![&candidate],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| format!("failed to check duplicate tag name: {}", err))?;
        if exists.is_none() {
            return Ok(candidate);
        }
        candidate = format!("{} {}", base, suffix);
        suffix += 1;
    }
}

fn build_bookmark_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(BOOKMARK_FETCH_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(4))
        .user_agent(BOOKMARK_USER_AGENT)
        .build()
        .map_err(|err| format!("failed to build bookmark http client: {}", err))
}

async fn fetch_bookmark_page_html(
    client: &reqwest::Client,
    url: &Url,
) -> Result<(Url, Option<String>), String> {
    let mut last_error: Option<String> = None;

    for attempt in 1..=(BOOKMARK_FETCH_RETRIES + 1) {
        let response_result = client
            .get(url.clone())
            .header(ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
            .send()
            .await;

        let response = match response_result {
            Ok(response) => response,
            Err(err) => {
                let message = format!("bookmark html request failed (attempt {}): {}", attempt, err);
                eprintln!("{}", message);
                last_error = Some(message);
                continue;
            }
        };

        let final_url = response.url().clone();
        if !is_http_or_https_url(&final_url) {
            return Err(format!(
                "redirected to unsupported url scheme: {}",
                final_url.as_str()
            ));
        }

        if !response.status().is_success() {
            eprintln!(
                "bookmark html request returned status {} for {}",
                response.status(),
                final_url
            );
            return Ok((final_url, None));
        }

        if let Some(content_length) = response.content_length() {
            if content_length as usize > BOOKMARK_HTML_MAX_BYTES {
                eprintln!(
                    "bookmark html skipped due to content-length {} > {} for {}",
                    content_length, BOOKMARK_HTML_MAX_BYTES, final_url
                );
                return Ok((final_url, None));
            }
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_ascii_lowercase());
        let is_html = content_type
            .as_deref()
            .map(|value| value.contains("text/html") || value.contains("application/xhtml"))
            .unwrap_or(true);
        if !is_html {
            return Ok((final_url, None));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|err| format!("failed to read bookmark html response: {}", err))?;
        if bytes.len() > BOOKMARK_HTML_MAX_BYTES {
            eprintln!(
                "bookmark html exceeded max size after download {} > {} for {}",
                bytes.len(),
                BOOKMARK_HTML_MAX_BYTES,
                final_url
            );
            return Ok((final_url, None));
        }

        let html = String::from_utf8_lossy(&bytes).into_owned();
        return Ok((final_url, Some(html)));
    }

    Err(last_error.unwrap_or_else(|| "bookmark html request failed".to_string()))
}

fn html_title_and_favicon_candidates(
    html: &str,
    final_url: &Url,
) -> (Option<String>, Vec<Url>) {
    let document = Html::parse_document(html);
    let mut title: Option<String> = None;
    let mut og_title: Option<String> = None;
    let mut weighted_candidates: Vec<(u8, Url)> = Vec::new();

    if let Ok(title_selector) = Selector::parse("title") {
        if let Some(node) = document.select(&title_selector).next() {
            let text = collapse_whitespace(&node.text().collect::<Vec<_>>().join(" "));
            if !text.is_empty() {
                title = Some(text);
            }
        }
    }

    if let Ok(meta_selector) = Selector::parse("meta") {
        for node in document.select(&meta_selector) {
            let property = node
                .value()
                .attr("property")
                .or_else(|| node.value().attr("name"))
                .map(|value| value.trim().to_ascii_lowercase());
            if property.as_deref() != Some("og:title") {
                continue;
            }
            let content = node
                .value()
                .attr("content")
                .map(collapse_whitespace)
                .filter(|value| !value.is_empty());
            if content.is_some() {
                og_title = content;
                break;
            }
        }
    }

    if let Ok(link_selector) = Selector::parse("link[href]") {
        for node in document.select(&link_selector) {
            let rel = node
                .value()
                .attr("rel")
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if rel.is_empty() {
                continue;
            }

            let priority = if rel.contains("shortcut icon") {
                Some(0)
            } else if rel
                .split_whitespace()
                .any(|token| token == "icon" || token == "shortcut")
            {
                Some(1)
            } else if rel.contains("apple-touch-icon") {
                Some(2)
            } else {
                None
            };
            let Some(priority) = priority else {
                continue;
            };

            let href = match node.value().attr("href") {
                Some(href) if !href.trim().is_empty() => href.trim(),
                _ => continue,
            };

            let resolved = match final_url.join(href) {
                Ok(url) => url,
                Err(_) => continue,
            };
            if !is_http_or_https_url(&resolved) {
                continue;
            }

            weighted_candidates.push((priority, resolved));
        }
    }

    weighted_candidates.sort_by_key(|(priority, _)| *priority);
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    for (_, candidate) in weighted_candidates {
        if seen.insert(candidate.as_str().to_string()) {
            candidates.push(candidate);
        }
    }

    if let Ok(fallback) = final_url.join("/favicon.ico") {
        if is_http_or_https_url(&fallback) && seen.insert(fallback.as_str().to_string()) {
            candidates.push(fallback);
        }
    }

    (title.or(og_title), candidates)
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_ascii_lowercase();
    head.contains("<svg")
}

fn infer_favicon_extension(
    content_type_header: Option<&str>,
    source_url: &Url,
    bytes: &[u8],
) -> String {
    let content_type = content_type_header
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) || content_type.contains("image/png") {
        return "png".to_string();
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || content_type.contains("image/jpeg") {
        return "jpg".to_string();
    }
    if bytes.starts_with(b"GIF8") || content_type.contains("image/gif") {
        return "gif".to_string();
    }
    if bytes.len() >= 12
        && &bytes[0..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        || content_type.contains("image/webp")
    {
        return "webp".to_string();
    }
    if bytes.len() >= 4
        && bytes[0] == 0x00
        && bytes[1] == 0x00
        && (bytes[2] == 0x01 || bytes[2] == 0x02)
        && bytes[3] == 0x00
        || content_type.contains("image/x-icon")
        || content_type.contains("vnd.microsoft.icon")
        || content_type.contains("image/ico")
    {
        return "ico".to_string();
    }
    if looks_like_svg(bytes) || content_type.contains("image/svg") {
        return "svg".to_string();
    }

    if let Some(ext) = source_url
        .path_segments()
        .and_then(|segments| segments.last())
        .and_then(|segment| Path::new(segment).extension())
        .and_then(OsStr::to_str)
    {
        let normalized = normalize_ext(ext);
        if matches!(
            normalized.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "svg"
        ) {
            return if normalized == "jpeg" {
                "jpg".to_string()
            } else {
                normalized
            };
        }
    }

    "ico".to_string()
}

async fn download_favicon_candidate(
    client: &reqwest::Client,
    favicon_url: &Url,
) -> Result<(Vec<u8>, String), String> {
    let mut last_error: Option<String> = None;

    for attempt in 1..=(BOOKMARK_FETCH_RETRIES + 1) {
        let response_result = client
            .get(favicon_url.clone())
            .header(ACCEPT, "image/*,*/*;q=0.8")
            .send()
            .await;

        let response = match response_result {
            Ok(response) => response,
            Err(err) => {
                let message = format!(
                    "favicon request failed for {} (attempt {}): {}",
                    favicon_url, attempt, err
                );
                last_error = Some(message.clone());
                eprintln!("{}", message);
                continue;
            }
        };

        if !response.status().is_success() {
            let message = format!(
                "favicon request returned status {} for {}",
                response.status(),
                favicon_url
            );
            last_error = Some(message.clone());
            eprintln!("{}", message);
            continue;
        }

        if let Some(content_length) = response.content_length() {
            if content_length as usize > BOOKMARK_FAVICON_MAX_BYTES {
                let message = format!(
                    "favicon too large for {} ({} bytes > {} bytes)",
                    favicon_url, content_length, BOOKMARK_FAVICON_MAX_BYTES
                );
                last_error = Some(message.clone());
                eprintln!("{}", message);
                continue;
            }
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let bytes = response
            .bytes()
            .await
            .map_err(|err| format!("failed to read favicon response {}: {}", favicon_url, err))?;
        if bytes.is_empty() {
            last_error = Some(format!("favicon response empty: {}", favicon_url));
            continue;
        }
        if bytes.len() > BOOKMARK_FAVICON_MAX_BYTES {
            let message = format!(
                "favicon exceeded max size after download for {} ({} bytes > {} bytes)",
                favicon_url,
                bytes.len(),
                BOOKMARK_FAVICON_MAX_BYTES
            );
            last_error = Some(message.clone());
            eprintln!("{}", message);
            continue;
        }

        let ext = infer_favicon_extension(content_type.as_deref(), favicon_url, &bytes);
        return Ok((bytes.to_vec(), ext));
    }

    Err(last_error.unwrap_or_else(|| format!("failed to download favicon: {}", favicon_url)))
}

fn store_favicon_bytes(bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    let root = ensure_favicons_root_internal()?;
    let filename = format!("{}.{}", sha256_for_bytes(bytes), normalize_ext(ext));
    let path = root.join(filename);
    if !path.exists() {
        fs::write(&path, bytes)
            .map_err(|err| format!("failed to write favicon {}: {}", path.display(), err))?;
    }
    Ok(path)
}

struct VaultImportComputation {
    result: VaultImportResult,
    hash_ms: u64,
    copy_ms: u64,
    deduped: bool,
}

fn import_with_metadata_detailed(
    source_path: Option<&Path>,
    source_bytes: Option<&[u8]>,
    requested_ext: Option<&str>,
    original_filename: Option<&str>,
) -> Result<VaultImportComputation, String> {
    let root = ensure_storage_root_internal()?;
    let month_dir = ensure_current_month_directory(&root)?;

    let hash_started_at = Instant::now();
    let (sha256, ext, fallback_filename) = match (source_path, source_bytes) {
        (Some(path), None) => {
            let sha = sha256_for_file(path)?;
            let path_ext = extension_from_path(path);
            let filename = path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("imported.bin")
                .to_string();
            (sha, path_ext, filename)
        }
        (None, Some(bytes)) => {
            let sha = sha256_for_bytes(bytes);
            let ext = requested_ext
                .map(normalize_ext)
                .or_else(|| original_filename.and_then(extension_from_filename))
                .unwrap_or_else(|| "bin".to_string());
            let filename = original_filename.unwrap_or("clipboard-image").to_string();
            (sha, ext, filename)
        }
        _ => {
            return Err(
                "invalid import request: provide either source_path or source_bytes".to_string(),
            )
        }
    };
    let hash_ms = hash_started_at.elapsed().as_millis() as u64;

    let copy_started_at = Instant::now();
    let vault_filename = build_vault_filename(&sha256, &ext);
    let existing_path = find_existing_vault_file(&root, &vault_filename)?;

    let (final_path, deduped) = if let Some(path) = existing_path {
        (path, true)
    } else {
        let destination = month_dir.join(&vault_filename);
        match (source_path, source_bytes) {
            (Some(path), None) => {
                fs::copy(path, &destination).map_err(|err| {
                    format!(
                        "failed to copy {} to {}: {}",
                        path.display(),
                        destination.display(),
                        err
                    )
                })?;
            }
            (None, Some(bytes)) => {
                let mut output = File::create(&destination).map_err(|err| {
                    format!(
                        "failed to create destination {}: {}",
                        destination.display(),
                        err
                    )
                })?;
                output.write_all(bytes).map_err(|err| {
                    format!(
                        "failed to write destination {}: {}",
                        destination.display(),
                        err
                    )
                })?;
                output.flush().map_err(|err| {
                    format!(
                        "failed to flush destination {}: {}",
                        destination.display(),
                        err
                    )
                })?;
            }
            _ => return Err("invalid import request while writing destination".to_string()),
        };
        (destination, false)
    };
    let copy_ms = copy_started_at.elapsed().as_millis() as u64;

    let size = fs::metadata(&final_path)
        .map_err(|err| format!("failed to read metadata {}: {}", final_path.display(), err))?
        .len();

    Ok(VaultImportComputation {
        result: VaultImportResult {
            vault_path: path_to_string(&final_path)?,
            sha256,
            ext,
            size,
            created_at: Utc::now().to_rfc3339(),
            original_filename: original_filename
                .map(str::to_string)
                .unwrap_or(fallback_filename),
        },
        hash_ms,
        copy_ms,
        deduped,
    })
}

fn import_with_metadata(
    source_path: Option<&Path>,
    source_bytes: Option<&[u8]>,
    requested_ext: Option<&str>,
    original_filename: Option<&str>,
) -> Result<VaultImportResult, String> {
    Ok(import_with_metadata_detailed(source_path, source_bytes, requested_ext, original_filename)?
        .result)
}

fn generate_thumbnail_internal(
    input_path: &Path,
    output_path: &Path,
    max_size: u32,
) -> Result<(), String> {
    let total_started_at = Instant::now();

    if !input_path.exists() {
        return Err(format!(
            "thumbnail source file does not exist: {}",
            input_path.display()
        ));
    }
    if !input_path.is_file() {
        return Err(format!(
            "thumbnail source is not a file: {}",
            input_path.display()
        ));
    }

    if output_path.exists() {
        println!(
            "[thumb-gen] skip-existing source={} output={}",
            input_path.display(),
            output_path.display()
        );
        return Ok(());
    }

    if let Some(parent_dir) = output_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|err| {
            format!(
                "failed to create thumbnail output directory {}: {}",
                parent_dir.display(),
                err
            )
        })?;
    }

    let decode_started_at = Instant::now();
    let image_reader = ImageReader::open(input_path)
        .map_err(|err| format!("failed to open image {}: {}", input_path.display(), err))?
        .with_guessed_format()
        .map_err(|err| {
            format!(
                "failed to detect image format {}: {}",
                input_path.display(),
                err
            )
        })?;

    let source_image = image_reader
        .decode()
        .map_err(|err| format!("failed to decode image {}: {}", input_path.display(), err))?;
    let decode_ms = decode_started_at.elapsed().as_millis() as u64;

    let (width, height) = source_image.dimensions();
    if width == 0 || height == 0 {
        return Err(format!(
            "invalid image dimensions for thumbnail source {}: {}x{}",
            input_path.display(),
            width,
            height
        ));
    }

    let bounded_max = max_size.max(1);
    let longest_side = width.max(height);
    let resize_started_at = Instant::now();
    let resized_image = if longest_side > bounded_max {
        let scale = bounded_max as f64 / longest_side as f64;
        let target_width = ((width as f64) * scale).round().max(1.0) as u32;
        let target_height = ((height as f64) * scale).round().max(1.0) as u32;
        source_image.resize(target_width, target_height, FilterType::Triangle)
    } else {
        source_image
    };
    let resize_ms = resize_started_at.elapsed().as_millis() as u64;
    let (resized_width, resized_height) = resized_image.dimensions();

    let encode_started_at = Instant::now();
    let rgba = resized_image.to_rgba8();
    let encoder = webp::Encoder::from_rgba(rgba.as_raw(), resized_width, resized_height);
    let encoded = encoder.encode(THUMB_WEBP_QUALITY);
    let mut output_file = File::create(output_path).map_err(|err| {
        format!(
            "failed to create thumbnail output {}: {}",
            output_path.display(),
            err
        )
    })?;

    output_file.write_all(encoded.as_ref()).map_err(|err| {
        format!(
            "failed to write thumbnail output {}: {}",
            output_path.display(),
            err
        )
    })?;
    output_file.flush().map_err(|err| {
        format!(
            "failed to flush thumbnail output {}: {}",
            output_path.display(),
            err
        )
    })?;
    let encode_ms = encode_started_at.elapsed().as_millis() as u64;
    let total_ms = total_started_at.elapsed().as_millis() as u64;

    println!(
        "[thumb-gen] source={} output={} source_w={} source_h={} target_w={} target_h={} max_size={} quality={} decode_ms={} resize_ms={} encode_ms={} total_ms={}",
        input_path.display(),
        output_path.display(),
        width,
        height,
        resized_width,
        resized_height,
        bounded_max,
        THUMB_WEBP_QUALITY,
        decode_ms,
        resize_ms,
        encode_ms,
        total_ms
    );

    Ok(())
}

fn is_image_extension(ext: &str) -> bool {
    matches!(
        normalize_ext(ext).as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    )
}

fn read_image_dimensions(input_path: &Path) -> Result<(u32, u32), String> {
    let reader = ImageReader::open(input_path)
        .map_err(|err| format!("failed to open image {}: {}", input_path.display(), err))?
        .with_guessed_format()
        .map_err(|err| {
            format!(
                "failed to detect image format {}: {}",
                input_path.display(),
                err
            )
        })?;
    reader
        .into_dimensions()
        .map_err(|err| format!("failed to read image dimensions {}: {}", input_path.display(), err))
}

fn run_import_pipeline_internal(
    source_path: Option<PathBuf>,
    source_bytes: Option<Vec<u8>>,
    requested_ext: Option<String>,
    original_filename: Option<String>,
    generate_thumb: bool,
) -> Result<ImportPipelineResult, String> {
    let started_at = Instant::now();
    let computation = import_with_metadata_detailed(
        source_path.as_deref(),
        source_bytes.as_deref(),
        requested_ext.as_deref(),
        original_filename.as_deref(),
    )?;
    let imported = computation.result;
    let vault_key = build_vault_filename(&imported.sha256, &imported.ext);
    let vault_path = PathBuf::from(&imported.vault_path);

    let is_image = is_image_extension(&imported.ext);
    let mut width = None;
    let mut height = None;
    let mut metadata_ms = 0_u64;
    let mut thumb_ms = 0_u64;
    let mut thumb_status = if is_image {
        DEFAULT_THUMB_STATUS.to_string()
    } else {
        "ready".to_string()
    };
    let mut thumb_path: Option<String> = None;

    if is_image {
        let metadata_started_at = Instant::now();
        match read_image_dimensions(&vault_path) {
            Ok((w, h)) => {
                width = Some(w);
                height = Some(h);
            }
            Err(err) => {
                eprintln!(
                    "[import-pipeline] failed to read dimensions for {}: {}",
                    vault_path.display(),
                    err
                );
                thumb_status = "error".to_string();
            }
        }
        metadata_ms = metadata_started_at.elapsed().as_millis() as u64;

        let should_skip_thumb = match (width, height) {
            (Some(w), Some(h)) => w.max(h) <= IMPORT_THUMB_MAX_SIZE,
            _ => false,
        };

        if thumb_status != "error" {
            if should_skip_thumb {
                thumb_status = "skipped".to_string();
            } else if generate_thumb {
                let thumb_started_at = Instant::now();
                match thumb_output_path_for_vault_key(&vault_key) {
                    Ok(path) => match generate_thumbnail_internal(&vault_path, &path, IMPORT_THUMB_MAX_SIZE) {
                        Ok(_) => {
                            thumb_status = "ready".to_string();
                            thumb_path = Some(path_to_string(&path)?);
                        }
                        Err(err) => {
                            eprintln!(
                                "[import-pipeline] failed to generate thumbnail for {}: {}",
                                vault_path.display(),
                                err
                            );
                            thumb_status = "error".to_string();
                        }
                    },
                    Err(err) => {
                        eprintln!(
                            "[import-pipeline] failed to compute thumbnail path for key {}: {}",
                            vault_key, err
                        );
                        thumb_status = "error".to_string();
                    }
                }
                thumb_ms = thumb_started_at.elapsed().as_millis() as u64;
            } else {
                thumb_status = DEFAULT_THUMB_STATUS.to_string();
            }
        }
    }

    let total_ms = started_at.elapsed().as_millis() as u64;
    let metrics = ImportPipelineMetrics {
        hash_ms: computation.hash_ms,
        copy_ms: computation.copy_ms,
        metadata_ms,
        thumb_ms,
        total_ms,
        deduped: computation.deduped,
    };

    println!(
        "[import-pipeline] file={} hash_ms={} copy_ms={} metadata_ms={} thumb_ms={} total_ms={} deduped={} thumb_status={}",
        imported.original_filename,
        metrics.hash_ms,
        metrics.copy_ms,
        metrics.metadata_ms,
        metrics.thumb_ms,
        metrics.total_ms,
        metrics.deduped,
        thumb_status
    );

    Ok(ImportPipelineResult {
        vault_path: imported.vault_path,
        sha256: imported.sha256,
        ext: imported.ext,
        size: imported.size,
        created_at: imported.created_at,
        original_filename: imported.original_filename,
        width,
        height,
        thumb_status,
        thumb_path,
        metrics,
    })
}

#[tauri::command]
fn init_db() -> Result<String, String> {
    initialize_db()?;
    let path = db_path()?;
    path_to_string(&path)
}

#[tauri::command]
fn load_app_state() -> Result<DbAppState, String> {
    initialize_db()?;
    let connection = open_db_connection()?;

    let mut collections_stmt = connection
        .prepare(
            "SELECT
                id,
                parent_id,
                name,
                description,
                icon,
                color,
                created_at,
                updated_at
             FROM collections
             ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to prepare collections query: {}", err))?;

    let collections_iter = collections_stmt
        .query_map([], |row| {
            Ok(DbCollectionRow {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                icon: row.get(4)?,
                color: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|err| format!("failed to query collections: {}", err))?;

    let mut collections = Vec::new();
    for row_result in collections_iter {
        collections
            .push(row_result.map_err(|err| format!("failed to read collection row: {}", err))?);
    }

    let mut collection_items_stmt = connection
        .prepare(
            "SELECT
                id,
                collection_id,
                item_id,
                custom_title,
                custom_description,
                sort_index,
                created_at
             FROM collection_items
             ORDER BY collection_id ASC, sort_index ASC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("failed to prepare collection_items query: {}", err))?;

    let collection_items_iter = collection_items_stmt
        .query_map([], |row| {
            Ok(DbCollectionItemRow {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                item_id: row.get(2)?,
                custom_title: row.get(3)?,
                custom_description: row.get(4)?,
                sort_index: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| format!("failed to query collection_items: {}", err))?;

    let mut collection_items = Vec::new();
    for row_result in collection_items_iter {
        collection_items.push(
            row_result.map_err(|err| format!("failed to read collection_items row: {}", err))?,
        );
    }

    let mut tags_stmt = connection
        .prepare(
            "SELECT
                id,
                name,
                color,
                sort_index,
                created_at,
                updated_at
             FROM tags
             ORDER BY sort_index ASC, created_at ASC, LOWER(name) ASC, name ASC",
        )
        .map_err(|err| format!("failed to prepare tags query: {}", err))?;

    let tags_iter = tags_stmt
        .query_map([], db_tag_row_from_row)
        .map_err(|err| format!("failed to query tags: {}", err))?;

    let mut tags = Vec::new();
    for row_result in tags_iter {
        tags.push(row_result.map_err(|err| format!("failed to read tag row: {}", err))?);
    }

    let mut items_stmt = connection
        .prepare(
            "SELECT
                i.id,
                i.collection_id,
                i.type,
                i.title,
                i.filename,
                i.vault_key,
                i.vault_path,
                i.preview_url,
                i.width,
                i.height,
                i.thumb_status,
                i.import_status,
                i.url,
                i.favicon_path,
                i.meta_status,
                i.description,
                i.rating,
                i.is_favorite,
                i.created_at,
                i.updated_at,
                COALESCE(GROUP_CONCAT(it.tag_id, '|'), ''),
                COALESCE(GROUP_CONCAT(t.name, '|'), '')
             FROM items AS i
             LEFT JOIN item_tags AS it ON it.item_id = i.id
             LEFT JOIN tags AS t ON t.id = it.tag_id
             GROUP BY i.id
             ORDER BY i.created_at DESC",
        )
        .map_err(|err| format!("failed to prepare items query: {}", err))?;

    let items_iter = items_stmt
        .query_map([], |row| {
            let tag_ids_raw: String = row.get(20)?;
            let tag_names: String = row.get(21)?;
            let tag_ids = if tag_ids_raw.is_empty() {
                Vec::new()
            } else {
                tag_ids_raw.split('|').map(str::to_string).collect()
            };
            let tags = if tag_names.is_empty() {
                Vec::new()
            } else {
                tag_names.split('|').map(str::to_string).collect()
            };

            Ok(DbItemRow {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                item_type: row.get(2)?,
                title: row.get(3)?,
                filename: row.get(4)?,
                vault_key: row.get(5)?,
                vault_path: row.get(6)?,
                preview_url: row.get(7)?,
                width: row.get(8)?,
                height: row.get(9)?,
                thumb_status: normalize_thumb_status(&row.get::<_, String>(10)?),
                import_status: normalize_import_status(&row.get::<_, String>(11)?),
                url: row.get(12)?,
                favicon_path: row.get(13)?,
                meta_status: normalize_meta_status(&row.get::<_, String>(14)?),
                description: row.get(15)?,
                rating: normalize_item_rating(row.get::<_, i64>(16)?),
                is_favorite: row.get::<_, i64>(17)? != 0,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
                tag_ids,
                tags,
            })
        })
        .map_err(|err| format!("failed to query items: {}", err))?;

    let mut items = Vec::new();
    for row_result in items_iter {
        items.push(row_result.map_err(|err| format!("failed to read item row: {}", err))?);
    }

    Ok(DbAppState {
        collections,
        collection_items,
        tags,
        items,
    })
}

#[tauri::command]
fn create_collection(
    name: String,
    parent_id: Option<String>,
    icon: String,
    color: String,
    description: Option<String>,
) -> Result<DbCollectionRow, String> {
    initialize_db()?;
    let connection = open_db_connection()?;

    let normalized_name = name.trim().to_string();
    if normalized_name.is_empty() {
        return Err("collection name cannot be empty".to_string());
    }

    let normalized_icon = icon.trim().to_string();
    if normalized_icon.is_empty() {
        return Err("collection icon cannot be empty".to_string());
    }

    let normalized_color = color.trim().to_string();
    if normalized_color.is_empty() {
        return Err("collection color cannot be empty".to_string());
    }

    let normalized_parent_id = parent_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(parent_collection_id) = normalized_parent_id.as_deref() {
        let parent_exists = connection
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![parent_collection_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| format!("failed to validate parent collection: {}", err))?;
        if parent_exists.is_none() {
            return Err("parent collection not found".to_string());
        }
    }

    let normalized_description = description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let now = Utc::now().timestamp_millis();
    let collection_id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO collections (
                id,
                name,
                description,
                icon,
                color,
                parent_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                &collection_id,
                &normalized_name,
                normalized_description.as_deref(),
                &normalized_icon,
                &normalized_color,
                normalized_parent_id.as_deref(),
                now
            ],
        )
        .map_err(|err| format!("failed to create collection: {}", err))?;

    Ok(DbCollectionRow {
        id: collection_id,
        parent_id: normalized_parent_id,
        name: normalized_name,
        description: normalized_description,
        icon: normalized_icon,
        color: normalized_color,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
fn get_all_collections() -> Result<Vec<DbCollectionRow>, String> {
    initialize_db()?;
    let connection = open_db_connection()?;

    let mut stmt = connection
        .prepare(
            "SELECT
                id,
                parent_id,
                name,
                description,
                icon,
                color,
                created_at,
                updated_at
             FROM collections
             ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to prepare all collections query: {}", err))?;

    let row_iter = stmt
        .query_map([], |row| {
            Ok(DbCollectionRow {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                icon: row.get(4)?,
                color: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|err| format!("failed to query all collections: {}", err))?;

    let mut collections = Vec::new();
    for row_result in row_iter {
        collections.push(
            row_result.map_err(|err| format!("failed to read collection row: {}", err))?,
        );
    }

    Ok(collections)
}

#[tauri::command]
fn update_collection_name(id: String, name: String) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;

    let normalized_name = name.trim().to_string();
    if normalized_name.is_empty() {
        return Err("collection name cannot be empty".to_string());
    }

    let updated_at = Utc::now().timestamp_millis();
    let updated_rows = connection
        .execute(
            "UPDATE collections
             SET name = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![normalized_name, updated_at, id],
        )
        .map_err(|err| format!("failed to update collection name: {}", err))?;

    if updated_rows == 0 {
        return Err("collection not found while updating name".to_string());
    }

    Ok(updated_at)
}

fn load_child_collection_ids_in_tx(
    transaction: &Transaction<'_>,
    parent_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = transaction
        .prepare("SELECT id FROM collections WHERE parent_id = ?1")
        .map_err(|err| format!("failed to prepare child collection query: {}", err))?;
    let row_iter = stmt
        .query_map(params![parent_id], |row| row.get::<_, String>(0))
        .map_err(|err| format!("failed to query child collections: {}", err))?;

    let mut child_ids = Vec::new();
    for row_result in row_iter {
        child_ids
            .push(row_result.map_err(|err| format!("failed to read child collection row: {}", err))?);
    }
    Ok(child_ids)
}

fn collect_collection_subtree_ids_in_tx(
    transaction: &Transaction<'_>,
    root_collection_id: &str,
) -> Result<Vec<String>, String> {
    let mut stack = vec![root_collection_id.to_string()];
    let mut visited_ids = BTreeSet::new();
    let mut collected_ids = Vec::new();

    while let Some(collection_id) = stack.pop() {
        if !visited_ids.insert(collection_id.clone()) {
            continue;
        }

        collected_ids.push(collection_id.clone());
        let child_ids = load_child_collection_ids_in_tx(transaction, &collection_id)?;
        for child_id in child_ids {
            stack.push(child_id);
        }
    }

    Ok(collected_ids)
}

#[tauri::command]
fn delete_collection(id: String) -> Result<usize, String> {
    initialize_db()?;
    let trimmed_id = id.trim().to_string();
    if trimmed_id.is_empty() {
        return Err("collection id cannot be empty".to_string());
    }

    let (subtree_ids, item_ids) = {
        let mut connection = open_db_connection()?;
        let transaction = connection
            .transaction()
            .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

        let exists = transaction
            .query_row(
                "SELECT 1 FROM collections WHERE id = ?1",
                params![&trimmed_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| format!("failed to verify collection before delete: {}", err))?;
        if exists.is_none() {
            return Ok(0);
        }

        let subtree_ids = collect_collection_subtree_ids_in_tx(&transaction, &trimmed_id)?;
        let subtree_id_set: BTreeSet<String> = subtree_ids.iter().cloned().collect();
        let mut candidate_item_ids = Vec::new();
        let mut seen_item_ids = BTreeSet::new();
        for collection_id in &subtree_ids {
            let mut stmt = transaction
                .prepare("SELECT DISTINCT item_id FROM collection_items WHERE collection_id = ?1")
                .map_err(|err| format!("failed to prepare collection membership query: {}", err))?;
            let row_iter = stmt
                .query_map(params![collection_id], |row| row.get::<_, String>(0))
                .map_err(|err| format!("failed to query collection membership item ids: {}", err))?;

            for row_result in row_iter {
                let item_id = row_result
                    .map_err(|err| format!("failed to read collection item id: {}", err))?;
                if seen_item_ids.insert(item_id.clone()) {
                    candidate_item_ids.push(item_id);
                }
            }
        }

        let mut item_ids = Vec::new();
        for item_id in candidate_item_ids {
            let mut membership_stmt = transaction
                .prepare("SELECT collection_id FROM collection_items WHERE item_id = ?1")
                .map_err(|err| format!("failed to prepare item membership scan: {}", err))?;
            let membership_iter = membership_stmt
                .query_map(params![&item_id], |row| row.get::<_, String>(0))
                .map_err(|err| format!("failed to query item memberships for delete preflight: {}", err))?;

            let mut has_membership_outside_subtree = false;
            for membership_row in membership_iter {
                let membership_collection_id = membership_row.map_err(|err| {
                    format!("failed to read item membership row during delete preflight: {}", err)
                })?;
                if !subtree_id_set.contains(&membership_collection_id) {
                    has_membership_outside_subtree = true;
                    break;
                }
            }

            if !has_membership_outside_subtree {
                item_ids.push(item_id);
            }
        }

        transaction
            .commit()
            .map_err(|err| format!("failed to commit collection delete preflight transaction: {}", err))?;

        (subtree_ids, item_ids)
    };

    if !item_ids.is_empty() {
        let _ = delete_items_with_cleanup_internal(item_ids)?;
    }

    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    let mut deleted_rows = 0usize;
    for collection_id in subtree_ids.iter().rev() {
        let affected = transaction
            .execute("DELETE FROM collections WHERE id = ?1", params![collection_id])
            .map_err(|err| format!("failed to delete collection row: {}", err))?;
        deleted_rows += affected;
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit delete collection transaction: {}", err))?;

    Ok(deleted_rows)
}

#[tauri::command]
fn create_tag(input: CreateTagInput) -> Result<DbTagRow, String> {
    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    let normalized_name = normalize_tag_name(&input.name)?;
    let normalized_color = normalize_tag_color(&input.color)?;
    let now = Utc::now().timestamp_millis();

    if find_tag_row_by_name_in_tx(&transaction, &normalized_name)?.is_some() {
        return Err("tag name already exists".to_string());
    }

    let created = insert_tag_row_in_tx(&transaction, &normalized_name, &normalized_color, now)?;
    transaction
        .commit()
        .map_err(|err| format!("failed to commit create tag transaction: {}", err))?;
    Ok(created)
}

#[tauri::command]
fn get_all_tags() -> Result<Vec<DbTagRow>, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let mut stmt = connection
        .prepare(
            "SELECT id, name, color, sort_index, created_at, updated_at
             FROM tags
             ORDER BY sort_index ASC, created_at ASC, LOWER(name) ASC, name ASC",
        )
        .map_err(|err| format!("failed to prepare all tags query: {}", err))?;
    let row_iter = stmt
        .query_map([], db_tag_row_from_row)
        .map_err(|err| format!("failed to query all tags: {}", err))?;
    let mut tags = Vec::new();
    for row_result in row_iter {
        tags.push(row_result.map_err(|err| format!("failed to read tag row: {}", err))?);
    }
    Ok(tags)
}

#[tauri::command]
fn reorder_tags(ordered_tag_ids: Vec<String>) -> Result<UpdateCollectionOrderResult, String> {
    let normalized_tag_ids = normalize_item_ids_input(ordered_tag_ids);
    let updated_at = Utc::now().timestamp_millis();

    if normalized_tag_ids.is_empty() {
        return Ok(UpdateCollectionOrderResult {
            updated_rows: 0,
            skipped_rows: 0,
            updated_at,
        });
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    let mut updated_rows = 0usize;
    let mut skipped_rows = 0usize;
    for (index, tag_id) in normalized_tag_ids.iter().enumerate() {
        let affected = transaction
            .execute(
                "UPDATE tags
                 SET sort_index = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![index as i64, updated_at, tag_id],
            )
            .map_err(|err| format!("failed to reorder tag row: {}", err))?;
        if affected == 0 {
            skipped_rows += 1;
        } else {
            updated_rows += affected;
        }
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit reorder tags transaction: {}", err))?;

    Ok(UpdateCollectionOrderResult {
        updated_rows,
        skipped_rows,
        updated_at,
    })
}

#[tauri::command]
fn update_tag_name(input: UpdateTagNameInput) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let tag_id = normalize_trimmed_id(&input.id).ok_or_else(|| "tag id cannot be empty".to_string())?;
    let normalized_name = normalize_tag_name(&input.name)?;
    let updated_at = Utc::now().timestamp_millis();

    let updated_rows = connection
        .execute(
            "UPDATE tags
             SET name = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![normalized_name, updated_at, tag_id],
        )
        .map_err(|err| format!("failed to update tag name: {}", err))?;
    if updated_rows == 0 {
        return Err("tag not found while updating name".to_string());
    }
    Ok(updated_at)
}

#[tauri::command]
fn update_tag_color(input: UpdateTagColorInput) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let tag_id = normalize_trimmed_id(&input.id).ok_or_else(|| "tag id cannot be empty".to_string())?;
    let normalized_color = normalize_tag_color(&input.color)?;
    let updated_at = Utc::now().timestamp_millis();

    let updated_rows = connection
        .execute(
            "UPDATE tags
             SET color = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![normalized_color, updated_at, tag_id],
        )
        .map_err(|err| format!("failed to update tag color: {}", err))?;
    if updated_rows == 0 {
        return Err("tag not found while updating color".to_string());
    }
    Ok(updated_at)
}

#[tauri::command]
fn duplicate_tag(id: String) -> Result<DbTagRow, String> {
    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;
    let tag_id = normalize_trimmed_id(&id).ok_or_else(|| "tag id cannot be empty".to_string())?;

    let source = transaction
        .query_row(
            "SELECT id, name, color, sort_index, created_at, updated_at
             FROM tags
             WHERE id = ?1",
            params![&tag_id],
            db_tag_row_from_row,
        )
        .optional()
        .map_err(|err| format!("failed to load tag for duplicate: {}", err))?
        .ok_or_else(|| "tag not found while duplicating".to_string())?;

    let duplicate_name = next_duplicate_tag_name(&transaction, &source.name)?;
    let now = Utc::now().timestamp_millis();
    let duplicated = insert_tag_row_in_tx(&transaction, &duplicate_name, &source.color, now)?;

    transaction
        .commit()
        .map_err(|err| format!("failed to commit duplicate tag transaction: {}", err))?;
    Ok(duplicated)
}

#[tauri::command]
fn delete_tag(input: DeleteTagInput) -> Result<usize, String> {
    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;
    let tag_id = normalize_trimmed_id(&input.id).ok_or_else(|| "tag id cannot be empty".to_string())?;
    let updated_at = Utc::now().timestamp_millis();

    transaction
        .execute(
            "UPDATE items
             SET updated_at = ?1
             WHERE id IN (
               SELECT DISTINCT item_id FROM item_tags WHERE tag_id = ?2
             )",
            params![updated_at, &tag_id],
        )
        .map_err(|err| format!("failed to update item timestamps for tag delete: {}", err))?;

    let deleted_rows = transaction
        .execute("DELETE FROM tags WHERE id = ?1", params![&tag_id])
        .map_err(|err| format!("failed to delete tag: {}", err))?;

    transaction
        .commit()
        .map_err(|err| format!("failed to commit delete tag transaction: {}", err))?;
    Ok(deleted_rows)
}

#[tauri::command]
fn update_item_tags(input: UpdateItemTagsInput) -> Result<i64, String> {
    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    let item_id = normalize_trimmed_id(&input.item_id).ok_or_else(|| "item id cannot be empty".to_string())?;
    let tag_ids = normalize_item_ids_input(input.tag_ids);
    let updated_at = Utc::now().timestamp_millis();

    let item_exists = transaction
        .query_row(
            "SELECT 1 FROM items WHERE id = ?1",
            params![&item_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("failed to validate item for tag update: {}", err))?;
    if item_exists.is_none() {
        return Err("item not found while updating tags".to_string());
    }

    for tag_id in &tag_ids {
        let tag_exists = transaction
            .query_row(
                "SELECT 1 FROM tags WHERE id = ?1",
                params![tag_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| format!("failed to validate tag for item tag update: {}", err))?;
        if tag_exists.is_none() {
            return Err(format!("tag not found while assigning to item: {}", tag_id));
        }
    }

    transaction
        .execute("DELETE FROM item_tags WHERE item_id = ?1", params![&item_id])
        .map_err(|err| format!("failed to clear item tag mappings: {}", err))?;

    for tag_id in &tag_ids {
        transaction
            .execute(
                "INSERT INTO item_tags (item_id, tag_id) VALUES (?1, ?2)",
                params![&item_id, tag_id],
            )
            .map_err(|err| format!("failed to insert item tag mapping: {}", err))?;
    }

    let updated_rows = transaction
        .execute(
            "UPDATE items
             SET updated_at = ?1
             WHERE id = ?2",
            params![updated_at, &item_id],
        )
        .map_err(|err| format!("failed to update item timestamp for tag update: {}", err))?;
    if updated_rows == 0 {
        return Err("item not found while finalizing tag update".to_string());
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit update item tags transaction: {}", err))?;
    Ok(updated_at)
}

fn insert_item_in_tx(transaction: &Transaction<'_>, item: InsertItemInput) -> Result<(), String> {
    let InsertItemInput {
        id,
        collection_id,
        item_type,
        title,
        filename,
        vault_key,
        vault_path,
        preview_url,
        width,
        height,
        thumb_status,
        import_status,
        url,
        favicon_path,
        meta_status,
        description,
        rating,
        is_favorite,
        created_at,
        updated_at,
        tags,
    } = item;
    let collection_id_for_membership = collection_id.clone();
    let tag_timestamp = Utc::now().timestamp_millis();

    transaction
        .execute(
            "INSERT INTO items (
                id,
                collection_id,
                type,
                title,
                filename,
                vault_key,
                vault_path,
                preview_url,
                width,
                height,
                thumb_status,
                import_status,
                url,
                favicon_path,
                meta_status,
                description,
                rating,
                is_favorite,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                &id,
                collection_id,
                item_type,
                title,
                filename,
                vault_key,
                vault_path,
                preview_url,
                width,
                height,
                normalize_thumb_status(&thumb_status),
                normalize_import_status(&import_status),
                url,
                favicon_path,
                meta_status
                    .as_deref()
                    .map(normalize_meta_status)
                    .unwrap_or_else(|| DEFAULT_META_STATUS.to_string()),
                description,
                normalize_item_rating(rating),
                normalize_is_favorite_int(is_favorite),
                created_at,
                updated_at,
            ],
        )
        .map_err(|err| format!("failed to insert item row: {}", err))?;

    if let Some(collection_id) = collection_id_for_membership.as_deref() {
        let sort_index = next_collection_item_sort_index_in_tx(transaction, collection_id)?;
        insert_collection_membership_in_tx(transaction, &id, collection_id, sort_index, created_at)?;
    }

    increment_vault_ref_in_tx(transaction, &vault_key, &vault_path)?;

    transaction
        .execute("DELETE FROM item_tags WHERE item_id = ?1", params![&id])
        .map_err(|err| format!("failed to clear existing item tags: {}", err))?;

    let mut unique_tags = BTreeSet::new();
    for raw_tag in tags {
        let trimmed = raw_tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        unique_tags.insert(trimmed.to_string());
    }

    for tag_name in unique_tags {
        let tag_id = ensure_tag_exists_by_name_in_tx(transaction, &tag_name, tag_timestamp)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)",
                params![&id, &tag_id],
            )
            .map_err(|err| format!("failed to map item tag row: {}", err))?;
    }

    Ok(())
}

#[tauri::command]
fn insert_item(item: InsertItemInput) -> Result<(), String> {
    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    insert_item_in_tx(&transaction, item)?;

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    Ok(())
}

#[tauri::command]
fn insert_items_batch(items: Vec<InsertItemInput>) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    for item in items {
        insert_item_in_tx(&transaction, item)?;
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    Ok(())
}

fn delete_items_with_cleanup_internal(item_ids: Vec<String>) -> Result<DeleteItemsResult, String> {
    if item_ids.is_empty() {
        return Ok(DeleteItemsResult {
            deleted_rows: 0,
            cleanup: Vec::new(),
        });
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    let mut vault_counts_by_key: HashMap<String, i64> = HashMap::new();
    let mut vault_path_by_key: HashMap<String, String> = HashMap::new();
    let mut favicon_paths_to_check: BTreeSet<String> = BTreeSet::new();
    let mut deleted_rows = 0usize;

    for item_id in &item_ids {
        let maybe_item_assets = transaction
            .query_row(
                "SELECT vault_key, vault_path, favicon_path FROM items WHERE id = ?1",
                params![item_id],
                |row| {
                    let vault_key: String = row.get(0)?;
                    let vault_path: String = row.get(1)?;
                    let favicon_path: Option<String> = row.get(2)?;
                    Ok((vault_key, vault_path, favicon_path))
                },
            )
            .optional()
            .map_err(|err| format!("failed to read item before delete: {}", err))?;

        if let Some((vault_key, vault_path, favicon_path)) = maybe_item_assets {
            if !vault_key.trim().is_empty() {
                let next_count = vault_counts_by_key.entry(vault_key.clone()).or_insert(0);
                *next_count += 1;
                vault_path_by_key.entry(vault_key).or_insert(vault_path);
            }
            if let Some(path) = favicon_path {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    favicon_paths_to_check.insert(trimmed.to_string());
                }
            }
        }
    }

    for item_id in item_ids {
        let affected = transaction
            .execute("DELETE FROM items WHERE id = ?1", params![item_id])
            .map_err(|err| format!("failed to delete item row: {}", err))?;
        deleted_rows += affected;
    }

    let mut zero_ref_candidates: Vec<(String, String, String, String)> = Vec::new();
    for (vault_key, decrement_by) in vault_counts_by_key {
        let refs_after_delete = decrement_vault_ref_in_tx(&transaction, &vault_key, decrement_by)?;
        let remaining_item_refs: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM items WHERE vault_key = ?1",
                params![&vault_key],
                |row| row.get(0),
            )
            .map_err(|err| format!("failed to verify remaining item refs: {}", err))?;

        if refs_after_delete == 0 && remaining_item_refs == 0 {
            if let Some((sha256, ext)) = parse_vault_key(&vault_key) {
                let vault_path = vault_path_by_key
                    .get(&vault_key)
                    .cloned()
                    .unwrap_or_default();
                zero_ref_candidates.push((vault_key, vault_path, sha256, ext));
            } else {
                eprintln!(
                    "cannot cleanup invalid vault key after delete: {}",
                    vault_key
                );
            }
        }
    }

    let mut favicon_cleanup_candidates: Vec<String> = Vec::new();
    for favicon_path in favicon_paths_to_check {
        let remaining_item_refs: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM items WHERE favicon_path = ?1",
                params![&favicon_path],
                |row| row.get(0),
            )
            .map_err(|err| format!("failed to verify remaining favicon refs: {}", err))?;

        if remaining_item_refs == 0 {
            favicon_cleanup_candidates.push(favicon_path);
        }
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    let storage_root = ensure_storage_root_internal()?;
    let mut rows_to_prune: Vec<String> = Vec::new();
    let mut cleanup_entries = Vec::new();

    for (vault_key, vault_path, sha256, ext) in zero_ref_candidates {
        let vault_filename = build_vault_filename(&sha256, &ext);
        let existing_paths = find_vault_files(&storage_root, &vault_filename)
            .map_err(|err| format!("failed to locate vault cleanup targets: {}", err))?;

        let mut deleted_from_disk = false;
        let mut cleanup_ok = true;
        for path in existing_paths {
            if let Err(err) = fs::remove_file(&path) {
                cleanup_ok = false;
                eprintln!("failed to remove vault file {}: {}", path.display(), err);
            } else {
                deleted_from_disk = true;
            }
        }

        if let Err(err) = remove_thumbnail_for_vault_key(&vault_key) {
            cleanup_ok = false;
            eprintln!(
                "failed to remove thumbnail for vault key {}: {}",
                vault_key, err
            );
        }

        if cleanup_ok {
            rows_to_prune.push(vault_key.clone());
        }

        cleanup_entries.push(VaultCleanupEntry {
            vault_key,
            vault_path,
            sha256,
            ext,
            deleted_from_disk,
        });
    }

    for favicon_path in favicon_cleanup_candidates {
        if let Err(err) = remove_favicon_file(&favicon_path) {
            eprintln!("failed to remove favicon {}: {}", favicon_path, err);
        }
    }

    if !rows_to_prune.is_empty() {
        let mut prune_connection = open_db_connection()?;
        let prune_tx = prune_connection
            .transaction()
            .map_err(|err| format!("failed to start vault prune transaction: {}", err))?;
        for vault_key in rows_to_prune {
            prune_tx
                .execute(
                    "DELETE FROM vault_files WHERE vault_key = ?1",
                    params![vault_key],
                )
                .map_err(|err| format!("failed to prune vault row: {}", err))?;
        }
        prune_tx
            .commit()
            .map_err(|err| format!("failed to commit vault prune transaction: {}", err))?;
    }

    Ok(DeleteItemsResult {
        deleted_rows,
        cleanup: cleanup_entries,
    })
}

#[tauri::command]
fn delete_items_with_cleanup(item_ids: Vec<String>) -> Result<DeleteItemsResult, String> {
    delete_items_with_cleanup_internal(item_ids)
}

#[tauri::command]
fn delete_items(item_ids: Vec<String>) -> Result<usize, String> {
    let result = delete_items_with_cleanup_internal(item_ids)?;
    Ok(result.deleted_rows)
}

fn normalize_trimmed_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_optional_trimmed_id(value: Option<String>) -> Option<String> {
    value.and_then(|entry| normalize_trimmed_id(&entry))
}

fn normalize_item_ids_input(item_ids: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for item_id in item_ids {
        if let Some(trimmed) = normalize_trimmed_id(&item_id) {
            if seen.insert(trimmed.clone()) {
                normalized.push(trimmed);
            }
        }
    }
    normalized
}

fn validate_collection_exists_in_tx(
    transaction: &Transaction<'_>,
    collection_id: &str,
) -> Result<(), String> {
    let exists = transaction
        .query_row(
            "SELECT 1 FROM collections WHERE id = ?1",
            params![collection_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("failed to verify collection existence: {}", err))?;
    if exists.is_none() {
        return Err(format!("collection not found: {}", collection_id));
    }
    Ok(())
}

fn collection_membership_exists_in_tx(
    transaction: &Transaction<'_>,
    item_id: &str,
    collection_id: &str,
) -> Result<bool, String> {
    let exists = transaction
        .query_row(
            "SELECT 1
             FROM collection_items
             WHERE item_id = ?1 AND collection_id = ?2
             LIMIT 1",
            params![item_id, collection_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("failed to verify collection membership: {}", err))?;
    Ok(exists.is_some())
}

fn next_collection_item_sort_index_in_tx(
    transaction: &Transaction<'_>,
    collection_id: &str,
) -> Result<i64, String> {
    transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_index), -1) + 1
             FROM collection_items
             WHERE collection_id = ?1",
            params![collection_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("failed to resolve next collection item sort index: {}", err))
}

fn insert_collection_membership_in_tx(
    transaction: &Transaction<'_>,
    item_id: &str,
    collection_id: &str,
    sort_index: i64,
    created_at: i64,
) -> Result<usize, String> {
    let membership_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT OR IGNORE INTO collection_items (
                id,
                collection_id,
                item_id,
                custom_title,
                custom_description,
                sort_index,
                created_at
             ) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5)",
            params![membership_id, collection_id, item_id, sort_index, created_at],
        )
        .map_err(|err| format!("failed to insert collection membership: {}", err))
}

fn sync_item_primary_collection_in_tx(
    transaction: &Transaction<'_>,
    item_id: &str,
    preferred_collection_id: Option<&str>,
    updated_at: i64,
) -> Result<(), String> {
    let current_collection_id = transaction
        .query_row(
            "SELECT collection_id FROM items WHERE id = ?1",
            params![item_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| format!("failed to read item while syncing primary collection: {}", err))?
        .ok_or_else(|| format!("item not found while syncing primary collection: {}", item_id))?;

    let preferred_valid = match preferred_collection_id {
        Some(preferred) => collection_membership_exists_in_tx(transaction, item_id, preferred)?,
        None => false,
    };
    let current_valid = match current_collection_id.as_deref() {
        Some(current_id) => collection_membership_exists_in_tx(transaction, item_id, current_id)?,
        None => false,
    };

    let next_collection_id = if preferred_valid {
        preferred_collection_id.map(str::to_string)
    } else if current_valid {
        current_collection_id
    } else {
        transaction
            .query_row(
                "SELECT collection_id
                 FROM collection_items
                 WHERE item_id = ?1
                 ORDER BY sort_index ASC, created_at ASC, id ASC
                 LIMIT 1",
                params![item_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("failed to resolve fallback primary collection: {}", err))?
    };

    transaction
        .execute(
            "UPDATE items
             SET collection_id = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![next_collection_id.as_deref(), updated_at, item_id],
        )
        .map_err(|err| format!("failed to sync item primary collection: {}", err))?;

    Ok(())
}

fn resolve_source_membership_for_move_in_tx(
    transaction: &Transaction<'_>,
    item_id: &str,
    source_collection_id: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    if let Some(source_collection_id) = source_collection_id {
        return transaction
            .query_row(
                "SELECT id, collection_id
                 FROM collection_items
                 WHERE item_id = ?1 AND collection_id = ?2
                 LIMIT 1",
                params![item_id, source_collection_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|err| format!("failed to resolve explicit source membership: {}", err));
    }

    transaction
        .query_row(
            "SELECT ci.id, ci.collection_id
             FROM collection_items AS ci
             LEFT JOIN items AS i ON i.id = ci.item_id
             WHERE ci.item_id = ?1
             ORDER BY
               CASE
                 WHEN i.collection_id IS NOT NULL AND ci.collection_id = i.collection_id THEN 0
                 ELSE 1
               END,
               ci.sort_index ASC,
               ci.created_at ASC,
               ci.id ASC
             LIMIT 1",
            params![item_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to resolve fallback source membership: {}", err))
}

#[tauri::command]
fn move_collection_item_memberships(
    item_ids: Vec<String>,
    source_collection_id: Option<String>,
    target_collection_id: Option<String>,
) -> Result<UpdateCollectionMembershipsResult, String> {
    let normalized_item_ids = normalize_item_ids_input(item_ids);
    let normalized_source_collection_id = normalize_optional_trimmed_id(source_collection_id);
    let normalized_target_collection_id = normalize_optional_trimmed_id(target_collection_id);

    let updated_at = Utc::now().timestamp_millis();
    if normalized_item_ids.is_empty() {
        return Ok(UpdateCollectionMembershipsResult {
            created_rows: 0,
            updated_rows: 0,
            deleted_rows: 0,
            skipped_rows: 0,
            updated_at,
        });
    }

    if normalized_source_collection_id == normalized_target_collection_id
        && normalized_source_collection_id.is_some()
    {
        return Ok(UpdateCollectionMembershipsResult {
            created_rows: 0,
            updated_rows: 0,
            deleted_rows: 0,
            skipped_rows: normalized_item_ids.len(),
            updated_at,
        });
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    if let Some(target_id) = normalized_target_collection_id.as_deref() {
        validate_collection_exists_in_tx(&transaction, target_id)?;
    }
    if let Some(source_id) = normalized_source_collection_id.as_deref() {
        validate_collection_exists_in_tx(&transaction, source_id)?;
    }

    let mut created_rows = 0usize;
    let mut updated_rows = 0usize;
    let mut deleted_rows = 0usize;
    let mut skipped_rows = 0usize;

    for item_id in &normalized_item_ids {
        let source_membership = resolve_source_membership_for_move_in_tx(
            &transaction,
            item_id,
            normalized_source_collection_id.as_deref(),
        )?;

        match (source_membership, normalized_target_collection_id.as_deref()) {
            (None, None) => {
                skipped_rows += 1;
            }
            (None, Some(target_id)) => {
                let next_sort_index = next_collection_item_sort_index_in_tx(&transaction, target_id)?;
                let inserted = insert_collection_membership_in_tx(
                    &transaction,
                    item_id,
                    target_id,
                    next_sort_index,
                    updated_at,
                )?;
                if inserted == 0 {
                    skipped_rows += 1;
                } else {
                    created_rows += inserted;
                }
                sync_item_primary_collection_in_tx(&transaction, item_id, Some(target_id), updated_at)?;
            }
            (Some((_membership_id, current_collection_id)), Some(target_id)) => {
                if current_collection_id == target_id {
                    skipped_rows += 1;
                    sync_item_primary_collection_in_tx(
                        &transaction,
                        item_id,
                        Some(target_id),
                        updated_at,
                    )?;
                    continue;
                }

                let target_exists =
                    collection_membership_exists_in_tx(&transaction, item_id, target_id)?;
                if target_exists {
                    let affected = transaction
                        .execute(
                            "DELETE FROM collection_items
                             WHERE item_id = ?1 AND collection_id = ?2",
                            params![item_id, current_collection_id],
                        )
                        .map_err(|err| {
                            format!("failed to collapse duplicate membership during move: {}", err)
                        })?;
                    if affected == 0 {
                        skipped_rows += 1;
                    } else {
                        deleted_rows += affected;
                    }
                } else {
                    let next_sort_index =
                        next_collection_item_sort_index_in_tx(&transaction, target_id)?;
                    let affected = transaction
                        .execute(
                            "UPDATE collection_items
                             SET collection_id = ?1,
                                 sort_index = ?2
                             WHERE item_id = ?3 AND collection_id = ?4",
                            params![target_id, next_sort_index, item_id, current_collection_id],
                        )
                        .map_err(|err| format!("failed to move collection membership: {}", err))?;
                    if affected == 0 {
                        skipped_rows += 1;
                    } else {
                        updated_rows += affected;
                    }
                }

                sync_item_primary_collection_in_tx(&transaction, item_id, Some(target_id), updated_at)?;
            }
            (Some((_membership_id, current_collection_id)), None) => {
                let affected = transaction
                    .execute(
                        "DELETE FROM collection_items
                         WHERE item_id = ?1 AND collection_id = ?2",
                        params![item_id, current_collection_id],
                    )
                    .map_err(|err| format!("failed to remove collection membership: {}", err))?;
                if affected == 0 {
                    skipped_rows += 1;
                } else {
                    deleted_rows += affected;
                }
                sync_item_primary_collection_in_tx(&transaction, item_id, None, updated_at)?;
            }
        }
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    Ok(UpdateCollectionMembershipsResult {
        created_rows,
        updated_rows,
        deleted_rows,
        skipped_rows,
        updated_at,
    })
}

#[tauri::command]
fn add_items_to_collection(
    item_ids: Vec<String>,
    collection_id: String,
) -> Result<UpdateCollectionMembershipsResult, String> {
    let normalized_item_ids = normalize_item_ids_input(item_ids);
    let normalized_collection_id = normalize_trimmed_id(&collection_id)
        .ok_or_else(|| "collection id cannot be empty".to_string())?;
    let updated_at = Utc::now().timestamp_millis();

    if normalized_item_ids.is_empty() {
        return Ok(UpdateCollectionMembershipsResult {
            created_rows: 0,
            updated_rows: 0,
            deleted_rows: 0,
            skipped_rows: 0,
            updated_at,
        });
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    validate_collection_exists_in_tx(&transaction, &normalized_collection_id)?;

    let mut created_rows = 0usize;
    let mut skipped_rows = 0usize;

    for item_id in &normalized_item_ids {
        let next_sort_index =
            next_collection_item_sort_index_in_tx(&transaction, &normalized_collection_id)?;
        let inserted = insert_collection_membership_in_tx(
            &transaction,
            item_id,
            &normalized_collection_id,
            next_sort_index,
            updated_at,
        )?;
        if inserted == 0 {
            skipped_rows += 1;
        } else {
            created_rows += inserted;
        }
        sync_item_primary_collection_in_tx(&transaction, item_id, None, updated_at)?;
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    Ok(UpdateCollectionMembershipsResult {
        created_rows,
        updated_rows: 0,
        deleted_rows: 0,
        skipped_rows,
        updated_at,
    })
}

#[tauri::command]
fn reorder_collection_items(
    collection_id: String,
    ordered_item_ids: Vec<String>,
) -> Result<UpdateCollectionOrderResult, String> {
    let normalized_collection_id = normalize_trimmed_id(&collection_id)
        .ok_or_else(|| "collection id cannot be empty".to_string())?;
    let normalized_item_ids = normalize_item_ids_input(ordered_item_ids);
    let updated_at = Utc::now().timestamp_millis();

    if normalized_item_ids.is_empty() {
        return Ok(UpdateCollectionOrderResult {
            updated_rows: 0,
            skipped_rows: 0,
            updated_at,
        });
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    validate_collection_exists_in_tx(&transaction, &normalized_collection_id)?;

    let mut updated_rows = 0usize;
    let mut skipped_rows = 0usize;
    for (index, item_id) in normalized_item_ids.iter().enumerate() {
        let affected = transaction
            .execute(
                "UPDATE collection_items
                 SET sort_index = ?1
                 WHERE collection_id = ?2 AND item_id = ?3",
                params![index as i64, normalized_collection_id, item_id],
            )
            .map_err(|err| format!("failed to reorder collection_items row: {}", err))?;
        if affected == 0 {
            skipped_rows += 1;
        } else {
            updated_rows += affected;
        }
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    Ok(UpdateCollectionOrderResult {
        updated_rows,
        skipped_rows,
        updated_at,
    })
}

#[tauri::command]
fn update_items_collection(
    item_ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<UpdateItemsCollectionResult, String> {
    let membership_result = move_collection_item_memberships(item_ids, None, collection_id)?;
    Ok(UpdateItemsCollectionResult {
        updated_rows: membership_result.created_rows
            + membership_result.updated_rows
            + membership_result.deleted_rows,
        updated_at: membership_result.updated_at,
    })
}

#[tauri::command]
fn update_item_description(item_id: String, description: String) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let updated_at = Utc::now().timestamp_millis();
    let affected_rows = connection
        .execute(
            "UPDATE items
             SET description = ?1, updated_at = ?2
             WHERE id = ?3",
            params![description, updated_at, item_id],
        )
        .map_err(|err| format!("failed to update item description: {}", err))?;

    if affected_rows == 0 {
        return Err("item not found while updating description".to_string());
    }

    Ok(updated_at)
}

#[tauri::command]
fn load_item_overlay(item_id: String) -> Result<Option<serde_json::Value>, String> {
    let normalized_item_id = normalize_trimmed_id(&item_id)
        .ok_or_else(|| "item id cannot be empty".to_string())?;

    initialize_db()?;
    let connection = open_db_connection()?;

    let strokes_json = connection
        .query_row(
            "SELECT strokes_json FROM item_overlays WHERE item_id = ?1",
            params![normalized_item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("failed to load item overlay: {}", err))?;

    let Some(strokes_json) = strokes_json else {
        return Ok(None);
    };

    let parsed = serde_json::from_str::<serde_json::Value>(&strokes_json)
        .map_err(|err| format!("failed to parse stored item overlay JSON: {}", err))?;
    Ok(Some(parsed))
}

#[tauri::command]
fn save_item_overlay(item_id: String, strokes: serde_json::Value) -> Result<i64, String> {
    let normalized_item_id = normalize_trimmed_id(&item_id)
        .ok_or_else(|| "item id cannot be empty".to_string())?;
    if !strokes.is_array() {
        return Err("overlay strokes payload must be an array".to_string());
    }

    initialize_db()?;
    let connection = open_db_connection()?;
    let updated_at = Utc::now().timestamp_millis();
    let strokes_json = serde_json::to_string(&strokes)
        .map_err(|err| format!("failed to serialize item overlay JSON: {}", err))?;

    let affected_rows = connection
        .execute(
            "INSERT INTO item_overlays (item_id, strokes_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(item_id) DO UPDATE SET
               strokes_json = excluded.strokes_json,
               updated_at = excluded.updated_at",
            params![normalized_item_id, strokes_json, updated_at],
        )
        .map_err(|err| format!("failed to save item overlay: {}", err))?;

    if affected_rows == 0 {
        return Err("failed to save item overlay".to_string());
    }

    Ok(updated_at)
}

#[tauri::command]
fn update_item_preferences(input: UpdateItemPreferencesInput) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let updated_at = Utc::now().timestamp_millis();

    let normalized_rating = input.rating.map(normalize_item_rating);
    let normalized_is_favorite = input.is_favorite.map(normalize_is_favorite_int);
    if normalized_rating.is_none() && normalized_is_favorite.is_none() {
        return Err("no item preference fields provided".to_string());
    }

    let affected_rows = connection
        .execute(
            "UPDATE items
             SET rating = COALESCE(?1, rating),
                 is_favorite = COALESCE(?2, is_favorite),
                 updated_at = ?3
             WHERE id = ?4",
            params![normalized_rating, normalized_is_favorite, updated_at, input.item_id],
        )
        .map_err(|err| format!("failed to update item preferences: {}", err))?;

    if affected_rows == 0 {
        return Err("item not found while updating preferences".to_string());
    }

    Ok(updated_at)
}

#[tauri::command]
fn update_item_bookmark_metadata(input: UpdateItemBookmarkMetadataInput) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let updated_at = Utc::now().timestamp_millis();

    let normalized_url = match normalize_optional_trimmed_string(input.url) {
        Some(value) => Some(normalize_bookmark_url_input(&value)?.as_str().to_string()),
        None => None,
    };
    let normalized_title = normalize_optional_trimmed_string(input.title);
    let normalized_filename = normalize_optional_trimmed_string(input.filename);
    let normalized_favicon_path = normalize_optional_trimmed_string(input.favicon_path);
    let normalized_meta_status = normalize_meta_status(&input.meta_status);

    let affected_rows = connection
        .execute(
            "UPDATE items
             SET url = COALESCE(?1, url),
                 title = COALESCE(?2, title),
                 filename = COALESCE(?3, filename),
                 favicon_path = COALESCE(?4, favicon_path),
                 meta_status = ?5,
                 updated_at = ?6
             WHERE id = ?7 AND type = 'bookmark'",
            params![
                normalized_url,
                normalized_title,
                normalized_filename,
                normalized_favicon_path,
                normalized_meta_status,
                updated_at,
                input.item_id
            ],
        )
        .map_err(|err| format!("failed to update bookmark metadata: {}", err))?;

    if affected_rows == 0 {
        return Err("bookmark item not found while updating metadata".to_string());
    }

    Ok(updated_at)
}

#[tauri::command]
fn update_item_media_state(input: UpdateItemMediaStateInput) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let updated_at = Utc::now().timestamp_millis();
    let normalized_thumb_status = input
        .thumb_status
        .as_deref()
        .map(normalize_thumb_status)
        .unwrap_or_else(|| DEFAULT_THUMB_STATUS.to_string());

    let affected_rows = connection
        .execute(
            "UPDATE items
             SET width = COALESCE(?1, width),
                 height = COALESCE(?2, height),
                 thumb_status = COALESCE(?3, thumb_status),
                 updated_at = ?4
             WHERE id = ?5",
            params![
                input.width,
                input.height,
                input.thumb_status.map(|_| normalized_thumb_status),
                updated_at,
                input.item_id
            ],
        )
        .map_err(|err| format!("failed to update item media state: {}", err))?;

    if affected_rows == 0 {
        return Err("item not found while updating media state".to_string());
    }

    Ok(updated_at)
}

#[tauri::command]
async fn fetch_bookmark_metadata(url: String) -> Result<FetchBookmarkMetadataResult, String> {
    let normalized_url = normalize_bookmark_url_input(&url)?;
    let client = build_bookmark_http_client()?;

    let (final_url, html_opt) = match fetch_bookmark_page_html(&client, &normalized_url).await {
        Ok((final_url, html_opt)) => (final_url, html_opt),
        Err(error) => {
            eprintln!(
                "bookmark html fetch failed for {}: {}. Falling back to favicon-only resolution.",
                normalized_url, error
            );
            (normalized_url.clone(), None)
        }
    };

    let (title, favicon_candidates) = match html_opt.as_deref() {
        Some(html) => html_title_and_favicon_candidates(html, &final_url),
        None => {
            let mut candidates = Vec::new();
            if let Ok(fallback) = final_url.join("/favicon.ico") {
                if is_http_or_https_url(&fallback) {
                    candidates.push(fallback);
                }
            }
            (None, candidates)
        }
    };

    let mut favicon_path: Option<String> = None;
    let mut favicon_ext: Option<String> = None;
    let mut favicon_url_candidate: Option<String> = None;

    for candidate in favicon_candidates {
        match download_favicon_candidate(&client, &candidate).await {
            Ok((bytes, ext)) => match store_favicon_bytes(&bytes, &ext) {
                Ok(stored_path) => {
                    favicon_path = Some(path_to_string(&stored_path)?);
                    favicon_ext = Some(ext);
                    favicon_url_candidate = Some(candidate.as_str().to_string());
                    break;
                }
                Err(error) => {
                    eprintln!("failed to store favicon from {}: {}", candidate, error);
                }
            },
            Err(error) => {
                eprintln!("favicon candidate failed {}: {}", candidate, error);
            }
        }
    }

    Ok(FetchBookmarkMetadataResult {
        final_url: final_url.as_str().to_string(),
        title,
        favicon_path,
        favicon_ext,
        favicon_url_candidate,
    })
}

#[tauri::command]
fn finalize_item_import(input: FinalizeItemImportInput) -> Result<i64, String> {
    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;

    let current_vault = transaction
        .query_row(
            "SELECT vault_key, vault_path FROM items WHERE id = ?1",
            params![&input.item_id],
            |row| {
                let vault_key: String = row.get(0)?;
                let vault_path: String = row.get(1)?;
                Ok((vault_key, vault_path))
            },
        )
        .optional()
        .map_err(|err| format!("failed to read current item import state: {}", err))?
        .ok_or_else(|| "item not found while finalizing import".to_string())?;

    let next_vault_key = input.vault_key.trim().to_string();
    let next_vault_path = input.vault_path.trim().to_string();
    if next_vault_key.is_empty() || next_vault_path.is_empty() {
        return Err("cannot finalize import without a vault key/path".to_string());
    }

    let (current_vault_key, _current_vault_path) = current_vault;
    if !current_vault_key.trim().is_empty() && current_vault_key != next_vault_key {
        let _ = decrement_vault_ref_in_tx(&transaction, &current_vault_key, 1)?;
    }
    if current_vault_key != next_vault_key {
        increment_vault_ref_in_tx(&transaction, &next_vault_key, &next_vault_path)?;
    }

    let updated_at = Utc::now().timestamp_millis();
    let affected_rows = transaction
        .execute(
            "UPDATE items
             SET title = ?1,
                 filename = ?2,
                 vault_key = ?3,
                 vault_path = ?4,
                 width = ?5,
                 height = ?6,
                 thumb_status = ?7,
                 import_status = 'ready',
                 updated_at = ?8
             WHERE id = ?9",
            params![
                input.title,
                input.filename,
                next_vault_key,
                next_vault_path,
                input.width,
                input.height,
                normalize_thumb_status(&input.thumb_status),
                updated_at,
                input.item_id
            ],
        )
        .map_err(|err| format!("failed to finalize imported item row: {}", err))?;

    if affected_rows == 0 {
        return Err("item not found while finalizing import".to_string());
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit finalize import transaction: {}", err))?;

    Ok(updated_at)
}

#[tauri::command]
fn mark_item_import_error(input: MarkItemImportErrorInput) -> Result<i64, String> {
    initialize_db()?;
    let connection = open_db_connection()?;
    let updated_at = Utc::now().timestamp_millis();
    let affected_rows = connection
        .execute(
            "UPDATE items
             SET import_status = 'error',
                 thumb_status = CASE
                     WHEN type = 'image' THEN 'error'
                     ELSE thumb_status
                 END,
                 updated_at = ?1
             WHERE id = ?2",
            params![updated_at, input.item_id],
        )
        .map_err(|err| format!("failed to mark item import error: {}", err))?;

    if affected_rows == 0 {
        return Err("item not found while marking import error".to_string());
    }

    Ok(updated_at)
}

#[tauri::command]
fn ensure_storage_root() -> Result<String, String> {
    let root = ensure_storage_root_internal()?;
    let _ = ensure_current_month_directory(&root)?;
    path_to_string(&root)
}

#[tauri::command]
fn ensure_thumbs_root() -> Result<String, String> {
    let root = ensure_thumbs_root_internal()?;
    path_to_string(&root)
}

#[tauri::command]
fn file_exists(path: String) -> Result<bool, String> {
    let target = PathBuf::from(path);
    Ok(target.exists() && target.is_file())
}

#[tauri::command]
fn compute_sha256(file_path: String) -> Result<String, String> {
    let path = PathBuf::from(file_path);
    if !path.exists() {
        return Err(format!("file does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("path is not a file: {}", path.display()));
    }
    sha256_for_file(&path)
}

#[tauri::command]
async fn process_import_path_job(
    original_path: String,
    generate_thumb: Option<bool>,
) -> Result<ImportPipelineResult, String> {
    let path = PathBuf::from(&original_path);
    if !path.exists() {
        return Err(format!("file does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("path is not a file: {}", path.display()));
    }
    let original_filename = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("imported-file")
        .to_string();
    let should_generate_thumb = generate_thumb.unwrap_or(true);

    tauri::async_runtime::spawn_blocking(move || {
        run_import_pipeline_internal(
            Some(path),
            None,
            None,
            Some(original_filename),
            should_generate_thumb,
        )
    })
    .await
    .map_err(|err| format!("import path job thread join failed: {}", err))?
}

#[tauri::command]
async fn process_import_bytes_job(
    bytes: Vec<u8>,
    original_filename: Option<String>,
    ext: Option<String>,
    generate_thumb: Option<bool>,
) -> Result<ImportPipelineResult, String> {
    if bytes.is_empty() {
        return Err("cannot import empty byte buffer".to_string());
    }
    let should_generate_thumb = generate_thumb.unwrap_or(true);
    let fallback_filename = original_filename.clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_import_pipeline_internal(
            None,
            Some(bytes),
            ext,
            fallback_filename,
            should_generate_thumb,
        )
    })
    .await
    .map_err(|err| format!("import bytes job thread join failed: {}", err))?
}

#[tauri::command]
fn import_to_vault(original_path: String) -> Result<VaultImportResult, String> {
    let path = PathBuf::from(&original_path);
    if !path.exists() {
        return Err(format!("file does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("path is not a file: {}", path.display()));
    }

    let original_filename = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("imported-file")
        .to_string();

    import_with_metadata(Some(&path), None, None, Some(&original_filename))
}

#[tauri::command]
fn import_bytes_to_vault(
    bytes: Vec<u8>,
    original_filename: Option<String>,
    ext: Option<String>,
) -> Result<VaultImportResult, String> {
    if bytes.is_empty() {
        return Err("cannot import empty byte buffer".to_string());
    }

    import_with_metadata(
        None,
        Some(&bytes),
        ext.as_deref(),
        original_filename.as_deref(),
    )
}

#[tauri::command]
async fn generate_thumbnail(
    input_path: String,
    output_path: String,
    max_size: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(input_path);
        let destination = PathBuf::from(output_path);
        let bounded_max = max_size.unwrap_or(IMPORT_THUMB_MAX_SIZE).max(1);
        generate_thumbnail_internal(&source, &destination, bounded_max)?;
        path_to_string(&destination)
    })
    .await
    .map_err(|err| format!("generate thumbnail thread join failed: {}", err))?
}

#[tauri::command]
fn remove_from_vault(sha256: String, ext: String) -> Result<bool, String> {
    let root = ensure_storage_root_internal()?;
    let vault_filename = build_vault_filename(&sha256, &ext);
    let existing_paths = find_vault_files(&root, &vault_filename)?;
    if existing_paths.is_empty() {
        Ok(false)
    } else {
        for path in existing_paths {
            fs::remove_file(&path).map_err(|err| {
                format!("failed to remove vault file {}: {}", path.display(), err)
            })?;
        }
        Ok(true)
    }
}

#[tauri::command]
fn pick_files() -> Result<Vec<String>, String> {
    let selected = FileDialog::new().pick_files();
    let mut paths = Vec::new();

    if let Some(files) = selected {
        for path in files {
            paths.push(path_to_string(&path)?);
        }
    }

    Ok(paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            init_db,
            load_app_state,
            create_collection,
            get_all_collections,
            update_collection_name,
            delete_collection,
            create_tag,
            get_all_tags,
            reorder_tags,
            update_tag_name,
            update_tag_color,
            duplicate_tag,
            delete_tag,
            insert_item,
            insert_items_batch,
            delete_items,
            delete_items_with_cleanup,
            move_collection_item_memberships,
            add_items_to_collection,
            reorder_collection_items,
            update_items_collection,
            update_item_tags,
            update_item_description,
            load_item_overlay,
            save_item_overlay,
            update_item_preferences,
            update_item_bookmark_metadata,
            update_item_media_state,
            finalize_item_import,
            mark_item_import_error,
            ensure_storage_root,
            ensure_thumbs_root,
            file_exists,
            fetch_bookmark_metadata,
            compute_sha256,
            process_import_path_job,
            process_import_bytes_job,
            import_to_vault,
            import_bytes_to_vault,
            generate_thumbnail,
            remove_from_vault,
            pick_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
