//! Unified `.cheers-extension` package validation and persistence.

use std::{
    collections::{BTreeMap, HashSet},
    io::{Cursor, Read},
    path::{Component, Path},
    sync::LazyLock,
};

use chrono::NaiveTime;
use regex::Regex;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use zip::ZipArchive;

pub const MEDIA_TYPE: &str = "application/vnd.cheers.extension+zip";
pub const MAX_COMPRESSED_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_EXPANDED_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FILES: usize = 128;
pub const MAX_SEED_BYTES: usize = 256 * 1024;
pub const MAX_AUTOMATION_TITLE_CHARS: usize = 120;
pub const MAX_AUTOMATION_MESSAGE_CHARS: usize = 4_000;
pub const MIN_INTERVAL_MINUTES: i32 = 5;
pub const MAX_INTERVAL_MINUTES: i32 = 10_080;
pub const MAX_TIMEZONE_CHARS: usize = 64;
pub const ID_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]{0,63}$";
pub const MAX_PANELS: usize = 32;
/// Source kinds a package may declare. `workspace` names paths on a bot's own machine,
/// authorized per-bot against the session-workdir root-set rather than by channel-role;
/// `rest` is an arbitrary endpoint rather than a vocabulary. Both stay first-party, so
/// neither appears here. Mirrors PLUGGABLE_SOURCE_KINDS on the client.
pub const PANEL_SOURCE_KINDS: &[&str] = &["resource", "fs"];
pub const CHANNEL_RESOURCES: &[&str] = &[
    "channel.info",
    "channel.members",
    "channel.messages",
    "channel.activity.read",
    "channel.messages.index",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionManifest {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub contributes: Contributions,
    #[serde(default)]
    pub permissions: Permissions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributions {
    #[serde(default)]
    pub scenes: Vec<SceneContribution>,
    #[serde(default)]
    pub renderers: Vec<RendererContribution>,
    #[serde(default)]
    pub automations: Vec<AutomationContribution>,
    #[serde(default)]
    pub panels: Vec<PanelContribution>,
}

/// A declarative board: where its data lives plus which compiled view renders it.
/// Carries no code — the view resolves to a built-in, or (personal scope only) to a
/// renderer the same package contributes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelContribution {
    pub id: String,
    pub title: String,
    pub source: PanelSource,
    pub view: String,
}

/// Only the kinds in PANEL_SOURCE_KINDS are variants here, so serde rejects a
/// `workspace` or `rest` source before any validation runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum PanelSource {
    Resource { verb: String },
    Fs { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneContribution {
    pub id: String,
    pub title: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererContribution {
    pub id: String,
    pub title: String,
    pub entry: String,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default, rename = "match")]
    pub matches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub message: String,
    pub default_schedule: AutomationSchedule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationSchedule {
    pub kind: String,
    #[serde(default)]
    pub every_minutes: Option<i32>,
    #[serde(default)]
    pub local_time: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    #[serde(default, rename = "file.write")]
    pub file_write: bool,
    #[serde(default, rename = "channel.resources")]
    pub channel_resources: Vec<String>,
    #[serde(default, rename = "navigation.open")]
    pub navigation_open: bool,
    #[serde(default, rename = "composer.prefill")]
    pub composer_prefill: bool,
    #[serde(default, rename = "automation.manage")]
    pub automation_manage: bool,
    #[serde(default)]
    pub network: Option<NetworkPermission>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPermission {
    Unrestricted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneDefinition {
    pub items: Vec<SceneItem>,
    #[serde(default)]
    pub seed: Vec<SeedReference>,
    #[serde(default)]
    pub pin: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneItem {
    pub id: String,
    pub title: String,
    pub file: String,
    #[serde(default = "auto_renderer")]
    pub renderer: String,
    #[serde(default)]
    pub config: Option<Value>,
}

fn auto_renderer() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedReference {
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedScene {
    pub id: String,
    pub title: String,
    pub items: Vec<SceneItem>,
    pub seed: Vec<SeedFile>,
    pub pin: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ValidatedPackage {
    pub manifest: ExtensionManifest,
    pub scenes: BTreeMap<String, ResolvedScene>,
    pub raw: Vec<u8>,
    pub sha256: String,
}

pub fn validate_package(raw: &[u8], allow_code: bool) -> Result<ValidatedPackage, String> {
    if raw.len() > MAX_COMPRESSED_BYTES {
        return Err("extension exceeds the 4 MiB compressed limit".into());
    }
    inspect_central_directory(raw)?;
    let mut archive = ZipArchive::new(Cursor::new(raw))
        .map_err(|e| format!("extension is not a valid ZIP: {e}"))?;
    if archive.len() > MAX_FILES {
        return Err(format!("extension contains more than {MAX_FILES} files"));
    }

    let mut files = BTreeMap::<String, Vec<u8>>::new();
    let mut expanded = 0usize;
    let mut actual_expanded = 0usize;
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("cannot read ZIP entry: {e}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        validate_archive_path(&name)?;
        if !seen.insert(name.clone()) {
            return Err(format!("duplicate ZIP path `{name}`"));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("symbolic link `{name}` is not allowed"));
        }
        validate_known_path(&name)?;
        let announced = usize::try_from(entry.size()).unwrap_or(usize::MAX);
        expanded = expanded
            .checked_add(announced)
            .ok_or_else(|| "extension expanded size overflow".to_string())?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err("extension exceeds the 8 MiB expanded limit".into());
        }
        let mut bytes = Vec::with_capacity(announced.min(MAX_EXPANDED_BYTES));
        let read_limit = MAX_EXPANDED_BYTES.saturating_sub(actual_expanded) + 1;
        entry
            .take(read_limit as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| {
                format!("cannot extract `{name}` (encrypted ZIPs are unsupported): {e}")
            })?;
        actual_expanded += bytes.len();
        if actual_expanded > MAX_EXPANDED_BYTES {
            return Err("extension exceeds the 8 MiB expanded limit".into());
        }
        // Checked after the cap so a genuine overflow keeps its own message.
        //
        // The declared size is whatever the archive's author put in the central
        // directory; this is the only place it meets the stream it describes.
        // Letting them differ is a parser differential rather than a size
        // problem: this reads the real stream, while the client's `fflate`
        // allocates the declared size and silently discards the rest, so one
        // package could validate here and run as something else there. The two
        // must agree or neither may interpret it.
        if bytes.len() != announced {
            return Err(format!(
                "`{name}` does not match its declared size ({announced} declared, {} actual)",
                bytes.len()
            ));
        }
        if name.starts_with("seed/") && bytes.len() > MAX_SEED_BYTES {
            return Err(format!("seed file `{name}` exceeds 256 KiB"));
        }
        files.insert(name, bytes);
    }
    validate_files(files, raw.to_vec(), allow_code)
}

fn inspect_central_directory(raw: &[u8]) -> Result<(), String> {
    let u16_at = |offset: usize| -> Result<u16, String> {
        let bytes: [u8; 2] = raw
            .get(offset..offset + 2)
            .ok_or_else(|| "truncated ZIP directory".to_string())?
            .try_into()
            .expect("slice length checked");
        Ok(u16::from_le_bytes(bytes))
    };
    let u32_at = |offset: usize| -> Result<u32, String> {
        let bytes: [u8; 4] = raw
            .get(offset..offset + 4)
            .ok_or_else(|| "truncated ZIP directory".to_string())?
            .try_into()
            .expect("slice length checked");
        Ok(u32::from_le_bytes(bytes))
    };
    let search_start = raw.len().saturating_sub(65_557);
    let eocd = (search_start..raw.len().saturating_sub(3))
        .rev()
        .find(|offset| raw.get(*offset..*offset + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]))
        .ok_or_else(|| "extension has no ZIP end-of-directory record".to_string())?;
    let count = usize::from(u16_at(eocd + 10)?);
    if count > MAX_FILES {
        return Err(format!("extension contains more than {MAX_FILES} files"));
    }
    let mut offset = usize::try_from(u32_at(eocd + 16)?).unwrap_or(usize::MAX);
    let mut expanded = 0usize;
    let mut names = HashSet::new();
    for _ in 0..count {
        if u32_at(offset)? != 0x0201_4b50 {
            return Err("invalid ZIP central directory".into());
        }
        if u16_at(offset + 8)? & 1 != 0 {
            return Err("encrypted ZIP entries are unsupported".into());
        }
        expanded = expanded
            .checked_add(usize::try_from(u32_at(offset + 24)?).unwrap_or(usize::MAX))
            .ok_or_else(|| "extension expanded size overflow".to_string())?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err("extension exceeds the 8 MiB expanded limit".into());
        }
        let name_len = usize::from(u16_at(offset + 28)?);
        let extra_len = usize::from(u16_at(offset + 30)?);
        let comment_len = usize::from(u16_at(offset + 32)?);
        let external_attributes = u32_at(offset + 38)?;
        let name_start = offset + 46;
        let name = std::str::from_utf8(
            raw.get(name_start..name_start + name_len)
                .ok_or_else(|| "truncated ZIP filename".to_string())?,
        )
        .map_err(|_| "ZIP paths must be UTF-8".to_string())?;
        validate_archive_path(name)?;
        validate_known_path(name)?;
        if !names.insert(name.to_string()) {
            return Err(format!("duplicate ZIP path `{name}`"));
        }
        if (external_attributes >> 16) & 0o170000 == 0o120000 {
            return Err(format!("symbolic link `{name}` is not allowed"));
        }
        offset = name_start
            .checked_add(name_len + extra_len + comment_len)
            .ok_or_else(|| "ZIP directory offset overflow".to_string())?;
    }
    Ok(())
}

pub fn validate_files(
    files: BTreeMap<String, Vec<u8>>,
    raw: Vec<u8>,
    allow_code: bool,
) -> Result<ValidatedPackage, String> {
    let manifest_bytes = files
        .get("manifest.json")
        .ok_or("extension is missing manifest.json")?;
    let manifest: ExtensionManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|e| format!("invalid manifest.json: {e}"))?;
    validate_manifest(&manifest, allow_code)?;
    for renderer in &manifest.contributes.renderers {
        if !files.contains_key(&renderer.entry) {
            return Err(format!("renderer `{}` entry is missing", renderer.id));
        }
        if renderer
            .style
            .as_ref()
            .is_some_and(|style| !files.contains_key(style))
        {
            return Err(format!("renderer `{}` style is missing", renderer.id));
        }
    }

    let mut scenes = BTreeMap::new();
    for contribution in &manifest.contributes.scenes {
        let bytes = files
            .get(&contribution.definition)
            .ok_or_else(|| format!("scene `{}` definition is missing", contribution.id))?;
        let definition: SceneDefinition = serde_json::from_slice(bytes)
            .map_err(|e| format!("invalid scene `{}`: {e}", contribution.id))?;
        let mut seed = Vec::new();
        let mut seed_paths = HashSet::new();
        for reference in &definition.seed {
            validate_workspace_path(&reference.path)?;
            if !seed_paths.insert(reference.path.as_str()) {
                return Err(format!("duplicate seed path `{}`", reference.path));
            }
            let expected_prefix = format!("seed/{}/", contribution.id);
            if !reference.source.starts_with(&expected_prefix) {
                return Err(format!(
                    "scene `{}` seed source must be under `{expected_prefix}`",
                    contribution.id
                ));
            }
            let content = files
                .get(&reference.source)
                .ok_or_else(|| format!("seed source `{}` is missing", reference.source))?;
            if content.len() > MAX_SEED_BYTES {
                return Err(format!("seed file `{}` exceeds 256 KiB", reference.source));
            }
            seed.push(SeedFile {
                path: reference.path.clone(),
                content: String::from_utf8(content.clone())
                    .map_err(|_| format!("seed source `{}` must be UTF-8", reference.source))?,
            });
        }
        let mut item_ids = HashSet::new();
        for item in &definition.items {
            validate_id("scene item", &item.id)?;
            if !item_ids.insert(item.id.as_str()) {
                return Err(format!("duplicate scene item id `{}`", item.id));
            }
            if item.title.trim().is_empty() {
                return Err(format!("scene item `{}` title is required", item.id));
            }
            validate_workspace_path(&item.file)?;
            validate_renderer_reference(&item.renderer, allow_code, &manifest)?;
        }
        for path in &definition.pin {
            validate_workspace_path(path)?;
        }
        scenes.insert(
            contribution.id.clone(),
            ResolvedScene {
                id: contribution.id.clone(),
                title: contribution.title.clone(),
                items: definition.items,
                seed,
                pin: definition.pin,
            },
        );
    }
    Ok(ValidatedPackage {
        manifest,
        scenes,
        sha256: hex::encode(Sha256::digest(&raw)),
        raw,
    })
}

fn validate_manifest(manifest: &ExtensionManifest, allow_code: bool) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("manifest schemaVersion must be 1".into());
    }
    validate_id("extension", &manifest.id)?;
    Version::parse(&manifest.version).map_err(|e| format!("version must be SemVer: {e}"))?;
    if manifest.title.trim().is_empty() {
        return Err("manifest title is required".into());
    }
    let mut ids = HashSet::new();
    for scene in &manifest.contributes.scenes {
        validate_id("scene", &scene.id)?;
        if scene.title.trim().is_empty() {
            return Err(format!("scene `{}` title is required", scene.id));
        }
        if !ids.insert(scene.id.as_str()) {
            return Err(format!("duplicate scene id `{}`", scene.id));
        }
        if scene.definition != format!("scenes/{}.json", scene.id) {
            return Err(format!(
                "scene `{}` has a non-canonical definition path",
                scene.id
            ));
        }
    }
    let mut renderer_ids = HashSet::new();
    for renderer in &manifest.contributes.renderers {
        validate_id("renderer", &renderer.id)?;
        if renderer.title.trim().is_empty() {
            return Err(format!("renderer `{}` title is required", renderer.id));
        }
        if !renderer_ids.insert(renderer.id.as_str()) {
            return Err(format!("duplicate renderer id `{}`", renderer.id));
        }
        if renderer.entry != format!("renderers/{}.js", renderer.id) {
            return Err(format!(
                "renderer `{}` has a non-canonical entry path",
                renderer.id
            ));
        }
        if renderer
            .style
            .as_deref()
            .is_some_and(|path| path != format!("renderers/{}.css", renderer.id))
        {
            return Err(format!(
                "renderer `{}` has a non-canonical style path",
                renderer.id
            ));
        }
        if renderer.matches.iter().any(|glob| glob.trim().is_empty()) {
            return Err(format!(
                "renderer `{}` contains an empty match rule",
                renderer.id
            ));
        }
    }
    let mut automation_ids = HashSet::new();
    for automation in &manifest.contributes.automations {
        validate_id("automation", &automation.id)?;
        if !automation_ids.insert(automation.id.as_str()) {
            return Err(format!("duplicate automation id `{}`", automation.id));
        }
        if automation.title.trim().is_empty()
            || automation.title.chars().count() > MAX_AUTOMATION_TITLE_CHARS
        {
            return Err(format!(
                "automation `{}` title must be between 1 and {MAX_AUTOMATION_TITLE_CHARS} characters",
                automation.id
            ));
        }
        if automation.message.trim().is_empty()
            || automation.message.chars().count() > MAX_AUTOMATION_MESSAGE_CHARS
        {
            return Err(format!(
                "automation `{}` message must be between 1 and {MAX_AUTOMATION_MESSAGE_CHARS} characters",
                automation.id
            ));
        }
        match automation.default_schedule.kind.as_str() {
            "interval"
                if automation.default_schedule.local_time.is_none()
                    && automation.default_schedule.timezone.is_none()
                    && automation
                        .default_schedule
                        .every_minutes
                        .is_some_and(|minutes| {
                            (MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&minutes)
                        }) => {}
            "daily"
                if automation.default_schedule.every_minutes.is_none()
                    && automation
                        .default_schedule
                        .local_time
                        .as_deref()
                        .is_some_and(|time| NaiveTime::parse_from_str(time, "%H:%M").is_ok())
                    && automation
                        .default_schedule
                        .timezone
                        .as_deref()
                        .is_none_or(|zone| {
                            !zone.trim().is_empty() && zone.chars().count() <= MAX_TIMEZONE_CHARS
                        }) => {}
            _ => {
                return Err(format!(
                    "automation `{}` has an invalid defaultSchedule",
                    automation.id
                ));
            }
        }
    }
    if manifest.contributes.panels.len() > MAX_PANELS {
        return Err(format!("a package may contribute at most {MAX_PANELS} panels"));
    }
    let mut panel_ids = HashSet::new();
    for panel in &manifest.contributes.panels {
        validate_id("panel", &panel.id)?;
        if panel.title.trim().is_empty() {
            return Err(format!("panel `{}` title is required", panel.id));
        }
        if !panel_ids.insert(panel.id.as_str()) {
            return Err(format!("duplicate panel id `{}`", panel.id));
        }
        match &panel.source {
            // A panel's verb comes from the SAME fixed list as channel.resources.
            // Declaring a source must never widen what a package can read.
            PanelSource::Resource { verb } => {
                if !CHANNEL_RESOURCES.contains(&verb.as_str()) {
                    return Err(format!(
                        "panel `{}` reads `{verb}`, which is not an allowed channel resource",
                        panel.id
                    ));
                }
            }
            PanelSource::Fs { path } => validate_workspace_path(path)?,
        }
        // A `self:` view is code and follows the renderer scope split.
        validate_renderer_reference(&panel.view, allow_code, manifest)?;
    }
    if !allow_code
        && (!manifest.contributes.renderers.is_empty()
            || manifest.permissions.file_write
            || !manifest.permissions.channel_resources.is_empty()
            || manifest.permissions.navigation_open
            || manifest.permissions.composer_prefill
            || manifest.permissions.automation_manage
            || manifest.permissions.network.is_some())
    {
        return Err(
            "global extensions must be declarative and cannot request code permissions".into(),
        );
    }
    for resource in &manifest.permissions.channel_resources {
        if !CHANNEL_RESOURCES.contains(&resource.as_str()) {
            return Err(format!("channel resource `{resource}` is not allowed"));
        }
    }
    Ok(())
}

