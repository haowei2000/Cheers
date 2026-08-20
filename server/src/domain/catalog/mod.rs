//! First-party, release-coupled catalog contributions.
//!
//! Provider integrations retain their specialised schema; official Workbench
//! scenarios use a separate typed contribution schema. Both are compiled into
//! the Gateway and never installed at runtime.

pub use crate::domain::integrations::catalog as integrations;
pub mod workbench;
