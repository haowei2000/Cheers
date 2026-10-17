use reqwest::Client;
use sqlx::{ConnectOptions, PgPool};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
use uuid::Uuid;

/// Own the process and temporary keys even if an assertion panics.
pub struct TestGateway {
    process: Option<Child>,
    directory: PathBuf,
}
impl Drop for TestGateway {
    fn drop(&mut self) {
        if let Some(process) = self.process.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
impl TestGateway {
    pub async fn start(db: &PgPool, login: &str, password: &str) -> (Self, String) {
        let directory = std::env::temp_dir().join(format!("cheers-http-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut gateway = Self {
            process: None,
            directory,
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
