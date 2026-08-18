//! A provider token that cannot be logged by accident.
//!
//! The custody rule for integrations is that a manifest never sees a token and
//! a token never reaches a log line, a trace, an API response, or a URL. Most
//! of that is reviewer discipline, but the log-line half is enforceable: the
//! usual way a secret escapes is a `tracing` call or a `{:?}` on a struct that
//! happens to contain one, and both go through `Debug`/`Display`.
//!
//! [`Secret`] implements `Debug` as a redaction and implements no `Display` at
//! all, so `format!("{}", token)` does not compile and `{:?}` prints
//! `Secret(redacted)`. Reading the real value requires calling
//! [`Secret::expose`], which is greppable in review.

use std::fmt;

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Yield the plaintext. Every call site is a place a secret could leak, so
    /// the name is deliberately loud enough to notice in a diff.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_reveals_the_value() {
        let secret = Secret::new("ghu_supersecrettoken");
        assert_eq!(format!("{secret:?}"), "Secret(redacted)");
        assert!(!format!("{secret:?}").contains("supersecret"));
    }

    #[test]
    fn debug_of_a_containing_struct_is_also_redacted() {
        // The realistic leak: a struct derives Debug and is logged whole.
        // These fields are read only through that derive — which is the whole
        // point of the test, so the dead-code lint is wrong here.
        #[allow(dead_code)]
        #[derive(Debug)]
        struct Credential {
            account: String,
            token: Secret,
        }
        let rendered = format!(
            "{:?}",
            Credential {
                account: "octocat".into(),
                token: Secret::new("ghu_supersecrettoken"),
            }
        );
        assert!(rendered.contains("octocat"));
        assert!(!rendered.contains("supersecret"), "{rendered}");
    }

    #[test]
    fn expose_returns_the_plaintext() {
        assert_eq!(Secret::new("abc").expose(), "abc");
    }
}
