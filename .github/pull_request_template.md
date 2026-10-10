## Change description

> **Language**: English | [中文](pull_request_template.zh-CN.md)

<!-- 简述本次变更内容及原因 -->

## Change type

- [ ] New features (feat)
- [ ] Bug fix (fix)
- [ ] Refactor
- [ ] Documentation (docs)
- [ ] test
- [ ] Others: ___

## Test

- [ ] Unit tests added/updated
- [ ] Local `pytest` passed in full
- [ ] Front-end `pnpm build` no error reported
- [ ] Front-end `pnpm lint` / `pnpm test` / `pnpm build` passed

## Database migration

- [ ] Does not involve database changes
- [ ] New sequential sqlx migration added under `gateway/migrations/` and verified locally (`cargo build`, then run against a clean Postgres); no edits to already-applied migrations

## Security and Release Impact

- [ ] Does not contain `.env`, logs, databases, uploaded files, private keys, tokens or production configurations
- [ ] Updated documentation when it comes to configuration, deployment, permissions, file uploads, or Agent Bridge

## Related Issues

Closes #
