# 文件上传与 SSE 推理联调说明

本文档对应第二阶段改造，验证链路如下：

1. 前端调用 `POST /api/files/presign`
2. 前端使用返回的 `upload_url` 直传 RustFS
3. 前端拿到稳定的 `file_id`
4. 前端调用 `POST /api/channels/{channel_id}/messages/stream`
5. 后端读取 RustFS 对象或旧本地文件，解析内容后交给 Bot / LLM
6. 前端通过 `text/event-stream` 实时接收推理结果

## 1. 前置条件

- `docker compose up -d rustfs redis backend frontend`
- `backend` 已配置好对象存储环境变量
- 目标频道中至少有一个可响应的 Bot
- 上传文件类型限制为 `pdf / docx / txt`

## 2. 生成 presigned URL

```bash
curl -X POST http://localhost:8000/api/files/presign \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "your-channel-id",
    "uploader_id": "your-user-id",
    "filename": "sample.txt",
    "content_type": "text/plain",
    "size": 12
  }'
```

预期返回：

- `file_id`
- `object_key`
- `upload_url`
- `headers`
- `expires_in`

## 3. 直传 RustFS

将上一步的返回值代入：

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: text/plain" \
  -H "x-amz-meta-file-id: $FILE_ID" \
  -H "x-amz-meta-original-filename: sample.txt" \
  --data-binary "hello rustfs"
```

如果返回 `200` 或 `204`，说明浏览器未来的直传链路是通的。

## 4. 触发消息 + SSE 推理

```bash
curl -N -X POST http://localhost:8000/api/channels/your-channel-id/messages/stream \
  -H "Content-Type: application/json" \
  -d '{
    "content": "@channel bot 请结合文件回答",
    "sender_id": "your-user-id",
    "sender_type": "user",
    "file_ids": ["'$FILE_ID'"]
  }'
```

预期会按顺序看到部分或全部 SSE 事件：

- `event: user_message`
- `event: bot_processing`
- `event: bot_message`
- `event: delta`
- `event: done`
- `event: complete`

说明：

- `user_message`：用户消息已经持久化并广播
- `bot_processing`：后端已开始调度 Bot
- `bot_message`：Bot 占位消息已创建
- `delta`：增量流式文本
- `done`：单条 Bot 消息流结束
- `complete`：本次请求整体结束

## 5. 旧 file_id 的兼容策略

当前后端同时支持两种文件来源：

- 新链路：`file_records.object_key` / `storage_bucket` 存在，优先从 RustFS / S3-compatible storage 读取
- 旧链路：只有 `file_records.original_path`，则回退到本地磁盘文件读取

因此：

- 旧上传接口生成的 `file_id` 仍然可以参与推理
- 新的 RustFS 直传 `file_id` 也可以参与推理

## 6. 常见报错

- `当前仅支持 pdf / docx / txt 文件`
  - 文件扩展名或 MIME 不在白名单内
- `空文件无法上传`
  - 上传体为空或对象长度为 0
- `上传文件尚未完成，或对象已不存在，请重新上传`
  - 前端拿到 `file_id` 后没有完成 PUT，或者对象已被删除
- `对象存储访问失败，请稍后重试`
  - RustFS 不可达、凭证错误、bucket 不存在且自动创建失败
- `文件解析失败`
  - 文件损坏、PDF 无法读取、DOCX 结构异常
- `storage unavailable`
  - 后端对象存储配置未生效

## 7. 前端接入说明

当前前端已改为：

- 上传时先请求 `/api/files/presign`
- 使用返回的 `upload_url` 直接上传 RustFS
- 发送带附件消息时走 `/api/channels/{channel_id}/messages/stream`
- 流式结果通过 SSE 实时更新当前消息气泡

非附件消息仍保留原有 `POST /api/channels/{channel_id}/messages` 行为。
