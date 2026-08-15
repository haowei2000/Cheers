//! Personal `.cheers-extension` package store for this Mac.

use std::{
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_PACKAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalExtension {
    pub id: String,
    pub content_base64: String,
    pub sha256: String,
}

fn extensions_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    Ok(home.join(".cheers/extensions"))
}

fn guard_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        });
    if ok {
        Ok(())
    } else {
        Err(format!("invalid extension id {id:?}"))
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn list_in(dir: &Path) -> Result<Vec<PersonalExtension>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(format!("read {}: {error}", dir.display())),
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|_| {
                path.extension().and_then(|value| value.to_str()) == Some("cheers-extension")
            })
        else {
            continue;
        };
        if guard_id(id).is_err() {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.len() > MAX_PACKAGE_BYTES {
            continue;
        }
        result.push(PersonalExtension {
            id: id.to_string(),
            content_base64: STANDARD.encode(&bytes),
            sha256: sha256(&bytes),
        });
    }
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

fn read_package(path: &Path) -> Result<PersonalExtension, String> {
    if path.extension().and_then(|value| value.to_str()) != Some("cheers-extension") {
        return Err("development package must use .cheers-extension".into());
    }
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("extension path has no UTF-8 filename")?;
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err("extension exceeds 4 MiB".into());
    }
    Ok(PersonalExtension {
        id: id.to_string(),
        content_base64: STANDARD.encode(&bytes),
        sha256: sha256(&bytes),
    })
}

fn install_in(
    dir: &Path,
    id: &str,
    content_base64: &str,
    expected_sha256: &str,
) -> Result<(), String> {
    guard_id(id)?;
    let bytes = STANDARD
        .decode(content_base64)
        .map_err(|error| format!("invalid package base64: {error}"))?;
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err("extension exceeds 4 MiB".into());
    }
    let actual = sha256(&bytes);
    if actual != expected_sha256 {
        return Err("extension SHA-256 mismatch".into());
    }
    fs::create_dir_all(dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
    let target = dir.join(format!("{id}.cheers-extension"));
    let temporary = dir.join(format!(".{id}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, &target)
        .map_err(|error| format!("replace {}: {error}", target.display()))
}

fn remove_in(dir: &Path, id: &str) -> Result<(), String> {
    guard_id(id)?;
    match fs::remove_file(dir.join(format!("{id}.cheers-extension"))) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove extension: {error}")),
    }
}

#[tauri::command]
pub fn extensions_list() -> Result<Vec<PersonalExtension>, String> {
    list_in(&extensions_dir()?)
}

#[tauri::command]
pub fn extensions_install(
    id: String,
    content_base64: String,
    sha256: String,
) -> Result<(), String> {
    install_in(&extensions_dir()?, &id, &content_base64, &sha256)
}

#[tauri::command]
pub fn extensions_remove(id: String) -> Result<(), String> {
    remove_in(&extensions_dir()?, &id)
}

#[tauri::command]
pub fn extension_dev_read(path: String) -> Result<PersonalExtension, String> {
    read_package(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cheers-extensions-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn package_round_trip_is_binary_and_atomic() {
        let dir = scratch("roundtrip");
        let bytes = b"PK\x03\x04binary";
        install_in(&dir, "example", &STANDARD.encode(bytes), &sha256(bytes)).unwrap();
        let listed = list_in(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(STANDARD.decode(&listed[0].content_base64).unwrap(), bytes);
        assert_eq!(listed[0].sha256, sha256(bytes));
        assert!(!dir.join(".example.tmp").exists());
        remove_in(&dir, "example").unwrap();
        assert!(list_in(&dir).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_bad_id_size_and_hash() {
        let dir = scratch("reject");
        assert!(install_in(&dir, "../escape", "", &sha256(b"")).is_err());
        assert!(install_in(&dir, "ok", &STANDARD.encode(b"x"), "bad").is_err());
        let large = vec![0; MAX_PACKAGE_BYTES + 1];
        assert!(install_in(&dir, "ok", &STANDARD.encode(&large), &sha256(&large)).is_err());
    }
}
