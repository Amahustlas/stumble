use chrono::{Datelike, Utc};
use image::{imageops::FilterType, GenericImageView, ImageReader};
use rfd::FileDialog;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

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
const DEFAULT_ROOT_COLLECTION_COLOR: &str = "#60a5fa";
const DEFAULT_THUMB_STATUS: &str = "pending";
const DEFAULT_IMPORT_STATUS: &str = "ready";
const IMPORT_THUMB_MAX_SIZE: u32 = 480;
const THUMB_WEBP_QUALITY: f32 = 60.0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbCollectionRow {
    id: String,
    parent_id: Option<String>,
    name: String,
    color: String,
    created_at: i64,
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
    description: Option<String>,
    created_at: i64,
    updated_at: i64,
    tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbAppState {
    collections: Vec<DbCollectionRow>,
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
    description: Option<String>,
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
                parent_id TEXT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                created_at INTEGER NOT NULL,
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
                description TEXT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL
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

            CREATE INDEX IF NOT EXISTS idx_vault_files_ref_count ON vault_files(ref_count);
            "#,
        )
        .map_err(|err| format!("failed to run sqlite migrations: {}", err))?;
    ensure_items_status_columns(connection)?;
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

fn ensure_default_root_collection(connection: &Connection) -> Result<(), String> {
    let collection_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))
        .map_err(|err| format!("failed to count collections: {}", err))?;

    if collection_count == 0 {
        let now = Utc::now().timestamp_millis();
        connection
            .execute(
                "INSERT INTO collections (id, parent_id, name, color, created_at) VALUES (?1, NULL, ?2, ?3, ?4)",
                params![
                    DEFAULT_ROOT_COLLECTION_ID,
                    DEFAULT_ROOT_COLLECTION_NAME,
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
            "SELECT id, parent_id, name, color, created_at
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
                color: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|err| format!("failed to query collections: {}", err))?;

    let mut collections = Vec::new();
    for row_result in collections_iter {
        collections
            .push(row_result.map_err(|err| format!("failed to read collection row: {}", err))?);
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
                i.description,
                i.created_at,
                i.updated_at,
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
            let tag_names: String = row.get(15)?;
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
                description: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                tags,
            })
        })
        .map_err(|err| format!("failed to query items: {}", err))?;

    let mut items = Vec::new();
    for row_result in items_iter {
        items.push(row_result.map_err(|err| format!("failed to read item row: {}", err))?);
    }

    Ok(DbAppState { collections, items })
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
        description,
        created_at,
        updated_at,
        tags,
    } = item;

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
                description,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                description,
                created_at,
                updated_at,
            ],
        )
        .map_err(|err| format!("failed to insert item row: {}", err))?;

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
        let tag_id = tag_name.to_ascii_lowercase();
        transaction
            .execute(
                "INSERT OR IGNORE INTO tags (id, name) VALUES (?1, ?2)",
                params![tag_id, tag_name],
            )
            .map_err(|err| format!("failed to upsert tag row: {}", err))?;

        transaction
            .execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)",
                params![&id, tag_id],
            )
            .map_err(|err| format!("failed to map item tag row: {}", err))?;
    }

    transaction
        .execute(
            "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM item_tags)",
            [],
        )
        .map_err(|err| format!("failed to prune unused tags: {}", err))?;

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

#[tauri::command]
fn delete_items_with_cleanup(item_ids: Vec<String>) -> Result<DeleteItemsResult, String> {
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
    let mut deleted_rows = 0usize;

    for item_id in &item_ids {
        let maybe_item_vault = transaction
            .query_row(
                "SELECT vault_key, vault_path FROM items WHERE id = ?1",
                params![item_id],
                |row| {
                    let vault_key: String = row.get(0)?;
                    let vault_path: String = row.get(1)?;
                    Ok((vault_key, vault_path))
                },
            )
            .optional()
            .map_err(|err| format!("failed to read item before delete: {}", err))?;

        if let Some((vault_key, vault_path)) = maybe_item_vault {
            if !vault_key.trim().is_empty() {
                let next_count = vault_counts_by_key.entry(vault_key.clone()).or_insert(0);
                *next_count += 1;
                vault_path_by_key.entry(vault_key).or_insert(vault_path);
            }
        }
    }

    for item_id in item_ids {
        let affected = transaction
            .execute("DELETE FROM items WHERE id = ?1", params![item_id])
            .map_err(|err| format!("failed to delete item row: {}", err))?;
        deleted_rows += affected;
    }

    transaction
        .execute(
            "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM item_tags)",
            [],
        )
        .map_err(|err| format!("failed to prune unused tags: {}", err))?;

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
fn delete_items(item_ids: Vec<String>) -> Result<usize, String> {
    let result = delete_items_with_cleanup(item_ids)?;
    Ok(result.deleted_rows)
}

#[tauri::command]
fn update_items_collection(
    item_ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<UpdateItemsCollectionResult, String> {
    if item_ids.is_empty() {
        return Ok(UpdateItemsCollectionResult {
            updated_rows: 0,
            updated_at: Utc::now().timestamp_millis(),
        });
    }

    initialize_db()?;
    let mut connection = open_db_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("failed to start sqlite transaction: {}", err))?;
    let updated_at = Utc::now().timestamp_millis();

    let mut updated_rows = 0usize;
    for item_id in item_ids {
        let affected = transaction
            .execute(
                "UPDATE items
                 SET collection_id = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![collection_id.as_deref(), updated_at, item_id],
            )
            .map_err(|err| format!("failed to update item collection: {}", err))?;
        updated_rows += affected;
    }

    transaction
        .commit()
        .map_err(|err| format!("failed to commit sqlite transaction: {}", err))?;

    Ok(UpdateItemsCollectionResult {
        updated_rows,
        updated_at,
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
            insert_item,
            insert_items_batch,
            delete_items,
            delete_items_with_cleanup,
            update_items_collection,
            update_item_description,
            update_item_media_state,
            finalize_item_import,
            mark_item_import_error,
            ensure_storage_root,
            ensure_thumbs_root,
            file_exists,
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