fn validate_id(kind: &str, id: &str) -> Result<(), String> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(ID_PATTERN).expect("static id regex"));
    if ID.is_match(id) {
        Ok(())
    } else {
        Err(format!("invalid {kind} id `{id}`"))
    }
}

fn validate_archive_path(path: &str) -> Result<(), String> {
    if path.contains('\\') || Path::new(path).is_absolute() {
        return Err(format!("unsafe ZIP path `{path}`"));
    }
    if Path::new(path).components().any(|part| {
        matches!(
            part,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("unsafe ZIP path `{path}`"));
    }
    Ok(())
}

fn validate_known_path(path: &str) -> Result<(), String> {
    let known = path == "manifest.json"
        || (path.starts_with("scenes/") && path.ends_with(".json"))
        || path.starts_with("seed/")
        || (path.starts_with("renderers/") && (path.ends_with(".js") || path.ends_with(".css")));
    if known {
        Ok(())
    } else {
        Err(format!(
            "unknown or executable file `{path}` is not allowed"
        ))
    }
}

fn validate_workspace_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains("..") {
        return Err(format!("unsafe workspace path `{path}`"));
    }
    Ok(())
}

fn validate_renderer_reference(
    renderer: &str,
    allow_code: bool,
    manifest: &ExtensionManifest,
) -> Result<(), String> {
    if renderer == "auto" || renderer.starts_with("builtin:") {
        return Ok(());
    }
    if allow_code {
        if let Some(id) = renderer.strip_prefix("self:") {
            if manifest
                .contributes
                .renderers
                .iter()
                .any(|candidate| candidate.id == id)
            {
                return Ok(());
            }
            return Err(format!("unknown self renderer `{id}`"));
        }
    }
    Err(format!("unsupported renderer reference `{renderer}`"))
}

