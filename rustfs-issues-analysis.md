# AgentNexus RustFS 使用问题分析

## 1. Scope 管理脆弱

`uploads` 和 `generated` 两个 scope 靠 `object_key` 前缀字符串判断。多处代码需要手动写 `if object_key.startswith("generated/")` 来推断 scope，漏掉一处就是 bug（实际已经因此出过 bug）。应该在 `FileRecord` 模型上直接存一个 `scope` 字段。

## 2. 没有清理机制

生成的图片、用户上传的文件永远留在 RustFS 里。没有：

- 过期清理（TTL / lifecycle policy）
- 孤儿文件清理（FileRecord 被删但对象还在）
- 频道删除后关联文件的清理

## 3. 预览走后端中转，效率低

每次 `<img src="/api/files/{id}/preview">` 都是：前端 → Nginx → Backend → RustFS → 原路返回。大图几 MB 每次都完整传输。没有：

- 缩略图生成（应该存一份 thumbnail）
- 浏览器缓存头（`Cache-Control`）
- 直接用 presigned GET URL 让前端直连 RustFS

## 4. boto3 同步调用包装为异步

所有存储操作用 `asyncio.to_thread()` 包装同步 boto3。高并发时会耗尽线程池，成为瓶颈。理想应该用 `aioboto3` 或 `aiohttp` 直接做 S3 异步调用。

## 5. Presigned URL 用得不彻底

上传用了 presigned PUT URL（前端直传 RustFS），但下载/预览没有用 presigned GET URL，而是走后端代理。生成图片时 `_save_image` 创建了 presigned GET URL 但只在 API 响应中返回一次，前端实际不用它。

## 6. 没有分 bucket

所有文件（用户上传、AI 生成图片）都在同一个 bucket 里用路径前缀区分。无法对不同类型设置不同的存储策略（如生成图片 7 天过期，用户上传永久保留）。

## 7. 上传后的确认机制薄弱

前端直传 RustFS 后，后端通过 `head_object` 确认文件存在。但如果前端上传失败或中断，`FileRecord` 会一直停留在 `pending_upload` 状态，没有定时扫描清理这些僵尸记录。

## 8. 没有文件去重

相同文件上传多次会存多份。没有基于 hash 的去重。

## 9. 容错不足

RustFS 挂掉时，整个文件功能（上传、预览、文生图）全部不可用，没有降级策略（如本地临时缓存）。

## 优先级建议

| 优先级 | 问题 | 原因 |
|--------|------|------|
| **高** | Scope 字段化 | 避免反复出 bug |
| **高** | 预览直连 RustFS | 性能提升最大 |
| 中 | 僵尸记录清理 | 存储空间浪费 |
| 中 | 浏览器缓存头 | 减少重复请求 |
| 低 | 分 bucket | 需要架构调整 |
| 低 | aioboto3 替换 | 高并发时才有感知 |
| 低 | 文件去重 | 当前规模影响不大 |
