# @cheers/canvas-runtime

Standalone runtime, RPC bridge, view host abstractions, and sandbox containers for Cheers interactive resources (TSX Canvas and A2UI).

Use `artifactCsp()` when constructing sandbox documents. The sandbox permits scripts
and form events; `form-action 'none'` prevents outbound form submission. Bridge request
messages are untrusted proposals: hosts must require a trusted host-side approval
before dispatching authenticated requests. Never treat an iframe message as user consent.

## Features

- **Action Metadata Extraction**: Parses `@cheers-actions` annotations from TSX/JSX canvas sources.
- **Sandboxed Execution**: Isolated `iframe` container enforcing strict Content Security Policy (CSP).
- **CheersBridge RPC**: Two-way JSON-RPC 2.0 communication between host application and iframe sandboxes.
- **View Host Abstractions**: Shared `ResourceViewHost`, `createReplyViewHost`, and `createWorkbenchViewHost` unifying inline reply cards, modals, and Workbench lenses.
