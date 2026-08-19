//! The GitHub vertical: the first integration assembled from the generic
//! engines rather than written as bespoke plumbing.
//!
//! # Why a GitHub App and not an OAuth App
//!
//! Issue #571 asked for this decision to be recorded before building. Both can
//! read a repository; they differ in what the gateway ends up holding.
//!
//! An OAuth App receives a token carrying the *user's* scope. `repo` is not
//! divisible — the token can read every private repository that user can
//! reach, at their employer and in their side projects alike, for as long as
//! the grant lives. Nothing about "connect the Cheers repo" narrows it, so a
//! gateway compromise reaches everything the connecting user could.
//!
//! A GitHub App is installed onto an account with a chosen set of
//! repositories. The gateway holds only an App private key, which by itself
//! reads nothing; each API call uses an *installation* token that is scoped to
//! that installation's repositories and expires in an hour. Revoking is
//! uninstalling, visible in GitHub's own UI. Webhook secrets are per
//! installation, which is what [`super::webhook`] already assumes, and the
//! hour-long expiry with renewal is the exact shape
//! [`super::credentials`] was built around.
//!
//! The cost is a heavier connect flow — an installation step, and a private
//! key in deployment configuration. That is the right trade for a platform
//! whose whole permission story is "an integration can never reach more than
//! the person who connected it".

pub mod api;
pub mod app;
