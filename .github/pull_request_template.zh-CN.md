## 变更描述

> **语言**：中文 | [English](pull_request_template.md)

<!-- 简述本次变更内容及原因 -->

## 变更类型

- [ ] 新功能 (feat)
- [ ] Bug 修复 (fix)
- [ ] 重构 (refactor)
- [ ] 文档 (docs)
- [ ] 测试 (test)
- [ ] 其他: ___

## 测试

- [ ] 已添加/更新单元测试
- [ ] 涉及的 Rust crate 本地 `cargo test` 已通过
- [ ] 前端 `pnpm build` 无报错
- [ ] 前端 `pnpm lint` / `pnpm test` / `pnpm build` 已通过

## 数据库迁移

- [ ] 不涉及数据库变更
- [ ] 已在 `server/migrations/` 下添加顺序编号的 sqlx 迁移并本地验证（`cargo build`，再在干净的 Postgres 上运行）；未修改已应用的迁移

## 安全与发布影响

- [ ] 不包含 `.env`、日志、数据库、上传文件、私钥、token 或生产配置
- [ ] 涉及配置、部署、权限、文件上传或 Agent Bridge 时已更新文档

## 相关 Issue

Closes #
