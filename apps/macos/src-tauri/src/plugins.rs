//! Personal `.cheers-extension` package store for this Mac.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

const MAX_PACKAGE_BYTES: usize = 4 * 1024 * 1024;
const OFFICIAL_EXTENSION_HOST: &str = "haowei2000.github.io";
const OFFICIAL_EXTENSION_PREFIX: &str = "/Cheers/downloads/extensions/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalExtension {
    pub id: String,
    pub content_base64: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedExtension {
    pub content_base64: String,
    pub sha256: String,
    pub source: String,
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

fn validate_catalog_source(source: &str, expected_sha256: &str) -> Result<reqwest::Url, String> {
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("extension SHA-256 must be 64 lowercase hexadecimal characters".into());
    }
    let url = reqwest::Url::parse(source).map_err(|_| "invalid extension source URL")?;
    if url.scheme() != "https"
        || url.host_str() != Some(OFFICIAL_EXTENSION_HOST)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with(OFFICIAL_EXTENSION_PREFIX)
    {
        return Err("extension source is not in the official Cheers catalog".into());
    }
    let expected_filename = format!("{expected_sha256}.cheers-extension");
    if !url.path().ends_with(&format!("/{expected_filename}")) {
        return Err("extension source filename does not match its SHA-256".into());
    }
    let suffix = &url.path()[OFFICIAL_EXTENSION_PREFIX.len()..];
    let segments: Vec<_> = suffix.split('/').collect();
    if segments.len() != 3 || segments.iter().any(|segment| segment.is_empty()) {
        return Err("extension source path must contain id, version, and SHA-256".into());
    }
    Ok(url)
}

fn verify_download(bytes: &[u8], expected_sha256: &str) -> Result<String, String> {
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err("extension exceeds 4 MiB".into());
    }
    let actual = sha256(bytes);
    if actual != expected_sha256 {
        return Err("downloaded extension SHA-256 mismatch".into());
    }
    Ok(actual)
}

async fn download_bytes(client: &reqwest::Client, url: reqwest::Url) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("download extension: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("download extension returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PACKAGE_BYTES as u64)
    {
        return Err("extension exceeds 4 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("read extension download: {error}"))?
    {
        if bytes.len() + chunk.len() > MAX_PACKAGE_BYTES {
            return Err("extension exceeds 4 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn catalog_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .user_agent("Cheers-macOS/extension-catalog")
        .build()
        .map_err(|error| format!("build extension downloader: {error}"))
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
    let nonce = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let temporary = dir.join(format!(".{id}.{}.{nonce}.tmp", std::process::id()));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| format!("create {}: {error}", temporary.display()))?;
        file.write_all(&bytes)
            .map_err(|error| format!("write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("sync {}: {error}", temporary.display()))?;
        fs::rename(&temporary, &target)
            .map_err(|error| format!("replace {}: {error}", target.display()))?;
        fs::File::open(dir)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("sync {}: {error}", dir.display()))
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
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

/// Download inert bytes from the official catalog. The frontend still parses the
/// complete package and shows permissions before calling `extensions_install`.
#[tauri::command]
pub async fn extension_catalog_download(
    source: String,
    sha256: String,
) -> Result<DownloadedExtension, String> {
    let url = validate_catalog_source(&source, &sha256)?;
    let client = catalog_client(Duration::from_secs(20))?;
    let bytes = download_bytes(&client, url).await?;
    let actual = verify_download(&bytes, &sha256)?;
    Ok(DownloadedExtension {
        content_base64: STANDARD.encode(bytes),
        sha256: actual,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read as _, net::TcpListener, thread};

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
        let updated = b"PK\x03\x04updated";
        install_in(&dir, "example", &STANDARD.encode(updated), &sha256(updated)).unwrap();
        let listed = list_in(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(STANDARD.decode(&listed[0].content_base64).unwrap(), updated);
        assert_eq!(listed[0].sha256, sha256(updated));
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|entry| entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            != Some("tmp")));
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

    #[test]
    fn catalog_sources_are_https_pinned_and_canonical() {
        let hash = "a".repeat(64);
        let valid = format!(
            "https://haowei2000.github.io/Cheers/downloads/extensions/notes/1.0.0/{hash}.cheers-extension"
        );
        assert!(validate_catalog_source(&valid, &hash).is_ok());
        assert!(validate_catalog_source(&valid.replace("https:", "http:"), &hash).is_err());
        assert!(validate_catalog_source(
            &valid.replace("haowei2000.github.io", "example.com"),
            &hash
        )
        .is_err());
        assert!(
            validate_catalog_source(&format!("{valid}?next=https://example.com"), &hash).is_err()
        );
        assert!(validate_catalog_source(&valid, &"b".repeat(64)).is_err());
        assert!(validate_catalog_source(&valid, "BAD").is_err());
    }

    #[test]
    fn downloaded_bytes_are_size_limited_and_hash_pinned() {
        let bytes = b"PK\x03\x04extension";
        let hash = sha256(bytes);
        assert_eq!(verify_download(bytes, &hash).unwrap(), hash);
        assert!(verify_download(bytes, &"0".repeat(64)).is_err());
        assert!(verify_download(&vec![0; MAX_PACKAGE_BYTES + 1], &hash).is_err());
    }

    fn serve_once(response: String, delay: Duration) -> reqwest::Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            stream.write_all(response.as_bytes()).unwrap();
        });
        reqwest::Url::parse(&format!("http://{address}/extension")).unwrap()
    }

    #[tokio::test]
    async fn downloader_rejects_redirects_and_declared_oversize_responses() {
        let client = catalog_client(Duration::from_secs(1)).unwrap();
        let redirect = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: https://example.com/other\r\nContent-Length: 0\r\n\r\n"
                .into(),
            Duration::ZERO,
        );
        assert!(download_bytes(&client, redirect)
            .await
            .unwrap_err()
            .contains("302"));

        let oversized = serve_once(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_PACKAGE_BYTES + 1
            ),
            Duration::ZERO,
        );
        let error = download_bytes(&client, oversized).await.unwrap_err();
        assert!(error.contains("4 MiB"), "unexpected error: {error}");
    }

    #[tokio::test]
    async fn downloader_has_a_total_timeout() {
        let client = catalog_client(Duration::from_millis(20)).unwrap();
        let slow = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".into(),
            Duration::from_millis(100),
        );
        assert!(download_bytes(&client, slow)
            .await
            .unwrap_err()
            .contains("download extension"));
    }
}
