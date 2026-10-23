//! Pure TOML transformations for desktop host credential isolation.

use toml_edit::{value, DocumentMut, Item, Table};

fn is_normalized_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// Scope a newly onboarded, file-authenticated account to its own host files.
/// The caller supplies an already normalized instance name; this function never
/// silently changes a name or converts an environment credential to file auth.
pub(crate) fn scope_host_instance(
    config: &str,
    account_id: &str,
    normalized_name: &str,
) -> Result<(String, String), String> {
    if !is_normalized_name(normalized_name) {
        return Err("Desktop host instance name must already be normalized".into());
    }
    let mut doc: DocumentMut = config
        .parse()
        .map_err(|error: toml_edit::TomlError| error.to_string())?;
    let credential_file = format!("secrets/{normalized_name}.token");
    let bridge = doc
        .get_mut("accounts")
        .and_then(Item::as_table_like_mut)
        .and_then(|accounts| accounts.get_mut(account_id))
        .and_then(Item::as_table_like_mut)
        .and_then(|account| account.get_mut("bridge"))
        .and_then(Item::as_table_like_mut)
        .ok_or("Bot account bridge is missing from the host configuration")?;
    if bridge.get("host_credential_env").is_some() {
        return Err(
            "Desktop host onboarding requires file credentials, not host_credential_env".into(),
        );
    }
    if bridge
        .get("host_credential_file")
        .and_then(Item::as_str)
        .is_none_or(|path| path.trim().is_empty())
    {
        return Err("Desktop host onboarding requires a host_credential_file".into());
    }
    bridge.insert("host_credential_file", value(credential_file.as_str()));
    bridge.remove("token_file");

    if doc.get("daemon").is_none() {
        doc["daemon"] = Item::Table(Table::new());
    }
    let daemon = doc
        .get_mut("daemon")
        .and_then(Item::as_table_like_mut)
        .ok_or("Host configuration daemon must be a table")?;
    daemon.insert("name", value(normalized_name));
    daemon.insert("state_path", value(format!("state-{normalized_name}.json")));
    daemon.insert("log_dir", value(format!("logs-{normalized_name}")));
    Ok((doc.to_string(), credential_file))
}

