fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().permissions_path_pattern("./permissions/*.toml"),
        ),
    )
    .expect("failed to build Tauri application permissions");
}
