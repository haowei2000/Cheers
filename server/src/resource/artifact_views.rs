//! Filename-only built-in view selection, shared with clients.
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize)]
pub(super) struct View {
    pub view: String,
    pub suffixes: Vec<String>,
}
pub(super) static VIEWS: LazyLock<Vec<View>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/view-suffixes.json"))
        .expect("valid shared artifact view table")
});

pub(super) fn view_for(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    VIEWS
        .iter()
        .flat_map(|row| {
            row.suffixes
                .iter()
                .map(move |suffix| (row.view.as_str(), suffix))
        })
        .filter(|(_, suffix)| name.ends_with(suffix.as_str()))
        .max_by_key(|(_, suffix)| suffix.len())
        .map(|(view, _)| view)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_shared_suffix_selects_its_view() {
        for row in VIEWS.iter() {
            for suffix in &row.suffixes {
                assert_eq!(
                    view_for(&format!("docs/REPORT{}", suffix.to_uppercase())),
                    Some(row.view.as_str())
                );
            }
        }
        assert_eq!(view_for("data.json"), None);
        assert_eq!(view_for("board.canvas.yaml/notes.txt"), None);
    }
}
