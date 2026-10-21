fn main() {
    // migrate! tracks existing files, but stable Rust needs a directory watch
    // to re-embed the migration list when a new numbered file is added.
    println!("cargo:rerun-if-changed=migrations");
}
