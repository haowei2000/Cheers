//! Thin client for the Gotenberg document-conversion service.
//!
//! We POST the raw document bytes to Gotenberg's LibreOffice route and get a PDF
//! back. The gateway feeds Gotenberg the bytes directly (pulled from S3), so
//! Gotenberg never needs object-store credentials or a fetchable file URL — it
//! stays a pure internal converter with no outbound access, sidestepping the
//! SSRF class of issues that URL-fetching preview services have.

/// Convert an office document to PDF via Gotenberg's `/forms/libreoffice/convert`.
///
/// `filename` MUST carry the real extension (e.g. `report.docx`) — Gotenberg picks
/// the LibreOffice converter from it, not from a content type. Returns the PDF bytes.
pub async fn convert_to_pdf(
    http: &reqwest::Client,
    base_url: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> anyhow::Result<Vec<u8>> {
    let url = format!("{}/forms/libreoffice/convert", base_url.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
    let form = reqwest::multipart::Form::new().part("files", part);

    let resp = http.post(url).multipart(form).send().await?;

    let status = resp.status();
    if !status.is_success() {
        let body: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(500)
            .collect();
        anyhow::bail!("gotenberg convert failed ({status}): {body}");
    }
    Ok(resp.bytes().await?.to_vec())
}
