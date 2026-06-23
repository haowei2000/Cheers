#Contributing to Cheers

> **Language**: English | [中文](CONTRIBUTING.zh-CN.md)

Thank you for your willingness to participate in Cheers. The project mainly uses Chinese to maintain documents and discussions, and English Issues/PRs are also accepted.

## Branching rules

- PRs for all feature, fix and documentation branches can only be merged into `develop`.
- `main` only accepts merges from `develop`.
- Recommended branch naming: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.

## Development environment

Gateway (Rust backend):```bash
cd server
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
cd server && cargo build && cargo test
cd frontend && npm run build
```
npm package changes also require running `npm run lint`, `npm test`, and `npm run build` in the corresponding package directory.

## npm package release notes

The legacy `packages/openclaw-channel-cheers` and standalone
`packages/cheers-bridge-client` packages have been removed. Do not add new
release or CI wiring for them.

## PR requirements

- Describe the motivation for the change, core solutions and test results.
- Synchronously update documentation when it comes to API, configuration, deployment or user flows.
- Add a new sequential sqlx migration (`server/migrations/<NNNN>_<desc>.sql`) for database structure changes; never edit an already-applied migration.
- Do not submit `.env`, databases, logs, uploaded files, private keys, tokens or production configurations.

## Security issues

Please do not disclose vulnerability details in public issues. Press [SECURITY.md](SECURITY.md) to report a security issue.
