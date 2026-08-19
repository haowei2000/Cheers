//! Service integrations: credential custody, inbound events, and the channel
//! bindings that tie an external resource to a Cheers channel.
//!
//! The plugin strategy this implements: the Gateway owns generic engines and an
//! integration is data describing how to drive them. No third-party code runs
//! in this process — anything needing real logic runs out-of-process as an ACP
//! connector or MCP server.

pub mod bindings;
pub mod catalog;
pub mod credentials;
pub mod delivery;
pub mod mapper;
pub mod projection;
pub mod secret;
pub mod template;
pub mod webhook;
