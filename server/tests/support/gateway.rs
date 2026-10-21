use reqwest::Client;
use sqlx::{ConnectOptions, PgPool};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

/// Own the process and temporary keys even if an assertion panics.
pub struct TestGateway {
    process: Option<Child>,
    directory: PathBuf,
    // Each real server owns its production PG pool. Bound process resources
    // while leaving the races within an individual gateway fully concurrent.
    _process_permit: OwnedSemaphorePermit,
}
impl Drop for TestGateway {
    fn drop(&mut self) {
        if let Some(process) = self.process.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        if std::thread::panicking() {
            if let Ok(log) = std::fs::read_to_string(self.directory.join("gateway.log")) {
                eprintln!("test gateway log after failure:\n{log}");
            }
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
impl TestGateway {
    /// Re-sign only the time claims of a real login token with this fixture's
    /// temporary key. Account, session, issuer and revocation version stay real.
    #[allow(dead_code)]
    pub fn access_token_with_expiry(&self, token: &str, expires_at: u64) -> String {
        use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Validation};
        use server::api::middleware::{Claims, JWT_ISSUER};

        let public = std::fs::read(self.directory.join("public.pem")).unwrap();
        let private = std::fs::read(self.directory.join("private.pem")).unwrap();
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_nbf = true;
        validation.set_issuer(&[JWT_ISSUER]);
        let original = decode::<Claims>(
            token,
            &DecodingKey::from_rsa_pem(&public).unwrap(),
            &validation,
        )
        .unwrap();
        let mut claims = original.claims;
        claims.exp = expires_at;
        claims.iat = chrono::Utc::now().timestamp() as u64;
        encode(
            &original.header,
            &claims,
            &EncodingKey::from_rsa_pem(&private).unwrap(),
        )
        .unwrap()
    }

    pub async fn start(db: &PgPool, login: &str, password: &str) -> (Self, String) {
        static PROCESS_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
        let process_permit = PROCESS_SLOTS
            .get_or_init(|| Arc::new(Semaphore::new(4)))
            .clone()
            .acquire_owned()
            .await
            .expect("gateway process semaphore remains open");
        let directory = std::env::temp_dir().join(format!("cheers-http-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut gateway = Self {
            process: None,
            directory,
            _process_permit: process_permit,
        };
        let private = gateway.directory.join("private.pem");
        let public = gateway.directory.join("public.pem");
        for args in [
            vec![
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
                "-out",
                private.to_str().unwrap(),
            ],
            vec![
                "pkey",
                "-in",
                private.to_str().unwrap(),
                "-pubout",
                "-out",
                public.to_str().unwrap(),
            ],
        ] {
            let output = Command::new("openssl")
                .args(args)
                .output()
                .expect("openssl is required for temporary test keys");
            assert!(output.status.success(), "temporary key generation failed");
        }
        // Ask the OS for a free port rather than assume one shared by other stacks.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let base = format!("http://127.0.0.1:{port}");
        let log = std::fs::File::create(gateway.directory.join("gateway.log")).unwrap();
        gateway.process = Some(
            Command::new(env!("CARGO_BIN_EXE_server"))
                .current_dir(&gateway.directory)
                .env("DATABASE_URL", db.connect_options().to_url_lossy().as_str())
                .env("PORT", port.to_string())
                .env("BIND_ADDRESS", "127.0.0.1")
                .env("JWT_PRIVATE_KEY", std::fs::read_to_string(private).unwrap())
                .env("JWT_PUBLIC_KEY", std::fs::read_to_string(public).unwrap())
                .env("ADMIN_USERNAME", login)
                .env("ADMIN_PASSWORD", password)
                .env("S3_ENDPOINT", "http://127.0.0.1:1")
                .env("S3_ACCESS_KEY", "integration-test")
                .env("S3_SECRET_KEY", "integration-test")
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        );
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let exited = gateway.process.as_mut().unwrap().try_wait().unwrap();
            assert!(
                exited.is_none(),
                "test gateway exited: {:?}\n{}",
                exited,
                std::fs::read_to_string(gateway.directory.join("gateway.log")).unwrap()
            );
            if client
                .get(format!("{base}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "test gateway did not become ready\n{}",
                std::fs::read_to_string(gateway.directory.join("gateway.log")).unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        (gateway, base)
    }
}