fn stored_manifest(package: &ValidatedPackage) -> Value {
    json!({
        "manifest": package.manifest,
        "scenes": package.scenes,
    })
}

pub async fn list(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
            'id', extension_id, 'version', version, 'title', title,
            'description', description, 'sha256', sha256, 'origin', origin,
            'scenes', COALESCE(manifest->'manifest'->'contributes'->'scenes', '[]'::jsonb),
            'renderers', COALESCE(manifest->'manifest'->'contributes'->'renderers', '[]'::jsonb),
            'automations', COALESCE(manifest->'manifest'->'contributes'->'automations', '[]'::jsonb),
            'panels', COALESCE(manifest->'manifest'->'contributes'->'panels', '[]'::jsonb),
            'permissions', COALESCE(manifest->'manifest'->'permissions', '{}'::jsonb),
            'updatedAt', updated_at
         )
         FROM workbench_extensions ORDER BY origin DESC, title ASC",
    )
    .fetch_all(db)
    .await
}

pub async fn get_scene(
    db: &PgPool,
    extension_id: &str,
    scene_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT manifest->'scenes'->$2 FROM workbench_extensions WHERE extension_id = $1",
    )
    .bind(extension_id)
    .bind(scene_id)
    .fetch_optional(db)
    .await
    .map(Option::flatten)
}

