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
- [ ] 本地 `pytest` 全量通过
- [ ] 前端 `npm run build` 无报错
- [ ] 涉及 npm 包时，对应包的 `npm run lint` / `npm test` / `npm run build` 已通过

## 数据库迁移

- [ ] 不涉及数据库变更
- [ ] 已添加 Alembic 迁移文件并本地验证（`alembic heads` 只有一个 head，然后 `alembic upgrade head`）

## 安全与发布影响

- [ ] 不包含 `.env`、日志、数据库、上传文件、私钥、token 或生产配置
- [ ] 涉及配置、部署、权限、文件上传或 Agent Bridge 时已更新文档

## 相关 Issue

Closes #
