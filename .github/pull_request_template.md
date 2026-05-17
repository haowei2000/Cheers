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
- [ ] Front-end `npm run build` no error reported
- [ ] When it comes to npm packages, the `npm run lint` / `npm test` / `npm run build` of the corresponding package has passed

## Database migration

- [ ] Does not involve database changes
- [ ] Alembic migration file added and verified locally (`alembic upgrade head`)

## Security and Release Impact

- [ ] Does not contain `.env`, logs, databases, uploaded files, private keys, tokens or production configurations
- [ ] Updated documentation when it comes to configuration, deployment, permissions, file uploads, or Agent Bridge

## Related Issues

Closes #