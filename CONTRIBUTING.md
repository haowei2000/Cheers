#Contributing to AgentNexus

> **Language**: English | [中文](CONTRIBUTING.zh-CN.md)

Thank you for your willingness to participate in AgentNexus. The project mainly uses Chinese to maintain documents and discussions, and English Issues/PRs are also accepted.

## Branching rules

- PRs for all feature, fix and documentation branches can only be merged into `develop`.
- `main` only accepts merges from `develop`.
- Recommended branch naming: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.

## Development environment

Gateway (Rust backend):```bash
cd gateway
cargo run   # runs sqlx migrations on startup
```
front end:```bash
cd frontend
npm install
npm run dev
```
Docker Compose:```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
docker compose up -d
```
Please modify the default password and key in `.env` before running it for the first time. Do not use the sample key in production environments.

## Check before submission

Run based on change scope:```bash
cd gateway && cargo build && cargo test
cd frontend && npm run build
```
npm package changes also require running `npm run lint`, `npm test`, and `npm run build` in the corresponding package directory.

## npm package release notes

`packages/openclaw-channel-agentnexus` and `packages/agentnexus-acp-connector` use monorepo local dependencies in the source code:```json
"@haowei0520/bridge-client": "file:../agentnexus-bridge-client"
```
The release workflow will rewrite the dependency to the published npm version before publishing. Do not manually change it to the registry version during daily development, otherwise local joint debugging will be slower and cross-package modifications will be more likely to be missed.

## PR requirements

- Describe the motivation for the change, core solutions and test results.
- Synchronously update documentation when it comes to API, configuration, deployment or user flows.
- Add a new sequential sqlx migration (`gateway/migrations/<NNNN>_<desc>.sql`) for database structure changes; never edit an already-applied migration.
- Do not submit `.env`, databases, logs, uploaded files, private keys, tokens or production configurations.

## Security issues

Please do not disclose vulnerability details in public issues. Press [SECURITY.md](SECURITY.md) to report a security issue.