/// Repair only the exact dual-field configuration emitted by desktop 0.1.42's
/// instance onboarding. Keep the instance credential, never the original shared
/// account file. Custom/ambiguous authentication and all other configs are left
/// byte-for-byte unchanged. No credential or filesystem access is performed.
pub(crate) fn repair_desktop_host_credential(config: &str) -> Result<String, String> {
    let mut doc: DocumentMut = config
        .parse()
        .map_err(|error: toml_edit::TomlError| error.to_string())?;
    let repair = (|| {
        let daemon = doc.get("daemon")?.as_table_like()?;
        let name = daemon.get("name")?.as_str()?;
        if !is_normalized_name(name)
            || daemon.get("state_path")?.as_str()? != format!("state-{name}.json")
            || daemon.get("log_dir")?.as_str()? != format!("logs-{name}")
        {
            return None;
        }
        let accounts = doc.get("accounts")?.as_table_like()?;
        let mut accounts = accounts.iter();
        let (account_id, account) = accounts.next()?;
        if accounts.next().is_some() {
            return None;
        }
        let bridge = account.as_table_like()?.get("bridge")?.as_table_like()?;
        if bridge.get("host_credential_env").is_some() {
            return None;
        }
        let credential_file = format!("secrets/{name}.token");
        if bridge.get("token_file")?.as_str()? != credential_file {
            return None;
        }
        let canonical = bridge.get("host_credential_file")?.as_str()?;
        if canonical != format!("secrets/{account_id}.token") && canonical != credential_file {
            return None;
        }
        Some((account_id.to_owned(), credential_file))
    })();
    let Some((account_id, credential_file)) = repair else {
        return Ok(config.to_string());
    };
    let bridge = doc
        .get_mut("accounts")
        .and_then(Item::as_table_like_mut)
        .and_then(|accounts| accounts.get_mut(&account_id))
        .and_then(Item::as_table_like_mut)
        .and_then(|account| account.get_mut("bridge"))
        .and_then(Item::as_table_like_mut)
        .ok_or("Desktop host bridge changed while repairing its configuration")?;
    bridge.insert("host_credential_file", value(credential_file.as_str()));
    bridge.remove("token_file");
    Ok(doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATED: &str = r#"# Gateway-generated file authentication.
version = 1
[daemon]
name = "bot"
state_path = "state-bot.json"
log_dir = "logs-bot"
[update]
auto = false
[accounts.bot.bridge]
control_url = "wss://example.invalid/ws/agent-bridge/control"
data_url = "wss://example.invalid/ws/agent-bridge/data"
host_credential_file = "secrets/bot.token"
[accounts.bot.adapter]
type = "stdio"
command = "/test/agent"
[accounts.bot.policy.workspace]
remote_open = false
"#;

    const BROKEN: &str = r#"# Existing desktop host, with its separate credential file.
version = 1
[daemon]
name = "host-one"
state_path = "state-host-one.json"
log_dir = "logs-host-one"
[update]
auto = false
[accounts.bot.bridge]
control_url = "wss://example.invalid/ws/agent-bridge/control"
data_url = "wss://example.invalid/ws/agent-bridge/data"
host_credential_file = "secrets/bot.token"
token_file = "secrets/host-one.token"
[accounts.bot.adapter]
type = "stdio"
command = "/test/agent"
[accounts.bot.policy.workspace]
remote_open = false
"#;

    #[test]
    fn producer_keeps_each_host_credential_and_state_separate() {
        let (first, first_file) = scope_host_instance(GENERATED, "bot", "host-one").unwrap();
        let (second, second_file) = scope_host_instance(GENERATED, "bot", "host-two").unwrap();
        assert_eq!(first_file, "secrets/host-one.token");
        assert_eq!(second_file, "secrets/host-two.token");
        let first: DocumentMut = first.parse().unwrap();
        let second: DocumentMut = second.parse().unwrap();
        for (doc, name, file) in [
            (&first, "host-one", &first_file),
            (&second, "host-two", &second_file),
        ] {
            assert_eq!(
                doc["accounts"]["bot"]["bridge"]["host_credential_file"].as_str(),
                Some(file.as_str())
            );
            assert!(doc["accounts"]["bot"]["bridge"].get("token_file").is_none());
            assert_eq!(doc["daemon"]["name"].as_str(), Some(name));
            assert_eq!(
                doc["daemon"]["state_path"].as_str(),
                Some(format!("state-{name}.json").as_str())
            );
            assert_eq!(
                doc["daemon"]["log_dir"].as_str(),
                Some(format!("logs-{name}").as_str())
            );
            assert_eq!(doc["update"]["auto"].as_bool(), Some(false));
            assert_eq!(
                doc["accounts"]["bot"]["policy"]["workspace"]["remote_open"].as_bool(),
                Some(false)
            );
        }
    }

    #[test]
    fn producer_removes_an_existing_legacy_alias() {
        let (scoped, credential_file) = scope_host_instance(BROKEN, "bot", "new-host").unwrap();
        let doc: DocumentMut = scoped.parse().unwrap();
        assert_eq!(credential_file, "secrets/new-host.token");
        assert_eq!(
            doc["accounts"]["bot"]["bridge"]["host_credential_file"].as_str(),
            Some(credential_file.as_str())
        );
        assert!(doc["accounts"]["bot"]["bridge"].get("token_file").is_none());
    }

    #[test]
    fn producer_rejects_environment_auth_missing_canonical_and_invalid_names() {
        for env in ["\"HOST_SECRET\"", "\"\"", "false"] {
            let config = GENERATED.replace(
                "host_credential_file = \"secrets/bot.token\"",
                &format!(
                    "host_credential_file = \"secrets/bot.token\"\nhost_credential_env = {env}"
                ),
            );
            assert!(scope_host_instance(&config, "bot", "host").is_err());
        }
        for replacement in [
            "",
            "host_credential_file = \"\"\n",
            "host_credential_file = false\n",
        ] {
            let config = GENERATED.replace(
                "host_credential_file = \"secrets/bot.token\"\n",
                replacement,
            );
            assert!(scope_host_instance(&config, "bot", "host").is_err());
        }
        for name in [
            "",
            "-host",
            "host-",
            "host/name",
            "host name",
            "höst",
            "host\n",
        ] {
            assert!(scope_host_instance(GENERATED, "bot", name).is_err());
        }
        assert!(scope_host_instance(GENERATED, "missing", "host").is_err());
    }

    #[test]
    fn repair_chooses_the_instance_credential_and_is_idempotent() {
        let fixed = repair_desktop_host_credential(BROKEN).unwrap();
        let doc: DocumentMut = fixed.parse().unwrap();
        assert_eq!(
            doc["accounts"]["bot"]["bridge"]["host_credential_file"].as_str(),
            Some("secrets/host-one.token")
        );
        assert!(doc["accounts"]["bot"]["bridge"].get("token_file").is_none());
        assert_eq!(doc["update"]["auto"].as_bool(), Some(false));
        assert_eq!(
            doc["accounts"]["bot"]["adapter"]["command"].as_str(),
            Some("/test/agent")
        );
        assert_eq!(repair_desktop_host_credential(&fixed).unwrap(), fixed);

        let partly_fixed = BROKEN.replace(
            "host_credential_file = \"secrets/bot.token\"",
            "host_credential_file = \"secrets/host-one.token\"",
        );
        let fixed = repair_desktop_host_credential(&partly_fixed).unwrap();
        let doc: DocumentMut = fixed.parse().unwrap();
        assert_eq!(
            doc["accounts"]["bot"]["bridge"]["host_credential_file"].as_str(),
            Some("secrets/host-one.token")
        );
        assert!(doc["accounts"]["bot"]["bridge"].get("token_file").is_none());
    }

    #[test]
    fn repair_does_not_rebind_custom_or_ambiguous_configurations() {
        let variants = [
            BROKEN.replace("token_file = \"secrets/host-one.token\"", "token_file = \"secrets/other-host.token\""),
            BROKEN.replace("host_credential_file = \"secrets/bot.token\"", "host_credential_file = \"secrets/custom.token\""),
            BROKEN.replace("host_credential_file = \"secrets/bot.token\"\n", ""),
            BROKEN.replace("host_credential_file = \"secrets/bot.token\"", "host_credential_file = false"),
            BROKEN.replace("host_credential_file = \"secrets/bot.token\"", "host_credential_file = \"secrets/bot.token\"\nhost_credential_env = \"HOST_SECRET\""),
            BROKEN.replace("host_credential_file = \"secrets/bot.token\"", "host_credential_file = \"secrets/bot.token\"\nhost_credential_env = false"),
            BROKEN.replace("state-host-one.json", "custom-state.json"),
            BROKEN.replace("logs-host-one", "custom-logs"),
            BROKEN.replace("name = \"host-one\"", "name = \"-host-one\""),
            format!("{BROKEN}\n[accounts.other.bridge]\nhost_credential_file = \"secrets/other.token\"\n"),
        ];
        for config in variants {
            assert_eq!(repair_desktop_host_credential(&config).unwrap(), config);
        }
    }

    #[test]
    fn valid_file_and_environment_configurations_remain_byte_for_byte_unchanged() {
        assert_eq!(
            repair_desktop_host_credential(GENERATED).unwrap(),
            GENERATED
        );
        let env = GENERATED.replace(
            "host_credential_file = \"secrets/bot.token\"",
            "host_credential_env = \"HOST_SECRET\"",
        );
        assert_eq!(repair_desktop_host_credential(&env).unwrap(), env);
    }
}
