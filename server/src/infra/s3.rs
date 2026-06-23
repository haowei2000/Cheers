//! S3 / RustFS object storage client (SigV4 via aws-sdk-s3).
//!
//! The gateway proxies uploads and downloads — the browser never talks to the
//! object store directly, so there are no presigned URLs, no browser-side
//! signing, and no object-store CORS to configure. All access is authenticated
//! with the configured access/secret keys; rustfs is S3-compatible and uses
//! path-style addressing.

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;

use crate::config::Config;

/// Build an S3 client for the configured endpoint (force path-style for
/// rustfs/minio, which do not support virtual-host-style buckets).
pub fn build_client(config: &Config) -> Client {
    let creds = Credentials::new(
        config.s3_access_key.clone(),
        config.s3_secret_key.clone(),
        None,
        None,
        "cheers-static",
    );
    let conf = aws_sdk_s3::config::Builder::new()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(config.s3_endpoint.clone())
        .region(Region::new(config.s3_region.clone()))
        .credentials_provider(creds)
        .force_path_style(true)
        .build();
    Client::from_conf(conf)
}

/// Create the bucket if it does not already exist. Idempotent.
pub async fn ensure_bucket(client: &Client, bucket: &str) -> anyhow::Result<()> {
    if client.head_bucket().bucket(bucket).send().await.is_ok() {
        return Ok(());
    }
    match client.create_bucket().bucket(bucket).send().await {
        Ok(_) => Ok(()),
        Err(err) => {
            let msg = format!("{err:?}");
            if msg.contains("BucketAlreadyOwnedByYou") || msg.contains("BucketAlreadyExists") {
                Ok(())
            } else {
                Err(anyhow::anyhow!("create_bucket {bucket} failed: {msg}"))
            }
        }
    }
}

/// Upload an object (gateway-proxied; bytes come from the browser via the API).
pub async fn put_object(
    client: &Client,
    bucket: &str,
    key: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> anyhow::Result<()> {
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_type(content_type)
        .body(ByteStream::from(bytes))
        .send()
        .await?;
    Ok(())
}

/// Fetch an object's bytes (gateway-proxied download/preview).
pub async fn get_object(client: &Client, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>> {
    let out = client.get_object().bucket(bucket).key(key).send().await?;
    let data = out.body.collect().await?;
    Ok(data.into_bytes().to_vec())
}