pub async fn install(
    db: &PgPool,
    package: &ValidatedPackage,
    installed_by: &str,
    origin: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO workbench_extensions
         (extension_id, version, title, description, manifest, package, sha256, origin, installed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (extension_id) DO UPDATE SET
           version=$2, title=$3, description=$4, manifest=$5, package=$6,
           sha256=$7, origin=$8, installed_by=$9, updated_at=NOW()",
    )
    .bind(&package.manifest.id)
    .bind(&package.manifest.version)
    .bind(&package.manifest.title)
    .bind(&package.manifest.description)
    .bind(stored_manifest(package))
    .bind(&package.raw)
    .bind(&package.sha256)
    .bind(origin)
    .bind(installed_by)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn origin(db: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT origin FROM workbench_extensions WHERE extension_id=$1")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn is_official_id(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workbench_official_extension_state WHERE extension_id=$1)",
    )
    .bind(id)
    .fetch_one(db)
    .await
}

pub async fn delete(db: &PgPool, id: &str) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("DELETE FROM workbench_extensions WHERE extension_id=$1")
            .bind(id)
            .execute(db)
            .await?
            .rows_affected(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn package(manifest: Value, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut output);
            let options = SimpleFileOptions::default();
            writer.start_file("manifest.json", options).unwrap();
            writer.write_all(manifest.to_string().as_bytes()).unwrap();
            for (name, content) in extra {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content).unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    /// Rewrite one entry's declared uncompressed size in the central directory,
    /// leaving the deflate stream alone. This is the shape of a package two
    /// parsers read differently: the client's `fflate` believes the declaration,
    /// this validator reads the stream.
    fn understate_size(raw: &[u8], entry: &str, declared: u32) -> Vec<u8> {
        let mut bytes = raw.to_vec();
        let u16_at = |b: &[u8], at: usize| u16::from_le_bytes([b[at], b[at + 1]]) as usize;
        let eocd = (0..=bytes.len() - 22)
            .rev()
            .find(|&i| bytes[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
            .expect("EOCD");
        let count = u16_at(&bytes, eocd + 10);
        let mut offset =
            u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        for _ in 0..count {
            let name_length = u16_at(&bytes, offset + 28);
            let name = String::from_utf8(bytes[offset + 46..offset + 46 + name_length].to_vec())
                .expect("utf-8 name");
            if name == entry {
                bytes[offset + 24..offset + 28].copy_from_slice(&declared.to_le_bytes());
                return bytes;
            }
            offset = offset
                + 46
                + name_length
                + u16_at(&bytes, offset + 30)
                + u16_at(&bytes, offset + 32);
        }
        panic!("no entry {entry}");
    }

    fn manifest(renderers: Value) -> Value {
        json!({
            "schemaVersion": 1, "id": "example", "version": "1.0.0",
            "title": "Example", "description": "",
            "contributes": {"scenes": [], "renderers": renderers}, "permissions": {}
        })
    }

    /// Both parsers must reject a package whose central directory disagrees with
    /// its own stream. If only one does, the same bytes and the same sha256
    /// describe two different extensions — and a renderer truncated mid-file is
    /// still valid JavaScript, so nothing downstream would notice.
    #[test]
    fn rejects_a_package_whose_declared_entry_size_is_a_lie() {
        let body = "// ".to_string() + &"payload;".repeat(200);
        let raw = package(
            manifest(json!([])),
            &[("seed/main/notes.md", body.as_bytes())],
        );
        validate_package(&raw, true).expect("the honest package is fine");

        let understated = understate_size(&raw, "seed/main/notes.md", 20);
        let error = validate_package(&understated, true).expect_err("understated size");
        assert!(error.contains("declared size"), "{error}");

        let overstated = understate_size(&raw, "seed/main/notes.md", 4096);
        let error = validate_package(&overstated, true).expect_err("overstated size");
        assert!(error.contains("declared size"), "{error}");
    }

    #[test]
    fn validates_minimal_data_package() {
        let raw = package(manifest(json!([])), &[]);
        assert_eq!(
            validate_package(&raw, false).unwrap().manifest.id,
            "example"
        );
    }

    /// The `.cheers-extension` grammar is enforced twice — here and in
    /// `frontend/src/features/chat/workbench/extensions/package.ts` — because a
    /// personal-scope package is never uploaded, so the client cannot delegate
    /// validation to this module. `fixtures/workbench/limits.json` and `corpus.json`
    /// are the shared contract that keeps the two implementations one grammar: the
    /// numbers and the verdicts, asserted here against these constants and in
    /// `corpus.test.ts` against the client's.
    mod shared_contract {
        use super::*;

        const LIMITS: &str = include_str!("../../../fixtures/workbench/limits.json");
        const CORPUS: &str = include_str!("../../../fixtures/workbench/corpus.json");

        #[derive(Deserialize)]
        struct Case {
            name: String,
            why: String,
            global: String,
            personal: String,
            files: serde_json::Map<String, Value>,
        }

        /// A string is written verbatim, an object is serialized as JSON, and
        /// `$repeat` is that unit repeated `$count` times — the same three forms the
        /// client materializes.
        fn contents(spec: &Value) -> Vec<u8> {
            match spec {
                Value::String(text) => text.clone().into_bytes(),
                Value::Object(map) if map.contains_key("$repeat") => {
                    let unit = map["$repeat"].as_str().expect("$repeat is a string");
                    let count = map["$count"].as_u64().expect("$count is a number") as usize;
                    unit.repeat(count).into_bytes()
                }
                other => other.to_string().into_bytes(),
            }
        }

        fn archive(files: &serde_json::Map<String, Value>) -> Vec<u8> {
            let mut output = Cursor::new(Vec::new());
            {
                let mut writer = ZipWriter::new(&mut output);
                for (name, spec) in files {
                    writer
                        .start_file(name, SimpleFileOptions::default())
                        .unwrap();
                    writer.write_all(&contents(spec)).unwrap();
                }
                writer.finish().unwrap();
            }
            output.into_inner()
        }

        #[test]
        fn declares_the_limits_this_validator_enforces() {
            let limits: Value = serde_json::from_str(LIMITS).expect("limits.json parses");
            let number = |key: &str| limits[key].as_u64().expect(key) as usize;
            assert_eq!(limits["mediaType"].as_str(), Some(MEDIA_TYPE));
            assert_eq!(number("maxCompressedBytes"), MAX_COMPRESSED_BYTES);
            assert_eq!(number("maxExpandedBytes"), MAX_EXPANDED_BYTES);
            assert_eq!(number("maxFiles"), MAX_FILES);
            assert_eq!(number("maxSeedBytes"), MAX_SEED_BYTES);
            assert_eq!(
                number("maxAutomationTitleChars"),
                MAX_AUTOMATION_TITLE_CHARS
            );
            assert_eq!(
                number("maxAutomationMessageChars"),
                MAX_AUTOMATION_MESSAGE_CHARS
            );
            assert_eq!(number("minIntervalMinutes") as i32, MIN_INTERVAL_MINUTES);
            assert_eq!(number("maxIntervalMinutes") as i32, MAX_INTERVAL_MINUTES);
            assert_eq!(number("maxTimezoneChars"), MAX_TIMEZONE_CHARS);
            assert_eq!(limits["idPattern"].as_str(), Some(ID_PATTERN));
            let resources: Vec<&str> = limits["channelResources"]
                .as_array()
                .expect("channelResources")
                .iter()
                .map(|value| value.as_str().expect("resource is a string"))
                .collect();
            assert_eq!(resources, CHANNEL_RESOURCES);
            assert_eq!(number("maxPanelsPerExtension"), MAX_PANELS);
            let kinds: Vec<&str> = limits["panelSources"]
                .as_array()
                .expect("panelSources")
                .iter()
                .map(|value| value.as_str().expect("source kind is a string"))
                .collect();
            assert_eq!(kinds, PANEL_SOURCE_KINDS);
        }

        #[test]
        fn gives_every_corpus_package_the_verdict_it_declares() {
            let corpus: Value = serde_json::from_str(CORPUS).expect("corpus.json parses");
            let cases: Vec<Case> =
                serde_json::from_value(corpus["cases"].clone()).expect("corpus cases");
            assert!(!cases.is_empty(), "the corpus must have cases to run");

            let mut disagreements = Vec::new();
            for case in &cases {
                let raw = archive(&case.files);
                for (scope, expected) in [("global", &case.global), ("personal", &case.personal)] {
                    let outcome = validate_package(&raw, scope != "global");
                    let actual = if outcome.is_ok() { "accept" } else { "reject" };
                    if actual != expected {
                        disagreements.push(format!(
                            "{} at {scope} scope: contract says {expected}, this validator says {actual}{}\n    {}",
                            case.name,
                            outcome.err().map(|e| format!(" ({e})")).unwrap_or_default(),
                            case.why,
                        ));
                    }
                }
            }
            assert!(
                disagreements.is_empty(),
                "the shared contract and this validator disagree:\n  {}",
                disagreements.join("\n  ")
            );
        }
    }

    #[test]
    fn sdk_shared_fixture_obeys_server_contract() {
        let raw = include_bytes!("../../../fixtures/workbench/scene-renderer.cheers-extension");
        let parsed = validate_package(raw, true).expect("SDK fixture must pass server validation");
        assert_eq!(parsed.manifest.id, "example-notes");
        assert_eq!(parsed.manifest.contributes.scenes.len(), 1);
        assert_eq!(parsed.manifest.contributes.renderers.len(), 1);
        assert_eq!(parsed.manifest.contributes.automations.len(), 1);
    }

    #[test]
    fn official_research_planner_fixture_is_globally_declarative() {
        let raw = include_bytes!("../../../fixtures/workbench/research-planner.cheers-extension");
        let parsed = validate_package(raw, false).expect("official catalog data package validates");
        assert_eq!(parsed.manifest.id, "research-planner");
        assert_eq!(parsed.manifest.contributes.scenes.len(), 1);
        assert!(parsed.manifest.contributes.renderers.is_empty());
        assert_eq!(parsed.manifest.contributes.automations.len(), 1);
    }

    #[test]
    fn global_package_rejects_renderer_code() {
        let raw = package(
            manifest(json!([{"id":"demo","title":"Demo","entry":"renderers/demo.js","match":[]}])),
            &[("renderers/demo.js", b"console.log('no')")],
        );
        assert!(validate_package(&raw, false)
            .unwrap_err()
            .contains("declarative"));
        assert!(validate_package(&raw, true).is_ok());
    }

    #[test]
    fn global_package_rejects_automation_management_code_permission() {
        let mut value = manifest(json!([]));
        value["permissions"] = json!({"automation.manage": true});
        let raw = package(value, &[]);
        assert!(validate_package(&raw, false)
            .unwrap_err()
            .contains("declarative"));
        assert!(validate_package(&raw, true).is_ok());
    }

    #[test]
    fn rejects_parent_traversal() {
        let raw = package(manifest(json!([])), &[("seed/demo/../../secret", b"x")]);
        assert!(validate_package(&raw, false)
            .unwrap_err()
            .contains("unsafe ZIP path"));
    }

    #[test]
    fn rejects_duplicate_paths() {
        let mut raw = package(
            manifest(json!([])),
            &[("renderers/a.js", b"a"), ("renderers/b.js", b"b")],
        );
        for index in 0..raw.len().saturating_sub("renderers/b.js".len()) {
            if &raw[index..index + "renderers/b.js".len()] == b"renderers/b.js" {
                raw[index..index + "renderers/a.js".len()].copy_from_slice(b"renderers/a.js");
            }
        }
        assert!(validate_package(&raw, false)
            .unwrap_err()
            .contains("duplicate"));
    }

    #[test]
    fn rejects_compression_bomb_by_declared_expanded_size() {
        let content = vec![0; MAX_EXPANDED_BYTES + 1];
        let raw = package(
            manifest(json!([])),
            &[("renderers/large.js", content.as_slice())],
        );
        assert!(raw.len() < MAX_COMPRESSED_BYTES);
        assert!(validate_package(&raw, true)
            .unwrap_err()
            .contains("expanded limit"));
    }

    #[test]
    fn rejects_non_semver_version() {
        let mut value = manifest(json!([]));
        value["version"] = json!(1);
        let raw = package(value, &[]);
        assert!(validate_package(&raw, false)
            .unwrap_err()
            .contains("invalid manifest.json"));
    }

    #[test]
    fn validates_declarative_automation() {
        let mut value = manifest(json!([]));
        value["contributes"]["automations"] = json!([{
            "id": "deadline-watch",
            "title": "Deadline watch",
            "message": "Review upcoming submission deadlines.",
            "defaultSchedule": { "kind": "interval", "everyMinutes": 1440 }
        }]);
        let raw = package(value, &[]);
        let parsed = validate_package(&raw, false).unwrap();
        assert_eq!(parsed.manifest.contributes.automations.len(), 1);
    }

    #[test]
    fn validates_daily_automation_template() {
        let mut value = manifest(json!([]));
        value["contributes"]["automations"] = json!([{
            "id": "morning-review",
            "title": "Morning review",
            "message": "Review today's deadlines.",
            "defaultSchedule": { "kind": "daily", "localTime": "09:00" }
        }]);
        let raw = package(value, &[]);
        assert!(validate_package(&raw, false).is_ok());
    }
}
